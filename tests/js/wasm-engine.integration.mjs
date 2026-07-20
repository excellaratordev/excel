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

assert.equal(engine.version, 6);
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
assert.equal(rustIr.ir_version, 2);
assert.deepEqual(rustIr.ast, javascriptIr.ast);
assert.deepEqual(rustIr.dependencies, javascriptIr.dependencies);
assert.deepEqual(rustIr.range_dependencies, javascriptIr.range_dependencies);

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

const largeWorkbook = engine.createWorkbook({
  A1: 1,
  A10000: 2,
  Z1: '=SOMA(A1:A10000)',
});
assert.equal(largeWorkbook.status, 'ok');
const largeStats = engine.getWorkbookStats(largeWorkbook.handle).stats;
assert.equal(largeStats.direct_dependency_edges, 0);
assert.equal(largeStats.range_dependencies, 1);
assert.ok(largeStats.range_buckets < 64);
assert.equal(engine.getWorkbookCell(largeWorkbook.handle, 'Z1').value, 3);
const largeApplied = engine.applyWorkbook(largeWorkbook.handle, { A5000: 5 });
assert.deepEqual(largeApplied.affected, ['A5000', 'Z1']);
assert.equal(engine.getWorkbookCell(largeWorkbook.handle, 'Z1').value, 8);
const unrelatedApplied = engine.applyWorkbook(largeWorkbook.handle, { B1: 9 });
assert.deepEqual(unrelatedApplied.affected, ['B1']);
assert.equal(engine.destroyWorkbook(largeWorkbook.handle), true);

const sparseWorkbook = engine.createWorkbook({
  A1: 10,
  A100000: 20,
  B1: 'Pago',
  B100000: 'Pago',
  Z1: '=SOMA(A1:A100000)',
  Z2: '=SOMASES(A1:A100000;B1:B100000;"Pago")',
});
assert.equal(sparseWorkbook.status, 'ok');
assert.equal(engine.getWorkbookCell(sparseWorkbook.handle, 'Z1').value, 30);
assert.equal(engine.getWorkbookCell(sparseWorkbook.handle, 'Z2').value, 30);
const sparseStats = engine.getWorkbookStats(sparseWorkbook.handle).stats;
assert.ok(sparseStats.sparse_range_evaluations >= 1);
assert.ok(sparseStats.range_positions_avoided >= 99998);
assert.ok(sparseStats.streamed_range_positions >= 100000);
assert.equal(engine.destroyWorkbook(sparseWorkbook.handle), true);

console.log(JSON.stringify({
  wasm: 'ok',
  abi: engine.version,
  tests: 22,
  ir: rustIr.ir_version,
  business: ['SOMASES', 'PROCX'],
  stateful: {
    affected: applied.affected,
    cache_hits: statsAfter.cache_hits,
    recalculations: statsAfter.recalculations,
    range_buckets: largeStats.range_buckets,
    sparse_evaluations: sparseStats.sparse_range_evaluations,
    positions_avoided: sparseStats.range_positions_avoided,
    streamed_positions: sparseStats.streamed_range_positions,
  },
}));
