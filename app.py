from __future__ import annotations

import os

import backend
from capability_backend import install as install_capabilities
from performance_cache import install as install_performance_cache

# Route modules import backend helpers by value, so wrappers must be installed first.
install_performance_cache(backend)
install_capabilities(backend)

import elementar_automation_routes
import elementar_routes
import github_sites
import workbook_routes
from flask import Flask, jsonify, redirect, render_template, request, url_for

from asset_routes import assets_api
from backend import (
    SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_URL,
    api_error,
    auth_configured,
    configured,
    db,
    protect_api_routes,
)
from base_elementar_automation import install as install_base_elementar_automation
from base_reference_routes import base_reference_api
from base_routes import base_api
from collaboration_routes import collaboration_api
from elementar_automation_values import install as install_elementar_value_reuse
from elementar_realtime_delivery import install as install_elementar_realtime_delivery
from files_routes import files_api
from github_connector import github_api
from github_oauth import github_oauth_api, install_secure_connector, secure_github_callback
from github_sites import github_sites_api, install_github_site_hosting
from projects_routes import projects_api
from recovery_routes import recovery_api
from roles_routes import roles_api
from snapshot_routes import snapshot_api
from superexcel.core.workbook_payload import compact_empty_workbook
from telemetry_routes import telemetry_api
from treated_base_routes import treated_base_api
from workbook_routes import workbooks_api

MAX_WORKBOOK_BYTES = 5 * 1024 * 1024

workbook_routes.empty_workbook = compact_empty_workbook
install_elementar_value_reuse(elementar_automation_routes)
elementar_routes.MAX_SOURCE_ROW = 5000
elementar_routes.MAX_SOURCE_CELLS = 100_000
install_elementar_realtime_delivery(elementar_routes, github_sites)
install_secure_connector()

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = MAX_WORKBOOK_BYTES + 512 * 1024
install_base_elementar_automation(app)
# Public HTML subdomains must be dispatched before the main application auth guard.
install_github_site_hosting(app)
app.before_request(protect_api_routes)
app.register_blueprint(assets_api)
app.register_blueprint(projects_api)
app.register_blueprint(files_api)
app.register_blueprint(workbooks_api)
app.register_blueprint(base_api)
app.register_blueprint(treated_base_api)
app.register_blueprint(base_reference_api)
app.register_blueprint(collaboration_api)
app.register_blueprint(recovery_api)
app.register_blueprint(roles_api)
app.register_blueprint(snapshot_api)
app.register_blueprint(telemetry_api)
app.register_blueprint(elementar_routes.elementar_api)
app.register_blueprint(elementar_automation_routes.elementar_automation_api)
app.register_blueprint(github_oauth_api)
app.register_blueprint(github_api)
app.register_blueprint(github_sites_api)
app.view_functions["github_api.github_callback"] = secure_github_callback


@app.get("/")
def root_page():
    return redirect(url_for("login_page"))


@app.get("/login")
def login_page():
    return render_template("login.html")


@app.get("/auth/callback")
def auth_callback_page():
    return render_template("auth_callback.html")


@app.get("/invite/<code>")
def invite_page(code):
    return render_template("invite.html", invite_code=code)


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


@app.get("/base/<int:workbook_id>")
def base_page(workbook_id: int):
    return render_template("base.html", preload_workbook_id=workbook_id)


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
