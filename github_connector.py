from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote, urlencode

import jwt
import requests
from flask import Blueprint, jsonify, redirect, request, url_for

from backend import ROLE_RANK, api_error, current_email, db, fetch_one, get_project_role, json_body, require_project

github_api = Blueprint("github_api", __name__)

GITHUB_API_URL = "https://api.github.com"
GITHUB_WEB_URL = "https://github.com"
REQUEST_TIMEOUT = float(os.getenv("GITHUB_REQUEST_TIMEOUT", "20"))
STATE_TTL_SECONDS = int(os.getenv("GITHUB_STATE_TTL_SECONDS", "900"))
MAX_HTML_FILES = int(os.getenv("GITHUB_MAX_HTML_FILES", "500"))
MAX_HTML_FILE_BYTES = int(os.getenv("GITHUB_MAX_HTML_FILE_BYTES", str(1024 * 1024)))
MAX_ARCHIVE_BYTES = int(os.getenv("GITHUB_MAX_ARCHIVE_BYTES", str(50 * 1024 * 1024)))
MAX_TOTAL_HTML_BYTES = int(os.getenv("GITHUB_MAX_TOTAL_HTML_BYTES", str(25 * 1024 * 1024)))
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]{1,255}$")

_token_cache: dict[int, tuple[str, float]] = {}
_token_cache_lock = threading.Lock()


class GitHubConnectorError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connector_configured() -> bool:
    return all(
        str(os.getenv(name, "")).strip()
        for name in (
            "GITHUB_APP_ID",
            "GITHUB_APP_SLUG",
            "GITHUB_APP_PRIVATE_KEY",
            "GITHUB_APP_WEBHOOK_SECRET",
            "GITHUB_STATE_SECRET",
        )
    )


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _state_secret() -> bytes:
    value = os.getenv("GITHUB_STATE_SECRET", "").encode("utf-8")
    if not value:
        raise GitHubConnectorError("GITHUB_STATE_SECRET não foi configurado.")
    return value


def _sign_state(payload: dict[str, Any]) -> str:
    signed = {
        **payload,
        "nonce": secrets.token_urlsafe(18),
        "exp": int(time.time()) + STATE_TTL_SECONDS,
    }
    raw = json.dumps(signed, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = _base64url_encode(raw)
    signature = hmac.new(_state_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded}.{_base64url_encode(signature)}"


def _verify_state(value: str) -> dict[str, Any]:
    encoded, separator, signature = str(value or "").partition(".")
    if not separator:
        raise GitHubConnectorError("Estado de conexão inválido.")
    expected = hmac.new(_state_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    try:
        received = _base64url_decode(signature)
        payload = json.loads(_base64url_decode(encoded))
    except (ValueError, json.JSONDecodeError) as exc:
        raise GitHubConnectorError("Estado de conexão inválido.") from exc
    if not hmac.compare_digest(expected, received):
        raise GitHubConnectorError("Estado de conexão inválido.")
    if int(payload.get("exp") or 0) < int(time.time()):
        raise GitHubConnectorError("A autorização do GitHub expirou. Inicie a conexão novamente.")
    return payload


def _private_key() -> str:
    value = os.getenv("GITHUB_APP_PRIVATE_KEY", "").strip().replace("\\n", "\n")
    if not value:
        raise GitHubConnectorError("GITHUB_APP_PRIVATE_KEY não foi configurada.")
    return value


def _app_jwt() -> str:
    now = int(time.time())
    return jwt.encode(
        {"iat": now - 60, "exp": now + 540, "iss": str(os.getenv("GITHUB_APP_ID", "")).strip()},
        _private_key(),
        algorithm="RS256",
    )


def _github_headers(token: str | None = None, *, app_jwt: bool = False) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Super-Excel-GitHub-Connector",
    }
    if app_jwt:
        headers["Authorization"] = f"Bearer {_app_jwt()}"
    elif token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _response_message(response: requests.Response, fallback: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    return str(payload.get("message") or fallback)


def _github_request(
    method: str,
    path: str,
    *,
    token: str | None = None,
    app_jwt: bool = False,
    params: dict[str, Any] | None = None,
    payload: Any = None,
    expected: tuple[int, ...] = (200,),
    stream: bool = False,
) -> requests.Response:
    try:
        response = requests.request(
            method,
            f"{GITHUB_API_URL}{path}",
            headers=_github_headers(token, app_jwt=app_jwt),
            params=params,
            json=payload,
            timeout=REQUEST_TIMEOUT,
            stream=stream,
        )
    except requests.RequestException as exc:
        raise GitHubConnectorError("Não foi possível acessar o GitHub.") from exc
    if response.status_code not in expected:
        raise GitHubConnectorError(_response_message(response, "O GitHub recusou a operação."))
    return response


def _installation_token(installation_id: int, *, force: bool = False) -> str:
    now = time.time()
    with _token_cache_lock:
        cached = _token_cache.get(installation_id)
        if cached and not force and cached[1] - 120 > now:
            return cached[0]
    response = _github_request(
        "POST",
        f"/app/installations/{installation_id}/access_tokens",
        app_jwt=True,
        expected=(201,),
    )
    payload = response.json()
    token = str(payload.get("token") or "")
    expires_at = datetime.fromisoformat(str(payload["expires_at"]).replace("Z", "+00:00")).timestamp()
    if not token:
        raise GitHubConnectorError("O GitHub não retornou um token de instalação.")
    with _token_cache_lock:
        _token_cache[installation_id] = (token, expires_at)
    return token


def _normalize_repository(value: Any) -> str:
    repository = str(value or "").strip()
    for prefix in ("https://github.com/", "http://github.com/", "git@github.com:"):
        if repository.startswith(prefix):
            repository = repository[len(prefix):]
            break
    repository = repository.removesuffix(".git").strip("/")
    if not REPOSITORY_PATTERN.fullmatch(repository):
        raise GitHubConnectorError("Informe o repositório no formato proprietário/repositorio.")
    return repository


def _normalize_branch(value: Any) -> str | None:
    branch = str(value or "").strip()
    if not branch:
        return None
    if not BRANCH_PATTERN.fullmatch(branch) or ".." in branch or branch.startswith("/") or branch.endswith("/"):
        raise GitHubConnectorError("Branch inválida.")
    return branch


def _repo_path(repository: str) -> str:
    owner, name = repository.split("/", 1)
    return f"{quote(owner, safe='')}/{quote(name, safe='')}"


def _is_template_html(path: str) -> bool:
    pure = PurePosixPath(str(path or ""))
    parts = pure.parts
    return (
        not pure.is_absolute()
        and ".." not in parts
        and "templates" in parts[:-1]
        and pure.suffix.lower() == ".html"
    )


def _git_blob_sha(content: bytes) -> str:
    header = f"blob {len(content)}\0".encode("utf-8")
    return hashlib.sha1(header + content).hexdigest()


def _connection_for_project(project_id: int):
    return fetch_one(
        "github_connections",
        {
            "select": (
                "id,project_id,installation_id,repository_full_name,branch,status,"
                "last_sync_sha,last_sync_at,last_error,created_by_email,created_at,updated_at"
            ),
            "project_id": f"eq.{project_id}",
        },
    )


def _public_connection(connection: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": connection.get("id"),
        "project_id": connection.get("project_id"),
        "installation_id": connection.get("installation_id"),
        "repository_full_name": connection.get("repository_full_name"),
        "branch": connection.get("branch"),
        "status": connection.get("status"),
        "last_sync_sha": connection.get("last_sync_sha"),
        "last_sync_at": connection.get("last_sync_at"),
        "last_error": connection.get("last_error"),
        "created_by_email": connection.get("created_by_email"),
        "created_at": connection.get("created_at"),
        "updated_at": connection.get("updated_at"),
    }


def _update_connection(connection_id: int, payload: dict[str, Any]) -> None:
    response = db(
        "PATCH",
        "github_connections",
        params={"id": f"eq.{connection_id}"},
        payload=payload,
        prefer="return=minimal",
    )
    if not response.ok:
        raise GitHubConnectorError(_response_message(response, "Não foi possível atualizar a conexão."))


def _upsert_connection(payload: dict[str, Any]) -> dict[str, Any]:
    response = db(
        "POST",
        "github_connections",
        params={"on_conflict": "project_id"},
        payload=payload,
        prefer="resolution=merge-duplicates,return=representation",
    )
    rows = response.json() if response.ok else []
    if not response.ok or not rows:
        raise GitHubConnectorError(_response_message(response, "Não foi possível salvar a conexão GitHub."))
    return rows[0]


def _branch_head(repository: str, branch: str, token: str) -> str:
    response = _github_request(
        "GET",
        f"/repos/{_repo_path(repository)}/commits/{quote(branch, safe='')}",
        token=token,
    )
    return str(response.json().get("sha") or "")


def _download_archive(repository: str, branch: str, token: str) -> bytes:
    response = _github_request(
        "GET",
        f"/repos/{_repo_path(repository)}/zipball/{quote(branch, safe='')}",
        token=token,
        expected=(200,),
        stream=True,
    )
    content = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        content.extend(chunk)
        if len(content) > MAX_ARCHIVE_BYTES:
            raise GitHubConnectorError("O repositório excede o limite de download configurado.")
    return bytes(content)


def _archive_template_files(archive: bytes, commit_sha: str) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    total_bytes = 0
    try:
        package = zipfile.ZipFile(io.BytesIO(archive))
    except zipfile.BadZipFile as exc:
        raise GitHubConnectorError("O GitHub retornou um pacote inválido.") from exc
    with package:
        for info in package.infolist():
            if info.is_dir():
                continue
            parts = PurePosixPath(info.filename).parts
            if len(parts) < 2:
                continue
            path = PurePosixPath(*parts[1:]).as_posix()
            if not _is_template_html(path):
                continue
            if info.file_size > MAX_HTML_FILE_BYTES:
                raise GitHubConnectorError(f"{path} excede o limite de tamanho por HTML.")
            if len(files) >= MAX_HTML_FILES:
                raise GitHubConnectorError("O repositório excede o limite de arquivos HTML configurado.")
            content_bytes = package.read(info)
            total_bytes += len(content_bytes)
            if total_bytes > MAX_TOTAL_HTML_BYTES:
                raise GitHubConnectorError("Os HTMLs excedem o limite total configurado.")
            try:
                content = content_bytes.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise GitHubConnectorError(f"{path} não é um HTML UTF-8 válido.") from exc
            files.append(
                {
                    "path": path,
                    "name": PurePosixPath(path).name,
                    "content": content,
                    "blob_sha": _git_blob_sha(content_bytes),
                    "commit_sha": commit_sha,
                    "size_bytes": len(content_bytes),
                }
            )
    return files


def _upsert_template_files(connection: dict[str, Any], files: list[dict[str, Any]]) -> None:
    if not files:
        return
    rows = [
        {
            **item,
            "project_id": int(connection["project_id"]),
            "github_connection_id": int(connection["id"]),
            "repository_full_name": connection["repository_full_name"],
            "synced_at": _now_iso(),
        }
        for item in files
    ]
    for offset in range(0, len(rows), 50):
        response = db(
            "POST",
            "github_template_files",
            params={"on_conflict": "github_connection_id,path"},
            payload=rows[offset:offset + 50],
            prefer="resolution=merge-duplicates,return=minimal",
        )
        if not response.ok:
            raise GitHubConnectorError(_response_message(response, "Não foi possível salvar os HTMLs sincronizados."))


def _remove_missing_files(connection_id: int, current_paths: set[str]) -> None:
    response = db(
        "GET",
        "github_template_files",
        params={"select": "id,path", "github_connection_id": f"eq.{connection_id}"},
    )
    if not response.ok:
        raise GitHubConnectorError(_response_message(response, "Não foi possível conferir os HTMLs existentes."))
    for row in response.json():
        if str(row.get("path")) in current_paths:
            continue
        deleted = db(
            "DELETE",
            "github_template_files",
            params={"id": f"eq.{int(row['id'])}"},
            prefer="return=minimal",
        )
        if not deleted.ok:
            raise GitHubConnectorError(_response_message(deleted, "Não foi possível remover um HTML antigo."))


def _full_sync(connection: dict[str, Any], token: str | None = None, commit_sha: str | None = None) -> dict[str, Any]:
    installation_id = int(connection["installation_id"])
    token = token or _installation_token(installation_id)
    repository = str(connection["repository_full_name"])
    branch = str(connection["branch"])
    commit_sha = commit_sha or _branch_head(repository, branch, token)
    _update_connection(int(connection["id"]), {"status": "syncing", "last_error": None})
    archive = _download_archive(repository, branch, token)
    files = _archive_template_files(archive, commit_sha)
    _upsert_template_files(connection, files)
    _remove_missing_files(int(connection["id"]), {item["path"] for item in files})
    synced_at = _now_iso()
    _update_connection(
        int(connection["id"]),
        {
            "status": "active",
            "last_sync_sha": commit_sha,
            "last_sync_at": synced_at,
            "last_error": None,
        },
    )
    return {"files": len(files), "commit_sha": commit_sha, "synced_at": synced_at, "mode": "full"}


def _fetch_template_file(repository: str, path: str, ref: str, token: str) -> dict[str, Any]:
    response = _github_request(
        "GET",
        f"/repos/{_repo_path(repository)}/contents/{quote(path, safe='/')}",
        token=token,
        params={"ref": ref},
    )
    payload = response.json()
    if payload.get("type") != "file" or payload.get("encoding") != "base64":
        raise GitHubConnectorError(f"Não foi possível ler {path}.")
    try:
        content_bytes = base64.b64decode(str(payload.get("content") or ""), validate=False)
        content = content_bytes.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise GitHubConnectorError(f"{path} não é um HTML UTF-8 válido.") from exc
    if len(content_bytes) > MAX_HTML_FILE_BYTES:
        raise GitHubConnectorError(f"{path} excede o limite de tamanho por HTML.")
    return {
        "path": path,
        "name": PurePosixPath(path).name,
        "content": content,
        "blob_sha": str(payload.get("sha") or _git_blob_sha(content_bytes)),
        "commit_sha": ref,
        "size_bytes": len(content_bytes),
    }


def _push_paths(payload: dict[str, Any]) -> tuple[set[str], set[str], bool]:
    changed: set[str] = set()
    removed: set[str] = set()
    commits = payload.get("commits") if isinstance(payload.get("commits"), list) else []
    for commit in commits:
        if not isinstance(commit, dict):
            continue
        changed.update(str(path) for path in (commit.get("added") or []))
        changed.update(str(path) for path in (commit.get("modified") or []))
        removed.update(str(path) for path in (commit.get("removed") or []))
    head_commit = payload.get("head_commit")
    if isinstance(head_commit, dict):
        changed.update(str(path) for path in (head_commit.get("added") or []))
        changed.update(str(path) for path in (head_commit.get("modified") or []))
        removed.update(str(path) for path in (head_commit.get("removed") or []))
    changed -= removed
    declared_size = int(payload.get("size") or len(commits))
    incomplete = bool(payload.get("forced")) or declared_size > len(commits)
    return changed, removed, incomplete


def _incremental_sync(connection: dict[str, Any], payload: dict[str, Any], token: str) -> dict[str, Any]:
    after = str(payload.get("after") or "")
    changed, removed, incomplete = _push_paths(payload)
    if incomplete or not after or after == "0" * 40:
        return _full_sync(connection, token=token, commit_sha=after or None)

    changed = {path for path in changed if _is_template_html(path)}
    removed = {path for path in removed if _is_template_html(path)}
    if len(changed) > MAX_HTML_FILES:
        return _full_sync(connection, token=token, commit_sha=after)

    files = [
        _fetch_template_file(str(connection["repository_full_name"]), path, after, token)
        for path in sorted(changed)
    ]
    _upsert_template_files(connection, files)
    for path in sorted(removed):
        response = db(
            "DELETE",
            "github_template_files",
            params={
                "github_connection_id": f"eq.{int(connection['id'])}",
                "path": f"eq.{path}",
            },
            prefer="return=minimal",
        )
        if not response.ok:
            raise GitHubConnectorError(_response_message(response, f"Não foi possível remover {path}."))

    synced_at = _now_iso()
    _update_connection(
        int(connection["id"]),
        {
            "status": "active",
            "last_sync_sha": after,
            "last_sync_at": synced_at,
            "last_error": None,
        },
    )
    return {
        "files": len(files),
        "removed": len(removed),
        "commit_sha": after,
        "synced_at": synced_at,
        "mode": "incremental",
    }


def _record_delivery(delivery_id: str, event_name: str, repository: str, installation_id: int) -> bool:
    response = db(
        "POST",
        "github_webhook_deliveries",
        payload={
            "delivery_id": delivery_id,
            "event_name": event_name,
            "repository_full_name": repository,
            "installation_id": installation_id,
            "received_at": _now_iso(),
        },
        prefer="return=minimal",
    )
    if response.status_code == 409:
        return False
    if not response.ok:
        raise GitHubConnectorError(_response_message(response, "Não foi possível registrar o webhook."))
    return True


def _finish_delivery(delivery_id: str, status: str, error: str | None = None) -> None:
    db(
        "PATCH",
        "github_webhook_deliveries",
        params={"delivery_id": f"eq.{delivery_id}"},
        payload={"status": status, "error": error, "processed_at": _now_iso()},
        prefer="return=minimal",
    )


def _verify_webhook_signature(raw_body: bytes, signature: str) -> bool:
    secret = os.getenv("GITHUB_APP_WEBHOOK_SECRET", "").encode("utf-8")
    if not secret or not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def _redirect_manager(*, connected: bool = False, error: str | None = None):
    query: dict[str, str] = {}
    if connected:
        query["github"] = "connected"
    if error:
        query["github_error"] = error[:300]
    target = url_for("manager_page")
    return redirect(f"{target}?{urlencode(query)}" if query else target)


@github_api.post("/api/github/connect")
def start_github_connection():
    if not connector_configured():
        return jsonify({"error": "O conector GitHub ainda não foi configurado no servidor."}), 503
    body = json_body()
    try:
        project_id = int(body.get("project_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Projeto inválido."}), 400
    _, _, error = require_project(project_id, "admin")
    if error:
        return error
    try:
        repository = _normalize_repository(body.get("repository"))
        branch = _normalize_branch(body.get("branch"))
    except GitHubConnectorError as exc:
        return jsonify({"error": str(exc)}), 400
    state = _sign_state(
        {
            "project_id": project_id,
            "repository": repository,
            "branch": branch,
            "email": current_email(),
        }
    )
    slug = str(os.getenv("GITHUB_APP_SLUG", "")).strip()
    authorization_url = f"{GITHUB_WEB_URL}/apps/{quote(slug, safe='')}/installations/new?{urlencode({'state': state})}"
    return jsonify({"authorization_url": authorization_url})


@github_api.get("/github/callback")
def github_callback():
    if not connector_configured():
        return _redirect_manager(error="O conector GitHub não está configurado.")
    try:
        state = _verify_state(request.args.get("state", ""))
        installation_id = int(request.args.get("installation_id", ""))
        project_id = int(state["project_id"])
        project, role, role_response = get_project_role(project_id, str(state.get("email") or ""))
        if role_response is not None and not role_response.ok:
            raise GitHubConnectorError("Não foi possível validar a permissão do projeto.")
        if not project or ROLE_RANK.get(role or "", -1) < ROLE_RANK["admin"]:
            raise GitHubConnectorError("Você não possui mais permissão para conectar este projeto.")
        repository = _normalize_repository(state["repository"])
        requested_branch = _normalize_branch(state.get("branch"))
        token = _installation_token(installation_id, force=True)
        repository_response = _github_request(
            "GET",
            f"/repos/{_repo_path(repository)}",
            token=token,
        )
        repository_data = repository_response.json()
        branch = requested_branch or str(repository_data.get("default_branch") or "main")
        _github_request(
            "GET",
            f"/repos/{_repo_path(repository)}/branches/{quote(branch, safe='')}",
            token=token,
        )
        connection = _upsert_connection(
            {
                "project_id": project_id,
                "installation_id": installation_id,
                "repository_full_name": repository,
                "branch": branch,
                "status": "syncing",
                "last_error": None,
                "created_by_email": str(state.get("email") or ""),
            }
        )
        try:
            _full_sync(connection, token=token)
        except GitHubConnectorError as exc:
            _update_connection(int(connection["id"]), {"status": "error", "last_error": str(exc)})
            return _redirect_manager(error=f"GitHub conectado, mas a sincronização falhou: {exc}")
        return _redirect_manager(connected=True)
    except (GitHubConnectorError, TypeError, ValueError, KeyError) as exc:
        return _redirect_manager(error=str(exc) or "Não foi possível concluir a conexão com o GitHub.")


@github_api.get("/api/github/connection")
def github_connection():
    try:
        project_id = int(request.args.get("project_id", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "Projeto inválido."}), 400
    _, role, error = require_project(project_id, "viewer")
    if error:
        return error
    connection, response = _connection_for_project(project_id)
    if not response.ok:
        return api_error(response, "Erro ao consultar a conexão GitHub")
    files: list[dict[str, Any]] = []
    if connection:
        file_response = db(
            "GET",
            "github_template_files",
            params={
                "select": "id,path,name,blob_sha,commit_sha,size_bytes,synced_at",
                "github_connection_id": f"eq.{int(connection['id'])}",
                "order": "path.asc",
            },
        )
        if not file_response.ok:
            return api_error(file_response, "Erro ao listar os HTMLs do GitHub")
        files = file_response.json()
    return jsonify(
        {
            "configured": connector_configured(),
            "role": role,
            "connection": _public_connection(connection) if connection else None,
            "files": files,
            "limits": {
                "extensions": [".html"],
                "folder": "templates",
                "max_files": MAX_HTML_FILES,
                "max_file_bytes": MAX_HTML_FILE_BYTES,
                "max_total_bytes": MAX_TOTAL_HTML_BYTES,
            },
        }
    )


@github_api.post("/api/github/sync")
def sync_github_connection():
    body = json_body()
    try:
        project_id = int(body.get("project_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Projeto inválido."}), 400
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    connection, response = _connection_for_project(project_id)
    if not response.ok:
        return api_error(response, "Erro ao consultar a conexão GitHub")
    if not connection:
        return jsonify({"error": "Este projeto ainda não possui uma conexão GitHub."}), 404
    try:
        result = _full_sync(connection)
        return jsonify(result)
    except GitHubConnectorError as exc:
        _update_connection(int(connection["id"]), {"status": "error", "last_error": str(exc)})
        return jsonify({"error": str(exc)}), 502


@github_api.delete("/api/github/connection")
def delete_github_connection():
    body = json_body()
    try:
        project_id = int(body.get("project_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Projeto inválido."}), 400
    _, _, error = require_project(project_id, "admin")
    if error:
        return error
    connection, response = _connection_for_project(project_id)
    if not response.ok:
        return api_error(response, "Erro ao consultar a conexão GitHub")
    if not connection:
        return jsonify({"deleted": False})
    response = db(
        "DELETE",
        "github_connections",
        params={"id": f"eq.{int(connection['id'])}"},
        prefer="return=representation",
    )
    if not response.ok:
        return api_error(response, "Erro ao remover a conexão GitHub")
    return jsonify({"deleted": bool(response.json())})


@github_api.post("/webhooks/github")
def github_webhook():
    if not connector_configured():
        return jsonify({"error": "Conector não configurado."}), 503
    raw_body = request.get_data(cache=True)
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not _verify_webhook_signature(raw_body, signature):
        return jsonify({"error": "Assinatura inválida."}), 401
    event_name = request.headers.get("X-GitHub-Event", "")
    delivery_id = request.headers.get("X-GitHub-Delivery", "")
    payload = request.get_json(silent=True)
    if not delivery_id or not isinstance(payload, dict):
        return jsonify({"error": "Webhook inválido."}), 400
    if event_name == "ping":
        return jsonify({"status": "ok"})
    if event_name != "push":
        return jsonify({"status": "ignored", "event": event_name}), 202

    repository = str((payload.get("repository") or {}).get("full_name") or "")
    try:
        installation_id = int((payload.get("installation") or {}).get("id"))
    except (TypeError, ValueError):
        return jsonify({"error": "Instalação ausente no webhook."}), 400
    if not repository:
        return jsonify({"error": "Repositório ausente no webhook."}), 400

    try:
        if not _record_delivery(delivery_id, event_name, repository, installation_id):
            return jsonify({"status": "duplicate"}), 200
        response = db(
            "GET",
            "github_connections",
            params={
                "select": "*",
                "installation_id": f"eq.{installation_id}",
                "repository_full_name": f"eq.{repository}",
            },
        )
        if not response.ok:
            raise GitHubConnectorError(_response_message(response, "Não foi possível localizar a conexão."))
        connections = response.json()
        if not connections:
            _finish_delivery(delivery_id, "ignored")
            return jsonify({"status": "ignored", "reason": "repository_not_connected"}), 202

        pushed_ref = str(payload.get("ref") or "")
        token = _installation_token(installation_id)
        results = []
        for connection in connections:
            expected_ref = f"refs/heads/{connection['branch']}"
            if pushed_ref != expected_ref:
                results.append({"project_id": connection["project_id"], "status": "ignored_branch"})
                continue
            try:
                result = _incremental_sync(connection, payload, token)
                results.append({"project_id": connection["project_id"], **result})
            except GitHubConnectorError as exc:
                _update_connection(int(connection["id"]), {"status": "error", "last_error": str(exc)})
                results.append({"project_id": connection["project_id"], "error": str(exc)})
        failed = [item for item in results if item.get("error")]
        _finish_delivery(delivery_id, "error" if failed else "processed", json.dumps(failed) if failed else None)
        return jsonify({"status": "processed", "results": results}), 207 if failed else 200
    except GitHubConnectorError as exc:
        _finish_delivery(delivery_id, "error", str(exc))
        return jsonify({"error": str(exc)}), 502
