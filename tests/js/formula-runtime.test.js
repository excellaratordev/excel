'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

global.window = global;
for (const file of [
  'formula-parser.js',
  'dependency-graph.js',
  'function-library.js',
  'formula-runtime.js',
  'logical-library.js',
]) {
  require(path.join(__dirname, '../../static/js/calculation', file));
}

function value(engine, row, col) {
  return engine.getCellValue({ sheet: 0, row, col });
}

test('calcula fórmulas básicas e atualiza somente dependentes', () => {
  const engine = SuperExcelFormulaEngine.create([
    [10, 20, '=SOMA(A1:B1)'],
    [null, null, '=C1*2'],
    [null, null, '=100+1'],
  ]);

  assert.equal(value(engine, 0, 2), 30);
  assert.equal(value(engine, 1, 2), 60);
  assert.equal(value(engine, 2, 2), 101);
  engine.consumeAffectedCells();

  engine.setCellContents({ sheet: 0, row: 0, col: 0 }, [[15]]);
  const affected = new Set(engine.consumeAffectedCells().map(item => `${item.row}:${item.col}`));
  assert.deepEqual(affected, new Set(['0:0', '0:2', '1:2']));
  assert.equal(value(engine, 0, 2), 35);
  assert.equal(value(engine, 1, 2), 70);
  assert.equal(value(engine, 2, 2), 101);
});

test('suporta funções empresariais em português', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['Cidade', 'Status', 'Valor'],
    ['Fortaleza', 'Pago', 100],
    ['Recife', 'Pendente', 50],
    ['Fortaleza', 'Pago', 200],
    ['=SOMASES(C2:C4;A2:A4;"Fortaleza";B2:B4;"Pago")'],
    ['=MÉDIASES(C2:C4;A2:A4;"Fortaleza")'],
    ['=PROCX("Recife";A2:A4;C2:C4;0)'],
  ]);

  assert.equal(value(engine, 4, 0), 300);
  assert.equal(value(engine, 5, 0), 150);
  assert.equal(value(engine, 6, 0), 50);
});

test('funções dinâmicas geram saída derramada sem gravar células extras', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['Nome', 'Status', null, '=FILTRO(A2:B4;B2:B4="Pago")'],
    ['A', 'Pago'],
    ['B', 'Pendente'],
    ['C', 'Pago'],
  ]);

  assert.equal(value(engine, 0, 3), 'A');
  assert.equal(value(engine, 0, 4), 'Pago');
  assert.equal(value(engine, 1, 3), 'C');
  assert.equal(value(engine, 1, 4), 'Pago');
  assert.equal(engine.getStats().spill_cells, 3);
});

test('detecta ciclos e preserva desfazer/refazer', () => {
  const engine = SuperExcelFormulaEngine.create([[1, '=A1+1']]);
  engine.setCellContents({ sheet: 0, row: 0, col: 0 }, [[5]]);
  assert.equal(value(engine, 0, 1), 6);
  assert.equal(engine.isThereSomethingToUndo(), true);

  engine.undo();
  assert.equal(value(engine, 0, 0), 1);
  assert.equal(value(engine, 0, 1), 2);
  engine.redo();
  assert.equal(value(engine, 0, 0), 5);

  engine.setCellContents({ sheet: 0, row: 0, col: 0 }, [['=B1']]);
  assert.equal(value(engine, 0, 0), '#CIRC!');
});

test('grafo usa dependências por intervalo sem expandir todas as células', () => {
  const engine = SuperExcelFormulaEngine.create([
    [1],
    [2],
    [3],
    [null, '=SOMA(A1:A5000)'],
  ]);
  assert.equal(value(engine, 3, 1), 6);
  const stats = engine.getStats();
  assert.equal(stats.range_dependency_edges, 1);
  assert.equal(stats.exact_dependency_edges, 0);
});
