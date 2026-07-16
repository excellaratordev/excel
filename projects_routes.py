from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, g, jsonify, request

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


def invite_digest(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def ensure_project_member(project: dict, email: str, role: str, invited_by: str):
    project_id = int(project["id"])
    if normalize_email(project.get("owner_email")) == email:
        return "owner", None

    member, response = fetch_one(
        "project_members",
        {
            "select": "id,email,role",
            "project_id": f"eq.{project_id}",
            "email": f"eq.{email}",
        },
    )
    if not response.ok:
        return None, api_error(response, "Erro ao verificar participação no projeto")

    if member:
        current_role = str(member.get("role") or "viewer")
        if ROLE_RANK.get(role, -1) > ROLE_RANK.get(current_role, -1):
            response = db(
                "PATCH",
                "project_members",
                params={"id": f"eq.{member['id']}"},
                payload={"role": role, "invited_by_email": invited_by},
                prefer="return=representation",
            )
            if not response.ok:
                return None, api_error(response, "Erro ao atualizar acesso ao projeto")
            return role, None
        return current_role, None

    response = db(
        "POST",
        "project_members",
        payload={
            "project_id": project_id,
            "email": email,
            "role": role,
            "invited_by_email": invited_by,
        },
        prefer="return=representation",
    )
    if not response.ok:
        return None, api_error(response, "Erro ao adicionar membro ao projeto")
    return role, None


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


@projects_api.post("/api/projects/<int:project_id>/share-links")
def share_link_create(project_id: int):
    project, _, error = require_project(project_id, "admin")
    if error:
        return error

    body = json_body()
    access_level = str(body.get("role", "editor")).lower()
    if access_level not in {"viewer", "editor", "admin"}:
        return jsonify({"error": "Nível de acesso inválido."}), 400
    try:
        valid_days = int(body.get("valid_days", 7))
    except (TypeError, ValueError):
        return jsonify({"error": "Validade inválida."}), 400
    if valid_days < 1 or valid_days > 30:
        return jsonify({"error": "A validade deve ser de 1 a 30 dias."}), 400

    expires_at = datetime.now(timezone.utc) + timedelta(days=valid_days)
    created = None
    raw_code = ""
    response = None
    for _ in range(3):
        raw_code = secrets.token_urlsafe(32)
        created, response = insert_one(
            "project_share_links",
            {
                "project_id": project_id,
                "code_digest": invite_digest(raw_code),
                "access_level": access_level,
                "created_by_email": current_email(),
                "expires_at": expires_at.isoformat(),
            },
        )
        if response.ok and created:
            break
        if response.status_code != 409:
            return api_error(response, "Erro ao criar link de convite")

    if not created:
        return jsonify({"error": "Não foi possível gerar um código de convite único."}), 500

    link = f"{request.url_root.rstrip('/')}/invite/{raw_code}"
    return jsonify({
        "project_id": project_id,
        "project_name": project.get("name"),
        "role": access_level,
        "expires_at": created.get("expires_at") or expires_at.isoformat(),
        "link": link,
    })


@projects_api.post("/api/share-links/<code>/accept")
def share_link_accept(code: str):
    if len(code) < 20 or len(code) > 200:
        return jsonify({"error": "Link de convite inválido."}), 404

    share, response = fetch_one(
        "project_share_links",
        {
            "select": "id,project_id,access_level,created_by_email,expires_at,used_by_email,used_at,disabled_at",
            "code_digest": f"eq.{invite_digest(code)}",
        },
    )
    if not response.ok:
        return api_error(response, "Erro ao validar convite")
    if not share:
        return jsonify({"error": "Este link de convite não existe."}), 404
    if share.get("disabled_at"):
        return jsonify({"error": "Este link de convite foi desativado."}), 410

    expires_at = parse_timestamp(share.get("expires_at"))
    if not expires_at or expires_at <= datetime.now(timezone.utc):
        return jsonify({"error": "Este link de convite expirou."}), 410

    project, project_response = fetch_one(
        "projects",
        {"select": "id,name,owner_email", "id": f"eq.{share['project_id']}"},
    )
    if not project_response.ok:
        return api_error(project_response, "Erro ao localizar projeto")
    if not project:
        return jsonify({"error": "O projeto deste convite não existe mais."}), 404

    email = current_email()
    used_by = normalize_email(share.get("used_by_email"))
    if share.get("used_at") and used_by and used_by != email:
        return jsonify({"error": "Este link de convite já foi utilizado por outra pessoa."}), 410

    if not share.get("used_at"):
        claimed_at = datetime.now(timezone.utc).isoformat()
        claim_response = db(
            "PATCH",
            "project_share_links",
            params={
                "id": f"eq.{share['id']}",
                "used_at": "is.null",
                "disabled_at": "is.null",
            },
            payload={"used_by_email": email, "used_at": claimed_at},
            prefer="return=representation",
        )
        if not claim_response.ok:
            return api_error(claim_response, "Erro ao confirmar convite")
        if not claim_response.json():
            latest, latest_response = fetch_one(
                "project_share_links",
                {"select": "used_by_email,used_at", "id": f"eq.{share['id']}"},
            )
            if not latest_response.ok:
                return api_error(latest_response, "Erro ao confirmar convite")
            if normalize_email((latest or {}).get("used_by_email")) != email:
                return jsonify({"error": "Este link de convite acabou de ser utilizado por outra pessoa."}), 410

    granted_role, member_error = ensure_project_member(
        project,
        email,
        str(share.get("access_level") or "editor"),
        normalize_email(share.get("created_by_email")),
    )
    if member_error:
        return member_error

    return jsonify({
        "accepted": True,
        "project_id": int(project["id"]),
        "project_name": project.get("name"),
        "role": granted_role,
    })
