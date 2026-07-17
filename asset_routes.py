from __future__ import annotations

import hashlib
import os
from pathlib import Path
from threading import Lock

import requests
from flask import Blueprint, Response, current_app

assets_api = Blueprint("assets_api", __name__)

SUPABASE_JS_VERSION = "2.110.7"
SUPABASE_JS_SHA256 = "2697f51bb3efa5f10b5b0bca2a39b3772b1b8f810e6885e3bb8d69c3242d5e07"
SUPABASE_JS_URLS = (
    f"https://unpkg.com/@supabase/supabase-js@{SUPABASE_JS_VERSION}/dist/umd/supabase.js",
    f"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@{SUPABASE_JS_VERSION}/dist/umd/supabase.js",
)

_download_lock = Lock()
_memory_bundle: bytes | None = None


def _valid_bundle(content: bytes) -> bool:
    if hashlib.sha256(content).hexdigest() != SUPABASE_JS_SHA256:
        return False
    return b"createClient" in content and b"var supabase=" in content


def _local_candidates() -> tuple[Path, ...]:
    root = Path(current_app.root_path)
    return (
        root / "static" / "vendor" / "supabase.js",
        Path(os.getenv("SUPEREXCEL_ASSET_CACHE", "/tmp")) / f"supabase-{SUPABASE_JS_VERSION}.js",
    )


def _read_local_bundle() -> bytes | None:
    for path in _local_candidates():
        try:
            content = path.read_bytes()
        except OSError:
            continue
        if _valid_bundle(content):
            return content
    return None


def _download_bundle() -> bytes:
    errors: list[str] = []
    for url in SUPABASE_JS_URLS:
        try:
            response = requests.get(url, timeout=20)
            response.raise_for_status()
            content = response.content
            if not _valid_bundle(content):
                raise ValueError("conteúdo recebido não corresponde ao bundle fixado")
            cache_path = _local_candidates()[-1]
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = cache_path.with_suffix(".tmp")
                temporary.write_bytes(content)
                temporary.replace(cache_path)
            except OSError:
                current_app.logger.warning("Não foi possível gravar o cache do cliente Supabase.")
            return content
        except (requests.RequestException, ValueError) as error:
            errors.append(f"{url}: {error}")
    raise RuntimeError("; ".join(errors) or "nenhuma origem disponível")


def supabase_browser_bundle() -> bytes:
    global _memory_bundle
    if _memory_bundle is not None:
        return _memory_bundle
    with _download_lock:
        if _memory_bundle is not None:
            return _memory_bundle
        _memory_bundle = _read_local_bundle() or _download_bundle()
        return _memory_bundle


@assets_api.get("/assets/supabase-2.js")
def supabase_browser_client():
    try:
        content = supabase_browser_bundle()
    except RuntimeError as error:
        current_app.logger.exception("Falha ao disponibilizar o cliente Supabase: %s", error)
        script = (
            "window.__SUPEREXCEL_SUPABASE_LOAD_ERROR__="
            + repr("Não foi possível carregar a biblioteca de autenticação.")
            + ";console.error(window.__SUPEREXCEL_SUPABASE_LOAD_ERROR__);"
        )
        return Response(
            script,
            status=200,
            mimetype="application/javascript",
            headers={"Cache-Control": "no-store"},
        )

    return Response(
        content,
        mimetype="application/javascript",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )
