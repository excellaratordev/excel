from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import backend
import github_connector
from app import app


class FakeResponse:
    def __init__(self, status_code: int, payload: Any):
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> Any:
        return self._payload


def authorize(monkeypatch) -> None:
    user = {
        "id": "user-id",
        "email": "usuario@gmail.com",
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "identities": [{"provider": "google"}],
    }
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (user, None))


def test_accepts_only_html_inside_templates():
    assert github_connector._is_template_html("templates/index.html")
    assert github_connector._is_template_html("src/site/templates/admin/dashboard.HTML")
    assert not github_connector._is_template_html("index.html")
    assert not github_connector._is_template_html("templates/app.js")
    assert not github_connector._is_template_html("../templates/index.html")


def test_push_paths_collects_all_commits():
    changed, removed, incomplete = github_connector._push_paths(
        {
            "size": 2,
            "commits": [
                {
                    "added": ["templates/new.html"],
                    "modified": ["templates/base.html"],
                    "removed": [],
                },
                {
                    "added": [],
                    "modified": ["README.md"],
                    "removed": ["templates/old.html"],
                },
            ],
        }
    )

    assert changed == {"templates/new.html", "templates/base.html", "README.md"}
    assert removed == {"templates/old.html"}
    assert incomplete is False


def test_starts_github_app_installation(monkeypatch):
    authorize(monkeypatch)
    monkeypatch.setenv("GITHUB_APP_SLUG", "super-excel")
    monkeypatch.setenv("GITHUB_STATE_SECRET", "test-state-secret")
    monkeypatch.setattr(github_connector, "connector_configured", lambda: True)
    monkeypatch.setattr(
        github_connector,
        "require_project",
        lambda project_id, role="viewer": ({"id": project_id}, "owner", None),
    )

    response = app.test_client().post(
        "/api/github/connect",
        headers={"Authorization": "Bearer valid-token"},
        json={
            "project_id": 7,
            "repository": "cliente/sistema",
            "branch": "main",
        },
    )

    assert response.status_code == 200
    authorization_url = response.get_json()["authorization_url"]
    assert authorization_url.startswith("https://github.com/apps/super-excel/installations/new?")
    assert "state=" in authorization_url


def test_webhook_rejects_invalid_signature(monkeypatch):
    monkeypatch.setattr(github_connector, "connector_configured", lambda: True)
    monkeypatch.setenv("GITHUB_APP_WEBHOOK_SECRET", "webhook-secret")

    response = app.test_client().post(
        "/webhooks/github",
        headers={
            "X-GitHub-Event": "push",
            "X-GitHub-Delivery": "delivery-1",
            "X-Hub-Signature-256": "sha256=invalid",
        },
        json={"repository": {"full_name": "cliente/sistema"}, "installation": {"id": 9}},
    )

    assert response.status_code == 401


def test_webhook_ignores_repository_without_connection(monkeypatch):
    monkeypatch.setattr(github_connector, "connector_configured", lambda: True)
    monkeypatch.setenv("GITHUB_APP_WEBHOOK_SECRET", "webhook-secret")
    monkeypatch.setattr(github_connector, "_record_delivery", lambda *args: True)
    monkeypatch.setattr(github_connector, "_finish_delivery", lambda *args: None)
    monkeypatch.setattr(github_connector, "db", lambda *args, **kwargs: FakeResponse(200, []))

    payload = {
        "ref": "refs/heads/main",
        "repository": {"full_name": "cliente/sistema"},
        "installation": {"id": 9},
        "commits": [],
    }
    raw = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()

    response = app.test_client().post(
        "/webhooks/github",
        headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": "push",
            "X-GitHub-Delivery": "delivery-2",
            "X-Hub-Signature-256": f"sha256={signature}",
        },
        data=raw,
    )

    assert response.status_code == 202
    assert response.get_json()["reason"] == "repository_not_connected"
