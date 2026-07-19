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
    successes: 0,
    fallbacks: 0,
    mismatches: 0,
    totalMs: 0,
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
      successes: state.successes,
      fallbacks: state.fallbacks,
      mismatches: state.mismatches,
      average_ms: state.evaluations ? state.totalMs / state.evaluations : 0,
      error: state.error,
    };
  }

  const api = Object.freeze({
    ASSET_URL,
    load,
    evaluateFormula,
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
