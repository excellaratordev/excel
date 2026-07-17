from __future__ import annotations

from typing import Any

import backend
import elementar_routes
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


def google_user() -> dict[str, Any]:
    return {"id": "user-id", "email": "usuario@gmail.com", "app_metadata": {"provider": "google", "providers": ["google"]}, "identities": [{"provider": "google"}]}


def test_slugify_and_reference_validation():
    assert elementar_routes.slugify("Pedidos em Produção") == "pedidos-em-producao"
    refs, error = elementar_routes.normalize_refs([{"key": "pedidos", "workbook_name": "Pedidos", "range": "$A$1:$D$100", "cell": "A2"}])
    assert error is None
    assert refs[0]["range"] == "$A$1:$D$100"
    _, error = elementar_routes.normalize_refs([
        {"key": "pedidos", "workbook_name": "A", "range": "A1"},
        {"key": "pedidos", "workbook_name": "B", "range": "B1"},
    ])
    assert "mais de uma vez" in error


def test_enable_elementar_creates_private_config(monkeypatch):
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (google_user(), None))
    workbook = {
        "id": 12,
        "name": "API Comercial",
        "project_id": 4,
        "revision": 1,
        "file_kind": "elementar",
        "pipeline_stage": "publication",
    }
    monkeypatch.setattr(elementar_routes, "get_workbook", lambda workbook_id, include_payload=False: (workbook.copy(), FakeResponse(200, [workbook.copy()])))
    monkeypatch.setattr(elementar_routes, "require_project", lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None))
    monkeypatch.setattr(elementar_routes, "fetch_one", lambda table, params: (None, FakeResponse(200, [])))

    def fake_db(method, table, **kwargs):
        payload = kwargs["payload"]
        assert method == "POST" and table == "elementar_configs"
        assert payload["slug"] == "api-comercial-12" and payload["visibility"] == "private"
        return FakeResponse(201, [{**payload, "last_publication_id": None, "last_publication_version": 0}])

    monkeypatch.setattr(elementar_routes, "db", fake_db)
    response = app.test_client().post("/api/elementar/workbooks/12/enable", headers={"Authorization": "Bearer token"}, json={})
    assert response.status_code == 200
    assert response.get_json()["authenticated_endpoint"] == "/api/elementar/data/api-comercial-12"


def test_regular_spreadsheet_cannot_be_converted_to_elementar(monkeypatch):
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (google_user(), None))
    workbook = {
        "id": 15,
        "name": "Cálculo",
        "project_id": 4,
        "revision": 1,
        "file_kind": "spreadsheet",
        "pipeline_stage": "calculation",
    }
    monkeypatch.setattr(elementar_routes, "get_workbook", lambda workbook_id, include_payload=False: (workbook.copy(), FakeResponse(200, [workbook.copy()])))
    monkeypatch.setattr(elementar_routes, "require_project", lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None))
    response = app.test_client().post("/api/elementar/workbooks/15/enable", headers={"Authorization": "Bearer token"}, json={})
    assert response.status_code == 409
    assert "etapa 4" in response.get_json()["error"]


def test_public_endpoint_returns_json_and_cache_headers(monkeypatch):
    config = {"workbook_id": 12, "project_id": 4, "visibility": "public", "public_token": "token-publico", "last_publication_id": 99}
    publication = {"id": 99, "version": 3, "payload": {"pedidos": [{"numero": 1001}]}, "created_at": "2026-07-17T00:00:00+00:00"}

    def fake_fetch_one(table, params):
        return (config.copy(), FakeResponse(200, [config.copy()])) if table == "elementar_configs" else (publication.copy(), FakeResponse(200, [publication.copy()]))

    monkeypatch.setattr(elementar_routes, "fetch_one", fake_fetch_one)
    response = app.test_client().get("/public/elementar/token-publico")
    assert response.status_code == 200
    assert response.get_json() == publication["payload"]
    assert response.headers["Access-Control-Allow-Origin"] == "*"
    assert response.headers["X-Elementar-Version"] == "3"
    assert response.headers["ETag"] == '"elementar-12-3"'

    response = app.test_client().get("/public/elementar/token-publico", headers={"If-None-Match": '"elementar-12-3"'})
    assert response.status_code == 304
