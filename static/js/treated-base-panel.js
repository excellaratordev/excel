(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const panel = document.querySelector('#treated-source-panel');
  const modeButton = document.querySelector('#treated-source-mode-button');
  const closeButton = document.querySelector('#treated-source-close');
  const sourceSelect = document.querySelector('#treated-source-select');
  const openSourceButton = document.querySelector('#treated-source-open');
  const refreshButton = document.querySelector('#treated-source-refresh');
  const selectModeButton = document.querySelector('#treated-source-select-mode');
  const syncButton = document.querySelector('#treated-source-sync');
  const headerRowInput = document.querySelector('#treated-source-header-row');
  const status = document.querySelector('#treated-source-status');
  const selectionLabel = document.querySelector('#treated-source-selection');
  const grid = document.querySelector('#treated-source-grid');
  const canvas = document.querySelector('#treated-source-canvas');

  if (!panel || !modeButton || !sourceSelect || !syncButton || !grid || !canvas) return;

  const ROW_HEIGHT = 32;
  const COL_WIDTH = 136;
  const HEADER_HEIGHT = 34;
  const ROW_HEADER_WIDTH = 46;
  const ROW_PAGE = 120;
  const COL_PAGE = 30;
  const OVERSCAN_ROWS = 8;
  const OVERSCAN_COLS = 2;
  const POLL_MS = 15000;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  const state = {
    role: 'viewer',
    sources: [],
    source: null,
    binding: null,
    rows: 60,
    cols: 26,
    cells: new Map(),
    pages: new Map(),
    selection: null,
    drag: null,
    frame: null,
    selectionMode: !coarsePointer,
    pollTimer: null,
    syncing: false,
    initialized: false,
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      cache: options.cache || 'no-store',
      ...options,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro ao acessar a Planilha de origem.');
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message || '';
    status.dataset.state = error ? 'error' : 'normal';
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
    const name = `'${String(state.source.name || '').replaceAll("'", "''")}'`;
    return `${name}!${start}${start === end ? '' : `:${end}`}`;
  }

  function updateSelectionLabel() {
    const reference = referenceText();
    selectionLabel.textContent = reference || 'Selecione uma célula ou arraste uma área.';
    syncButton.disabled = !reference || !['editor', 'admin', 'owner'].includes(state.role);
  }

  function formatValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return '[objeto]'; }
    }
    return String(value);
  }

  function cellKey(row, col) {
    return `${row}:${col}`;
  }

  function pageKey(rowOffset, colOffset) {
    return `${rowOffset}:${colOffset}`;
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
    document.body.classList.toggle('treated-source-open', open);
    modeButton.classList.toggle('active', open);
    modeButton.setAttribute('aria-pressed', String(open));
    if (open) requestAnimationFrame(scheduleRender);
  }

  function setSelectionMode(active) {
    state.selectionMode = Boolean(active);
    grid.classList.toggle('selection-mode', state.selectionMode);
    selectModeButton?.classList.toggle('active', state.selectionMode);
    selectModeButton?.setAttribute('aria-pressed', String(state.selectionMode));
    if (selectModeButton) selectModeButton.textContent = state.selectionMode ? '✓ Selecionando' : 'Selecionar área';
  }

  function renderSourceOptions() {
    sourceSelect.replaceChildren();
    if (!state.sources.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Nenhuma Planilha de cálculo';
      sourceSelect.append(option);
      sourceSelect.disabled = true;
      return;
    }
    sourceSelect.disabled = false;
    [...state.sources]
      .sort((left, right) => Number(right.bound) - Number(left.bound) || String(left.name).localeCompare(String(right.name), 'pt-BR'))
      .forEach(source => {
        const option = document.createElement('option');
        option.value = String(source.id);
        option.textContent = `${source.bound ? '● ' : ''}${source.name}`;
        sourceSelect.append(option);
      });
  }

  function makeBox(className, x, y, width, height) {
    const element = document.createElement('div');
    element.className = className;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.transform = `translate(${x}px, ${y}px)`;
    return element;
  }

  function visibleRange() {
    const firstRow = Math.max(0, Math.floor((grid.scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS);
    const lastRow = Math.min(state.rows - 1, Math.ceil((grid.scrollTop + grid.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS);
    const firstCol = Math.max(0, Math.floor((grid.scrollLeft - ROW_HEADER_WIDTH) / COL_WIDTH) - OVERSCAN_COLS);
    const lastCol = Math.min(state.cols - 1, Math.ceil((grid.scrollLeft + grid.clientWidth - ROW_HEADER_WIDTH) / COL_WIDTH) + OVERSCAN_COLS);
    return { firstRow, lastRow, firstCol, lastCol };
  }

  function selectionClasses(row, col) {
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

  async function loadPage(rowOffset, colOffset, force = false) {
    if (!state.source) return;
    const normalizedRow = Math.max(0, Math.floor(rowOffset / ROW_PAGE) * ROW_PAGE);
    const normalizedCol = Math.max(0, Math.floor(colOffset / COL_PAGE) * COL_PAGE);
    const key = pageKey(normalizedRow, normalizedCol);
    if (!force && state.pages.has(key)) return state.pages.get(key);
    const sourceId = state.source.id;
    const promise = api(`/api/treated-bases/${workbookId}/sources/${sourceId}?row_offset=${normalizedRow}&row_limit=${ROW_PAGE}&col_offset=${normalizedCol}&col_limit=${COL_PAGE}`)
      .then(data => {
        if (!state.source || Number(state.source.id) !== Number(sourceId)) return data;
        state.source = { ...state.source, ...(data.source || {}) };
        state.rows = Math.max(1, Number(data?.shape?.rows || 60));
        state.cols = Math.max(1, Number(data?.shape?.cols || 26));
        (data.cells || []).forEach(cell => {
          state.cells.set(cellKey(Number(cell.r), Number(cell.c)), {
            value: cell.v,
            computed: Boolean(cell.computed),
          });
        });
        scheduleRender();
        return data;
      })
      .catch(error => {
        state.pages.delete(key);
        setStatus(error.message, true);
        throw error;
      });
    state.pages.set(key, promise);
    return promise;
  }

  function render() {
    state.frame = null;
    const width = ROW_HEADER_WIDTH + state.cols * COL_WIDTH;
    const height = HEADER_HEIGHT + state.rows * ROW_HEIGHT;
    canvas.style.width = `${Math.max(width, grid.clientWidth)}px`;
    canvas.style.height = `${Math.max(height, grid.clientHeight)}px`;
    canvas.replaceChildren();

    if (!state.source) {
      const empty = document.createElement('div');
      empty.className = 'treated-source-empty';
      empty.innerHTML = '<div><strong>Nenhuma Planilha selecionada</strong><span>Escolha uma Planilha da etapa 2.</span></div>';
      canvas.append(empty);
      return;
    }

    const range = visibleRange();
    const fragment = document.createDocumentFragment();
    const corner = makeBox('treated-source-corner', grid.scrollLeft, grid.scrollTop, ROW_HEADER_WIDTH, HEADER_HEIGHT);
    corner.textContent = '↘';
    fragment.append(corner);

    for (let col = range.firstCol; col <= range.lastCol; col += 1) {
      const header = makeBox('treated-source-col-header', ROW_HEADER_WIDTH + col * COL_WIDTH, grid.scrollTop, COL_WIDTH, HEADER_HEIGHT);
      header.textContent = columnName(col);
      fragment.append(header);
    }

    const requiredPages = new Set();
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      const rowHeader = makeBox('treated-source-row-header', grid.scrollLeft, HEADER_HEIGHT + row * ROW_HEIGHT, ROW_HEADER_WIDTH, ROW_HEIGHT);
      rowHeader.textContent = String(row + 1);
      fragment.append(rowHeader);
      for (let col = range.firstCol; col <= range.lastCol; col += 1) {
        const rowPage = Math.floor(row / ROW_PAGE) * ROW_PAGE;
        const colPage = Math.floor(col / COL_PAGE) * COL_PAGE;
        const page = pageKey(rowPage, colPage);
        if (!state.pages.has(page)) requiredPages.add(page);
        const stored = state.cells.get(cellKey(row, col));
        const value = stored ? formatValue(stored.value) : '';
        const cell = makeBox('treated-source-cell', ROW_HEADER_WIDTH + col * COL_WIDTH, HEADER_HEIGHT + row * ROW_HEIGHT, COL_WIDTH, ROW_HEIGHT);
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.textContent = value;
        if (value) cell.title = value;
        if (stored?.computed) cell.classList.add('is-computed');
        if (!stored?.computed && typeof stored?.value === 'string' && stored.value.trimStart().startsWith('=')) cell.classList.add('is-formula');
        cell.classList.add(...selectionClasses(row, col));
        fragment.append(cell);
      }
    }
    canvas.append(fragment);
    requiredPages.forEach(key => {
      const [rowOffset, colOffset] = key.split(':').map(Number);
      loadPage(rowOffset, colOffset).catch(() => {});
    });
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
    if (row < 0 || col < 0 || row >= state.rows || col >= state.cols) return null;
    return { row, col };
  }

  function setSelection(startRow, startCol, endRow = startRow, endCol = startCol) {
    state.selection = { startRow, startCol, endRow, endCol };
    updateSelectionLabel();
    scheduleRender();
  }

  async function chooseSource(sourceId) {
    const source = state.sources.find(item => Number(item.id) === Number(sourceId));
    if (!source) return;
    state.source = { ...source };
    state.cells.clear();
    state.pages.clear();
    state.rows = 60;
    state.cols = 26;
    if (!state.binding || Number(state.binding.source_workbook_id) !== Number(source.id)) state.selection = null;
    updateSelectionLabel();
    setStatus(`Carregando ${source.name}…`);
    scheduleRender();
    try {
      const output = await loadPage(0, 0, true);
      const snapshotRevision = Number(output?.source?.snapshot_revision || 0);
      const sourceRevision = Number(output?.source?.revision || 0);
      setStatus(snapshotRevision >= sourceRevision
        ? `Valores calculados atualizados · revisão ${sourceRevision}`
        : `Prévia carregada · aguardando cálculo da revisão ${sourceRevision}`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function saveSelection() {
    const bounds = selectionBounds();
    if (!bounds || !state.source || state.syncing) return;
    state.syncing = true;
    syncButton.disabled = true;
    setStatus('Vinculando intervalo e materializando a Base 2…');
    try {
      const output = await api(`/api/treated-bases/${workbookId}/binding`, {
        method: 'POST',
        body: JSON.stringify({
          source_id: state.source.id,
          start: cellAddress(bounds.top, bounds.left),
          end: cellAddress(bounds.bottom, bounds.right),
          header_row: Boolean(headerRowInput?.checked),
        }),
      });
      state.binding = output.binding;
      const result = output.result || {};
      if (result.status === 'materialized') {
        setStatus(`${result.row_count.toLocaleString('pt-BR')} registros sincronizados.`);
        location.reload();
        return;
      }
      if (result.status === 'pending') {
        setStatus(`${result.error} Abra a Planilha de origem para calcular e sincronizar.`, false);
      } else if (result.status === 'unchanged') {
        setStatus('A Base 2 já está sincronizada com esta revisão.');
      } else {
        setStatus(result.error || 'Não foi possível materializar a Base 2.', true);
      }
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      state.syncing = false;
      updateSelectionLabel();
    }
  }

  async function syncCurrent({ quiet = false } = {}) {
    if (!state.binding || state.syncing || !['editor', 'admin', 'owner'].includes(state.role)) return;
    state.syncing = true;
    try {
      const output = await api(`/api/treated-bases/${workbookId}/sync`, { method: 'POST', body: '{}' });
      const result = output.result || {};
      if (result.status === 'materialized') {
        if (!quiet) setStatus(`${result.row_count.toLocaleString('pt-BR')} registros atualizados.`);
        location.reload();
      } else if (!quiet && result.status === 'unchanged') {
        setStatus('Base 2 sincronizada com a revisão atual.');
      } else if (!quiet && result.status === 'pending') {
        setStatus(result.error || 'Aguardando valores calculados da Planilha.');
      }
    } catch (error) {
      if (!quiet) setStatus(error.message, true);
    } finally {
      state.syncing = false;
    }
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    try {
      const output = await api(`/api/treated-bases/${workbookId}/sources`);
      state.role = output?.target?.role || 'viewer';
      state.sources = Array.isArray(output.sources) ? output.sources : [];
      state.binding = output.binding || null;
      document.body.classList.add('treated-base-workbook');
      modeButton.hidden = false;
      panel.hidden = false;
      setPanelOpen(!coarsePointer);
      setSelectionMode(!coarsePointer);
      renderSourceOptions();
      if (state.binding) {
        state.selection = {
          startRow: Number(state.binding.top_row),
          endRow: Number(state.binding.bottom_row),
          startCol: Number(state.binding.left_col),
          endCol: Number(state.binding.right_col),
        };
        if (headerRowInput) headerRowInput.checked = Boolean(state.binding.header_row);
      }
      const preferred = state.sources.find(item => item.bound) || state.sources[0];
      if (preferred) {
        sourceSelect.value = String(preferred.id);
        await chooseSource(preferred.id);
      } else {
        setStatus('Crie uma Planilha na etapa 2 para alimentar esta Base 2.');
      }
      updateSelectionLabel();
      state.pollTimer = window.setInterval(() => {
        if (!document.hidden) syncCurrent({ quiet: true }).catch(() => {});
      }, POLL_MS);
    } catch (error) {
      if (error.status === 409) return;
      document.body.classList.add('treated-base-workbook');
      modeButton.hidden = false;
      panel.hidden = false;
      setPanelOpen(!coarsePointer);
      setStatus(error.message, true);
    }
  }

  grid.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });

  grid.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !state.source) return;
    if (coarsePointer && !state.selectionMode) return;
    const hit = hitTest(event);
    if (!hit) return;
    event.preventDefault();
    state.drag = hit;
    setSelection(hit.row, hit.col);
    grid.setPointerCapture?.(event.pointerId);
  });

  grid.addEventListener('pointermove', event => {
    if (!state.drag) return;
    event.preventDefault();
    const hit = hitTest(event);
    if (!hit) return;
    setSelection(state.drag.row, state.drag.col, hit.row, hit.col);
  });

  function endSelection(event) {
    if (!state.drag) return;
    state.drag = null;
    try { grid.releasePointerCapture?.(event.pointerId); } catch {}
  }

  grid.addEventListener('pointerup', endSelection);
  grid.addEventListener('pointercancel', endSelection);
  sourceSelect.addEventListener('change', () => chooseSource(sourceSelect.value));
  modeButton.addEventListener('click', () => setPanelOpen(panel.hidden));
  closeButton?.addEventListener('click', () => setPanelOpen(false));
  selectModeButton?.addEventListener('click', () => setSelectionMode(!state.selectionMode));
  syncButton.addEventListener('click', saveSelection);
  openSourceButton?.addEventListener('click', () => {
    if (state.source) window.open(`/sheet/${state.source.id}`, '_blank', 'noopener');
  });
  refreshButton?.addEventListener('click', async () => {
    if (!state.source) return;
    state.cells.clear();
    state.pages.clear();
    await loadPage(Math.max(0, Math.floor(grid.scrollTop / ROW_HEIGHT)), Math.max(0, Math.floor(grid.scrollLeft / COL_WIDTH)), true);
    await syncCurrent();
  });

  window.addEventListener('pagehide', () => {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
  }, { once: true });

  window.SuperExcelAuth?.ready?.then(initialize).catch(error => setStatus(error.message, true));
})();
