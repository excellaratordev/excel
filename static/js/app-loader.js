(() => {
  'use strict';

  const AUTOSAVE = 'super-excel-autosave-v1';
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
    for (const letter of String(name).toUpperCase()) {
      result = result * 26 + letter.charCodeAt(0) - 64;
    }
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

    const rows = Math.min(
      MAX_ROWS,
      Math.max(
        DEFAULT_ROWS,
        Math.min(declaredRows, SOFT_ROWS),
        lastUsedRow + 51,
        lastReferencedRow + 1,
      ),
    );
    const cols = Math.min(
      MAX_COLS,
      Math.max(
        DEFAULT_COLS,
        Math.min(declaredCols, SOFT_COLS),
        lastUsedCol + 11,
        lastReferencedCol + 1,
      ),
    );

    return { rows, cols };
  }

  function savedPayload() {
    try {
      return JSON.parse(localStorage.getItem(AUTOSAVE) || '{}');
    } catch {
      localStorage.removeItem(AUTOSAVE);
      return {};
    }
  }

  function loadApplication(rows, cols) {
    const request = new XMLHttpRequest();
    request.open('GET', '/static/js/app.js', false);
    request.send(null);

    if (request.status < 200 || request.status >= 300) {
      throw new Error(`Não foi possível carregar o editor (${request.status}).`);
    }

    let source = request.responseText;
    source = source.replace(/const ROWS\s*=\s*\d+\s*;/, `const ROWS = ${rows};`);
    source = source.replace(/const COLS\s*=\s*\d+\s*;/, `const COLS = ${cols};`);

    if (!source.includes(`const ROWS = ${rows};`) || !source.includes(`const COLS = ${cols};`)) {
      throw new Error('Não foi possível ajustar o tamanho da grade.');
    }

    window.SuperExcelGridSize = Object.freeze({ rows, cols });
    (0, eval)(`${source}\n//# sourceURL=/static/js/app.dynamic.js`);
  }

  try {
    const dimensions = dimensionsFromPayload(savedPayload());
    loadApplication(dimensions.rows, dimensions.cols);
  } catch (error) {
    console.error(error);
    document.body.classList.remove('sheet-loading');
    const status = document.querySelector('#status-message');
    if (status) {
      status.textContent = error.message || 'Erro ao abrir a planilha.';
      status.classList.add('error');
    }
  }
})();
