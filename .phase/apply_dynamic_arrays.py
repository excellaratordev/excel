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


# Rust formula evaluator: ABI 7 and dynamic array functions.
lib_path = "wasm-engine/src/lib.rs"
lib = read(lib_path)
lib = replace_once(lib, "pub const ABI_VERSION: u32 = 6;", "pub const ABI_VERSION: u32 = 7;", "Rust ABI")
lib = replace_once(
    lib,
    "const MAX_RANGE_CELLS: usize = 4096;\n",
    "const MAX_RANGE_CELLS: usize = 4096;\nconst MAX_DYNAMIC_ARRAY_CELLS: usize = 10_000;\n",
    "dynamic array limit",
)
lib = replace_once(
    lib,
    '''            "INDICE" | "INDEX" => self.index_function(args),
            "CORRESP" | "MATCH" => self.match_function(args),
            "ABS" => {''',
    '''            "INDICE" | "INDEX" => self.index_function(args),
            "CORRESP" | "MATCH" => self.match_function(args),
            "FILTRO" | "FILTER" => self.filter_function(args),
            "UNICO" | "UNIQUE" => self.unique_function(args),
            "CLASSIFICAR" | "SORT" => self.sort_function(args),
            "ABS" => {''',
    "dynamic function dispatch",
)

dynamic_methods = r'''    fn filter_function(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let source = to_matrix(self.evaluate(&args[0])?);
        let include = to_matrix(self.evaluate(&args[1])?);
        if !matrix_is_rectangular(&source) || !matrix_is_rectangular(&include) {
            return Ok(Value::Error("#VALOR!".into()));
        }
        ensure_dynamic_array_limit(&source)?;
        let height = source.len();
        let width = source.first().map(Vec::len).unwrap_or(0);
        let fallback = args
            .get(2)
            .map(|value| self.evaluate(value))
            .transpose()?
            .map(first_scalar)
            .unwrap_or(Value::Error("#CALC!".into()));

        let result = if include.len() == height && include.iter().all(|row| row.len() == 1) {
            source
                .into_iter()
                .enumerate()
                .filter_map(|(row, values)| filter_include_truthy(&include[row][0]).then_some(values))
                .collect::<Vec<_>>()
        } else if include.len() == 1 && include.first().is_some_and(|row| row.len() == width) {
            let columns = include[0]
                .iter()
                .enumerate()
                .filter_map(|(column, value)| filter_include_truthy(value).then_some(column))
                .collect::<Vec<_>>();
            source
                .into_iter()
                .map(|row| {
                    columns
                        .iter()
                        .map(|column| row.get(*column).cloned().unwrap_or(Value::Blank))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        } else if include.len() == height && include.iter().all(|row| row.len() == width) {
            source
                .into_iter()
                .enumerate()
                .filter_map(|(row, values)| {
                    include[row]
                        .iter()
                        .all(filter_include_truthy)
                        .then_some(values)
                })
                .collect::<Vec<_>>()
        } else {
            return Ok(Value::Error("#VALOR!".into()));
        };

        if result.is_empty() || result.iter().all(Vec::is_empty) {
            Ok(Value::Array(vec![vec![fallback]]))
        } else {
            ensure_dynamic_array_limit(&result)?;
            Ok(Value::Array(result))
        }
    }

    fn unique_function(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() != 1 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let matrix = to_matrix(self.evaluate(&args[0])?);
        ensure_dynamic_array_limit(&matrix)?;
        let mut unique = Vec::<Vec<Value>>::new();
        for row in matrix {
            if unique.iter().any(|existing| existing == &row) {
                continue;
            }
            unique.push(row);
        }
        Ok(Value::Array(unique))
    }

    fn sort_function(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.is_empty() || args.len() > 4 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let mut matrix = to_matrix(self.evaluate(&args[0])?);
        if !matrix_is_rectangular(&matrix) {
            return Ok(Value::Error("#VALOR!".into()));
        }
        ensure_dynamic_array_limit(&matrix)?;
        let sort_index = args
            .get(1)
            .map(|value| self.evaluate(value))
            .transpose()?
            .map(first_scalar)
            .map(|value| to_number(&value))
            .transpose()?
            .unwrap_or(1.0)
            .trunc() as isize
            - 1;
        let sort_index = sort_index.max(0) as usize;
        let direction = args
            .get(2)
            .map(|value| self.evaluate(value))
            .transpose()?
            .map(first_scalar)
            .map(|value| to_number(&value))
            .transpose()?
            .unwrap_or(1.0);
        let direction = if direction == -1.0 { -1 } else { 1 };
        let by_column = args
            .get(3)
            .map(|value| self.evaluate(value))
            .transpose()?
            .map(first_scalar)
            .map(|value| truthy(&value))
            .transpose()?
            .unwrap_or(false);

        if by_column {
            if matrix.is_empty() {
                return Ok(Value::Array(matrix));
            }
            let height = matrix.len();
            let width = matrix.first().map(Vec::len).unwrap_or(0);
            let mut columns = (0..width)
                .map(|column| {
                    (0..height)
                        .map(|row| matrix[row].get(column).cloned().unwrap_or(Value::Blank))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            columns.sort_by(|left, right| {
                let comparison = compare_values(
                    left.get(sort_index).unwrap_or(&Value::Blank),
                    right.get(sort_index).unwrap_or(&Value::Blank),
                ) * direction;
                comparison_ordering(comparison)
            });
            matrix = (0..height)
                .map(|row| {
                    columns
                        .iter()
                        .map(|column| column.get(row).cloned().unwrap_or(Value::Blank))
                        .collect::<Vec<_>>()
                })
                .collect();
        } else {
            matrix.sort_by(|left, right| {
                let comparison = compare_values(
                    left.get(sort_index).unwrap_or(&Value::Blank),
                    right.get(sort_index).unwrap_or(&Value::Blank),
                ) * direction;
                comparison_ordering(comparison)
            });
        }
        Ok(Value::Array(matrix))
    }

'''
lib = replace_once(
    lib,
    "    fn aggregate(&self, args: &[Ast], mode: Aggregate) -> Result<Value, EngineError> {",
    dynamic_methods + "    fn aggregate(&self, args: &[Ast], mode: Aggregate) -> Result<Value, EngineError> {",
    "dynamic evaluator methods",
)

helpers = r'''fn matrix_is_rectangular(matrix: &[Vec<Value>]) -> bool {
    let width = matrix.first().map(Vec::len).unwrap_or(0);
    matrix.iter().all(|row| row.len() == width)
}

fn ensure_dynamic_array_limit(matrix: &[Vec<Value>]) -> Result<(), EngineError> {
    let cells = matrix.iter().map(Vec::len).sum::<usize>();
    if cells > MAX_DYNAMIC_ARRAY_CELLS {
        return Err(EngineError::unsupported(format!(
            "Matriz dinâmica excede o limite experimental de {MAX_DYNAMIC_ARRAY_CELLS} células."
        )));
    }
    Ok(())
}

fn filter_include_truthy(value: &Value) -> bool {
    match value {
        Value::Blank => false,
        Value::Boolean(value) => *value,
        Value::Number(value) => *value != 0.0,
        Value::Text(value) | Value::Error(value) => !value.is_empty(),
        Value::Array(rows) => rows
            .first()
            .and_then(|row| row.first())
            .is_some_and(filter_include_truthy),
    }
}

fn comparison_ordering(value: i8) -> std::cmp::Ordering {
    if value < 0 {
        std::cmp::Ordering::Less
    } else if value > 0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

'''
lib = replace_once(lib, "fn criterion_number(value: &Value) -> Option<f64> {", helpers + "fn criterion_number(value: &Value) -> Option<f64> {", "dynamic helpers")
lib = replace_once(
    lib,
    "fn abi_is_version_six() {\n        assert_eq!(superexcel_abi_version(), 6);\n    }",
    "fn abi_is_version_seven() {\n        assert_eq!(superexcel_abi_version(), 7);\n    }",
    "Rust ABI test",
)
lib = replace_once(
    lib,
    '''    #[test]
    fn reports_unsupported_functions_for_javascript_fallback() {
        let response = evaluate("=FILTRO(A1:A2;B1:B2)", json!({}));
        assert_eq!(response.status, "unsupported");
    }
''',
    '''    #[test]
    fn evaluates_dynamic_array_functions() {
        let filtered = evaluate(
            "=FILTRO(A1:B3;C1:C3)",
            json!({
                "A1": 1, "B1": "A", "C1": true,
                "A2": 2, "B2": "B", "C2": false,
                "A3": 3, "B3": "C", "C3": true
            }),
        );
        assert_eq!(filtered.status, "ok");
        assert_eq!(filtered.value, json!([[1.0, "A"], [3.0, "C"]]));

        let unique = evaluate(
            "=ÚNICO(A1:B4)",
            json!({
                "A1": 1, "B1": "A",
                "A2": 1, "B2": "A",
                "A3": 2, "B3": "B",
                "A4": 1, "B4": "C"
            }),
        );
        assert_eq!(unique.value, json!([[1.0, "A"], [2.0, "B"], [1.0, "C"]]));

        let sorted = evaluate(
            "=CLASSIFICAR(A1:B3;2;-1)",
            json!({
                "A1": "A", "B1": 10,
                "A2": "B", "B2": 30,
                "A3": "C", "B3": 20
            }),
        );
        assert_eq!(sorted.value, json!([["B", 30.0], ["C", 20.0], ["A", 10.0]]));
    }

    #[test]
    fn preserves_fallback_for_oversized_dynamic_arrays() {
        let response = evaluate("=FILTRO(A1:A5000;B1:B5000)", json!({}));
        assert_eq!(response.status, "unsupported");
    }
''',
    "dynamic Rust tests",
)
write(lib_path, lib)


# Stateful workbook: spill planning contract without becoming authoritative.
workbook_path = "wasm-engine/src/workbook.rs"
workbook = read(workbook_path)
workbook = replace_once(
    workbook,
    "const MAX_WORKBOOK_RANGE_CELLS: usize = 100_000;\n",
    "const MAX_WORKBOOK_RANGE_CELLS: usize = 100_000;\nconst MAX_WORKBOOK_SPILL_CELLS: usize = 10_000;\n",
    "spill limit",
)
workbook = replace_once(
    workbook,
    "    range_positions_avoided: u64,\n    cache_entries: usize,",
    "    range_positions_avoided: u64,\n    spill_plans: u64,\n    spill_conflicts: u64,\n    cache_entries: usize,",
    "spill stats fields",
)
spill_struct = r'''
#[derive(Debug, Serialize)]
struct SpillPlan {
    status: &'static str,
    origin: String,
    range: String,
    rows: usize,
    cols: usize,
    value: JsonValue,
    value_type: &'static str,
    matrix: JsonValue,
    blocked_by: Vec<String>,
}
'''
workbook = replace_once(workbook, "\n#[derive(Debug)]\nstruct Workbook {", spill_struct + "\n#[derive(Debug)]\nstruct Workbook {", "spill plan struct")
workbook = replace_once(
    workbook,
    "    range_positions_avoided: u64,\n    last_affected: Vec<String>,",
    "    range_positions_avoided: u64,\n    spill_plans: u64,\n    spill_conflicts: u64,\n    last_affected: Vec<String>,",
    "spill workbook counters",
)
workbook = replace_once(
    workbook,
    "            range_positions_avoided: 0,\n            last_affected: Vec::new(),",
    "            range_positions_avoided: 0,\n            spill_plans: 0,\n            spill_conflicts: 0,\n            last_affected: Vec::new(),",
    "spill counter initialization",
)
spill_method = r'''
    fn spill_plan(&mut self, cell: &str) -> Result<SpillPlan, EngineError> {
        let (origin_key, value) = self.evaluate_cell(cell)?;
        let is_array = matches!(value, Value::Array(_));
        let matrix = match value {
            Value::Array(rows) => rows,
            scalar => vec![vec![scalar]],
        };
        let rows = matrix.len();
        let cols = matrix.first().map(Vec::len).unwrap_or(0);
        if rows == 0 || cols == 0 || matrix.iter().any(|row| row.len() != cols) {
            return Err(EngineError::unsupported(
                "Matriz dinâmica vazia ou irregular ainda usa fallback JavaScript.",
            ));
        }
        let total = rows.saturating_mul(cols);
        if total > MAX_WORKBOOK_SPILL_CELLS {
            return Err(EngineError::unsupported(format!(
                "Spill excede o limite experimental de {MAX_WORKBOOK_SPILL_CELLS} células."
            )));
        }

        let origin = parse_cell_reference(&origin_key)?;
        let end = CellReference {
            row: origin.row.saturating_add(rows - 1),
            col: origin.col.saturating_add(cols - 1),
        };
        let end_key = cell_name(&end);
        let mut blocked_by = Vec::new();
        if is_array {
            for row in 0..rows {
                for col in 0..cols {
                    if row == 0 && col == 0 {
                        continue;
                    }
                    let target = cell_name(&CellReference {
                        row: origin.row + row,
                        col: origin.col + col,
                    });
                    if self.raw.contains_key(&target) {
                        blocked_by.push(target);
                    }
                }
            }
        }
        blocked_by.sort();
        blocked_by.dedup();

        let top_left = matrix
            .first()
            .and_then(|row| row.first())
            .cloned()
            .unwrap_or(Value::Blank);
        let blocked = !blocked_by.is_empty();
        if is_array {
            self.spill_plans = self.spill_plans.saturating_add(1);
            if blocked {
                self.spill_conflicts = self.spill_conflicts.saturating_add(1);
            }
        }
        Ok(SpillPlan {
            status: if !is_array {
                "scalar"
            } else if blocked {
                "blocked"
            } else {
                "ready"
            },
            origin: origin_key.clone(),
            range: if rows == 1 && cols == 1 {
                origin_key
            } else {
                format!("{origin_key}:{end_key}")
            },
            rows,
            cols,
            value: if blocked {
                json!("#DESPEJAR!")
            } else {
                top_left.to_json()
            },
            value_type: if blocked { "error" } else { top_left.value_type() },
            matrix: Value::Array(matrix).to_json(),
            blocked_by,
        })
    }
'''
workbook = replace_once(
    workbook,
    "    fn stats(&self) -> WorkbookStats {",
    spill_method + "\n    fn stats(&self) -> WorkbookStats {",
    "spill plan method",
)
workbook = replace_once(
    workbook,
    "            range_positions_avoided: self.range_positions_avoided,\n            cache_entries: self.cache.len(),",
    "            range_positions_avoided: self.range_positions_avoided,\n            spill_plans: self.spill_plans,\n            spill_conflicts: self.spill_conflicts,\n            cache_entries: self.cache.len(),",
    "spill metrics response",
)
spill_export = r'''
#[no_mangle]
pub unsafe extern "C" fn superexcel_workbook_get_spill(
    handle: u32,
    pointer: *const u8,
    len: usize,
) -> *mut u8 {
    let request = match parse_payload::<WorkbookCellRequest>(pointer, len) {
        Ok(request) => request,
        Err(error) => {
            return write_json(json!({
                "status": "error",
                "value": "#VALOR!",
                "value_type": "error",
                "error": error,
            }))
        }
    };
    let mut registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(workbook) = registry.workbooks.get_mut(&handle) else {
        return write_json(missing_workbook(handle));
    };
    match workbook.spill_plan(&request.cell) {
        Ok(plan) => write_json(json!({
            "status": "ok",
            "revision": workbook.revision,
            "spill": plan,
        })),
        Err(error) => write_json(error_json(error)),
    }
}

'''
workbook = replace_once(
    workbook,
    "#[no_mangle]\npub extern \"C\" fn superexcel_workbook_stats(handle: u32) -> *mut u8 {",
    spill_export + "#[no_mangle]\npub extern \"C\" fn superexcel_workbook_stats(handle: u32) -> *mut u8 {",
    "spill ABI export",
)
workbook = replace_once(
    workbook,
    '''    #[test]
    fn keeps_unsupported_formulas_for_javascript_fallback() {''',
    '''    #[test]
    fn plans_dynamic_spill_and_reports_blockers() {
        let mut workbook = workbook(json!({
            "A1": 10,
            "A2": 20,
            "A3": 30,
            "B1": true,
            "B2": false,
            "B3": true,
            "D1": "=FILTRO(A1:A3;B1:B3)",
        }));
        let ready = workbook.spill_plan("D1").unwrap();
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.range, "D1:D2");
        assert_eq!(ready.rows, 2);
        assert_eq!(ready.cols, 1);
        assert_eq!(ready.matrix, json!([[10.0], [30.0]]));
        assert!(ready.blocked_by.is_empty());

        workbook
            .apply_changes(HashMap::from([("D2".into(), json!(999))]))
            .unwrap();
        let blocked = workbook.spill_plan("D1").unwrap();
        assert_eq!(blocked.status, "blocked");
        assert_eq!(blocked.value, json!("#DESPEJAR!"));
        assert_eq!(blocked.blocked_by, vec!["D2"]);
        assert_eq!(workbook.stats().spill_conflicts, 1);
    }

    #[test]
    fn keeps_unsupported_formulas_for_javascript_fallback() {''',
    "spill workbook tests",
)
write(workbook_path, workbook)


# Browser ABI contract.
contract_path = "static/js/wasm/engine-contract.js"
contract = read(contract_path)
contract = replace_once(contract, "const ABI_VERSION = 6;", "const ABI_VERSION = 7;", "JS ABI")
contract = replace_once(
    contract,
    "      'superexcel_workbook_get_cell',\n      'superexcel_workbook_stats',",
    "      'superexcel_workbook_get_cell',\n      'superexcel_workbook_get_spill',\n      'superexcel_workbook_stats',",
    "required spill export",
)
contract = replace_once(
    contract,
    '''    function getWorkbookStats(handle) {
      return readJsonResult(exports.superexcel_workbook_stats(Number(handle) || 0));
    }
''',
    '''    function getWorkbookSpill(handle, cell) {
      return withPayload({ cell }, (pointer, length) => (
        readJsonResult(exports.superexcel_workbook_get_spill(Number(handle) || 0, pointer, length))
      ));
    }

    function getWorkbookStats(handle) {
      return readJsonResult(exports.superexcel_workbook_stats(Number(handle) || 0));
    }
''',
    "contract spill method",
)
contract = replace_once(
    contract,
    "      getWorkbookCell,\n      getWorkbookStats,",
    "      getWorkbookCell,\n      getWorkbookSpill,\n      getWorkbookStats,",
    "contract spill API",
)
write(contract_path, contract)


# Browser wrapper exposes diagnostics, but JavaScript remains authoritative for applying spill.
engine_path = "static/js/wasm/formula-engine.js"
engine = read(engine_path)
engine = replace_once(
    engine,
    "    workbookFailures: 0,\n",
    "    workbookFailures: 0,\n    spillPlans: 0,\n    spillConflicts: 0,\n",
    "formula engine spill counters",
)
engine = replace_once(
    engine,
    '''  function getWorkbookStats(handle) {
    if (!state.engine || !handle) return null;
''',
    '''  function getWorkbookSpill(handle, cell) {
    if (!state.engine || !handle) return { status: 'unavailable', error: 'Workbook Wasm indisponível.' };
    try {
      const result = state.engine.getWorkbookSpill(handle, cell);
      if (result?.status === 'ok') {
        state.spillPlans += 1;
        if (result.spill?.status === 'blocked') state.spillConflicts += 1;
      } else state.workbookFailures += 1;
      return result;
    } catch (error) {
      state.workbookFailures += 1;
      return { status: 'error', error: error?.message || String(error), value: '#ERRO!' };
    }
  }

  function getWorkbookStats(handle) {
    if (!state.engine || !handle) return null;
''',
    "formula engine spill method",
)
engine = replace_once(
    engine,
    "      workbook_failures: state.workbookFailures,\n      error: state.error,",
    "      workbook_failures: state.workbookFailures,\n      spill_plans: state.spillPlans,\n      spill_conflicts: state.spillConflicts,\n      error: state.error,",
    "formula engine spill metrics",
)
engine = replace_once(
    engine,
    "    getWorkbookCell,\n    getWorkbookStats,",
    "    getWorkbookCell,\n    getWorkbookSpill,\n    getWorkbookStats,",
    "formula engine spill API",
)
write(engine_path, engine)


# Tests and integration.
platform_path = "tests/js/platform-foundation.test.js"
platform = read(platform_path)
platform = replace_once(
    platform,
    "test('runtime Rust/Wasm com avaliação esparsa usa ABI 6', () => assert.equal(ABI_VERSION, 6));",
    "test('runtime Rust/Wasm com matrizes dinâmicas usa ABI 7', () => assert.equal(ABI_VERSION, 7));",
    "platform ABI test",
)
write(platform_path, platform)

frontend_path = "tests/test_wasm_frontend.py"
frontend = read(frontend_path)
frontend = replace_once(frontend, 'assert "const ABI_VERSION = 6" in contract', 'assert "const ABI_VERSION = 7" in contract', "Python ABI")
frontend = replace_once(
    frontend,
    '    assert "PROCX" in formula_source\n',
    '    assert "PROCX" in formula_source\n    assert "FILTRO" in formula_source\n    assert "UNICO" in formula_source\n    assert "CLASSIFICAR" in formula_source\n',
    "Python dynamic functions",
)
frontend = replace_once(
    frontend,
    '    assert "getWorkbookCell" in contract\n',
    '    assert "getWorkbookCell" in contract\n    assert "superexcel_workbook_get_spill" in workbook_source\n    assert "getWorkbookSpill" in contract\n',
    "Python spill contract",
)
write(frontend_path, frontend)

integration_path = "tests/js/wasm-engine.integration.mjs"
integration = read(integration_path)
integration = replace_once(integration, "assert.equal(engine.version, 6);", "assert.equal(engine.version, 7);", "Node ABI")
integration = replace_once(
    integration,
    '''const unsupported = engine.evaluateFormula('=FILTRO(A1:A2;B1:B2)', {});
assert.equal(unsupported.status, 'unsupported');
''',
    '''const filtered = engine.evaluateFormula('=FILTRO(A1:B3;C1:C3)', {
  A1: 1, B1: 'A', C1: true,
  A2: 2, B2: 'B', C2: false,
  A3: 3, B3: 'C', C3: true,
});
assert.equal(filtered.status, 'ok');
assert.deepEqual(filtered.value, [[1, 'A'], [3, 'C']]);

const unique = engine.evaluateFormula('=ÚNICO(A1:B4)', {
  A1: 1, B1: 'A', A2: 1, B2: 'A', A3: 2, B3: 'B', A4: 1, B4: 'C',
});
assert.deepEqual(unique.value, [[1, 'A'], [2, 'B'], [1, 'C']]);

const sorted = engine.evaluateFormula('=CLASSIFICAR(A1:B3;2;-1)', {
  A1: 'A', B1: 10, A2: 'B', B2: 30, A3: 'C', B3: 20,
});
assert.deepEqual(sorted.value, [['B', 30], ['C', 20], ['A', 10]]);

const oversizedDynamic = engine.evaluateFormula('=FILTRO(A1:A5000;B1:B5000)', {});
assert.equal(oversizedDynamic.status, 'unsupported');
''',
    "Node dynamic arrays",
)
integration = replace_once(
    integration,
    '''assert.equal(engine.destroyWorkbook(sparseWorkbook.handle), true);

console.log(JSON.stringify({''',
    '''assert.equal(engine.destroyWorkbook(sparseWorkbook.handle), true);

const dynamicWorkbook = engine.createWorkbook({
  A1: 10,
  A2: 20,
  A3: 30,
  B1: true,
  B2: false,
  B3: true,
  D1: '=FILTRO(A1:A3;B1:B3)',
});
assert.equal(dynamicWorkbook.status, 'ok');
const dynamicCell = engine.getWorkbookCell(dynamicWorkbook.handle, 'D1');
assert.equal(dynamicCell.value_type, 'array');
assert.deepEqual(dynamicCell.value, [[10], [30]]);
const readySpill = engine.getWorkbookSpill(dynamicWorkbook.handle, 'D1');
assert.equal(readySpill.status, 'ok');
assert.equal(readySpill.spill.status, 'ready');
assert.equal(readySpill.spill.range, 'D1:D2');
assert.deepEqual(readySpill.spill.matrix, [[10], [30]]);
engine.applyWorkbook(dynamicWorkbook.handle, { D2: 999 });
const blockedSpill = engine.getWorkbookSpill(dynamicWorkbook.handle, 'D1');
assert.equal(blockedSpill.spill.status, 'blocked');
assert.equal(blockedSpill.spill.value, '#DESPEJAR!');
assert.deepEqual(blockedSpill.spill.blocked_by, ['D2']);
assert.equal(engine.destroyWorkbook(dynamicWorkbook.handle), true);

console.log(JSON.stringify({''',
    "Node spill workbook",
)
integration = replace_once(integration, "  tests: 22,", "  tests: 27,", "Node test count")
integration = replace_once(
    integration,
    "  business: ['SOMASES', 'PROCX'],\n",
    "  business: ['SOMASES', 'PROCX'],\n  dynamic_arrays: ['FILTRO', 'ÚNICO', 'CLASSIFICAR'],\n  spill: { ready: readySpill.spill.range, blocked_by: blockedSpill.spill.blocked_by },\n",
    "Node dynamic output",
)
write(integration_path, integration)
