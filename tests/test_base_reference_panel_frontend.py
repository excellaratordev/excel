from pathlib import Path


def template() -> str:
    return Path("templates/index.html").read_text(encoding="utf-8")


def panel_script() -> str:
    return Path("static/js/base-reference-panel.js").read_text(encoding="utf-8")


def focus_bridge_script() -> str:
    return Path("static/js/base-reference-focus-bridge.js").read_text(encoding="utf-8")


def runtime_script() -> str:
    return Path("static/js/calculation/external-reference-runtime.js").read_text(encoding="utf-8")


def test_calculation_workspace_contains_base_reference_panel() -> None:
    source = template()
    for control_id in (
        "base-reference-mode-button",
        "base-reference-panel",
        "base-reference-select",
        "base-reference-refresh",
        "base-reference-open-file",
        "base-reference-grid",
        "base-reference-canvas",
        "base-reference-selection",
    ):
        assert f'id="{control_id}"' in source
    assert "css/base-reference-panel.css" in source
    assert "js/base-reference-panel.js" in source
    assert "js/base-reference-focus-bridge.js" in source


def test_external_runtime_loads_after_formula_runtime_and_before_sheet_bootstrap() -> None:
    source = template()
    formula_runtime = source.index("js/calculation/formula-runtime.js")
    external_runtime = source.index("js/calculation/external-reference-runtime.js")
    bootstrap = source.index("js/sheet-bootstrap-v2.js")
    panel = source.index("js/base-reference-panel.js")
    focus_bridge = source.index("js/base-reference-focus-bridge.js")
    assert formula_runtime < external_runtime < bootstrap < panel < focus_bridge


def test_panel_virtualizes_rows_and_inserts_at_formula_cursor() -> None:
    source = panel_script()
    assert "PAGE_SIZE = 200" in source
    assert "visibleRange" in source
    assert "rowCache" in source
    assert "requiredPages" in source
    assert "setPointerCapture" in source
    assert "formulaInput.selectionStart" not in source
    assert "active.selectionStart" in source
    assert "setSelectionRange(caret, caret)" in source
    assert "superexcel:base-reference-inserted" in source


def test_focus_bridge_preserves_formula_cursor_and_opens_base() -> None:
    source = focus_bridge_script()
    assert "selectionStart" in source
    assert "selectionEnd" in source
    assert "stopImmediatePropagation" in source
    assert "setSelectionRange(start, end)" in source
    assert "window.open(`/base/${sourceId}`" in source


def test_panel_hydrates_only_formula_references_and_syncs_dependencies() -> None:
    source = panel_script()
    assert "getExternalDependencies" in source
    assert "base-reference-values" in source
    assert "base-dependencies/sync" in source
    assert "POLL_MS = 15000" in source


def test_external_runtime_invalidates_only_external_dependents() -> None:
    source = runtime_script()
    assert "externalDependents" in source
    assert "formulaExternalSources" in source
    assert "graph?.collectAffected" in source
    assert "external_dependency_edges" in source
    assert "sourcePayload" in source
