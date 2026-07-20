from pathlib import Path

root = Path(__file__).resolve().parents[1]
workbook_path = root / "wasm-engine/src/workbook.rs"
workbook = workbook_path.read_text(encoding="utf-8")

duplicate = """    recalculations: u64,
    updates: u64,
    sparse_range_evaluations: u64,
    sparse_cells_resolved: u64,
    streamed_range_positions: u64,
    range_positions_avoided: u64,
    last_affected: Vec<String>,
}

#[derive(Debug)]
struct Workbook {"""
replacement = """    recalculations: u64,
    updates: u64,
    last_affected: Vec<String>,
}

#[derive(Debug)]
struct Workbook {"""
if duplicate not in workbook:
    raise RuntimeError("duplicate WorkbookStats counters marker not found")
workbook = workbook.replace(duplicate, replacement, 1)

fields = """    recalculations: u64,
    updates: u64,
    last_affected: Vec<String>,
}

impl Workbook {"""
fields_replacement = """    recalculations: u64,
    updates: u64,
    sparse_range_evaluations: u64,
    sparse_cells_resolved: u64,
    streamed_range_positions: u64,
    range_positions_avoided: u64,
    last_affected: Vec<String>,
}

impl Workbook {"""
if fields not in workbook:
    raise RuntimeError("Workbook counter fields marker not found")
workbook = workbook.replace(fields, fields_replacement, 1)

bad_formula = '"Z1": "=SOMASES(A1:A100000;B1:B100000;"Pago")",'
good_formula = '"Z1": "=SOMASES(A1:A100000;B1:B100000;\\"Pago\\")",'
if bad_formula not in workbook:
    raise RuntimeError("conditional formula quote marker not found")
workbook = workbook.replace(bad_formula, good_formula, 1)
workbook_path.write_text(workbook, encoding="utf-8")

sparse_path = root / "wasm-engine/src/workbook/sparse.rs"
sparse = sparse_path.read_text(encoding="utf-8")
sparse = sparse.replace(
    "    CellRange, CellReference, EngineError, Value, MAX_RANGE_CELLS,",
    "    CellRange, EngineError, Value, MAX_RANGE_CELLS,",
    1,
)
sparse_path.write_text(sparse, encoding="utf-8")
