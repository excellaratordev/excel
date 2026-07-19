(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  const parserApi = window.SuperExcelFormulaParser;
  const graphApi = window.SuperExcelDependencyGraph;
  const wasmApi = window.SuperExcelWasmFormulaEngine;
  if (!engineApi?.create) throw new Error('Runtime de cálculo não foi carregado.');

  const originalCreate = engineApi.create.bind(engineApi);
  const MAX_WASM_INPUT_CELLS = 4096;

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
      return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
    }
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }

  function buildInputs(runtime, ast, originalGetCellValue) {
    if (!parserApi?.collectDependencies) return null;
    const dependencies = parserApi.collectDependencies(ast);
    if (dependencies.external?.length) return null;
    let total = dependencies.cells?.size || 0;
    for (const range of dependencies.ranges || []) {
      total += (range.bottom - range.top + 1) * (range.right - range.left + 1);
      if (total > MAX_WASM_INPUT_CELLS) return null;
    }

    const cells = {};
    for (const key of dependencies.cells || []) {
      const [row, col] = String(key).split(':').map(Number);
      const value = originalGetCellValue({ row, col });
      if (value && typeof value === 'object') return null;
      cells[cellName(row, col)] = value;
    }
    for (const range of dependencies.ranges || []) {
      for (let row = range.top; row <= range.bottom; row += 1) {
        for (let col = range.left; col <= range.right; col += 1) {
          const value = originalGetCellValue({ row, col });
          if (value && typeof value === 'object') return null;
          cells[cellName(row, col)] = value;
        }
      }
    }
    return cells;
  }

  function installHybridEvaluation(runtime) {
    if (!wasmApi || !graphApi?.coordinateKey) return runtime;
    const originalGetCellValue = runtime.getCellValue.bind(runtime);
    const originalGetStats = runtime.getStats.bind(runtime);

    function evaluateRust(coordinate) {
      if (!wasmApi.ready || wasmApi.mode === 'off') return null;
      const row = Number(coordinate?.row) || 0;
      const col = Number(coordinate?.col) || 0;
      const key = graphApi.coordinateKey(row, col);
      const formula = runtime.raw?.get(key);
      const ast = runtime.parsed?.get(key);
      if (typeof formula !== 'string' || !formula.trimStart().startsWith('=') || !ast) return null;
      const cells = buildInputs(runtime, ast, originalGetCellValue);
      if (!cells) return null;
      return wasmApi.evaluateFormula(formula, cells);
    }

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
      wasm: wasmApi.getStats(),
    });
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
