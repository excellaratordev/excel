const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBounds,
  collectClearChanges,
  keyboardAction,
} = require('../../static/js/grid/interaction.js');

test('normalizes reverse selections', () => {
  assert.deepEqual(normalizeBounds({ startRow: 4, startCol: 5, endRow: 2, endCol: 1 }), {
    top: 2, bottom: 4, left: 1, right: 5,
  });
});

test('collects every filled cell in a selected range for Backspace', () => {
  const filled = new Set(['1:1', '1:2', '2:2', '3:3']);
  const store = { has: (row, col) => filled.has(`${row}:${col}`) };
  assert.deepEqual(
    collectClearChanges(store, { startRow: 1, startCol: 1, endRow: 2, endCol: 2 }),
    [
      { row: 1, col: 1, value: null },
      { row: 1, col: 2, value: null },
      { row: 2, col: 2, value: null },
    ],
  );
});

test('returns early at the patch limit', () => {
  const store = { has: () => true };
  assert.equal(
    collectClearChanges(store, { startRow: 0, startCol: 0, endRow: 20, endCol: 20 }, 5).length,
    5,
  );
});

test('maps direct typing and deletion to spreadsheet actions', () => {
  assert.deepEqual(keyboardAction({ key: 'A' }), { type: 'edit', initialValue: 'A' });
  assert.deepEqual(keyboardAction({ key: 'Backspace' }), { type: 'clear' });
  assert.deepEqual(keyboardAction({ key: 'ArrowRight', shiftKey: true }), {
    type: 'extend', rowDelta: 0, colDelta: 1,
  });
  assert.equal(keyboardAction({ key: 'c', ctrlKey: true }), null);
});
