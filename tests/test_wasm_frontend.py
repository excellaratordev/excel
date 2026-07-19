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


def test_rust_engine_exposes_real_formula_evaluation():
    source = (ROOT / "wasm-engine/src/lib.rs").read_text(encoding="utf-8")
    assert "superexcel_evaluate_formula" in source
    assert "enum Ast" in source
    assert "evaluate_call" in source
    assert "SOMA" in source
