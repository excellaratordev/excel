from pathlib import Path
import subprocess


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_base_2_exposes_spreadsheet_source_panel() -> None:
    template = read("templates/base.html")
    script = read("static/js/treated-base-panel.js")
    styles = read("static/css/treated-base.css")

    assert 'id="treated-source-mode-button"' in template
    assert 'id="treated-source-panel"' in template
    assert 'id="treated-source-select"' in template
    assert 'id="treated-source-grid"' in template
    assert 'id="treated-source-sync"' in template
    assert "treated-base-panel.js" in template
    assert "treated-base.css" in template
    assert "/api/treated-bases/${workbookId}/binding" in script
    assert "pointerdown" in script and "pointermove" in script
    assert "ROW_PAGE = 120" in script and "COL_PAGE = 30" in script
    assert ".treated-base-workbook.treated-source-open .base-workspace" in styles


def test_base_2_keeps_column_record_and_cell_editing() -> None:
    template = read("templates/base.html")
    styles = read("static/css/treated-base-editing.css")
    app = read("app.py")

    assert 'id="add-column"' in template
    assert 'id="add-row"' in template
    assert "treated-base-editing.css" in template
    assert ".treated-base-workbook #add-column" in styles
    assert ".treated-base-workbook #add-row" in styles
    assert "display: inline-flex" in styles
    assert "pointer-events: auto" in styles
    assert "protect_materialized_treated_data" in app
    assert "callback.__name__ != \"protect_materialized_treated_data\"" in app


def test_base_2_mobile_layout_is_touch_first() -> None:
    template = read("templates/base.html")
    script = read("static/js/treated-base-panel.js")
    styles = read("static/css/treated-base.css")
    editing_styles = read("static/css/treated-base-editing.css")

    assert "No celular" in template
    assert 'id="treated-source-select-mode"' in template
    assert "matchMedia('(pointer: coarse)')" in script
    assert "touch-action: pan-x pan-y" in styles
    assert "touch-action: none" in styles
    assert "@media (max-width: 800px)" in styles
    assert "position: fixed" in styles
    assert "env(safe-area-inset-bottom)" in styles
    assert "min-height: 46px" in styles
    assert "@media (max-width: 640px)" in editing_styles
    assert "min-height: 42px" in editing_styles


def test_calculation_sheet_loads_treated_base_sync_client() -> None:
    template = read("templates/index.html")
    client = read("static/js/treated-base-source-sync.js")

    assert "treated-base-source-sync.js" in template
    assert "/api/treated-bases/sources/${workbookId}/dependencies" in client
    assert "/api/treated-bases/sources/${workbookId}/calculated-snapshot" in client
    assert "captureCalculatedCells" in client
    assert "superexcel:changes" in client


def test_new_javascript_files_have_valid_syntax() -> None:
    for path in (
        "static/js/treated-base-panel.js",
        "static/js/treated-base-source-sync.js",
    ):
        subprocess.run(["node", "--check", path], check=True, capture_output=True, text=True)
