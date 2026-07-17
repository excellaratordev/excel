const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBounds,
  selectionContains,
  collectClearChanges,
  parseClipboardText,
  selectionToMatrix,
  serializeSelection,
  keyboardAction,
} = require('../../static/js/grid/interaction.js');

test('normalizes reverse selections', () => {
  assert.deepEqual(normalizeBounds({ startRow: 4, startCol: 5, endRow: 2, endCol: 1 }), {
    top: 2, bottom: 4, left: 1, right: 5,
  });
});

test('detects coordinates inside reverse selections', () => {
  const selection = { startRow: 4, startCol: 5, endRow: 2, endCol: 1 };
  assert.equal(selectionContains(selection, 3, 2), true);
  assert.equal(selectionContains(selection, 1, 2), false);
});

test('clears sparse entries without scanning the full rectangle', () => {
  const values = [
    { row: 1, col: 1, value: 'A' },
    { row: 1, col: 2, value: 'B' },
    { row: 2, col: 2, value: 'C' },
    { row: 50, col: 50, value: 'outside' },
  ];
  const store = { entries: function* entries() { yield* values; } };
  assert.deepEqual(
    collectClearChanges(store, { startRow: 1, startCol: 1, endRow: 2, endCol: 2 }),
    [
      { row: 1, col: 1, value: null },
      { row: 1, col: 2, value: null },
      { row: 2, col: 2, value: null },
    ],
  );
});

test('keeps compatibility with stores that only expose has', () => {
  const filled = new Set(['1:1', '2:2']);
  const store = { has: (row, col) => filled.has(`${row}:${col}`) };
  assert.deepEqual(
    collectClearChanges(store, { startRow: 1, startCol: 1, endRow: 2, endCol: 2 }),
    [{ row: 1, col: 1, value: null }, { row: 2, col: 2, value: null }],
  );
});

test('parses clipboard rows, columns and Windows newlines', () => {
  assert.deepEqual(parseClipboardText('A\tB\r\n1\t2\r\n'), [['A', 'B'], ['1', '2']]);
  assert.deepEqual(parseClipboardText(''), [['']]);
});

test('serializes a rectangular selection as TSV', () => {
  const values = new Map([['0:0', 'A'], ['0:1', '=SOMA(A1:A2)'], ['1:0', 10]]);
  const store = { get: (row, col) => values.get(`${row}:${col}`) ?? null };
  const selection = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
  assert.deepEqual(selectionToMatrix(store, selection), [['A', '=SOMA(A1:A2)'], [10, '']]);
  assert.equal(serializeSelection(store, selection), 'A\t=SOMA(A1:A2)\n10\t');
});

test('maps editing, navigation and clipboard shortcuts', () => {
  assert.deepEqual(keyboardAction({ key: 'A' }), { type: 'edit', initialValue: 'A', replace: true });
  assert.deepEqual(keyboardAction({ key: 'F2' }), { type: 'edit', preserve: true });
  assert.deepEqual(keyboardAction({ key: 'Backspace' }), { type: 'clear' });
  assert.deepEqual(keyboardAction({ key: 'ArrowRight', shiftKey: true }), {
    type: 'extend', rowDelta: 0, colDelta: 1,
  });
  assert.deepEqual(keyboardAction({ key: 'c', ctrlKey: true }), { type: 'copy' });
  assert.deepEqual(keyboardAction({ key: 'x', metaKey: true }), { type: 'cut' });
  assert.deepEqual(keyboardAction({ key: 'a', ctrlKey: true }), { type: 'selectAll' });
  assert.deepEqual(keyboardAction({ key: 'ArrowDown', ctrlKey: true }), {
    type: 'moveEdge', rowDelta: 1, colDelta: 0,
  });
});
