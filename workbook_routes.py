from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

from backend import (
    api_error,
    current_email,
    db,
    empty_workbook,
    get_folder,
    get_workbook,
    json_body,
    list_user_projects,
    parse_nullable_id,
    parse_required_id,
    project_ids_for_user,
    require_project,
)
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    FILE_KIND_SPREADSHEET,
    STAGE_CALCULATION,
    normalize_file_identity,
)

MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
workbooks_api = Blueprint("workbooks_api", __name__)


@workbooks_api.get("/api/workbooks")
def list_workbooks():
    project_id, error_text = parse_nullable_id(request.args.get("project_id"), "Projeto")
    if error_text:
        return jsonify({"error": error_text}), 400
    if project_id is not None:
        _, _, error = require_project(project_id, "viewer")
        if error:
            return error
        ids = [project_id]
    else:
        ids = project_ids_for_user(current_email())
        if not ids:
            ids = [int(item["id"]) for item in list_user_projects()]
    response = db("GET", "workbooks", params={
        "select": "id,name,folder_id,project_id,revision,file_kind,pipeline_stage,created_at,updated_at,updated_by_email",
        "project_id": f"in.({','.join(map(str, ids))})",
        "order": "updated_at.desc",
    })
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar arquivos")


@workbooks_api.get("/api/workbooks/<int:workbook_id>")
def get_workbook_route(workbook_id: int):
    workbook, response = get_workbook(workbook_id, include_payload=True)
    if not response.ok:
        return api_error(response, "Erro ao abrir planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    _, role, error = require_project(int(workbook.get("project_id") or 0), "viewer")
    if error:
        return error
    if workbook.get("file_kind") == FILE_KIND_BASE:
        return jsonify({
            "error": "Este arquivo usa armazenamento relacional e deve ser aberto como Base.",
            "redirect": f"/base/{workbook_id}",
            "file_kind": FILE_KIND_BASE,
        }), 409
    workbook["data"] = workbook.pop("payload")
    workbook["role"] = role
    return jsonify(workbook)


@workbooks_api.get("/api/workbooks/<int:workbook_id>/sync")
def sync_workbook(workbook_id: int):
    workbook, response = get_workbook(workbook_id, include_payload=True)
    if not response.ok:
        return api_error(response, "Erro ao sincronizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    _, role, error = require_project(int(workbook.get("project_id") or 0), "viewer")
    if error:
        return error
    if workbook.get("file_kind") == FILE_KIND_BASE:
        return jsonify({"error": "Bases são sincronizadas por registros relacionais.", "redirect": f"/base/{workbook_id}"}), 409
    try:
        after_revision = int(request.args.get("after_revision", "0"))
    except ValueError:
        after_revision = 0
    if int(workbook.get("revision") or 1) <= after_revision:
        return "", 204
    workbook["data"] = workbook.pop("payload")
    workbook["role"] = role
    return jsonify(workbook)


@workbooks_api.post("/api/workbooks")
def save_workbook():
    body = json_body()
    name = str(body.get("name", "")).strip()
    payload = body.get("data")
    if not name:
        return jsonify({"error": "Informe o nome da planilha."}), 400
    if not isinstance(payload, dict):
        payload = empty_workbook(name)
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_WORKBOOK_BYTES:
        return jsonify({"error": "A planilha excede 5 MB."}), 400
    workbook_id, error_text = parse_nullable_id(body.get("id"), "Planilha")
    if error_text:
        return jsonify({"error": error_text}), 400
    email = current_email()

    if workbook_id is None:
        try:
            file_kind, pipeline_stage = normalize_file_identity(
                body.get("file_kind"),
                body.get("pipeline_stage"),
                default_kind=FILE_KIND_SPREADSHEET,
                default_stage=STAGE_CALCULATION,
            )
        except ValueError as validation_error:
            return jsonify({"error": str(validation_error)}), 400
        if file_kind == FILE_KIND_BASE:
            return jsonify({"error": "Crie arquivos Base pelo endpoint relacional /api/bases."}), 400
        project_id, error_text = parse_required_id(body.get("project_id"), "Projeto")
        if error_text:
            return jsonify({"error": error_text}), 400
        _, _, error = require_project(project_id, "editor")
        if error:
            return error
        folder_id, error_text = parse_nullable_id(body.get("folder_id"), "Pasta")
        if error_text:
            return jsonify({"error": error_text}), 400
        if folder_id is not None:
            folder, response = get_folder(folder_id)
            if not response.ok:
                return api_error(response, "Erro ao validar a pasta")
            if not folder or int(folder.get("project_id") or 0) != project_id:
                return jsonify({"error": "Pasta não pertence ao projeto."}), 400
        response = db("POST", "workbooks", payload={
            "name": name,
            "payload": payload,
            "folder_id": folder_id,
            "project_id": project_id,
            "revision": 1,
            "file_kind": file_kind,
            "pipeline_stage": pipeline_stage,
            "created_by_email": email,
            "updated_by_email": email,
        }, prefer="return=representation")
        if response.status_code == 409:
            return jsonify({"error": "Já existe um arquivo com esse nome nesta pasta."}), 409
        if not response.ok or not response.json():
            return api_error(response, "Erro ao salvar planilha")
        saved = response.json()[0]
        return jsonify({
            "id": saved["id"],
            "name": saved["name"],
            "revision": saved.get("revision", 1),
            "file_kind": saved.get("file_kind"),
            "pipeline_stage": saved.get("pipeline_stage"),
            "updated_at": saved["updated_at"],
            "updated_by_email": email,
        })

    current, response = get_workbook(workbook_id, include_payload=True)
    if not response.ok:
        return api_error(response, "Erro ao abrir planilha")
    if not current:
        return jsonify({"error": "Planilha não encontrada."}), 404
    if current.get("file_kind") == FILE_KIND_BASE:
        return jsonify({"error": "Uma Base não pode ser salva como matriz de planilha. Use a API relacional."}), 409
    project_id = int(current.get("project_id") or 0)
    _, role, error = require_project(project_id, "editor")
    if error:
        return error
    current_revision = int(current.get("revision") or 1)
    base_revision = body.get("base_revision")
    if base_revision is not None:
        try:
            base_revision = int(base_revision)
        except (TypeError, ValueError):
            return jsonify({"error": "Revisão inválida."}), 400
        if base_revision != current_revision:
            current["data"] = current.pop("payload")
            current["role"] = role
            return jsonify({"error": "A planilha foi alterada por outra pessoa.", "conflict": True, "current": current}), 409
    response = db("PATCH", "workbooks", params={"id": f"eq.{workbook_id}", "revision": f"eq.{current_revision}"}, payload={
        "name": name,
        "payload": payload,
        "revision": current_revision + 1,
        "updated_by_email": email,
    }, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe um arquivo com esse nome nesta pasta."}), 409
    if not response.ok:
        return api_error(response, "Erro ao salvar planilha")
    if not response.json():
        latest, latest_response = get_workbook(workbook_id, include_payload=True)
        if latest_response.ok and latest:
            latest["data"] = latest.pop("payload")
            latest["role"] = role
            return jsonify({"error": "A planilha foi alterada por outra pessoa.", "conflict": True, "current": latest}), 409
        return jsonify({"error": "Não foi possível confirmar a gravação."}), 409
    saved = response.json()[0]
    return jsonify({
        "id": saved["id"],
        "name": saved["name"],
        "revision": saved["revision"],
        "file_kind": current.get("file_kind"),
        "pipeline_stage": current.get("pipeline_stage"),
        "updated_at": saved["updated_at"],
        "updated_by_email": email,
    })


@workbooks_api.patch("/api/workbooks/<int:workbook_id>/move")
def move_workbook(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar arquivo")
    if not workbook:
        return jsonify({"error": "Arquivo não encontrado."}), 404
    project_id = int(workbook.get("project_id") or 0)
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    folder_id, error_text = parse_nullable_id(json_body().get("folder_id"), "Pasta de destino")
    if error_text:
        return jsonify({"error": error_text}), 400
    if folder_id is not None:
        folder, response = get_folder(folder_id)
        if not response.ok:
            return api_error(response, "Erro ao validar a pasta de destino")
        if not folder or int(folder.get("project_id") or 0) != project_id:
            return jsonify({"error": "Pasta de destino não pertence ao projeto."}), 404
    response = db("PATCH", "workbooks", params={"id": f"eq.{workbook_id}"}, payload={"folder_id": folder_id, "updated_by_email": current_email()}, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe um arquivo com esse nome no destino."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao mover arquivo")


@workbooks_api.delete("/api/workbooks/<int:workbook_id>")
def delete_workbook(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar arquivo")
    if not workbook:
        return jsonify({"error": "Arquivo não encontrado."}), 404
    _, _, error = require_project(int(workbook.get("project_id") or 0), "editor")
    if error:
        return error
    response = db("DELETE", "workbooks", params={"id": f"eq.{workbook_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir arquivo")


def active_presence(workbook_id: int, project_id: int):
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
    db("DELETE", "workbook_presence", params={"workbook_id": f"eq.{workbook_id}", "last_seen": f"lt.{cutoff}"}, prefer="return=minimal")
    response = db("GET", "workbook_presence", params={"select": "user_email,user_name,avatar_url,last_seen", "workbook_id": f"eq.{workbook_id}", "project_id": f"eq.{project_id}", "order": "last_seen.desc"})
    return response.json() if response.ok else []


@workbooks_api.post("/api/workbooks/<int:workbook_id>/presence")
def presence(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar arquivo")
    if not workbook:
        return jsonify({"error": "Arquivo não encontrado."}), 404
    project_id = int(workbook.get("project_id") or 0)
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error
    metadata = g.auth_user.get("user_metadata") or {}
    email = current_email()
    response = db("POST", "workbook_presence", params={"on_conflict": "workbook_id,user_email"}, payload={
        "workbook_id": workbook_id,
        "project_id": project_id,
        "user_email": email,
        "user_name": metadata.get("full_name") or metadata.get("name") or email,
        "avatar_url": metadata.get("avatar_url") or metadata.get("picture"),
        "last_seen": datetime.now(timezone.utc).isoformat(),
    }, prefer="resolution=merge-duplicates,return=minimal")
    if not response.ok:
        return api_error(response, "Erro ao atualizar presença")
    return jsonify({"online": active_presence(workbook_id, project_id), "role": role})


@workbooks_api.delete("/api/workbooks/<int:workbook_id>/presence")
def presence_leave(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar arquivo")
    if not workbook:
        return jsonify({"deleted": False})
    _, _, error = require_project(int(workbook.get("project_id") or 0), "viewer")
    if error:
        return error
    response = db("DELETE", "workbook_presence", params={"workbook_id": f"eq.{workbook_id}", "user_email": f"eq.{current_email()}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao remover presença")
