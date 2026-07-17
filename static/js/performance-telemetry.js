(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  if (!workbookId) return;

  const SAMPLE_INTERVAL_MS = 15000;
  const changedValues = new Map();
  let initialPayload = null;
  let sparseValues = null;
  let filledCells = 0;
  let formulaCells = 0;
  let sendTimer = null;
  let sending = false;

  function isFilled(value) {
    return value !== null && value !== undefined && value !== '';
  }

  function isFormula(value) {
    return typeof value === 'string' && value.trimStart().startsWith('=');
  }

  function initializeCounts() {
    if (initialPayload) return;
    const payload = window.SuperExcelInitialWorkbook;
    if (!payload || typeof payload !== 'object') return;

    initialPayload = payload;
    const cells = Array.isArray(payload.cells) ? payload.cells : [];
    const sparse = payload.storage === 'sparse' || (cells.length && !Array.isArray(cells[0]));

    if (sparse) {
      sparseValues = new Map();
      for (const item of cells) {
        const row = Number(item?.r);
        const col = Number(item?.c);
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
        const value = item?.v;
        sparseValues.set(`${row}:${col}`, value);
        if (isFilled(value)) filledCells += 1;
        if (isFormula(value)) formulaCells += 1;
      }
      return;
    }

    for (const row of cells) {
      if (!Array.isArray(row)) continue;
      for (const value of row) {
        if (isFilled(value)) filledCells += 1;
        if (isFormula(value)) formulaCells += 1;
      }
    }
  }

  function initialValue(row, col) {
    initializeCounts();
    const key = `${row}:${col}`;
    if (changedValues.has(key)) return changedValues.get(key);
    if (sparseValues) return sparseValues.get(key) ?? null;
    return initialPayload?.cells?.[row]?.[col] ?? null;
  }

  function applyChanges(changes) {
    initializeCounts();
    for (const change of Array.isArray(changes) ? changes : []) {
      const row = Number(change?.row);
      const col = Number(change?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      const key = `${row}:${col}`;
      const previous = initialValue(row, col);
      const next = change?.value ?? null;
      if (isFilled(previous) !== isFilled(next)) filledCells += isFilled(next) ? 1 : -1;
      if (isFormula(previous) !== isFormula(next)) formulaCells += isFormula(next) ? 1 : -1;
      changedValues.set(key, next);
    }
  }

  function collectMetrics() {
    initializeCounts();
    const memory = performance.memory || {};
    const gridSize = window.SuperExcelGridSize || {};
    const rows = Math.max(0, Number(gridSize.rows || initialPayload?.rows || 0));
    const cols = Math.max(0, Number(gridSize.cols || initialPayload?.cols || 0));
    const result = {
      dom_cells: document.querySelectorAll('#spreadsheet .cell').length,
      loaded_cells: rows * cols,
      filled_cells: Math.max(0, filledCells),
      formula_cells: Math.max(0, formulaCells),
      pending_operations: 0,
    };

    if (Number.isFinite(memory.usedJSHeapSize)) result.heap_used_bytes = memory.usedJSHeapSize;
    if (Number.isFinite(memory.totalJSHeapSize)) result.heap_total_bytes = memory.totalJSHeapSize;
    if (Number.isFinite(memory.jsHeapSizeLimit)) result.heap_limit_bytes = memory.jsHeapSizeLimit;
    if (Number.isFinite(navigator.deviceMemory)) result.device_memory_gb = navigator.deviceMemory;
    return result;
  }

  async function send() {
    if (sending || document.hidden || !navigator.onLine) return;
    sending = true;
    try {
      const metrics = collectMetrics();
      if (window.SuperExcelOperationStore?.count) {
        metrics.pending_operations = await window.SuperExcelOperationStore.count(workbookId);
      }
      const response = await fetch(`/api/workbooks/${workbookId}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_version: 'foundation-v1', metrics }),
        keepalive: true,
      });
      if (!response.ok) {
        const output = await response.json().catch(() => ({}));
        throw new Error(output.error || 'Falha ao registrar telemetria.');
      }
    } catch (error) {
      console.debug('Telemetria não enviada.', error);
    } finally {
      sending = false;
    }
  }

  function scheduleSoon() {
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(send, 1000);
  }

  window.addEventListener('superexcel:changes', event => {
    applyChanges(event.detail?.changes);
    scheduleSoon();
  });
  window.addEventListener('online', scheduleSoon);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleSoon();
  });

  Promise.resolve(window.SuperExcelAuth?.ready)
    .catch(() => null)
    .finally(() => {
      window.setTimeout(send, 2000);
      window.setInterval(send, SAMPLE_INTERVAL_MS);
    });
})();
