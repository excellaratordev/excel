from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    if old not in content:
        raise RuntimeError(f"marker not found: {label}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "wasm-engine/src/workbook.rs",
    '            "B1": "=FILTRO(C1:C2;D1:D2)",',
    '            "B1": "=TEXTO(A1;\\"0,00\\")",',
    "unsupported workbook formula",
)
replace_once(
    "wasm-engine/src/workbook/sparse.rs",
    "    CellReference, EngineError, Value, MAX_RANGE_CELLS,\n",
    "    EngineError, Value, MAX_RANGE_CELLS,\n",
    "unused CellReference import",
)
