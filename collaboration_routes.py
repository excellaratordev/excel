from __future__ import annotations

from uuid import UUID

from flask import Blueprint, jsonify, request

from backend import api_error, current_email, db, get_workbook, json_body, require_project

collaboration_api = Blueprint("collaboration_api", __name__)
MAX_PATCH_CHANGES = 10_000
MAX_SYNC_EVENTS = 500
MAX_OPERATIONS = 100


def rpc_payload(response):
    try:
        output = response.json()
    except ValueError:
        return None
    if isinstance(output, list) and len(output) == 1 and isinstance(output[0], dict):
        return output[0]
    return output


def response_error_text(response, fallback: str) -> str:
    try:
        detail = response.json()
    except ValueError:
        return fallback
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("hint") or detail.get("error") or fallback)
    return fallback


def normalize_changes(value):
    if not isinstance(value, list):
        return None, "Alterações inválidas."
    if len(value) > MAX_PATCH_CHANGES:
        return None, f"Envie no máximo {MAX_PATCH_CHANGES} células por operação."

    normalized = []
    for change in value:
        if not isinstance(change, dict):
            return None, "Alteração de célula inválida."
        try:
            row = int(change.get("row"))
            col = int(change.get("col"))
        except (TypeError, ValueError):
            return None, "Coordenadas de célula inválidas."
        if row < 0 or row >= 5000 or col < 0 or col >= 300:
            return None, "Célula fora do limite permitido."
        normalized.append({"row": row, "col": col, "value": change.get("value")})
    return normalized, None


def normalize_name(value):
    if value is None:
        return None, None
    name = str(value).strip()
    if not name or len(name) > 120:
        return None, "Nome da planilha inválido."
    return name, None


def normalize_optional_integer(value, label: str):
    if value is None or value == "":
        return None, None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, f"{label} inválido."
    if parsed < 0:
        return None, f"{label} inválido."
    return parsed, None


def normalize_operation(value, workbook_id: int):
    if not isinstance(value, dict):
        return None, "Operação inválida."

    try:
        op_id = str(UUID(str(value.get("op_id", ""))))
    except (TypeError, ValueError, AttributeError):
        return None, "Identificador da operação inválido."

    operation_workbook_id = value.get("workbook_id")
    if operation_workbook_id not in (None, ""):
        try:
            if int(operation_workbook_id) != workbook_id:
                return None, "A operação pertence a outra planilha."
        except (TypeError, ValueError):
            return None, "Planilha da operação inválida."

    changes, error = normalize_changes(value.get("changes", []))
    if error:
        return None, error

    name, error = normalize_name(value.get("name"))
    if error:
        return None, error

    client_id = str(value.get("client_id") or "").strip()
    if not client_id or len(client_id) > 160:
        return None, "Identificador do cliente inválido."

    client_seq, error = normalize_optional_integer(value.get("client_seq"), "Sequência do cliente")
    if error:
        return None, error
    known_revision, error = normalize_optional_integer(value.get("known_revision"), "Revisão conhecida")
    if error:
        return None, error

    kind = str(value.get("kind") or "cells.patch").strip()
    if not kind or len(kind) > 80:
        return None, "Tipo de operação inválido."

    return {
        "op_id": op_id,
        "workbook_id": workbook_id,
        "client_id": client_id,
        "client_seq": client_seq,
        "known_revision": known_revision,
        "kind": kind,
        "changes": changes,
        "name": name,
    }, None


@collaboration_api.get("/api/workbooks/<int:workbook_id>/collaboration-config")
def collaboration_config(workbook_id: int):
    response = db(
        "GET",
        "workbooks",
        params={
            "select": "id,project_id,realtime_key,revision",
            "id": f"eq.{workbook_id}",
            "limit": "1",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    rows = response.json()
    if not rows:
        return jsonify({"error": "Planilha não encontrada."}), 404

    workbook = rows[0]
    project_id = int(workbook.get("project_id") or 0)
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error

    return jsonify({
        "workbook_id": workbook_id,
        "project_id": project_id,
        "role": role,
        "revision": int(workbook.get("revision") or 0),
        "realtime_topic": f"workbook:{workbook['realtime_key']}",
    })


@collaboration_api.post("/api/workbooks/<int:workbook_id>/operations")
def apply_operations(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404

    project_id = int(workbook.get("project_id") or 0)
    _, _, error = require_project(project_id, "editor")
    if error:
        return error

    raw_operations = json_body().get("operations", [])
    if not isinstance(raw_operations, list):
        return jsonify({"error": "Lista de operações inválida."}), 400
    if len(raw_operations) > MAX_OPERATIONS:
        return jsonify({"error": f"Envie no máximo {MAX_OPERATIONS} operações por vez."}), 400

    operations = []
    for raw_operation in raw_operations:
        operation, error_text = normalize_operation(raw_operation, workbook_id)
        if error_text:
            return jsonify({"error": error_text}), 400
        operations.append(operation)

    if not operations:
        return jsonify({
            "workbook_id": workbook_id,
            "project_id": project_id,
            "current_revision": int(workbook.get("revision") or 0),
            "results": [],
        })

    results = []
    current_revision = int(workbook.get("revision") or 0)
    for operation in operations:
        response = db(
            "POST",
            "rpc/apply_workbook_operation",
            payload={
                "p_workbook_id": workbook_id,
                "p_user_email": current_email(),
                "p_op_id": operation["op_id"],
                "p_changes": operation["changes"],
                "p_name": operation["name"],
                "p_client_id": operation["client_id"],
                "p_client_seq": operation["client_seq"],
                "p_known_revision": operation["known_revision"],
                "p_operation_kind": operation["kind"],
            },
        )
        if not response.ok:
            return jsonify({
                "error": response_error_text(response, "Erro ao aplicar operação."),
                "processed": results,
            }), response.status_code
        output = rpc_payload(response)
        if not isinstance(output, dict):
            return jsonify({"error": "O banco não confirmou a operação.", "processed": results}), 500
        results.append(output)
        current_revision = max(current_revision, int(output.get("revision") or 0))

    return jsonify({
        "workbook_id": workbook_id,
        "project_id": project_id,
        "current_revision": current_revision,
        "results": results,
    })


@collaboration_api.post("/api/workbooks/<int:workbook_id>/patch")
def patch_workbook(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404

    project_id = int(workbook.get("project_id") or 0)
    _, _, error = require_project(project_id, "editor")
    if error:
        return error

    body = json_body()
    normalized, error_text = normalize_changes(body.get("changes", []))
    if error_text:
        return jsonify({"error": error_text}), 400
    name, error_text = normalize_name(body.get("name"))
    if error_text:
        return jsonify({"error": error_text}), 400

    if not normalized and name is None:
        return jsonify({
            "workbook_id": workbook_id,
            "project_id": project_id,
            "revision": int(workbook.get("revision") or 0),
            "name": workbook.get("name"),
            "changes": [],
        })

    response = db(
        "POST",
        "rpc/apply_workbook_patch",
        payload={
            "p_workbook_id": workbook_id,
            "p_user_email": current_email(),
            "p_changes": normalized,
            "p_name": name,
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao aplicar alterações")
    output = rpc_payload(response)
    if not isinstance(output, dict):
        return jsonify({"error": "O banco não confirmou as alterações."}), 500
    return jsonify(output)


@collaboration_api.get("/api/workbooks/<int:workbook_id>/changes")
def workbook_changes(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404

    project_id = int(workbook.get("project_id") or 0)
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error

    try:
        after_revision = max(0, int(request.args.get("after_revision", "0")))
    except ValueError:
        return jsonify({"error": "Revisão inválida."}), 400

    current_revision = int(workbook.get("revision") or 0)
    if current_revision <= after_revision:
        return "", 204

    response = db(
        "GET",
        "workbook_changes",
        params={
            "select": "revision,user_email,changes,workbook_name,created_at,op_id,client_id,client_seq,known_revision,operation_kind",
            "workbook_id": f"eq.{workbook_id}",
            "revision": f"gt.{after_revision}",
            "order": "revision.asc",
            "limit": str(MAX_SYNC_EVENTS + 1),
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao buscar alterações")

    rows = response.json()
    complete_delta = (
        0 < len(rows) <= MAX_SYNC_EVENTS
        and int(rows[0].get("revision") or -1) == after_revision + 1
        and int(rows[-1].get("revision") or -1) == current_revision
    )
    if complete_delta:
        return jsonify({
            "mode": "patches",
            "workbook_id": workbook_id,
            "project_id": project_id,
            "revision": current_revision,
            "role": role,
            "events": [
                {
                    "revision": int(row.get("revision") or 0),
                    "op_id": str(row.get("op_id")) if row.get("op_id") else None,
                    "client_id": row.get("client_id"),
                    "client_seq": row.get("client_seq"),
                    "known_revision": row.get("known_revision"),
                    "kind": row.get("operation_kind") or "legacy.patch",
                    "user_email": row.get("user_email"),
                    "changes": row.get("changes") if isinstance(row.get("changes"), list) else [],
                    "name": row.get("workbook_name"),
                    "created_at": row.get("created_at"),
                }
                for row in rows
            ],
        })

    snapshot, response = get_workbook(workbook_id, include_payload=True)
    if not response.ok:
        return api_error(response, "Erro ao recuperar planilha")
    if not snapshot:
        return jsonify({"error": "Planilha não encontrada."}), 404
    return jsonify({
        "mode": "snapshot",
        "workbook_id": workbook_id,
        "project_id": project_id,
        "revision": int(snapshot.get("revision") or current_revision),
        "role": role,
        "name": snapshot.get("name"),
        "updated_at": snapshot.get("updated_at"),
        "updated_by_email": snapshot.get("updated_by_email"),
        "data": snapshot.get("payload") or {},
    })
