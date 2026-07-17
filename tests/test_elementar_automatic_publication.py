from __future__ import annotations

from types import SimpleNamespace

from flask import Response

import elementar_automation_routes as automation
from elementar_automation_values import get_nested
from elementar_realtime_delivery import install as install_realtime_delivery


def test_range_parser_and_selective_intersection() -> None:
    bounds = automation.parse_range("$B$2:D10")
    assert bounds == {
        "top_row": 1,
        "bottom_row": 9,
        "left_col": 1,
        "right_col": 3,
    }
    dependency = bounds
    assert automation.cell_hits_dependency({"row": 1, "col": 1}, dependency)
    assert automation.cell_hits_dependency({"row": 9, "col": 3}, dependency)
    assert not automation.cell_hits_dependency({"row": 0, "col": 1}, dependency)
    assert not automation.cell_hits_dependency({"row": 5, "col": 4}, dependency)


def test_matrix_conversion_matches_elementar_contract() -> None:
    assert automation.matrix_to_json([[42]]) == 42
    assert automation.matrix_to_json([[1, 2, None, ""]]) == [1, 2]
    assert automation.matrix_to_json([["A"], ["B"], [None]]) == ["A", "B"]
    assert automation.matrix_to_json([
        ["nome", "valor"],
        ["Porta", 1200],
        ["Vidro", 300],
        [None, None],
    ]) == [
        {"nome": "Porta", "valor": 1200},
        {"nome": "Vidro", "valor": 300},
    ]


def test_nested_payload_and_hash_are_deterministic() -> None:
    payload: dict = {}
    automation.set_nested(payload, "dashboard.vendas.total", 1500)
    automation.set_nested(payload, "dashboard.vendas.quantidade", 3)
    assert get_nested(payload, "dashboard.vendas.total") == (True, 1500)
    assert get_nested(payload, "dashboard.inexistente") == (False, None)
    assert automation.content_hash({"b": 2, "a": 1}) == automation.content_hash({"a": 1, "b": 2})


def test_calculated_snapshot_normalization_is_sparse_and_deduplicated() -> None:
    cells, error = automation.normalize_cells([
        {"r": 1, "c": 2, "v": 10},
        {"r": 1, "c": 2, "v": 20, "t": "NUMBER"},
        {"r": 3, "c": 4, "v": "Pago"},
    ])
    assert error is None
    assert cells == [
        {"r": 1, "c": 2, "v": 20, "t": "NUMBER"},
        {"r": 3, "c": 4, "v": "Pago"},
    ]


def test_hosted_html_receives_etag_watcher_and_elementar_cache_is_short() -> None:
    elementar = SimpleNamespace()
    github_sites = SimpleNamespace()

    def original_serve(_config):
        response = Response('{"ok":true}', content_type="application/json")
        response.headers["Cache-Control"] = "public, max-age=30"
        return response

    def original_site_response(_file_row, *, sandboxed=False):
        return Response(
            "<!doctype html><html><body><script>fetch('/public/elementar/token')</script></body></html>",
            content_type="text/html; charset=utf-8",
        )

    elementar.serve = original_serve
    github_sites._site_response = original_site_response
    install_realtime_delivery(elementar, github_sites)

    endpoint = elementar.serve({})
    assert "max-age=1" in endpoint.headers["Cache-Control"]
    assert "must-revalidate" in endpoint.headers["Cache-Control"]

    hosted = github_sites._site_response({}, sandboxed=False)
    html = hosted.get_data(as_text=True)
    assert "__superexcelElementarWatchInstalled" in html
    assert "If-None-Match" in html
    assert "superexcel:elementar-update" in html
    assert "location.reload()" in html

    preview = github_sites._site_response({}, sandboxed=True)
    assert "__superexcelElementarWatchInstalled" not in preview.get_data(as_text=True)
