from __future__ import annotations

import os
import re
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote

from flask import Blueprint, Flask, Response, jsonify, request

from backend import api_error, db, fetch_one, require_project


github_sites_api = Blueprint("github_sites_api", __name__)

SITE_SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
HTML_MIME_TYPE = "text/html; charset=utf-8"
SITE_CACHE_CONTROL = os.getenv("GITHUB_SITES_CACHE_CONTROL", "public, max-age=30, stale-while-revalidate=120")
PREVIEW_SANDBOX_POLICY = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"


def _clean_host(value: str | None) -> str:
    host = str(value or "").strip().lower().rstrip(".")
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end > 0 else host
    return host.split(":", 1)[0]


def sites_base_domain() -> str | None:
    value = str(os.getenv("GITHUB_SITES_BASE_DOMAIN", "")).strip().lower()
    value = re.sub(r"^https?://", "", value).split("/", 1)[0]
    value = _clean_host(value)
    return value or None


def sites_scheme() -> str:
    configured = str(os.getenv("GITHUB_SITES_SCHEME", "https")).strip().lower()
    return configured if configured in {"http", "https"} else "https"


def normalize_site_slug(value: Any) -> str | None:
    slug = str(value or "").strip().lower()
    return slug if SITE_SLUG_PATTERN.fullmatch(slug) else None


def site_slug_from_host(host: str | None = None) -> str | None:
    base_domain = sites_base_domain()
    if not base_domain:
        return None
    request_host = _clean_host(host if host is not None else request.host)
    suffix = f".{base_domain}"
    if not request_host.endswith(suffix):
        return None
    slug = request_host[: -len(suffix)]
    if not slug or "." in slug:
        return None
    return normalize_site_slug(slug)


def public_site_url(slug: str, site_path: str = "") -> str | None:
    normalized_slug = normalize_site_slug(slug)
    base_domain = sites_base_domain()
    if not normalized_slug or not base_domain:
        return None
    clean_path = str(site_path or "").strip("/")
    suffix = quote(clean_path, safe="/") if clean_path else ""
    return f"{sites_scheme()}://{normalized_slug}.{base_domain}/{suffix}"


def preview_site_url(slug: str, site_path: str = "") -> str:
    normalized_slug = normalize_site_slug(slug) or "invalid"
    clean_path = str(site_path or "").strip("/")
    suffix = quote(clean_path, safe="/")
    return f"/_sites/{normalized_slug}/{suffix}" if suffix else f"/_sites/{normalized_slug}/"


def candidate_site_paths(requested_path: str | None) -> list[str]:
    raw = str(requested_path or "").replace("\\", "/").strip()
    raw = raw.split("?", 1)[0].split("#", 1)[0].lstrip("/")
    if not raw:
        return ["index.html"]
    pure = PurePosixPath(raw)
    if pure.is_absolute() or ".." in pure.parts or "\x00" in raw:
        return []
    normalized = pure.as_posix().strip("/")
    if not normalized:
        return ["index.html"]
    if normalized.lower().endswith(".html"):
        return [normalized]
    if raw.endswith("/"):
        return [f"{normalized}/index.html"]
    return [f"{normalized}.html", f"{normalized}/index.html"]


def _connection_for_slug(slug: str) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "github_connections",
        {
            "select": (
                "id,project_id,repository_full_name,branch,status,last_sync_sha,last_sync_at,"
                "site_slug,site_enabled"
            ),
            "site_slug": f"eq.{slug}",
            "site_enabled": "eq.true",
        },
    )


def _connection_for_project(project_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "github_connections",
        {
            "select": (
                "id,project_id,repository_full_name,branch,status,last_sync_sha,last_sync_at,"
                "site_slug,site_enabled"
            ),
            "project_id": f"eq.{project_id}",
        },
    )


def _file_for_site_path(connection_id: int, site_path: str) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "github_template_files",
        {
            "select": "id,path,name,site_path,content,blob_sha,commit_sha,size_bytes,synced_at",
            "github_connection_id": f"eq.{connection_id}",
            "site_path": f"eq.{site_path}",
            "order": "path.asc",
        },
    )


def _first_file(connection_id: int) -> tuple[dict[str, Any] | None, Any]:
    return fetch_one(
        "github_template_files",
        {
            "select": "id,path,name,site_path,content,blob_sha,commit_sha,size_bytes,synced_at",
            "github_connection_id": f"eq.{connection_id}",
            "order": "site_path.asc,path.asc",
        },
    )


def _resolve_site_file(connection_id: int, requested_path: str | None) -> tuple[dict[str, Any] | None, Any]:
    candidates = candidate_site_paths(requested_path)
    last_response = None
    for candidate in candidates:
        row, response = _file_for_site_path(connection_id, candidate)
        last_response = response
        if response is not None and not response.ok:
            return None, response
        if row:
            return row, response
    if not str(requested_path or "").strip("/"):
        return _first_file(connection_id)
    return None, last_response


def _site_files(connection_id: int, slug: str) -> tuple[list[dict[str, Any]], Any]:
    response = db(
        "GET",
        "github_template_files",
        params={
            "select": "id,path,name,site_path,blob_sha,commit_sha,size_bytes,synced_at",
            "github_connection_id": f"eq.{connection_id}",
            "order": "site_path.asc,path.asc",
        },
    )
    if not response.ok:
        return [], response
    rows = []
    for row in response.json():
        site_path = str(row.get("site_path") or "")
        public_url = public_site_url(slug, site_path)
        preview_url = preview_site_url(slug, site_path)
        rows.append(
            {
                **row,
                "public_url": public_url,
                "preview_url": preview_url,
                "open_url": public_url or preview_url,
            }
        )
    return rows, response


def _not_found_response() -> Response:
    return Response(
        "<!doctype html><html lang='pt-BR'><meta charset='utf-8'><title>Site não encontrado</title>"
        "<body style='font:16px system-ui;padding:40px'><h1>Site não encontrado</h1>"
        "<p>Este HTML não existe ou ainda não foi sincronizado.</p></body></html>",
        status=404,
        content_type=HTML_MIME_TYPE,
    )


def _site_response(file_row: dict[str, Any], *, sandboxed: bool = False) -> Response:
    content = str(file_row.get("content") or "")
    response = Response(content, status=200, content_type=HTML_MIME_TYPE)
    blob_sha = str(file_row.get("blob_sha") or "").strip()
    if blob_sha:
        response.set_etag(blob_sha)
        response.make_conditional(request)
    response.headers["Cache-Control"] = "no-store" if sandboxed else SITE_CACHE_CONTROL
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["X-SuperExcel-Source-Commit"] = str(file_row.get("commit_sha") or "")[:40]
    if sandboxed:
        # The preview lives on the application host. An opaque sandbox origin prevents
        # synchronized HTML from reading the authenticated panel's storage or APIs.
        response.headers["Content-Security-Policy"] = PREVIEW_SANDBOX_POLICY
        response.headers["X-SuperExcel-Preview"] = "sandboxed"
    return response


def serve_github_site(
    slug: str,
    requested_path: str | None = None,
    *,
    sandboxed: bool = False,
) -> Response:
    normalized_slug = normalize_site_slug(slug)
    if not normalized_slug:
        return _not_found_response()
    connection, response = _connection_for_slug(normalized_slug)
    if response is None or not response.ok or not connection or connection.get("status") != "active":
        return _not_found_response()
    file_row, file_response = _resolve_site_file(int(connection["id"]), requested_path)
    if file_response is not None and not file_response.ok:
        return _not_found_response()
    return _site_response(file_row, sandboxed=sandboxed) if file_row else _not_found_response()


def install_github_site_hosting(app: Flask) -> None:
    @app.before_request
    def dispatch_github_site_subdomain():
        slug = site_slug_from_host()
        if not slug:
            return None
        if request.method not in {"GET", "HEAD"}:
            return Response("Método não permitido.", status=405, content_type="text/plain; charset=utf-8")
        return serve_github_site(slug, request.path.lstrip("/"), sandboxed=False)


@github_sites_api.get("/_sites/<slug>/")
@github_sites_api.get("/_sites/<slug>/<path:site_path>")
def github_site_preview(slug: str, site_path: str = ""):
    return serve_github_site(slug, site_path, sandboxed=True)


@github_sites_api.get("/api/github/site")
def github_site_status():
    try:
        project_id = int(request.args.get("project_id", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "Projeto inválido."}), 400
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error
    connection, response = _connection_for_project(project_id)
    if not response.ok:
        return api_error(response, "Erro ao consultar a publicação do GitHub")
    if not connection:
        return jsonify({"role": role, "site": None, "files": []})

    slug = normalize_site_slug(connection.get("site_slug"))
    if not slug:
        return jsonify({"error": "A conexão ainda não possui um subdomínio válido."}), 409
    files, file_response = _site_files(int(connection["id"]), slug)
    if not file_response.ok:
        return api_error(file_response, "Erro ao listar os HTMLs publicados")
    entry = next((item for item in files if item.get("site_path") == "index.html"), files[0] if files else None)
    site_url = public_site_url(slug)
    preview_url = preview_site_url(slug)
    return jsonify(
        {
            "role": role,
            "site": {
                "slug": slug,
                "enabled": bool(connection.get("site_enabled")),
                "status": connection.get("status"),
                "domain_configured": bool(sites_base_domain()),
                "base_domain": sites_base_domain(),
                "public_url": site_url,
                "preview_url": preview_url,
                "open_url": site_url or preview_url,
                "entry_path": entry.get("site_path") if entry else None,
                "repository_full_name": connection.get("repository_full_name"),
                "last_sync_sha": connection.get("last_sync_sha"),
                "last_sync_at": connection.get("last_sync_at"),
            },
            "files": files,
        }
    )
