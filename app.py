from __future__ import annotations

import json
import os
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request

MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
SUPABASE_TABLE = os.getenv("SUPABASE_TABLE", "workbooks")
REQUEST_TIMEOUT = float(os.getenv("SUPABASE_TIMEOUT", "15"))

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = MAX_WORKBOOK_BYTES + 512 * 1024


def supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def supabase_headers(*, prefer: str | None = None) -> dict[str, str]:
    if not supabase_configured():
        raise RuntimeError("SUPABASE_URL e SUPABASE_SECRET_KEY não foram configurados.")

    headers = {
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def supabase_request(
    method: str,
    path: str,
    *,
    params: dict[str, str] | None = None,
    payload: Any | None = None,
    prefer: str | None = None,
) -> requests.Response:
    response = requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers=supabase_headers(prefer=prefer),
        params=params,
        json=payload,
        timeout=REQUEST_TIMEOUT,
    )
    return response


def parse_workbook_payload(body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    name = str(body.get("name", "")).strip()
    payload = body.get("data")

    if not name:
        raise ValueError("Informe um nome para a planilha.")
    if len(name) > 120:
        raise ValueError("O nome pode ter no máximo 120 caracteres.")
    if not isinstance(payload, dict):
        raise ValueError("Os dados da planilha são inválidos.")

    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_WORKBOOK_BYTES:
        raise ValueError("A planilha excede o limite de 5 MB.")

    return name, payload


def api_error(response: requests.Response, fallback: str) -> tuple[Any, int]:
    try:
        details = response.json()
    except ValueError:
        details = {"message": response.text[:500]}

    message = details.get("message") or details.get("hint") or fallback
    return jsonify({"error": message}), response.status_code


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/health")
def health() -> Any:
    if not supabase_configured():
        return jsonify(
            {
                "status": "error",
                "app": "Super Excel",
                "database": "supabase",
                "configured": False,
                "error": "Variáveis do Supabase ausentes.",
            }
        ), 503

    try:
        response = supabase_request(
            "GET",
            SUPABASE_TABLE,
            params={"select": "id", "limit": "1"},
        )
    except requests.RequestException as error:
        return jsonify(
            {
                "status": "error",
                "app": "Super Excel",
                "database": "supabase",
                "configured": True,
                "error": str(error),
            }
        ), 503

    if not response.ok:
        return api_error(response, "Falha ao consultar o Supabase.")

    return jsonify(
        {
            "status": "ok",
            "app": "Super Excel",
            "database": "supabase",
            "configured": True,
        }
    )


@app.get("/api/workbooks")
def list_workbooks() -> Any:
    try:
        response = supabase_request(
            "GET",
            SUPABASE_TABLE,
            params={
                "select": "id,name,created_at,updated_at",
                "order": "updated_at.desc",
            },
        )
    except (RuntimeError, requests.RequestException) as error:
        return jsonify({"error": str(error)}), 503

    if not response.ok:
        return api_error(response, "Erro ao listar planilhas.")

    return jsonify(response.json())


@app.get("/api/workbooks/<int:workbook_id>")
def get_workbook(workbook_id: int) -> Any:
    try:
        response = supabase_request(
            "GET",
            SUPABASE_TABLE,
            params={
                "select": "id,name,payload,created_at,updated_at",
                "id": f"eq.{workbook_id}",
                "limit": "1",
            },
        )
    except (RuntimeError, requests.RequestException) as error:
        return jsonify({"error": str(error)}), 503

    if not response.ok:
        return api_error(response, "Erro ao abrir planilha.")

    rows = response.json()
    if not rows:
        return jsonify({"error": "Planilha não encontrada."}), 404

    result = rows[0]
    result["data"] = result.pop("payload")
    return jsonify(result)


@app.post("/api/workbooks")
def save_workbook() -> Any:
    body = request.get_json(silent=True) or {}
    try:
        name, payload = parse_workbook_payload(body)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    workbook_id = body.get("id")
    record = {"name": name, "payload": payload}

    try:
        if workbook_id is None:
            response = supabase_request(
                "POST",
                SUPABASE_TABLE,
                payload=record,
                prefer="return=representation",
            )
        else:
            response = supabase_request(
                "PATCH",
                SUPABASE_TABLE,
                params={"id": f"eq.{int(workbook_id)}"},
                payload=record,
                prefer="return=representation",
            )
    except (RuntimeError, ValueError, TypeError, requests.RequestException) as error:
        return jsonify({"error": str(error)}), 503

    if response.status_code == 409:
        return jsonify({"error": "Já existe uma planilha com esse nome."}), 409
    if not response.ok:
        return api_error(response, "Erro ao salvar planilha.")

    rows = response.json()
    if not rows:
        return jsonify({"error": "Planilha não encontrada."}), 404

    saved = rows[0]
    return jsonify(
        {
            "id": saved["id"],
            "name": saved["name"],
            "updated_at": saved["updated_at"],
        }
    )


@app.delete("/api/workbooks/<int:workbook_id>")
def delete_workbook(workbook_id: int) -> Any:
    try:
        response = supabase_request(
            "DELETE",
            SUPABASE_TABLE,
            params={"id": f"eq.{workbook_id}"},
            prefer="return=representation",
        )
    except (RuntimeError, requests.RequestException) as error:
        return jsonify({"error": str(error)}), 503

    if not response.ok:
        return api_error(response, "Erro ao excluir planilha.")

    rows = response.json()
    if not rows:
        return jsonify({"error": "Planilha não encontrada."}), 404

    return jsonify({"deleted": True})


@app.errorhandler(413)
def request_too_large(_: Exception) -> Any:
    return jsonify({"error": "Requisição muito grande."}), 413


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
