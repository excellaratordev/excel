(() => {
  'use strict';

  const ROWS = 60;
  const COLS = 26;
  const AUTOSAVE = 'super-excel-autosave-v1';

  const F = [
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

  const $ = (selector) => document.querySelector(selector);
  const el = {
    grid: $('#spreadsheet'),
    formula: $('#formula-input'),
    address: $('#cell-address'),
    status: $('#status-message'),
    summary: $('#selection-summary'),
    name: $('#workbook-name'),
    fDlg: $('#functions-dialog'),
    fList: $('#functions-list'),
    oDlg: $('#open-dialog'),
    oList: $('#workbooks-list'),
  };

  let data = empty();
  let engine;
  let selected = { row: 0, col: 0 };
  let selectionRange = createRange(0, 0, 0, 0);
  let workbookId = null;
  let timer;
  let editing = null;
  let formulaRange = null;
  let dragState = null;

  function empty() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function clampRow(row) {
    return Math.max(0, Math.min(ROWS - 1, row));
  }

  function clampCol(col) {
    return Math.max(0, Math.min(COLS - 1, col));
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

  function addr(row, col) {
    return `${colName(col)}${row + 1}`;
  }

  function rangeAddress(range) {
    const bounds = normalizeRange(range);
    const first = addr(bounds.top, bounds.left);
    const last = addr(bounds.bottom, bounds.right);
    return first === last ? first : `${first}:${last}`;
  }

  function cell(row, col) {
    return el.grid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  function status(text, error = false) {
    el.status.textContent = text;
    el.status.classList.toggle('error', error);
  }

  function parse(value) {
    const text = String(value).trim();
    if (!text) return null;
    if (text.startsWith('=')) return text;
    if (/^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/u.test(text)) {
      return Number(text.replaceAll('.', '').replace(',', '.'));
    }
    if (/^(VERDADEIRO|FALSO)$/iu.test(text)) return text.toUpperCase() === 'VERDADEIRO';
    return value;
  }

  function raw(row, col) {
    return data[row]?.[col] ?? null;
  }

  function display(row, col) {
    const address = { sheet: 0, row, col };
    const value = engine.getCellValue(address);
    if (value == null) return '';
    if (typeof value === 'object' && value.value) return value.value;
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'number') {
      const type = String(engine.getCellValueDetailedType(address));
      if (type.includes('DATE')) {
        const date = new Date(Date.UTC(1899, 11, 30));
        date.setUTCDate(date.getUTCDate() + Math.floor(value));
        return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date);
      }
      return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 }).format(value);
    }
    return String(value);
  }

  function build() {
    let html = '<table class="sheet-table"><thead><tr><th class="corner"></th>';
    for (let col = 0; col < COLS; col += 1) html += `<th>${colName(col)}</th>`;
    html += '</tr></thead><tbody>';
    for (let row = 0; row < ROWS; row += 1) {
      html += `<tr><th class="row-header">${row + 1}</th>`;
      for (let col = 0; col < COLS; col += 1) {
        html += `<td class="cell" tabindex="-1" data-row="${row}" data-col="${col}"></td>`;
      }
      html += '</tr>';
    }
    el.grid.innerHTML = `${html}</tbody></table>`;
  }

  function clearRangeClasses() {
    el.grid.querySelectorAll(
      '.selected,.selection-anchor,.range-selected,.range-top,.range-bottom,.range-left,.range-right,.range-handle,.reference-range,.reference-top,.reference-bottom,.reference-left,.reference-right'
    ).forEach((element) => {
      element.classList.remove(
        'selected',
        'selection-anchor',
        'range-selected',
        'range-top',
        'range-bottom',
        'range-left',
        'range-right',
        'range-handle',
        'reference-range',
        'reference-top',
        'reference-bottom',
        'reference-left',
        'reference-right'
      );
    });
  }

  function paintRange(range, prefix, includeHandle = false) {
    const bounds = normalizeRange(range);
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        const target = cell(row, col);
        if (!target) continue;
        target.classList.add(prefix === 'range' ? 'range-selected' : 'reference-range');
        if (row === bounds.top) target.classList.add(`${prefix}-top`);
        if (row === bounds.bottom) target.classList.add(`${prefix}-bottom`);
        if (col === bounds.left) target.classList.add(`${prefix}-left`);
        if (col === bounds.right) target.classList.add(`${prefix}-right`);
      }
    }
    if (includeHandle) cell(bounds.bottom, bounds.right)?.classList.add('range-handle');
  }

  function selectionSummary() {
    const bounds = normalizeRange(selectionRange);
    const count = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
    if (count === 1) {
      const value = display(selected.row, selected.col);
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
    if (numericCount) parts.push(`Soma: ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 }).format(sum)}`);
    return parts.join(' · ');
  }

  function render() {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const element = cell(row, col);
        const value = display(row, col);
        const rawValue = raw(row, col);
        element.textContent = value;
        element.classList.toggle('formula-cell', typeof rawValue === 'string' && rawValue.startsWith('='));
        element.classList.toggle('error-cell', String(value).startsWith('#'));
        element.classList.remove('editing');
      }
    }
    selectionUi();
    if (editing) previewEdit();
  }

  function rebuild() {
    if (engine) engine.destroy();
    engine = window.SuperExcelFormulaEngine.create(data);
    render();
  }

  function select(row, col, focus = true) {
    selected = { row: clampRow(row), col: clampCol(col) };
    selectionRange = createRange(selected.row, selected.col);
    formulaRange = null;
    selectionUi();
    if (focus) cell(selected.row, selected.col)?.focus({ preventScroll: true });
  }

  function selectionUi() {
    clearRangeClasses();

    if (isSingleRange(selectionRange)) {
      cell(selected.row, selected.col)?.classList.add('selected');
    } else {
      paintRange(selectionRange, 'range', true);
      cell(selected.row, selected.col)?.classList.add('selection-anchor');
    }

    if (formulaRange) paintRange(formulaRange, 'reference');

    el.address.textContent = isSingleRange(selectionRange) ? addr(selected.row, selected.col) : rangeAddress(selectionRange);
    if (!editing) {
      el.formula.value = raw(selected.row, selected.col) ?? '';
      el.summary.textContent = selectionSummary();
    }
  }

  function startEdit(initialValue) {
    if (!editing) editing = { row: selected.row, col: selected.col };
    selectionRange = createRange(editing.row, editing.col);
    formulaRange = null;
    if (initialValue !== undefined) el.formula.value = initialValue;
    selectionUi();
    previewEdit();
    el.formula.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const end = el.formula.value.length;
      el.formula.setSelectionRange(end, end);
    });
  }

  function previewEdit() {
    if (!editing) return;
    const target = cell(editing.row, editing.col);
    if (!target) return;
    const value = el.formula.value;
    target.textContent = value;
    target.classList.add('editing');
    target.classList.toggle('formula-cell', value.trimStart().startsWith('='));
    target.classList.remove('error-cell');
    el.summary.textContent = value ? `Editando: ${value}` : '';
  }

  function cancelEdit() {
    const target = editing ? { ...editing } : { ...selected };
    editing = null;
    formulaRange = null;
    dragState = null;
    selectionRange = createRange(target.row, target.col);
    selected = target;
    render();
    cell(target.row, target.col)?.focus({ preventScroll: true });
  }

  function beginFormulaRange(row, col) {
    const value = el.formula.value;
    dragState = {
      mode: 'formula',
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col,
      baseValue: value,
      replaceStart: el.formula.selectionStart ?? value.length,
      replaceEnd: el.formula.selectionEnd ?? (el.formula.selectionStart ?? value.length),
    };
    updateFormulaRange(row, col);
  }

  function updateFormulaRange(row, col) {
    if (!dragState || dragState.mode !== 'formula') return;
    dragState.endRow = clampRow(row);
    dragState.endCol = clampCol(col);
    formulaRange = createRange(
      dragState.startRow,
      dragState.startCol,
      dragState.endRow,
      dragState.endCol
    );
    const reference = rangeAddress(formulaRange);
    el.formula.value =
      dragState.baseValue.slice(0, dragState.replaceStart) +
      reference +
      dragState.baseValue.slice(dragState.replaceEnd);
    selectionUi();
    previewEdit();
  }

  function finishFormulaRange() {
    if (!dragState || dragState.mode !== 'formula') return;
    const caret = dragState.replaceStart + rangeAddress(formulaRange).length;
    dragState = null;
    el.formula.focus({ preventScroll: true });
    requestAnimationFrame(() => el.formula.setSelectionRange(caret, caret));
  }

  function beginSelectionRange(row, col) {
    selected = { row: clampRow(row), col: clampCol(col) };
    selectionRange = createRange(selected.row, selected.col);
    formulaRange = null;
    dragState = {
      mode: 'selection',
      startRow: selected.row,
      startCol: selected.col,
      endRow: selected.row,
      endCol: selected.col,
    };
    selectionUi();
  }

  function updateSelectionRange(row, col) {
    if (!dragState || dragState.mode !== 'selection') return;
    dragState.endRow = clampRow(row);
    dragState.endCol = clampCol(col);
    selectionRange = createRange(
      dragState.startRow,
      dragState.startCol,
      dragState.endRow,
      dragState.endCol
    );
    selectionUi();
  }

  function finishSelectionRange() {
    if (!dragState || dragState.mode !== 'selection') return;
    dragState = null;
    selectionUi();
    cell(selected.row, selected.col)?.focus({ preventScroll: true });
  }

  function commit(value) {
    const target = editing ? { ...editing } : { ...selected };
    const parsed = parse(value);
    try {
      engine.setCellContents(
        { sheet: 0, row: target.row, col: target.col },
        [[window.SuperExcelFormulaEngine.normalizeFormula(parsed)]]
      );
      data[target.row][target.col] = parsed;
      editing = null;
      formulaRange = null;
      dragState = null;
      selected = target;
      selectionRange = createRange(target.row, target.col);
      render();
      autosave();
      status('Alteração calculada');
      return true;
    } catch (error) {
      status(error.message || 'Erro ao calcular.', true);
      previewEdit();
      return false;
    }
  }

  function clearSelectedRange() {
    const bounds = normalizeRange(selectionRange);
    const matrix = Array.from(
      { length: bounds.bottom - bounds.top + 1 },
      () => Array(bounds.right - bounds.left + 1).fill(null)
    );
    try {
      engine.setCellContents(
        { sheet: 0, row: bounds.top, col: bounds.left },
        window.SuperExcelFormulaEngine.normalizeDataForEngine(matrix)
      );
      for (let row = bounds.top; row <= bounds.bottom; row += 1) {
        for (let col = bounds.left; col <= bounds.right; col += 1) data[row][col] = null;
      }
      render();
      autosave();
      status('Conteúdo apagado');
    } catch (error) {
      status(error.message || 'Erro ao apagar.', true);
    }
  }

  function move(deltaRow, deltaCol) {
    select(selected.row + deltaRow, selected.col + deltaCol);
    cell(selected.row, selected.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function serialize() {
    return {
      version: 1,
      name: el.name.value.trim() || 'Minha Planilha',
      rows: ROWS,
      cols: COLS,
      cells: data,
    };
  }

  function load(payload, id = null) {
    if (!payload || !Array.isArray(payload.cells)) throw new Error('Arquivo de planilha inválido.');
    editing = null;
    formulaRange = null;
    dragState = null;
    data = empty();
    payload.cells.slice(0, ROWS).forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.slice(0, COLS).forEach((value, colIndex) => {
        data[rowIndex][colIndex] = value;
      });
    });
    workbookId = id;
    el.name.value = payload.name || 'Minha Planilha';
    rebuild();
    select(0, 0);
    autosave();
  }

  function autosave() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      localStorage.setItem(AUTOSAVE, JSON.stringify(serialize()));
      status('Salvo automaticamente no navegador');
    }, 400);
  }

  function syncFromEngine() {
    editing = null;
    formulaRange = null;
    dragState = null;
    const rows = engine.getSheetSerialized(0);
    data = empty();
    rows.slice(0, ROWS).forEach((row, rowIndex) => {
      row.slice(0, COLS).forEach((value, colIndex) => {
        data[rowIndex][colIndex] = value;
      });
    });
    render();
    autosave();
  }

  async function saveServer() {
    const name = el.name.value.trim();
    if (!name) {
      el.name.focus();
      return status('Informe o nome da planilha.', true);
    }
    status('Salvando...');
    const response = await fetch('/api/workbooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: workbookId, name, data: serialize() }),
    });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao salvar.');
    workbookId = output.id;
    status(`Planilha salva: ${output.name}`);
    autosave();
  }

  async function listServer() {
    el.oList.innerHTML = '<p class="muted">Carregando...</p>';
    el.oDlg.showModal();
    const response = await fetch('/api/workbooks');
    const list = await response.json();
    if (!response.ok) throw new Error('Erro ao listar planilhas.');
    if (!list.length) {
      el.oList.innerHTML = '<p class="muted">Nenhuma planilha salva.</p>';
      return;
    }
    el.oList.innerHTML = '';
    list.forEach((workbook) => {
      const item = document.createElement('div');
      item.className = 'workbook-item';
      item.innerHTML = '<div><strong></strong><small></small></div><div><button class="primary">Abrir</button><button>Excluir</button></div>';
      item.querySelector('strong').textContent = workbook.name;
      item.querySelector('small').textContent = `Atualizada em ${new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(workbook.updated_at))}`;
      const [open, remove] = item.querySelectorAll('button');
      open.onclick = () => openServer(workbook.id);
      remove.onclick = () => deleteServer(workbook.id);
      el.oList.append(item);
    });
  }

  async function openServer(id) {
    const response = await fetch(`/api/workbooks/${id}`);
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao abrir.');
    load(output.data, output.id);
    el.oDlg.close();
    status(`Planilha aberta: ${output.name}`);
  }

  async function deleteServer(id) {
    const response = await fetch(`/api/workbooks/${id}`, { method: 'DELETE' });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao excluir.');
    if (workbookId === id) workbookId = null;
    el.oDlg.close();
    await listServer();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${(el.name.value || 'planilha')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    status('Planilha exportada');
  }

  async function importJson(file) {
    load(JSON.parse(await file.text()));
    status(`Arquivo importado: ${file.name}`);
  }

  function newBook() {
    editing = null;
    formulaRange = null;
    dragState = null;
    data = empty();
    workbookId = null;
    el.name.value = 'Minha Planilha';
    rebuild();
    select(0, 0);
    localStorage.removeItem(AUTOSAVE);
    status('Nova planilha criada');
  }

  function example() {
    newBook();
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
    engine.setCellContents(
      { sheet: 0, row: 0, col: 0 },
      window.SuperExcelFormulaEngine.normalizeDataForEngine(matrix)
    );
    matrix.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        data[rowIndex][colIndex] = value;
      });
    });
    render();
    autosave();
    status('Exemplo empresarial carregado');
  }

  function renderFunctions() {
    el.fList.innerHTML = '';
    F.forEach(([name, description, formula], index) => {
      const card = document.createElement('article');
      card.className = 'formula-card';
      card.innerHTML = `<span class="formula-number">${String(index + 1).padStart(2, '0')}</span><div><strong></strong><p></p><code></code></div><button>Usar</button>`;
      card.querySelector('strong').textContent = name;
      card.querySelector('p').textContent = description;
      card.querySelector('code').textContent = formula;
      card.querySelector('button').onclick = () => {
        el.fDlg.close();
        startEdit(formula);
      };
      el.fList.append(card);
    });
  }

  function cellFromPointerEvent(event) {
    return event.target.closest?.('.cell') ?? null;
  }

  function bind() {
    el.grid.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const target = cellFromPointerEvent(event);
      if (!target) return;
      const row = Number(target.dataset.row);
      const col = Number(target.dataset.col);

      event.preventDefault();

      if (editing) {
        if (el.formula.value.trimStart().startsWith('=')) {
          beginFormulaRange(row, col);
          return;
        }
        if (!commit(el.formula.value)) return;
      }

      beginSelectionRange(row, col);
    });

    el.grid.addEventListener('mousemove', (event) => {
      if (!dragState) return;
      const target = cellFromPointerEvent(event);
      if (!target) return;
      const row = Number(target.dataset.row);
      const col = Number(target.dataset.col);
      if (dragState.mode === 'formula') updateFormulaRange(row, col);
      else updateSelectionRange(row, col);
    });

    window.addEventListener('mouseup', () => {
      if (!dragState) return;
      if (dragState.mode === 'formula') finishFormulaRange();
      else finishSelectionRange();
    });

    el.grid.addEventListener('dblclick', (event) => {
      if (event.target.closest('.cell')) startEdit();
    });

    el.grid.addEventListener('keydown', (event) => {
      const map = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        Enter: [1, 0],
        Tab: [0, event.shiftKey ? -1 : 1],
      };
      if (map[event.key]) {
        event.preventDefault();
        move(...map[event.key]);
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

    el.grid.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      const matrix = text
        .replace(/\r/g, '')
        .split('\n')
        .filter((line, index, lines) => line || index < lines.length - 1)
        .map((row) => row.split('\t').map(parse));
      try {
        engine.setCellContents(
          { sheet: 0, row: selected.row, col: selected.col },
          window.SuperExcelFormulaEngine.normalizeDataForEngine(matrix)
        );
        matrix.forEach((row, rowOffset) => {
          row.forEach((value, colOffset) => {
            if (selected.row + rowOffset < ROWS && selected.col + colOffset < COLS) {
              data[selected.row + rowOffset][selected.col + colOffset] = value;
            }
          });
        });
        render();
        autosave();
        status(`${matrix.length} linha(s) colada(s)`);
      } catch (error) {
        status(error.message, true);
      }
    });

    el.formula.addEventListener('focus', () => {
      if (!editing) {
        editing = { row: selected.row, col: selected.col };
        selectionRange = createRange(selected.row, selected.col);
        selectionUi();
        previewEdit();
      }
    });

    el.formula.addEventListener('input', () => {
      formulaRange = null;
      selectionUi();
      previewEdit();
    });

    el.formula.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (commit(el.formula.value)) move(1, 0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      }
    });

    $('#new-button').onclick = newBook;
    $('#save-button').onclick = () => saveServer().catch((error) => status(error.message, true));
    $('#open-button').onclick = () => listServer().catch((error) => status(error.message, true));
    $('#functions-button').onclick = () => el.fDlg.showModal();
    $('#clear-button').onclick = clearSelectedRange;
    $('#example-button').onclick = example;
    $('#export-button').onclick = exportJson;
    $('#import-input').onchange = (event) => {
      const file = event.target.files[0];
      if (file) importJson(file).catch((error) => status(error.message, true));
      event.target.value = '';
    };
    $('#undo-button').onclick = () => {
      if (engine.isThereSomethingToUndo()) {
        engine.undo();
        syncFromEngine();
      }
    };
    $('#redo-button').onclick = () => {
      if (engine.isThereSomethingToRedo()) {
        engine.redo();
        syncFromEngine();
      }
    };

    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.onclick = () => document.querySelector(`#${button.dataset.closeDialog}`).close();
    });
    el.name.addEventListener('input', autosave);
    window.addEventListener('beforeunload', () => {
      localStorage.setItem(AUTOSAVE, JSON.stringify(serialize()));
    });
  }

  function init() {
    build();
    renderFunctions();
    rebuild();
    bind();
    const saved = localStorage.getItem(AUTOSAVE);
    if (saved) {
      try {
        load(JSON.parse(saved));
        status('Rascunho restaurado do navegador');
      } catch {
        localStorage.removeItem(AUTOSAVE);
        select(0, 0);
      }
    } else {
      select(0, 0);
    }
  }

  init();
})();