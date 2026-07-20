'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const parser = require('../../static/js/calculation/formula-parser.js');

test('IR JavaScript é versionada e normaliza nomes localizados', () => {
  const result = parser.compile('=MÉDIA(A1:A3)+SE(B1>0;1;0)');
  assert.equal(result.status, 'ok');
  assert.equal(result.ir_version, 1);
  assert.equal(result.ast.type, 'binary');
  assert.equal(result.ast.left.name, 'MEDIA');
  assert.deepEqual(result.dependencies, ['A1', 'A2', 'A3', 'B1']);
});

test('IR local recusa referências externas sem inventar contrato', () => {
  const result = parser.compile("='Clientes'!A1");
  assert.equal(result.status, 'unsupported');
});
