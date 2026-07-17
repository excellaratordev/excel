from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, jsonify, request

from backend import api_error, current_email, db, fetch_one, get_workbook, json_body, require_project
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    FILE_KIND_SPREADSHEET,
    STAGE_CALCULATION,
    STAGE_TREATED,
    allowed_transition,
)
from superexcel.core.workbook_payload import iter_non_empty_cells


treated_base_api = Blueprint("treated_base_api", __name__)

CELL_RE = re.compile(r"^\$?([A-Z]{1,3})\$?([1-9]\d*)$", re.IGNORECASE)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
MAX_SOURCE_ROWS = 5000
MAX_SOURCE_COLS = 300
MAX_SELECTION_CELLS = 100_000
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_PREVIEW_ROWS = 240
MAX_PREVIEW_COLS = 60
BASE_DATA_MUTATION_RE = re.compile(r"^/api/bases/(\d+)/(?:columns(?:/\d+)?|rows(?:/\d+)?)$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def column_index(name: str) -> int:
    result = 0
    for letter in name.upper():
        result = result * 26 + ord(letter) - 64
    return result - 1


def column_name(index: int) -> str:
    result = ""
    number = index + 1
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_cell(value: Any) -> tuple[int, int]:
    match = CELL_RE.fullmatch(str(value or "").strip())
    if not match:
        raise ValueError(f"Referência inválida: {value}.")
    return int(match.group(2)) - 1, column_index(match.group(1))


def normalize_range(start: Any, end: Any) -> dict[str, Any]:
    start_row, start_col = parse_cell(start)
    end_row, end_col = parse_cell(end or start)
    top, bottom = sorted((start_row, end_row))
    left, right = sorted((start_col, end_col))
    if bottom >= MAX_SOURCE_ROWS or right >= MAX_SOURCE_COLS:
        raise ValueError("A seleção excede o limite da planilha.")
    cell_count = (bottom - top + 1) * (right - left + 1)
    if cell_count > MAX_SELECTION_CELLS:
        raise ValueError("A seleção excede 100.000 células.")
    start_address = f"{column_name(left)}{top + 1}"
    end_address = f"{column_name(right)}{bottom + 1}"
    return {
        "top_row": top,
        "bottom_row": bottom,
        "left_col": left,
        "right_col": right,
        "source_range": start_address if start_address == end_address else f"{start_address}:{end_address}",
        "cell_count": cell_count,
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
        return None, None, (
            jsonify({"error": "Esta funcionalidade está disponível somente em Bases 2 tratadas."}),
            409,
        )
    _, role, error = require_project(int(workbook.get("project_id") or 0), minimum_role)
    if error:
        return None, None, error
    return workbook, role, None


def require_calculation_source(source_id: int, target: dict[str, Any] | None = None, include_payload: bool = False):
    source, response = get_workbook(source_id, include_payload=include_payload)
    if not response.ok:
        return None, api_error(response, "Erro ao localizar a Planilha")
    if not source:
        return None, (jsonify({"error": "Planilha não encontrada."}), 404)
    if not (
        source.get("file_kind") == FILE_KIND_SPREADSHEET
        and source.get("pipeline_stage") == STAGE_CALCULATION
    ):
        return None, (jsonify({"error": "A origem deve ser uma Planilha da etapa 2."}), 409)
    if target and not (
        int(source.get("project_id") or 0) == int(target.get("project_id") or 0)
        and allowed_transition(source.get("pipeline_stage"), target.get("pipeline_stage"))
    ):
        return None, (jsonify({"error": "Esta Planilha não pode alimentar a Base 2 atual."}), 409)
    return source, None


def binding_for(target_workbook_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "treated_base_bindings",
        {
            "select": "*",
            "target_workbook_id": f"eq.{target_workbook_id}",
        },
    )


def source_snapshot(source_workbook_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "treated_base_source_snapshots",
        {
            "select": "source_workbook_id,revision,payload,payload_hash,updated_at,updated_by_email",
            "source_workbook_id": f"eq.{source_workbook_id}",
        },
    )


def payload_map(payload: Any) -> dict[tuple[int, int], Any]:
    source = payload if isinstance(payload, dict) else {}
    return {(row, col): value for row, col, value in iter_non_empty_cells(source)}


def snapshot_map(snapshot: dict[str, Any] | None) -> dict[tuple[int, int], Any]:
    output: dict[tuple[int, int], Any] = {}
    for item in ((snapshot or {}).get("payload") or {}).get("cells", []):
        if not isinstance(item, dict):
            continue
        try:
            row, col = int(item.get("r")), int(item.get("c"))
        except (TypeError, ValueError):
            continue
        if 0 <= row < MAX_SOURCE_ROWS and 0 <= col < MAX_SOURCE_COLS:
            output[(row, col)] = item.get("v")
    return output


def source_shape(source: dict[str, Any], raw_values: dict[tuple[int, int], Any], computed_values: dict[tuple[int, int], Any]) -> tuple[int, int]:
    payload = source.get("payload") if isinstance(source.get("payload"), dict) else {}
    try:
        declared_rows = int(payload.get("rows") or 60)
    except (TypeError, ValueError):
        declared_rows = 60
    try:
        declared_cols = int(payload.get("cols") or 26)
    except (TypeError, ValueError):
        declared_cols = 26
    coordinates = [*raw_values.keys(), *computed_values.keys()]
    used_row = max((row for row, _ in coordinates), default=-1)
    used_col = max((col for _, col in coordinates), default=-1)
    rows = min(MAX_SOURCE_ROWS, max(60, min(declared_rows, 400), used_row + 12))
    cols = min(MAX_SOURCE_COLS, max(26, min(declared_cols, 80), used_col + 4))
    return rows, cols


def formula_in_range(raw_values: dict[tuple[int, int], Any], bounds: dict[str, Any]) -> bool:
    for (row, col), value in raw_values.items():
        if not (bounds["top_row"] <= row <= bounds["bottom_row"]):
            continue
        if not (bounds["left_col"] <= col <= bounds["right_col"]):
            continue
        if isinstance(value, str) and value.lstrip().startswith("="):
            return True
    return False


def normalize_key(value: Any, fallback: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = re.sub(r"[^a-zA-Z0-9_]+", "_", text.strip().lower()).strip("_")
    if not text:
        text = fallback
    if text[0].isdigit():
        text = f"campo_{text}"
    return text[:64]


def infer_type(values: list[Any]) -> str:
    meaningful = [value for value in values if value not in (None, "")]
    if not meaningful:
        return "text"
    if all(isinstance(value, bool) for value in meaningful):
        return "boolean"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in meaningful):
        return "number"
    if all(isinstance(value, str) and DATE_RE.fullmatch(value) for value in meaningful):
        return "date"
    if all(isinstance(value, str) and DATETIME_RE.match(value) for value in meaningful):
        return "datetime"
    if all(isinstance(value, (dict, list)) for value in meaningful):
        return "json"
    return "text"


def coerce_value(value: Any, data_type: str) -> Any:
    if value in (None, ""):
        return None
    if isinstance(value, str) and value.startswith("#"):
        raise ValueError(f"A Planilha contém o erro {value} dentro da seleção.")
    if data_type == "text":
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)
    if data_type == "number":
        return value
    if data_type == "boolean":
        return bool(value)
    return value


def build_materialization(
    binding: dict[str, Any],
    source: dict[str, Any],
    snapshot: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    bounds = {
        "top_row": int(binding["top_row"]),
        "bottom_row": int(binding["bottom_row"]),
        "left_col": int(binding["left_col"]),
        "right_col": int(binding["right_col"]),
    }
    raw_values = payload_map(source.get("payload"))
    computed_values = snapshot_map(snapshot)
    source_revision = int(source.get("revision") or 0)
    snapshot_revision = int((snapshot or {}).get("revision") or 0)
    has_formulas = formula_in_range(raw_values, bounds)
    if has_formulas and snapshot_revision < source_revision:
        raise RuntimeError("Aguardando os valores calculados mais recentes da Planilha.")

    values = dict(raw_values)
    values.update(computed_values)
    matrix = [
        [values.get((row, col)) for col in range(bounds["left_col"], bounds["right_col"] + 1)]
        for row in range(bounds["top_row"], bounds["bottom_row"] + 1)
    ]
    if not matrix:
        raise ValueError("A seleção não possui células.")

    header_row = bool(binding.get("header_row", True))
    header_values = matrix[0] if header_row else []
    data_matrix = matrix[1:] if header_row else matrix
    while data_matrix and all(value in (None, "") for value in data_matrix[-1]):
        data_matrix.pop()

    width = bounds["right_col"] - bounds["left_col"] + 1
    used_keys: set[str] = set()
    columns: list[dict[str, Any]] = []
    for index in range(width):
        letter = column_name(bounds["left_col"] + index)
        requested_name = str(header_values[index]).strip() if index < len(header_values) and header_values[index] not in (None, "") else f"Coluna {letter}"
        key = normalize_key(requested_name, f"coluna_{letter.lower()}")
        if key in used_keys:
            suffix = 2
            while f"{key}_{suffix}" in used_keys:
                suffix += 1
            key = f"{key}_{suffix}"
        used_keys.add(key)
        column_values = [row[index] if index < len(row) else None for row in data_matrix]
        columns.append({
            "column_key": key,
            "name": requested_name[:120],
            "data_type": infer_type(column_values),
            "position": index,
            "required": False,
        })

    rows: list[dict[str, Any]] = []
    for row in data_matrix:
        if all(value in (None, "") for value in row):
            continue
        values_object = {
            column["column_key"]: coerce_value(row[index] if index < len(row) else None, column["data_type"])
            for index, column in enumerate(columns)
        }
        rows.append({"row_order": len(rows), "values": values_object})

    meta = {
        "source_revision": source_revision,
        "snapshot_revision": snapshot_revision,
        "has_formulas": has_formulas,
        "column_count": len(columns),
        "row_count": len(rows),
    }
    return columns, rows, meta


def materialize_binding(target: dict[str, Any], binding: dict[str, Any], source: dict[str, Any] | None = None) -> dict[str, Any]:
    if source is None:
        source, error = require_calculation_source(int(binding["source_workbook_id"]), target, include_payload=True)
        if error:
            return {"status": "error", "error": "A Planilha vinculada não está disponível."}
    snapshot, response = source_snapshot(int(binding["source_workbook_id"]))
    if not response.ok:
        return {"status": "error", "error": "Erro ao carregar o snapshot calculado da Planilha."}
    snapshot_revision = int((snapshot or {}).get("revision") or 0)
    try:
        columns, rows, meta = build_materialization(binding, source, snapshot)
    except RuntimeError as error:
        return {
            "status": "pending",
            "error": str(error),
            "source_revision": int(source.get("revision") or 0),
            "snapshot_revision": snapshot_revision,
        }
    except ValueError as error:
        return {"status": "error", "error": str(error)}

    effective_revision = int(meta["snapshot_revision"] or meta["source_revision"])
    if effective_revision == int(binding.get("source_revision") or 0):
        return {
            "status": "unchanged",
            "source_revision": effective_revision,
            "source_range": binding.get("source_range"),
            "row_count": meta["row_count"],
            "column_count": meta["column_count"],
        }

    response = db(
        "POST",
        "rpc/materialize_treated_base",
        payload={
            "p_target_workbook_id": int(target["id"]),
            "p_source_workbook_id": int(source["id"]),
            "p_source_revision": effective_revision,
            "p_source_range": str(binding["source_range"]),
            "p_columns": columns,
            "p_rows": rows,
            "p_actor": current_email(),
        },
    )
    if not response.ok:
        try:
            message = response.json().get("message")
        except ValueError:
            message = None
        return {"status": "error", "error": message or "Erro ao materializar a Base 2."}
    result = response.json()
    if isinstance(result, list) and result:
        result = result[0]
    if not isinstance(result, dict):
        result = {}
    return {
        "status": "materialized",
        "source_revision": effective_revision,
        "source_range": binding["source_range"],
        "row_count": meta["row_count"],
        "column_count": meta["column_count"],
        "target_revision": int(result.get("target_revision") or 0),
    }


@treated_base_api.before_app_request
def protect_materialized_treated_data():
    if request.method not in {"POST", "PATCH", "DELETE"}:
        return None
    match = BASE_DATA_MUTATION_RE.fullmatch(request.path)
    if not match:
        return None
    workbook, response = get_workbook(int(match.group(1)))
    if not response.ok or not workbook:
        return None
    if workbook.get("file_kind") == FILE_KIND_BASE and workbook.get("pipeline_stage") == STAGE_TREATED:
        return jsonify({
            "error": "A Base 2 é materializada pela Planilha vinculada. Altere a Planilha ou selecione outro intervalo."
        }), 409
    return None


def normalize_snapshot_cells(value: Any) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not isinstance(value, list) or len(value) > MAX_SELECTION_CELLS:
        return None, "Envie no máximo 100.000 células calculadas."
    output: dict[tuple[int, int], dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict):
            return None, "Célula calculada inválida."
        try:
            row, col = int(item.get("r")), int(item.get("c"))
        except (TypeError, ValueError):
            return None, "Coordenadas calculadas inválidas."
        if row < 0 or row >= MAX_SOURCE_ROWS or col < 0 or col >= MAX_SOURCE_COLS:
            return None, "Célula calculada fora do limite permitido."
        cell = {"r": row, "c": col, "v": item.get("v")}
        if item.get("t"):
            cell["t"] = str(item.get("t"))[:24]
        output[(row, col)] = cell
    cells = list(output.values())
    try:
        encoded = json.dumps({"cells": cells}, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        return None, "Os valores calculados não formam um JSON válido."
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        return None, "O snapshot calculado excede 4 MB."
    return cells, None


@treated_base_api.get("/api/treated-bases/<int:workbook_id>/sources")
def list_sources(workbook_id: int):
    target, role, error = require_treated_base(workbook_id)
    if error:
        return error
    response = db(
        "GET",
        "workbooks",
        params={
            "select": "id,name,revision,updated_at,updated_by_email,file_kind,pipeline_stage,project_id",
            "project_id": f"eq.{target['project_id']}",
            "file_kind": f"eq.{FILE_KIND_SPREADSHEET}",
            "pipeline_stage": f"eq.{STAGE_CALCULATION}",
            "order": "name.asc,id.asc",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao listar Planilhas de cálculo")
    binding, binding_response = binding_for(workbook_id)
    if not binding_response.ok:
        return api_error(binding_response, "Erro ao carregar o vínculo da Base 2")
    return jsonify({
        "target": {
            "id": int(target["id"]),
            "name": target["name"],
            "revision": int(target.get("revision") or 1),
            "role": role,
        },
        "sources": [
            {
                "id": int(item["id"]),
                "name": item["name"],
                "revision": int(item.get("revision") or 1),
                "updated_at": item.get("updated_at"),
                "updated_by_email": item.get("updated_by_email"),
                "bound": bool(binding and int(binding["source_workbook_id"]) == int(item["id"])),
            }
            for item in response.json()
        ],
        "binding": binding,
    })


@treated_base_api.get("/api/treated-bases/<int:workbook_id>/sources/<int:source_id>")
def preview_source(workbook_id: int, source_id: int):
    target, role, error = require_treated_base(workbook_id)
    if error:
        return error
    source, source_error = require_calculation_source(source_id, target, include_payload=True)
    if source_error:
        return source_error
    try:
        row_offset = max(0, int(request.args.get("row_offset", "0")))
        col_offset = max(0, int(request.args.get("col_offset", "0")))
        row_limit = min(MAX_PREVIEW_ROWS, max(1, int(request.args.get("row_limit", "120"))))
        col_limit = min(MAX_PREVIEW_COLS, max(1, int(request.args.get("col_limit", "30"))))
    except ValueError:
        return jsonify({"error": "Janela de visualização inválida."}), 400

    snapshot, snapshot_response = source_snapshot(source_id)
    if not snapshot_response.ok:
        return api_error(snapshot_response, "Erro ao carregar valores calculados")
    raw_values = payload_map(source.get("payload"))
    computed_values = snapshot_map(snapshot)
    rows, cols = source_shape(source, raw_values, computed_values)
    row_end = min(rows, row_offset + row_limit)
    col_end = min(cols, col_offset + col_limit)
    cells = []
    for row in range(row_offset, row_end):
        for col in range(col_offset, col_end):
            key = (row, col)
            if key in computed_values:
                cells.append({"r": row, "c": col, "v": computed_values[key], "computed": True})
            elif key in raw_values:
                cells.append({"r": row, "c": col, "v": raw_values[key], "computed": False})
    return jsonify({
        "role": role,
        "source": {
            "id": int(source["id"]),
            "name": source["name"],
            "revision": int(source.get("revision") or 1),
            "snapshot_revision": int((snapshot or {}).get("revision") or 0),
            "snapshot_updated_at": (snapshot or {}).get("updated_at"),
        },
        "shape": {"rows": rows, "cols": cols},
        "window": {
            "row_offset": row_offset,
            "col_offset": col_offset,
            "row_limit": row_limit,
            "col_limit": col_limit,
        },
        "cells": cells,
    })


@treated_base_api.post("/api/treated-bases/<int:workbook_id>/binding")
def save_binding(workbook_id: int):
    target, role, error = require_treated_base(workbook_id, "editor")
    if error:
        return error
    body = json_body()
    try:
        source_id = int(body.get("source_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Informe a Planilha de origem."}), 400
    source, source_error = require_calculation_source(source_id, target, include_payload=True)
    if source_error:
        return source_error
    try:
        bounds = normalize_range(body.get("start"), body.get("end"))
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400

    actor = current_email()
    payload = {
        "target_workbook_id": workbook_id,
        "project_id": int(target["project_id"]),
        "source_workbook_id": source_id,
        "source_name": source["name"],
        "source_range": bounds["source_range"],
        "top_row": bounds["top_row"],
        "bottom_row": bounds["bottom_row"],
        "left_col": bounds["left_col"],
        "right_col": bounds["right_col"],
        "header_row": bool(body.get("header_row", True)),
        "source_revision": 0,
        "synced_at": None,
        "synced_by_email": None,
        "updated_by_email": actor,
        "updated_at": now_iso(),
    }
    response = db(
        "POST",
        "treated_base_bindings",
        params={"on_conflict": "target_workbook_id"},
        payload=payload,
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not response.ok or not response.json():
        return api_error(response, "Erro ao vincular a Planilha à Base 2")
    binding = response.json()[0]
    dependency = db(
        "POST",
        "file_dependencies",
        params={"on_conflict": "source_workbook_id,target_workbook_id"},
        payload={
            "project_id": int(target["project_id"]),
            "source_workbook_id": source_id,
            "target_workbook_id": workbook_id,
            "created_by_email": actor,
        },
        prefer="resolution=merge-duplicates,return=minimal",
    )
    if not dependency.ok:
        return api_error(dependency, "Erro ao registrar a dependência Planilha → Base 2")
    result = materialize_binding(target, binding, source)
    return jsonify({"binding": binding, "result": result, "role": role})


@treated_base_api.post("/api/treated-bases/<int:workbook_id>/sync")
def sync_binding(workbook_id: int):
    target, role, error = require_treated_base(workbook_id, "editor")
    if error:
        return error
    binding, response = binding_for(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar o vínculo da Base 2")
    if not binding:
        return jsonify({"error": "Selecione um intervalo de uma Planilha antes de sincronizar."}), 409
    result = materialize_binding(target, binding)
    status = 200 if result.get("status") != "error" else 409
    return jsonify({"binding": binding, "result": result, "role": role}), status


@treated_base_api.get("/api/treated-bases/sources/<int:source_workbook_id>/dependencies")
def source_dependencies(source_workbook_id: int):
    source, source_error = require_calculation_source(source_workbook_id)
    if source_error:
        return source_error
    _, role, error = require_project(int(source["project_id"]), "viewer")
    if error:
        return error
    response = db(
        "GET",
        "treated_base_bindings",
        params={
            "select": "target_workbook_id,top_row,bottom_row,left_col,right_col,source_range,updated_at",
            "source_workbook_id": f"eq.{source_workbook_id}",
            "order": "target_workbook_id.asc",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao carregar dependências da Base 2")
    ranges = []
    seen = set()
    for item in response.json():
        key = (
            int(item["top_row"]),
            int(item["bottom_row"]),
            int(item["left_col"]),
            int(item["right_col"]),
        )
        if key in seen:
            continue
        seen.add(key)
        ranges.append({"top": key[0], "bottom": key[1], "left": key[2], "right": key[3]})
    return jsonify({
        "source_workbook_id": source_workbook_id,
        "revision": int(source.get("revision") or 0),
        "role": role,
        "ranges": ranges,
        "dependency_count": len(response.json()),
    })


@treated_base_api.post("/api/treated-bases/sources/<int:source_workbook_id>/calculated-snapshot")
def save_calculated_snapshot(source_workbook_id: int):
    source, source_error = require_calculation_source(source_workbook_id)
    if source_error:
        return source_error
    _, _, error = require_project(int(source["project_id"]), "editor")
    if error:
        return error
    body = json_body()
    try:
        revision = int(body.get("revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão calculada inválida."}), 400
    current_revision = int(source.get("revision") or 0)
    if revision != current_revision:
        return jsonify({
            "error": "Os valores calculados pertencem a uma revisão desatualizada.",
            "current_revision": current_revision,
        }), 409
    cells, message = normalize_snapshot_cells(body.get("cells"))
    if message:
        return jsonify({"error": message}), 400
    payload = {"version": 1, "cells": cells or [], "generated_at": now_iso()}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    response = db(
        "POST",
        "treated_base_source_snapshots",
        params={"on_conflict": "source_workbook_id"},
        payload={
            "source_workbook_id": source_workbook_id,
            "revision": revision,
            "payload": payload,
            "payload_hash": digest,
            "updated_by_email": current_email(),
            "updated_at": now_iso(),
        },
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not response.ok:
        return api_error(response, "Erro ao salvar valores calculados da Base 2")

    bindings = db(
        "GET",
        "treated_base_bindings",
        params={"select": "*", "source_workbook_id": f"eq.{source_workbook_id}"},
    )
    if not bindings.ok:
        return api_error(bindings, "Erro ao localizar Bases 2 dependentes")
    results = []
    for binding in bindings.json():
        target, target_response = get_workbook(int(binding["target_workbook_id"]))
        if not target_response.ok or not target:
            results.append({"workbook_id": int(binding["target_workbook_id"]), "status": "error"})
            continue
        result = materialize_binding(target, binding, {**source, "payload": None})
        results.append({"workbook_id": int(target["id"]), **result})
    return jsonify({
        "source_workbook_id": source_workbook_id,
        "revision": revision,
        "results": results,
        "materialized": sum(1 for item in results if item.get("status") == "materialized"),
        "unchanged": sum(1 for item in results if item.get("status") == "unchanged"),
        "pending": sum(1 for item in results if item.get("status") == "pending"),
    })
