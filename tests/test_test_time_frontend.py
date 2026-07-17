from pathlib import Path
import subprocess


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_test_time_is_loaded_in_all_four_pipeline_stages() -> None:
    base_template = read("templates/base.html")
    sheet_template = read("templates/index.html")
    app = read("app.py")

    for template in (base_template, sheet_template):
        assert "css/test-time.css" in template
        assert "js/test-time.js" in template

    assert "from test_time_unlimited import test_time_api" in app
    assert "app.register_blueprint(test_time_api)" in app


def test_test_time_client_supports_groups_exact_timestamps_and_cross_tab_updates() -> None:
    script = read("static/js/test-time.js")

    assert "performance.timeOrigin + performance.now()" in script
    assert "BroadcastChannel" in script
    assert "/api/test-time/workbooks/${workbookId}" in script
    assert "/api/test-time/groups/${group.id}/observe" in script
    assert "client_epoch_ms" in script
    assert "server_received_at" in script
    assert "changed_cells" in script
    assert "stage_number" in script
    assert "sampleBase" in script
    assert "sampleSheet" in script
    assert "sampleElementar" in script


def test_test_time_selection_works_for_base_sheet_and_mobile() -> None:
    script = read("static/js/test-time.js")
    styles = read("static/css/test-time.css")

    assert "base-grid-cell" in script
    assert "cell-address" in script
    assert "pointerdown" in script
    assert "pointermove" in script
    assert "test-time-selection-bar" in styles
    assert "@media (max-width: 700px)" in styles
    assert "env(safe-area-inset-bottom)" in styles
    assert "min-height: 46px" in styles


def test_test_time_javascript_has_valid_syntax() -> None:
    subprocess.run(
        ["node", "--check", "static/js/test-time.js"],
        check=True,
        capture_output=True,
        text=True,
    )
