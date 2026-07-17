from __future__ import annotations

from typing import Any

import backend
import base_reference_routes
from app import app


class FakeResponse:
    def __init__(self, status_code: int, payload: Any, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> Any:
        return self._payload


def google_user() -> dict[str, Any]:
    return {
        "id": "user-id",
        "email": "usuario@gmail.com",
        "app_metadata": {"provider": "google", "providers": ["google"]},
        "identities": [{"provider": "google"}],
    }


def calculation_workbook() -> dict[str, Any]:
    return {
        "id": 20,
        "name": "Cálculo",
        "project_id": 4,
        "revision": 3,
        "file_kind": "spreadsheet",
        "pipeline_stage": "calculation",
    }


def source_base() -> dict[str, Any]:
    return {
        "id": 10,
        "name": "Clientes",
        "project_id": 4,
        "revision": 7,
        "file_kind": "base",
        "pipeline_stage": "source",
        "updated_at": "2026-07-17T10:00:00+00:00",
    }


def configure_auth(monkeypatch):
    monkeypatch.setattr(backend, "verify_user_token", lambda token: (google_user(), None))
    monkeypatch.setattr(
        base_reference_routes,
        "require_project",
        lambda project_id, minimum_role="viewer": ({"id": project_id}, "editor", None),
    )


def test_parse_cell_uses_excel_coordinates():
    assert base_reference_routes.parse_cell("A1") == (0, 0)
    assert base_reference_routes.parse_cell("$AA$12") == (11, 26)


def test_lists_only_project_source_bases_and_marks_dependencies(monkeypatch):
    configure_auth(monkeypatch)
    target = calculation_workbook()
    source = source_base()
    monkeypatch.setattr(
        base_reference_routes,
        "get_workbook",
        lambda workbook_id: (target.copy(), FakeResponse(200, [target.copy()])),
    )

    def fake_db(method, table, **kwargs):
        if table == "workbooks":
            assert kwargs["params"]["pipeline_stage"] == "eq.source"
            return FakeResponse(200, [source.copy()])
        if table == "file_dependencies":
            return FakeResponse(200, [{"source_workbook_id": source["id"]}])
        raise AssertionError(table)

    monkeypatch.setattr(base_reference_routes, "db", fake_db)
    response = app.test_client().get(
        "/api/workbooks/20/base-sources",
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["sources"] == [{
        "id": 10,
        "name": "Clientes",
        "revision": 7,
        "updated_at": "2026-07-17T10:00:00+00:00",
        "updated_by_email": None,
        "linked": True,
    }]


def test_materializes_only_requested_base_range(monkeypatch):
    configure_auth(monkeypatch)
    target = calculation_workbook()
    source = source_base()
    monkeypatch.setattr(
        base_reference_routes,
        "get_workbook",
        lambda workbook_id: (target.copy(), FakeResponse(200, [target.copy()])),
    )

    columns = [
        {"column_key": "nome", "name": "Nome", "position": 0, "data_type": "text"},
        {"column_key": "limite", "name": "Limite", "position": 1, "data_type": "number"},
    ]
    monkeypatch.setattr(
        base_reference_routes,
        "list_columns",
        lambda workbook_id: (columns, FakeResponse(200, columns)),
    )

    def fake_db(method, table, **kwargs):
        if table == "workbooks":
            return FakeResponse(200, [source.copy()])
        if table == "base_rows":
            assert kwargs["params"]["offset"] == "0"
            assert kwargs["params"]["limit"] == "2"
            return FakeResponse(200, [
                {"row_order": 0, "values": {"nome": "Ana", "limite": 100}},
                {"row_order": 1, "values": {"nome": "Bruno", "limite": 250}},
            ])
        raise AssertionError(table)

    monkeypatch.setattr(base_reference_routes, "db", fake_db)
    response = app.test_client().post(
        "/api/workbooks/20/base-reference-values",
        headers={"Authorization": "Bearer token"},
        json={"references": [{"source": "Clientes", "start": "A1", "end": "B2"}]},
    )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["cell_count"] == 4
    assert payload["sources"][0]["cells"] == [
        {"r": 0, "c": 0, "v": "Ana"},
        {"r": 0, "c": 1, "v": 100},
        {"r": 1, "c": 0, "v": "Bruno"},
        {"r": 1, "c": 1, "v": 250},
    ]


def test_rejects_base_panel_for_non_calculation_files(monkeypatch):
    configure_auth(monkeypatch)
    workbook = {
        "id": 30,
        "name": "Publicação",
        "project_id": 4,
        "file_kind": "elementar",
        "pipeline_stage": "publication",
    }
    monkeypatch.setattr(
        base_reference_routes,
        "get_workbook",
        lambda workbook_id: (workbook.copy(), FakeResponse(200, [workbook.copy()])),
    )
    response = app.test_client().get(
        "/api/workbooks/30/base-sources",
        headers={"Authorization": "Bearer token"},
    )
    assert response.status_code == 409
