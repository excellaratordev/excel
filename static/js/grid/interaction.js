(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SuperExcelGridInteraction = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DIRECTIONS = Object.freeze({
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  });

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeBounds(selection = {}) {
    const startRow = numberOrZero(selection.startRow);
    const startCol = numberOrZero(selection.startCol);
    const endRow = numberOrZero(selection.endRow);
    const endCol = numberOrZero(selection.endCol);
    return {
      top: Math.min(startRow, endRow),
      bottom: Math.max(startRow, endRow),
      left: Math.min(startCol, endCol),
      right: Math.max(startCol, endCol),
    };
  }

  function selectionContains(selection, row, col) {
    const bounds = normalizeBounds(selection);
    return row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;
  }

  function collectClearChanges(store, selection, limit = 10000) {
    const maximum = Math.max(1, Number(limit) || 10000);
    const result = [];

    if (store?.entries) {
      for (const item of store.entries()) {
        if (!selectionContains(selection, item.row, item.col)) continue;
        result.push({ row: item.row, col: item.col, value: null });
        if (result.length >= maximum) break;
      }
      return result;
    }

    const bounds = normalizeBounds(selection);
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        if (store?.has?.(row, col)) result.push({ row, col, value: null });
        if (result.length >= maximum) return result;
      }
    }
    return result;
  }

  function parseClipboardText(text) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines.map(line => line.split('\t'));
  }

  function selectionToMatrix(store, selection, formatter = value => value ?? '') {
    const bounds = normalizeBounds(selection);
    const matrix = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const line = [];
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        line.push(formatter(store?.get?.(row, col), row, col));
      }
      matrix.push(line);
    }
    return matrix;
  }

  function serializeSelection(store, selection, formatter) {
    return selectionToMatrix(store, selection, formatter)
      .map(row => row.map(value => String(value ?? '')).join('\t'))
      .join('\n');
  }

  function keyboardAction(event = {}) {
    const key = String(event.key || '');
    const modifier = Boolean(event.ctrlKey || event.metaKey);
    const direction = DIRECTIONS[key];

    if (modifier && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'c') return { type: 'copy' };
      if (lower === 'x') return { type: 'cut' };
      if (lower === 'a') return { type: 'selectAll' };
      if (direction) {
        return {
          type: event.shiftKey ? 'extendEdge' : 'moveEdge',
          rowDelta: direction[0],
          colDelta: direction[1],
        };
      }
      if (key === 'Home') return { type: event.shiftKey ? 'extendStart' : 'moveStart' };
      if (key === 'End') return { type: event.shiftKey ? 'extendEnd' : 'moveEnd' };
      return null;
    }

    if (direction && event.shiftKey && !event.altKey) {
      return { type: 'extend', rowDelta: direction[0], colDelta: direction[1] };
    }
    if (direction && !event.altKey) return { type: 'move', rowDelta: direction[0], colDelta: direction[1] };
    if (key === 'Enter') return { type: 'move', rowDelta: event.shiftKey ? -1 : 1, colDelta: 0 };
    if (key === 'Tab') return { type: 'move', rowDelta: 0, colDelta: event.shiftKey ? -1 : 1 };
    if (key === 'Home') return { type: event.shiftKey ? 'extendRowStart' : 'moveRowStart' };
    if (key === 'End') return { type: event.shiftKey ? 'extendRowEnd' : 'moveRowEnd' };
    if (key === 'PageUp') return { type: event.shiftKey ? 'extendPage' : 'movePage', direction: -1 };
    if (key === 'PageDown') return { type: event.shiftKey ? 'extendPage' : 'movePage', direction: 1 };
    if (key === 'Delete' || key === 'Backspace') return { type: 'clear' };
    if (key === 'F2') return { type: 'edit', preserve: true };
    if (!modifier && !event.altKey && key.length === 1) return { type: 'edit', initialValue: key, replace: true };
    return null;
  }

  return {
    DIRECTIONS,
    normalizeBounds,
    selectionContains,
    collectClearChanges,
    parseClipboardText,
    selectionToMatrix,
    serializeSelection,
    keyboardAction,
  };
});
