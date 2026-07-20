import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const contract = require('../../static/js/wasm/engine-contract.js');
const parser = require('../../static/js/calculation/formula-parser.js');
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWasm = path.resolve(currentDir, '../../wasm-engine/target/wasm32-unknown-unknown/release/superexcel_wasm_engine.wasm');
const wasmPath = path.resolve(process.argv[2] || defaultWasm);
const engine = await contract.instantiate(fs.readFileSync(wasmPath));

assert.equal(engine.version, 4);
assert.equal(engine.validateOperation({ id: 'op-1', kind: 'cells.patch', changes: [] }), true);
assert.equal(engine.validateOperation({ kind: 'cells.patch' }), false);

const arithmetic = engine.evaluateFormula('=1+2*3');
assert.equal(arithmetic.status, 'ok');
assert.equal(arithmetic.value, 7);

const aggregate = engine.evaluateFormula('=SOMA(A1:A3)+B1', { A1: 2, A2: 3, A3: 5, B1: 10 });
assert.equal(aggregate.status, 'ok');
assert.equal(aggregate.value, 20);
assert.deepEqual(aggregate.dependencies, ['A1', 'A2', 'A3', 'B1']);

const conditional = engine.evaluateFormula('=SE(A1>10;"alto";"baixo")', { A1: 12 });
assert.equal(conditional.status, 'ok');
assert.equal(conditional.value, 'alto');

const sumifs = engine.evaluateFormula('=SOMASES(D1:D4;A1:A4;"Pago";B1:B4;">=10")', {
  A1: 'Pago', A2: 'Pendente', A3: 'Pago', A4: 'Pago',
  B1: 10, B2: 20, B3: 8, B4: 30,
  D1: 100, D2: 200, D3: 300, D4: 400,
});
assert.equal(sumifs.status, 'ok');
assert.equal(sumifs.value, 500);

const xlookup = engine.evaluateFormula('=PROCX("B";A1:A3;B1:B3;"ausente")', {
  A1: 'A', A2: 'B', A3: 'C', B1: 10, B2: 20, B3: 30,
});
assert.equal(xlookup.status, 'ok');
assert.equal(xlookup.value, 20);

const formula = '=SOMASES(D1:D4;A1:A4;"Pago";B1:B4;">=10")';
const rustIr = engine.compileFormula(formula);
const javascriptIr = parser.compile(formula);
assert.equal(rustIr.status, 'ok');
assert.equal(rustIr.ir_version, 1);
assert.deepEqual(rustIr.ast, javascriptIr.ast);
assert.deepEqual(rustIr.dependencies, javascriptIr.dependencies);

const unsupported = engine.evaluateFormula('=FILTRO(A1:A2;B1:B2)', {});
assert.equal(unsupported.status, 'unsupported');

const created = engine.createWorkbook({
  A1: 2,
  B1: '=A1*3',
  C1: '=B1+1',
  Z1: '=1+1',
});
assert.equal(created.status, 'ok');
assert.ok(created.handle > 0);

const before = engine.getWorkbookCell(created.handle, 'C1');
assert.equal(before.status, 'ok');
assert.equal(before.value, 7);

const independent = engine.getWorkbookCell(created.handle, 'Z1');
assert.equal(independent.value, 2);
const statsBefore = engine.getWorkbookStats(created.handle).stats;

const applied = engine.applyWorkbook(created.handle, { A1: 5 });
assert.equal(applied.status, 'ok');
assert.deepEqual(applied.affected, ['A1', 'B1', 'C1']);

const after = engine.getWorkbookCell(created.handle, 'C1');
assert.equal(after.value, 16);
const independentAgain = engine.getWorkbookCell(created.handle, 'Z1');
assert.equal(independentAgain.value, 2);
const statsAfter = engine.getWorkbookStats(created.handle).stats;
assert.ok(statsAfter.cache_hits > statsBefore.cache_hits);
assert.ok(statsAfter.recalculations > statsBefore.recalculations);
assert.equal(engine.destroyWorkbook(created.handle), true);

console.log(JSON.stringify({
  wasm: 'ok',
  abi: engine.version,
  tests: 16,
  ir: rustIr.ir_version,
  business: ['SOMASES', 'PROCX'],
  stateful: {
    affected: applied.affected,
    cache_hits: statsAfter.cache_hits,
    recalculations: statsAfter.recalculations,
  },
}));
