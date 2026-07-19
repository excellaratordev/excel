import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const contract = require('../../static/js/wasm/engine-contract.js');
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWasm = path.resolve(currentDir, '../../wasm-engine/target/wasm32-unknown-unknown/release/superexcel_wasm_engine.wasm');
const wasmPath = path.resolve(process.argv[2] || defaultWasm);
const engine = await contract.instantiate(fs.readFileSync(wasmPath));

assert.equal(engine.version, 3);
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

const unsupported = engine.evaluateFormula('=PROCX(A1;B1:B2;C1:C2)', {});
assert.equal(unsupported.status, 'unsupported');

const created = engine.createWorkbook({
  cells: {
    A1: 2,
    B1: '=A1*3',
    C1: '=B1+1',
    D1: '=10+1',
  },
});
assert.equal(created.status, 'ok');
assert.ok(created.handle > 0);

const handle = created.handle;
const first = engine.getWorkbookCell(handle, 'C1');
assert.equal(first.status, 'ok');
assert.equal(first.value, 7);

const independent = engine.getWorkbookCell(handle, 'D1');
assert.equal(independent.status, 'ok');
assert.equal(independent.value, 11);

const beforeUpdate = engine.getWorkbookStats(handle);
assert.equal(beforeUpdate.status, 'ok');
assert.equal(beforeUpdate.stats.cache_entries, 3);
assert.equal(beforeUpdate.stats.dependency_edges, 2);

const updated = engine.applyWorkbook(handle, { changes: { A1: 4 } });
assert.equal(updated.status, 'ok');
assert.deepEqual(updated.affected, ['A1', 'B1', 'C1']);
assert.equal(updated.stats.cache_entries, 1);

const recalculated = engine.getWorkbookCell(handle, 'C1');
assert.equal(recalculated.status, 'ok');
assert.equal(recalculated.value, 13);

const cached = engine.getWorkbookCell(handle, 'C1');
assert.equal(cached.status, 'ok');
assert.equal(cached.value, 13);
const afterCache = engine.getWorkbookStats(handle);
assert.ok(afterCache.stats.cache_hits >= 1);
assert.equal(afterCache.stats.revision, 1);

assert.equal(engine.destroyWorkbook(handle), true);
assert.equal(engine.destroyWorkbook(handle), false);

console.log(JSON.stringify({
  wasm: 'ok',
  abi: engine.version,
  tests: 12,
  stateful: {
    affected: updated.affected,
    cache_hits: afterCache.stats.cache_hits,
    recalculations: afterCache.stats.recalculations,
  },
}));
