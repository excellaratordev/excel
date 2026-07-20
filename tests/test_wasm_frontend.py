from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_wasm_formula_engine_is_loaded_before_runtime_bridge():
    template = (ROOT / "templates/index.html").read_text(encoding="utf-8")
    contract = "js/wasm/engine-contract.js"
    engine = "js/wasm/formula-engine.js"
    bridge = "js/calculation/runtime-bridge.js"
    assert contract in template
    assert engine in template
    assert template.index(contract) < template.index(engine) < template.index(bridge)


def test_committed_wasm_asset_exists():
    asset = ROOT / "static/wasm/superexcel_wasm_engine.wasm"
    assert asset.is_file()
    assert asset.stat().st_size > 1024


def test_rust_engine_exposes_formula_and_stateful_workbook_runtime():
    formula_source = (ROOT / "wasm-engine/src/lib.rs").read_text(encoding="utf-8")
    workbook_source = (ROOT / "wasm-engine/src/workbook.rs").read_text(encoding="utf-8")
    contract = (ROOT / "static/js/wasm/engine-contract.js").read_text(encoding="utf-8")
    bridge = (ROOT / "static/js/calculation/runtime-bridge.js").read_text(encoding="utf-8")

    assert "superexcel_evaluate_formula" in formula_source
    assert "enum Ast" in formula_source
    assert "mod workbook;" in formula_source
    assert "superexcel_workbook_create" in workbook_source
    assert "reverse_dependencies" in workbook_source
    assert "collect_affected" in workbook_source
    assert "cache_hits" in workbook_source
    assert "const ABI_VERSION = 4" in contract
    assert "superexcel_compile_formula" in formula_source
    assert "compileFormula" in contract
    assert "SOMASES" in formula_source
    assert "PROCX" in formula_source
    assert "createWorkbook" in contract
    assert "getWorkbookCell" in contract
    assert "applyWorkbook" in bridge
