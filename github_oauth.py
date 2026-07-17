from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote, urlencode

import requests
from flask import Blueprint, redirect, request, url_for

import github_connector
from backend import ROLE_RANK, get_project_role

github_oauth_api = Blueprint("github_oauth_api", __name__)

OAUTH_REQUIRED_ENVIRONMENT = (
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_WEBHOOK_SECRET",
    "GITHUB_STATE_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
)


def connector_configured() -> bool:
    return all(str(os.getenv(name, "")).strip() for name in OAUTH_REQUIRED_ENVIRONMENT)


def install_secure_connector() -> None:
    """Make all existing connector routes use the stricter OAuth configuration check."""
    github_connector.connector_configured = connector_configured


def _oauth_callback_url() -> str:
    configured = str(os.getenv("GITHUB_OAUTH_CALLBACK_URL", "")).strip()
    return configured or url_for("github_api.github_callback", _external=True)


def _exchange_user_code(code: str, redirect_uri: str) -> str:
    try:
        response = requests.post(
            f"{github_connector.GITHUB_WEB_URL}/login/oauth/access_token",
            headers={
                "Accept": "application/json",
                "User-Agent": "Super-Excel-GitHub-Connector",
            },
            data={
                "client_id": str(os.getenv("GITHUB_CLIENT_ID", "")).strip(),
                "client_secret": str(os.getenv("GITHUB_CLIENT_SECRET", "")).strip(),
                "code": code,
                "redirect_uri": redirect_uri,
            },
            timeout=github_connector.REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise github_connector.GitHubConnectorError(
            "Não foi possível validar a autorização do GitHub."
        ) from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise github_connector.GitHubConnectorError(
            "O GitHub retornou uma autorização inválida."
        ) from exc

    token = str(payload.get("access_token") or "")
    if not response.ok or not token:
        message = str(payload.get("error_description") or payload.get("error") or "")
        raise github_connector.GitHubConnectorError(
            message or "O GitHub recusou a autorização do usuário."
        )
    return token


def _user_can_access_repository(user_token: str, installation_id: int, repository: str) -> bool:
    wanted = repository.casefold()
    page = 1
    while page <= 20:
        response = github_connector._github_request(
            "GET",
            f"/user/installations/{installation_id}/repositories",
            token=user_token,
            params={"per_page": 100, "page": page},
        )
        payload = response.json()
        repositories = payload.get("repositories") if isinstance(payload, dict) else []
        if not isinstance(repositories, list):
            repositories = []
        if any(
            str(item.get("full_name") or "").casefold() == wanted
            for item in repositories
            if isinstance(item, dict)
        ):
            return True
        total_count = (
            int(payload.get("total_count") or len(repositories))
            if isinstance(payload, dict)
            else len(repositories)
        )
        if page * 100 >= total_count or not repositories:
            return False
        page += 1
    return False


def _oauth_state(initial_state: dict[str, Any], installation_id: int) -> str:
    return github_connector._sign_state(
        {
            "phase": "oauth",
            "project_id": int(initial_state["project_id"]),
            "repository": github_connector._normalize_repository(initial_state["repository"]),
            "branch": github_connector._normalize_branch(initial_state.get("branch")),
            "email": str(initial_state.get("email") or ""),
            "installation_id": installation_id,
        }
    )


@github_oauth_api.get("/github/setup")
def github_setup():
    if not connector_configured():
        return github_connector._redirect_manager(error="O conector GitHub não está configurado.")
    try:
        initial_state = github_connector._verify_state(request.args.get("state", ""))
        installation_id = int(request.args.get("installation_id", ""))
        if installation_id <= 0:
            raise ValueError
        state = _oauth_state(initial_state, installation_id)
        callback_url = _oauth_callback_url()
        authorization_url = (
            f"{github_connector.GITHUB_WEB_URL}/login/oauth/authorize?"
            + urlencode(
                {
                    "client_id": str(os.getenv("GITHUB_CLIENT_ID", "")).strip(),
                    "redirect_uri": callback_url,
                    "state": state,
                }
            )
        )
        return redirect(authorization_url)
    except (github_connector.GitHubConnectorError, TypeError, ValueError, KeyError) as exc:
        return github_connector._redirect_manager(
            error=str(exc) or "Não foi possível validar a instalação do GitHub."
        )


def secure_github_callback():
    if not connector_configured():
        return github_connector._redirect_manager(error="O conector GitHub não está configurado.")
    try:
        state = github_connector._verify_state(request.args.get("state", ""))
        if state.get("phase") != "oauth":
            raise github_connector.GitHubConnectorError("Etapa de autorização inválida.")

        code = str(request.args.get("code") or "").strip()
        if not code:
            denied = str(
                request.args.get("error_description") or request.args.get("error") or ""
            ).strip()
            raise github_connector.GitHubConnectorError(
                denied or "A autorização do GitHub foi cancelada."
            )

        installation_id = int(state["installation_id"])
        project_id = int(state["project_id"])
        if installation_id <= 0:
            raise ValueError

        project, role, role_response = get_project_role(
            project_id,
            str(state.get("email") or ""),
        )
        if role_response is not None and not role_response.ok:
            raise github_connector.GitHubConnectorError(
                "Não foi possível validar a permissão do projeto."
            )
        if not project or ROLE_RANK.get(role or "", -1) < ROLE_RANK["admin"]:
            raise github_connector.GitHubConnectorError(
                "Você não possui mais permissão para conectar este projeto."
            )

        repository = github_connector._normalize_repository(state["repository"])
        requested_branch = github_connector._normalize_branch(state.get("branch"))
        callback_url = _oauth_callback_url()
        user_token = _exchange_user_code(code, callback_url)
        if not _user_can_access_repository(user_token, installation_id, repository):
            raise github_connector.GitHubConnectorError(
                "A instalação selecionada não pertence ao usuário ou não possui acesso ao repositório informado."
            )

        installation_token = github_connector._installation_token(installation_id, force=True)
        repository_response = github_connector._github_request(
            "GET",
            f"/repos/{github_connector._repo_path(repository)}",
            token=installation_token,
        )
        repository_data = repository_response.json()
        branch = requested_branch or str(repository_data.get("default_branch") or "main")
        github_connector._github_request(
            "GET",
            f"/repos/{github_connector._repo_path(repository)}/branches/{quote(branch, safe='')}",
            token=installation_token,
        )

        connection = github_connector._upsert_connection(
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
            github_connector._full_sync(connection, token=installation_token)
        except github_connector.GitHubConnectorError as exc:
            github_connector._update_connection(
                int(connection["id"]),
                {"status": "error", "last_error": str(exc)},
            )
            return github_connector._redirect_manager(
                error=f"GitHub conectado, mas a sincronização falhou: {exc}"
            )
        return github_connector._redirect_manager(connected=True)
    except (github_connector.GitHubConnectorError, TypeError, ValueError, KeyError) as exc:
        return github_connector._redirect_manager(
            error=str(exc) or "Não foi possível concluir a conexão com o GitHub."
        )
