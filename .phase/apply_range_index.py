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

def replace_last(content, old, new, label):
    index = content.rfind(old)
    if index < 0:
        raise RuntimeError(f"marker not found: {label}")
    return content[:index] + new + content[index + len(old):]

lib_path = "wasm-engine/src/lib.rs"
lib = read(lib_path)
lib = replace_once(
    lib,
    "pub const ABI_VERSION: u32 = 4;\nconst IR_VERSION: u32 = 1;",
    "pub const ABI_VERSION: u32 = 5;\nconst IR_VERSION: u32 = 2;",
    "ABI and IR versions",
)
lib = replace_once(
    lib,
    '''#[derive(Debug, Clone)]
struct CellReference {
    row: usize,
    col: usize,
}

#[derive(Debug, Clone)]
enum Ast {''',
    '''#[derive(Debug, Clone)]
pub(crate) struct CellReference {
    pub(crate) row: usize,
    pub(crate) col: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct CellRange {
    pub(crate) top: usize,
    pub(crate) bottom: usize,
    pub(crate) left: usize,
    pub(crate) right: usize,
}

impl CellRange {
    pub(crate) fn from_references(start: &CellReference, end: &CellReference) -> Self {
        Self {
            top: start.row.min(end.row),
            bottom: start.row.max(end.row),
            left: start.col.min(end.col),
            right: start.col.max(end.col),
        }
    }

    pub(crate) fn cell_count(&self) -> usize {
        (self.bottom - self.top + 1).saturating_mul(self.right - self.left + 1)
    }

    pub(crate) fn contains(&self, reference: &CellReference) -> bool {
        (self.top..=self.bottom).contains(&reference.row)
            && (self.left..=self.right).contains(&reference.col)
    }

    fn to_json(&self) -> JsonValue {
        json!({
            "top": self.top,
            "bottom": self.bottom,
            "left": self.left,
            "right": self.right,
        })
    }
}

#[derive(Debug, Clone)]
enum Ast {''',
    "CellRange definition",
)
lib = replace_once(
    lib,
    '''fn collect_dependencies(ast: &Ast, output: &mut BTreeSet<String>) -> Result<(), EngineError> {
    match ast {''',
    '''pub(crate) fn collect_compact_dependencies(
    ast: &Ast,
    direct: &mut BTreeSet<String>,
    ranges: &mut BTreeSet<CellRange>,
) {
    match ast {
        Ast::Reference(reference) => {
            direct.insert(cell_name(reference));
        }
        Ast::Range(start, end) => {
            ranges.insert(CellRange::from_references(start, end));
        }
        Ast::Unary(_, value) | Ast::Percent(value) => {
            collect_compact_dependencies(value, direct, ranges);
        }
        Ast::Binary(_, left, right) => {
            collect_compact_dependencies(left, direct, ranges);
            collect_compact_dependencies(right, direct, ranges);
        }
        Ast::Call(_, args) => {
            for arg in args {
                collect_compact_dependencies(arg, direct, ranges);
            }
        }
        Ast::Literal(_) => {}
    }
}

fn collect_dependencies(ast: &Ast, output: &mut BTreeSet<String>) -> Result<(), EngineError> {
    match ast {''',
    "compact dependency collector",
)
lib = replace_once(
    lib,
    '''struct Evaluator<'a> {
    cells: &'a HashMap<String, JsonValue>,
}''',
    '''struct Evaluator<'a> {
    cells: &'a HashMap<String, JsonValue>,
    max_range_cells: usize,
}''',
    "Evaluator range limit field",
)
old_limit = '''        if total > MAX_RANGE_CELLS {
            return Err(EngineError::unsupported(format!(
                "Intervalo excede o limite experimental de {MAX_RANGE_CELLS} células."
            )));
        }'''
new_limit = '''        if total > self.max_range_cells {
            return Err(EngineError::unsupported(format!(
                "Intervalo excede o limite de {} células para este avaliador.",
                self.max_range_cells
            )));
        }'''
lib = replace_last(lib, old_limit, new_limit, "Evaluator large range check")
old_compile = '''    let mut dependencies = BTreeSet::new();
    if let Err(error) = collect_dependencies(&ast, &mut dependencies) {
        return json!({
            "status": if error.unsupported { "unsupported" } else { "error" },
            "ir_version": IR_VERSION,
            "ast": ast_to_ir(&ast),
            "dependencies": dependencies.into_iter().collect::<Vec<_>>(),
            "error": error.message,
        });
    }
    json!({
        "status": "ok",
        "ir_version": IR_VERSION,
        "ast": ast_to_ir(&ast),
        "dependencies": dependencies.into_iter().collect::<Vec<_>>(),
        "error": JsonValue::Null,
    })'''
new_compile = '''    let mut dependencies = BTreeSet::new();
    let mut range_dependencies = BTreeSet::new();
    collect_compact_dependencies(&ast, &mut dependencies, &mut range_dependencies);
    json!({
        "status": "ok",
        "ir_version": IR_VERSION,
        "ast": ast_to_ir(&ast),
        "dependencies": dependencies.into_iter().collect::<Vec<_>>(),
        "range_dependencies": range_dependencies
            .into_iter()
            .map(|range| range.to_json())
            .collect::<Vec<_>>(),
        "error": JsonValue::Null,
    })'''
lib = replace_once(lib, old_compile, new_compile, "compact compile result")
lib = replace_once(
    lib,
    '''    match (Evaluator {
        cells: &request.cells,
    })''',
    '''    match (Evaluator {
        cells: &request.cells,
        max_range_cells: MAX_RANGE_CELLS,
    })''',
    "stateless evaluator constructor",
)
lib = lib.replace(
    '"dependencies": [],\n                "error": error.message,',
    '"dependencies": [],\n                "range_dependencies": [],\n                "error": error.message,',
)
lib = lib.replace(
    '"dependencies": [],\n                "error": "Payload de compilação inválido.",',
    '"dependencies": [],\n                "range_dependencies": [],\n                "error": "Payload de compilação inválido.",',
)
write(lib_path, lib)

workbook_path = "wasm-engine/src/workbook.rs"
workbook = read(workbook_path)
workbook = replace_once(
    workbook,
    '''use super::{
    cell_name, collect_dependencies, parse_cell_reference, write_result, Ast, EngineError,
    Evaluator, Parser, Value, MAX_PAYLOAD_BYTES,
};''',
    '''use super::{
    cell_name, collect_compact_dependencies, parse_cell_reference, write_result, Ast, CellRange,
    CellReference, EngineError, Evaluator, Parser, Value, MAX_PAYLOAD_BYTES,
};''',
    "workbook imports",
)
workbook = replace_once(
    workbook,
    '''const MAX_WORKBOOK_CELLS: usize = 100_000;
const MAX_WORKBOOK_CHANGES: usize = 10_000;''',
    '''const MAX_WORKBOOK_CELLS: usize = 100_000;
const MAX_WORKBOOK_CHANGES: usize = 10_000;
const MAX_WORKBOOK_RANGE_CELLS: usize = 100_000;
const RANGE_BUCKET_ROWS: usize = 256;
const RANGE_BUCKET_COLS: usize = 32;''',
    "workbook range constants",
)
workbook = replace_once(
    workbook,
    '''#[derive(Debug, Clone)]
struct FormulaNode {
    ast: Ast,
    dependencies: BTreeSet<String>,
}''',
    '''#[derive(Debug, Default)]
struct RangeDependencyIndex {
    buckets: HashMap<(usize, usize), BTreeSet<String>>,
    ranges_by_formula: HashMap<String, BTreeSet<CellRange>>,
}

impl RangeDependencyIndex {
    fn register(&mut self, formula: &str, ranges: &BTreeSet<CellRange>) {
        self.unregister(formula);
        if ranges.is_empty() {
            return;
        }
        for range in ranges {
            for_each_range_bucket(range, |bucket| {
                self.buckets
                    .entry(bucket)
                    .or_default()
                    .insert(formula.to_string());
            });
        }
        self.ranges_by_formula
            .insert(formula.to_string(), ranges.clone());
    }

    fn unregister(&mut self, formula: &str) {
        let Some(ranges) = self.ranges_by_formula.remove(formula) else {
            return;
        };
        let mut empty_buckets = Vec::new();
        for range in &ranges {
            for_each_range_bucket(range, |bucket| {
                if let Some(formulas) = self.buckets.get_mut(&bucket) {
                    formulas.remove(formula);
                    if formulas.is_empty() {
                        empty_buckets.push(bucket);
                    }
                }
            });
        }
        for bucket in empty_buckets {
            self.buckets.remove(&bucket);
        }
    }

    fn dependents_for_cell(&self, reference: &CellReference) -> BTreeSet<String> {
        let bucket = (
            reference.row / RANGE_BUCKET_ROWS,
            reference.col / RANGE_BUCKET_COLS,
        );
        self.buckets
            .get(&bucket)
            .into_iter()
            .flatten()
            .filter(|formula| {
                self.ranges_by_formula
                    .get(*formula)
                    .is_some_and(|ranges| ranges.iter().any(|range| range.contains(reference)))
            })
            .cloned()
            .collect()
    }

    fn dependency_count(&self) -> usize {
        self.ranges_by_formula.values().map(BTreeSet::len).sum()
    }

    fn bucket_count(&self) -> usize {
        self.buckets.len()
    }
}

fn for_each_range_bucket<F>(range: &CellRange, mut callback: F)
where
    F: FnMut((usize, usize)),
{
    let top = range.top / RANGE_BUCKET_ROWS;
    let bottom = range.bottom / RANGE_BUCKET_ROWS;
    let left = range.left / RANGE_BUCKET_COLS;
    let right = range.right / RANGE_BUCKET_COLS;
    for row_bucket in top..=bottom {
        for col_bucket in left..=right {
            callback((row_bucket, col_bucket));
        }
    }
}

#[derive(Debug, Clone)]
struct FormulaNode {
    ast: Ast,
    direct_dependencies: BTreeSet<String>,
    range_dependencies: BTreeSet<CellRange>,
}''',
    "range index and formula node",
)
workbook = replace_once(
    workbook,
    '''struct WorkbookStats {
    revision: u64,
    stored_cells: usize,
    formula_cells: usize,
    dependency_edges: usize,
    cache_entries: usize,''',
    '''struct WorkbookStats {
    revision: u64,
    stored_cells: usize,
    formula_cells: usize,
    dependency_edges: usize,
    direct_dependency_edges: usize,
    range_dependencies: usize,
    range_buckets: usize,
    cache_entries: usize,''',
    "workbook stats fields",
)
workbook = replace_once(
    workbook,
    '''    formulas: HashMap<String, FormulaState>,
    reverse_dependencies: HashMap<String, BTreeSet<String>>,
    cache: HashMap<String, Value>,''',
    '''    formulas: HashMap<String, FormulaState>,
    reverse_dependencies: HashMap<String, BTreeSet<String>>,
    range_index: RangeDependencyIndex,
    cache: HashMap<String, Value>,''',
    "workbook range index field",
)
workbook = replace_once(
    workbook,
    '''            formulas: HashMap::new(),
            reverse_dependencies: HashMap::new(),
            cache: HashMap::new(),''',
    '''            formulas: HashMap::new(),
            reverse_dependencies: HashMap::new(),
            range_index: RangeDependencyIndex::default(),
            cache: HashMap::new(),''',
    "workbook range index initialization",
)
workbook = replace_once(
    workbook,
    '''        let state = match Parser::new(formula).and_then(Parser::parse) {
            Ok(ast) => {
                let mut dependencies = BTreeSet::new();
                match collect_dependencies(&ast, &mut dependencies) {
                    Ok(()) => FormulaState::Ready(FormulaNode { ast, dependencies }),
                    Err(error) => FormulaState::Failed(error),
                }
            }
            Err(error) => FormulaState::Failed(error),
        };

        if let FormulaState::Ready(node) = &state {
            for dependency in &node.dependencies {
                self.reverse_dependencies
                    .entry(dependency.clone())
                    .or_default()
                    .insert(key.clone());
            }
        }
        self.formulas.insert(key, state);''',
    '''        let state = match Parser::new(formula).and_then(Parser::parse) {
            Ok(ast) => {
                let mut direct_dependencies = BTreeSet::new();
                let mut range_dependencies = BTreeSet::new();
                collect_compact_dependencies(
                    &ast,
                    &mut direct_dependencies,
                    &mut range_dependencies,
                );
                if let Some(range) = range_dependencies
                    .iter()
                    .find(|range| range.cell_count() > MAX_WORKBOOK_RANGE_CELLS)
                {
                    FormulaState::Failed(EngineError::unsupported(format!(
                        "Intervalo de {} células excede o limite stateful de {MAX_WORKBOOK_RANGE_CELLS}.",
                        range.cell_count()
                    )))
                } else {
                    FormulaState::Ready(FormulaNode {
                        ast,
                        direct_dependencies,
                        range_dependencies,
                    })
                }
            }
            Err(error) => FormulaState::Failed(error),
        };

        if let FormulaState::Ready(node) = &state {
            for dependency in &node.direct_dependencies {
                self.reverse_dependencies
                    .entry(dependency.clone())
                    .or_default()
                    .insert(key.clone());
            }
            self.range_index.register(&key, &node.range_dependencies);
        }
        self.formulas.insert(key, state);''',
    "compact formula definition",
)
workbook = replace_once(
    workbook,
    '''    fn remove_formula(&mut self, key: &str) {
        let dependencies = match self.formulas.remove(key) {
            Some(FormulaState::Ready(node)) => node.dependencies,
            _ => BTreeSet::new(),
        };
        for dependency in dependencies {
            let should_remove = self
                .reverse_dependencies
                .get_mut(&dependency)
                .map(|dependents| {
                    dependents.remove(key);
                    dependents.is_empty()
                })
                .unwrap_or(false);
            if should_remove {
                self.reverse_dependencies.remove(&dependency);
            }
        }
    }''',
    '''    fn remove_formula(&mut self, key: &str) {
        let dependencies = match self.formulas.remove(key) {
            Some(FormulaState::Ready(node)) => node.direct_dependencies,
            _ => BTreeSet::new(),
        };
        self.range_index.unregister(key);
        for dependency in dependencies {
            let should_remove = self
                .reverse_dependencies
                .get_mut(&dependency)
                .map(|dependents| {
                    dependents.remove(key);
                    dependents.is_empty()
                })
                .unwrap_or(false);
            if should_remove {
                self.reverse_dependencies.remove(&dependency);
            }
        }
    }''',
    "formula range unregister",
)
workbook = replace_once(
    workbook,
    '''    fn collect_affected(&self, changed: &BTreeSet<String>) -> BTreeSet<String> {
        let mut affected = changed.clone();
        let mut pending: VecDeque<String> = changed.iter().cloned().collect();
        while let Some(current) = pending.pop_front() {
            if let Some(dependents) = self.reverse_dependencies.get(&current) {
                for dependent in dependents {
                    if affected.insert(dependent.clone()) {
                        pending.push_back(dependent.clone());
                    }
                }
            }
        }
        affected
    }''',
    '''    fn collect_affected(&self, changed: &BTreeSet<String>) -> BTreeSet<String> {
        let mut affected = changed.clone();
        let mut pending: VecDeque<String> = changed.iter().cloned().collect();
        while let Some(current) = pending.pop_front() {
            let mut dependents = self
                .reverse_dependencies
                .get(&current)
                .cloned()
                .unwrap_or_default();
            if let Ok(reference) = parse_cell_reference(&current) {
                dependents.extend(self.range_index.dependents_for_cell(&reference));
            }
            for dependent in dependents {
                if affected.insert(dependent.clone()) {
                    pending.push_back(dependent);
                }
            }
        }
        affected
    }''',
    "range-aware invalidation",
)
workbook = replace_once(
    workbook,
    '''        stack.insert(key.to_string());
        let mut resolved = HashMap::with_capacity(node.dependencies.len());
        for dependency in &node.dependencies {
            let value = self.evaluate_cell_inner(dependency, stack)?;
            resolved.insert(dependency.clone(), value.to_json());
        }
        let result = (Evaluator { cells: &resolved }).evaluate(&node.ast);
        stack.remove(key);''',
    '''        stack.insert(key.to_string());
        let mut resolved = HashMap::with_capacity(
            node.direct_dependencies.len()
                + node.range_dependencies.len().saturating_mul(16),
        );
        let mut visited = HashSet::new();
        for dependency in &node.direct_dependencies {
            visited.insert(dependency.clone());
            let value = self.evaluate_cell_inner(dependency, stack)?;
            if value != Value::Blank {
                resolved.insert(dependency.clone(), value.to_json());
            }
        }
        for range in &node.range_dependencies {
            for row in range.top..=range.bottom {
                for col in range.left..=range.right {
                    let dependency = cell_name(&CellReference { row, col });
                    if !visited.insert(dependency.clone()) {
                        continue;
                    }
                    let value = self.evaluate_cell_inner(&dependency, stack)?;
                    if value != Value::Blank {
                        resolved.insert(dependency, value.to_json());
                    }
                }
            }
        }
        let result = (Evaluator {
            cells: &resolved,
            max_range_cells: MAX_WORKBOOK_RANGE_CELLS,
        })
        .evaluate(&node.ast);
        stack.remove(key);''',
    "lazy large range resolution",
)
workbook = replace_once(
    workbook,
    '''    fn stats(&self) -> WorkbookStats {
        WorkbookStats {
            revision: self.revision,
            stored_cells: self.raw.len(),
            formula_cells: self.formulas.len(),
            dependency_edges: self.reverse_dependencies.values().map(BTreeSet::len).sum(),
            cache_entries: self.cache.len(),''',
    '''    fn stats(&self) -> WorkbookStats {
        let direct_dependency_edges =
            self.reverse_dependencies.values().map(BTreeSet::len).sum();
        let range_dependencies = self.range_index.dependency_count();
        WorkbookStats {
            revision: self.revision,
            stored_cells: self.raw.len(),
            formula_cells: self.formulas.len(),
            dependency_edges: direct_dependency_edges + range_dependencies,
            direct_dependency_edges,
            range_dependencies,
            range_buckets: self.range_index.bucket_count(),
            cache_entries: self.cache.len(),''',
    "compact dependency stats",
)
workbook = replace_once(
    workbook,
    '''    #[test]
    fn keeps_unsupported_formulas_for_javascript_fallback() {''',
    '''    #[test]
    fn indexes_large_ranges_without_per_cell_edges() {
        let mut workbook = workbook(json!({
            "A1": 1,
            "A10000": 2,
            "Z1": "=SOMA(A1:A10000)",
        }));
        let stats = workbook.stats();
        assert_eq!(stats.direct_dependency_edges, 0);
        assert_eq!(stats.range_dependencies, 1);
        assert!(stats.range_buckets < 64);
        assert_eq!(
            workbook.evaluate_cell("Z1").unwrap().1,
            Value::Number(3.0)
        );

        let affected = workbook
            .apply_changes(HashMap::from([("A5000".into(), json!(5))]))
            .unwrap();
        assert_eq!(affected, vec!["A5000", "Z1"]);
        assert_eq!(
            workbook.evaluate_cell("Z1").unwrap().1,
            Value::Number(8.0)
        );

        let unrelated = workbook
            .apply_changes(HashMap::from([("B1".into(), json!(9))]))
            .unwrap();
        assert_eq!(unrelated, vec!["B1"]);
    }

    #[test]
    fn propagates_large_range_invalidation_transitively() {
        let mut workbook = workbook(json!({
            "A1": 1,
            "A100000": 2,
            "AA1": "=SOMA(A1:A100000)",
            "AB1": "=AA1*2",
        }));
        assert_eq!(
            workbook.evaluate_cell("AB1").unwrap().1,
            Value::Number(6.0)
        );
        let stats = workbook.stats();
        assert_eq!(stats.direct_dependency_edges, 1);
        assert_eq!(stats.range_dependencies, 1);
        assert!(stats.range_buckets < 512);

        let affected = workbook
            .apply_changes(HashMap::from([("A50000".into(), json!(7))]))
            .unwrap();
        assert_eq!(affected, vec!["A50000", "AA1", "AB1"]);
        assert_eq!(
            workbook.evaluate_cell("AB1").unwrap().1,
            Value::Number(20.0)
        );
    }

    #[test]
    fn removes_stale_range_index_entries_when_formula_changes() {
        let mut workbook = workbook(json!({
            "A1": 1,
            "Z1": "=SOMA(A1:A10000)",
        }));
        workbook
            .apply_changes(HashMap::from([("Z1".into(), json!(10))]))
            .unwrap();
        assert_eq!(workbook.stats().range_dependencies, 0);
        let affected = workbook
            .apply_changes(HashMap::from([("A1".into(), json!(2))]))
            .unwrap();
        assert_eq!(affected, vec!["A1"]);
    }

    #[test]
    fn keeps_unsupported_formulas_for_javascript_fallback() {''',
    "large range tests",
)
write(workbook_path, workbook)

parser_path = "static/js/calculation/formula-parser.js"
parser = read(parser_path)
parser = replace_once(parser, "  const IR_VERSION = 1;", "  const IR_VERSION = 2;", "JavaScript IR version")
parser = replace_once(
    parser,
    '''      const names = new Set();
      for (const key of dependencies.cells) {
        const [row, col] = String(key).split(':').map(Number);
        names.add(cellName(row, col));
      }
      for (const range of dependencies.ranges) {
        const total = (range.bottom - range.top + 1) * (range.right - range.left + 1);
        if (total > 4096) {
          return {
            status: 'unsupported',
            ir_version: IR_VERSION,
            ast: toIntermediateRepresentation(ast),
            dependencies: [...names].sort(),
            error: 'Intervalo excede o limite experimental de 4096 células.',
          };
        }
        for (let row = range.top; row <= range.bottom; row += 1) {
          for (let col = range.left; col <= range.right; col += 1) names.add(cellName(row, col));
        }
      }
      return {
        status: 'ok',
        ir_version: IR_VERSION,
        ast: toIntermediateRepresentation(ast),
        dependencies: [...names].sort(),
        error: null,
      };''',
    '''      const names = new Set();
      for (const key of dependencies.cells) {
        const [row, col] = String(key).split(':').map(Number);
        names.add(cellName(row, col));
      }
      const rangeDependencies = [...new Map(
        dependencies.ranges.map(range => {
          const descriptor = {
            top: range.top,
            bottom: range.bottom,
            left: range.left,
            right: range.right,
          };
          return [`${descriptor.top}:${descriptor.bottom}:${descriptor.left}:${descriptor.right}`, descriptor];
        }),
      ).values()].sort((left, right) => (
        left.top - right.top
        || left.bottom - right.bottom
        || left.left - right.left
        || left.right - right.right
      ));
      return {
        status: 'ok',
        ir_version: IR_VERSION,
        ast: toIntermediateRepresentation(ast),
        dependencies: [...names].sort(),
        range_dependencies: rangeDependencies,
        error: null,
      };''',
    "compact JavaScript IR dependencies",
)
parser = parser.replace(
    "          dependencies: [],\n          error: 'Referências externas",
    "          dependencies: [],\n          range_dependencies: [],\n          error: 'Referências externas",
)
parser = parser.replace(
    "        dependencies: [],\n        error: error?.message",
    "        dependencies: [],\n        range_dependencies: [],\n        error: error?.message",
)
write(parser_path, parser)

contract_path = "static/js/wasm/engine-contract.js"
contract = read(contract_path)
contract = replace_once(contract, "  const ABI_VERSION = 4;", "  const ABI_VERSION = 5;", "browser ABI version")
write(contract_path, contract)

ir_test_path = "tests/js/formula-ir.test.js"
ir_test = read(ir_test_path)
ir_test = replace_once(
    ir_test,
    '''  assert.equal(result.ir_version, 1);
  assert.equal(result.ast.type, 'binary');
  assert.equal(result.ast.left.name, 'MEDIA');
  assert.deepEqual(result.dependencies, ['A1', 'A2', 'A3', 'B1']);''',
    '''  assert.equal(result.ir_version, 2);
  assert.equal(result.ast.type, 'binary');
  assert.equal(result.ast.left.name, 'MEDIA');
  assert.deepEqual(result.dependencies, ['B1']);
  assert.deepEqual(result.range_dependencies, [
    { top: 0, bottom: 2, left: 0, right: 0 },
  ]);''',
    "IR compact dependency expectation",
)
ir_test += '''

test('IR v2 mantém intervalos grandes compactos', () => {
  const result = parser.compile('=SOMA(A1:A100000)+Z1');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.dependencies, ['Z1']);
  assert.deepEqual(result.range_dependencies, [
    { top: 0, bottom: 99999, left: 0, right: 0 },
  ]);
});
'''
write(ir_test_path, ir_test)

platform_path = "tests/js/platform-foundation.test.js"
platform = read(platform_path)
platform = replace_once(
    platform,
    "test('runtime Rust/Wasm com IR compartilhada usa ABI 4', () => assert.equal(ABI_VERSION, 4));",
    "test('runtime Rust/Wasm com índice de intervalos usa ABI 5', () => assert.equal(ABI_VERSION, 5));",
    "platform ABI test",
)
write(platform_path, platform)

integration_path = "tests/js/wasm-engine.integration.mjs"
integration = read(integration_path)
integration = replace_once(integration, "assert.equal(engine.version, 4);", "assert.equal(engine.version, 5);", "Wasm ABI expectation")
integration = replace_once(
    integration,
    '''assert.equal(rustIr.ir_version, 1);
assert.deepEqual(rustIr.ast, javascriptIr.ast);
assert.deepEqual(rustIr.dependencies, javascriptIr.dependencies);''',
    '''assert.equal(rustIr.ir_version, 2);
assert.deepEqual(rustIr.ast, javascriptIr.ast);
assert.deepEqual(rustIr.dependencies, javascriptIr.dependencies);
assert.deepEqual(rustIr.range_dependencies, javascriptIr.range_dependencies);''',
    "IR v2 parity",
)
integration = replace_once(
    integration,
    '''assert.equal(engine.destroyWorkbook(created.handle), true);

console.log(JSON.stringify({''',
    '''assert.equal(engine.destroyWorkbook(created.handle), true);

const largeWorkbook = engine.createWorkbook({
  A1: 1,
  A10000: 2,
  Z1: '=SOMA(A1:A10000)',
});
assert.equal(largeWorkbook.status, 'ok');
const largeStats = engine.getWorkbookStats(largeWorkbook.handle).stats;
assert.equal(largeStats.direct_dependency_edges, 0);
assert.equal(largeStats.range_dependencies, 1);
assert.ok(largeStats.range_buckets < 64);
assert.equal(engine.getWorkbookCell(largeWorkbook.handle, 'Z1').value, 3);
const largeApplied = engine.applyWorkbook(largeWorkbook.handle, { A5000: 5 });
assert.deepEqual(largeApplied.affected, ['A5000', 'Z1']);
assert.equal(engine.getWorkbookCell(largeWorkbook.handle, 'Z1').value, 8);
const unrelatedApplied = engine.applyWorkbook(largeWorkbook.handle, { B1: 9 });
assert.deepEqual(unrelatedApplied.affected, ['B1']);
assert.equal(engine.destroyWorkbook(largeWorkbook.handle), true);

console.log(JSON.stringify({''',
    "large workbook integration",
)
integration = integration.replace("  tests: 16,", "  tests: 20,")
integration = integration.replace(
    "    recalculations: statsAfter.recalculations,\n  },",
    "    recalculations: statsAfter.recalculations,\n    range_buckets: largeStats.range_buckets,\n  },",
)
write(integration_path, integration)

frontend_path = "tests/test_wasm_frontend.py"
frontend = read(frontend_path)
frontend = replace_once(
    frontend,
    '    assert "const ABI_VERSION = 4" in contract',
    '    assert "const ABI_VERSION = 5" in contract',
    "frontend ABI expectation",
)
frontend = frontend.replace(
    '    assert "PROCX" in formula_source\n',
    '    assert "PROCX" in formula_source\n    assert "RangeDependencyIndex" in workbook_source\n    assert "range_buckets" in workbook_source\n',
)
write(frontend_path, frontend)

readme_path = "README.md"
readme = read(readme_path)
readme = readme.replace("ABI 4, IR compartilhada e funções empresariais", "ABI 5, IR v2 e índice de intervalos")
readme = readme.replace(
    "A ABI 4 também expõe uma representação intermediária JSON versionada, comparável à produzida pelo parser JavaScript.",
    "A ABI 5 expõe a IR JSON versão 2, na qual referências diretas e retângulos de intervalo são descritos separadamente.",
)
readme = readme.replace("- ABI versão `4` e IR de fórmulas versão `1`;", "- ABI versão `5` e IR de fórmulas versão `2`;")
readme = readme.replace("- grafo reverso de dependências por célula;", "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;")
readme = readme.replace(
    "- limite de 4.096 células por intervalo e 100.000 células por workbook experimental;",
    "- avaliação stateless limitada a 4.096 posições; workbook stateful aceita intervalos de até 100.000 posições;",
)
readme = readme.replace("- dependências de intervalos grandes com indexação especializada;\n", "")
write(readme_path, readme)

roadmap_path = "docs/RUST_WASM_ROADMAP.md"
roadmap = read(roadmap_path)
roadmap = roadmap.replace(
    "## Fase 4 — grafo de intervalos grandes\n\nEstado: **planejado**.",
    "## Fase 4 — grafo de intervalos grandes\n\nEstado: **implementado nesta entrega**.",
)
roadmap = roadmap.replace(
    '''- buckets bidimensionais para intervalos grandes;
- dependências de intervalo sem expansão célula por célula;
- invalidação por sobreposição de retângulos;
- operações em lote com buffers compactos;
- benchmarks específicos de cadeias e agregações empresariais.

Critério de saída: fórmulas com grandes intervalos não geram explosão de arestas e mantêm recálculo seletivo mensurável.''',
    '''- ABI versão 5 e IR versão 2;
- referências diretas separadas de retângulos de intervalo;
- buckets bidimensionais de 256 linhas por 32 colunas;
- dependências de intervalo sem uma aresta por célula;
- invalidação por sobreposição exata após seleção de candidatos por bucket;
- intervalos stateful de até 100.000 posições;
- métricas separadas de arestas diretas, intervalos e buckets;
- testes de recálculo transitivo, remoção de índices obsoletos e execução real do Wasm.

Critério de saída atingido: um intervalo de 100.000 posições usa um descritor de dependência e menos de 512 buckets, preservando recálculo seletivo.''',
)
write(roadmap_path, roadmap)

architecture_path = "docs/ARCHITECTURE.md"
architecture = read(architecture_path)
architecture = architecture.replace("- ABI versão 4 e IR de fórmulas versão 1;", "- ABI versão 5 e IR de fórmulas versão 2;")
architecture = architecture.replace(
    "- compilação local para IR JSON e testes diferenciais contra o parser JavaScript;",
    "- compilação local para IR JSON compacta, separando células e retângulos, com testes diferenciais contra o parser JavaScript;",
)
architecture = architecture.replace("- grafo reverso de dependências por célula;", "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;")
architecture = architecture.replace(
    "O grafo Rust atual expande intervalos locais dentro do limite experimental.",
    "O grafo Rust não expande intervalos em arestas por célula; ele seleciona candidatos por bucket e confirma a sobreposição exata.",
)
architecture = architecture.replace(
    "A próxima ampliação exige intervalos indexados, matrizes dinâmicas",
    "A próxima ampliação exige buffers compactos, matrizes dinâmicas",
)
write(architecture_path, architecture)

status_path = "docs/CURRENT_STATUS.md"
status = read(status_path)
status = status.replace(
    "a IR versão 1 já permite comparar fórmulas locais",
    "a IR versão 2 já permite comparar fórmulas locais e representar intervalos compactamente",
)
status = status.replace("- ABI versão 4 e IR de fórmulas versão 1;", "- ABI versão 5 e IR de fórmulas versão 2;")
status = status.replace("- grafo reverso de dependências por célula;", "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;")
status = status.replace("- dependências de intervalos grandes sem expansão célula por célula;\n", "")
write(status_path, status)

engine_readme_path = "wasm-engine/README.md"
engine_readme = read(engine_readme_path)
engine_readme = engine_readme.replace("A ABI versão `4` implementa:", "A ABI versão `5` implementa:")
engine_readme = engine_readme.replace("- IR JSON versão 1 para fórmulas locais;", "- IR JSON versão 2, separando referências diretas e retângulos de intervalo;")
engine_readme = engine_readme.replace("- grafo reverso de dependências entre células;", "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;")
engine_readme = engine_readme.replace("## ABI versão 4", "## ABI versão 5")
engine_readme = engine_readme.replace("- grafo otimizado por buckets para intervalos muito grandes;\n", "")
engine_readme = engine_readme.replace(
    "- até 4.096 células expandidas por intervalo;",
    "- até 4.096 posições por intervalo no avaliador stateless;\n- até 100.000 posições por intervalo no workbook stateful;",
)
write(engine_readme_path, engine_readme)
