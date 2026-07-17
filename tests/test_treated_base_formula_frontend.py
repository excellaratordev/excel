from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_base_template_loads_formula_runtime() -> None:
    template = read("templates/base.html")
    assert "treated-base-formulas.css" in template
    assert "treated-base-formulas.js" in template
    assert template.index("base-grid.js") < template.index("treated-base-formulas.js")


def test_formula_client_resolves_sheet_values_in_hidden_runtime() -> None:
    script = read("static/js/treated-base-formulas.js")
    bridge = read("static/js/workbook-value-bridge.js")
    source_sync = read("static/js/treated-base-source-sync.js")

    assert "DIRECT_REFERENCE_RE" in script
    assert "treated-formula-runtime-frame" in script
    assert "superexcel:value-subscribe" in script
    assert "/formula-result" in script
    assert "sourceGroups" in script
    assert "superexcel:value-bridge-ready" in bridge
    assert "SuperExcelActiveRuntime" in bridge
    assert "getCellValue" in bridge
    assert "workbook-value-bridge.js" in source_sync


def test_formula_value_is_visible_while_expression_remains_editable() -> None:
    script = read("static/js/treated-base-formulas.js")
    styles = read("static/css/treated-base-formulas.css")

    assert "input.dataset.treatedFormula" in script
    assert "input.dataset.original = formula" in script
    assert ".treated-formula-display" in styles
    assert ".base-grid-cell:focus-within .treated-formula-display" in styles
    assert "color: transparent" in styles
