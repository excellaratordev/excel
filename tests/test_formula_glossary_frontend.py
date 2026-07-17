from pathlib import Path


def template() -> str:
    return Path("templates/index.html").read_text(encoding="utf-8")


def test_formula_glossary_controls_are_present() -> None:
    source = template()

    for control_id in (
        "functions-button",
        "functions-dialog",
        "functions-search",
        "functions-category",
        "functions-result-count",
        "functions-total-count",
        "functions-list",
    ):
        assert f'id="{control_id}"' in source

    assert "Glossário de fórmulas" in source
    assert "Buscar fórmula, função ou exemplo" in source


def test_formula_glossary_assets_load_in_safe_order() -> None:
    source = template()

    catalog = source.index("js/calculation/formula-catalog.js")
    runtime = source.index("js/calculation/formula-runtime.js")
    logical = source.index("js/calculation/logical-library.js")
    bootstrap = source.index("js/sheet-bootstrap-v2.js")
    glossary = source.index("js/formula-glossary.js")

    assert catalog < runtime < logical < bootstrap < glossary
    assert "css/formula-glossary.css" in source


def test_formula_button_lives_in_spreadsheet_toolbar() -> None:
    source = template()
    toolbar_start = source.index('<section class="toolbar"')
    toolbar_end = source.index("</section>", toolbar_start)
    toolbar = source[toolbar_start:toolbar_end]

    assert 'id="functions-button"' in toolbar
