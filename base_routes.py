from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, datetime, timezone
from typing import Any

from flask import Blueprint, jsonify, request

from backend import (
    api_error,
    current_email,
    db,
    fetch_one,
    get_folder,
    get_workbook,
    json_body,
    parse_nullable_id,
    parse_required_id,
    require_project,
)
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    STAGE_SOURCE,
    STAGE_TREATED,
    allowed_transition,
    is_base,
    relational_payload,
)


base_api = Blueprint("base_api", __name__)

BASE_STAGES = {STAGE_SOURCE, STAGE_TREATED}
BASE_DATA_TYPES = {"text", "number", "boolean", "date", "datetime", "json"}
MAX_PAGE_SIZE = 500
MAX_BULK_ROWS = 500
MAX_COLUMNS = 200
MAX_CELL_BYTES = 256 * 1024


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def formula_like(value: Any) -> bool:
    if isinstance(value, str):
        return value.lstrip().startswith("=")
    if isinstance(value, list):
        return any(formula_like(item) for item in value)
    if isinstance(value, dict):
        return any(formula_like(item) for item in value.values())
    return False


def normalize_key(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = re.sub(r"[^a-zA-Z0-9_]+", "_", text.strip().lower()).strip("_")
    if not text:
        text = "campo"
    if text[0].isdigit():
        text = f"campo_{text}"
    return text[:64]


def parse_total(response, fallback: int) -> int:
    header = str(response.headers.get("Content-Range") or "")
    if "/" not in header:
        return fallback
    total = header.rsplit("/", 1)[-1]
    try:
        return int(total)
    except ValueError:
        return fallback


def workbook_view(workbook: dict[str, Any], role: str) -> dict[str, Any]:
    return {
        "id": int(workbook["id"]),
        "name": workbook["name"],
        "project_id": int(workbook["project_id"]),
        "folder_id": workbook.get("folder_id"),
        "file_kind": workbook.get("file_kind"),
        "pipeline_stage": workbook.get("pipeline_stage"),
        "revision": int(workbook.get("revision") or 1),
        "updated_at": workbook.get("updated_at"),
        "updated_by_email": workbook.get("updated_by_email"),
        "role": role,
    }


def require_base(workbook_id: int, minimum_role: str = "viewer"):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, api_error(response, "Erro ao localizar a Base")
    if not workbook:
        return None, None, (jsonify({"error": "Base não encontrada."}), 404)
    if not is_base(workbook):
        return None, None, (jsonify({"error": "Este arquivo não é uma Base relacional."}), 409)
    _, role, error = require_project(int(workbook.get("project_id") or 0), minimum_role)
    if error:
        return None, None, error
    return workbook, role, None


def list_columns(workbook_id: int) -> tuple[list[dict[str, Any]], Any]:
    response = db(
        "GET",
        "base_columns",
        params={
            "select": "id,workbook_id,column_key,name,data_type,position,required,default_value,created_at,updated_at",
            "workbook_id": f"eq.{workbook_id}",
            "order": "position.asc,id.asc",
        },
    )
    return (response.json() if response.ok else []), response


def columns_by_key(workbook_id: int) -> tuple[dict[str, dict[str, Any]], Any]:
    columns, response = list_columns(workbook_id)
    return {str(column["column_key"]): column for column in columns}, response


def normalize_typed_value(value: Any, data_type: str) -> Any:
    if formula_like(value):
        raise ValueError("Arquivos Base não aceitam fórmulas.")
    if value is None or value == "":
        return None
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_CELL_BYTES:
        raise ValueError("O valor da célula excede 256 KB.")
    if data_type == "text":
        return str(value)
    if data_type == "number":
        if isinstance(value, bool):
            raise ValueError("Valor numérico inválido.")
        number = float(str(value).replace(",", "."))
        return int(number) if number.is_integer() else number
    if data_type == "boolean":
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {"true", "1", "sim", "verdadeiro"}:
            return True
        if normalized in {"false", "0", "nao", "não", "falso"}:
            return False
        raise ValueError("Valor booleano inválido.")
    if data_type == "date":
        return date.fromisoformat(str(value)[:10]).isoformat()
    if data_type == "datetime":
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    if data_type == "json":
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError as error:
                raise ValueError("JSON inválido.") from error
        if formula_like(value):
            raise ValueError("Arquivos Base não aceitam fórmulas.")
        json.dumps(value, ensure_ascii=False, allow_nan=False)
        return value
    raise ValueError("Tipo de coluna inválido.")


def normalize_values(
    value: Any,
    columns: dict[str, dict[str, Any]],
    *,
    partial: bool,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Os valores da linha devem formar um objeto.")
    unknown = sorted(set(map(str, value.keys())) - set(columns))
    if unknown:
        raise ValueError(f"Coluna desconhecida: {unknown[0]}.")
    output: dict[str, Any] = {}
    for key, column in columns.items():
        if key in value:
            output[key] = normalize_typed_value(value[key], str(column["data_type"]))
        elif not partial:
            default = column.get("default_value")
            output[key] = normalize_typed_value(default, str(column["data_type"])) if default is not None else None
        if not partial and bool(column.get("required")) and output.get(key) is None:
            raise ValueError(f"A coluna {column['name']} é obrigatória.")
    return output


def next_column_position(workbook_id: int) -> int:
    response = db(
        "GET",
        "base_columns",
        params={
            "select": "position",
            "workbook_id": f"eq.{workbook_id}",
            "order": "position.desc",
            "limit": "1",
        },
    )
    return int(response.json()[0]["position"]) + 1 if response.ok and response.json() else 0


def next_row_order(workbook_id: int) -> int:
    response = db(
        "GET",
        "base_rows",
        params={
            "select": "row_order",
            "workbook_id": f"eq.{workbook_id}",
            "order": "row_order.desc",
            "limit": "1",
        },
    )
    return int(response.json()[0]["row_order"]) + 1 if response.ok and response.json() else 0


def unique_column_key(workbook_id: int, requested: str) -> str:
    base = normalize_key(requested)
    response = db(
        "GET",
        "base_columns",
        params={
            "select": "column_key",
            "workbook_id": f"eq.{workbook_id}",
            "column_key": f"like.{base}*",
        },
    )
    existing = {str(item["column_key"]) for item in response.json()} if response.ok else set()
    if base not in existing:
        return base
    suffix = 2
    while f"{base}_{suffix}" in existing:
        suffix += 1
    return f"{base}_{suffix}"


@base_api.post("/api/bases")
def create_base():
    body = json_body()
    project_id, message = parse_required_id(body.get("project_id"), "Projeto")
    if message:
        return jsonify({"error": message}), 400
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    name = str(body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Informe o nome da Base."}), 400
    stage = str(body.get("pipeline_stage") or STAGE_SOURCE).strip().lower()
    if stage not in BASE_STAGES:
        return jsonify({"error": "A Base deve ser de entrada ou tratada."}), 400
    folder_id, message = parse_nullable_id(body.get("folder_id"), "Pasta")
    if message:
        return jsonify({"error": message}), 400
    if folder_id is not None:
        folder, response = get_folder(folder_id)
        if not response.ok:
            return api_error(response, "Erro ao validar a pasta")
        if not folder or int(folder.get("project_id") or 0) != project_id:
            return jsonify({"error": "Pasta não pertence ao projeto."}), 400
    email = current_email()
    response = db(
        "POST",
        "workbooks",
        payload={
            "name": name,
            "payload": relational_payload(name, stage),
            "folder_id": folder_id,
            "project_id": project_id,
            "revision": 1,
            "file_kind": FILE_KIND_BASE,
            "pipeline_stage": stage,
            "created_by_email": email,
            "updated_by_email": email,
        },
        prefer="return=representation",
    )
    if response.status_code == 409:
        return jsonify({"error": "Já existe um arquivo com esse nome neste local."}), 409
    if not response.ok or not response.json():
        return api_error(response, "Erro ao criar a Base")
    workbook = response.json()[0]
    column_response = db(
        "POST",
        "base_columns",
        payload={
            "workbook_id": workbook["id"],
            "column_key": "campo_1",
            "name": "Campo 1",
            "data_type": "text",
            "position": 0,
        },
        prefer="return=representation",
    )
    if not column_response.ok:
        db("DELETE", "workbooks", params={"id": f"eq.{workbook['id']}"}, prefer="return=minimal")
        return api_error(column_response, "Erro ao criar a primeira coluna")
    return jsonify({
        "id": int(workbook["id"]),
        "name": workbook["name"],
        "file_kind": FILE_KIND_BASE,
        "pipeline_stage": stage,
        "revision": int(workbook.get("revision") or 1),
    })


@base_api.get("/api/bases/<int:workbook_id>")
def get_base(workbook_id: int):
    workbook, role, error = require_base(workbook_id)
    if error:
        return error
    try:
        offset = max(0, int(request.args.get("offset", "0")))
        limit = min(MAX_PAGE_SIZE, max(1, int(request.args.get("limit", "120"))))
    except ValueError:
        return jsonify({"error": "Janela de linhas inválida."}), 400
    columns, response = list_columns(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar colunas")
    rows = db(
        "GET",
        "base_rows",
        params={
            "select": "id,workbook_id,row_order,values,revision,created_at,updated_at,updated_by_email",
            "workbook_id": f"eq.{workbook_id}",
            "order": "row_order.asc,id.asc",
            "offset": str(offset),
            "limit": str(limit),
        },
        prefer="count=exact",
    )
    if not rows.ok:
        return api_error(rows, "Erro ao carregar registros")
    result = rows.json()
    return jsonify({
        "workbook": workbook_view(workbook, role),
        "columns": columns,
        "rows": result,
        "window": {
            "offset": offset,
            "limit": limit,
            "returned": len(result),
            "total": parse_total(rows, offset + len(result)),
        },
    })


@base_api.patch("/api/bases/<int:workbook_id>")
def rename_base(workbook_id: int):
    workbook, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    name = str(json_body().get("name") or "").strip()
    if not name:
        return jsonify({"error": "Informe o nome da Base."}), 400
    current_revision = int(workbook.get("revision") or 1)
    response = db(
        "PATCH",
        "workbooks",
        params={"id": f"eq.{workbook_id}", "revision": f"eq.{current_revision}"},
        payload={
            "name": name,
            "revision": current_revision + 1,
            "updated_by_email": current_email(),
        },
        prefer="return=representation",
    )
    if response.status_code == 409:
        return jsonify({"error": "Já existe um arquivo com esse nome neste local."}), 409
    if not response.ok or not response.json():
        return jsonify({"error": "A Base foi alterada por outra pessoa."}), 409
    return jsonify(response.json()[0])


@base_api.post("/api/bases/<int:workbook_id>/columns")
def create_column(workbook_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    existing, response = list_columns(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar colunas")
    if len(existing) >= MAX_COLUMNS:
        return jsonify({"error": f"Uma Base aceita no máximo {MAX_COLUMNS} colunas."}), 400
    body = json_body()
    name = str(body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Informe o nome da coluna."}), 400
    data_type = str(body.get("data_type") or "text").strip().lower()
    if data_type not in BASE_DATA_TYPES:
        return jsonify({"error": "Tipo de coluna inválido."}), 400
    try:
        default_value = normalize_typed_value(body.get("default_value"), data_type) if body.get("default_value") not in (None, "") else None
    except (ValueError, TypeError) as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    response = db(
        "POST",
        "base_columns",
        payload={
            "workbook_id": workbook_id,
            "column_key": unique_column_key(workbook_id, body.get("column_key") or name),
            "name": name,
            "data_type": data_type,
            "position": next_column_position(workbook_id),
            "required": bool(body.get("required")),
            "default_value": default_value,
        },
        prefer="return=representation",
    )
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao criar coluna")


@base_api.patch("/api/bases/<int:workbook_id>/columns/<int:column_id>")
def update_column(workbook_id: int, column_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    column, response = fetch_one(
        "base_columns",
        {"select": "*", "id": f"eq.{column_id}", "workbook_id": f"eq.{workbook_id}"},
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar coluna")
    if not column:
        return jsonify({"error": "Coluna não encontrada."}), 404
    body = json_body()
    payload: dict[str, Any] = {"updated_at": now_iso()}
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Informe o nome da coluna."}), 400
        payload["name"] = name
    if "required" in body:
        payload["required"] = bool(body.get("required"))
    if "data_type" in body:
        data_type = str(body.get("data_type") or "").strip().lower()
        if data_type not in BASE_DATA_TYPES:
            return jsonify({"error": "Tipo de coluna inválido."}), 400
        payload["data_type"] = data_type
    response = db(
        "PATCH",
        "base_columns",
        params={"id": f"eq.{column_id}", "workbook_id": f"eq.{workbook_id}"},
        payload=payload,
        prefer="return=representation",
    )
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao atualizar coluna")


@base_api.delete("/api/bases/<int:workbook_id>/columns/<int:column_id>")
def delete_column(workbook_id: int, column_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    response = db(
        "DELETE",
        "base_columns",
        params={"id": f"eq.{column_id}", "workbook_id": f"eq.{workbook_id}"},
        prefer="return=representation",
    )
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir coluna")


@base_api.post("/api/bases/<int:workbook_id>/rows")
def create_row(workbook_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    columns, response = columns_by_key(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar colunas")
    try:
        values = normalize_values(json_body().get("values") or {}, columns, partial=False)
    except (ValueError, TypeError) as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    email = current_email()
    order = next_row_order(workbook_id)
    for _ in range(2):
        response = db(
            "POST",
            "base_rows",
            payload={
                "workbook_id": workbook_id,
                "row_order": order,
                "values": values,
                "revision": 1,
                "created_by_email": email,
                "updated_by_email": email,
            },
            prefer="return=representation",
        )
        if response.status_code != 409:
            break
        order += 1
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao criar registro")


@base_api.post("/api/bases/<int:workbook_id>/rows/bulk")
def create_rows_bulk(workbook_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    raw_rows = json_body().get("rows")
    if not isinstance(raw_rows, list) or not raw_rows or len(raw_rows) > MAX_BULK_ROWS:
        return jsonify({"error": f"Envie entre 1 e {MAX_BULK_ROWS} registros."}), 400
    columns, response = columns_by_key(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar colunas")
    start = next_row_order(workbook_id)
    email = current_email()
    payload = []
    try:
        for index, row in enumerate(raw_rows):
            payload.append({
                "workbook_id": workbook_id,
                "row_order": start + index,
                "values": normalize_values(row, columns, partial=False),
                "revision": 1,
                "created_by_email": email,
                "updated_by_email": email,
            })
    except (ValueError, TypeError) as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    response = db("POST", "base_rows", payload=payload, prefer="return=representation")
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao importar registros")


@base_api.patch("/api/bases/<int:workbook_id>/rows/<int:row_id>")
def update_row(workbook_id: int, row_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    row, response = fetch_one(
        "base_rows",
        {
            "select": "id,workbook_id,row_order,values,revision,updated_at,updated_by_email",
            "id": f"eq.{row_id}",
            "workbook_id": f"eq.{workbook_id}",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar registro")
    if not row:
        return jsonify({"error": "Registro não encontrado."}), 404
    body = json_body()
    try:
        base_revision = int(body.get("base_revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão do registro inválida."}), 400
    current_revision = int(row.get("revision") or 1)
    if base_revision != current_revision:
        return jsonify({"error": "O registro foi alterado por outra pessoa.", "conflict": True, "current": row}), 409
    columns, columns_response = columns_by_key(workbook_id)
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas")
    try:
        partial = normalize_values(body.get("values") or {}, columns, partial=True)
        merged = {**(row.get("values") or {}), **partial}
        for key, column in columns.items():
            if bool(column.get("required")) and merged.get(key) is None:
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
            "values": merged,
            "revision": current_revision + 1,
            "updated_by_email": current_email(),
            "updated_at": now_iso(),
        },
        prefer="return=representation",
    )
    if not response.ok:
        return api_error(response, "Erro ao atualizar registro")
    if not response.json():
        latest, _ = fetch_one("base_rows", {"select": "*", "id": f"eq.{row_id}"})
        return jsonify({"error": "O registro foi alterado por outra pessoa.", "conflict": True, "current": latest}), 409
    return jsonify(response.json()[0])


@base_api.delete("/api/bases/<int:workbook_id>/rows/<int:row_id>")
def delete_row(workbook_id: int, row_id: int):
    _, _, error = require_base(workbook_id, "editor")
    if error:
        return error
    response = db(
        "DELETE",
        "base_rows",
        params={"id": f"eq.{row_id}", "workbook_id": f"eq.{workbook_id}"},
        prefer="return=representation",
    )
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir registro")


@base_api.get("/api/projects/<int:project_id>/file-dependencies")
def list_file_dependencies(project_id: int):
    _, _, error = require_project(project_id, "viewer")
    if error:
        return error
    response = db(
        "GET",
        "file_dependencies",
        params={
            "select": "id,project_id,source_workbook_id,target_workbook_id,created_at,created_by_email",
            "project_id": f"eq.{project_id}",
            "order": "created_at.asc",
        },
    )
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar dependências")


@base_api.post("/api/file-dependencies")
def create_file_dependency():
    body = json_body()
    source_id, message = parse_required_id(body.get("source_workbook_id"), "Arquivo de origem")
    if message:
        return jsonify({"error": message}), 400
    target_id, message = parse_required_id(body.get("target_workbook_id"), "Arquivo de destino")
    if message:
        return jsonify({"error": message}), 400
    source, source_response = get_workbook(source_id)
    target, target_response = get_workbook(target_id)
    if not source_response.ok or not target_response.ok:
        return jsonify({"error": "Erro ao validar os arquivos."}), 503
    if not source or not target:
        return jsonify({"error": "Arquivo de origem ou destino não encontrado."}), 404
    project_id = int(source.get("project_id") or 0)
    if project_id != int(target.get("project_id") or 0):
        return jsonify({"error": "Os arquivos devem pertencer ao mesmo projeto."}), 400
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    if not allowed_transition(source.get("pipeline_stage"), target.get("pipeline_stage")):
        return jsonify({"error": "Use Base → Planilhas → Base 2 → Elementar."}), 400
    response = db(
        "POST",
        "file_dependencies",
        payload={
            "project_id": project_id,
            "source_workbook_id": source_id,
            "target_workbook_id": target_id,
            "created_by_email": current_email(),
        },
        prefer="return=representation",
    )
    if response.status_code == 409:
        return jsonify({"error": "Esta dependência já existe."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao criar dependência")


@base_api.delete("/api/file-dependencies/<int:dependency_id>")
def delete_file_dependency(dependency_id: int):
    dependency, response = fetch_one(
        "file_dependencies",
        {"select": "id,project_id", "id": f"eq.{dependency_id}"},
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar dependência")
    if not dependency:
        return jsonify({"error": "Dependência não encontrada."}), 404
    _, _, error = require_project(int(dependency["project_id"]), "editor")
    if error:
        return error
    response = db("DELETE", "file_dependencies", params={"id": f"eq.{dependency_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir dependência")
