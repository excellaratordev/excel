from __future__ import annotations

import os
from typing import Any

import requests
from flask import g, jsonify, request

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
REQUEST_TIMEOUT = float(os.getenv("SUPABASE_TIMEOUT", "15"))
ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2, "owner": 3}
PUBLIC_API_PATHS = {"/api/health", "/api/auth/config"}


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def auth_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY)


def service_headers(prefer: str | None = None) -> dict[str, str]:
    if not configured():
        raise RuntimeError("Supabase não configurado.")
    result = {"apikey": SUPABASE_SECRET_KEY, "Content-Type": "application/json"}
    if SUPABASE_SECRET_KEY.startswith("eyJ"):
        result["Authorization"] = f"Bearer {SUPABASE_SECRET_KEY}"
    if prefer:
        result["Prefer"] = prefer
    return result


def db(method: str, table: str, *, params: dict[str, str] | None = None, payload: Any = None, prefer: str | None = None) -> requests.Response:
    return requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=service_headers(prefer),
        params=params,
        json=payload,
        timeout=REQUEST_TIMEOUT,
    )


def api_error(response: requests.Response, fallback: str):
    try:
        detail = response.json()
    except ValueError:
        detail = {"message": response.text[:500]}
    return jsonify({"error": detail.get("message") or detail.get("hint") or fallback}), response.status_code


def json_body() -> dict[str, Any]:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def current_email() -> str:
    return normalize_email((g.auth_user or {}).get("email"))


def parse_nullable_id(value: Any, field_name: str) -> tuple[int | None, str | None]:
    if value is None or value == "":
        return None, None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None, f"{field_name} inválido."
    if parsed <= 0:
        return None, f"{field_name} inválido."
    return parsed, None


def parse_required_id(value: Any, field_name: str) -> tuple[int | None, str | None]:
    parsed, error = parse_nullable_id(value, field_name)
    if error:
        return None, error
    if parsed is None:
        return None, f"Informe {field_name.lower()}."
    return parsed, None


def empty_workbook(name: str) -> dict[str, Any]:
    return {"version": 1, "name": name, "rows": 1000, "cols": 60, "cells": [[None] * 60 for _ in range(1000)]}


def bearer_token() -> str | None:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def google_provider(user: dict[str, Any]) -> bool:
    metadata = user.get("app_metadata") or {}
    providers = {str(item).lower() for item in metadata.get("providers") or []}
    identities = {str(item.get("provider", "")).lower() for item in user.get("identities") or [] if isinstance(item, dict)}
    return str(metadata.get("provider", "")).lower() == "google" or "google" in providers or "google" in identities


def verify_user_token(token: str):
    if not auth_configured():
        return None, (jsonify({"error": "Supabase Auth não configurado no servidor."}), 503)
    try:
        response = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": f"Bearer {token}"},
            timeout=REQUEST_TIMEOUT,
        )
    except requests.RequestException:
        return None, (jsonify({"error": "Não foi possível validar a sessão."}), 503)
    if not response.ok:
        return None, (jsonify({"error": "Sessão inválida ou expirada."}), 401)
    user = response.json()
    if not google_provider(user):
        return None, (jsonify({"error": "Acesso permitido somente com uma conta Google."}), 403)
    return user, None


def protect_api_routes():
    if not request.path.startswith("/api/") or request.path in PUBLIC_API_PATHS:
        return None
    token = bearer_token()
    if not token:
        return jsonify({"error": "Faça login com o Google para continuar."}), 401
    user, error = verify_user_token(token)
    if error:
        return error
    g.auth_user = user
    return None


def fetch_one(table: str, params: dict[str, str]):
    response = db("GET", table, params={**params, "limit": "1"})
    if not response.ok:
        return None, response
    rows = response.json()
    return (rows[0] if rows else None), response


def insert_one(table: str, payload: dict[str, Any]):
    response = db("POST", table, payload=payload, prefer="return=representation")
    rows = response.json() if response.ok else []
    return (rows[0] if rows else None), response


def get_project_role(project_id: int, email: str | None = None):
    email = normalize_email(email or current_email())
    project, response = fetch_one("projects", {"select": "id,name,owner_email,created_at,updated_at", "id": f"eq.{project_id}"})
    if not response.ok:
        return None, None, response
    if not project:
        return None, None, None
    if normalize_email(project.get("owner_email")) == email:
        return project, "owner", None
    member, response = fetch_one(
        "project_members",
        {"select": "id,project_id,email,role,created_at,updated_at", "project_id": f"eq.{project_id}", "email": f"eq.{email}"},
    )
    if not response.ok:
        return None, None, response
    return project, (str(member.get("role")) if member else None), None


def require_project(project_id: int, minimum_role: str = "viewer"):
    project, role, response = get_project_role(project_id)
    if response is not None:
        return None, None, api_error(response, "Erro ao verificar o projeto")
    if not project:
        return None, None, (jsonify({"error": "Projeto não encontrado."}), 404)
    if role is None:
        return None, None, (jsonify({"error": "Você não possui acesso a este projeto."}), 403)
    if ROLE_RANK.get(role, -1) < ROLE_RANK[minimum_role]:
        return None, None, (jsonify({"error": "Você não possui permissão para esta ação."}), 403)
    return project, role, None


def project_ids_for_user(email: str) -> list[int]:
    ids: set[int] = set()
    owned = db("GET", "projects", params={"select": "id", "owner_email": f"eq.{email}"})
    members = db("GET", "project_members", params={"select": "project_id", "email": f"eq.{email}"})
    if owned.ok:
        ids.update(int(row["id"]) for row in owned.json())
    if members.ok:
        ids.update(int(row["project_id"]) for row in members.json())
    return sorted(ids)


def ensure_owner_membership(project: dict[str, Any]) -> None:
    owner = normalize_email(project.get("owner_email"))
    member, response = fetch_one("project_members", {"select": "id", "project_id": f"eq.{project['id']}", "email": f"eq.{owner}"})
    if owner and response.ok and not member:
        db("POST", "project_members", payload={"project_id": project["id"], "email": owner, "role": "owner", "invited_by_email": owner}, prefer="return=minimal")


def create_personal_project(email: str) -> dict[str, Any]:
    project, response = insert_one("projects", {"name": "Meu projeto", "owner_email": email})
    if not response.ok or not project:
        raise RuntimeError("Não foi possível criar o projeto inicial.")
    ensure_owner_membership(project)
    projects = db("GET", "projects", params={"select": "id", "limit": "2"})
    if projects.ok and len(projects.json()) == 1:
        for table in ("folders", "workbooks", "external_variables", "resource_permissions"):
            payload: dict[str, Any] = {"project_id": project["id"]}
            if table in {"folders", "workbooks"}:
                payload["created_by_email"] = email
            if table == "workbooks":
                payload["updated_by_email"] = email
            db("PATCH", table, params={"project_id": "is.null"}, payload=payload, prefer="return=minimal")
    return project


def list_user_projects() -> list[dict[str, Any]]:
    email = current_email()
    ids = project_ids_for_user(email)
    if not ids:
        ids = [int(create_personal_project(email)["id"])]
    response = db("GET", "projects", params={"select": "id,name,owner_email,created_at,updated_at", "id": f"in.({','.join(map(str, ids))})", "order": "name.asc"})
    if not response.ok:
        raise RuntimeError("Não foi possível listar os projetos.")
    result = []
    for project in response.json():
        ensure_owner_membership(project)
        _, role, _ = get_project_role(int(project["id"]), email)
        project["role"] = role or "viewer"
        result.append(project)
    return result


def get_folder(folder_id: int):
    return fetch_one("folders", {"select": "id,name,parent_id,project_id,created_at,updated_at", "id": f"eq.{folder_id}"})


def get_workbook(workbook_id: int, include_payload: bool = False):
    select = "id,name,folder_id,project_id,revision,file_kind,pipeline_stage,created_at,updated_at,created_by_email,updated_by_email"
    if include_payload:
        select += ",payload"
    return fetch_one("workbooks", {"select": select, "id": f"eq.{workbook_id}"})
