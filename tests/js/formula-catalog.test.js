'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadCatalog() {
  global.window = {};
  const parserPath = path.resolve(__dirname, '../../static/js/calculation/formula-parser.js');
  const catalogPath = path.resolve(__dirname, '../../static/js/calculation/formula-catalog.js');
  const logicalPath = path.resolve(__dirname, '../../static/js/calculation/logical-library.js');
  delete require.cache[parserPath];
  delete require.cache[catalogPath];
  delete require.cache[logicalPath];
  require(parserPath);
  require(catalogPath);
  require(logicalPath);
  return {
    parser: global.window.SuperExcelFormulaParser,
    catalog: global.window.SuperExcelFormulaCatalog,
  };
}

test('formula catalog documents every currently supported Portuguese function', () => {
  const { catalog } = loadCatalog();
  const names = catalog.items.map(item => item.name);
  const expected = [
    'SOMA', 'MÉDIA', 'MÁXIMO', 'MÍNIMO',
    'SE', 'SES', 'E', 'OU', 'NÃO', 'OUEXCL', 'SEERRO', 'SENÃODISP', 'PARÂMETRO',
    'ÉCÉL.VAZIA', 'ÉLÓGICO', 'ÉNÚM', 'ÉTEXTO', 'ÉERRO', 'ÉERROS', 'ÉNÃO.DISP', 'NÃO.DISP',
    'CONT.NÚM', 'CONT.VALORES', 'CONT.SE', 'CONT.SES',
    'SOMASE', 'SOMASES', 'MÉDIASE', 'MÉDIASES',
    'PROCV', 'PROCX', 'ÍNDICE', 'CORRESP',
    'FILTRO', 'ÚNICO', 'CLASSIFICAR',
    'CONCAT', 'TEXTO.JUNTAR', 'ESQUERDA', 'DIREITA', 'TEXTO',
    'HOJE', 'VERDADEIRO', 'FALSO',
  ];

  assert.equal(catalog.count, 44);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), [...expected].sort());
});

test('every catalog entry includes usable documentation and a parseable example', () => {
  const { parser, catalog } = loadCatalog();

  for (const item of catalog.items) {
    assert.ok(item.category, `${item.name} sem categoria`);
    assert.ok(item.description, `${item.name} sem descrição`);
    assert.ok(item.syntax.includes('('), `${item.name} sem sintaxe`);
    assert.ok(item.example.startsWith('='), `${item.name} sem exemplo de fórmula`);
    assert.doesNotThrow(() => parser.parse(item.example), `exemplo inválido: ${item.name}`);
  }
});
