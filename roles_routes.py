from __future__ import annotations

import re

from flask import Blueprint, jsonify

from backend import (
    get_workbook,
    api_error,
    db,
    fetch_one,
    get_project_custom_roles,
    json_body,
    require_project,
)
from superexcel.core.permissions import (
    ALL_CAPABILITIES,
    DEFAULT_ROLE_CAPABILITIES,
    normalize_capabilities,
)

roles_api = Blueprint("roles_api", __name__)
ROLE_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")
PRESET_ROLES = {"viewer", "editor", "admin", "owner"}


def normalize_role_name(value: object) -> str:
    return str(value or "").strip().lower().replace(" ", "-")


def serialize_presets() -> list[dict]:
    return [
        {
            "id": None,
            "name": name,
            "capabilities": sorted(capabilities),
            "preset": True,
            "is_active": True,
        }
        for name, capabilities in DEFAULT_ROLE_CAPABILITIES.items()
    ]


@roles_api.get("/api/projects/<int:project_id>/roles")
def roles_list(project_id: int):
    project, role, error = require_project(project_id, "roles.view")
    if error:
        return error
    response = db(
        "GET",
        "project_roles",
        params={
            "select": "id,project_id,name,capabilities,is_active,created_at,updated_at",
            "project_id": f"eq.{project_id}",
            "order": "name.asc",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao listar roles")
    custom = [{**item, "preset": False} for item in response.json()]
    return jsonify({
        "project": project,
        "current_role": role,
        "all_capabilities": sorted(ALL_CAPABILITIES),
        "roles": serialize_presets() + custom,
    })


@roles_api.post("/api/projects/<int:project_id>/roles")
def roles_create(project_id: int):
    _, _, error = require_project(project_id, "roles.manage")
    if error:
        return error
    body = json_body()
    name = normalize_role_name(body.get("name"))
    if not ROLE_NAME_PATTERN.fullmatch(name) or name in PRESET_ROLES:
        return jsonify({"error": "Nome de role inválido ou reservado."}), 400
    try:
        capabilities = sorted(normalize_capabilities(body.get("capabilities") or []))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    response = db(
        "POST",
        "project_roles",
        payload={"project_id": project_id, "name": name, "capabilities": capabilities, "is_active": True},
        prefer="return=representation",
    )
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma role com esse nome."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao criar role")


@roles_api.patch("/api/projects/<int:project_id>/roles/<int:role_id>")
def roles_update(project_id: int, role_id: int):
    _, _, error = require_project(project_id, "roles.manage")
    if error:
        return error
    current, response = fetch_one(
        "project_roles",
        {"select": "id,name", "id": f"eq.{role_id}", "project_id": f"eq.{project_id}"},
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar role")
    if not current:
        return jsonify({"error": "Role não encontrada."}), 404
    body = json_body()
    payload = {}
    if "name" in body:
        name = normalize_role_name(body.get("name"))
        if not ROLE_NAME_PATTERN.fullmatch(name) or name in PRESET_ROLES:
            return jsonify({"error": "Nome de role inválido ou reservado."}), 400
        payload["name"] = name
    if "capabilities" in body:
        try:
            payload["capabilities"] = sorted(normalize_capabilities(body.get("capabilities") or []))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    if "is_active" in body:
        payload["is_active"] = bool(body.get("is_active"))
    if not payload:
        return jsonify({"error": "Nenhuma alteração informada."}), 400
    response = db(
        "PATCH",
        "project_roles",
        params={"id": f"eq.{role_id}", "project_id": f"eq.{project_id}"},
        payload=payload,
        prefer="return=representation",
    )
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma role com esse nome."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao atualizar role")


@roles_api.delete("/api/projects/<int:project_id>/roles/<int:role_id>")
def roles_delete(project_id: int, role_id: int):
    _, _, error = require_project(project_id, "roles.manage")
    if error:
        return error
    role, response = fetch_one(
        "project_roles",
        {"select": "id,name", "id": f"eq.{role_id}", "project_id": f"eq.{project_id}"},
    )
    if not response.ok:
        return api_error(response, "Erro ao localizar role")
    if not role:
        return jsonify({"error": "Role não encontrada."}), 404
    members = db(
        "GET",
        "project_members",
        params={"select": "id", "project_id": f"eq.{project_id}", "role": f"eq.{role['name']}", "limit": "1"},
    )
    if not members.ok:
        return api_error(members, "Erro ao validar uso da role")
    if members.json():
        return jsonify({"error": "A role está atribuída a membros e não pode ser excluída."}), 409
    response = db(
        "DELETE",
        "project_roles",
        params={"id": f"eq.{role_id}", "project_id": f"eq.{project_id}"},
        prefer="return=representation",
    )
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir role")


def valid_project_role(project_id: int, role_name: str) -> bool:
    if role_name in PRESET_ROLES - {"owner"}:
        return True
    return role_name in get_project_custom_roles(project_id)


@roles_api.post("/api/projects/<int:project_id>/access-members")
def access_members_add(project_id: int):
    _, _, error = require_project(project_id, "members.manage")
    if error:
        return error
    body = json_body()
    email = str(body.get("email") or "").strip().lower()
    role = normalize_role_name(body.get("role") or "editor")
    if not email or "@" not in email:
        return jsonify({"error": "Informe um e-mail válido."}), 400
    if not valid_project_role(project_id, role):
        return jsonify({"error": "Role de acesso inválida."}), 400
    existing, response = fetch_one("project_members", {"select": "id", "project_id": f"eq.{project_id}", "email": f"eq.{email}"})
    if not response.ok:
        return api_error(response, "Erro ao verificar membro")
    method = "PATCH" if existing else "POST"
    params = {"id": f"eq.{existing['id']}"} if existing else None
    payload = {"project_id": project_id, "email": email, "role": role} if not existing else {"role": role}
    response = db(method, "project_members", params=params, payload=payload, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao salvar membro")


@roles_api.patch("/api/projects/<int:project_id>/access-members/<int:member_id>")
def access_members_update(project_id: int, member_id: int):
    _, _, error = require_project(project_id, "members.manage")
    if error:
        return error
    role = normalize_role_name(json_body().get("role"))
    if not valid_project_role(project_id, role):
        return jsonify({"error": "Role de acesso inválida."}), 400
    member, response = fetch_one("project_members", {"select": "id,role", "id": f"eq.{member_id}", "project_id": f"eq.{project_id}"})
    if not response.ok:
        return api_error(response, "Erro ao localizar membro")
    if not member:
        return jsonify({"error": "Membro não encontrado."}), 404
    if member.get("role") == "owner":
        return jsonify({"error": "O proprietário não pode ter sua role alterada."}), 400
    response = db("PATCH", "project_members", params={"id": f"eq.{member_id}"}, payload={"role": role}, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao atualizar membro")


@roles_api.get("/api/workbooks/<int:workbook_id>/capabilities")
def workbook_capabilities(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    project, role, error = require_project(int(workbook.get("project_id") or 0), "workbook.view")
    if error:
        return error
    return jsonify({
        "workbook_id": workbook_id,
        "project_id": workbook.get("project_id"),
        "role": role,
        "capabilities": project.get("capabilities", []),
    })
