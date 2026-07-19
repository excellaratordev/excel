from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_test_time_is_idle_until_opened():
    content = source("static/js/test-time.js")
    assert "STATE_POLL_MS = 700" not in content
    assert "Nenhuma consulta é feita até o usuário abrir" in content
    assert "updateStatePolling" in content


def test_base_reference_does_not_open_or_fetch_automatically():
    content = source("static/js/base-reference-panel.js")
    assert "async function ensureSourcesLoaded()" in content
    assert "panel.hidden = true;" in content
    assert "setPanelOpen(false);" in content
    assert "setPanelOpen(true);" not in content


def test_auxiliary_modules_start_after_first_paint():
    assert "requestIdleCallback" in source("static/js/elementar-source-sync.js")
    assert "waitForIdle" in source("static/js/elementar-sheet.js")
    assert "requestIdleCallback(startMemoryMonitor" in source("static/js/performance-telemetry.js")
    assert "scheduleBackgroundInitialize" in source("static/js/treated-base-formulas.js")


def test_bootstrap_paints_cached_cells_before_remote_roundtrips():
    content = source("static/js/sheet-bootstrap-v2.js")
    assert "const authReady = Promise.resolve(window.SuperExcelAuth.ready)" in content
    assert "superexcel:first-paint" in content
    assert "cells: Array.isArray(renderSnapshot?.cells)" in content
    assert "await authReady;" in content


def test_static_scripts_download_in_parallel_and_keep_order():
    content = source("templates/base.html")
    tail = content.split("assets_api.supabase_browser_client", 1)[1]
    external_scripts = [line for line in tail.splitlines() if "<script" in line and "src=" in line]
    assert external_scripts
    assert all(" defer" in line for line in external_scripts)
