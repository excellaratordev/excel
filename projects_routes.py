from __future__ import annotations

from flask import Blueprint, g, jsonify

from backend import (
    ROLE_RANK,
    api_error,
    current_email,
    db,
    ensure_owner_membership,
    fetch_one,
    insert_one,
    json_body,
    list_user_projects,
    normalize_email,
    require_project,
)

projects_api = Blueprint("projects_api", __name__)


@projects_api.get("/api/me")
def current_user():
    user = g.auth_user
    metadata = user.get("user_metadata") or {}
    return jsonify({
        "id": user.get("id"),
        "email": user.get("email"),
        "name": metadata.get("full_name") or metadata.get("name") or user.get("email"),
        "avatar_url": metadata.get("avatar_url") or metadata.get("picture"),
        "provider": "google",
    })


@projects_api.get("/api/projects")
def projects_list():
    try:
        return jsonify(list_user_projects())
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 500


@projects_api.post("/api/projects")
def projects_create():
    name = str(json_body().get("name", "")).strip()
    if not name:
        return jsonify({"error": "Informe o nome do projeto."}), 400
    project, response = insert_one("projects", {"name": name, "owner_email": current_email()})
    if response.status_code == 409:
        return jsonify({"error": "Você já possui um projeto com esse nome."}), 409
    if not response.ok or not project:
        return api_error(response, "Erro ao criar projeto")
    ensure_owner_membership(project)
    project["role"] = "owner"
    return jsonify(project)


@projects_api.patch("/api/projects/<int:project_id>")
def projects_update(project_id: int):
    _, _, error = require_project(project_id, "admin")
    if error:
        return error
    name = str(json_body().get("name", "")).strip()
    if not name:
        return jsonify({"error": "Informe o nome do projeto."}), 400
    response = db("PATCH", "projects", params={"id": f"eq.{project_id}"}, payload={"name": name}, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe um projeto com esse nome."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao renomear projeto")


@projects_api.delete("/api/projects/<int:project_id>")
def projects_delete(project_id: int):
    _, _, error = require_project(project_id, "owner")
    if error:
        return error
    response = db("DELETE", "projects", params={"id": f"eq.{project_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir projeto")


@projects_api.get("/api/projects/<int:project_id>/members")
def members_list(project_id: int):
    project, role, error = require_project(project_id, "viewer")
    if error:
        return error
    response = db("GET", "project_members", params={"select": "id,email,role,invited_by_email,created_at,updated_at", "project_id": f"eq.{project_id}", "order": "role.desc,email.asc"})
    if not response.ok:
        return api_error(response, "Erro ao listar membros")
    return jsonify({"project": project, "current_role": role, "members": response.json()})


@projects_api.post("/api/projects/<int:project_id>/members")
def members_add(project_id: int):
    project, _, error = require_project(project_id, "admin")
    if error:
        return error
    body = json_body()
    email = normalize_email(body.get("email"))
    role = str(body.get("role", "editor")).lower()
    if not email or "@" not in email:
        return jsonify({"error": "Informe um e-mail válido."}), 400
    if role not in {"viewer", "editor", "admin"}:
        return jsonify({"error": "Nível de acesso inválido."}), 400
    if email == normalize_email(project.get("owner_email")):
        return jsonify({"error": "O proprietário já faz parte do projeto."}), 409
    existing, response = fetch_one("project_members", {"select": "id", "project_id": f"eq.{project_id}", "email": f"eq.{email}"})
    if not response.ok:
        return api_error(response, "Erro ao verificar membro")
    if existing:
        response = db("PATCH", "project_members", params={"id": f"eq.{existing['id']}"}, payload={"role": role, "invited_by_email": current_email()}, prefer="return=representation")
    else:
        response = db("POST", "project_members", payload={"project_id": project_id, "email": email, "role": role, "invited_by_email": current_email()}, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao adicionar membro")


@projects_api.patch("/api/projects/<int:project_id>/members/<int:member_id>")
def members_update(project_id: int, member_id: int):
    _, _, error = require_project(project_id, "admin")
    if error:
        return error
    role = str(json_body().get("role", "")).lower()
    if role not in {"viewer", "editor", "admin"}:
        return jsonify({"error": "Nível de acesso inválido."}), 400
    member, response = fetch_one("project_members", {"select": "id,email,role", "id": f"eq.{member_id}", "project_id": f"eq.{project_id}"})
    if not response.ok:
        return api_error(response, "Erro ao localizar membro")
    if not member:
        return jsonify({"error": "Membro não encontrado."}), 404
    if member.get("role") == "owner":
        return jsonify({"error": "O proprietário não pode ter seu nível alterado."}), 400
    response = db("PATCH", "project_members", params={"id": f"eq.{member_id}"}, payload={"role": role}, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao atualizar membro")


@projects_api.delete("/api/projects/<int:project_id>/members/<int:member_id>")
def members_delete(project_id: int, member_id: int):
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error
    member, response = fetch_one("project_members", {"select": "id,email,role", "id": f"eq.{member_id}", "project_id": f"eq.{project_id}"})
    if not response.ok:
        return api_error(response, "Erro ao localizar membro")
    if not member:
        return jsonify({"error": "Membro não encontrado."}), 404
    is_self = normalize_email(member.get("email")) == current_email()
    if member.get("role") == "owner":
        return jsonify({"error": "O proprietário não pode ser removido do projeto."}), 400
    if not is_self and ROLE_RANK.get(role or "", -1) < ROLE_RANK["admin"]:
        return jsonify({"error": "Você não possui permissão para remover este membro."}), 403
    response = db("DELETE", "project_members", params={"id": f"eq.{member_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao remover membro")
