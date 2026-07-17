(() => {
  'use strict';

  const Store = window.SuperExcelSparseStore?.SparseWorkbookStore;
  const viewportRange = window.SuperExcelViewport?.viewportRange;
  const Interaction = window.SuperExcelGridInteraction;
  const engineApi = window.SuperExcelFormulaEngine;
  if (!Store || !viewportRange || !Interaction || !engineApi) {
    throw new Error('Módulos da grade virtual não foram carregados.');
  }

  const ROW_HEIGHT = 26;
  const COL_WIDTH = 118;
  const HEADER_HEIGHT = 28;
  const ROW_HEADER_WIDTH = 48;
  const MAX_ROWS = 5000;
  const MAX_COLS = 300;
  const AUTOSAVE = 'super-excel-autosave-v2';
  const MAX_PATCH_CHANGES = 10000;
  const FORMULAS = [
    ['SOMA', 'Soma valores', '=SOMA(B2:B20)'], ['MÉDIA', 'Calcula a média', '=MÉDIA(B2:B20)'],
    ['MÁXIMO', 'Maior valor', '=MÁXIMO(B2:B20)'], ['MÍNIMO', 'Menor valor', '=MÍNIMO(B2:B20)'],
    ['SE', 'Executa uma condição', '=SE(B2>=1000;"Meta atingida";"Abaixo da meta")'],
    ['SES', 'Várias condições', '=SES(B2>=1000;"Alta";B2>=500;"Média";VERDADEIRO;"Baixa")'],
    ['E', 'Todas as condições', '=E(B2>0;C2="Pago")'], ['OU', 'Qualquer condição', '=OU(C2="Pago";C2="Parcial")'],
    ['SEERRO', 'Substitui erros', '=SEERRO(A2/B2;0)'], ['CONT.NÚM', 'Conta números', '=CONT.NÚM(B2:B100)'],
    ['CONT.VALORES', 'Conta células preenchidas', '=CONT.VALORES(A2:A100)'], ['CONT.SE', 'Conta por critério', '=CONT.SE(C2:C100;"Pago")'],
    ['CONT.SES', 'Conta por critérios', '=CONT.SES(C2:C100;"Pago";B2:B100;">1000")'],
    ['SOMASE', 'Soma por critério', '=SOMASE(C2:C100;"Pago";B2:B100)'],
    ['SOMASES', 'Soma por critérios', '=SOMASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")'],
    ['MÉDIASE', 'Média por critério', '=MÉDIASE(C2:C100;"William";B2:B100)'],
    ['MÉDIASES', 'Média por critérios', '=MÉDIASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")'],
    ['PROCV', 'Busca vertical', '=PROCV(A2;F2:H20;3;FALSO)'], ['PROCX', 'Busca moderna', '=PROCX(A2;F2:F20;H2:H20;"Não encontrado")'],
    ['ÍNDICE', 'Valor pela posição', '=ÍNDICE(D2:D100;5)'], ['CORRESP', 'Posição de um valor', '=CORRESP(A2;F2:F100;0)'],
    ['FILTRO', 'Filtra linhas', '=FILTRO(A2:D20;D2:D20="Pendente")'], ['ÚNICO', 'Valores únicos', '=ÚNICO(B2:B20)'],
    ['CLASSIFICAR', 'Ordena intervalo', '=CLASSIFICAR(A2:D20;4;-1)'], ['CONCAT', 'Junta textos', '=CONCAT(A2;" - ";B2)'],
    ['TEXTO.JUNTAR', 'Junta com separador', '=TEXTO.JUNTAR(", ";VERDADEIRO;A2:A10)'],
    ['ESQUERDA', 'Texto do início', '=ESQUERDA(A2;3)'], ['DIREITA', 'Texto do final', '=DIREITA(A2;4)'],
    ['TEXTO', 'Formata valor', '=TEXTO(B2;"R$ #.##0,00")'], ['HOJE', 'Data atual', '=HOJE()'],
  ];

  const $ = selector => document.querySelector(selector);
  const shell = $('.sheet-shell');
  const grid = $('#spreadsheet');
  const formula = $('#formula-input');
  const addressBox = $('#cell-address');
  const status = $('#status-message');
  const summary = $('#selection-summary');
  const nameInput = $('#workbook-name');
  const functionsDialog = $('#functions-dialog');
  const functionsList = $('#functions-list');
  const openDialog = $('#open-dialog');
  const openList = $('#workbooks-list');

  let workbookId = Number(document.documentElement.dataset.workbookId || 0) || null;
  let store = new Store(window.SuperExcelInitialWorkbook || {}, { maxRows: MAX_ROWS, maxCols: MAX_COLS });
  let engine = null;
  let selected = { row: 0, col: 0 };
  let selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  let editing = null;
  let applyingRemote = 0;
  let renderFrame = null;
  let persistTimer = null;
  let dragSelection = null;
  let visibleCells = new Map();
  let visibleHeaders = [];
  let lastRenderMs = 0;

  grid.classList.add('virtual-grid');
  grid.tabIndex = 0;
  const canvas = document.createElement('div');
  canvas.className = 'virtual-grid-canvas';
  grid.append(canvas);

  function colName(index) {
    let result = '';
    for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
      result = String.fromCharCode(65 + ((number - 1) % 26)) + result;
    }
    return result;
  }

  function cellAddress(row, col) { return `${colName(col)}${row + 1}`; }
  function bounds(value = selection) { return Interaction.normalizeBounds(value); }
  function clampRow(value) { return Math.max(0, Math.min(MAX_ROWS - 1, Number(value) || 0)); }
  function clampCol(value) { return Math.max(0, Math.min(MAX_COLS - 1, Number(value) || 0)); }
  function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function focusGrid() {
    if (document.activeElement !== grid) grid.focus({ preventScroll: true });
  }

  function parseInput(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (text.startsWith('=')) return text;
    if (/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/u.test(text)) return Number(text.replaceAll('.', '').replace(',', '.'));
    if (/^(VERDADEIRO|FALSO|TRUE|FALSE)$/iu.test(text)) return /^(VERDADEIRO|TRUE)$/iu.test(text);
    return value;
  }

  function engineMatrix() {
    let lastRow = -1;
    let lastCol = -1;
    for (const { row, col } of store.entries()) {
      lastRow = Math.max(lastRow, row);
      lastCol = Math.max(lastCol, col);
    }
    if (lastRow < 0 || lastCol < 0) return [];
    const matrix = Array.from({ length: lastRow + 1 }, () => Array(lastCol + 1).fill(null));
    for (const { row, col, value } of store.entries()) matrix[row][col] = value;
    return matrix;
  }

  function rebuildEngine() {
    engine?.destroy?.();
    engine = engineApi.create(engineMatrix());
    scheduleRender();
  }

  function displayValue(row, col) {
    const coordinate = { sheet: 0, row, col };
    const value = engine.getCellValue(coordinate);
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'number') {
      const type = String(engine.getCellValueDetailedType(coordinate));
      if (type.includes('DATE')) {
        const date = new Date(Date.UTC(1899, 11, 30));
        date.setUTCDate(date.getUTCDate() + Math.floor(value));
        return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date);
      }
      return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 }).format(value);
    }
    return String(value);
  }

  function updateCanvasSize() {
    canvas.style.width = `${ROW_HEADER_WIDTH + store.cols * COL_WIDTH}px`;
    canvas.style.height = `${HEADER_HEIGHT + store.rows * ROW_HEIGHT}px`;
  }

  function clearVisible() {
    visibleCells.clear();
    visibleHeaders.length = 0;
    canvas.replaceChildren();
  }

  function selectionClasses(row, col) {
    const selectedBounds = bounds();
    const classes = [];
    const inside = row >= selectedBounds.top && row <= selectedBounds.bottom
      && col >= selectedBounds.left && col <= selectedBounds.right;
    if (!inside) return classes;
    if (selectedBounds.top === selectedBounds.bottom && selectedBounds.left === selectedBounds.right) {
      classes.push('selected');
    } else {
      classes.push('range-selected');
      if (row === selected.row && col === selected.col) classes.push('selection-anchor');
      if (row === selectedBounds.top) classes.push('range-top');
      if (row === selectedBounds.bottom) classes.push('range-bottom');
      if (col === selectedBounds.left) classes.push('range-left');
      if (col === selectedBounds.right) classes.push('range-right');
    }
    return classes;
  }

  function renderViewport() {
    renderFrame = null;
    const started = performance.now();
    updateCanvasSize();
    const range = viewportRange({
      scrollTop: shell.scrollTop,
      scrollLeft: shell.scrollLeft,
      viewportHeight: shell.clientHeight,
      viewportWidth: shell.clientWidth,
      rows: store.rows,
      cols: store.cols,
      rowHeight: ROW_HEIGHT,
      cellWidth: COL_WIDTH,
      headerHeight: HEADER_HEIGHT,
      rowHeaderWidth: ROW_HEADER_WIDTH,
    });
    clearVisible();
    const fragment = document.createDocumentFragment();

    const corner = document.createElement('div');
    corner.className = 'virtual-grid-corner';
    corner.style.transform = `translate(${shell.scrollLeft}px, ${shell.scrollTop}px)`;
    fragment.append(corner);

    for (let col = range.left; col <= range.right; col += 1) {
      const header = document.createElement('div');
      header.className = 'virtual-grid-col-header';
      header.textContent = colName(col);
      header.style.transform = `translate(${ROW_HEADER_WIDTH + col * COL_WIDTH}px, ${shell.scrollTop}px)`;
      fragment.append(header);
      visibleHeaders.push(header);
    }

    for (let row = range.top; row <= range.bottom; row += 1) {
      const header = document.createElement('div');
      header.className = 'virtual-grid-row-header';
      header.textContent = String(row + 1);
      header.style.transform = `translate(${shell.scrollLeft}px, ${HEADER_HEIGHT + row * ROW_HEIGHT}px)`;
      fragment.append(header);
      visibleHeaders.push(header);

      for (let col = range.left; col <= range.right; col += 1) {
        const cell = document.createElement('div');
        cell.id = `grid-cell-${row}-${col}`;
        cell.className = 'virtual-grid-cell cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.style.transform = `translate(${ROW_HEADER_WIDTH + col * COL_WIDTH}px, ${HEADER_HEIGHT + row * ROW_HEIGHT}px)`;
        const source = store.get(row, col);
        const shown = displayValue(row, col);
        const editingThisCell = editing && row === editing.row && col === editing.col;
        cell.textContent = editingThisCell ? formula.value : shown;
        if (typeof source === 'string' && source.trimStart().startsWith('=')) cell.classList.add('formula-cell');
        if (shown.startsWith('#')) cell.classList.add('error-cell');
        if (editingThisCell) cell.classList.add('editing');
        cell.classList.add(...selectionClasses(row, col));
        visibleCells.set(`${row}:${col}`, cell);
        fragment.append(cell);
      }
    }

    canvas.append(fragment);
    grid.setAttribute('aria-activedescendant', `grid-cell-${selected.row}-${selected.col}`);
    lastRenderMs = performance.now() - started;
    window.dispatchEvent(new CustomEvent('superexcel:render-metrics', {
      detail: { render_ms: lastRenderMs, dom_cells: visibleCells.size },
    }));
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(renderViewport);
  }

  function updateSelectionUi() {
    const selectedBounds = bounds();
    addressBox.textContent = selectedBounds.top === selectedBounds.bottom && selectedBounds.left === selectedBounds.right
      ? cellAddress(selected.row, selected.col)
      : `${cellAddress(selectedBounds.top, selectedBounds.left)}:${cellAddress(selectedBounds.bottom, selectedBounds.right)}`;
    if (!editing) formula.value = store.get(selected.row, selected.col) ?? '';

    const count = (selectedBounds.bottom - selectedBounds.top + 1)
      * (selectedBounds.right - selectedBounds.left + 1);
    let filled = 0;
    let numericCount = 0;
    let sum = 0;
    for (const { row, col } of store.entries()) {
      if (row < selectedBounds.top || row > selectedBounds.bottom || col < selectedBounds.left || col > selectedBounds.right) continue;
      const value = engine.getCellValue({ sheet: 0, row, col });
      if (value !== null && value !== '') filled += 1;
      if (typeof value === 'number' && Number.isFinite(value)) {
        numericCount += 1;
        sum += value;
      }
    }
    const parts = count === 1 ? [] : [`${count} células selecionadas`];
    if (filled) parts.push(`${filled} preenchidas`);
    if (numericCount) parts.push(`Soma: ${new Intl.NumberFormat('pt-BR').format(sum)}`);
    summary.textContent = parts.join(' · ');
    scheduleRender();
  }

  function ensureCellVisible(row, col) {
    const top = HEADER_HEIGHT + row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const left = ROW_HEADER_WIDTH + col * COL_WIDTH;
    const right = left + COL_WIDTH;
    const visibleTop = shell.scrollTop + HEADER_HEIGHT;
    const visibleBottom = shell.scrollTop + shell.clientHeight;
    const visibleLeft = shell.scrollLeft + ROW_HEADER_WIDTH;
    const visibleRight = shell.scrollLeft + shell.clientWidth;
    if (top < visibleTop) shell.scrollTop = Math.max(0, top - HEADER_HEIGHT);
    else if (bottom > visibleBottom) shell.scrollTop = Math.max(0, bottom - shell.clientHeight);
    if (left < visibleLeft) shell.scrollLeft = Math.max(0, left - ROW_HEADER_WIDTH);
    else if (right > visibleRight) shell.scrollLeft = Math.max(0, right - shell.clientWidth);
  }

  function selectCell(row, col, focus = true) {
    selected = { row: clampRow(row), col: clampCol(col) };
    selection = { startRow: selected.row, startCol: selected.col, endRow: selected.row, endCol: selected.col };
    editing = null;
    ensureCellVisible(selected.row, selected.col);
    updateSelectionUi();
    if (focus) focusGrid();
  }

  function extendSelection(rowDelta, colDelta) {
    selection.endRow = clampRow(selection.endRow + rowDelta);
    selection.endCol = clampCol(selection.endCol + colDelta);
    ensureCellVisible(selection.endRow, selection.endCol);
    updateSelectionUi();
    focusGrid();
  }

  function emitChanges(changes, reason = 'edit') {
    if (applyingRemote || !changes.length) return;
    window.dispatchEvent(new CustomEvent('superexcel:changes', {
      detail: { changes, reason, name: nameInput.value.trim() || 'Minha Planilha' },
    }));
  }

  function emitName() {
    if (applyingRemote) return;
    window.dispatchEvent(new CustomEvent('superexcel:name', {
      detail: { name: nameInput.value.trim() || 'Minha Planilha' },
    }));
  }

  function persistNow() {
    clearTimeout(persistTimer);
    try { localStorage.setItem(AUTOSAVE, JSON.stringify(store.toPayload(nameInput.value))); }
    catch (error) { console.warn('Autosave local indisponível.', error); }
  }

  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 700);
  }

  function applyChanges(changes, options = {}) {
    const deduplicated = new Map();
    for (const item of Array.isArray(changes) ? changes : []) {
      const row = Number(item?.row);
      const col = Number(item?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) {
        if (options.remote) return { requiresReload: true, applied: 0 };
        continue;
      }
      deduplicated.set(`${row}:${col}`, { row, col, value: item?.value ?? null });
    }
    const normalized = [...deduplicated.values()];
    if (!normalized.length) return { requiresReload: false, applied: 0 };

    engine.suspendEvaluation?.();
    try {
      for (const change of normalized) {
        store.set(change.row, change.col, change.value);
        engine.setCellContents(
          { sheet: 0, row: change.row, col: change.col },
          [[engineApi.normalizeFormula(change.value)]],
        );
      }
    } finally {
      engine.resumeEvaluation?.();
    }
    persistSoon();
    scheduleRender();
    if (!options.remote) emitChanges(normalized, options.reason || 'batch');
    return { requiresReload: false, applied: normalized.length };
  }

  function commit(value) {
    const target = editing ? { ...editing } : { ...selected };
    const parsed = parseInput(value);
    const before = store.get(target.row, target.col);
    try {
      if (JSON.stringify(before) !== JSON.stringify(parsed)) {
        applyChanges([{ row: target.row, col: target.col, value: parsed }], { reason: 'edit' });
      }
      editing = null;
      selected = target;
      selection = { startRow: target.row, startCol: target.col, endRow: target.row, endCol: target.col };
      formula.value = parsed ?? '';
      setStatus('Alteração calculada');
      updateSelectionUi();
      return true;
    } catch (error) {
      setStatus(error.message || 'Erro ao calcular.', true);
      scheduleRender();
      return false;
    }
  }

  function startEdit(initialValue) {
    if (!editing) editing = { ...selected };
    selected = { ...editing };
    selection = { startRow: editing.row, startCol: editing.col, endRow: editing.row, endCol: editing.col };
    formula.value = initialValue !== undefined ? initialValue : (store.get(editing.row, editing.col) ?? '');
    updateSelectionUi();
    formula.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const end = formula.value.length;
      formula.setSelectionRange(end, end);
    });
  }

  function cancelEdit() {
    const target = editing ? { ...editing } : { ...selected };
    editing = null;
    selected = target;
    selection = { startRow: target.row, startCol: target.col, endRow: target.row, endCol: target.col };
    formula.value = store.get(target.row, target.col) ?? '';
    updateSelectionUi();
    focusGrid();
  }

  function clearSelection() {
    const changes = Interaction.collectClearChanges(store, selection, MAX_PATCH_CHANGES);
    if (!changes.length) {
      setStatus('A seleção já está vazia');
      focusGrid();
      return;
    }
    applyChanges(changes, { reason: 'clear' });
    setStatus(`${changes.length} célula(s) apagada(s)`);
    updateSelectionUi();
    focusGrid();
  }

  function moveSelection(rowDelta, colDelta) {
    if (editing && !commit(formula.value)) return;
    selectCell(selected.row + rowDelta, selected.col + colDelta);
  }

  function snapshotDiff(beforeEntries, afterStore) {
    const previous = new Map(beforeEntries.map(item => [`${item.row}:${item.col}`, item.value]));
    const next = new Map([...afterStore.entries()].map(item => [`${item.row}:${item.col}`, item.value]));
    const changes = [];
    const keys = new Set([...previous.keys(), ...next.keys()]);
    for (const key of keys) {
      const before = previous.get(key) ?? null;
      const after = next.get(key) ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const [row, col] = key.split(':').map(Number);
      changes.push({ row, col, value: after });
      if (changes.length >= MAX_PATCH_CHANGES) break;
    }
    return changes;
  }

  function replaceSnapshot(payload) {
    editing = null;
    store = new Store(payload || {}, { maxRows: MAX_ROWS, maxCols: MAX_COLS });
    nameInput.value = payload?.name || 'Minha Planilha';
    rebuildEngine();
    selectCell(0, 0, false);
    persistSoon();
  }

  function syncFromEngine(reason) {
    const serialized = engine.getSheetSerialized();
    const next = [];
    const previous = new Map([...store.entries()].map(item => [`${item.row}:${item.col}`, item.value]));
    const seen = new Set();
    serialized.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
      const key = `${rowIndex}:${colIndex}`;
      seen.add(key);
      if (JSON.stringify(previous.get(key) ?? null) !== JSON.stringify(value ?? null)) {
        next.push({ row: rowIndex, col: colIndex, value: value ?? null });
      }
    }));
    for (const [key] of previous) {
      if (seen.has(key)) continue;
      const [row, col] = key.split(':').map(Number);
      next.push({ row, col, value: null });
    }
    applyChanges(next, { reason });
    updateSelectionUi();
  }

  function renderFunctions() {
    functionsList.replaceChildren();
    FORMULAS.forEach(([name, description, example], index) => {
      const card = document.createElement('article');
      card.className = 'formula-card';
      card.innerHTML = `<span class="formula-number">${String(index + 1).padStart(2, '0')}</span><div><strong></strong><p></p><code></code></div><button>Usar</button>`;
      card.querySelector('strong').textContent = name;
      card.querySelector('p').textContent = description;
      card.querySelector('code').textContent = example;
      card.querySelector('button').onclick = () => { functionsDialog.close(); startEdit(example); };
      functionsList.append(card);
    });
  }

  async function listServer() {
    openList.innerHTML = '<p class="muted">Carregando...</p>';
    openDialog.showModal();
    const response = await fetch('/api/workbooks');
    const list = await response.json();
    if (!response.ok) throw new Error(list.error || 'Erro ao listar planilhas.');
    openList.replaceChildren();
    for (const workbook of list) {
      const item = document.createElement('div');
      item.className = 'workbook-item';
      item.innerHTML = '<div><strong></strong><small></small></div><div><button class="primary">Abrir</button></div>';
      item.querySelector('strong').textContent = workbook.name;
      item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
      item.querySelector('button').onclick = () => { location.href = `/sheet/${workbook.id}`; };
      openList.append(item);
    }
  }

  shell.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });

  grid.addEventListener('mousedown', event => {
    const target = event.target.closest('.virtual-grid-cell');
    if (!target || event.button !== 0) return;
    event.preventDefault();
    const row = Number(target.dataset.row);
    const col = Number(target.dataset.col);
    if (editing && !commit(formula.value)) return;
    selected = { row, col };
    selection = { startRow: row, startCol: col, endRow: row, endCol: col };
    dragSelection = { row, col };
    updateSelectionUi();
    focusGrid();
  });

  grid.addEventListener('mousemove', event => {
    if (!dragSelection) return;
    const target = event.target.closest('.virtual-grid-cell');
    if (!target) return;
    selection.endRow = clampRow(target.dataset.row);
    selection.endCol = clampCol(target.dataset.col);
    updateSelectionUi();
  });

  window.addEventListener('mouseup', () => {
    if (!dragSelection) return;
    dragSelection = null;
    focusGrid();
  });

  grid.addEventListener('dblclick', event => {
    if (event.target.closest('.virtual-grid-cell')) startEdit();
  });

  grid.addEventListener('keydown', event => {
    const action = Interaction.keyboardAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === 'move') moveSelection(action.rowDelta, action.colDelta);
    else if (action.type === 'extend') extendSelection(action.rowDelta, action.colDelta);
    else if (action.type === 'clear') clearSelection();
    else if (action.type === 'edit') startEdit(action.initialValue);
  });

  grid.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const matrix = text.replace(/\r/g, '').split('\n')
      .filter((line, index, lines) => line || index < lines.length - 1)
      .map(row => row.split('\t').map(parseInput));
    const changes = [];
    matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => {
      const targetRow = selected.row + rowOffset;
      const targetCol = selected.col + colOffset;
      if (targetRow < MAX_ROWS && targetCol < MAX_COLS) changes.push({ row: targetRow, col: targetCol, value });
    }));
    applyChanges(changes, { reason: 'paste' });
    setStatus(`${matrix.length} linha(s) colada(s)`);
    updateSelectionUi();
    focusGrid();
  });

  formula.addEventListener('focus', () => {
    if (!editing) startEdit();
  });
  formula.addEventListener('input', () => {
    if (editing) {
      summary.textContent = formula.value ? `Editando: ${formula.value}` : '';
      scheduleRender();
    }
  });
  formula.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commit(formula.value)) moveSelection(1, 0);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  });
  formula.addEventListener('blur', () => {
    const target = editing;
    if (!target) return;
    queueMicrotask(() => {
      if (!editing || editing.row !== target.row || editing.col !== target.col) return;
      if (document.activeElement === formula) return;
      commit(formula.value);
    });
  });

  nameInput.addEventListener('input', () => {
    store.name = nameInput.value;
    persistSoon();
    emitName();
  });

  $('#clear-button').onclick = clearSelection;
  $('#functions-button').onclick = () => functionsDialog.showModal();
  $('#open-button').onclick = () => listServer().catch(error => setStatus(error.message, true));
  $('#new-button').onclick = () => {
    const changes = [...store.entries()].slice(0, MAX_PATCH_CHANGES)
      .map(item => ({ row: item.row, col: item.col, value: null }));
    store.clear();
    nameInput.value = 'Minha Planilha';
    rebuildEngine();
    selectCell(0, 0);
    emitChanges(changes, 'new');
    emitName();
  };
  $('#example-button').onclick = () => applyChanges([
    { row: 0, col: 0, value: 'Produto' }, { row: 0, col: 1, value: 'Status' }, { row: 0, col: 2, value: 'Valor' },
    { row: 1, col: 0, value: 'Porta bronze' }, { row: 1, col: 1, value: 'Pago' }, { row: 1, col: 2, value: 3200 },
    { row: 2, col: 0, value: 'Porta preta' }, { row: 2, col: 1, value: 'Pendente' }, { row: 2, col: 2, value: 2100 },
    { row: 3, col: 1, value: 'Total pago' }, { row: 3, col: 2, value: '=SOMASE(B2:B3;"Pago";C2:C3)' },
  ], { reason: 'example' });
  $('#export-button').onclick = () => {
    const blob = new Blob([JSON.stringify(store.toPayload(nameInput.value), null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'planilha.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };
  $('#import-input').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    const previous = [...store.entries()];
    replaceSnapshot(JSON.parse(await file.text()));
    emitChanges(snapshotDiff(previous, store), 'replace');
    event.target.value = '';
  };
  $('#undo-button').onclick = () => {
    if (engine.isThereSomethingToUndo()) {
      engine.undo();
      syncFromEngine('undo');
    }
    focusGrid();
  };
  $('#redo-button').onclick = () => {
    if (engine.isThereSomethingToRedo()) {
      engine.redo();
      syncFromEngine('redo');
    }
    focusGrid();
  };
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.onclick = () => document.querySelector(`#${button.dataset.closeDialog}`).close();
  });
  window.addEventListener('beforeunload', () => {
    if (editing) commit(formula.value);
    persistNow();
  });

  nameInput.value = store.name;
  rebuildEngine();
  renderFunctions();
  updateSelectionUi();
  focusGrid();

  window.SuperExcelApp = Object.freeze({
    get rows() { return store.rows; },
    get cols() { return store.cols; },
    getSnapshot: () => store.toPayload(nameInput.value),
    getStoreStats: () => store.stats(),
    getDomStats: () => ({ render_ms: lastRenderMs, mounted_cells: visibleCells.size }),
    isEditing: () => Boolean(editing),
    getRenderStats: () => ({ render_ms: lastRenderMs, dom_cells: visibleCells.size }),
    applyRemoteChanges(changes, metadata = {}) {
      applyingRemote += 1;
      try {
        if (metadata.name) {
          nameInput.value = metadata.name;
          store.name = metadata.name;
        }
        return applyChanges(changes, { remote: true });
      } finally {
        applyingRemote -= 1;
      }
    },
    replaceSnapshot(payload) {
      applyingRemote += 1;
      try { replaceSnapshot(payload); }
      finally { applyingRemote -= 1; }
    },
    flushLocal: persistNow,
    setWorkbookId(value) { workbookId = Number(value) || workbookId; },
  });
  window.dispatchEvent(new CustomEvent('superexcel:ready'));
})();
