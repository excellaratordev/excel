(() => {
  'use strict';

  const initialSize = window.SuperExcelGridSize || {};
  const ROWS = Math.max(1, Number(initialSize.rows) || 60);
  const COLS = Math.max(1, Number(initialSize.cols) || 26);
  const AUTOSAVE = 'super-excel-autosave-v1';
  const MAX_PATCH_CHANGES = 10000;

  const FORMULAS = [
    ['SOMA', 'Soma valores', '=SOMA(B2:B20)'],
    ['MÉDIA', 'Calcula a média', '=MÉDIA(B2:B20)'],
    ['MÁXIMO', 'Maior valor', '=MÁXIMO(B2:B20)'],
    ['MÍNIMO', 'Menor valor', '=MÍNIMO(B2:B20)'],
    ['SE', 'Executa uma condição', '=SE(B2>=1000;"Meta atingida";"Abaixo da meta")'],
    ['SES', 'Várias condições', '=SES(B2>=1000;"Alta";B2>=500;"Média";VERDADEIRO;"Baixa")'],
    ['E', 'Todas as condições', '=E(B2>0;C2="Pago")'],
    ['OU', 'Qualquer condição', '=OU(C2="Pago";C2="Parcial")'],
    ['SEERRO', 'Substitui erros', '=SEERRO(A2/B2;0)'],
    ['CONT.NÚM', 'Conta números', '=CONT.NÚM(B2:B100)'],
    ['CONT.VALORES', 'Conta células preenchidas', '=CONT.VALORES(A2:A100)'],
    ['CONT.SE', 'Conta por critério', '=CONT.SE(C2:C100;"Pago")'],
    ['CONT.SES', 'Conta por critérios', '=CONT.SES(C2:C100;"Pago";B2:B100;">1000")'],
    ['SOMASE', 'Soma por critério', '=SOMASE(C2:C100;"Pago";B2:B100)'],
    ['SOMASES', 'Soma por critérios', '=SOMASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")'],
    ['MÉDIASE', 'Média por critério', '=MÉDIASE(C2:C100;"William";B2:B100)'],
    ['MÉDIASES', 'Média por critérios', '=MÉDIASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")'],
    ['PROCV', 'Busca vertical', '=PROCV(A2;F2:H20;3;FALSO)'],
    ['PROCX', 'Busca moderna', '=PROCX(A2;F2:F20;H2:H20;"Não encontrado")'],
    ['ÍNDICE', 'Valor pela posição', '=ÍNDICE(D2:D100;5)'],
    ['CORRESP', 'Posição de um valor', '=CORRESP(A2;F2:F100;0)'],
    ['FILTRO', 'Filtra linhas', '=FILTRO(A2:D20;D2:D20="Pendente")'],
    ['ÚNICO', 'Valores únicos', '=ÚNICO(B2:B20)'],
    ['CLASSIFICAR', 'Ordena intervalo', '=CLASSIFICAR(A2:D20;4;-1)'],
    ['CONCAT', 'Junta textos', '=CONCAT(A2;" - ";B2)'],
    ['TEXTO.JUNTAR', 'Junta com separador', '=TEXTO.JUNTAR(", ";VERDADEIRO;A2:A10)'],
    ['ESQUERDA', 'Texto do início', '=ESQUERDA(A2;3)'],
    ['DIREITA', 'Texto do final', '=DIREITA(A2;4)'],
    ['TEXTO', 'Formata valor', '=TEXTO(B2;"R$ #.##0,00")'],
    ['HOJE', 'Data atual', '=HOJE()'],
  ];

  const $ = selector => document.querySelector(selector);
  const elements = {
    grid: $('#spreadsheet'),
    formula: $('#formula-input'),
    address: $('#cell-address'),
    status: $('#status-message'),
    summary: $('#selection-summary'),
    name: $('#workbook-name'),
    functionsDialog: $('#functions-dialog'),
    functionsList: $('#functions-list'),
    openDialog: $('#open-dialog'),
    openList: $('#workbooks-list'),
  };

  if (!elements.grid || !elements.formula || !window.SuperExcelFormulaEngine) return;

  const cellCache = Array.from({ length: ROWS }, () => Array(COLS));
  const formulaCells = new Set();
  const paintedCells = new Set();
  const paintedClasses = [
    'selected', 'selection-anchor', 'range-selected', 'range-top', 'range-bottom',
    'range-left', 'range-right', 'range-handle', 'reference-range', 'reference-top',
    'reference-bottom', 'reference-left', 'reference-right',
  ];
  const numberFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 });
  const dateFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' });

  let data = emptyMatrix();
  let engine = null;
  let workbookId = Number(document.documentElement.dataset.workbookId || 0) || null;
  let selected = { row: 0, col: 0 };
  let selectionRange = createRange(0, 0);
  let editing = null;
  let formulaRange = null;
  let dragState = null;
  let activeFormulaReference = null;
  let internalFormulaInput = false;
  let dragFrame = null;
  let pendingDragCoordinates = null;
  let persistenceTimer = null;
  let summaryFrame = null;
  let applyingRemote = 0;

  function emptyMatrix() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function clampRow(row) {
    return Math.max(0, Math.min(ROWS - 1, Number(row) || 0));
  }

  function clampCol(col) {
    return Math.max(0, Math.min(COLS - 1, Number(col) || 0));
  }

  function createRange(startRow, startCol, endRow = startRow, endCol = startCol) {
    return {
      startRow: clampRow(startRow),
      startCol: clampCol(startCol),
      endRow: clampRow(endRow),
      endCol: clampCol(endCol),
    };
  }

  function normalizeRange(range) {
    return {
      top: Math.min(range.startRow, range.endRow),
      bottom: Math.max(range.startRow, range.endRow),
      left: Math.min(range.startCol, range.endCol),
      right: Math.max(range.startCol, range.endCol),
    };
  }

  function isSingleRange(range) {
    const bounds = normalizeRange(range);
    return bounds.top === bounds.bottom && bounds.left === bounds.right;
  }

  function colName(index) {
    let result = '';
    for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
      result = String.fromCharCode(65 + ((number - 1) % 26)) + result;
    }
    return result;
  }

  function address(row, col) {
    return `${colName(col)}${row + 1}`;
  }

  function rangeAddress(range) {
    const bounds = normalizeRange(range);
    const first = address(bounds.top, bounds.left);
    const last = address(bounds.bottom, bounds.right);
    return first === last ? first : `${first}:${last}`;
  }

  function cell(row, col) {
    return cellCache[row]?.[col] || null;
  }

  function raw(row, col) {
    return data[row]?.[col] ?? null;
  }

  function setStatus(text, error = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle('error', error);
  }

  function parseInput(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (text.startsWith('=')) return text;
    if (/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/u.test(text)) {
      return Number(text.replaceAll('.', '').replace(',', '.'));
    }
    if (/^(VERDADEIRO|FALSO|TRUE|FALSE)$/iu.test(text)) {
      return /^(VERDADEIRO|TRUE)$/iu.test(text);
    }
    return value;
  }

  function displayValue(row, col) {
    const coordinate = { sheet: 0, row, col };
    const value = engine.getCellValue(coordinate);
    if (value == null) return '';
    if (typeof value === 'object' && value.value !== undefined) return String(value.value);
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'number') {
      const type = String(engine.getCellValueDetailedType(coordinate));
      if (type.includes('DATE')) {
        const date = new Date(Date.UTC(1899, 11, 30));
        date.setUTCDate(date.getUTCDate() + Math.floor(value));
        return dateFormatter.format(date);
      }
      return numberFormatter.format(value);
    }
    return String(value);
  }

  function updateFormulaIndex(row, col, value) {
    const key = `${row}:${col}`;
    if (typeof value === 'string' && value.trimStart().startsWith('=')) formulaCells.add(key);
    else formulaCells.delete(key);
  }

  function renderCell(row, col) {
    const target = cell(row, col);
    if (!target) return;
    const value = displayValue(row, col);
    const source = raw(row, col);
    target.textContent = value;
    target.classList.toggle('formula-cell', typeof source === 'string' && source.trimStart().startsWith('='));
    target.classList.toggle('error-cell', value.startsWith('#'));
    target.classList.remove('editing');
  }

  function renderAffected(changes = []) {
    const coordinates = new Set();
    for (const change of changes) coordinates.add(`${change.row}:${change.col}`);
    for (const key of formulaCells) coordinates.add(key);
    for (const key of coordinates) {
      const [row, col] = key.split(':').map(Number);
      renderCell(row, col);
    }
    updateSelectionUi();
    if (editing) previewEdit();
  }

  function renderAll() {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) renderCell(row, col);
    }
    updateSelectionUi();
    if (editing) previewEdit();
  }

  function buildGrid() {
    const chunks = ['<table class="sheet-table"><thead><tr><th class="corner"></th>'];
    for (let col = 0; col < COLS; col += 1) chunks.push(`<th>${colName(col)}</th>`);
    chunks.push('</tr></thead><tbody>');
    for (let row = 0; row < ROWS; row += 1) {
      chunks.push(`<tr><th class="row-header">${row + 1}</th>`);
      for (let col = 0; col < COLS; col += 1) {
        chunks.push(`<td class="cell" tabindex="-1" data-row="${row}" data-col="${col}"></td>`);
      }
      chunks.push('</tr>');
    }
    chunks.push('</tbody></table>');
    elements.grid.innerHTML = chunks.join('');
    elements.grid.querySelectorAll('.cell').forEach(target => {
      cellCache[Number(target.dataset.row)][Number(target.dataset.col)] = target;
    });
  }

  function markPainted(target, ...classes) {
    if (!target) return;
    target.classList.add(...classes);
    paintedCells.add(target);
  }

  function clearRangeClasses() {
    for (const target of paintedCells) target.classList.remove(...paintedClasses);
    paintedCells.clear();
  }

  function paintRange(range, prefix, includeHandle = false) {
    const bounds = normalizeRange(range);
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        const classes = [prefix === 'range' ? 'range-selected' : 'reference-range'];
        if (row === bounds.top) classes.push(`${prefix}-top`);
        if (row === bounds.bottom) classes.push(`${prefix}-bottom`);
        if (col === bounds.left) classes.push(`${prefix}-left`);
        if (col === bounds.right) classes.push(`${prefix}-right`);
        markPainted(cell(row, col), ...classes);
      }
    }
    if (includeHandle) markPainted(cell(bounds.bottom, bounds.right), 'range-handle');
  }

  function selectionSummary() {
    const bounds = normalizeRange(selectionRange);
    const count = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
    if (count === 1) {
      const value = displayValue(selected.row, selected.col);
      return value ? `Valor: ${value}` : '';
    }
    let filled = 0;
    let numericCount = 0;
    let sum = 0;
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        const value = engine.getCellValue({ sheet: 0, row, col });
        if (value !== null && value !== '') filled += 1;
        if (typeof value === 'number' && Number.isFinite(value)) {
          numericCount += 1;
          sum += value;
        }
      }
    }
    const parts = [`${count} células selecionadas`];
    if (filled) parts.push(`${filled} preenchidas`);
    if (numericCount) parts.push(`Soma: ${numberFormatter.format(sum)}`);
    return parts.join(' · ');
  }

  function scheduleSummary() {
    cancelAnimationFrame(summaryFrame);
    summaryFrame = requestAnimationFrame(() => {
      if (!editing) elements.summary.textContent = selectionSummary();
    });
  }

  function updateSelectionUi() {
    clearRangeClasses();
    if (isSingleRange(selectionRange)) markPainted(cell(selected.row, selected.col), 'selected');
    else {
      paintRange(selectionRange, 'range', true);
      markPainted(cell(selected.row, selected.col), 'selection-anchor');
    }
    if (formulaRange) paintRange(formulaRange, 'reference');
    elements.address.textContent = isSingleRange(selectionRange)
      ? address(selected.row, selected.col)
      : rangeAddress(selectionRange);
    if (!editing) {
      internalFormulaInput = true;
      elements.formula.value = raw(selected.row, selected.col) ?? '';
      internalFormulaInput = false;
      scheduleSummary();
    }
  }

  function compactCells() {
    let lastRow = -1;
    let lastCol = -1;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const value = data[row][col];
        if (value !== null && value !== undefined && value !== '') {
          lastRow = Math.max(lastRow, row);
          lastCol = Math.max(lastCol, col);
        }
      }
    }
    if (lastRow < 0 || lastCol < 0) return [];
    return data.slice(0, lastRow + 1).map(row => row.slice(0, lastCol + 1));
  }

  function serialize() {
    return {
      version: 1,
      name: elements.name.value.trim() || 'Minha Planilha',
      rows: ROWS,
      cols: COLS,
      cells: compactCells(),
    };
  }

  function persistNow() {
    clearTimeout(persistenceTimer);
    try {
      localStorage.setItem(AUTOSAVE, JSON.stringify(serialize()));
    } catch (error) {
      console.warn('Não foi possível manter o rascunho local.', error);
    }
  }

  function persistSoon(delay = 900) {
    clearTimeout(persistenceTimer);
    persistenceTimer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(persistNow, { timeout: 800 });
      else persistNow();
    }, delay);
  }

  function emitChanges(changes, reason = 'edit') {
    if (applyingRemote || !changes.length) return;
    window.dispatchEvent(new CustomEvent('superexcel:changes', {
      detail: { changes, reason, name: elements.name.value.trim() || 'Minha Planilha' },
    }));
  }

  function emitName() {
    if (applyingRemote) return;
    window.dispatchEvent(new CustomEvent('superexcel:name', {
      detail: { name: elements.name.value.trim() || 'Minha Planilha' },
    }));
  }

  function rebuildEngine() {
    if (engine) engine.destroy();
    formulaCells.clear();
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) updateFormulaIndex(row, col, data[row][col]);
    }
    engine = window.SuperExcelFormulaEngine.create(data);
    renderAll();
  }

  function loadSnapshot(payload, options = {}) {
    if (!payload || !Array.isArray(payload.cells)) throw new Error('Arquivo de planilha inválido.');
    const previous = options.emit ? data.map(row => [...row]) : null;
    data = emptyMatrix();
    payload.cells.slice(0, ROWS).forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.slice(0, COLS).forEach((value, colIndex) => { data[rowIndex][colIndex] = value; });
    });
    editing = null;
    formulaRange = null;
    dragState = null;
    activeFormulaReference = null;
    elements.name.value = payload.name || 'Minha Planilha';
    rebuildEngine();
    selectCell(0, 0, false);
    persistSoon(0);
    if (previous) {
      const changes = diffMatrices(previous, data);
      emitChanges(changes, 'replace');
      emitName();
    }
  }

  function diffMatrices(before, after) {
    const changes = [];
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (JSON.stringify(before[row]?.[col] ?? null) !== JSON.stringify(after[row]?.[col] ?? null)) {
          changes.push({ row, col, value: after[row]?.[col] ?? null });
          if (changes.length >= MAX_PATCH_CHANGES) return changes;
        }
      }
    }
    return changes;
  }

  function selectCell(row, col, focus = true) {
    selected = { row: clampRow(row), col: clampCol(col) };
    selectionRange = createRange(selected.row, selected.col);
    formulaRange = null;
    activeFormulaReference = null;
    updateSelectionUi();
    if (focus) cell(selected.row, selected.col)?.focus({ preventScroll: true });
  }

  function moveSelection(deltaRow, deltaCol) {
    selectCell(selected.row + deltaRow, selected.col + deltaCol);
    cell(selected.row, selected.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function startEdit(initialValue) {
    if (!editing) editing = { row: selected.row, col: selected.col };
    selectionRange = createRange(editing.row, editing.col);
    formulaRange = null;
    activeFormulaReference = null;
    if (initialValue !== undefined) {
      internalFormulaInput = true;
      elements.formula.value = initialValue;
      internalFormulaInput = false;
    }
    updateSelectionUi();
    previewEdit();
    elements.formula.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const end = elements.formula.value.length;
      elements.formula.setSelectionRange(end, end);
    });
  }

  function previewEdit() {
    if (!editing) return;
    const target = cell(editing.row, editing.col);
    if (!target) return;
    const value = elements.formula.value;
    target.textContent = value;
    target.classList.add('editing');
    target.classList.toggle('formula-cell', value.trimStart().startsWith('='));
    target.classList.remove('error-cell');
    elements.summary.textContent = value ? `Editando: ${value}` : '';
  }

  function cancelEdit() {
    const target = editing ? { ...editing } : { ...selected };
    editing = null;
    formulaRange = null;
    dragState = null;
    activeFormulaReference = null;
    selected = target;
    selectionRange = createRange(target.row, target.col);
    renderCell(target.row, target.col);
    updateSelectionUi();
    cell(target.row, target.col)?.focus({ preventScroll: true });
  }

  function commit(value) {
    const target = editing ? { ...editing } : { ...selected };
    const parsed = parseInput(value);
    const previous = raw(target.row, target.col);
    try {
      engine.setCellContents(
        { sheet: 0, row: target.row, col: target.col },
        [[window.SuperExcelFormulaEngine.normalizeFormula(parsed)]],
      );
      data[target.row][target.col] = parsed;
      updateFormulaIndex(target.row, target.col, parsed);
      editing = null;
      formulaRange = null;
      dragState = null;
      activeFormulaReference = null;
      selected = target;
      selectionRange = createRange(target.row, target.col);
      renderAffected([{ row: target.row, col: target.col }]);
      persistSoon();
      if (JSON.stringify(previous) !== JSON.stringify(parsed)) {
        emitChanges([{ row: target.row, col: target.col, value: parsed }]);
      }
      setStatus('Alteração calculada');
      return true;
    } catch (error) {
      setStatus(error.message || 'Erro ao calcular.', true);
      previewEdit();
      return false;
    }
  }

  function applyCellChanges(changes, options = {}) {
    const deduplicated = new Map();
    for (const item of changes || []) {
      const row = Number(item.row);
      const col = Number(item.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= ROWS || col >= COLS) {
        if (options.remote) return { requiresReload: true, applied: 0 };
        continue;
      }
      deduplicated.set(`${row}:${col}`, { row, col, value: item.value ?? null });
    }
    const normalized = [...deduplicated.values()];
    if (!normalized.length) return { requiresReload: false, applied: 0 };

    const canSuspend = typeof engine.suspendEvaluation === 'function' && typeof engine.resumeEvaluation === 'function';
    if (canSuspend) engine.suspendEvaluation();
    try {
      for (const change of normalized) {
        data[change.row][change.col] = change.value;
        updateFormulaIndex(change.row, change.col, change.value);
        engine.setCellContents(
          { sheet: 0, row: change.row, col: change.col },
          [[window.SuperExcelFormulaEngine.normalizeFormula(change.value)]],
        );
      }
    } finally {
      if (canSuspend) engine.resumeEvaluation();
    }
    renderAffected(normalized);
    persistSoon();
    if (!options.remote) emitChanges(normalized, options.reason || 'batch');
    return { requiresReload: false, applied: normalized.length };
  }

  function clearSelectedRange() {
    const bounds = normalizeRange(selectionRange);
    const matrix = Array.from(
      { length: bounds.bottom - bounds.top + 1 },
      () => Array(bounds.right - bounds.left + 1).fill(null),
    );
    const changes = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        if (raw(row, col) !== null) changes.push({ row, col, value: null });
      }
    }
    if (!changes.length) return;
    try {
      engine.setCellContents(
        { sheet: 0, row: bounds.top, col: bounds.left },
        window.SuperExcelFormulaEngine.normalizeDataForEngine(matrix),
      );
      for (const change of changes) {
        data[change.row][change.col] = null;
        updateFormulaIndex(change.row, change.col, null);
      }
      renderAffected(changes);
      persistSoon();
      emitChanges(changes, 'clear');
      setStatus('Conteúdo apagado');
    } catch (error) {
      setStatus(error.message || 'Erro ao apagar.', true);
    }
  }

  function beginFormulaRange(row, col) {
    const formula = elements.formula.value;
    let replaceStart = elements.formula.selectionStart ?? formula.length;
    let replaceEnd = elements.formula.selectionEnd ?? replaceStart;
    if (activeFormulaReference
      && formula === activeFormulaReference.formula
      && replaceStart === activeFormulaReference.end
      && replaceEnd === activeFormulaReference.end) {
      replaceStart = activeFormulaReference.start;
      replaceEnd = activeFormulaReference.end;
    }
    dragState = {
      mode: 'formula', startRow: row, startCol: col, endRow: row, endCol: col,
      baseValue: formula, replaceStart, replaceEnd,
    };
    updateFormulaRange(row, col);
  }

  function updateFormulaRange(row, col) {
    if (!dragState || dragState.mode !== 'formula') return;
    dragState.endRow = clampRow(row);
    dragState.endCol = clampCol(col);
    formulaRange = createRange(dragState.startRow, dragState.startCol, dragState.endRow, dragState.endCol);
    const reference = rangeAddress(formulaRange);
    internalFormulaInput = true;
    elements.formula.value = `${dragState.baseValue.slice(0, dragState.replaceStart)}${reference}${dragState.baseValue.slice(dragState.replaceEnd)}`;
    internalFormulaInput = false;
    updateSelectionUi();
    previewEdit();
  }

  function finishFormulaRange() {
    if (!dragState || dragState.mode !== 'formula') return;
    const reference = rangeAddress(formulaRange);
    const start = dragState.replaceStart;
    const end = start + reference.length;
    dragState = null;
    activeFormulaReference = { start, end, formula: elements.formula.value };
    elements.formula.focus({ preventScroll: true });
    requestAnimationFrame(() => elements.formula.setSelectionRange(end, end));
  }

  function beginSelectionRange(row, col) {
    selected = { row: clampRow(row), col: clampCol(col) };
    selectionRange = createRange(selected.row, selected.col);
    formulaRange = null;
    activeFormulaReference = null;
    dragState = {
      mode: 'selection', startRow: selected.row, startCol: selected.col,
      endRow: selected.row, endCol: selected.col,
    };
    updateSelectionUi();
  }

  function updateSelectionRange(row, col) {
    if (!dragState || dragState.mode !== 'selection') return;
    dragState.endRow = clampRow(row);
    dragState.endCol = clampCol(col);
    selectionRange = createRange(dragState.startRow, dragState.startCol, dragState.endRow, dragState.endCol);
    updateSelectionUi();
  }

  function finishSelectionRange() {
    if (!dragState || dragState.mode !== 'selection') return;
    dragState = null;
    updateSelectionUi();
    cell(selected.row, selected.col)?.focus({ preventScroll: true });
  }

  function queueDrag(row, col) {
    pendingDragCoordinates = { row, col };
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = null;
      const coordinates = pendingDragCoordinates;
      pendingDragCoordinates = null;
      if (!coordinates || !dragState) return;
      if (dragState.mode === 'formula') updateFormulaRange(coordinates.row, coordinates.col);
      else updateSelectionRange(coordinates.row, coordinates.col);
    });
  }

  function isFilled(row, col) {
    const value = raw(row, col);
    return value !== null && value !== undefined && value !== '';
  }

  function nextDataBoundary(start, rowStep, colStep) {
    const inBounds = (row, col) => row >= 0 && row < ROWS && col >= 0 && col < COLS;
    const next = { row: start.row + rowStep, col: start.col + colStep };
    if (!inBounds(next.row, next.col)) return start;
    const currentFilled = isFilled(start.row, start.col);
    const nextFilled = isFilled(next.row, next.col);
    if (nextFilled) {
      if (!currentFilled) return next;
      let target = next;
      while (inBounds(target.row + rowStep, target.col + colStep)
        && isFilled(target.row + rowStep, target.col + colStep)) {
        target = { row: target.row + rowStep, col: target.col + colStep };
      }
      return target;
    }
    let target = next;
    while (inBounds(target.row, target.col)) {
      if (isFilled(target.row, target.col)) return target;
      const following = { row: target.row + rowStep, col: target.col + colStep };
      if (!inBounds(following.row, following.col)) return target;
      target = following;
    }
    return start;
  }

  function extendSelection(rowStep, colStep, jump) {
    const endpoint = { row: selectionRange.endRow, col: selectionRange.endCol };
    const next = jump
      ? nextDataBoundary(endpoint, rowStep, colStep)
      : { row: clampRow(endpoint.row + rowStep), col: clampCol(endpoint.col + colStep) };
    selectionRange = createRange(selectionRange.startRow, selectionRange.startCol, next.row, next.col);
    updateSelectionUi();
    cell(next.row, next.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function syncFromEngine(reason) {
    const previous = data;
    const serialized = engine.getSheetSerialized(0);
    data = emptyMatrix();
    serialized.slice(0, ROWS).forEach((row, rowIndex) => {
      row.slice(0, COLS).forEach((value, colIndex) => { data[rowIndex][colIndex] = value; });
    });
    formulaCells.clear();
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) updateFormulaIndex(row, col, data[row][col]);
    }
    const changes = diffMatrices(previous, data);
    renderAffected(changes);
    persistSoon();
    emitChanges(changes, reason);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${(elements.name.value || 'planilha')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    setStatus('Planilha exportada');
  }

  async function importJson(file) {
    const payload = JSON.parse(await file.text());
    loadSnapshot(payload, { emit: true });
    setStatus(`Arquivo importado: ${file.name}`);
  }

  function newBook() {
    const previous = data;
    data = emptyMatrix();
    elements.name.value = 'Minha Planilha';
    editing = null;
    formulaRange = null;
    dragState = null;
    rebuildEngine();
    selectCell(0, 0);
    const changes = diffMatrices(previous, data);
    emitChanges(changes, 'new');
    emitName();
    persistSoon(0);
    setStatus('Nova planilha criada');
  }

  function loadExample() {
    const matrix = [
      ['Produto', 'Vendedor', 'Cidade', 'Status', 'Valor'],
      ['Porta bronze', 'William', 'Fortaleza', 'Pago', 3200],
      ['Porta preta', 'Kadu', 'Fortaleza', 'Pendente', 2100],
      ['Espelho', 'William', 'Recife', 'Pago', 950],
      ['Perfil slim', 'Kadu', 'Fortaleza', 'Parcial', 1450],
      ['Puxador Roma', 'William', 'Fortaleza', 'Pago', 700],
      [null, null, null, 'Total pago', '=SOMASE(D2:D6;"Pago";E2:E6)'],
      [null, null, null, 'Média Fortaleza', '=MÉDIASES(E2:E6;C2:C6;"Fortaleza")'],
      [null, null, null, 'Maior venda', '=MÁXIMO(E2:E6)'],
      [null, null, null, 'Hoje', '=HOJE()'],
    ];
    const changes = [];
    matrix.forEach((row, rowIndex) => row.forEach((value, colIndex) => {
      if (rowIndex < ROWS && colIndex < COLS) changes.push({ row: rowIndex, col: colIndex, value });
    }));
    applyCellChanges(changes, { reason: 'example' });
    setStatus('Exemplo empresarial carregado');
  }

  function renderFunctions() {
    elements.functionsList.innerHTML = '';
    FORMULAS.forEach(([name, description, formula], index) => {
      const card = document.createElement('article');
      card.className = 'formula-card';
      card.innerHTML = `<span class="formula-number">${String(index + 1).padStart(2, '0')}</span><div><strong></strong><p></p><code></code></div><button>Usar</button>`;
      card.querySelector('strong').textContent = name;
      card.querySelector('p').textContent = description;
      card.querySelector('code').textContent = formula;
      card.querySelector('button').onclick = () => {
        elements.functionsDialog.close();
        startEdit(formula);
      };
      elements.functionsList.append(card);
    });
  }

  async function listServer() {
    elements.openList.innerHTML = '<p class="muted">Carregando...</p>';
    elements.openDialog.showModal();
    const response = await fetch('/api/workbooks');
    const list = await response.json();
    if (!response.ok) throw new Error(list.error || 'Erro ao listar planilhas.');
    if (!list.length) {
      elements.openList.innerHTML = '<p class="muted">Nenhuma planilha salva.</p>';
      return;
    }
    elements.openList.innerHTML = '';
    list.forEach(workbook => {
      const item = document.createElement('div');
      item.className = 'workbook-item';
      item.innerHTML = '<div><strong></strong><small></small></div><div><button class="primary">Abrir</button></div>';
      item.querySelector('strong').textContent = workbook.name;
      item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
      item.querySelector('button').onclick = () => { window.location.href = `/sheet/${workbook.id}`; };
      elements.openList.append(item);
    });
  }

  function cellFromEvent(event) {
    return event.target.closest?.('.cell') || null;
  }

  function bindEvents() {
    elements.grid.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      const target = cellFromEvent(event);
      if (!target) return;
      const row = Number(target.dataset.row);
      const col = Number(target.dataset.col);
      event.preventDefault();
      if (editing) {
        if (elements.formula.value.trimStart().startsWith('=')) {
          beginFormulaRange(row, col);
          return;
        }
        if (!commit(elements.formula.value)) return;
      }
      beginSelectionRange(row, col);
    });

    elements.grid.addEventListener('mousemove', event => {
      if (!dragState) return;
      const target = cellFromEvent(event);
      if (!target) return;
      queueDrag(Number(target.dataset.row), Number(target.dataset.col));
    });

    window.addEventListener('mouseup', () => {
      if (!dragState) return;
      if (dragState.mode === 'formula') finishFormulaRange();
      else finishSelectionRange();
    });

    elements.grid.addEventListener('dblclick', event => {
      if (cellFromEvent(event)) startEdit();
    });

    elements.grid.addEventListener('keydown', event => {
      const directions = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      };
      if (directions[event.key] && event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        extendSelection(...directions[event.key], event.ctrlKey || event.metaKey);
        return;
      }
      const movement = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
        Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1],
      };
      if (movement[event.key]) {
        event.preventDefault();
        moveSelection(...movement[event.key]);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        clearSelectedRange();
      } else if (event.key === 'F2') {
        event.preventDefault();
        startEdit();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        startEdit(event.key);
      }
    });

    elements.grid.addEventListener('paste', event => {
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
        if (targetRow < ROWS && targetCol < COLS) changes.push({ row: targetRow, col: targetCol, value });
      }));
      applyCellChanges(changes, { reason: 'paste' });
      setStatus(`${matrix.length} linha(s) colada(s)`);
    });

    elements.formula.addEventListener('focus', () => {
      if (!editing) {
        editing = { row: selected.row, col: selected.col };
        selectionRange = createRange(selected.row, selected.col);
        updateSelectionUi();
        previewEdit();
      }
    });

    elements.formula.addEventListener('input', () => {
      if (!internalFormulaInput) activeFormulaReference = null;
      formulaRange = null;
      updateSelectionUi();
      previewEdit();
    });

    elements.formula.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (commit(elements.formula.value)) moveSelection(1, 0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        activeFormulaReference = null;
      }
    });

    $('#new-button').onclick = newBook;
    $('#open-button').onclick = () => listServer().catch(error => setStatus(error.message, true));
    $('#functions-button').onclick = () => elements.functionsDialog.showModal();
    $('#clear-button').onclick = clearSelectedRange;
    $('#example-button').onclick = loadExample;
    $('#export-button').onclick = exportJson;
    $('#import-input').onchange = event => {
      const file = event.target.files[0];
      if (file) importJson(file).catch(error => setStatus(error.message, true));
      event.target.value = '';
    };
    $('#undo-button').onclick = () => {
      if (engine.isThereSomethingToUndo()) {
        engine.undo();
        syncFromEngine('undo');
      }
    };
    $('#redo-button').onclick = () => {
      if (engine.isThereSomethingToRedo()) {
        engine.redo();
        syncFromEngine('redo');
      }
    };

    document.querySelectorAll('[data-close-dialog]').forEach(button => {
      button.onclick = () => document.querySelector(`#${button.dataset.closeDialog}`).close();
    });

    elements.name.addEventListener('input', () => {
      persistSoon();
      emitName();
    });
    window.addEventListener('beforeunload', persistNow);
  }

  function initialize() {
    buildGrid();
    renderFunctions();
    bindEvents();
    const initial = window.SuperExcelInitialWorkbook;
    if (initial && Array.isArray(initial.cells)) {
      loadSnapshot(initial);
      setStatus('Planilha carregada');
    } else {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(AUTOSAVE) || 'null'); } catch { saved = null; }
      if (saved?.cells) loadSnapshot(saved);
      else {
        rebuildEngine();
        selectCell(0, 0);
      }
    }

    window.SuperExcelApp = Object.freeze({
      rows: ROWS,
      cols: COLS,
      getSnapshot: serialize,
      isEditing: () => Boolean(editing),
      applyRemoteChanges(changes, metadata = {}) {
        applyingRemote += 1;
        try {
          if (metadata.name && metadata.name !== elements.name.value) elements.name.value = metadata.name;
          return applyCellChanges(changes, { remote: true });
        } finally {
          applyingRemote -= 1;
        }
      },
      replaceSnapshot(payload) {
        applyingRemote += 1;
        try { loadSnapshot(payload); } finally { applyingRemote -= 1; }
      },
      flushLocal: persistNow,
      setWorkbookId(value) { workbookId = Number(value) || workbookId; },
    });

    window.dispatchEvent(new CustomEvent('superexcel:ready'));
  }

  initialize();
})();