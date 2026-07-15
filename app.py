from __future__ import annotations

import os

from flask import Flask, jsonify, redirect, render_template, request, url_for

from backend import (
    SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_URL,
    api_error,
    auth_configured,
    configured,
    db,
    protect_api_routes,
)
from files_routes import files_api
from projects_routes import projects_api
from workbook_routes import workbooks_api

MAX_WORKBOOK_BYTES = 5 * 1024 * 1024

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = MAX_WORKBOOK_BYTES + 512 * 1024
app.before_request(protect_api_routes)
app.register_blueprint(projects_api)
app.register_blueprint(files_api)
app.register_blueprint(workbooks_api)


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
    return render_template("index.html", preload_workbook_id=workbook_id)


@app.get("/api/auth/config")
def auth_config():
    if not auth_configured():
        return jsonify({"error": "SUPABASE_PUBLISHABLE_KEY não foi configurada."}), 503
    return jsonify({"supabase_url": SUPABASE_URL, "publishable_key": SUPABASE_PUBLISHABLE_KEY, "provider": "google"})


@app.get("/api/health")
def health():
    if not configured():
        return jsonify({"status": "error", "configured": False}), 503
    response = db("GET", "projects", params={"select": "id", "limit": "1"})
    return (jsonify({"status": "ok", "database": "supabase"}), 200) if response.ok else api_error(response, "Falha no Supabase")


@app.errorhandler(413)
def too_large(_: Exception):
    return jsonify({"error": "Requisição muito grande."}), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
