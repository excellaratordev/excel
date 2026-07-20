use super::{
    cell_name, collect_dependencies, parse_cell_reference, write_result, Ast, EngineError,
    Evaluator, Parser, Value, MAX_PAYLOAD_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::slice;
use std::str;
use std::sync::{Mutex, OnceLock};

const MAX_WORKBOOK_CELLS: usize = 100_000;
const MAX_WORKBOOK_CHANGES: usize = 10_000;

#[derive(Debug, Deserialize)]
struct WorkbookCreateRequest {
    #[serde(default)]
    cells: HashMap<String, JsonValue>,
}

#[derive(Debug, Deserialize)]
struct WorkbookApplyRequest {
    #[serde(default)]
    changes: HashMap<String, JsonValue>,
}

#[derive(Debug, Deserialize)]
struct WorkbookCellRequest {
    cell: String,
}

#[derive(Debug, Clone)]
struct FormulaNode {
    ast: Ast,
    dependencies: BTreeSet<String>,
}

#[derive(Debug, Clone)]
enum FormulaState {
    Ready(FormulaNode),
    Failed(EngineError),
}

#[derive(Debug, Serialize)]
struct WorkbookStats {
    revision: u64,
    stored_cells: usize,
    formula_cells: usize,
    dependency_edges: usize,
    cache_entries: usize,
    cache_hits: u64,
    cache_misses: u64,
    recalculations: u64,
    updates: u64,
    last_affected: Vec<String>,
}

#[derive(Debug)]
struct Workbook {
    raw: HashMap<String, JsonValue>,
    formulas: HashMap<String, FormulaState>,
    reverse_dependencies: HashMap<String, BTreeSet<String>>,
    cache: HashMap<String, Value>,
    revision: u64,
    cache_hits: u64,
    cache_misses: u64,
    recalculations: u64,
    updates: u64,
    last_affected: Vec<String>,
}

impl Workbook {
    fn empty() -> Self {
        Self {
            raw: HashMap::new(),
            formulas: HashMap::new(),
            reverse_dependencies: HashMap::new(),
            cache: HashMap::new(),
            revision: 0,
            cache_hits: 0,
            cache_misses: 0,
            recalculations: 0,
            updates: 0,
            last_affected: Vec::new(),
        }
    }

    fn from_cells(cells: HashMap<String, JsonValue>) -> Result<Self, EngineError> {
        if cells.len() > MAX_WORKBOOK_CELLS {
            return Err(EngineError::unsupported(format!(
                "Workbook excede o limite experimental de {MAX_WORKBOOK_CELLS} células."
            )));
        }
        let mut workbook = Self::empty();
        let mut entries: Vec<(String, JsonValue)> = cells.into_iter().collect();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        for (cell, value) in entries {
            let key = normalize_cell_key(&cell)?;
            workbook.define_cell(key, value);
        }
        Ok(workbook)
    }

    fn define_cell(&mut self, key: String, value: JsonValue) {
        self.remove_formula(&key);
        self.cache.remove(&key);

        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            self.raw.remove(&key);
            return;
        }

        self.raw.insert(key.clone(), value.clone());
        let Some(formula) = formula_text(&value) else {
            return;
        };

        let state = match Parser::new(formula).and_then(Parser::parse) {
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
        self.formulas.insert(key, state);
    }

    fn remove_formula(&mut self, key: &str) {
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
    }

    fn apply_changes(
        &mut self,
        changes: HashMap<String, JsonValue>,
    ) -> Result<Vec<String>, EngineError> {
        if changes.len() > MAX_WORKBOOK_CHANGES {
            return Err(EngineError::unsupported(format!(
                "Lote excede o limite experimental de {MAX_WORKBOOK_CHANGES} alterações."
            )));
        }
        if self.raw.len().saturating_add(changes.len())
            > MAX_WORKBOOK_CELLS.saturating_add(MAX_WORKBOOK_CHANGES)
        {
            return Err(EngineError::unsupported(
                "Workbook excederia o limite experimental de células.",
            ));
        }

        let mut normalized = Vec::with_capacity(changes.len());
        for (cell, value) in changes {
            normalized.push((normalize_cell_key(&cell)?, value));
        }
        normalized.sort_by(|left, right| left.0.cmp(&right.0));

        let changed: BTreeSet<String> = normalized.iter().map(|(key, _)| key.clone()).collect();
        for (key, value) in normalized {
            self.define_cell(key, value);
        }

        let affected = self.collect_affected(&changed);
        for key in &affected {
            self.cache.remove(key);
        }
        self.revision = self.revision.saturating_add(1);
        self.updates = self.updates.saturating_add(changed.len() as u64);
        self.last_affected = affected.iter().cloned().collect();
        Ok(self.last_affected.clone())
    }

    fn collect_affected(&self, changed: &BTreeSet<String>) -> BTreeSet<String> {
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
    }

    fn evaluate_cell(&mut self, cell: &str) -> Result<(String, Value), EngineError> {
        let key = normalize_cell_key(cell)?;
        let mut stack = HashSet::new();
        let value = self.evaluate_cell_inner(&key, &mut stack)?;
        Ok((key, value))
    }

    fn evaluate_cell_inner(
        &mut self,
        key: &str,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if let Some(value) = self.cache.get(key).cloned() {
            self.cache_hits = self.cache_hits.saturating_add(1);
            return Ok(value);
        }

        let raw = self.raw.get(key).cloned().unwrap_or(JsonValue::Null);
        if formula_text(&raw).is_none() {
            return Ok(Value::from_json(&raw));
        }

        if stack.contains(key) {
            return Ok(Value::Error("#CIRC!".into()));
        }

        self.cache_misses = self.cache_misses.saturating_add(1);
        let state = self
            .formulas
            .get(key)
            .cloned()
            .ok_or_else(|| EngineError::syntax("Fórmula sem estado compilado."))?;
        let node = match state {
            FormulaState::Ready(node) => node,
            FormulaState::Failed(error) => return Err(error),
        };

        stack.insert(key.to_string());
        let mut resolved = HashMap::with_capacity(node.dependencies.len());
        for dependency in &node.dependencies {
            let value = self.evaluate_cell_inner(dependency, stack)?;
            resolved.insert(dependency.clone(), value.to_json());
        }
        let result = (Evaluator { cells: &resolved }).evaluate(&node.ast);
        stack.remove(key);

        let value = result?;
        self.recalculations = self.recalculations.saturating_add(1);
        self.cache.insert(key.to_string(), value.clone());
        Ok(value)
    }

    fn stats(&self) -> WorkbookStats {
        WorkbookStats {
            revision: self.revision,
            stored_cells: self.raw.len(),
            formula_cells: self.formulas.len(),
            dependency_edges: self.reverse_dependencies.values().map(BTreeSet::len).sum(),
            cache_entries: self.cache.len(),
            cache_hits: self.cache_hits,
            cache_misses: self.cache_misses,
            recalculations: self.recalculations,
            updates: self.updates,
            last_affected: self.last_affected.clone(),
        }
    }
}

#[derive(Default)]
struct WorkbookRegistry {
    next_handle: u32,
    workbooks: HashMap<u32, Workbook>,
}

impl WorkbookRegistry {
    fn insert(&mut self, workbook: Workbook) -> u32 {
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        while self.workbooks.contains_key(&self.next_handle) {
            self.next_handle = self.next_handle.wrapping_add(1).max(1);
        }
        let handle = self.next_handle;
        self.workbooks.insert(handle, workbook);
        handle
    }
}

fn registry() -> &'static Mutex<WorkbookRegistry> {
    static REGISTRY: OnceLock<Mutex<WorkbookRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(WorkbookRegistry::default()))
}

fn normalize_cell_key(value: &str) -> Result<String, EngineError> {
    parse_cell_reference(value).map(|reference| cell_name(&reference))
}

fn formula_text(value: &JsonValue) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| value.starts_with('='))
}

unsafe fn parse_payload<T: for<'de> Deserialize<'de>>(
    pointer: *const u8,
    len: usize,
) -> Result<T, String> {
    if pointer.is_null() || len == 0 || len > MAX_PAYLOAD_BYTES {
        return Err("Payload inválido.".into());
    }
    let bytes = slice::from_raw_parts(pointer, len);
    let payload = str::from_utf8(bytes).map_err(|_| "Payload não está em UTF-8.".to_string())?;
    serde_json::from_str(payload).map_err(|error| format!("JSON inválido: {error}"))
}

fn write_json(value: JsonValue) -> *mut u8 {
    write_result(serde_json::to_string(&value).unwrap_or_else(|_| {
        r##"{"status":"error","value":"#ERRO!","error":"Falha ao serializar resposta."}"##.into()
    }))
}

fn error_json(error: EngineError) -> JsonValue {
    json!({
        "status": if error.unsupported { "unsupported" } else { "error" },
        "value": error.code,
        "value_type": "error",
        "error": error.message,
    })
}

fn missing_workbook(handle: u32) -> JsonValue {
    json!({
        "status": "error",
        "value": "#REF!",
        "value_type": "error",
        "error": format!("Workbook Wasm inexistente: {handle}."),
    })
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_workbook_create(pointer: *const u8, len: usize) -> *mut u8 {
    let request = match parse_payload::<WorkbookCreateRequest>(pointer, len) {
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
    let workbook = match Workbook::from_cells(request.cells) {
        Ok(workbook) => workbook,
        Err(error) => return write_json(error_json(error)),
    };
    let stats = workbook.stats();
    let handle = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(workbook);
    write_json(json!({
        "status": "ok",
        "handle": handle,
        "revision": stats.revision,
        "stats": stats,
    }))
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_workbook_apply(
    handle: u32,
    pointer: *const u8,
    len: usize,
) -> *mut u8 {
    let request = match parse_payload::<WorkbookApplyRequest>(pointer, len) {
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
    match workbook.apply_changes(request.changes) {
        Ok(affected) => write_json(json!({
            "status": "ok",
            "revision": workbook.revision,
            "affected": affected,
            "stats": workbook.stats(),
        })),
        Err(error) => write_json(error_json(error)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_workbook_get_cell(
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
    match workbook.evaluate_cell(&request.cell) {
        Ok((cell, value)) => write_json(json!({
            "status": "ok",
            "cell": cell,
            "value": value.to_json(),
            "value_type": value.value_type(),
            "revision": workbook.revision,
        })),
        Err(error) => {
            let mut response = error_json(error);
            if let Some(object) = response.as_object_mut() {
                object.insert("cell".into(), json!(request.cell));
                object.insert("revision".into(), json!(workbook.revision));
            }
            write_json(response)
        }
    }
}

#[no_mangle]
pub extern "C" fn superexcel_workbook_stats(handle: u32) -> *mut u8 {
    let registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(workbook) = registry.workbooks.get(&handle) else {
        return write_json(missing_workbook(handle));
    };
    write_json(json!({
        "status": "ok",
        "handle": handle,
        "stats": workbook.stats(),
    }))
}

#[no_mangle]
pub extern "C" fn superexcel_workbook_destroy(handle: u32) -> u32 {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .workbooks
        .remove(&handle)
        .is_some() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workbook(cells: JsonValue) -> Workbook {
        Workbook::from_cells(serde_json::from_value(cells).expect("mapa de células válido"))
            .expect("workbook válido")
    }

    #[test]
    fn recalculates_transitive_formula_chain() {
        let mut workbook = workbook(json!({
            "A1": 2,
            "B1": "=A1*3",
            "C1": "=B1+1",
        }));
        assert_eq!(workbook.evaluate_cell("C1").unwrap().1, Value::Number(7.0));
        let affected = workbook
            .apply_changes(HashMap::from([("A1".into(), json!(4))]))
            .unwrap();
        assert_eq!(affected, vec!["A1", "B1", "C1"]);
        assert_eq!(workbook.evaluate_cell("C1").unwrap().1, Value::Number(13.0));
    }

    #[test]
    fn preserves_unaffected_cache_entries() {
        let mut workbook = workbook(json!({
            "A1": 2,
            "B1": "=A1*3",
            "C1": "=B1+1",
            "D1": "=10+1",
        }));
        workbook.evaluate_cell("C1").unwrap();
        workbook.evaluate_cell("D1").unwrap();
        assert_eq!(workbook.cache.len(), 3);
        workbook
            .apply_changes(HashMap::from([("A1".into(), json!(5))]))
            .unwrap();
        assert_eq!(workbook.cache.len(), 1);
        assert!(workbook.cache.contains_key("D1"));
    }

    #[test]
    fn detects_cycles_without_recursing_forever() {
        let mut workbook = workbook(json!({
            "A1": "=B1+1",
            "B1": "=A1+1",
        }));
        assert_eq!(
            workbook.evaluate_cell("A1").unwrap().1,
            Value::Error("#CIRC!".into())
        );
    }

    #[test]
    fn keeps_unsupported_formulas_for_javascript_fallback() {
        let mut workbook = workbook(json!({
            "A1": 10,
            "B1": "=FILTRO(C1:C2;D1:D2)",
        }));
        let error = workbook.evaluate_cell("B1").unwrap_err();
        assert!(error.unsupported);
    }
}
