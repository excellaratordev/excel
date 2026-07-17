from __future__ import annotations

from typing import Any

import backend
import snapshot_routes
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
        "user_metadata": {"full_name": "Usuário Teste"},
        "identities": [{"provider": "google"}],
    }
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (user, None))


def workbook(revision: int = 7) -> dict[str, Any]:
    return {"id": 21, "project_id": 4, "revision": revision, "name": "Financeiro"}


def test_returns_render_snapshot(monkeypatch):
    authorize(monkeypatch)
    monkeypatch.setattr(snapshot_routes, "get_workbook", lambda workbook_id: (workbook(), FakeResponse(200, [workbook()])))
    monkeypatch.setattr(snapshot_routes, "require_project", lambda project_id, role="viewer": ({"id": project_id}, "editor", None))

    def fake_db(method, table, **kwargs):
        assert method == "GET"
        assert table == "workbook_render_snapshots"
        return FakeResponse(200, [{
            "workbook_id": 21,
            "revision": 7,
            "payload": {"version": 1, "rows": 60, "cols": 26, "cells": []},
            "updated_at": "2026-07-17T00:00:00+00:00",
        }])

    monkeypatch.setattr(snapshot_routes, "db", fake_db)
    response = app.test_client().get(
        "/api/workbooks/21/render-snapshot",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["revision"] == 7
    assert body["current_revision"] == 7
    assert body["role"] == "editor"


def test_rejects_stale_render_snapshot(monkeypatch):
    authorize(monkeypatch)
    monkeypatch.setattr(snapshot_routes, "get_workbook", lambda workbook_id: (workbook(8), FakeResponse(200, [workbook(8)])))
    monkeypatch.setattr(snapshot_routes, "require_project", lambda project_id, role="viewer": ({"id": project_id}, "editor", None))

    response = app.test_client().post(
        "/api/workbooks/21/render-snapshot",
        headers={"Authorization": "Bearer valid-token"},
        json={
            "revision": 7,
            "payload": {"version": 1, "rows": 60, "cols": 26, "cells": []},
        },
    )

    assert response.status_code == 409
    assert response.get_json()["current_revision"] == 8
