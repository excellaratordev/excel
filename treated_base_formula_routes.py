from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, request

import base_routes
from backend import api_error, current_email, db, fetch_one, get_workbook, json_body, require_project
from superexcel.core.file_pipeline import FILE_KIND_BASE, STAGE_TREATED


treated_base_formula_api = Blueprint("treated_base_formula_api", __name__)

ROW_PATCH_RE = re.compile(r"^/api/bases/(\d+)/rows/(\d+)$")
DIRECT_REFERENCE_RE = re.compile(
    r"^\s*=\s*(?:'((?:''|[^'])+)'|([^'!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)\s*$",
    re.IGNORECASE,
)
MAX_FORMULA_LENGTH = 4096
MAX_FORMULA_PAGE = 240


def is_formula(value: Any) -> bool:
    return isinstance(value, str) and value.lstrip().startswith("=")


def parse_direct_reference(value: Any) -> dict[str, Any] | None:
    match = DIRECT_REFERENCE_RE.fullmatch(str(value or ""))
    if not match:
        return None
    quoted_name, plain_name, column, row = match.groups()
    source_name = (quoted_name.replace("''", "'") if quoted_name is not None else plain_name or "").strip()
    if not source_name:
        return None
    return {
        "source_name": source_name,
        "column": column.upper(),
        "row": int(row),
        "address": f"{column.upper()}{int(row)}",
    }


def require_treated_base(workbook_id: int, minimum_role: str = "viewer"):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, api_error(response, "Erro ao localizar a Base 2")
    if not workbook:
        return None, None, (jsonify({"error": "Base 2 não encontrada."}), 404)
    if not (
        workbook.get("file_kind") == FILE_KIND_BASE
        and workbook.get("pipeline_stage") == STAGE_TREATED
    ):
        return None, None, (jsonify({"error": "Fórmulas calculadas estão disponíveis somente na Base 2."}), 409)
    _, role, error = require_project(int(workbook.get("project_id") or 0), minimum_role)
    if error:
        return None, None, error
    return workbook, role, None


def normalize_formula_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    output: dict[str, str] = {}
    for key, formula in value.items():
        if not is_formula(formula):
            continue
        text = str(formula)
        if len(text) <= MAX_FORMULA_LENGTH:
            output[str(key)] = text
    return output


@treated_base_formula_api.before_app_request
def store_treated_base_formulas():
    """Replace the generic row PATCH only for treated Bases.

    Formula text is persisted in base_rows.formulas while base_rows.values keeps
    the last calculated value consumed by Elementar and other downstream stages.
    """
    if request.method != "PATCH":
        return None
    match = ROW_PATCH_RE.fullmatch(request.path)
    if not match:
        return None
    workbook_id, row_id = map(int, match.groups())
    workbook, _, error = require_treated_base(workbook_id, "editor")
    if error:
        if isinstance(error, tuple) and len(error) > 1 and error[1] == 409:
            return None
        return error

    body = request.get_json(silent=True) or {}
    submitted = body.get("values")
    if not isinstance(submitted, dict):
        return jsonify({"error": "Os valores da linha devem formar um objeto."}), 400

    row, response = fetch_one(
        "base_rows",
        {
            "select": "id,workbook_id,row_order,values,formulas,revision,updated_at,updated_by_email",
            "id": f"eq.{row_id}",
            "workbook_id": f"eq.{workbook_id}",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar registro")
    if not row:
        return jsonify({"error": "Registro não encontrado."}), 404

    try:
        base_revision = int(body.get("base_revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão do registro inválida."}), 400
    current_revision = int(row.get("revision") or 1)
    if base_revision != current_revision:
        return jsonify({"error": "O registro foi alterado por outra pessoa.", "conflict": True, "current": row}), 409

    columns, columns_response = base_routes.columns_by_key(workbook_id)
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas")
    unknown = sorted(set(map(str, submitted.keys())) - set(columns))
    if unknown:
        return jsonify({"error": f"Coluna desconhecida: {unknown[0]}."}), 400

    merged_values = dict(row.get("values") or {})
    merged_formulas = normalize_formula_map(row.get("formulas"))
    try:
        for key, raw_value in submitted.items():
            key = str(key)
            if is_formula(raw_value):
                formula = str(raw_value)
                if len(formula) > MAX_FORMULA_LENGTH:
                    raise ValueError("A fórmula excede 4.096 caracteres.")
                merged_formulas[key] = formula
                merged_values[key] = None
            else:
                merged_formulas.pop(key, None)
                merged_values[key] = base_routes.normalize_typed_value(raw_value, str(columns[key]["data_type"]))

        for key, column in columns.items():
            if bool(column.get("required")) and merged_values.get(key) is None and key not in merged_formulas:
                raise ValueError(f"A coluna {column['name']} é obrigatória.")
    except (ValueError, TypeError) as validation_error:
        return jsonify({"error": str(validation_error)}), 400

    response = db(
        "PATCH",
        "base_rows",
        params={
            "id": f"eq.{row_id}",
            "workbook_id": f"eq.{workbook_id}",
            "revision": f"eq.{current_revision}",
        },
        payload={
            "values": merged_values,
            "formulas": merged_formulas,
            "revision": current_revision + 1,
            "updated_by_email": current_email(),
            "updated_at": base_routes.now_iso(),
        },
        prefer="return=representation",
    )
    if not response.ok:
        return api_error(response, "Erro ao atualizar registro")
    if not response.json():
        latest, _ = fetch_one("base_rows", {"select": "*", "id": f"eq.{row_id}"})
        return jsonify({"error": "O registro foi alterado por outra pessoa.", "conflict": True, "current": latest}), 409
    return jsonify(response.json()[0])


@treated_base_formula_api.get("/api/treated-bases/<int:workbook_id>/formula-rows")
def formula_rows(workbook_id: int):
    _, role, error = require_treated_base(workbook_id)
    if error:
        return error
    try:
        offset = max(0, int(request.args.get("offset", "0")))
        limit = min(MAX_FORMULA_PAGE, max(1, int(request.args.get("limit", "120"))))
    except ValueError:
        return jsonify({"error": "Janela de fórmulas inválida."}), 400

    columns, columns_response = base_routes.list_columns(workbook_id)
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas")
    rows_response = db(
        "GET",
        "base_rows",
        params={
            "select": "id,row_order,values,formulas,revision,updated_at",
            "workbook_id": f"eq.{workbook_id}",
            "order": "row_order.asc,id.asc",
            "offset": str(offset),
            "limit": str(limit),
        },
    )
    if not rows_response.ok:
        return api_error(rows_response, "Erro ao carregar fórmulas da Base 2")
    rows = []
    for index, row in enumerate(rows_response.json()):
        rows.append({
            **row,
            "index": offset + index,
            "formulas": normalize_formula_map(row.get("formulas")),
        })
    return jsonify({"role": role, "columns": columns, "rows": rows, "offset": offset, "limit": limit})


@treated_base_formula_api.post("/api/treated-bases/<int:workbook_id>/rows/<int:row_id>/formula-result")
def save_formula_result(workbook_id: int, row_id: int):
    _, _, error = require_treated_base(workbook_id, "editor")
    if error:
        return error
    body = json_body()
    column_key = str(body.get("column_key") or "").strip()
    formula = str(body.get("formula") or "")
    if not column_key or not is_formula(formula):
        return jsonify({"error": "Resultado de fórmula inválido."}), 400
    if isinstance(body.get("value"), str) and str(body.get("value")).startswith("#"):
        return jsonify({"error": str(body.get("value"))}), 422

    columns, columns_response = base_routes.columns_by_key(workbook_id)
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas")
    column = columns.get(column_key)
    if not column:
        return jsonify({"error": "Coluna da fórmula não encontrada."}), 404
    try:
        normalized = base_routes.normalize_typed_value(body.get("value"), str(column["data_type"]))
    except (ValueError, TypeError) as validation_error:
        return jsonify({"error": str(validation_error)}), 400

    response = db(
        "POST",
        "rpc/set_treated_base_formula_result",
        payload={
            "p_workbook_id": workbook_id,
            "p_row_id": row_id,
            "p_column_key": column_key,
            "p_formula": formula,
            "p_value": normalized,
            "p_actor": current_email(),
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao gravar o valor calculado")
    result = response.json()
    if isinstance(result, list) and result:
        result = result[0]
    if not isinstance(result, dict):
        result = {}
    if result.get("status") == "stale":
        return jsonify({"error": "A fórmula foi alterada antes do resultado chegar.", **result}), 409
    return jsonify(result)
