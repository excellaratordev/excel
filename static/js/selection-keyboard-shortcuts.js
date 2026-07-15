(() => {
  'use strict';

  const grid = document.querySelector('#spreadsheet');
  if (!grid) return;

  const directions = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };

  function allCells() {
    return [...grid.querySelectorAll('.cell')];
  }

  function dimensions() {
    const cells = allCells();
    let rows = 0;
    let cols = 0;
    for (const cell of cells) {
      rows = Math.max(rows, Number(cell.dataset.row) + 1);
      cols = Math.max(cols, Number(cell.dataset.col) + 1);
    }
    return { rows, cols };
  }

  function getCell(row, col) {
    return grid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  function coordinates(cell) {
    return {
      row: Number(cell.dataset.row),
      col: Number(cell.dataset.col),
    };
  }

  function currentSelection() {
    const selectedCells = [...grid.querySelectorAll('.range-selected, .selected')];
    if (!selectedCells.length) return null;

    const anchorCell = grid.querySelector('.selection-anchor, .selected') ?? selectedCells[0];
    const anchor = coordinates(anchorCell);
    const rows = selectedCells.map((cell) => Number(cell.dataset.row));
    const cols = selectedCells.map((cell) => Number(cell.dataset.col));
    const bounds = {
      top: Math.min(...rows),
      bottom: Math.max(...rows),
      left: Math.min(...cols),
      right: Math.max(...cols),
    };

    const endpoint = {
      row: anchor.row === bounds.top ? bounds.bottom : bounds.top,
      col: anchor.col === bounds.left ? bounds.right : bounds.left,
    };

    return { anchor, endpoint };
  }

  function inBounds(row, col, size) {
    return row >= 0 && row < size.rows && col >= 0 && col < size.cols;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function isFilled(row, col) {
    const cell = getCell(row, col);
    return Boolean(cell && cell.textContent.trim() !== '');
  }

  function nextDataBoundary(start, rowStep, colStep, size) {
    const next = { row: start.row + rowStep, col: start.col + colStep };
    if (!inBounds(next.row, next.col, size)) return start;

    const currentFilled = isFilled(start.row, start.col);
    const nextFilled = isFilled(next.row, next.col);

    if (nextFilled) {
      // Partindo de uma célula vazia, o Excel para na primeira célula preenchida.
      if (!currentFilled) return next;

      // Dentro de um bloco preenchido, avança até a borda desse bloco.
      let target = next;
      while (inBounds(target.row + rowStep, target.col + colStep, size)
        && isFilled(target.row + rowStep, target.col + colStep)) {
        target = { row: target.row + rowStep, col: target.col + colStep };
      }
      return target;
    }

    // Quando a próxima célula é vazia, procura a próxima célula preenchida.
    // Se não houver outra, termina na borda da planilha.
    let target = next;
    while (inBounds(target.row, target.col, size)) {
      if (isFilled(target.row, target.col)) return target;
      const following = { row: target.row + rowStep, col: target.col + colStep };
      if (!inBounds(following.row, following.col, size)) return target;
      target = following;
    }

    return start;
  }

  function dispatchMouse(target, type, options = {}) {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      ...options,
    }));
  }

  function applySelection(anchor, endpoint) {
    const startCell = getCell(anchor.row, anchor.col);
    const endCell = getCell(endpoint.row, endpoint.col);
    if (!startCell || !endCell) return;

    dispatchMouse(startCell, 'mousedown', { buttons: 1 });
    if (startCell !== endCell) dispatchMouse(endCell, 'mousemove', { buttons: 1 });
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 0,
    }));

    endCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  grid.addEventListener('keydown', (event) => {
    const direction = directions[event.key];
    if (!direction || !event.shiftKey || event.altKey) return;

    const selection = currentSelection();
    if (!selection) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const [rowStep, colStep] = direction;
    const size = dimensions();
    let endpoint;

    if (event.ctrlKey || event.metaKey) {
      endpoint = nextDataBoundary(selection.endpoint, rowStep, colStep, size);
    } else {
      endpoint = {
        row: clamp(selection.endpoint.row + rowStep, 0, size.rows - 1),
        col: clamp(selection.endpoint.col + colStep, 0, size.cols - 1),
      };
    }

    applySelection(selection.anchor, endpoint);
  }, true);
})();
