from __future__ import annotations

from typing import Any

import app as app_module
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


def test_health(monkeypatch):
    monkeypatch.setattr(app_module, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(app_module, "SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setattr(
        app_module,
        "supabase_request",
        lambda *args, **kwargs: FakeResponse(200, []),
    )

    client = app.test_client()
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    assert response.get_json()["database"] == "supabase"


def test_health_without_configuration(monkeypatch):
    monkeypatch.setattr(app_module, "SUPABASE_URL", "")
    monkeypatch.setattr(app_module, "SUPABASE_SECRET_KEY", "")

    client = app.test_client()
    response = client.get("/api/health")

    assert response.status_code == 503
    assert response.get_json()["configured"] is False


def test_workbook_crud(monkeypatch):
    monkeypatch.setattr(app_module, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(app_module, "SUPABASE_SECRET_KEY", "secret")

    def fake_request(method: str, path: str, **kwargs: Any) -> FakeResponse:
        if method == "POST":
            return FakeResponse(
                201,
                [
                    {
                        "id": 1,
                        "name": "Teste",
                        "payload": {"version": 1, "cells": [[1, "=SOMA(A1:A1)"]]},
                        "created_at": "2026-07-15T00:00:00+00:00",
                        "updated_at": "2026-07-15T00:00:00+00:00",
                    }
                ],
            )
        if method == "GET" and kwargs.get("params", {}).get("id") == "eq.1":
            return FakeResponse(
                200,
                [
                    {
                        "id": 1,
                        "name": "Teste",
                        "payload": {"version": 1, "cells": [[1, "=SOMA(A1:A1)"]]},
                        "created_at": "2026-07-15T00:00:00+00:00",
                        "updated_at": "2026-07-15T00:00:00+00:00",
                    }
                ],
            )
        if method == "DELETE":
            return FakeResponse(200, [{"id": 1}])
        return FakeResponse(200, [])

    monkeypatch.setattr(app_module, "supabase_request", fake_request)

    client = app.test_client()
    created = client.post(
        "/api/workbooks",
        json={
            "name": "Teste",
            "data": {"version": 1, "cells": [[1, "=SOMA(A1:A1)"]]},
        },
    )
    assert created.status_code == 200
    workbook_id = created.get_json()["id"]

    loaded = client.get(f"/api/workbooks/{workbook_id}")
    assert loaded.status_code == 200
    assert loaded.get_json()["data"]["cells"][0][0] == 1

    deleted = client.delete(f"/api/workbooks/{workbook_id}")
    assert deleted.status_code == 200
