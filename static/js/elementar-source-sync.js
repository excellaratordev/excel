(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const SYNC_DELAY_MS = 520;
  const DEPENDENCY_REFRESH_MS = 30000;
  const state = {
    ranges: [],
    timer: null,
    dependencyTimer: null,
    syncing: false,
    hydrated: false,
    pendingCells: new Map(),
    dependencySignature: '',
  };

  function intersects(row, col) {
    return state.ranges.some(range => (
      row >= range.top && row <= range.bottom
      && col >= range.left && col <= range.right
    ));
  }

  function rememberCells(cells) {
    let relevant = false;
    for (const item of cells || []) {
      const row = Number(item?.row ?? item?.r);
      const col = Number(item?.col ?? item?.c);
      if (!Number.isInteger(row) || !Number.isInteger(col) || !intersects(row, col)) continue;
      state.pendingCells.set(`${row}:${col}`, { row, col });
      relevant = true;
    }
    return relevant;
  }

  function jsonValue(runtime, row, col) {
    const coordinate = { sheet: 0, row, col };
    let value = runtime.getCellValue(coordinate);
    if (value && value.__superexcelTyped) value = value.value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) value = value.value;
    const type = String(runtime.getCellValueDetailedType?.(coordinate) || '');
    if (typeof value === 'number' && type.includes('DATE')) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + Math.floor(value));
      return { value: date.toISOString().slice(0, 10), type: 'DATE' };
    }
    if (value === undefined) value = null;
    return { value, type: type || null };
  }

  function captureCalculatedCells() {
    const runtime = window.SuperExcelActiveRuntime;
    if (!runtime?.getCellValue) return [];
    const seen = new Set();
    const output = [];
    for (const range of state.ranges) {
      for (let row = range.top; row <= range.bottom; row += 1) {
        for (let col = range.left; col <= range.right; col += 1) {
          const key = `${row}:${col}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const result = jsonValue(runtime, row, col);
          if (result.value === null || result.value === '') continue;
          const cell = { r: row, c: col, v: result.value };
          if (result.type) cell.t = result.type;
          output.push(cell);
        }
      }
    }
    return output;
  }

  async function pendingOperations() {
    try {
      return Number(await window.SuperExcelOperationStore?.count?.(workbookId) || 0);
    } catch {
      return 0;
    }
  }

  async function currentRevision() {
    const response = await fetch(`/api/workbooks/${workbookId}/collaboration-config`, { cache: 'no-store' });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Não foi possível obter a revisão atual.');
    return Number(output.revision || 0);
  }

  async function syncCalculatedSnapshot() {
    if (!state.hydrated || state.syncing || !state.ranges.length || !navigator.onLine) return;
    if (await pendingOperations() > 0) {
      scheduleSync(700);
      return;
    }
    state.syncing = true;
    const changedCells = [...state.pendingCells.values()];
    try {
      const revision = await currentRevision();
      const cells = captureCalculatedCells();
      const response = await fetch(`/api/elementar/sources/${workbookId}/calculated-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision, cells, changed_cells: changedCells }),
        keepalive: true,
      });
      const output = await response.json().catch(() => ({}));
      if (response.status === 409) {
        scheduleSync(900);
        return;
      }
      if (!response.ok) throw new Error(output.error || 'Falha ao sincronizar saída Elementar.');
      for (const item of changedCells) state.pendingCells.delete(`${item.row}:${item.col}`);
      window.dispatchEvent(new CustomEvent('superexcel:elementar-source-synced', {
        detail: {
          workbookId,
          revision,
          published: Number(output.published || 0),
          unchanged: Number(output.unchanged || 0),
          pending: Number(output.pending || 0),
        },
      }));
    } catch (error) {
      console.debug('Sincronização Elementar adiada.', error);
      scheduleSync(1400);
    } finally {
      state.syncing = false;
    }
  }

  function scheduleSync(delay = SYNC_DELAY_MS) {
    if (!state.ranges.length) return;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = null;
      syncCalculatedSnapshot();
    }, delay);
  }

  function normalizeRanges(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => ({
      top: Number(item?.top),
      bottom: Number(item?.bottom),
      left: Number(item?.left),
      right: Number(item?.right),
    })).filter(item => (
      Number.isInteger(item.top) && Number.isInteger(item.bottom)
      && Number.isInteger(item.left) && Number.isInteger(item.right)
      && item.top >= 0 && item.bottom >= item.top
      && item.left >= 0 && item.right >= item.left
    ));
  }

  async function loadDependencies({ capture = false } = {}) {
    const response = await fetch(`/api/elementar/sources/${workbookId}/dependencies`, { cache: 'no-store' });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Falha ao carregar dependências Elementar.');
    const ranges = normalizeRanges(output.ranges);
    const signature = JSON.stringify(ranges);
    const changed = signature !== state.dependencySignature;
    state.ranges = ranges;
    state.dependencySignature = signature;
    if ((capture || changed) && state.hydrated && ranges.length) scheduleSync(100);
  }

  function ensureDependencyPolling() {
    if (state.dependencyTimer) window.clearInterval(state.dependencyTimer);
    state.dependencyTimer = window.setInterval(() => {
      if (document.hidden || !navigator.onLine) return;
      loadDependencies().catch(error => console.debug('Dependências Elementar indisponíveis.', error));
    }, DEPENDENCY_REFRESH_MS);
  }

  window.addEventListener('superexcel:changes', event => {
    if (rememberCells(event.detail?.changes)) scheduleSync();
  });

  window.addEventListener('superexcel:rendered', event => {
    if (rememberCells(event.detail?.coordinates)) scheduleSync();
  });

  window.addEventListener('superexcel:hydrated', () => {
    state.hydrated = true;
    loadDependencies({ capture: true }).catch(error => console.debug('Dependências Elementar indisponíveis.', error));
    ensureDependencyPolling();
  });

  window.addEventListener('focus', () => {
    if (!state.hydrated) return;
    loadDependencies().catch(error => console.debug('Dependências Elementar indisponíveis.', error));
  });

  window.addEventListener('online', () => {
    if (!state.hydrated) return;
    loadDependencies({ capture: true }).catch(error => console.debug('Dependências Elementar indisponíveis.', error));
  });

  window.addEventListener('pagehide', () => {
    if (state.timer) window.clearTimeout(state.timer);
    if (state.dependencyTimer) window.clearInterval(state.dependencyTimer);
  });
})();
