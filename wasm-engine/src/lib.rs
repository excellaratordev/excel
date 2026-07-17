use std::mem;
use std::slice;
use std::str;

pub const ABI_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Blank,
    Number(f64),
    Boolean(bool),
    Text(String),
    Formula(String),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellCoordinate {
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellPatch {
    pub coordinate: CellCoordinate,
    pub value: CellValue,
}

pub fn validate_operation_json(payload: &str) -> bool {
    let normalized = payload.trim();
    normalized.starts_with('{')
        && normalized.ends_with('}')
        && normalized.contains("\"id\"")
        && normalized.contains("\"kind\"")
        && normalized.len() <= 4 * 1024 * 1024
}

#[no_mangle]
pub extern "C" fn superexcel_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn superexcel_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_dealloc(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(pointer, 0, len));
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_validate_operation(pointer: *const u8, len: usize) -> u32 {
    if pointer.is_null() || len == 0 || len > 4 * 1024 * 1024 {
        return 0;
    }
    let bytes = slice::from_raw_parts(pointer, len);
    match str::from_utf8(bytes) {
        Ok(payload) if validate_operation_json(payload) => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_is_stable() {
        assert_eq!(superexcel_abi_version(), 1);
    }

    #[test]
    fn validates_operation_envelope() {
        assert!(validate_operation_json(r#"{"id":"op-1","kind":"cells.patch","changes":[]}"#));
        assert!(!validate_operation_json(r#"{"kind":"cells.patch"}"#));
    }

    #[test]
    fn cell_contract_supports_formulas() {
        let patch = CellPatch {
            coordinate: CellCoordinate { row: 2, col: 3 },
            value: CellValue::Formula("=A1+1".to_string()),
        };
        assert_eq!(patch.coordinate.row, 2);
    }
}
