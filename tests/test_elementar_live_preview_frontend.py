from pathlib import Path


def template() -> str:
    return Path("templates/index.html").read_text(encoding="utf-8")


def script() -> str:
    return Path("static/js/elementar-sheet.js").read_text(encoding="utf-8")


def stylesheet() -> str:
    return Path("static/css/elementar.css").read_text(encoding="utf-8")


def test_elementar_uses_live_json_side_panel() -> None:
    source = template()
    for control_id in (
        "elementar-live-panel",
        "elementar-live-state",
        "elementar-live-summary",
        "elementar-live-json",
        "elementar-live-refresh",
        "elementar-live-copy",
    ):
        assert f'id="{control_id}"' in source

    assert 'class="sheet-workspace"' in source
    assert 'class="sheet-editor-column"' in source
    assert 'id="elementar-preview-button"' not in source
    assert 'id="elementar-preview-dialog"' not in source


def test_live_json_is_recalculated_from_sheet_events() -> None:
    source = script()
    assert "LIVE_DEBOUNCE_MS" in source
    assert "LIVE_REFRESH_MS" in source
    assert "superexcel:changes" in source
    assert "superexcel:hydrated" in source
    assert "scheduleLivePreview" in source
    assert "refreshLivePreview" in source
    assert "renderLivePreview" in source
    assert "state.preview = preview" in source


def test_elementar_workspace_has_desktop_and_mobile_layouts() -> None:
    source = stylesheet()
    assert "body.elementar-workbook .sheet-workspace" in source
    assert "grid-template-columns:minmax(0,1fr) minmax(340px,36vw)" in source
    assert "elementar-live-panel" in source
    assert "@media(max-width:900px)" in source
