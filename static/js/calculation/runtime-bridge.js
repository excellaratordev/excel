(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  const graphApi = window.SuperExcelDependencyGraph;
  const wasmApi = window.SuperExcelWasmFormulaEngine;
  if (!engineApi?.create) throw new Error('Runtime de cálculo não foi carregado.');

  const originalCreate = engineApi.create.bind(engineApi);

  function cellName(row, col) {
    let letters = '';
    for (let number = Number(col) + 1; number; number = Math.floor((number - 1) / 26)) {
      letters = String.fromCharCode(65 + ((number - 1) % 26)) + letters;
    }
    return `${letters}${Number(row) + 1}`;
  }

  function equivalent(left, right) {
    if (Object.is(left, right)) return true;
    if (typeof left === 'number' && typeof right === 'number') {
      return Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
    }
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }

  function normalizedRows(matrix) {
    if (!Array.isArray(matrix)) return [[matrix]];
    return matrix.map(row => (Array.isArray(row) ? row : [row]));
  }

  function installHybridEvaluation(runtime) {
    if (!wasmApi || !graphApi?.coordinateKey) return runtime;

    const originalGetCellValue = runtime.getCellValue.bind(runtime);
    const originalGetStats = runtime.getStats.bind(runtime);
    const originalSetCellContents = runtime.setCellContents.bind(runtime);
    const originalSuspendEvaluation = runtime.suspendEvaluation.bind(runtime);
    const originalResumeEvaluation = runtime.resumeEvaluation.bind(runtime);
    const originalUndo = runtime.undo.bind(runtime);
    const originalRedo = runtime.redo.bind(runtime);
    const originalDestroy = runtime.destroy.bind(runtime);

    let workbookHandle = 0;
    let mirrorDepth = 0;
    let disposed = false;
    const pendingChanges = new Map();

    function destroyWorkbook() {
      if (workbookHandle) wasmApi.destroyWorkbook(workbookHandle);
      workbookHandle = 0;
    }

    function ensureWorkbook() {
      if (disposed || wasmApi.mode === 'off' || !wasmApi.ready) return 0;
      if (workbookHandle) return workbookHandle;
      const created = wasmApi.createWorkbook(runtime.getSheetSerialized());
      if (created?.status !== 'ok' || !created.handle) return 0;
      workbookHandle = Number(created.handle);
      pendingChanges.clear();
      return workbookHandle;
    }

    function rebuildWorkbook() {
      destroyWorkbook();
      return ensureWorkbook();
    }

    function flushChanges() {
      if (disposed || mirrorDepth > 0 || !pendingChanges.size) return;
      const changes = Object.fromEntries(pendingChanges);
      pendingChanges.clear();
      const handle = ensureWorkbook();
      if (!handle) return;
      const result = wasmApi.applyWorkbook(handle, changes);
      if (result?.status !== 'ok') rebuildWorkbook();
    }

    function queueMatrix(origin, matrix) {
      const startRow = Number(origin?.row) || 0;
      const startCol = Number(origin?.col) || 0;
      const rows = normalizedRows(matrix);
      for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 1) {
        for (let colOffset = 0; colOffset < rows[rowOffset].length; colOffset += 1) {
          const value = rows[rowOffset][colOffset];
          pendingChanges.set(
            cellName(startRow + rowOffset, startCol + colOffset),
            value === undefined || value === '' ? null : value,
          );
        }
      }
    }

    function evaluateRust(coordinate) {
      if (wasmApi.mode === 'off' || !wasmApi.ready) return null;
      const row = Number(coordinate?.row) || 0;
      const col = Number(coordinate?.col) || 0;
      const key = graphApi.coordinateKey(row, col);
      const formula = runtime.raw?.get(key);
      if (typeof formula !== 'string' || !formula.trimStart().startsWith('=')) return null;
      const handle = ensureWorkbook();
      if (!handle) return null;
      const result = wasmApi.getWorkbookCell(handle, cellName(row, col));
      if (result?.status === 'ok' && Array.isArray(result.value)) return null;
      return result;
    }

    runtime.suspendEvaluation = () => {
      mirrorDepth += 1;
      return originalSuspendEvaluation();
    };

    runtime.resumeEvaluation = () => {
      const result = originalResumeEvaluation();
      mirrorDepth = Math.max(0, mirrorDepth - 1);
      if (mirrorDepth === 0) flushChanges();
      return result;
    };

    runtime.setCellContents = (origin, matrix) => {
      const result = originalSetCellContents(origin, matrix);
      queueMatrix(origin, matrix);
      if (mirrorDepth === 0) flushChanges();
      return result;
    };

    runtime.undo = () => {
      const result = originalUndo();
      pendingChanges.clear();
      rebuildWorkbook();
      return result;
    };

    runtime.redo = () => {
      const result = originalRedo();
      pendingChanges.clear();
      rebuildWorkbook();
      return result;
    };

    runtime.getCellValue = coordinate => {
      if (wasmApi.mode === 'prefer') {
        const rust = evaluateRust(coordinate);
        if (rust?.status === 'ok') return rust.value;
        return originalGetCellValue(coordinate);
      }

      const javascriptValue = originalGetCellValue(coordinate);
      if (wasmApi.mode === 'shadow') {
        const rust = evaluateRust(coordinate);
        if (rust?.status === 'ok' && !equivalent(rust.value, javascriptValue)) {
          wasmApi.markMismatch();
          console.debug('Divergência Rust/Wasm detectada; JavaScript preservado.', {
            coordinate,
            javascriptValue,
            rustValue: rust.value,
          });
        }
      }
      return javascriptValue;
    };

    runtime.getStats = () => ({
      ...originalGetStats(),
      wasm: {
        ...wasmApi.getStats(),
        workbook_handle: workbookHandle || null,
        workbook: workbookHandle ? wasmApi.getWorkbookStats(workbookHandle) : null,
      },
    });

    const onWasmState = () => {
      if (disposed) return;
      if (wasmApi.mode === 'off') destroyWorkbook();
      else if (wasmApi.ready) ensureWorkbook();
    };
    window.addEventListener('superexcel:wasm-engine', onWasmState);

    runtime.destroy = () => {
      disposed = true;
      window.removeEventListener('superexcel:wasm-engine', onWasmState);
      pendingChanges.clear();
      destroyWorkbook();
      return originalDestroy();
    };

    ensureWorkbook();
    return runtime;
  }

  engineApi.create = data => {
    const previous = window.SuperExcelCalculationRuntime;
    if (previous?.destroy) previous.destroy();
    const runtime = installHybridEvaluation(originalCreate(data));
    window.SuperExcelCalculationRuntime = runtime;
    window.dispatchEvent(new CustomEvent('superexcel:calculation-runtime', {
      detail: {
        name: engineApi.engineName,
        version: engineApi.engineVersion,
        wasm: wasmApi?.getStats?.() || null,
      },
    }));
    return runtime;
  };
})();
