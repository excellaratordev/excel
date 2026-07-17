(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const layer = document.querySelector('#base-grid-layer');
  if (!layer) return;

  const DIRECT_REFERENCE_RE = /^\s*=\s*(?:'((?:''|[^'])+)'|([^'!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)\s*$/i;
  const state = {
    sources: [],
    sourceGroups: new Map(),
    bridges: new Map(),
    generation: 0,
    refreshTimer: null,
    pollTimer: null,
    initialized: false,
    lastWindow: '',
    persisted: new Map(),
    inflight: new Map(),
  };

  function api(path, options = {}) {
    return fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      cache: options.cache || 'no-store',
      ...options,
    }).then(async response => {
      const data = response.status === 204 ? null : await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.error || 'Erro ao calcular a fórmula da Base 2.');
        error.status = response.status;
        error.payload = data;
        throw error;
      }
      return data;
    });
  }

  function normalizedName(value) {
    return String(value || '').trim().toLocaleLowerCase('pt-BR');
  }

  function columnIndex(name) {
    let result = 0;
    for (const letter of String(name || '').toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
    return result - 1;
  }

  function parseFormula(value) {
    const match = DIRECT_REFERENCE_RE.exec(String(value || ''));
    if (!match) return null;
    const sourceName = String(match[1] !== undefined ? match[1].replaceAll("''", "'") : match[2] || '').trim();
    const row = Number(match[4]) - 1;
    const col = columnIndex(match[3]);
    if (!sourceName || row < 0 || col < 0) return null;
    return { sourceName, row, col, address: `${match[3].toUpperCase()}${row + 1}` };
  }

  function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return '[objeto]'; }
    }
    return String(value);
  }

  function stableValue(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  function visibleWindow() {
    const rows = [...layer.querySelectorAll(':scope > .base-grid-row[data-row-index]')];
    if (!rows.length) return null;
    const indexes = rows.map(row => Number(row.dataset.rowIndex)).filter(Number.isInteger);
    if (!indexes.length) return null;
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    return { first, last, rows };
  }

  function clearDecorations(rows) {
    for (const row of rows || []) {
      row.querySelectorAll('.base-grid-cell.has-treated-formula').forEach(cell => {
        cell.classList.remove('has-treated-formula', 'treated-formula-error', 'treated-formula-pending');
        cell.querySelector('.treated-formula-display')?.remove();
        const input = cell.querySelector('input');
        if (input) delete input.dataset.treatedFormula;
      });
    }
  }

  function overlayFor(cell, input, formula) {
    cell.classList.add('has-treated-formula', 'treated-formula-pending');
    let overlay = cell.querySelector('.treated-formula-display');
    if (!overlay) {
      overlay = document.createElement('span');
      overlay.className = 'treated-formula-display';
      cell.append(overlay);
    }
    overlay.textContent = 'Calculando…';
    overlay.title = formula;
    input.dataset.treatedFormula = formula;
    if (document.activeElement !== input && input.dataset.dirty !== 'true') {
      input.value = formula;
      input.dataset.original = formula;
      input.dataset.dirty = 'false';
    }
    return overlay;
  }

  function showTarget(target, value, mode = 'value') {
    const { cell, overlay, formula } = target;
    cell.classList.toggle('treated-formula-error', mode === 'error');
    cell.classList.toggle('treated-formula-pending', mode === 'pending');
    overlay.textContent = mode === 'pending' ? 'Calculando…' : formatValue(value);
    overlay.title = mode === 'error' ? `${formula}\n${String(value || 'Erro de cálculo')}` : formula;
  }

  function sourceFor(name) {
    const matches = state.sourceGroups.get(normalizedName(name)) || [];
    if (matches.length !== 1) return { source: null, ambiguous: matches.length > 1 };
    return { source: matches[0], ambiguous: false };
  }

  function ensureBridge(source) {
    const sourceId = Number(source.id);
    if (state.bridges.has(sourceId)) return state.bridges.get(sourceId);
    const iframe = document.createElement('iframe');
    iframe.className = 'treated-formula-runtime-frame';
    iframe.title = `Cálculo automático de ${source.name}`;
    iframe.src = `/sheet/${sourceId}?embedded=treated-base-formula`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    document.body.append(iframe);
    const bridge = {
      source,
      iframe,
      ready: false,
      targets: new Map(),
      subscriptionId: '',
    };
    state.bridges.set(sourceId, bridge);
    return bridge;
  }

  function sendSubscription(bridge) {
    if (!bridge.ready || !bridge.iframe.contentWindow) return;
    const cells = [...bridge.targets.keys()].map(key => {
      const [r, c] = key.split(':').map(Number);
      return { r, c };
    });
    bridge.subscriptionId = `base-${workbookId}-${state.generation}-${bridge.source.id}`;
    bridge.iframe.contentWindow.postMessage({
      type: 'superexcel:value-subscribe',
      workbookId: Number(bridge.source.id),
      subscriptionId: bridge.subscriptionId,
      cells,
    }, location.origin);
  }

  function queueResult(target, value) {
    const key = `${target.rowId}:${target.columnKey}:${target.formula}`;
    const signature = stableValue(value);
    if (state.persisted.get(key) === signature || state.inflight.get(key) === signature) return;
    state.inflight.set(key, signature);
    api(`/api/treated-bases/${workbookId}/rows/${target.rowId}/formula-result`, {
      method: 'POST',
      body: JSON.stringify({
        column_key: target.columnKey,
        formula: target.formula,
        value,
      }),
    }).then(() => {
      state.persisted.set(key, signature);
    }).catch(error => {
      if (error.status === 409) scheduleRefresh(180, true);
      else showTarget(target, error.message, 'error');
    }).finally(() => {
      if (state.inflight.get(key) === signature) state.inflight.delete(key);
    });
  }

  function handleBridgeValues(message) {
    const bridge = state.bridges.get(Number(message.workbookId));
    if (!bridge || message.subscriptionId !== bridge.subscriptionId) return;
    for (const item of message.values || []) {
      const targets = bridge.targets.get(`${Number(item.r)}:${Number(item.c)}`) || [];
      for (const target of targets) {
        if (target.generation !== state.generation) continue;
        const value = item.v;
        if (typeof value === 'string' && value.startsWith('#')) {
          showTarget(target, value, 'error');
          continue;
        }
        showTarget(target, value, 'value');
        queueResult(target, value);
      }
    }
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin) return;
    const message = event.data || {};
    const bridge = state.bridges.get(Number(message.workbookId));
    if (!bridge || event.source !== bridge.iframe.contentWindow) return;
    if (message.type === 'superexcel:value-bridge-ready') {
      bridge.ready = true;
      sendSubscription(bridge);
    } else if (message.type === 'superexcel:value-bridge-values') {
      handleBridgeValues(message);
    }
  });

  function applyMetadata(data, windowState) {
    state.generation += 1;
    clearDecorations(windowState.rows);
    state.bridges.forEach(bridge => bridge.targets.clear());

    const columns = [...(data.columns || [])].sort((a, b) => Number(a.position) - Number(b.position));
    const positionByKey = new Map(columns.map((column, index) => [String(column.column_key), index]));
    const elementsByIndex = new Map(windowState.rows.map(row => [Number(row.dataset.rowIndex), row]));

    for (const rowData of data.rows || []) {
      const rowElement = elementsByIndex.get(Number(rowData.index));
      if (!rowElement) continue;
      const cells = [...rowElement.querySelectorAll('.base-grid-cell:not(.system):not(.action)')];
      const formulas = rowData.formulas || {};
      for (const [columnKey, formula] of Object.entries(formulas)) {
        const position = positionByKey.get(String(columnKey));
        const cell = Number.isInteger(position) ? cells[position] : null;
        const input = cell?.querySelector('input');
        if (!cell || !input) continue;
        const overlay = overlayFor(cell, input, formula);
        const parsed = parseFormula(formula);
        const target = {
          generation: state.generation,
          rowId: Number(rowData.id),
          columnKey: String(columnKey),
          formula,
          cell,
          input,
          overlay,
        };
        if (!parsed) {
          showTarget(target, 'Use uma referência direta, por exemplo: =\'Planilha\'!A1', 'error');
          continue;
        }
        const located = sourceFor(parsed.sourceName);
        if (!located.source) {
          showTarget(target, located.ambiguous ? 'Nome de Planilha ambíguo' : 'Planilha não encontrada', 'error');
          continue;
        }
        const bridge = ensureBridge(located.source);
        const coordinate = `${parsed.row}:${parsed.col}`;
        if (!bridge.targets.has(coordinate)) bridge.targets.set(coordinate, []);
        bridge.targets.get(coordinate).push(target);
      }
    }
    state.bridges.forEach(sendSubscription);
  }

  async function refreshVisible(force = false) {
    state.refreshTimer = null;
    const windowState = visibleWindow();
    if (!windowState) return;
    const key = `${windowState.first}:${windowState.last}`;
    if (!force && key === state.lastWindow) return;
    state.lastWindow = key;
    try {
      const data = await api(`/api/treated-bases/${workbookId}/formula-rows?offset=${windowState.first}&limit=${windowState.last - windowState.first + 1}`);
      applyMetadata(data, windowState);
    } catch (error) {
      if (error.status !== 409) console.debug('Fórmulas da Base 2 indisponíveis.', error);
    }
  }

  function scheduleRefresh(delay = 100, force = false) {
    if (force) state.lastWindow = '';
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refreshVisible(force), delay);
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    try {
      const output = await api(`/api/treated-bases/${workbookId}/sources`);
      state.sources = Array.isArray(output.sources) ? output.sources : [];
      for (const source of state.sources) {
        const key = normalizedName(source.name);
        if (!state.sourceGroups.has(key)) state.sourceGroups.set(key, []);
        state.sourceGroups.get(key).push(source);
      }
    } catch (error) {
      if (error.status === 409) return;
      console.debug('Planilhas de origem indisponíveis para fórmulas.', error);
      return;
    }

    const observer = new MutationObserver(() => scheduleRefresh(80, true));
    observer.observe(layer, { childList: true });
    layer.addEventListener('focusout', () => scheduleRefresh(320, true));
    layer.addEventListener('input', event => {
      if (event.target instanceof HTMLInputElement) scheduleRefresh(700, true);
    });
    window.addEventListener('resize', () => scheduleRefresh());
    state.pollTimer = window.setInterval(() => {
      if (!document.hidden) scheduleRefresh(0, true);
    }, 8000);
    scheduleRefresh(0, true);

    window.addEventListener('pagehide', () => {
      observer.disconnect();
      if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      state.bridges.forEach(bridge => bridge.iframe.remove());
    }, { once: true });
  }

  window.SuperExcelAuth?.ready?.then(initialize).catch(error => console.debug('Fórmulas da Base 2 não iniciadas.', error));
})();
