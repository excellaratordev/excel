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

assert.equal(engine.version, 2);
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

console.log(JSON.stringify({ wasm: 'ok', abi: engine.version, tests: 5 }));
