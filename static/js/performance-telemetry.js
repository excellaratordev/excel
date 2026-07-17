(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  if (!workbookId) return;

  const SAMPLE_INTERVAL_MS = 15000;
  let sendTimer = null;
  let sending = false;

  function currentSnapshot() {
    try {
      const serialized = window.SuperExcelApp?.serialize?.();
      if (serialized && typeof serialized === 'object') return serialized;
    } catch (error) {
      console.debug('Snapshot indisponível para telemetria.', error);
    }
    return window.SuperExcelInitialWorkbook || {};
  }

  function workbookCounts(payload) {
    const cells = Array.isArray(payload?.cells) ? payload.cells : [];
    let filledCells = 0;
    let formulaCells = 0;

    if (payload?.storage === 'sparse' || (cells.length && !Array.isArray(cells[0]))) {
      for (const item of cells) {
        const value = item?.v;
        if (value === null || value === undefined || value === '') continue;
        filledCells += 1;
        if (typeof value === 'string' && value.trimStart().startsWith('=')) formulaCells += 1;
      }
    } else {
      for (const row of cells) {
        if (!Array.isArray(row)) continue;
        for (const value of row) {
          if (value === null || value === undefined || value === '') continue;
          filledCells += 1;
          if (typeof value === 'string' && value.trimStart().startsWith('=')) formulaCells += 1;
        }
      }
    }

    return { filledCells, formulaCells };
  }

  function metrics() {
    const snapshot = currentSnapshot();
    const counts = workbookCounts(snapshot);
    const memory = performance.memory || {};
    const gridSize = window.SuperExcelGridSize || {};
    const rows = Math.max(0, Number(gridSize.rows || snapshot.rows || 0));
    const cols = Math.max(0, Number(gridSize.cols || snapshot.cols || 0));

    const result = {
      dom_cells: document.querySelectorAll('#spreadsheet .cell').length,
      loaded_cells: rows * cols,
      filled_cells: counts.filledCells,
      formula_cells: counts.formulaCells,
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
      const response = await fetch(`/api/workbooks/${workbookId}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_version: 'foundation-v1',
          metrics: metrics(),
        }),
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

  window.addEventListener('superexcel:changes', scheduleSoon);
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
