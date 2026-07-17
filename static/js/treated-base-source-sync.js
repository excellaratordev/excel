(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const SYNC_DELAY_MS = 560;
  const DEPENDENCY_REFRESH_MS = 30000;
  const state = {
    ranges: [],
    hydrated: false,
    syncing: false,
    timer: null,
    dependencyTimer: null,
    dependencyRequest: null,
    pendingCells: new Map(),
    dependencySignature: '',
    enabled: true,
  };

  function normalizeCoordinates(cells) {
    const output = [];
    for (const item of cells || []) {
      const row = Number(item?.row ?? item?.r);
      const col = Number(item?.col ?? item?.c);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      output.push({ row, col });
    }
    return output;
  }

  function intersects(row, col) {
    return state.ranges.some(range => (
      row >= range.top && row <= range.bottom
      && col >= range.left && col <= range.right
    ));
  }

  function rememberRelevant(cells) {
    let relevant = false;
    for (const item of normalizeCoordinates(cells)) {
      if (!intersects(item.row, item.col)) continue;
      state.pendingCells.set(`${item.row}:${item.col}`, item);
      relevant = true;
    }
    return relevant;
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

  async function pendingOperations() {
    try {
      return Number(await window.SuperExcelOperationStore?.count?.(workbookId) || 0);
    } catch {
      return 0;
    }
  }

  async function currentRevision() {
    const response = await fetch(`/api/workbooks/${workbookId}/collaboration-config`, { cache: 'no-store' });
    const output = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(output.error || 'Não foi possível obter a revisão da Planilha.');
    return Number(output.revision || 0);
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

  async function loadDependencies({ capture = false } = {}) {
    if (!state.enabled || state.dependencyRequest) return state.dependencyRequest;
    state.dependencyRequest = (async () => {
      const response = await fetch(`/api/treated-bases/sources/${workbookId}/dependencies`, { cache: 'no-store' });
      const output = await response.json().catch(() => ({}));
      if (response.status === 409) {
        state.enabled = false;
        state.ranges = [];
        return [];
      }
      if (!response.ok) throw new Error(output.error || 'Falha ao carregar dependências da Base 2.');
      const ranges = normalizeRanges(output.ranges);
      const signature = JSON.stringify(ranges);
      const changed = signature !== state.dependencySignature;
      state.ranges = ranges;
      state.dependencySignature = signature;
      if ((capture || changed) && state.hydrated && ranges.length) scheduleSync(120);
      return ranges;
    })();
    try {
      return await state.dependencyRequest;
    } finally {
      state.dependencyRequest = null;
    }
  }

  async function syncCalculatedSnapshot() {
    if (!state.enabled || !state.hydrated || state.syncing || !state.ranges.length || !navigator.onLine) return;
    if (await pendingOperations() > 0) {
      scheduleSync(750);
      return;
    }
    state.syncing = true;
    const changedCells = [...state.pendingCells.values()];
    try {
      const revision = await currentRevision();
      const cells = captureCalculatedCells();
      const response = await fetch(`/api/treated-bases/sources/${workbookId}/calculated-snapshot`, {
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
      if (!response.ok) throw new Error(output.error || 'Falha ao sincronizar a Base 2.');
      state.pendingCells.clear();
      window.dispatchEvent(new CustomEvent('superexcel:treated-base-source-synced', {
        detail: {
          workbookId,
          revision,
          materialized: Number(output.materialized || 0),
          unchanged: Number(output.unchanged || 0),
          pending: Number(output.pending || 0),
        },
      }));
    } catch (error) {
      console.debug('Sincronização da Base 2 adiada.', error);
      scheduleSync(1500);
    } finally {
      state.syncing = false;
    }
  }

  function scheduleSync(delay = SYNC_DELAY_MS) {
    if (!state.enabled || !state.ranges.length) return;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = null;
      syncCalculatedSnapshot();
    }, delay);
  }

  function ensureDependencyPolling() {
    if (state.dependencyTimer) window.clearInterval(state.dependencyTimer);
    state.dependencyTimer = window.setInterval(() => {
      if (document.hidden || !navigator.onLine || !state.enabled) return;
      loadDependencies().catch(error => console.debug('Dependências da Base 2 indisponíveis.', error));
    }, DEPENDENCY_REFRESH_MS);
  }

  function handleChanges(cells) {
    if (rememberRelevant(cells)) scheduleSync();
    else if (!state.ranges.length) loadDependencies().catch(() => {});
  }

  window.addEventListener('superexcel:changes', event => handleChanges(event.detail?.changes));
  window.addEventListener('superexcel:rendered', event => handleChanges(event.detail?.coordinates));
  window.addEventListener('superexcel:hydrated', () => {
    state.hydrated = true;
    loadDependencies({ capture: true }).catch(error => console.debug('Dependências da Base 2 indisponíveis.', error));
    ensureDependencyPolling();
  });
  window.addEventListener('focus', () => {
    if (state.hydrated) loadDependencies().catch(() => {});
  });
  window.addEventListener('online', () => {
    if (state.hydrated) loadDependencies({ capture: true }).catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    if (state.timer) window.clearTimeout(state.timer);
    if (state.dependencyTimer) window.clearInterval(state.dependencyTimer);
  }, { once: true });
})();
