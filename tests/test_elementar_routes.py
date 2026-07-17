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


def google_user(email: str = "usuario@gmail.com") -> dict[str, Any]:
    return {
        "id": "user-id",
        "email": email,
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "identities": [{"provider": "google"}],
    }


def authorize(monkeypatch) -> None:
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (google_user(), None))


def test_slugify_is_stable_and_url_safe():
    assert elementar_routes.slugify("Pedidos em Produção") == "pedidos-em-producao"
    assert elementar_routes.slugify("  ") == "elementar"


def test_normalize_elementar_references():
    references, error = elementar_routes.normalize_refs([
        {
            "key": "pedidos",
            "workbook_name": "Planilha de Pedidos",
            "range": "$A$1:$D$100",
            "cell": "A2",
        }
    ])

    assert error is None
    assert references == [{
        "key": "pedidos",
        "workbook_name": "Planilha de Pedidos",
        "range": "$A$1:$D$100",
        "cell": "A2",
    }]


def test_rejects_duplicate_element_names():
    _, error = elementar_routes.normalize_refs([
        {"key": "pedidos", "workbook_name": "A", "range": "A1", "cell": "A1"},
        {"key": "pedidos", "workbook_name": "B", "range": "B1", "cell": "A2"},
    ])

    assert "mais de uma vez" in error


def test_enable_elementar_creates_private_config(monkeypatch):
    authorize(monkeypatch)
    workbook = {"id": 12, "name": "API Comercial", "project_id": 4, "revision": 1}
    monkeypatch.setattr(
        elementar_routes,
        "get_workbook",
        lambda workbook_id, include_payload=False: (workbook.copy(), FakeResponse(200, [workbook.copy()])),
    )
    monkeypatch.setattr(
        elementar_routes,
        "require_project",
        lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None),
    )
    monkeypatch.setattr(
        elementar_routes,
        "fetch_one",
        lambda table, params: (None, FakeResponse(200, [])),
    )

    def fake_db(method, table, **kwargs):
        assert method == "POST"
        assert table == "elementar_configs"
        payload = kwargs["payload"]
        assert payload["slug"] == "api-comercial-12"
        assert payload["visibility"] == "private"
        return FakeResponse(201, [{
            **payload,
            "last_publication_id": None,
            "last_publication_version": 0,
            "created_at": "2026-07-17T00:00:00+00:00",
            "updated_at": "2026-07-17T00:00:00+00:00",
        }])

    monkeypatch.setattr(elementar_routes, "db", fake_db)
    response = app.test_client().post(
        "/api/elementar/workbooks/12/enable",
        headers={"Authorization": "Bearer valid-token"},
        json={},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["slug"] == "api-comercial-12"
    assert body["visibility"] == "private"
    assert body["authenticated_endpoint"] == "/api/elementar/data/api-comercial-12"


def test_public_elementar_returns_raw_json_with_cache_headers(monkeypatch):
    config = {
        "workbook_id": 12,
        "project_id": 4,
        "visibility": "public",
        "public_token": "token-publico",
        "last_publication_id": 99,
    }
    publication = {
        "id": 99,
        "version": 3,
        "payload": {"pedidos": [{"numero": 1001}]},
        "created_at": "2026-07-17T00:00:00+00:00",
    }

    def fake_fetch_one(table, params):
        if table == "elementar_configs":
            return config.copy(), FakeResponse(200, [config.copy()])
        if table == "elementar_publications":
            return publication.copy(), FakeResponse(200, [publication.copy()])
        raise AssertionError(table)

    monkeypatch.setattr(elementar_routes, "fetch_one", fake_fetch_one)
    response = app.test_client().get("/public/elementar/token-publico")

    assert response.status_code == 200
    assert response.get_json() == {"pedidos": [{"numero": 1001}]}
    assert response.headers["Access-Control-Allow-Origin"] == "*"
    assert response.headers["X-Elementar-Version"] == "3"
    assert response.headers["ETag"] == '"elementar-12-3"'


def test_public_elementar_supports_conditional_request(monkeypatch):
    config = {
        "workbook_id": 12,
        "project_id": 4,
        "visibility": "public",
        "public_token": "token-publico",
        "last_publication_id": 99,
    }
    publication = {"id": 99, "version": 3, "payload": {"ok": True}, "created_at": None}

    def fake_fetch_one(table, params):
        return (config.copy(), FakeResponse(200, [config.copy()])) if table == "elementar_configs" else (
            publication.copy(), FakeResponse(200, [publication.copy()])
        )

    monkeypatch.setattr(elementar_routes, "fetch_one", fake_fetch_one)
    response = app.test_client().get(
        "/public/elementar/token-publico",
        headers={"If-None-Match": '"elementar-12-3"'},
    )

    assert response.status_code == 304
    assert response.headers["Access-Control-Allow-Origin"] == "*"
