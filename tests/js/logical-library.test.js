'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

global.window = global;
for (const file of [
  'formula-parser.js',
  'dependency-graph.js',
  'function-library.js',
  'formula-catalog.js',
  'formula-runtime.js',
  'logical-library.js',
]) {
  require(path.join(__dirname, '../../static/js/calculation', file));
}

function value(engine, row, col) {
  return engine.getCellValue({ sheet: 0, row, col });
}

test('SE, E e OU evitam avaliar expressões desnecessárias', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['=SE(FALSO();1/0;42)'],
    ['=E(FALSO();1/0>0)'],
    ['=OU(VERDADEIRO();1/0>0)'],
  ]);

  assert.equal(value(engine, 0, 0), 42);
  assert.equal(value(engine, 1, 0), false);
  assert.equal(value(engine, 2, 0), true);
  assert.ok(engine.getStats().logical_short_circuits >= 2);
});

test('suporta NÃO, OUEXCL e coerção lógica explícita', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['=NÃO(VERDADEIRO())'],
    ['=OUEXCL(VERDADEIRO();FALSO();VERDADEIRO())'],
    ['=E(1;VERDADEIRO())'],
    ['=OU(0;FALSO())'],
  ]);

  assert.equal(value(engine, 0, 0), false);
  assert.equal(value(engine, 1, 0), false);
  assert.equal(value(engine, 2, 0), true);
  assert.equal(value(engine, 3, 0), false);
});

test('SENÃODISP diferencia #N/D de outros erros', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['Código', 'Valor'],
    ['A', 10],
    ['=SENÃODISP(PROCX("X";A2:A2;B2:B2);"Ausente")'],
    ['=SENÃODISP(1/0;"Ausente")'],
  ]);

  assert.equal(value(engine, 2, 0), 'Ausente');
  assert.equal(value(engine, 3, 0), '#DIV/0!');
});

test('PARÂMETRO avalia somente o resultado correspondente', () => {
  const engine = SuperExcelFormulaEngine.create([
    ['=PARÂMETRO("A";"P";1/0;"A";10;20)'],
    ['=PARÂMETRO("X";"A";1;"B";2;99)'],
    ['=PARÂMETRO("X";"A";1;"B";2)'],
  ]);

  assert.equal(value(engine, 0, 0), 10);
  assert.equal(value(engine, 1, 0), 99);
  assert.equal(value(engine, 2, 0), '#N/D');
});

test('funções de inspeção retornam valores lógicos previsíveis', () => {
  const engine = SuperExcelFormulaEngine.create([
    [null, 12, 'texto', true, '#N/D', '#DIV/0!'],
    ['=ÉCÉL.VAZIA(A1)', '=ÉNÚM(B1)', '=ÉTEXTO(C1)', '=ÉLÓGICO(D1)', '=ÉNÃO.DISP(E1)', '=ÉERROS(F1)'],
  ]);

  for (let col = 0; col < 6; col += 1) assert.equal(value(engine, 1, col), true);
});

test('SE e comparações suportam matrizes derramadas', () => {
  const engine = SuperExcelFormulaEngine.create([
    [1, null, '=SE(A1:A3>1;"alto";"baixo")'],
    [2],
    [3],
  ]);

  assert.equal(value(engine, 0, 2), 'baixo');
  assert.equal(value(engine, 1, 2), 'alto');
  assert.equal(value(engine, 2, 2), 'alto');
});

test('biblioteca lógica expõe catálogo e comparação centralizada', () => {
  assert.equal(SuperExcelLogicalLibrary.catalog.length, 19);
  assert.equal(SuperExcelLogicalLibrary.compareOperator('=', 'Pago', 'pago'), true);
  assert.equal(SuperExcelLogicalLibrary.compareOperator('<>', 10, 20), true);
  assert.deepEqual(
    SuperExcelLogicalLibrary.broadcastComparison('>', [[1], [3]], 2),
    [[false], [true]],
  );
});
