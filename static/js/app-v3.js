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
  const PATCH_CHUNK_SIZE = 10000;
  const HISTORY_LIMIT = 100;
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

  if (!shell || !grid || !formula || !addressBox || !status || !summary || !nameInput) {
    throw new Error('Estrutura da planilha incompleta.');
  }

  let workbookId = Number(document.documentElement.dataset.workbookId || 0) || null;
  let store = new Store(loadInitialPayload(), { maxRows: MAX_ROWS, maxCols: MAX_COLS });
  let engine = null;
  let selected = { row: 0, col: 0 };
  let selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  let editing = null;
  let applyingRemote = 0;
  let renderFrame = null;
  let persistTimer = null;
  let dragSelection = null;
  let visibleCells = new Map();
  let lastRenderMs = 0;
  let undoStack = [];
  let redoStack = [];

  grid.classList.add('virtual-grid');
  grid.tabIndex = 0;
  grid.setAttribute('aria-multiselectable', 'true');
  const canvas = document.createElement('div');
  canvas.className = 'virtual-grid-canvas';
  const editor = document.createElement('input');
  editor.className = 'virtual-grid-editor cell';
  editor.type = 'text';
  editor.spellcheck = false;
  editor.autocomplete = 'off';
  editor.hidden = true;
  editor.setAttribute('aria-label', 'Editor da célula');
  grid.append(canvas, editor);

  function loadInitialPayload() {
    const initial = window.SuperExcelInitialWorkbook || {};
    if (workbookId || (Array.isArray(initial.cells) && initial.cells.length)) return initial;
    try {
      const cached = JSON.parse(localStorage.getItem(AUTOSAVE) || 'null');
      if (cached && typeof cached === 'object') return cached;
    } catch (error) {
      console.warn('Autosave local inválido; iniciando uma planilha vazia.', error);
    }
    return initial;
  }

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
  function sameValue(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
  function setStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }
  function canMutate(quiet = false) {
    const allowed = !document.body.classList.contains('sheet-readonly');
    if (!allowed && !quiet) setStatus('Você possui acesso somente para visualização.', true);
    return allowed;
  }
  function focusGrid() {
    if (document.activeElement !== grid) grid.focus({ preventScroll: true });
  }

  function parseInput(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (text.startsWith('=')) return text;
    if (/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/u.test(text)) {
      return Number(text.replaceAll('.', '').replace(',', '.'));
    }
    if (/^(VERDADEIRO|FALSO|TRUE|FALSE)$/iu.test(text)) return /^(VERDADEIRO|TRUE)$/iu.test(text);
    return String(value ?? '');
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
      const type = String(engine.getCellValueDetailedType?.(coordinate) || '');
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
    const width = ROW_HEADER_WIDTH + store.cols * COL_WIDTH;
    const height = HEADER_HEIGHT + store.rows * ROW_HEIGHT;
    const renderedWidth = Math.max(width, shell.clientWidth || 0);
    const renderedHeight = Math.max(height, shell.clientHeight || 0);
    grid.style.width = `${renderedWidth}px`;
    grid.style.height = `${renderedHeight}px`;
    canvas.style.width = `${renderedWidth}px`;
    canvas.style.height = `${renderedHeight}px`;
    grid.setAttribute('aria-rowcount', String(store.rows));
    grid.setAttribute('aria-colcount', String(store.cols));
  }

  function selectionClasses(row, col) {
    if (!Interaction.selectionContains(selection, row, col)) return [];
    const selectedBounds = bounds();
    if (selectedBounds.top === selectedBounds.bottom && selectedBounds.left === selectedBounds.right) return ['selected'];
    const classes = ['range-selected'];
    if (row === selected.row && col === selected.col) classes.push('selection-anchor');
    if (row === selectedBounds.top) classes.push('range-top');
    if (row === selectedBounds.bottom) classes.push('range-bottom');
    if (col === selectedBounds.left) classes.push('range-left');
    if (col === selectedBounds.right) classes.push('range-right');
    return classes;
  }

  function positionEditor() {
    if (!editing) {
      editor.hidden = true;
      editor.classList.remove('editing');
      editor.removeAttribute('data-row');
      editor.removeAttribute('data-col');
      return;
    }
    editor.hidden = false;
    editor.classList.add('editing');
    editor.dataset.row = String(editing.row);
    editor.dataset.col = String(editing.col);
    editor.style.transform = `translate(${ROW_HEADER_WIDTH + editing.col * COL_WIDTH}px, ${HEADER_HEIGHT + editing.row * ROW_HEIGHT}px)`;
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

    visibleCells.clear();
    canvas.replaceChildren();
    const fragment = document.createDocumentFragment();
    const selectedBounds = bounds();

    const corner = document.createElement('div');
    corner.className = 'virtual-grid-corner';
    corner.dataset.header = 'corner';
    corner.setAttribute('role', 'button');
    corner.setAttribute('aria-label', 'Selecionar toda a planilha');
    corner.style.transform = `translate(${shell.scrollLeft}px, ${shell.scrollTop}px)`;
    fragment.append(corner);

    for (let col = range.left; col <= range.right; col += 1) {
      const header = document.createElement('div');
      header.className = 'virtual-grid-col-header';
      if (selectedBounds.left <= col && col <= selectedBounds.right
        && selectedBounds.top === 0 && selectedBounds.bottom === store.rows - 1) header.classList.add('header-selected');
      header.dataset.header = 'col';
      header.dataset.col = String(col);
      header.textContent = colName(col);
      header.setAttribute('role', 'columnheader');
      header.style.transform = `translate(${ROW_HEADER_WIDTH + col * COL_WIDTH}px, ${shell.scrollTop}px)`;
      fragment.append(header);
    }

    for (let row = range.top; row <= range.bottom; row += 1) {
      const header = document.createElement('div');
      header.className = 'virtual-grid-row-header';
      if (selectedBounds.top <= row && row <= selectedBounds.bottom
        && selectedBounds.left === 0 && selectedBounds.right === store.cols - 1) header.classList.add('header-selected');
      header.dataset.header = 'row';
      header.dataset.row = String(row);
      header.textContent = String(row + 1);
      header.setAttribute('role', 'rowheader');
      header.style.transform = `translate(${shell.scrollLeft}px, ${HEADER_HEIGHT + row * ROW_HEIGHT}px)`;
      fragment.append(header);

      for (let col = range.left; col <= range.right; col += 1) {
        const cell = document.createElement('div');
        const editingThisCell = editing && row === editing.row && col === editing.col;
        const source = store.get(row, col);
        const shown = displayValue(row, col);
        cell.id = `grid-cell-${row}-${col}`;
        cell.className = 'virtual-grid-cell cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-rowindex', String(row + 1));
        cell.setAttribute('aria-colindex', String(col + 1));
        cell.style.transform = `translate(${ROW_HEADER_WIDTH + col * COL_WIDTH}px, ${HEADER_HEIGHT + row * ROW_HEIGHT}px)`;
        cell.textContent = editingThisCell ? '' : shown;
        if (shown) cell.title = shown;
        if (typeof source === 'string' && source.trimStart().startsWith('=')) cell.classList.add('formula-cell');
        if (shown.startsWith('#')) cell.classList.add('error-cell');
        if (editingThisCell) cell.classList.add('editing');
        cell.classList.add(...selectionClasses(row, col));
        visibleCells.set(`${row}:${col}`, cell);
        fragment.append(cell);
      }
    }

    canvas.append(fragment);
    positionEditor();
    const activeId = `grid-cell-${selected.row}-${selected.col}`;
    if (visibleCells.has(`${selected.row}:${selected.col}`)) grid.setAttribute('aria-activedescendant', activeId);
    else grid.removeAttribute('aria-activedescendant');
    lastRenderMs = performance.now() - started;
    window.dispatchEvent(new CustomEvent('superexcel:render-metrics', {
      detail: { render_ms: lastRenderMs, dom_cells: visibleCells.size },
    }));
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(renderViewport);
  }

  function usedBounds() {
    let bottom = 0;
    let right = 0;
    for (const { row, col } of store.entries()) {
      bottom = Math.max(bottom, row);
      right = Math.max(right, col);
    }
    return { bottom, right };
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
      if (!Interaction.selectionContains(selection, row, col)) continue;
      const value = engine.getCellValue({ sheet: 0, row, col });
      if (value !== null && value !== '') filled += 1;
      if (typeof value === 'number' && Number.isFinite(value)) {
        numericCount += 1;
        sum += value;
      }
    }
    const parts = count === 1 ? [] : [`${count.toLocaleString('pt-BR')} células selecionadas`];
    if (filled) parts.push(`${filled.toLocaleString('pt-BR')} preenchidas`);
    if (numericCount) parts.push(`Soma: ${new Intl.NumberFormat('pt-BR').format(sum)}`);
    summary.textContent = editing ? `Editando ${cellAddress(editing.row, editing.col)}` : parts.join(' · ');
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
    else if (bottom > visibleBottom) shell.scrollTop = Math.max(0, bottom - shell.clientHeight + HEADER_HEIGHT);
    if (left < visibleLeft) shell.scrollLeft = Math.max(0, left - ROW_HEADER_WIDTH);
    else if (right > visibleRight) shell.scrollLeft = Math.max(0, right - shell.clientWidth + ROW_HEADER_WIDTH);
  }

  function setSelection(anchorRow, anchorCol, activeRow = anchorRow, activeCol = anchorCol, focus = true) {
    const startRow = clampRow(anchorRow);
    const startCol = clampCol(anchorCol);
    const endRow = clampRow(activeRow);
    const endCol = clampCol(activeCol);
    selected = { row: endRow, col: endCol };
    selection = { startRow, startCol, endRow, endCol };
    ensureCellVisible(endRow, endCol);
    updateSelectionUi();
    if (focus) focusGrid();
  }

  function selectCell(row, col, focus = true) { setSelection(row, col, row, col, focus); }

  function extendSelection(rowDelta, colDelta) {
    setSelection(
      selection.startRow,
      selection.startCol,
      selected.row + rowDelta,
      selected.col + colDelta,
    );
  }

  function emitChanges(changes, reason = 'edit') {
    if (applyingRemote || !changes.length) return;
    for (let index = 0; index < changes.length; index += PATCH_CHUNK_SIZE) {
      window.dispatchEvent(new CustomEvent('superexcel:changes', {
        detail: {
          changes: changes.slice(index, index + PATCH_CHUNK_SIZE),
          reason,
          name: nameInput.value.trim() || 'Minha Planilha',
        },
      }));
    }
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
    persistTimer = setTimeout(persistNow, 500);
  }

  function normalizeChanges(changes) {
    const deduplicated = new Map();
    for (const item of Array.isArray(changes) ? changes : []) {
      const row = Number(item?.row);
      const col = Number(item?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS) continue;
      deduplicated.set(`${row}:${col}`, { row, col, value: item?.value ?? null });
    }
    return [...deduplicated.values()];
  }

  function pushHistory(before, after) {
    undoStack.push({ before, after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  function applyChanges(changes, options = {}) {
    if (!options.remote && !canMutate()) return { requiresReload: false, applied: 0, readonly: true };
    const normalized = normalizeChanges(changes);
    const before = [];
    const effective = [];
    for (const change of normalized) {
      const previous = store.get(change.row, change.col);
      if (sameValue(previous, change.value)) continue;
      before.push({ row: change.row, col: change.col, value: previous });
      effective.push(change);
    }
    if (!effective.length) return { requiresReload: false, applied: 0 };

    let engineError = null;
    engine.suspendEvaluation?.();
    try {
      for (const change of effective) {
        engine.setCellContents(
          { sheet: 0, row: change.row, col: change.col },
          [[engineApi.normalizeFormula(change.value)]],
        );
      }
    } catch (error) {
      engineError = error;
    } finally {
      engine.resumeEvaluation?.();
    }
    if (engineError) {
      rebuildEngine();
      throw engineError;
    }

    for (const change of effective) store.set(change.row, change.col, change.value);
    if (options.recordHistory !== false && !options.remote) pushHistory(before, effective.map(item => ({ ...item })));
    persistSoon();
    updateSelectionUi();
    if (!options.remote) emitChanges(effective, options.reason || 'batch');
    return { requiresReload: false, applied: effective.length };
  }

  function beginEdit(initialValue, options = {}) {
    if (!canMutate()) return;
    if (!editing) {
      editing = {
        row: selected.row,
        col: selected.col,
        original: store.get(selected.row, selected.col),
      };
    }
    selected = { row: editing.row, col: editing.col };
    selection = { startRow: editing.row, startCol: editing.col, endRow: editing.row, endCol: editing.col };
    const value = initialValue !== undefined ? String(initialValue) : String(store.get(editing.row, editing.col) ?? '');
    formula.value = value;
    editor.value = value;
    ensureCellVisible(editing.row, editing.col);
    positionEditor();
    updateSelectionUi();
    scheduleRender();

    const target = options.focus === 'formula' ? formula : editor;
    requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      if (options.selectAll) target.select();
      else {
        const end = target.value.length;
        target.setSelectionRange(end, end);
      }
    });
  }

  function finishEdit(value = editor.value) {
    if (!editing) return true;
    const target = { row: editing.row, col: editing.col };
    const parsed = parseInput(value);
    try {
      const result = applyChanges([{ row: target.row, col: target.col, value: parsed }], { reason: 'edit' });
      if (result.readonly) return false;
      editing = null;
      editor.hidden = true;
      editor.classList.remove('editing');
      selected = target;
      selection = { startRow: target.row, startCol: target.col, endRow: target.row, endCol: target.col };
      formula.value = parsed ?? '';
      setStatus('Alteração calculada');
      updateSelectionUi();
      return true;
    } catch (error) {
      setStatus(error.message || 'Erro ao calcular.', true);
      editor.focus({ preventScroll: true });
      return false;
    }
  }

  function cancelEdit() {
    if (!editing) return;
    const target = { row: editing.row, col: editing.col };
    editing = null;
    editor.hidden = true;
    editor.classList.remove('editing');
    selected = target;
    selection = { startRow: target.row, startCol: target.col, endRow: target.row, endCol: target.col };
    formula.value = store.get(target.row, target.col) ?? '';
    setStatus('Edição cancelada');
    updateSelectionUi();
    focusGrid();
  }

  function clearSelection() {
    if (!canMutate()) return;
    if (editing && !finishEdit()) return;
    const changes = Interaction.collectClearChanges(store, selection, Number.MAX_SAFE_INTEGER);
    if (!changes.length) {
      setStatus('A seleção já está vazia');
      focusGrid();
      return;
    }
    applyChanges(changes, { reason: 'clear' });
    setStatus(`${changes.length.toLocaleString('pt-BR')} célula(s) apagada(s)`);
    focusGrid();
  }

  function moveSelection(rowDelta, colDelta) {
    if (editing && !finishEdit()) return;
    selectCell(selected.row + rowDelta, selected.col + colDelta);
  }

  function jumpTarget(rowDelta, colDelta) {
    const entries = [...store.entries()];
    if (rowDelta) {
      const candidates = entries.filter(item => item.col === selected.col && (rowDelta > 0 ? item.row > selected.row : item.row < selected.row));
      if (candidates.length) return { row: rowDelta > 0 ? Math.min(...candidates.map(item => item.row)) : Math.max(...candidates.map(item => item.row)), col: selected.col };
      return { row: rowDelta > 0 ? store.rows - 1 : 0, col: selected.col };
    }
    const candidates = entries.filter(item => item.row === selected.row && (colDelta > 0 ? item.col > selected.col : item.col < selected.col));
    if (candidates.length) return { row: selected.row, col: colDelta > 0 ? Math.min(...candidates.map(item => item.col)) : Math.max(...candidates.map(item => item.col)) };
    return { row: selected.row, col: colDelta > 0 ? store.cols - 1 : 0 };
  }

  function moveTo(row, col, extend = false) {
    if (editing && !finishEdit()) return;
    if (extend) setSelection(selection.startRow, selection.startCol, row, col);
    else selectCell(row, col);
  }

  function selectAll() {
    if (editing && !finishEdit()) return;
    const used = usedBounds();
    setSelection(0, 0, used.bottom, used.right);
    setStatus('Toda a planilha selecionada');
  }

  function rawSelectionText() {
    const selectedBounds = bounds();
    const count = (selectedBounds.bottom - selectedBounds.top + 1)
      * (selectedBounds.right - selectedBounds.left + 1);
    if (count > 200000) throw new Error('Seleção grande demais para copiar de uma vez.');
    return Interaction.serializeSelection(store, selection, value => value ?? '');
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        console.debug('Clipboard API indisponível; usando fallback.', error);
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.append(textarea);
    textarea.select();
    const copied = Boolean(document.execCommand && document.execCommand('copy'));
    textarea.remove();
    focusGrid();
    return copied;
  }

  async function copySelection(cut = false) {
    const copiedSelection = { ...selection };
    let text;
    try { text = rawSelectionText(); }
    catch (error) {
      setStatus(error.message, true);
      return;
    }
    const copied = await writeClipboard(text);
    if (!copied) {
      setStatus('Não foi possível acessar a área de transferência.', true);
      return;
    }
    if (cut) {
      if (!canMutate()) {
        setStatus('Seleção copiada; recorte bloqueado no modo somente leitura');
        return;
      }
      const currentSelection = selection;
      selection = copiedSelection;
      clearSelection();
      selection = currentSelection;
      updateSelectionUi();
    } else setStatus('Seleção copiada');
  }

  function pasteMatrix(matrix) {
    if (!canMutate()) return;
    if (!Array.isArray(matrix) || !matrix.length) return;
    if (editing && !finishEdit()) return;
    const selectedBounds = bounds();
    const singleValue = matrix.length === 1 && matrix[0]?.length === 1;
    const changes = [];

    if (singleValue && (selectedBounds.top !== selectedBounds.bottom || selectedBounds.left !== selectedBounds.right)) {
      for (let row = selectedBounds.top; row <= selectedBounds.bottom; row += 1) {
        for (let col = selectedBounds.left; col <= selectedBounds.right; col += 1) {
          changes.push({ row, col, value: parseInput(matrix[0][0]) });
        }
      }
    } else {
      matrix.forEach((row, rowOffset) => row.forEach((value, colOffset) => {
        const targetRow = selected.row + rowOffset;
        const targetCol = selected.col + colOffset;
        if (targetRow < MAX_ROWS && targetCol < MAX_COLS) {
          changes.push({ row: targetRow, col: targetCol, value: parseInput(value) });
        }
      }));
      if (changes.length) {
        setSelection(
          selected.row,
          selected.col,
          Math.min(MAX_ROWS - 1, selected.row + matrix.length - 1),
          Math.min(MAX_COLS - 1, selected.col + Math.max(...matrix.map(row => row.length), 1) - 1),
          false,
        );
      }
    }

    applyChanges(changes, { reason: 'paste' });
    setStatus(`${changes.length.toLocaleString('pt-BR')} célula(s) colada(s)`);
    focusGrid();
  }

  function snapshotDiff(beforeEntries, afterStore) {
    const previous = new Map(beforeEntries.map(item => [`${item.row}:${item.col}`, item.value]));
    const next = new Map([...afterStore.entries()].map(item => [`${item.row}:${item.col}`, item.value]));
    const changes = [];
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const before = previous.get(key) ?? null;
      const after = next.get(key) ?? null;
      if (sameValue(before, after)) continue;
      const [row, col] = key.split(':').map(Number);
      changes.push({ row, col, value: after });
    }
    return changes;
  }

  function replaceSnapshot(payload) {
    editing = null;
    editor.hidden = true;
    editor.classList.remove('editing');
    store = new Store(payload || {}, { maxRows: MAX_ROWS, maxCols: MAX_COLS });
    nameInput.value = payload?.name || 'Minha Planilha';
    undoStack = [];
    redoStack = [];
    rebuildEngine();
    selectCell(0, 0, false);
    persistSoon();
  }

  function undo() {
    if (!canMutate()) return;
    if (editing && !finishEdit()) return;
    const transaction = undoStack.pop();
    if (!transaction) {
      setStatus('Nada para desfazer');
      focusGrid();
      return;
    }
    applyChanges(transaction.before, { reason: 'undo', recordHistory: false });
    redoStack.push(transaction);
    setStatus('Alteração desfeita');
    focusGrid();
  }

  function redo() {
    if (!canMutate()) return;
    if (editing && !finishEdit()) return;
    const transaction = redoStack.pop();
    if (!transaction) {
      setStatus('Nada para refazer');
      focusGrid();
      return;
    }
    applyChanges(transaction.after, { reason: 'redo', recordHistory: false });
    undoStack.push(transaction);
    setStatus('Alteração refeita');
    focusGrid();
  }

  function renderFunctions() {
    if (!functionsList) return;
    functionsList.replaceChildren();
    FORMULAS.forEach(([name, description, example], index) => {
      const card = document.createElement('article');
      card.className = 'formula-card';
      card.innerHTML = `<span class="formula-number">${String(index + 1).padStart(2, '0')}</span><div><strong></strong><p></p><code></code></div><button type="button">Usar</button>`;
      card.querySelector('strong').textContent = name;
      card.querySelector('p').textContent = description;
      card.querySelector('code').textContent = example;
      card.querySelector('button').onclick = () => {
        functionsDialog?.close();
        beginEdit(example, { focus: 'cell' });
      };
      functionsList.append(card);
    });
  }

  async function listServer() {
    if (!openList || !openDialog) return;
    openList.innerHTML = '<p class="muted">Carregando...</p>';
    openDialog.showModal();
    try {
      const response = await fetch('/api/workbooks');
      const list = await response.json();
      if (!response.ok) throw new Error(list.error || 'Erro ao listar planilhas.');
      openList.replaceChildren();
      for (const workbook of list) {
        const item = document.createElement('div');
        item.className = 'workbook-item';
        item.innerHTML = '<div><strong></strong><small></small></div><div><button class="primary" type="button">Abrir</button></div>';
        item.querySelector('strong').textContent = workbook.name;
        item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
        item.querySelector('button').onclick = () => { location.href = `/sheet/${workbook.id}`; };
        openList.append(item);
      }
      if (!list.length) openList.innerHTML = '<p class="muted">Nenhuma planilha disponível.</p>';
    } catch (error) {
      openList.innerHTML = '<p class="error-text"></p>';
      openList.querySelector('p').textContent = error.message || 'Erro ao listar planilhas.';
      throw error;
    }
  }

  function hitTestPointer(event) {
    const rect = shell.getBoundingClientRect();
    const viewX = event.clientX - rect.left;
    const viewY = event.clientY - rect.top;
    if (viewX < 0 || viewY < 0 || viewX > rect.width || viewY > rect.height) return null;
    if (viewX < ROW_HEADER_WIDTH && viewY < HEADER_HEIGHT) return { type: 'corner' };
    const contentX = shell.scrollLeft + viewX;
    const contentY = shell.scrollTop + viewY;
    if (viewY < HEADER_HEIGHT) {
      return { type: 'col', col: clampCol(Math.floor((contentX - ROW_HEADER_WIDTH) / COL_WIDTH)) };
    }
    if (viewX < ROW_HEADER_WIDTH) {
      return { type: 'row', row: clampRow(Math.floor((contentY - HEADER_HEIGHT) / ROW_HEIGHT)) };
    }
    return {
      type: 'cell',
      row: clampRow(Math.floor((contentY - HEADER_HEIGHT) / ROW_HEIGHT)),
      col: clampCol(Math.floor((contentX - ROW_HEADER_WIDTH) / COL_WIDTH)),
    };
  }

  function applyPointerSelection(hit, drag = false) {
    if (!hit) return;
    if (!drag) {
      if (hit.type === 'cell') setSelection(hit.row, hit.col, hit.row, hit.col, false);
      else if (hit.type === 'row') setSelection(hit.row, 0, hit.row, store.cols - 1, false);
      else if (hit.type === 'col') setSelection(0, hit.col, store.rows - 1, hit.col, false);
      else selectAll();
      return;
    }
    if (dragSelection?.type === 'cell' && hit.type === 'cell') {
      setSelection(dragSelection.row, dragSelection.col, hit.row, hit.col, false);
    } else if (dragSelection?.type === 'row' && (hit.type === 'row' || hit.type === 'cell')) {
      const row = hit.row;
      setSelection(dragSelection.row, 0, row, store.cols - 1, false);
    } else if (dragSelection?.type === 'col' && (hit.type === 'col' || hit.type === 'cell')) {
      const col = hit.col;
      setSelection(0, dragSelection.col, store.rows - 1, col, false);
    }
  }

  function handleGridAction(action) {
    if (!action) return false;
    if (action.type === 'move') moveSelection(action.rowDelta, action.colDelta);
    else if (action.type === 'extend') extendSelection(action.rowDelta, action.colDelta);
    else if (action.type === 'clear') clearSelection();
    else if (action.type === 'edit') beginEdit(action.initialValue, { focus: 'cell', selectAll: false });
    else if (action.type === 'copy') copySelection(false);
    else if (action.type === 'cut') copySelection(true);
    else if (action.type === 'selectAll') selectAll();
    else if (action.type === 'moveEdge' || action.type === 'extendEdge') {
      const target = jumpTarget(action.rowDelta, action.colDelta);
      moveTo(target.row, target.col, action.type === 'extendEdge');
    } else if (action.type === 'moveRowStart' || action.type === 'extendRowStart') {
      moveTo(selected.row, 0, action.type === 'extendRowStart');
    } else if (action.type === 'moveRowEnd' || action.type === 'extendRowEnd') {
      moveTo(selected.row, usedBounds().right, action.type === 'extendRowEnd');
    } else if (action.type === 'moveStart' || action.type === 'extendStart') {
      moveTo(0, 0, action.type === 'extendStart');
    } else if (action.type === 'moveEnd' || action.type === 'extendEnd') {
      const used = usedBounds();
      moveTo(used.bottom, used.right, action.type === 'extendEnd');
    } else if (action.type === 'movePage' || action.type === 'extendPage') {
      const pageRows = Math.max(1, Math.floor((shell.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
      moveTo(selected.row + action.direction * pageRows, selected.col, action.type === 'extendPage');
    }
    return true;
  }

  shell.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });

  grid.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target === editor) return;
    const hit = hitTestPointer(event);
    if (!hit) return;
    event.preventDefault();
    if (editing && !finishEdit()) return;
    dragSelection = hit;
    applyPointerSelection(hit, false);
    grid.setPointerCapture?.(event.pointerId);
    focusGrid();
  });

  grid.addEventListener('pointermove', event => {
    if (!dragSelection) return;
    const hit = hitTestPointer(event);
    applyPointerSelection(hit, true);
  });

  function endPointerSelection(event) {
    if (!dragSelection) return;
    dragSelection = null;
    try { grid.releasePointerCapture?.(event.pointerId); } catch {}
    focusGrid();
  }
  grid.addEventListener('pointerup', endPointerSelection);
  grid.addEventListener('pointercancel', endPointerSelection);

  grid.addEventListener('dblclick', event => {
    if (event.target === editor) return;
    const hit = hitTestPointer(event);
    if (hit?.type !== 'cell') return;
    selectCell(hit.row, hit.col, false);
    beginEdit(undefined, { focus: 'cell', selectAll: true });
  });

  grid.addEventListener('keydown', event => {
    const action = Interaction.keyboardAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    handleGridAction(action);
  });

  grid.addEventListener('copy', event => {
    if (editing) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', rawSelectionText());
    setStatus('Seleção copiada');
  });

  grid.addEventListener('cut', event => {
    if (editing) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', rawSelectionText());
    clearSelection();
  });

  grid.addEventListener('paste', event => {
    if (editing) return;
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined || text === null || text === '') return;
    event.preventDefault();
    pasteMatrix(Interaction.parseClipboardText(text));
  });

  editor.addEventListener('pointerdown', event => event.stopPropagation());
  editor.addEventListener('input', () => {
    formula.value = editor.value;
    summary.textContent = `Editando ${cellAddress(editing.row, editing.col)}`;
  });
  editor.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const rowDelta = event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0;
      const colDelta = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0;
      if (finishEdit(editor.value)) moveSelection(rowDelta, colDelta);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  });
  editor.addEventListener('blur', () => {
    const target = editing && { row: editing.row, col: editing.col };
    if (!target) return;
    queueMicrotask(() => {
      if (!editing || editing.row !== target.row || editing.col !== target.col) return;
      if (document.activeElement === formula || document.activeElement === editor) return;
      finishEdit(editor.value);
    });
  });

  formula.addEventListener('focus', () => {
    if (!editing) beginEdit(undefined, { focus: 'formula' });
  });
  formula.addEventListener('input', () => {
    if (!editing) return;
    editor.value = formula.value;
    summary.textContent = `Editando ${cellAddress(editing.row, editing.col)}`;
  });
  formula.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const rowDelta = event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0;
      const colDelta = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0;
      if (finishEdit(formula.value)) moveSelection(rowDelta, colDelta);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  });
  formula.addEventListener('blur', () => {
    const target = editing && { row: editing.row, col: editing.col };
    if (!target) return;
    queueMicrotask(() => {
      if (!editing || editing.row !== target.row || editing.col !== target.col) return;
      if (document.activeElement === formula || document.activeElement === editor) return;
      finishEdit(formula.value);
    });
  });

  nameInput.addEventListener('input', () => {
    store.name = nameInput.value;
    persistSoon();
    emitName();
  });

  $('#clear-button').onclick = clearSelection;
  $('#functions-button').onclick = () => functionsDialog?.showModal();
  $('#open-button').onclick = () => listServer().catch(error => setStatus(error.message, true));
  $('#new-button').onclick = () => {
    if (!canMutate()) return;
    if (editing && !finishEdit()) return;
    const changes = [...store.entries()].map(item => ({ row: item.row, col: item.col, value: null }));
    if (changes.length) applyChanges(changes, { reason: 'new' });
    nameInput.value = 'Minha Planilha';
    store.name = nameInput.value;
    selectCell(0, 0);
    persistSoon();
    emitName();
    setStatus('Nova planilha criada');
  };
  $('#example-button').onclick = () => {
    if (!canMutate()) return;
    const sample = [
      { row: 0, col: 0, value: 'Produto' }, { row: 0, col: 1, value: 'Status' }, { row: 0, col: 2, value: 'Valor' },
      { row: 1, col: 0, value: 'Porta bronze' }, { row: 1, col: 1, value: 'Pago' }, { row: 1, col: 2, value: 3200 },
      { row: 2, col: 0, value: 'Porta preta' }, { row: 2, col: 1, value: 'Pendente' }, { row: 2, col: 2, value: 2100 },
      { row: 3, col: 1, value: 'Total pago' }, { row: 3, col: 2, value: '=SOMASE(B2:B3;"Pago";C2:C3)' },
    ];
    const clear = [...store.entries()].map(item => ({ row: item.row, col: item.col, value: null }));
    applyChanges([...clear, ...sample], { reason: 'example' });
    selectCell(0, 0);
    setStatus('Exemplo carregado');
  };
  $('#export-button').onclick = () => {
    if (editing) finishEdit();
    const blob = new Blob([JSON.stringify(store.toPayload(nameInput.value), null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    const url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = `${(nameInput.value.trim() || 'planilha').replace(/[^a-z0-9_-]+/gi, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('#import-input').onchange = async event => {
    if (!canMutate()) return;
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cells)) throw new Error('Arquivo de planilha inválido.');
      const previous = [...store.entries()];
      replaceSnapshot(payload);
      emitChanges(snapshotDiff(previous, store), 'replace');
      emitName();
      setStatus('Planilha importada');
    } catch (error) {
      setStatus(error.message || 'Não foi possível importar o arquivo.', true);
    } finally {
      event.target.value = '';
    }
  };
  $('#undo-button').onclick = undo;
  $('#redo-button').onclick = redo;
  $('#save-button')?.addEventListener('click', () => {
    if (editing) finishEdit();
    persistNow();
    if (!workbookId) setStatus('Planilha salva neste navegador');
  });

  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.onclick = () => document.querySelector(`#${button.dataset.closeDialog}`)?.close();
  });

  function flushEditingAndLocal() {
    if (editing) finishEdit(editor.value);
    persistNow();
  }
  window.addEventListener('beforeunload', flushEditingAndLocal);
  window.addEventListener('pagehide', flushEditingAndLocal);

  nameInput.value = store.name;
  rebuildEngine();
  renderFunctions();
  updateSelectionUi();
  setStatus('Pronto');
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
        return applyChanges(changes, { remote: true, recordHistory: false });
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
