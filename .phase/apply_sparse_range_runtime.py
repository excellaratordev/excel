from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def write(path, content):
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(content, old, new, label):
    if old not in content:
        raise RuntimeError(f"marker not found: {label}")
    return content.replace(old, new, 1)


# Rust ABI version and unit expectations.
lib_path = "wasm-engine/src/lib.rs"
lib = read(lib_path)
lib = replace_once(
    lib,
    "pub const ABI_VERSION: u32 = 5;",
    "pub const ABI_VERSION: u32 = 6;",
    "ABI version",
)
lib = replace_once(
    lib,
    "fn abi_is_version_five() {\n        assert_eq!(superexcel_abi_version(), 5);\n    }",
    "fn abi_is_version_six() {\n        assert_eq!(superexcel_abi_version(), 6);\n    }",
    "Rust ABI test",
)
write(lib_path, lib)

# Stateful workbook wiring and metrics.
workbook_path = "wasm-engine/src/workbook.rs"
workbook = read(workbook_path)
workbook = replace_once(
    workbook,
    "use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};",
    "use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};",
    "BTreeMap import",
)
workbook = replace_once(
    workbook,
    "use std::sync::{Mutex, OnceLock};\n\nconst MAX_WORKBOOK_CELLS",
    "use std::sync::{Mutex, OnceLock};\n\nmod sparse;\n\nconst MAX_WORKBOOK_CELLS",
    "sparse module declaration",
)
workbook = replace_once(
    workbook,
    "    range_buckets: usize,\n    cache_entries: usize,",
    "    range_buckets: usize,\n    sparse_range_evaluations: u64,\n    sparse_cells_resolved: u64,\n    streamed_range_positions: u64,\n    range_positions_avoided: u64,\n    cache_entries: usize,",
    "workbook stats sparse fields",
)
workbook = replace_once(
    workbook,
    "struct Workbook {\n    raw: HashMap<String, JsonValue>,\n    formulas: HashMap<String, FormulaState>,",
    "struct Workbook {\n    raw: HashMap<String, JsonValue>,\n    occupied_cells: BTreeMap<(usize, usize), String>,\n    formulas: HashMap<String, FormulaState>,",
    "occupied cell index field",
)
workbook = replace_once(
    workbook,
    "    recalculations: u64,\n    updates: u64,\n    last_affected: Vec<String>,",
    "    recalculations: u64,\n    updates: u64,\n    sparse_range_evaluations: u64,\n    sparse_cells_resolved: u64,\n    streamed_range_positions: u64,\n    range_positions_avoided: u64,\n    last_affected: Vec<String>,",
    "workbook sparse counters",
)
workbook = replace_once(
    workbook,
    "            raw: HashMap::new(),\n            formulas: HashMap::new(),",
    "            raw: HashMap::new(),\n            occupied_cells: BTreeMap::new(),\n            formulas: HashMap::new(),",
    "occupied cell index initialization",
)
workbook = replace_once(
    workbook,
    "            recalculations: 0,\n            updates: 0,\n            last_affected: Vec::new(),",
    "            recalculations: 0,\n            updates: 0,\n            sparse_range_evaluations: 0,\n            sparse_cells_resolved: 0,\n            streamed_range_positions: 0,\n            range_positions_avoided: 0,\n            last_affected: Vec::new(),",
    "sparse counters initialization",
)
workbook = replace_once(
    workbook,
    '''        self.remove_formula(&key);
        self.cache.remove(&key);

        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            self.raw.remove(&key);
            return;
        }

        self.raw.insert(key.clone(), value.clone());''',
    '''        self.remove_formula(&key);
        self.cache.remove(&key);
        let coordinate = parse_cell_reference(&key)
            .ok()
            .map(|reference| (reference.row, reference.col));

        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            self.raw.remove(&key);
            if let Some(coordinate) = coordinate {
                self.occupied_cells.remove(&coordinate);
            }
            return;
        }

        if let Some(coordinate) = coordinate {
            self.occupied_cells.insert(coordinate, key.clone());
        }
        self.raw.insert(key.clone(), value.clone());''',
    "occupied cell maintenance",
)
workbook = replace_once(
    workbook,
    '''        stack.insert(key.to_string());
        let mut resolved = HashMap::with_capacity(
            node.direct_dependencies.len() + node.range_dependencies.len().saturating_mul(16),
        );''',
    '''        stack.insert(key.to_string());
        if self.should_use_sparse(&node) {
            let result = self.evaluate_sparse_formula(&node.ast, stack);
            stack.remove(key);
            let value = result?;
            self.recalculations = self.recalculations.saturating_add(1);
            self.cache.insert(key.to_string(), value.clone());
            return Ok(value);
        }

        let mut resolved = HashMap::with_capacity(
            node.direct_dependencies.len() + node.range_dependencies.len().saturating_mul(16),
        );''',
    "sparse evaluator dispatch",
)
workbook = replace_once(
    workbook,
    "            range_buckets: self.range_index.bucket_count(),\n            cache_entries: self.cache.len(),",
    "            range_buckets: self.range_index.bucket_count(),\n            sparse_range_evaluations: self.sparse_range_evaluations,\n            sparse_cells_resolved: self.sparse_cells_resolved,\n            streamed_range_positions: self.streamed_range_positions,\n            range_positions_avoided: self.range_positions_avoided,\n            cache_entries: self.cache.len(),",
    "sparse metrics response",
)
workbook = replace_once(
    workbook,
    '''    #[test]
    fn removes_stale_range_index_entries_when_formula_changes() {''',
    '''    #[test]
    fn evaluates_large_sparse_sum_without_dense_materialization() {
        let mut workbook = workbook(json!({
            "A1": 10,
            "A100000": 20,
            "Z1": "=SOMA(A1:A100000)",
        }));
        assert_eq!(workbook.evaluate_cell("Z1").unwrap().1, Value::Number(30.0));
        let stats = workbook.stats();
        assert_eq!(stats.sparse_range_evaluations, 1);
        assert_eq!(stats.sparse_cells_resolved, 2);
        assert!(stats.range_positions_avoided >= 99_998);
        assert_eq!(stats.streamed_range_positions, 0);
    }

    #[test]
    fn streams_large_conditional_ranges_without_dense_buffers() {
        let mut workbook = workbook(json!({
            "A1": 10,
            "A100000": 20,
            "B1": "Pago",
            "B100000": "Pago",
            "Z1": "=SOMASES(A1:A100000;B1:B100000;\"Pago\")",
        }));
        assert_eq!(workbook.evaluate_cell("Z1").unwrap().1, Value::Number(30.0));
        let stats = workbook.stats();
        assert!(stats.streamed_range_positions >= 100_000);
        assert!(stats.sparse_cells_resolved >= 4);
    }

    #[test]
    fn removes_stale_range_index_entries_when_formula_changes() {''',
    "sparse workbook tests",
)
write(workbook_path, workbook)

# Browser ABI contract.
contract_path = "static/js/wasm/engine-contract.js"
contract = read(contract_path)
contract = replace_once(contract, "const ABI_VERSION = 5;", "const ABI_VERSION = 6;", "JS ABI")
write(contract_path, contract)

# JavaScript and Python contract tests.
platform_path = "tests/js/platform-foundation.test.js"
platform = read(platform_path)
platform = replace_once(
    platform,
    "test('runtime Rust/Wasm com índice de intervalos usa ABI 5', () => assert.equal(ABI_VERSION, 5));",
    "test('runtime Rust/Wasm com avaliação esparsa usa ABI 6', () => assert.equal(ABI_VERSION, 6));",
    "platform ABI test",
)
write(platform_path, platform)

frontend_path = "tests/test_wasm_frontend.py"
frontend = read(frontend_path)
frontend = replace_once(frontend, 'assert "const ABI_VERSION = 5" in contract', 'assert "const ABI_VERSION = 6" in contract', "Python ABI assertion")
frontend = replace_once(
    frontend,
    '    assert "range_buckets" in workbook_source\n',
    '    assert "range_buckets" in workbook_source\n    assert "occupied_cells" in workbook_source\n    assert "evaluate_sparse_formula" in (ROOT / "wasm-engine/src/workbook/sparse.rs").read_text(encoding="utf-8")\n',
    "Python sparse source assertions",
)
write(frontend_path, frontend)

integration_path = "tests/js/wasm-engine.integration.mjs"
integration = read(integration_path)
integration = replace_once(integration, "assert.equal(engine.version, 5);", "assert.equal(engine.version, 6);", "Node ABI assertion")
integration = replace_once(
    integration,
    '''assert.equal(engine.destroyWorkbook(largeWorkbook.handle), true);

console.log(JSON.stringify({''',
    '''assert.equal(engine.destroyWorkbook(largeWorkbook.handle), true);

const sparseWorkbook = engine.createWorkbook({
  A1: 10,
  A100000: 20,
  B1: 'Pago',
  B100000: 'Pago',
  Z1: '=SOMA(A1:A100000)',
  Z2: '=SOMASES(A1:A100000;B1:B100000;"Pago")',
});
assert.equal(sparseWorkbook.status, 'ok');
assert.equal(engine.getWorkbookCell(sparseWorkbook.handle, 'Z1').value, 30);
assert.equal(engine.getWorkbookCell(sparseWorkbook.handle, 'Z2').value, 30);
const sparseStats = engine.getWorkbookStats(sparseWorkbook.handle).stats;
assert.ok(sparseStats.sparse_range_evaluations >= 1);
assert.ok(sparseStats.range_positions_avoided >= 99998);
assert.ok(sparseStats.streamed_range_positions >= 100000);
assert.equal(engine.destroyWorkbook(sparseWorkbook.handle), true);

console.log(JSON.stringify({''',
    "Node sparse workbook coverage",
)
integration = replace_once(integration, "tests: 20,", "tests: 22,", "Node test count")
integration = replace_once(
    integration,
    '''    range_buckets: largeStats.range_buckets,
  },''',
    '''    range_buckets: largeStats.range_buckets,
    sparse_evaluations: sparseStats.sparse_range_evaluations,
    positions_avoided: sparseStats.range_positions_avoided,
    streamed_positions: sparseStats.streamed_range_positions,
  },''',
    "Node sparse metrics output",
)
write(integration_path, integration)
