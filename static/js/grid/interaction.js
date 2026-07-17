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

  function normalizeBounds(selection = {}) {
    const startRow = Number(selection.startRow) || 0;
    const startCol = Number(selection.startCol) || 0;
    const endRow = Number(selection.endRow) || 0;
    const endCol = Number(selection.endCol) || 0;
    return {
      top: Math.min(startRow, endRow),
      bottom: Math.max(startRow, endRow),
      left: Math.min(startCol, endCol),
      right: Math.max(startCol, endCol),
    };
  }

  function collectClearChanges(store, selection, limit = 10000) {
    const maximum = Math.max(1, Number(limit) || 10000);
    const result = [];
    const bounds = normalizeBounds(selection);
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let col = bounds.left; col <= bounds.right; col += 1) {
        if (store?.has?.(row, col)) result.push({ row, col, value: null });
        if (result.length >= maximum) return result;
      }
    }
    return result;
  }

  function keyboardAction(event = {}) {
    const direction = DIRECTIONS[event.key];
    if (direction && event.shiftKey && !event.altKey) {
      return { type: 'extend', rowDelta: direction[0], colDelta: direction[1] };
    }
    if (direction) return { type: 'move', rowDelta: direction[0], colDelta: direction[1] };
    if (event.key === 'Enter') return { type: 'move', rowDelta: 1, colDelta: 0 };
    if (event.key === 'Tab') return { type: 'move', rowDelta: 0, colDelta: event.shiftKey ? -1 : 1 };
    if (event.key === 'Delete' || event.key === 'Backspace') return { type: 'clear' };
    if (event.key === 'F2') return { type: 'edit' };
    if (!event.ctrlKey && !event.metaKey && !event.altKey && String(event.key || '').length === 1) {
      return { type: 'edit', initialValue: event.key };
    }
    return null;
  }

  return { DIRECTIONS, normalizeBounds, collectClearChanges, keyboardAction };
});
