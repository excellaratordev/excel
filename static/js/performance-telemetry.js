(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const memoryDisplay = document.querySelector('#memory-usage');
  const SAMPLE_INTERVAL_MS = 60000;
  const MEMORY_DISPLAY_INTERVAL_MS = 1000;
  const DETAILED_MEMORY_REFRESH_MS = 30000;
  const MEBIBYTE = 1024 * 1024;
  const changedValues = new Map();
  let initialPayload = null;
  let sparseValues = null;
  let filledCells = 0;
  let formulaCells = 0;
  let sendTimer = null;
  let sending = false;
  let latestMemorySnapshot = null;
  let detailedMeasurementPromise = null;

  function isFilled(value) {
    return value !== null && value !== undefined && value !== '';
  }

  function isFormula(value) {
    return typeof value === 'string' && value.trimStart().startsWith('=');
  }

  function finitePositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function directMemorySnapshot() {
    const memory = performance.memory;
    const usedBytes = finitePositive(memory?.usedJSHeapSize);
    if (usedBytes === null) return null;
    return {
      usedBytes,
      totalBytes: finitePositive(memory?.totalJSHeapSize),
      limitBytes: finitePositive(memory?.jsHeapSizeLimit),
      source: 'performance.memory',
      measuredAt: Date.now(),
    };
  }

  async function detailedMemorySnapshot() {
    const direct = directMemorySnapshot();
    if (direct) {
      latestMemorySnapshot = direct;
      return direct;
    }

    if (latestMemorySnapshot && Date.now() - latestMemorySnapshot.measuredAt < DETAILED_MEMORY_REFRESH_MS) {
      return latestMemorySnapshot;
    }

    if (!window.crossOriginIsolated || typeof performance.measureUserAgentSpecificMemory !== 'function') return null;
    if (detailedMeasurementPromise) return detailedMeasurementPromise;

    detailedMeasurementPromise = performance.measureUserAgentSpecificMemory()
      .then(result => {
        const usedBytes = finitePositive(result?.bytes);
        if (usedBytes === null) return null;
        latestMemorySnapshot = {
          usedBytes,
          totalBytes: null,
          limitBytes: null,
          source: 'measureUserAgentSpecificMemory',
          measuredAt: Date.now(),
        };
        return latestMemorySnapshot;
      })
      .catch(error => {
        console.debug('Medição detalhada de memória indisponível.', error);
        return null;
      })
      .finally(() => {
        detailedMeasurementPromise = null;
      });

    return detailedMeasurementPromise;
  }

  function formatMemory(bytes) {
    const megabytes = Math.max(0, Number(bytes) || 0) / MEBIBYTE;
    const maximumFractionDigits = megabytes < 100 ? 1 : 0;
    return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits, minimumFractionDigits: megabytes < 10 ? 1 : 0 }).format(megabytes)} MB`;
  }

  function memoryState(snapshot) {
    if (!snapshot) return 'unsupported';
    if (!snapshot.limitBytes) return 'normal';
    const ratio = snapshot.usedBytes / snapshot.limitBytes;
    if (ratio >= 0.75) return 'danger';
    if (ratio >= 0.5) return 'warning';
    return 'normal';
  }

  function renderMemory(snapshot) {
    if (!memoryDisplay) return;
    if (!snapshot) {
      memoryDisplay.textContent = 'RAM: n/d';
      memoryDisplay.dataset.memoryState = 'unsupported';
      memoryDisplay.title = 'Este navegador não disponibiliza uma medição confiável da memória usada pela aba.';
      memoryDisplay.setAttribute('aria-label', 'Uso de memória RAM indisponível neste navegador');
      return;
    }

    const formattedUsed = formatMemory(snapshot.usedBytes);
    memoryDisplay.textContent = `RAM: ${formattedUsed}`;
    memoryDisplay.dataset.memoryState = memoryState(snapshot);
    const limitText = snapshot.limitBytes ? ` de ${formatMemory(snapshot.limitBytes)} disponíveis para o heap` : '';
    const sourceText = snapshot.source === 'performance.memory'
      ? 'Memória JavaScript usada pela aba da planilha'
      : 'Memória atribuída pelo navegador à aba da planilha';
    memoryDisplay.title = `${sourceText}: ${formattedUsed}${limitText}. Atualização a cada segundo.`;
    memoryDisplay.setAttribute('aria-label', `Uso de memória RAM da planilha: ${formattedUsed}`);
  }

  async function updateMemoryDisplay() {
    const snapshot = await detailedMemorySnapshot();
    renderMemory(snapshot);
    if (snapshot) {
      window.dispatchEvent(new CustomEvent('superexcel:memory', { detail: { ...snapshot } }));
    }
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
    const memory = directMemorySnapshot() || latestMemorySnapshot || {};
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

    const runtimeStats = window.SuperExcelCalculationRuntime?.getStats?.() || {};
    for (const key of [
      'dependency_nodes',
      'dependency_edges',
      'cache_bytes',
      'cache_hit_ratio',
      'calculation_ms',
    ]) {
      if (Number.isFinite(runtimeStats[key])) result[key] = runtimeStats[key];
    }

    if (Number.isFinite(memory.usedBytes)) result.heap_used_bytes = memory.usedBytes;
    if (Number.isFinite(memory.totalBytes)) result.heap_total_bytes = memory.totalBytes;
    if (Number.isFinite(memory.limitBytes)) result.heap_limit_bytes = memory.limitBytes;
    if (Number.isFinite(navigator.deviceMemory)) result.device_memory_gb = navigator.deviceMemory;
    return result;
  }

  async function send() {
    if (!workbookId || sending || document.hidden || !navigator.onLine) return;
    sending = true;
    try {
      const metrics = collectMetrics();
      if (window.SuperExcelOperationStore?.count) {
        metrics.pending_operations = await window.SuperExcelOperationStore.count(workbookId);
      }
      const response = await fetch(`/api/workbooks/${workbookId}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_version: 'custom-runtime-v1', metrics }),
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
    if (!workbookId) return;
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(send, 1000);
  }

  window.SuperExcelMemoryMonitor = {
    formatMemory,
    read: directMemorySnapshot,
    refresh: updateMemoryDisplay,
  };

  function startMemoryMonitor() {
    updateMemoryDisplay();
    window.setInterval(() => {
      if (!document.hidden) updateMemoryDisplay();
    }, MEMORY_DISPLAY_INTERVAL_MS);
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(startMemoryMonitor, { timeout: 2500 });
  } else {
    window.setTimeout(startMemoryMonitor, 1600);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateMemoryDisplay();
      scheduleSoon();
    }
  });

  if (!workbookId) return;

  window.addEventListener('superexcel:changes', event => {
    applyChanges(event.detail?.changes);
    updateMemoryDisplay();
    scheduleSoon();
  });
  window.addEventListener('superexcel:calculation-runtime', () => {
    updateMemoryDisplay();
    scheduleSoon();
  });
  window.addEventListener('online', scheduleSoon);

  Promise.resolve(window.SuperExcelAuth?.ready)
    .catch(() => null)
    .finally(() => {
      const startTelemetry = () => {
        send();
        window.setInterval(send, SAMPLE_INTERVAL_MS);
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(startTelemetry, { timeout: 10000 });
      } else {
        window.setTimeout(startTelemetry, 8000);
      }
    });
})();
