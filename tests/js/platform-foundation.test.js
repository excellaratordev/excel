'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { filterSum, SharedFilterCache, IncrementalSum } = require('../../static/js/calculation/enterprise-kernel.js');
const { runSimulation } = require('../../benchmarks/collaboration-simulator.js');
const { ABI_VERSION } = require('../../static/js/wasm/engine-contract.js');

test('kernel empresarial filtra, reutiliza e atualiza por diferença', () => {
  const columns = {
    status: Uint8Array.from([1, 0, 1]),
    amount: Float64Array.from([10, 20, 30]),
  };
  assert.deepEqual(filterSum(columns, (source, index) => source.status[index] === 1, 'amount'), { total: 40, matched: 2, scanned: 3 });
  const cache = new SharedFilterCache();
  assert.equal(cache.get('x', () => 42), 42);
  assert.equal(cache.get('x', () => 99), 42);
  assert.equal(cache.executions, 1);
  const sum = new IncrementalSum([1, 2, 3]);
  assert.equal(sum.update(1, 5).total, 9);
});

test('simulação R1-R5 não perde operações e usa recuperação por delta', () => {
  const result = runSimulation();
  assert.equal(result.scenarios.R1.lost, 0);
  assert.equal(result.scenarios.R2.conflicts, 1);
  assert.equal(result.scenarios.R3.users, 20);
  assert.equal(result.scenarios.R4.lost, 0);
  assert.equal(result.scenarios.R4.recovered_events, 50);
  assert.equal(result.scenarios.R5.snapshot_required, false);
});

test('runtime Rust/Wasm com índice de intervalos usa ABI 5', () => assert.equal(ABI_VERSION, 5));
