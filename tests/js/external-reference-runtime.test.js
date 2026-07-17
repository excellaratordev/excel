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
  'external-reference-runtime.js',
]) {
  require(path.join(__dirname, '../../static/js/calculation', file));
}

function value(engine, row, col) {
  return engine.getCellValue({ sheet: 0, row, col });
}

test('analisa célula e faixa de uma Base com nome entre aspas simples', () => {
  const scalar = SuperExcelFormulaParser.parse("='Clientes Premium'!B3*2");
  assert.equal(scalar.type, 'binary');
  assert.equal(scalar.left.type, 'externalReference');
  assert.equal(scalar.left.source, 'Clientes Premium');
  assert.deepEqual({ row: scalar.left.row, col: scalar.left.col }, { row: 2, col: 1 });

  const range = SuperExcelFormulaParser.parse("=SOMA('Clientes'!A1:A3)");
  const reference = range.args[0];
  assert.equal(reference.type, 'externalRange');
  assert.deepEqual(reference.start, { row: 0, col: 0 });
  assert.deepEqual(reference.end, { row: 2, col: 0 });

  const dependencies = SuperExcelFormulaParser.collectDependencies(range);
  assert.equal(dependencies.external.length, 1);
  assert.equal(dependencies.external[0].sourceKey, 'clientes');
});

test('calcula valores escalares e faixas vindas de uma Base', () => {
  const engine = SuperExcelFormulaEngine.create([
    ["='Clientes'!A1*2", "=SOMA('Clientes'!A1:A3)"],
  ], {
    externalSources: [{
      id: 10,
      name: 'Clientes',
      revision: 1,
      cells: [
        { r: 0, c: 0, v: 10 },
        { r: 1, c: 0, v: 20 },
        { r: 2, c: 0, v: 30 },
      ],
    }],
  });

  assert.equal(value(engine, 0, 0), 20);
  assert.equal(value(engine, 0, 1), 60);
  assert.equal(engine.getStats().external_sources, 1);
  assert.equal(engine.getStats().external_cells, 3);
});

test('mudança de revisão invalida fórmulas externas e dependentes locais', () => {
  const engine = SuperExcelFormulaEngine.create([
    ["='Clientes'!A1", '=A1+1', '=100+1'],
  ], {
    externalSources: [{ name: 'Clientes', revision: 1, cells: [{ r: 0, c: 0, v: 5 }] }],
  });

  assert.equal(value(engine, 0, 0), 5);
  assert.equal(value(engine, 0, 1), 6);
  assert.equal(value(engine, 0, 2), 101);
  engine.consumeAffectedCells();

  engine.setExternalSources([
    { name: 'Clientes', revision: 2, cells: [{ r: 0, c: 0, v: 12 }] },
  ]);

  const affected = new Set(engine.consumeAffectedCells().map(item => `${item.row}:${item.col}`));
  assert.deepEqual(affected, new Set(['0:0', '0:1']));
  assert.equal(value(engine, 0, 0), 12);
  assert.equal(value(engine, 0, 1), 13);
  assert.equal(value(engine, 0, 2), 101);
});

test('escapa aspas simples no nome da Base', () => {
  const ast = SuperExcelFormulaParser.parse("='D''Ávila'!A1");
  assert.equal(ast.type, 'externalReference');
  assert.equal(ast.source, "D'Ávila");
});
