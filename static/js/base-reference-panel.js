(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const parserApi = window.SuperExcelFormulaParser;
  const engineApi = window.SuperExcelFormulaEngine;
  const panel = document.querySelector('#base-reference-panel');
  const modeButton = document.querySelector('#base-reference-mode-button');
  const closeButton = document.querySelector('#base-reference-close');
  const refreshButton = document.querySelector('#base-reference-refresh');
  const select = document.querySelector('#base-reference-select');
  const grid = document.querySelector('#base-reference-grid');
  const canvas = document.querySelector('#base-reference-canvas');
  const status = document.querySelector('#base-reference-status');
  const selectionLabel = document.querySelector('#base-reference-selection');
  const formulaInput = document.querySelector('#formula-input');

  if (!parserApi || !engineApi || !panel || !modeButton || !select || !grid || !canvas || !formulaInput) return;

  const ROW_HEIGHT = 28;
  const COL_WIDTH = 132;
  const HEADER_HEIGHT = 30;
  const ROW_HEADER_WIDTH = 42;
  const PAGE_SIZE = 200;
  const OVERSCAN_ROWS = 8;
  const OVERSCAN_COLS = 2;
  const POLL_MS = 15000;

  const state = {
    initialized: false,
    role: 'viewer',
    sources: [],
    source: null,
    sourceRevision: 0,
    columns: [],
    totalRows: 0,
    rowCache: new Map(),
    pages: new Map(),
    selection: null,
    drag: null,
    frame: null,
    hydrateTimer: null,
    pollTimer: null,
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro ao acessar a Base.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', error);
  }

  function columnName(index) {
    let result = '';
    for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
      result = String.fromCharCode(65 + ((number - 1) % 26)) + result;
    }
    return result;
  }

  function cellAddress(row, col) {
    return `${columnName(col)}${row + 1}`;
  }

  function quoteSourceName(name) {
    return `'${String(name || '').replaceAll("'", "''")}'`;
  }

  function selectionBounds() {
    if (!state.selection) return null;
    return {
      top: Math.min(state.selection.startRow, state.selection.endRow),
      bottom: Math.max(state.selection.startRow, state.selection.endRow),
      left: Math.min(state.selection.startCol, state.selection.endCol),
      right: Math.max(state.selection.startCol, state.selection.endCol),
    };
  }

  function referenceText() {
    const bounds = selectionBounds();
    if (!bounds || !state.source) return '';
    const start = cellAddress(bounds.top, bounds.left);
    const end = cellAddress(bounds.bottom, bounds.right);
    return `${quoteSourceName(state.source.name)}!${start}${start === end ? '' : `:${end}`}`;
  }

  function updateSelectionLabel() {
    if (!selectionLabel) return;
    const reference = referenceText();
    selectionLabel.textContent = reference
      ? `${reference} · solte para inserir na fórmula`
      : 'Clique em uma célula ou arraste uma área.';
  }

  function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return '[objeto]'; }
    }
    return String(value);
  }

  function rowValue(rowIndex, colIndex) {
    const row = state.rowCache.get(rowIndex);
    if (!row) return { loaded: false, value: null };
    const column = state.columns[colIndex];
    if (!column) return { loaded: true, value: null };
    const values = row.values && typeof row.values === 'object' ? row.values : {};
    return { loaded: true, value: values[column.column_key] };
  }

  function sourceCellsFromRows(rows, offset) {
    const cells = [];
    rows.forEach((row, rowOffset) => {
      const values = row?.values && typeof row.values === 'object' ? row.values : {};
      state.columns.forEach((column, col) => {
        cells.push({ r: offset + rowOffset, c: col, v: values[column.column_key] ?? null });
      });
    });
    return cells;
  }

  function registerRowsWithRuntime(rows, offset) {
    if (!state.source || !rows.length) return;
    engineApi.setExternalSources?.([{
      id: state.source.id,
      name: state.source.name,
      revision: state.sourceRevision,
      cells: sourceCellsFromRows(rows, offset),
    }]);
  }

  function applyWindow(data, offset) {
    const revision = Number(data?.source?.revision || 0);
    if (state.sourceRevision && revision && state.sourceRevision !== revision) {
      state.rowCache.clear();
      state.pages.clear();
    }
    state.sourceRevision = revision || state.sourceRevision;
    state.source = { ...state.source, ...(data.source || {}) };
    state.columns = Array.isArray(data.columns) ? data.columns : state.columns;
    state.totalRows = Number(data?.window?.total || 0);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    rows.forEach((row, index) => state.rowCache.set(offset + index, row));
    registerRowsWithRuntime(rows, offset);
    scheduleRender();
  }

  async function loadPage(offset, force = false) {
    if (!state.source) return;
    const normalizedOffset = Math.max(0, Math.floor(Number(offset) / PAGE_SIZE) * PAGE_SIZE);
    if (!force && state.pages.has(normalizedOffset)) return state.pages.get(normalizedOffset);
    const sourceId = state.source.id;
    const promise = api(`/api/workbooks/${workbookId}/base-sources/${sourceId}?offset=${normalizedOffset}&limit=${PAGE_SIZE}`)
      .then(data => {
        if (!state.source || Number(state.source.id) !== Number(sourceId)) return data;
        applyWindow(data, normalizedOffset);
        state.pages.set(normalizedOffset, Promise.resolve(data));
        return data;
      })
      .catch(error => {
        state.pages.delete(normalizedOffset);
        setStatus(error.message, true);
        throw error;
      });
    state.pages.set(normalizedOffset, promise);
    return promise;
  }

  function visibleRange() {
    const rows = Math.max(0, state.totalRows);
    const cols = Math.max(0, state.columns.length);
    const firstRow = Math.max(0, Math.floor((grid.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(rows - 1, Math.ceil((grid.scrollTop + grid.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS);
    const firstCol = Math.max(0, Math.floor((grid.scrollLeft - ROW_HEADER_WIDTH) / COL_WIDTH) - OVERSCAN_COLS);
    const lastCol = Math.min(cols - 1, Math.ceil((grid.scrollLeft + grid.clientWidth - ROW_HEADER_WIDTH) / COL_WIDTH) + OVERSCAN_COLS);
    return { firstRow, lastRow, firstCol, lastCol };
  }

  function cellSelectionClasses(row, col) {
    const bounds = selectionBounds();
    if (!bounds || row < bounds.top || row > bounds.bottom || col < bounds.left || col > bounds.right) return [];
    if (bounds.top === bounds.bottom && bounds.left === bounds.right) return ['selected'];
    const classes = ['range-selected'];
    if (row === bounds.top) classes.push('range-top');
    if (row === bounds.bottom) classes.push('range-bottom');
    if (col === bounds.left) classes.push('range-left');
    if (col === bounds.right) classes.push('range-right');
    return classes;
  }

  function makeBox(className, x, y, width, height) {
    const element = document.createElement('div');
    element.className = className;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.transform = `translate(${x}px, ${y}px)`;
    return element;
  }

  function render() {
    state.frame = null;
    const width = ROW_HEADER_WIDTH + Math.max(1, state.columns.length) * COL_WIDTH;
    const height = HEADER_HEIGHT + Math.max(1, state.totalRows) * ROW_HEIGHT;
    canvas.style.width = `${Math.max(width, grid.clientWidth)}px`;
    canvas.style.height = `${Math.max(height, grid.clientHeight)}px`;
    canvas.replaceChildren();

    if (!state.source) {
      const empty = document.createElement('div');
      empty.className = 'base-reference-empty';
      empty.innerHTML = '<div><strong>Nenhuma Base selecionada</strong><span>Crie ou escolha uma Base de entrada.</span></div>';
      canvas.append(empty);
      return;
    }

    const range = visibleRange();
    const fragment = document.createDocumentFragment();
    const corner = makeBox('base-reference-corner', grid.scrollLeft, grid.scrollTop, ROW_HEADER_WIDTH, HEADER_HEIGHT);
    corner.textContent = '↘';
    fragment.append(corner);

    for (let col = range.firstCol; col <= range.lastCol; col += 1) {
      const header = makeBox(
        'base-reference-col-header',
        ROW_HEADER_WIDTH + col * COL_WIDTH,
        grid.scrollTop,
        COL_WIDTH,
        HEADER_HEIGHT,
      );
      const column = state.columns[col];
      header.textContent = `${columnName(col)} · ${column?.name || columnName(col)}`;
      header.title = column?.name || columnName(col);
      fragment.append(header);
    }

    const requiredPages = new Set();
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      if (!state.rowCache.has(row)) requiredPages.add(Math.floor(row / PAGE_SIZE) * PAGE_SIZE);
      const rowHeader = makeBox(
        'base-reference-row-header',
        grid.scrollLeft,
        HEADER_HEIGHT + row * ROW_HEIGHT,
        ROW_HEADER_WIDTH,
        ROW_HEIGHT,
      );
      rowHeader.textContent = String(row + 1);
      fragment.append(rowHeader);

      for (let col = range.firstCol; col <= range.lastCol; col += 1) {
        const result = rowValue(row, col);
        const cell = makeBox(
          `base-reference-cell${result.loaded ? '' : ' is-loading'}`,
          ROW_HEADER_WIDTH + col * COL_WIDTH,
          HEADER_HEIGHT + row * ROW_HEIGHT,
          COL_WIDTH,
          ROW_HEIGHT,
        );
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        const text = result.loaded ? formatValue(result.value) : '…';
        cell.textContent = text;
        if (text) cell.title = text;
        cell.classList.add(...cellSelectionClasses(row, col));
        fragment.append(cell);
      }
    }

    canvas.append(fragment);
    requiredPages.forEach(offset => loadPage(offset).catch(() => {}));
  }

  function scheduleRender() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(render);
  }

  function hitTest(event) {
    const rect = grid.getBoundingClientRect();
    const x = grid.scrollLeft + event.clientX - rect.left;
    const y = grid.scrollTop + event.clientY - rect.top;
    if (x < ROW_HEADER_WIDTH || y < HEADER_HEIGHT) return null;
    const row = Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT);
    const col = Math.floor((x - ROW_HEADER_WIDTH) / COL_WIDTH);
    if (row < 0 || col < 0 || row >= state.totalRows || col >= state.columns.length) return null;
    return { row, col };
  }

  function setSelection(startRow, startCol, endRow = startRow, endCol = startCol) {
    state.selection = { startRow, startCol, endRow, endCol };
    updateSelectionLabel();
    scheduleRender();
  }

  async function ensureSelectionLoaded() {
    const bounds = selectionBounds();
    if (!bounds) return;
    const pages = new Set();
    for (let row = bounds.top; row <= bounds.bottom; row += PAGE_SIZE) {
      pages.add(Math.floor(row / PAGE_SIZE) * PAGE_SIZE);
    }
    pages.add(Math.floor(bounds.bottom / PAGE_SIZE) * PAGE_SIZE);
    await Promise.all([...pages].map(offset => loadPage(offset)));
  }

  function insertReferenceAtCursor(reference) {
    if (!reference) return;
    const active = document.activeElement;
    let start = null;
    let end = null;
    if (active === formulaInput || active?.classList?.contains('virtual-grid-editor')) {
      start = active.selectionStart;
      end = active.selectionEnd;
    }

    formulaInput.focus({ preventScroll: true });
    let value = String(formulaInput.value || '');
    if (!value.trimStart().startsWith('=')) {
      value = '=';
      start = value.length;
      end = value.length;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      start = value.length;
      end = value.length;
    }
    const next = `${value.slice(0, start)}${reference}${value.slice(end)}`;
    formulaInput.value = next;
    formulaInput.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: reference,
    }));
    const caret = start + reference.length;
    formulaInput.setSelectionRange(caret, caret);
    formulaInput.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('superexcel:base-reference-inserted', {
      detail: { reference, source_id: state.source?.id },
    }));
  }

  async function finishReferenceSelection() {
    const reference = referenceText();
    if (!reference) return;
    try {
      await ensureSelectionLoaded();
      const bounds = selectionBounds();
      const cells = [];
      for (let row = bounds.top; row <= bounds.bottom; row += 1) {
        for (let col = bounds.left; col <= bounds.right; col += 1) {
          cells.push({ r: row, c: col, v: rowValue(row, col).value ?? null });
        }
      }
      engineApi.setExternalSources?.([{
        id: state.source.id,
        name: state.source.name,
        revision: state.sourceRevision,
        cells,
      }]);
      insertReferenceAtCursor(reference);
      setStatus(`${reference} inserida na fórmula.`);
    } catch (error) {
      setStatus(error.message || 'Não foi possível inserir a referência.', true);
    }
  }

  function renderSourceOptions() {
    select.replaceChildren();
    if (!state.sources.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Nenhuma Base de entrada';
      select.append(option);
      select.disabled = true;
      state.source = null;
      scheduleRender();
      return;
    }
    select.disabled = false;
    const sorted = [...state.sources].sort((left, right) => (
      Number(right.linked) - Number(left.linked)
      || String(left.name).localeCompare(String(right.name), 'pt-BR')
    ));
    sorted.forEach(source => {
      const option = document.createElement('option');
      option.value = String(source.id);
      option.textContent = `${source.linked ? '● ' : ''}${source.name}`;
      select.append(option);
    });
  }

  async function chooseSource(sourceId) {
    const source = state.sources.find(item => Number(item.id) === Number(sourceId));
    if (!source) return;
    state.source = { ...source };
    state.sourceRevision = Number(source.revision || 0);
    state.columns = [];
    state.totalRows = 0;
    state.rowCache.clear();
    state.pages.clear();
    state.selection = null;
    updateSelectionLabel();
    setStatus(`Carregando ${source.name}…`);
    scheduleRender();
    try {
      await loadPage(0, true);
      setStatus(`${state.totalRows.toLocaleString('pt-BR')} registros · revisão ${state.sourceRevision}`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function dependencyReferences() {
    const dependencies = engineApi.getExternalDependencies?.() || [];
    const unique = new Map();
    for (const item of dependencies) {
      const start = cellAddress(item.start.row, item.start.col);
      const end = cellAddress(item.end.row, item.end.col);
      const key = `${item.sourceKey}:${start}:${end}`;
      unique.set(key, { source: item.source, start, end });
    }
    return [...unique.values()];
  }

  async function syncDependencies(references) {
    if (!['editor', 'admin', 'owner'].includes(state.role)) return;
    const unique = [...new Set(references.map(item => item.source))];
    await api(`/api/workbooks/${workbookId}/base-dependencies/sync`, {
      method: 'POST',
      body: JSON.stringify({ sources: unique }),
    });
    const linkedKeys = new Set(unique.map(name => parserApi.normalizeSourceName(name)));
    state.sources = state.sources.map(source => ({
      ...source,
      linked: linkedKeys.has(parserApi.normalizeSourceName(source.name)),
    }));
  }

  async function hydrateFormulaReferences(options = {}) {
    const references = dependencyReferences();
    try {
      if (!references.length) {
        if (options.sync !== false) await syncDependencies([]);
        return;
      }
      const output = await api(`/api/workbooks/${workbookId}/base-reference-values`, {
        method: 'POST',
        body: JSON.stringify({ references }),
      });
      engineApi.setExternalSources?.(output.sources || []);
      if (options.sync !== false) await syncDependencies(references);
      if (options.announce) setStatus(`${output.cell_count.toLocaleString('pt-BR')} células externas atualizadas.`);
    } catch (error) {
      if (options.announce) setStatus(error.message, true);
      else console.debug('Não foi possível hidratar referências de Base.', error);
    }
  }

  function scheduleHydration() {
    if (state.hydrateTimer) clearTimeout(state.hydrateTimer);
    state.hydrateTimer = setTimeout(() => {
      state.hydrateTimer = null;
      hydrateFormulaReferences({ sync: true }).catch(console.debug);
    }, 420);
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
    document.body.classList.toggle('base-reference-open', open);
    modeButton.classList.toggle('active', open);
    modeButton.setAttribute('aria-pressed', String(open));
    if (open) requestAnimationFrame(scheduleRender);
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    try {
      const output = await api(`/api/workbooks/${workbookId}/base-sources`);
      state.role = output.role || 'viewer';
      state.sources = Array.isArray(output.sources) ? output.sources : [];
      document.body.classList.add('base-reference-workbook');
      modeButton.hidden = false;
      panel.hidden = false;
      setPanelOpen(true);
      renderSourceOptions();
      if (state.sources.length) {
        const first = [...state.sources].sort((left, right) => Number(right.linked) - Number(left.linked))[0];
        select.value = String(first.id);
        await chooseSource(first.id);
      } else {
        setStatus('Crie uma Base de entrada para usar referências relacionais.');
      }
      await hydrateFormulaReferences({ sync: true });
      state.pollTimer = setInterval(() => {
        if (document.hidden) return;
        hydrateFormulaReferences({ sync: false }).catch(console.debug);
        if (!panel.hidden && state.source) loadPage(Math.floor(Math.max(0, grid.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT), true).catch(console.debug);
      }, POLL_MS);
    } catch (error) {
      if (error.status === 409) return;
      console.error(error);
      setStatus(error.message, true);
    }
  }

  grid.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });

  grid.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !state.source) return;
    const hit = hitTest(event);
    if (!hit) return;
    event.preventDefault();
    state.drag = hit;
    setSelection(hit.row, hit.col);
    grid.setPointerCapture?.(event.pointerId);
  });

  grid.addEventListener('pointermove', event => {
    if (!state.drag) return;
    const hit = hitTest(event);
    if (!hit) return;
    setSelection(state.drag.row, state.drag.col, hit.row, hit.col);
  });

  async function endSelection(event) {
    if (!state.drag) return;
    state.drag = null;
    try { grid.releasePointerCapture?.(event.pointerId); } catch {}
    await finishReferenceSelection();
  }

  grid.addEventListener('pointerup', endSelection);
  grid.addEventListener('pointercancel', event => {
    state.drag = null;
    try { grid.releasePointerCapture?.(event.pointerId); } catch {}
  });

  select.addEventListener('change', () => chooseSource(select.value));
  refreshButton?.addEventListener('click', async () => {
    if (!state.source) return;
    state.rowCache.clear();
    state.pages.clear();
    await loadPage(Math.floor(Math.max(0, grid.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT), true);
    await hydrateFormulaReferences({ sync: false, announce: true });
  });
  modeButton.addEventListener('click', () => setPanelOpen(panel.hidden));
  closeButton?.addEventListener('click', () => setPanelOpen(false));

  window.addEventListener('superexcel:hydrated', initialize, { once: true });
  window.addEventListener('superexcel:changes', scheduleHydration);
  window.addEventListener('superexcel:base-reference-inserted', () => {
    window.setTimeout(scheduleHydration, 0);
  });
  window.addEventListener('pagehide', () => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.hydrateTimer) clearTimeout(state.hydrateTimer);
  }, { once: true });

  if (!document.body.classList.contains('sheet-loading') && window.SuperExcelApp) initialize();
})();
