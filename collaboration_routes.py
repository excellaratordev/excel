from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend import api_error, current_email, db, get_workbook, json_body, require_project

collaboration_api = Blueprint("collaboration_api", __name__)
MAX_PATCH_CHANGES = 10_000
MAX_SYNC_EVENTS = 500


def rpc_payload(response):
    try:
        output = response.json()
    except ValueError:
        return None
    if isinstance(output, list) and len(output) == 1 and isinstance(output[0], dict):
        return output[0]
    return output


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
    changes = body.get("changes", [])
    if not isinstance(changes, list):
        return jsonify({"error": "Alterações inválidas."}), 400
    if len(changes) > MAX_PATCH_CHANGES:
        return jsonify({"error": f"Envie no máximo {MAX_PATCH_CHANGES} células por vez."}), 400

    normalized = []
    for change in changes:
        if not isinstance(change, dict):
            return jsonify({"error": "Alteração de célula inválida."}), 400
        try:
            row = int(change.get("row"))
            col = int(change.get("col"))
        except (TypeError, ValueError):
            return jsonify({"error": "Coordenadas de célula inválidas."}), 400
        if row < 0 or row >= 5000 or col < 0 or col >= 300:
            return jsonify({"error": "Célula fora do limite permitido."}), 400
        normalized.append({"row": row, "col": col, "value": change.get("value")})

    name = body.get("name")
    if name is not None:
        name = str(name).strip()
        if not name or len(name) > 120:
            return jsonify({"error": "Nome da planilha inválido."}), 400

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
            "select": "revision,user_email,changes,workbook_name,created_at",
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