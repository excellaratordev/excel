from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend import api_error, db, get_workbook, require_project

recovery_api = Blueprint("recovery_api", __name__)
MAX_RECOVERY_EVENTS = 1000


@recovery_api.get("/api/workbooks/<int:workbook_id>/recovery")
def recovery(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    project_id = int(workbook.get("project_id") or 0)
    project, role, error = require_project(project_id, "workbook.view")
    if error:
        return error
    try:
        after_revision = max(0, int(request.args.get("after_revision", "0")))
    except ValueError:
        return jsonify({"error": "Revisão inválida."}), 400

    checkpoint_response = db(
        "GET",
        "workbook_checkpoints",
        params={
            "select": "revision,payload,created_at",
            "workbook_id": f"eq.{workbook_id}",
            "revision": f"gte.{after_revision}",
            "order": "revision.desc",
            "limit": "1",
        },
    )
    if not checkpoint_response.ok:
        return api_error(checkpoint_response, "Erro ao buscar checkpoint")
    checkpoint = checkpoint_response.json()[0] if checkpoint_response.json() else None
    base_revision = int(checkpoint.get("revision") or after_revision) if checkpoint else after_revision

    changes_response = db(
        "GET",
        "workbook_changes",
        params={
            "select": "revision,user_email,changes,workbook_name,created_at,op_id,client_id,client_seq,known_revision,operation_kind",
            "workbook_id": f"eq.{workbook_id}",
            "revision": f"gt.{base_revision}",
            "order": "revision.asc",
            "limit": str(MAX_RECOVERY_EVENTS + 1),
        },
    )
    if not changes_response.ok:
        return api_error(changes_response, "Erro ao buscar deltas")
    rows = changes_response.json()
    if len(rows) > MAX_RECOVERY_EVENTS:
        return jsonify({"error": "Janela de recuperação excedida.", "requires_snapshot": True}), 409
    return jsonify({
        "mode": "checkpoint" if checkpoint else "delta",
        "workbook_id": workbook_id,
        "project_id": project_id,
        "role": role,
        "capabilities": project.get("capabilities", []),
        "checkpoint": checkpoint,
        "events": rows,
        "revision": int(workbook.get("revision") or base_revision),
    })


@recovery_api.get("/api/workbooks/<int:workbook_id>/chunks")
def chunks(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    project, role, error = require_project(int(workbook.get("project_id") or 0), "workbook.view")
    if error:
        return error
    requested = [part.strip() for part in request.args.get("keys", "").split(",") if part.strip()]
    if not requested or len(requested) > 200:
        return jsonify({"error": "Informe de 1 a 200 chunks."}), 400
    safe: set[tuple[int, int]] = set()
    for item in requested:
        try:
            row_chunk, col_chunk = [int(part) for part in item.split(":", 1)]
        except (TypeError, ValueError):
            return jsonify({"error": f"Chunk inválido: {item}"}), 400
        if row_chunk < 0 or col_chunk < 0:
            return jsonify({"error": f"Chunk inválido: {item}"}), 400
        safe.add((row_chunk, col_chunk))
    response = db(
        "GET",
        "workbook_chunks",
        params={
            "select": "row_chunk,col_chunk,revision,cells,updated_at",
            "workbook_id": f"eq.{workbook_id}",
            "limit": "10000",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao buscar chunks")
    selected = [
        item for item in response.json()
        if (int(item.get("row_chunk") or 0), int(item.get("col_chunk") or 0)) in safe
    ]
    return jsonify({"workbook_id": workbook_id, "role": role, "capabilities": project.get("capabilities", []), "chunks": selected})
