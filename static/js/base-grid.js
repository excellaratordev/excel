(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const ROW_HEIGHT = 38;
  const CHUNK_SIZE = 140;
  const OVERSCAN = 12;
  const COLUMN_WIDTH = 190;
  const SYSTEM_WIDTH = 54;
  const ACTION_WIDTH = 46;

  const nameInput = document.querySelector('#base-name');
  const stageBadge = document.querySelector('#base-stage');
  const status = document.querySelector('#base-status');
  const rowCount = document.querySelector('#base-row-count');
  const columnCount = document.querySelector('#base-column-count');
  const header = document.querySelector('#base-grid-header');
  const viewport = document.querySelector('#base-grid-viewport');
  const spacer = document.querySelector('#base-grid-spacer');
  const layer = document.querySelector('#base-grid-layer');
  const empty = document.querySelector('#base-empty');
  const addRow = document.querySelector('#add-row');
  const addColumn = document.querySelector('#add-column');
  const columnDialog = document.querySelector('#column-dialog');
  const columnForm = document.querySelector('#column-form');
  const columnSave = document.querySelector('#column-save');
  const columnError = document.querySelector('#column-error');

  const state = {
    workbook: null,
    columns: [],
    rows: new Map(),
    total: 0,
    loading: new Set(),
    editable: false,
    renderQueued: false,
    initialLoaded: false,
  };

  function setStatus(message, mode = '') {
    status.textContent = message;
    status.dataset.state = mode;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro inesperado.');
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function stageLabel(stage) {
    return stage === 'treated' ? 'Base 2 · dados tratados' : 'Base · dados de entrada';
  }

  function gridTemplate() {
    return `${SYSTEM_WIDTH}px repeat(${state.columns.length}, ${COLUMN_WIDTH}px) ${ACTION_WIDTH}px`;
  }

  function gridWidth() {
    return SYSTEM_WIDTH + state.columns.length * COLUMN_WIDTH + ACTION_WIDTH;
  }

  function formatValue(value, type) {
    if (value === null || value === undefined) return '';
    if (type === 'json' && typeof value !== 'string') {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    if (type === 'boolean' && typeof value === 'boolean') return value ? 'true' : 'false';
    if (type === 'datetime' && typeof value === 'string' && !value.trimStart().startsWith('=')) return value.slice(0, 16);
    return String(value);
  }

  function inputValue(input, type) {
    const value = input.value;
    if (value.trimStart().startsWith('=')) return value;
    if (type === 'boolean') {
      if (value === '') return null;
      return value === 'true';
    }
    return value;
  }

  function renderHeader() {
    header.innerHTML = '';
    header.style.gridTemplateColumns = gridTemplate();
    header.style.width = `${gridWidth()}px`;

    const rowNumber = document.createElement('div');
    rowNumber.className = 'base-grid-header-cell system';
    rowNumber.textContent = '#';
    header.append(rowNumber);

    state.columns.forEach(column => {
      const cell = document.createElement('div');
      cell.className = 'base-grid-header-cell';
      const title = document.createElement('span');
      title.textContent = column.name;
      const type = document.createElement('small');
      type.textContent = column.data_type;
      cell.append(title, type);
      if (state.editable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = `Excluir coluna ${column.name}`;
        remove.textContent = '×';
        remove.addEventListener('click', () => deleteColumn(column));
        cell.append(remove);
      }
      header.append(cell);
    });

    const action = document.createElement('div');
    action.className = 'base-grid-header-cell system';
    action.textContent = '⋯';
    header.append(action);
  }

  function createEditor(row, column) {
    const type = column.data_type;
    const value = row.values?.[column.column_key];
    const input = document.createElement('input');
    input.type = 'text';
    input.value = formatValue(value, type);
    input.spellcheck = type === 'text';
    input.autocomplete = 'off';
    input.disabled = !state.editable;
    input.dataset.original = input.value;
    input.addEventListener('input', () => {
      input.dataset.dirty = String(input.value !== input.dataset.original);
      input.dataset.error = 'false';
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        input.value = input.dataset.original;
        input.dataset.dirty = 'false';
        input.dataset.error = 'false';
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      if (!state.editable || input.value === input.dataset.original) return;
      saveCell(row, column, input);
    });
    return input;
  }

  function renderRow(index, row) {
    const element = document.createElement('div');
    element.className = 'base-grid-row';
    element.style.top = `${index * ROW_HEIGHT}px`;
    element.style.gridTemplateColumns = gridTemplate();
    element.style.width = `${gridWidth()}px`;
    element.dataset.rowIndex = String(index);

    const number = document.createElement('div');
    number.className = 'base-grid-cell system';
    number.textContent = String(index + 1);
    element.append(number);

    if (!row) {
      state.columns.forEach(() => {
        const cell = document.createElement('div');
        cell.className = 'base-grid-cell';
        cell.textContent = '…';
        element.append(cell);
      });
    } else {
      state.columns.forEach(column => {
        const cell = document.createElement('div');
        cell.className = 'base-grid-cell';
        cell.append(createEditor(row, column));
        element.append(cell);
      });
    }

    const action = document.createElement('div');
    action.className = 'base-grid-cell action';
    if (row && state.editable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Excluir registro';
      remove.textContent = '×';
      remove.addEventListener('click', () => deleteRow(row));
      action.append(remove);
    }
    element.append(action);
    return element;
  }

  function visibleBounds() {
    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    return { first, last: Math.min(state.total, first + visible) };
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      renderVisible();
    });
  }

  function renderVisible() {
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    spacer.style.width = `${gridWidth()}px`;
    layer.style.width = `${gridWidth()}px`;
    empty.hidden = state.total > 0;
    rowCount.textContent = state.total.toLocaleString('pt-BR');
    columnCount.textContent = String(state.columns.length);
    layer.innerHTML = '';
    if (!state.total) return;
    const { first, last } = visibleBounds();
    ensureRange(first, last);
    const fragment = document.createDocumentFragment();
    for (let index = first; index < last; index += 1) {
      fragment.append(renderRow(index, state.rows.get(index)));
    }
    layer.append(fragment);
  }

  async function fetchChunk(offset) {
    const normalized = Math.max(0, Math.floor(offset / CHUNK_SIZE) * CHUNK_SIZE);
    if (state.loading.has(normalized)) return;
    state.loading.add(normalized);
    try {
      const data = await api(`/api/bases/${workbookId}?offset=${normalized}&limit=${CHUNK_SIZE}`);
      if (!state.initialLoaded) applyMetadata(data);
      state.total = Number(data.window?.total || 0);
      (data.rows || []).forEach((row, index) => state.rows.set(normalized + index, row));
      scheduleRender();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      state.loading.delete(normalized);
    }
  }

  function ensureRange(first, last) {
    const startChunk = Math.floor(first / CHUNK_SIZE) * CHUNK_SIZE;
    const endChunk = Math.floor(Math.max(first, last - 1) / CHUNK_SIZE) * CHUNK_SIZE;
    for (let offset = startChunk; offset <= endChunk; offset += CHUNK_SIZE) {
      if (!state.rows.has(offset)) fetchChunk(offset);
    }
  }

  function applyMetadata(data) {
    state.workbook = data.workbook;
    state.columns = Array.isArray(data.columns) ? data.columns : [];
    state.editable = ['editor', 'admin', 'owner'].includes(state.workbook.role);
    nameInput.value = state.workbook.name;
    nameInput.disabled = !state.editable;
    stageBadge.textContent = stageLabel(state.workbook.pipeline_stage);
    stageBadge.dataset.stage = state.workbook.pipeline_stage;
    addRow.disabled = !state.editable;
    addColumn.disabled = !state.editable;
    renderHeader();
    state.initialLoaded = true;
    document.body.classList.remove('base-loading');
    setStatus('Base sincronizada com o banco relacional.', 'success');
  }

  async function reload({ keepScroll = true } = {}) {
    const scrollTop = keepScroll ? viewport.scrollTop : 0;
    state.rows.clear();
    state.loading.clear();
    state.initialLoaded = false;
    await fetchChunk(Math.floor(scrollTop / ROW_HEIGHT));
    viewport.scrollTop = scrollTop;
  }

  async function saveCell(row, column, input) {
    input.disabled = true;
    setStatus(`Salvando ${column.name}…`);
    try {
      const updated = await api(`/api/bases/${workbookId}/rows/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          base_revision: row.revision,
          values: { [column.column_key]: inputValue(input, column.data_type) },
        }),
      });
      row.values = updated.values;
      row.revision = updated.revision;
      row.updated_at = updated.updated_at;
      input.value = formatValue(updated.values?.[column.column_key], column.data_type);
      input.dataset.original = input.value;
      input.dataset.dirty = 'false';
      input.dataset.error = 'false';
      setStatus('Registro salvo.', 'success');
    } catch (error) {
      input.dataset.error = 'true';
      if (error.status === 409 && error.payload?.current) {
        Object.assign(row, error.payload.current);
        input.value = formatValue(row.values?.[column.column_key], column.data_type);
        input.dataset.original = input.value;
      }
      setStatus(error.message, 'error');
    } finally {
      input.disabled = !state.editable;
    }
  }

  async function createRow() {
    addRow.disabled = true;
    setStatus('Criando registro…');
    try {
      await api(`/api/bases/${workbookId}/rows`, { method: 'POST', body: JSON.stringify({ values: {} }) });
      state.total += 1;
      state.rows.clear();
      await fetchChunk(Math.max(0, state.total - 1));
      viewport.scrollTop = Math.max(0, state.total * ROW_HEIGHT - viewport.clientHeight);
      scheduleRender();
      setStatus('Registro criado.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      addRow.disabled = !state.editable;
    }
  }

  async function deleteRow(row) {
    if (!confirm('Excluir este registro da Base?')) return;
    setStatus('Excluindo registro…');
    try {
      await api(`/api/bases/${workbookId}/rows/${row.id}`, { method: 'DELETE' });
      state.total = Math.max(0, state.total - 1);
      await reload();
      setStatus('Registro excluído.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function deleteColumn(column) {
    if (!confirm(`Excluir a coluna ${column.name}? Os valores deixarão de aparecer na Base.`)) return;
    setStatus('Excluindo coluna…');
    try {
      await api(`/api/bases/${workbookId}/columns/${column.id}`, { method: 'DELETE' });
      await reload();
      setStatus('Coluna excluída.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function renameBase() {
    if (!state.editable || !state.workbook) return;
    const name = nameInput.value.trim();
    if (!name || name === state.workbook.name) {
      nameInput.value = state.workbook.name;
      return;
    }
    nameInput.disabled = true;
    setStatus('Renomeando Base…');
    try {
      const updated = await api(`/api/bases/${workbookId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      state.workbook.name = updated.name;
      state.workbook.revision = updated.revision;
      nameInput.value = updated.name;
      document.title = `${updated.name} — Super Excel`;
      setStatus('Base renomeada.', 'success');
    } catch (error) {
      nameInput.value = state.workbook.name;
      setStatus(error.message, 'error');
    } finally {
      nameInput.disabled = !state.editable;
    }
  }

  viewport.addEventListener('scroll', scheduleRender, { passive: true });
  new ResizeObserver(scheduleRender).observe(viewport);
  addRow.addEventListener('click', createRow);
  addColumn.addEventListener('click', () => {
    columnForm.reset();
    columnError.textContent = '';
    columnDialog.showModal();
    requestAnimationFrame(() => columnForm.elements.name.focus());
  });
  columnDialog.querySelector('[data-close-column]').addEventListener('click', () => columnDialog.close());
  columnForm.addEventListener('submit', async event => {
    event.preventDefault();
    columnSave.disabled = true;
    columnError.textContent = '';
    try {
      const form = new FormData(columnForm);
      await api(`/api/bases/${workbookId}/columns`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          data_type: form.get('data_type'),
          required: form.get('required') === 'on',
        }),
      });
      columnDialog.close();
      await reload();
      setStatus('Coluna criada.', 'success');
    } catch (error) {
      columnError.textContent = error.message;
    } finally {
      columnSave.disabled = false;
    }
  });
  nameInput.addEventListener('change', renameBase);
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      nameInput.blur();
    }
  });

  async function initialize() {
    await window.SuperExcelAuth.ready;
    await fetchChunk(0);
    document.title = `${state.workbook?.name || 'Base'} — Super Excel`;
  }

  initialize().catch(error => {
    document.body.classList.remove('base-loading');
    setStatus(error.message, 'error');
  });
})();
