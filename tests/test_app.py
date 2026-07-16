from __future__ import annotations

from typing import Any

import app as app_module
import backend
import collaboration_routes
import projects_routes
import workbook_routes
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


def google_user(email: str = "usuario@gmail.com") -> dict[str, Any]:
    return {
        "id": "user-id",
        "email": email,
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "user_metadata": {"full_name": "Usuário Teste"},
        "identities": [{"provider": "google"}],
    }


def authorize(monkeypatch, email: str = "usuario@gmail.com") -> None:
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (google_user(email), None))


def test_health(monkeypatch):
    monkeypatch.setattr(app_module, "configured", lambda: True)
    monkeypatch.setattr(app_module, "db", lambda *args, **kwargs: FakeResponse(200, []))

    response = app.test_client().get("/api/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "database": "supabase"}


def test_protected_api_requires_login():
    response = app.test_client().get("/api/projects")

    assert response.status_code == 401
    assert "login" in response.get_json()["error"].lower()


def test_create_shared_project(monkeypatch):
    authorize(monkeypatch)
    created = {
        "id": 7,
        "name": "Projeto Comercial",
        "owner_email": "usuario@gmail.com",
        "created_at": "2026-07-15T00:00:00+00:00",
        "updated_at": "2026-07-15T00:00:00+00:00",
    }
    monkeypatch.setattr(
        projects_routes,
        "insert_one",
        lambda table, payload: (created.copy(), FakeResponse(201, [created.copy()])),
    )
    monkeypatch.setattr(projects_routes, "ensure_owner_membership", lambda project: None)

    response = app.test_client().post(
        "/api/projects",
        headers={"Authorization": "Bearer valid-token"},
        json={"name": "Projeto Comercial"},
    )

    assert response.status_code == 200
    assert response.get_json()["id"] == 7
    assert response.get_json()["role"] == "owner"


def test_rejects_stale_workbook_revision(monkeypatch):
    authorize(monkeypatch)
    current = {
        "id": 11,
        "name": "Orçamento",
        "project_id": 3,
        "folder_id": None,
        "revision": 4,
        "payload": {"version": 1, "name": "Orçamento", "rows": 1, "cols": 1, "cells": [[100]]},
        "created_at": "2026-07-15T00:00:00+00:00",
        "updated_at": "2026-07-15T01:00:00+00:00",
        "created_by_email": "usuario@gmail.com",
        "updated_by_email": "outra.pessoa@gmail.com",
    }
    monkeypatch.setattr(
        workbook_routes,
        "get_workbook",
        lambda workbook_id, include_payload=False: (current.copy(), FakeResponse(200, [current.copy()])),
    )
    monkeypatch.setattr(
        workbook_routes,
        "require_project",
        lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None),
    )

    response = app.test_client().post(
        "/api/workbooks",
        headers={"Authorization": "Bearer valid-token"},
        json={
            "id": 11,
            "name": "Orçamento",
            "base_revision": 3,
            "data": {"version": 1, "name": "Orçamento", "rows": 1, "cols": 1, "cells": [[200]]},
        },
    )

    assert response.status_code == 409
    body = response.get_json()
    assert body["conflict"] is True
    assert body["current"]["revision"] == 4
    assert body["current"]["data"]["cells"] == [[100]]


def test_applies_idempotent_operation(monkeypatch):
    authorize(monkeypatch)
    workbook = {
        "id": 15,
        "name": "Compartilhada",
        "project_id": 4,
        "folder_id": None,
        "revision": 8,
    }
    monkeypatch.setattr(
        collaboration_routes,
        "get_workbook",
        lambda workbook_id, include_payload=False: (workbook.copy(), FakeResponse(200, [workbook.copy()])),
    )
    monkeypatch.setattr(
        collaboration_routes,
        "require_project",
        lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None),
    )

    def fake_db(method, table, **kwargs):
        assert method == "POST"
        assert table == "rpc/apply_workbook_operation"
        payload = kwargs["payload"]
        assert payload["p_op_id"] == "8f0fe1ce-b32f-4a58-a4c1-8da7f5f3db4e"
        assert payload["p_changes"] == [{"row": 2, "col": 1, "value": 450}]
        return FakeResponse(200, [{
            "workbook_id": 15,
            "op_id": payload["p_op_id"],
            "revision": 9,
            "duplicate": False,
        }])

    monkeypatch.setattr(collaboration_routes, "db", fake_db)

    response = app.test_client().post(
        "/api/workbooks/15/operations",
        headers={"Authorization": "Bearer valid-token"},
        json={
            "operations": [{
                "op_id": "8f0fe1ce-b32f-4a58-a4c1-8da7f5f3db4e",
                "workbook_id": 15,
                "client_id": "device:tab",
                "client_seq": 1,
                "known_revision": 8,
                "kind": "cells.edit",
                "changes": [{"row": 2, "col": 1, "value": 450}],
            }],
        },
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["current_revision"] == 9
    assert body["results"][0]["duplicate"] is False


def test_rejects_operation_without_valid_uuid(monkeypatch):
    authorize(monkeypatch)
    workbook = {"id": 15, "name": "Compartilhada", "project_id": 4, "revision": 8}
    monkeypatch.setattr(
        collaboration_routes,
        "get_workbook",
        lambda workbook_id, include_payload=False: (workbook.copy(), FakeResponse(200, [workbook.copy()])),
    )
    monkeypatch.setattr(
        collaboration_routes,
        "require_project",
        lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None),
    )

    response = app.test_client().post(
        "/api/workbooks/15/operations",
        headers={"Authorization": "Bearer valid-token"},
        json={
            "operations": [{
                "op_id": "invalido",
                "workbook_id": 15,
                "client_id": "device:tab",
                "changes": [],
            }],
        },
    )

    assert response.status_code == 400
    assert "identificador" in response.get_json()["error"].lower()
