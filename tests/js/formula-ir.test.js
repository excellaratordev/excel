'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const parser = require('../../static/js/calculation/formula-parser.js');

test('IR JavaScript é versionada e normaliza nomes localizados', () => {
  const result = parser.compile('=MÉDIA(A1:A3)+SE(B1>0;1;0)');
  assert.equal(result.status, 'ok');
  assert.equal(result.ir_version, 2);
  assert.equal(result.ast.type, 'binary');
  assert.equal(result.ast.left.name, 'MEDIA');
  assert.deepEqual(result.dependencies, ['B1']);
  assert.deepEqual(result.range_dependencies, [
    { top: 0, bottom: 2, left: 0, right: 0 },
  ]);
});

test('IR local recusa referências externas sem inventar contrato', () => {
  const result = parser.compile("='Clientes'!A1");
  assert.equal(result.status, 'unsupported');
});


test('IR v2 mantém intervalos grandes compactos', () => {
  const result = parser.compile('=SOMA(A1:A100000)+Z1');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.dependencies, ['Z1']);
  assert.deepEqual(result.range_dependencies, [
    { top: 0, bottom: 99999, left: 0, right: 0 },
  ]);
});
