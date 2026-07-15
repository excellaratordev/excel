from __future__ import annotations

import json
import os
from typing import Any

import requests
from flask import Flask, g, jsonify, redirect, render_template, request, url_for

MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
REQUEST_TIMEOUT = float(os.getenv("SUPABASE_TIMEOUT", "15"))

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = MAX_WORKBOOK_BYTES + 512 * 1024

PUBLIC_API_PATHS = {"/api/health", "/api/auth/config"}


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def auth_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY)


def headers(prefer: str | None = None) -> dict[str, str]:
    if not configured():
        raise RuntimeError("Supabase não configurado.")
    result = {"apikey": SUPABASE_SECRET_KEY, "Content-Type": "application/json"}
    if SUPABASE_SECRET_KEY.startswith("eyJ"):
        result["Authorization"] = f"Bearer {SUPABASE_SECRET_KEY}"
    if prefer:
        result["Prefer"] = prefer
    return result


def db(
    method: str,
    table: str,
    *,
    params: dict[str, str] | None = None,
    payload: Any = None,
    prefer: str | None = None,
) -> requests.Response:
    return requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=headers(prefer),
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


def empty_workbook(name: str) -> dict[str, Any]:
    return {
        "version": 1,
        "name": name,
        "rows": 60,
        "cols": 26,
        "cells": [[None] * 26 for _ in range(60)],
    }


def bearer_token() -> str | None:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def google_provider(user: dict[str, Any]) -> bool:
    app_metadata = user.get("app_metadata") or {}
    provider = str(app_metadata.get("provider", "")).lower()
    providers = {str(item).lower() for item in app_metadata.get("providers") or []}
    identities = {
        str(identity.get("provider", "")).lower()
        for identity in user.get("identities") or []
        if isinstance(identity, dict)
    }
    return provider == "google" or "google" in providers or "google" in identities


def verify_user_token(token: str) -> tuple[dict[str, Any] | None, tuple[Any, int] | None]:
    if not auth_configured():
        return None, (jsonify({"error": "Supabase Auth não configurado no servidor."}), 503)

    try:
        response = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": f"Bearer {token}",
            },
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


@app.before_request
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


@app.get("/")
def root_page():
    return redirect(url_for("login_page"))


@app.get("/login")
def login_page():
    return render_template("login.html")


@app.get("/auth/callback")
def auth_callback_page():
    return render_template("auth_callback.html")


@app.get("/files")
def manager_page():
    return render_template("manager.html")


@app.get("/sheet")
def sheet_redirect():
    workbook_id = request.args.get("id")
    return redirect(url_for("sheet_page", workbook_id=workbook_id)) if workbook_id else redirect(url_for("manager_page"))


@app.get("/sheet/<int:workbook_id>")
def sheet_page(workbook_id: int):
    # O conteúdo da planilha é carregado pela API autenticada no navegador.
    return render_template("index.html", preload_workbook_id=workbook_id)


@app.get("/api/auth/config")
def auth_config():
    if not auth_configured():
        return jsonify({"error": "SUPABASE_PUBLISHABLE_KEY não foi configurada."}), 503
    return jsonify(
        {
            "supabase_url": SUPABASE_URL,
            "publishable_key": SUPABASE_PUBLISHABLE_KEY,
            "provider": "google",
        }
    )


@app.get("/api/health")
def health():
    if not configured():
        return jsonify({"status": "error", "configured": False}), 503
    response = db("GET", "workbooks", params={"select": "id", "limit": "1"})
    return (jsonify({"status": "ok", "database": "supabase"}), 200) if response.ok else api_error(response, "Falha no Supabase")


@app.get("/api/me")
def current_user():
    user = g.auth_user
    metadata = user.get("user_metadata") or {}
    return jsonify(
        {
            "id": user.get("id"),
            "email": user.get("email"),
            "name": metadata.get("full_name") or metadata.get("name") or user.get("email"),
            "avatar_url": metadata.get("avatar_url") or metadata.get("picture"),
            "provider": "google",
        }
    )


@app.get("/api/manager")
def manager_data():
    folder_id = request.args.get("folder_id")
    folder_filter = "is.null" if not folder_id else f"eq.{int(folder_id)}"
    folders = db("GET", "folders", params={"select": "id,name,parent_id,updated_at", "parent_id": folder_filter, "order": "name.asc"})
    books = db("GET", "workbooks", params={"select": "id,name,folder_id,created_at,updated_at", "folder_id": folder_filter, "order": "name.asc"})
    if not folders.ok:
        return api_error(folders, "Erro ao listar pastas")
    if not books.ok:
        return api_error(books, "Erro ao listar planilhas")
    return jsonify({"folders": folders.json(), "workbooks": books.json()})


@app.post("/api/folders")
def create_folder():
    body = json_body()
    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Informe o nome da pasta."}), 400
    record = {"name": name, "parent_id": body.get("parent_id")}
    response = db("POST", "folders", payload=record, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma pasta com esse nome."}), 409
    return jsonify(response.json()[0]) if response.ok else api_error(response, "Erro ao criar pasta")


@app.delete("/api/folders/<int:folder_id>")
def delete_folder(folder_id: int):
    response = db("DELETE", "folders", params={"id": f"eq.{folder_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir pasta")


@app.get("/api/workbooks")
def list_workbooks():
    response = db("GET", "workbooks", params={"select": "id,name,folder_id,created_at,updated_at", "order": "updated_at.desc"})
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar planilhas")


@app.get("/api/workbooks/<int:workbook_id>")
def get_workbook(workbook_id: int):
    response = db("GET", "workbooks", params={"select": "id,name,payload,folder_id,created_at,updated_at", "id": f"eq.{workbook_id}", "limit": "1"})
    if not response.ok:
        return api_error(response, "Erro ao abrir planilha")
    rows = response.json()
    if not rows:
        return jsonify({"error": "Planilha não encontrada."}), 404
    result = rows[0]
    result["data"] = result.pop("payload")
    return jsonify(result)


@app.post("/api/workbooks")
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
    record = {"name": name, "payload": payload}
    if "folder_id" in body:
        record["folder_id"] = body.get("folder_id")
    workbook_id = body.get("id")
    if workbook_id is None:
        response = db("POST", "workbooks", payload=record, prefer="return=representation")
    else:
        response = db("PATCH", "workbooks", params={"id": f"eq.{int(workbook_id)}"}, payload=record, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma planilha com esse nome nesta pasta."}), 409
    if not response.ok:
        return api_error(response, "Erro ao salvar planilha")
    saved = response.json()[0]
    return jsonify({"id": saved["id"], "name": saved["name"], "updated_at": saved["updated_at"]})


@app.patch("/api/workbooks/<int:workbook_id>/move")
def move_workbook(workbook_id: int):
    response = db("PATCH", "workbooks", params={"id": f"eq.{workbook_id}"}, payload={"folder_id": json_body().get("folder_id")}, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao mover planilha")


@app.delete("/api/workbooks/<int:workbook_id>")
def delete_workbook(workbook_id: int):
    response = db("DELETE", "workbooks", params={"id": f"eq.{workbook_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir planilha")


@app.get("/api/variables")
def list_variables():
    response = db("GET", "external_variables", params={"select": "*", "order": "scope.asc,name.asc"})
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar variáveis")


@app.post("/api/variables")
def save_variable():
    body = json_body()
    name = str(body.get("name", "")).strip().upper()
    if not name:
        return jsonify({"error": "Informe o nome da variável."}), 400
    record = {
        "name": name,
        "value": body.get("value"),
        "scope": body.get("scope", "global"),
        "folder_id": body.get("folder_id"),
        "workbook_id": body.get("workbook_id"),
        "description": str(body.get("description", "")),
    }
    response = db("POST", "external_variables", payload=record, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok else api_error(response, "Erro ao salvar variável")


@app.delete("/api/variables/<int:variable_id>")
def delete_variable(variable_id: int):
    response = db("DELETE", "external_variables", params={"id": f"eq.{variable_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir variável")


@app.get("/api/permissions")
def list_permissions():
    response = db("GET", "resource_permissions", params={"select": "*", "order": "grantee_email.asc"})
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar permissões")


@app.post("/api/permissions")
def save_permission():
    body = json_body()
    resource_type = body.get("resource_type")
    record = {
        "resource_type": resource_type,
        "folder_id": body.get("folder_id") if resource_type == "folder" else None,
        "workbook_id": body.get("workbook_id") if resource_type == "workbook" else None,
        "grantee_email": str(body.get("grantee_email", "")).strip().lower(),
        "permission": body.get("permission", "view"),
    }
    if not record["grantee_email"]:
        return jsonify({"error": "Informe o e-mail."}), 400
    response = db("POST", "resource_permissions", payload=record, prefer="return=representation")
    return jsonify(response.json()[0]) if response.ok else api_error(response, "Erro ao salvar permissão")


@app.delete("/api/permissions/<int:permission_id>")
def delete_permission(permission_id: int):
    response = db("DELETE", "resource_permissions", params={"id": f"eq.{permission_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir permissão")


@app.errorhandler(413)
def too_large(_: Exception):
    return jsonify({"error": "Requisição muito grande."}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
