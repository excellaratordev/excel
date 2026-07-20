(() => {
  'use strict';

  const contract = window.SuperExcelWasmContract;
  if (!contract) throw new Error('Contrato Rust/Wasm não foi carregado.');

  const ASSET_URL = '/static/wasm/superexcel_wasm_engine.wasm';
  const MODES = new Set(['off', 'shadow', 'prefer']);
  const state = {
    mode: configuredMode(),
    status: 'idle',
    error: null,
    engine: null,
    loadPromise: null,
    evaluations: 0,
    compilations: 0,
    successes: 0,
    fallbacks: 0,
    mismatches: 0,
    totalMs: 0,
    workbooksCreated: 0,
    workbooksDestroyed: 0,
    workbookReads: 0,
    workbookUpdates: 0,
    workbookFailures: 0,
  };

  function configuredMode() {
    const query = new URLSearchParams(location.search).get('wasm');
    let stored = null;
    try { stored = localStorage.getItem('superexcel.wasm.mode'); } catch { /* storage opcional */ }
    const value = String(query || stored || 'off').toLowerCase();
    return MODES.has(value) ? value : 'off';
  }

  function emit() {
    window.dispatchEvent(new CustomEvent('superexcel:wasm-engine', { detail: getStats() }));
  }

  async function load() {
    if (state.engine) return state.engine;
    if (state.loadPromise) return state.loadPromise;
    state.status = 'loading';
    state.error = null;
    emit();
    state.loadPromise = contract.instantiate(ASSET_URL)
      .then(engine => {
        state.engine = engine;
        state.status = 'ready';
        emit();
        return engine;
      })
      .catch(error => {
        state.status = 'error';
        state.error = error?.message || String(error);
        emit();
        throw error;
      })
      .finally(() => {
        state.loadPromise = null;
      });
    return state.loadPromise;
  }

  function matrixToCells(data) {
    const cells = {};
    const rows = Array.isArray(data) ? data : [];
    for (let row = 0; row < rows.length; row += 1) {
      const values = Array.isArray(rows[row]) ? rows[row] : [];
      for (let col = 0; col < values.length; col += 1) {
        const value = values[col];
        if (value === null || value === undefined || value === '') continue;
        cells[cellName(row, col)] = value;
      }
    }
    return cells;
  }

  function cellName(row, col) {
    let letters = '';
    for (let number = Number(col) + 1; number; number = Math.floor((number - 1) / 26)) {
      letters = String.fromCharCode(65 + ((number - 1) % 26)) + letters;
    }
    return `${letters}${Number(row) + 1}`;
  }

  function compileFormula(formula) {
    state.compilations += 1;
    if (!state.engine) {
      state.fallbacks += 1;
      return { status: 'unavailable', error: state.error || 'Núcleo Wasm ainda não carregado.' };
    }
    try {
      return state.engine.compileFormula(formula);
    } catch (error) {
      state.fallbacks += 1;
      return { status: 'error', error: error?.message || String(error) };
    }
  }

  function evaluateFormula(formula, cells = {}) {
    state.evaluations += 1;
    if (!state.engine) {
      state.fallbacks += 1;
      return { status: 'unavailable', error: state.error || 'Núcleo Wasm ainda não carregado.' };
    }
    const started = performance.now();
    try {
      const result = state.engine.evaluateFormula(formula, cells);
      if (result?.status === 'ok') state.successes += 1;
      else state.fallbacks += 1;
      return result;
    } catch (error) {
      state.fallbacks += 1;
      return { status: 'error', error: error?.message || String(error), value: '#ERRO!' };
    } finally {
      state.totalMs += performance.now() - started;
    }
  }

  function createWorkbook(data) {
    if (!state.engine) return { status: 'unavailable', error: 'Núcleo Wasm ainda não carregado.' };
    try {
      const result = state.engine.createWorkbook({ cells: matrixToCells(data) });
      if (result?.status === 'ok') state.workbooksCreated += 1;
      else state.workbookFailures += 1;
      return result;
    } catch (error) {
      state.workbookFailures += 1;
      return { status: 'error', error: error?.message || String(error), value: '#ERRO!' };
    }
  }

  function applyWorkbook(handle, changes) {
    if (!state.engine || !handle) return { status: 'unavailable', error: 'Workbook Wasm indisponível.' };
    try {
      const result = state.engine.applyWorkbook(handle, { changes });
      if (result?.status === 'ok') state.workbookUpdates += 1;
      else state.workbookFailures += 1;
      return result;
    } catch (error) {
      state.workbookFailures += 1;
      return { status: 'error', error: error?.message || String(error), value: '#ERRO!' };
    }
  }

  function getWorkbookCell(handle, cell) {
    state.evaluations += 1;
    state.workbookReads += 1;
    if (!state.engine || !handle) {
      state.fallbacks += 1;
      return { status: 'unavailable', error: 'Workbook Wasm indisponível.' };
    }
    const started = performance.now();
    try {
      const result = state.engine.getWorkbookCell(handle, cell);
      if (result?.status === 'ok') state.successes += 1;
      else state.fallbacks += 1;
      return result;
    } catch (error) {
      state.fallbacks += 1;
      state.workbookFailures += 1;
      return { status: 'error', error: error?.message || String(error), value: '#ERRO!' };
    } finally {
      state.totalMs += performance.now() - started;
    }
  }

  function getWorkbookStats(handle) {
    if (!state.engine || !handle) return null;
    try {
      const result = state.engine.getWorkbookStats(handle);
      return result?.status === 'ok' ? result.stats : null;
    } catch {
      return null;
    }
  }

  function destroyWorkbook(handle) {
    if (!state.engine || !handle) return false;
    try {
      const destroyed = state.engine.destroyWorkbook(handle);
      if (destroyed) state.workbooksDestroyed += 1;
      return destroyed;
    } catch {
      state.workbookFailures += 1;
      return false;
    }
  }

  function markMismatch() {
    state.mismatches += 1;
  }

  function setMode(mode, persist = true) {
    const normalized = String(mode || '').toLowerCase();
    if (!MODES.has(normalized)) throw new Error(`Modo Wasm inválido: ${mode}`);
    state.mode = normalized;
    if (persist) {
      try { localStorage.setItem('superexcel.wasm.mode', normalized); } catch { /* storage opcional */ }
    }
    if (normalized !== 'off') load().catch(error => console.debug('Rust/Wasm indisponível; JavaScript permanece autoritativo.', error));
    emit();
  }

  function getStats() {
    return {
      mode: state.mode,
      status: state.status,
      abi_version: contract.ABI_VERSION,
      evaluations: state.evaluations,
      compilations: state.compilations,
      successes: state.successes,
      fallbacks: state.fallbacks,
      mismatches: state.mismatches,
      average_ms: state.evaluations ? state.totalMs / state.evaluations : 0,
      workbooks_created: state.workbooksCreated,
      workbooks_destroyed: state.workbooksDestroyed,
      workbook_reads: state.workbookReads,
      workbook_updates: state.workbookUpdates,
      workbook_failures: state.workbookFailures,
      error: state.error,
    };
  }

  const api = Object.freeze({
    ASSET_URL,
    load,
    compileFormula,
    evaluateFormula,
    createWorkbook,
    applyWorkbook,
    getWorkbookCell,
    getWorkbookStats,
    destroyWorkbook,
    getStats,
    markMismatch,
    setMode,
    get mode() { return state.mode; },
    get ready() { return state.status === 'ready'; },
  });
  window.SuperExcelWasmFormulaEngine = api;

  if (state.mode !== 'off') {
    const start = () => load().catch(error => console.debug('Rust/Wasm indisponível; usando runtime JavaScript.', error));
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2500 });
    else setTimeout(start, 1200);
  }
})();
