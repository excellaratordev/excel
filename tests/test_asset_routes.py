from __future__ import annotations

import asset_routes
from app import app


def test_supabase_asset_is_served_from_memory(monkeypatch):
    bundle = b"var supabase={createClient:function(){}};"
    monkeypatch.setattr(asset_routes, "_memory_bundle", bundle)

    response = app.test_client().get("/assets/supabase-2.js")

    assert response.status_code == 200
    assert response.mimetype == "application/javascript"
    assert response.data == bundle
    assert "immutable" in response.headers["Cache-Control"]


def test_supabase_asset_returns_executable_error(monkeypatch):
    monkeypatch.setattr(asset_routes, "_memory_bundle", None)
    monkeypatch.setattr(
        asset_routes,
        "supabase_browser_bundle",
        lambda: (_ for _ in ()).throw(RuntimeError("indisponível")),
    )

    response = app.test_client().get("/assets/supabase-2.js")

    assert response.status_code == 200
    assert response.mimetype == "application/javascript"
    assert b"__SUPEREXCEL_SUPABASE_LOAD_ERROR__" in response.data
    assert response.headers["Cache-Control"] == "no-store"


def test_login_references_same_origin_asset():
    response = app.test_client().get("/login")

    assert response.status_code == 200
    assert b'/assets/supabase-2.js' in response.data
    assert b'static/vendor/supabase.js' not in response.data
