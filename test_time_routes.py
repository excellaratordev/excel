from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from flask import Blueprint, jsonify

from backend import api_error, current_email, db, fetch_one, get_workbook, json_body, require_project
from base_routes import list_columns


test_time_api = Blueprint("test_time_api", __name__)

CELL_RE = re.compile(r"^\$?([A-Z]{1,3})\$?([1-9]\d*)$", re.IGNORECASE)
HASH_RE = re.compile(r"^[a-f0-9]{16,128}$", re.IGNORECASE)
MAX_GROUP_CELLS = 10_000
MAX_PREVIEW_BYTES = 32 * 1024
MAX_CHANGED_CELLS = 100
MAX_TIMELINE_EVENTS = 500

STAGES = {
    "source": (1, "Base", "base"),
    "calculation": (2, "Planilha", "sheet"),
    "treated": (3, "Base 2", "base"),
    "publication": (4, "Elementar", "elementar"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def column_index(name: str) -> int:
    result = 0
    for letter in str(name).upper():
        result = result * 26 + ord(letter) - 64
    return result - 1


def column_name(index: int) -> str:
    result = ""
    number = int(index) + 1
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_cell(value: Any) -> tuple[int, int]:
    match = CELL_RE.fullmatch(str(value or "").strip())
    if not match:
        raise ValueError(f"Referência inválida: {value}.")
    return int(match.group(2)) - 1, column_index(match.group(1))


def normalize_range(start: Any, end: Any = None) -> dict[str, Any]:
    start_row, start_col = parse_cell(start)
    end_row, end_col = parse_cell(end or start)
    top, bottom = sorted((start_row, end_row))
    left, right = sorted((start_col, end_col))
    cell_count = (bottom - top + 1) * (right - left + 1)
    if cell_count > MAX_GROUP_CELLS:
        raise ValueError("Cada grupo Test Time pode monitorar no máximo 10.000 células.")
    first = f"{column_name(left)}{top + 1}"
    last = f"{column_name(right)}{bottom + 1}"
    return {
        "top_row": top,
        "bottom_row": bottom,
        "left_col": left,
        "right_col": right,
        "reference": first if first == last else f"{first}:{last}",
        "cell_count": cell_count,
    }


def stage_view(workbook: dict[str, Any]) -> dict[str, Any]:
    stage_number, stage_label, mode = STAGES.get(
        str(workbook.get("pipeline_stage") or ""),
        (0, "Arquivo", "sheet"),
    )
    return {
        "id": int(workbook["id"]),
        "name": workbook["name"],
        "project_id": int(workbook["project_id"]),
        "file_kind": workbook.get("file_kind"),
        "pipeline_stage": workbook.get("pipeline_stage"),
        "stage_number": stage_number,
        "stage_label": stage_label,
        "mode": mode,
        "revision": int(workbook.get("revision") or 1),
    }


def require_workbook(workbook_id: int, minimum_role: str = "viewer"):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, api_error(response, "Erro ao localizar o arquivo")
    if not workbook:
        return None, None, (jsonify({"error": "Arquivo não encontrado."}), 404)
    if str(workbook.get("pipeline_stage") or "") not in STAGES:
        return None, None, (jsonify({"error": "Este arquivo não pertence ao pipeline Test Time."}), 409)
    _, role, error = require_project(int(workbook["project_id"]), minimum_role)
    if error:
        return None, None, error
    return workbook, role, None


def parse_uuid(value: Any, field: str = "Sessão") -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as error:
        raise ValueError(f"{field} inválida.") from error


def session_for(session_id: str) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "test_time_sessions",
        {"select": "*", "id": f"eq.{session_id}"},
    )


def open_session(project_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "test_time_sessions",
        {
            "select": "*",
            "project_id": f"eq.{project_id}",
            "status": "in.(setup,running)",
            "order": "created_at.desc",
        },
    )


def latest_session(project_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "test_time_sessions",
        {
            "select": "*",
            "project_id": f"eq.{project_id}",
            "order": "created_at.desc",
        },
    )


def group_for(group_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "test_time_groups",
        {"select": "*", "id": f"eq.{group_id}"},
    )


def validate_json_size(value: Any, maximum: int, message: str) -> None:
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValueError(message) from error
    if len(encoded) > maximum:
        raise ValueError(message)


def load_session_state(session: dict[str, Any] | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], Any | None]:
    if not session:
        return [], [], None
    session_id = str(session["id"])
    groups_response = db(
        "GET",
        "test_time_groups",
        params={
            "select": "*",
            "session_id": f"eq.{session_id}",
            "order": "stage_number.asc,workbook_name.asc,id.asc",
        },
    )
    if not groups_response.ok:
        return [], [], groups_response
    events_response = db(
        "GET",
        "test_time_events",
        params={
            "select": "*",
            "session_id": f"eq.{session_id}",
            "order": "client_epoch_ms.asc,id.asc",
            "limit": str(MAX_TIMELINE_EVENTS),
        },
    )
    if not events_response.ok:
        return [], [], events_response
    return groups_response.json(), events_response.json(), None


@test_time_api.get("/api/test-time/workbooks/<int:workbook_id>")
def test_time_state(workbook_id: int):
    workbook, role, error = require_workbook(workbook_id)
    if error:
        return error
    session, response = latest_session(int(workbook["project_id"]))
    if not response.ok:
        return api_error(response, "Erro ao carregar a sessão Test Time")
    groups, events, state_error = load_session_state(session)
    if state_error is not None:
        return api_error(state_error, "Erro ao carregar os dados Test Time")
    return jsonify({
        "workbook": {**stage_view(workbook), "role": role},
        "session": session,
        "groups": groups,
        "events": events,
        "server_now": now_iso(),
    })


@test_time_api.post("/api/test-time/workbooks/<int:workbook_id>/sessions")
def create_session(workbook_id: int):
    workbook, role, error = require_workbook(workbook_id, "editor")
    if error:
        return error
    project_id = int(workbook["project_id"])
    existing, response = open_session(project_id)
    if not response.ok:
        return api_error(response, "Erro ao procurar uma sessão Test Time")
    if existing:
        return jsonify({"session": existing, "role": role, "existing": True})

    body = json_body()
    name = str(body.get("name") or "Teste de propagação").strip()[:120]
    if not name:
        name = "Teste de propagação"
    created = db(
        "POST",
        "test_time_sessions",
        payload={
            "project_id": project_id,
            "name": name,
            "status": "setup",
            "created_by_email": current_email(),
        },
        prefer="return=representation",
    )
    if created.status_code == 409:
        existing, retry = open_session(project_id)
        if retry.ok and existing:
            return jsonify({"session": existing, "role": role, "existing": True})
    if not created.ok or not created.json():
        return api_error(created, "Erro ao criar a sessão Test Time")
    return jsonify({"session": created.json()[0], "role": role, "existing": False})


@test_time_api.post("/api/test-time/sessions/<session_id>/start")
def start_session(session_id: str):
    try:
        session_id = parse_uuid(session_id)
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    session, response = session_for(session_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar a sessão Test Time")
    if not session:
        return jsonify({"error": "Sessão Test Time não encontrada."}), 404
    _, role, error = require_project(int(session["project_id"]), "editor")
    if error:
        return error
    body = json_body()
    try:
        client_epoch_ms = float(body.get("client_epoch_ms"))
    except (TypeError, ValueError):
        return jsonify({"error": "Horário inicial do Test Time inválido."}), 400
    result = db(
        "POST",
        "rpc/start_test_time_session",
        payload={
            "p_session_id": session_id,
            "p_client_epoch_ms": client_epoch_ms,
            "p_actor": current_email(),
        },
    )
    if not result.ok:
        return api_error(result, "Erro ao iniciar o Test Time")
    return jsonify({"result": result.json(), "role": role})


@test_time_api.post("/api/test-time/sessions/<session_id>/stop")
def stop_session(session_id: str):
    try:
        session_id = parse_uuid(session_id)
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    session, response = session_for(session_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar a sessão Test Time")
    if not session:
        return jsonify({"error": "Sessão Test Time não encontrada."}), 404
    _, role, error = require_project(int(session["project_id"]), "editor")
    if error:
        return error
    result = db(
        "POST",
        "rpc/stop_test_time_session",
        payload={"p_session_id": session_id, "p_actor": current_email()},
    )
    if not result.ok:
        return api_error(result, "Erro ao encerrar o Test Time")
    return jsonify({"result": result.json(), "role": role})


@test_time_api.post("/api/test-time/sessions/<session_id>/groups")
def create_group(session_id: str):
    try:
        session_id = parse_uuid(session_id)
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    session, response = session_for(session_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar a sessão Test Time")
    if not session:
        return jsonify({"error": "Sessão Test Time não encontrada."}), 404
    _, role, error = require_project(int(session["project_id"]), "editor")
    if error:
        return error
    if session.get("status") not in {"setup", "running"}:
        return jsonify({"error": "Crie uma nova sessão para adicionar grupos."}), 409

    body = json_body()
    try:
        workbook_id = int(body.get("workbook_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Arquivo monitorado inválido."}), 400
    workbook, _, workbook_error = require_workbook(workbook_id, "viewer")
    if workbook_error:
        return workbook_error
    if int(workbook["project_id"]) != int(session["project_id"]):
        return jsonify({"error": "O arquivo não pertence ao projeto do teste."}), 409
    try:
        bounds = normalize_range(body.get("start"), body.get("end"))
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400

    group_name = str(body.get("group_name") or f"Grupo {bounds['reference']}").strip()[:120]
    if not group_name:
        group_name = f"Grupo {bounds['reference']}"
    created = db(
        "POST",
        "test_time_groups",
        payload={
            "session_id": session_id,
            "project_id": int(session["project_id"]),
            "workbook_id": workbook_id,
            "workbook_name": workbook["name"],
            "file_kind": workbook.get("file_kind"),
            "pipeline_stage": workbook.get("pipeline_stage"),
            "stage_number": STAGES[str(workbook["pipeline_stage"])][0],
            "mode": STAGES[str(workbook["pipeline_stage"])][2],
            "group_name": group_name,
            "reference": bounds["reference"],
            "top_row": bounds["top_row"],
            "bottom_row": bounds["bottom_row"],
            "left_col": bounds["left_col"],
            "right_col": bounds["right_col"],
            "created_by_email": current_email(),
        },
        prefer="return=representation",
    )
    if created.status_code == 409:
        return jsonify({"error": "Este grupo e intervalo já existem no teste."}), 409
    if not created.ok or not created.json():
        return api_error(created, "Erro ao criar o grupo Test Time")
    return jsonify({"group": created.json()[0], "role": role})


@test_time_api.delete("/api/test-time/groups/<int:group_id>")
def delete_group(group_id: int):
    group, response = group_for(group_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar o grupo Test Time")
    if not group:
        return jsonify({"error": "Grupo Test Time não encontrado."}), 404
    _, _, error = require_project(int(group["project_id"]), "editor")
    if error:
        return error
    deleted = db(
        "DELETE",
        "test_time_groups",
        params={"id": f"eq.{group_id}"},
        prefer="return=minimal",
    )
    if not deleted.ok:
        return api_error(deleted, "Erro ao excluir o grupo Test Time")
    return "", 204


@test_time_api.post("/api/test-time/groups/<int:group_id>/observe")
def observe_group(group_id: int):
    group, response = group_for(group_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar o grupo Test Time")
    if not group:
        return jsonify({"error": "Grupo Test Time não encontrado."}), 404
    _, role, error = require_project(int(group["project_id"]), "viewer")
    if error:
        return error

    body = json_body()
    value_hash = str(body.get("value_hash") or "").strip().lower()
    if not HASH_RE.fullmatch(value_hash):
        return jsonify({"error": "Hash de observação inválido."}), 400
    preview = body.get("value_preview")
    changed_cells = body.get("changed_cells")
    if changed_cells is None:
        changed_cells = []
    if not isinstance(changed_cells, list) or len(changed_cells) > MAX_CHANGED_CELLS:
        return jsonify({"error": "Lista de células alteradas inválida."}), 400
    try:
        validate_json_size(preview, MAX_PREVIEW_BYTES, "A prévia do Test Time excede 32 KB.")
        validate_json_size(changed_cells, MAX_PREVIEW_BYTES, "A lista de alterações do Test Time excede 32 KB.")
        client_epoch_ms = float(body.get("client_epoch_ms"))
    except ValueError as validation_error:
        return jsonify({"error": str(validation_error)}), 400
    if client_epoch_ms <= 0:
        return jsonify({"error": "Horário da observação inválido."}), 400

    observed = db(
        "POST",
        "rpc/observe_test_time_group",
        payload={
            "p_group_id": group_id,
            "p_value_hash": value_hash,
            "p_value_preview": preview,
            "p_changed_cells": changed_cells,
            "p_client_epoch_ms": client_epoch_ms,
            "p_observer_email": current_email(),
        },
    )
    if not observed.ok:
        return api_error(observed, "Erro ao registrar a observação Test Time")
    return jsonify({"result": observed.json(), "role": role})


@test_time_api.get("/api/test-time/groups/<int:group_id>/base-snapshot")
def base_group_snapshot(group_id: int):
    group, response = group_for(group_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar o grupo Test Time")
    if not group:
        return jsonify({"error": "Grupo Test Time não encontrado."}), 404
    if group.get("mode") != "base":
        return jsonify({"error": "Este grupo não monitora uma Base relacional."}), 409
    workbook, role, error = require_workbook(int(group["workbook_id"]), "viewer")
    if error:
        return error

    columns, columns_response = list_columns(int(group["workbook_id"]))
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas da Base")
    top = int(group["top_row"])
    bottom = int(group["bottom_row"])
    left = int(group["left_col"])
    right = int(group["right_col"])
    selected_columns = columns[left : right + 1]
    row_limit = bottom - top + 1
    rows_response = db(
        "GET",
        "base_rows",
        params={
            "select": "id,row_order,values,revision,updated_at",
            "workbook_id": f"eq.{group['workbook_id']}",
            "order": "row_order.asc,id.asc",
            "offset": str(top),
            "limit": str(row_limit),
        },
    )
    if not rows_response.ok:
        return api_error(rows_response, "Erro ao carregar registros da Base")
    loaded_rows = rows_response.json()
    cells: list[dict[str, Any]] = []
    for row_offset in range(row_limit):
        row = loaded_rows[row_offset] if row_offset < len(loaded_rows) else None
        values = row.get("values") if isinstance(row, dict) and isinstance(row.get("values"), dict) else {}
        for column_offset in range(right - left + 1):
            column = selected_columns[column_offset] if column_offset < len(selected_columns) else None
            value = values.get(column["column_key"]) if column else None
            cells.append({
                "r": top + row_offset,
                "c": left + column_offset,
                "v": value,
            })
    return jsonify({
        "group_id": group_id,
        "workbook_id": int(workbook["id"]),
        "revision": int(workbook.get("revision") or 1),
        "reference": group["reference"],
        "role": role,
        "cells": cells,
    })
