(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const DEFAULT_ROWS = 60;
  const DEFAULT_COLS = 26;
  const SOFT_ROWS = 250;
  const SOFT_COLS = 40;
  const MAX_ROWS = 5000;
  const MAX_COLS = 300;

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function columnIndex(name) {
    let result = 0;
    for (const letter of String(name).toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
    return Math.max(0, result - 1);
  }

  function dimensionsFromPayload(payload) {
    const cells = Array.isArray(payload?.cells) ? payload.cells : [];
    const declaredRows = positiveInteger(payload?.rows, cells.length || DEFAULT_ROWS);
    const declaredCols = positiveInteger(
      payload?.cols,
      cells.reduce((largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 0), DEFAULT_COLS),
    );
    let lastUsedRow = -1;
    let lastUsedCol = -1;
    let lastReferencedRow = -1;
    let lastReferencedCol = -1;
    const referencePattern = /\$?([A-Z]{1,3})\$?(\d+)/giu;

    cells.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, colIndex) => {
        if (value === null || value === undefined || value === '') return;
        lastUsedRow = Math.max(lastUsedRow, rowIndex);
        lastUsedCol = Math.max(lastUsedCol, colIndex);
        if (typeof value !== 'string' || !value.trimStart().startsWith('=')) return;
        referencePattern.lastIndex = 0;
        let match;
        while ((match = referencePattern.exec(value)) !== null) {
          lastReferencedCol = Math.max(lastReferencedCol, columnIndex(match[1]));
          lastReferencedRow = Math.max(lastReferencedRow, Number(match[2]) - 1);
        }
      });
    });

    return {
      rows: Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, Math.min(declaredRows, SOFT_ROWS), lastUsedRow + 31, lastReferencedRow + 1)),
      cols: Math.min(MAX_COLS, Math.max(DEFAULT_COLS, Math.min(declaredCols, SOFT_COLS), lastUsedCol + 8, lastReferencedCol + 1)),
    };
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Não foi possível carregar ${path}.`));
      document.body.append(script);
    });
  }

  async function initialize() {
    await window.SuperExcelAuth.ready;
    let workbook = { version: 1, name: 'Minha Planilha', rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: [] };
    let meta = { revision: 0, project_id: null, role: 'editor' };

    if (workbookId) {
      const response = await fetch(`/api/workbooks/${workbookId}`);
      const output = await response.json();
      if (!response.ok) throw new Error(output.error || 'Erro ao abrir planilha.');
      workbook = output.data || workbook;
      workbook.name = output.name || workbook.name || 'Minha Planilha';
      meta = {
        revision: Number(output.revision || 1),
        project_id: output.project_id,
        role: output.role || 'viewer',
        updated_at: output.updated_at,
        updated_by_email: output.updated_by_email,
      };
    }

    window.SuperExcelInitialWorkbook = workbook;
    window.SuperExcelInitialMeta = meta;
    window.SuperExcelGridSize = Object.freeze(dimensionsFromPayload(workbook));

    await loadScript('/static/js/app-v2.js');
    await loadScript('/static/js/sheet-collaboration-v2.js');
  }

  initialize().catch(error => {
    console.error(error);
    document.body.classList.remove('sheet-loading');
    const status = document.querySelector('#status-message');
    if (status) {
      status.textContent = error.message || 'Erro ao abrir a planilha.';
      status.classList.add('error');
    }
  });
})();