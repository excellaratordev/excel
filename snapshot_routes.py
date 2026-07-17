from __future__ import annotations

import json

from flask import Blueprint, jsonify

from backend import api_error, db, get_workbook, json_body, require_project

snapshot_api = Blueprint("snapshot_api", __name__)
MAX_SNAPSHOT_BYTES = 1_500_000


@snapshot_api.get("/api/workbooks/<int:workbook_id>/render-snapshot")
def get_render_snapshot(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404

    _, role, error = require_project(int(workbook.get("project_id") or 0), "viewer")
    if error:
        return error

    response = db(
        "GET",
        "workbook_render_snapshots",
        params={
            "select": "workbook_id,revision,payload,updated_at",
            "workbook_id": f"eq.{workbook_id}",
            "limit": "1",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao carregar snapshot visual")
    rows = response.json()
    if not rows:
        return "", 204

    snapshot = rows[0]
    snapshot["role"] = role
    snapshot["current_revision"] = int(workbook.get("revision") or 0)
    return jsonify(snapshot)


@snapshot_api.post("/api/workbooks/<int:workbook_id>/render-snapshot")
def save_render_snapshot(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404

    _, _, error = require_project(int(workbook.get("project_id") or 0), "editor")
    if error:
        return error

    body = json_body()
    payload = body.get("payload")
    try:
        revision = int(body.get("revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão do snapshot inválida."}), 400

    current_revision = int(workbook.get("revision") or 0)
    if revision != current_revision:
        return jsonify({
            "error": "Snapshot pertence a uma revisão desatualizada.",
            "current_revision": current_revision,
        }), 409
    if not isinstance(payload, dict):
        return jsonify({"error": "Snapshot visual inválido."}), 400
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        return jsonify({"error": "Snapshot visual excede o limite permitido."}), 400

    response = db(
        "POST",
        "workbook_render_snapshots",
        params={"on_conflict": "workbook_id"},
        payload={
            "workbook_id": workbook_id,
            "revision": revision,
            "payload": payload,
            "updated_at": "now()",
        },
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not response.ok:
        return api_error(response, "Erro ao salvar snapshot visual")
    rows = response.json()
    return jsonify(rows[0] if rows else {"workbook_id": workbook_id, "revision": revision})
