from __future__ import annotations

from types import SimpleNamespace

from flask import Flask

import github_sites


def ok_response():
    return SimpleNamespace(ok=True, status_code=200)


def test_candidate_site_paths_resolve_html_routes():
    assert github_sites.candidate_site_paths("") == ["index.html"]
    assert github_sites.candidate_site_paths("sobre") == ["sobre.html", "sobre/index.html"]
    assert github_sites.candidate_site_paths("docs/") == ["docs/index.html"]
    assert github_sites.candidate_site_paths("painel.html") == ["painel.html"]
    assert github_sites.candidate_site_paths("../segredo.html") == []
    assert github_sites.candidate_site_paths("pasta\\pagina") == ["pasta/pagina.html", "pasta/pagina/index.html"]


def test_subdomain_url_and_host_detection(monkeypatch):
    monkeypatch.setenv("GITHUB_SITES_BASE_DOMAIN", "sites.superexcel.com.br")
    monkeypatch.setenv("GITHUB_SITES_SCHEME", "https")

    assert github_sites.public_site_url("frontend-12") == "https://frontend-12.sites.superexcel.com.br/"
    assert github_sites.public_site_url("frontend-12", "admin/index.html") == (
        "https://frontend-12.sites.superexcel.com.br/admin/index.html"
    )
    assert github_sites.site_slug_from_host("frontend-12.sites.superexcel.com.br") == "frontend-12"
    assert github_sites.site_slug_from_host("outro.dominio.com") is None
    assert github_sites.site_slug_from_host("x.y.sites.superexcel.com.br") is None


def install_published_file_stubs(monkeypatch):
    monkeypatch.setattr(
        github_sites,
        "_connection_for_slug",
        lambda slug: ({"id": 8, "status": "active", "site_enabled": True}, ok_response()),
    )
    monkeypatch.setattr(
        github_sites,
        "_resolve_site_file",
        lambda connection_id, path: (
            {
                "content": "<!doctype html><title>Publicado</title><h1>Olá</h1>",
                "blob_sha": "abc123",
                "commit_sha": "9" * 40,
            },
            ok_response(),
        ),
    )


def test_synced_html_is_served_with_isolation_headers(monkeypatch):
    install_published_file_stubs(monkeypatch)
    app = Flask(__name__)
    with app.test_request_context("/"):
        response = github_sites.serve_github_site("frontend-12", "")

    assert response.status_code == 200
    assert "Publicado" in response.get_data(as_text=True)
    assert response.content_type == "text/html; charset=utf-8"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert response.headers["X-SuperExcel-Source-Commit"] == "9" * 40
    assert "Content-Security-Policy" not in response.headers


def test_same_origin_preview_uses_opaque_sandbox(monkeypatch):
    install_published_file_stubs(monkeypatch)
    app = Flask(__name__)
    with app.test_request_context("/_sites/frontend-12/"):
        response = github_sites.serve_github_site("frontend-12", "", sandboxed=True)

    assert response.headers["Content-Security-Policy"] == github_sites.PREVIEW_SANDBOX_POLICY
    assert response.headers["X-SuperExcel-Preview"] == "sandboxed"
    assert response.headers["Cache-Control"] == "no-store"
    assert "allow-same-origin" not in response.headers["Content-Security-Policy"]


def test_host_dispatch_intercepts_only_configured_site_domain(monkeypatch):
    monkeypatch.setenv("GITHUB_SITES_BASE_DOMAIN", "sites.example.com")
    monkeypatch.setattr(
        github_sites,
        "serve_github_site",
        lambda slug, path, **kwargs: github_sites.Response(f"{slug}:{path}", content_type="text/plain"),
    )

    app = Flask(__name__)
    github_sites.install_github_site_hosting(app)

    @app.get("/")
    def main_page():
        return "painel"

    client = app.test_client()
    site_response = client.get("/dashboard", headers={"Host": "cliente-7.sites.example.com"})
    main_response = client.get("/", headers={"Host": "app.example.com"})

    assert site_response.get_data(as_text=True) == "cliente-7:dashboard"
    assert main_response.get_data(as_text=True) == "painel"
