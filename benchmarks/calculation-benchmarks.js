'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { filterSum, SharedFilterCache, IncrementalSum } = require('../static/js/calculation/enterprise-kernel.js');

function loadRuntime() {
  global.window = global;
  for (const file of ['formula-parser.js', 'dependency-graph.js', 'function-library.js', 'formula-runtime.js']) {
    require(path.join(__dirname, '../static/js/calculation', file));
  }
  return global.SuperExcelFormulaEngine;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((p / 100) * ordered.length) - 1));
  return ordered[index];
}

function measure(run, repetitions = 5) {
  const samples = [];
  let detail;
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    detail = run();
    samples.push(performance.now() - started);
  }
  return {
    samples_ms: samples,
    average_ms: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    detail,
  };
}

const PROFILES = {
  ci: { c1: 800, c2: 750, c3: 100000, c5: 100000, repetitions: 3 },
  standard: { c1: 5000, c2: 5000, c3: 1000000, c5: 1000000, repetitions: 5 },
  official: { c1: 100000, c2: 10000, c3: 1000000, c5: 1000000, repetitions: 5 },
};

function scenarioC1(engineApi, size) {
  const matrix = Array.from({ length: size }, (_, row) => [row === 0 ? 1 : `=A${row}+1`]);
  const engine = engineApi.create(matrix);
  const before = engine.getCellValue({ row: size - 1, col: 0 });
  engine.consumeAffectedCells();
  engine.setCellContents({ row: 0, col: 0 }, [[2]]);
  const after = engine.getCellValue({ row: size - 1, col: 0 });
  const affected = engine.consumeAffectedCells().length;
  engine.destroy();
  if (before !== size || after !== size + 1) throw new Error(`C1 incorreto: ${before} -> ${after}`);
  return { cells: size, affected, result: after };
}

function scenarioC2(engineApi, dependents) {
  const matrix = [[1]];
  for (let row = 1; row <= dependents; row += 1) matrix.push([`=A1+${row}`]);
  const engine = engineApi.create(matrix);
  for (let row = 1; row <= dependents; row += 1) engine.getCellValue({ row, col: 0 });
  engine.consumeAffectedCells();
  engine.setCellContents({ row: 0, col: 0 }, [[10]]);
  const last = engine.getCellValue({ row: dependents, col: 0 });
  const affected = engine.consumeAffectedCells().length;
  engine.destroy();
  if (last !== dependents + 10) throw new Error(`C2 incorreto: ${last}`);
  return { dependents, affected, result: last };
}

function createEnterpriseColumns(size) {
  const period = new Uint16Array(size);
  const status = new Uint8Array(size);
  const owner = new Uint16Array(size);
  const amount = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    period[index] = index % 24;
    status[index] = index % 3;
    owner[index] = index % 97;
    amount[index] = (index % 1000) / 10;
  }
  return { period, status, owner, amount };
}

function scenarioC3(size) {
  const columns = createEnterpriseColumns(size);
  const result = filterSum(columns, (source, index) => (
    source.period[index] >= 12 && source.status[index] === 1 && source.owner[index] === 7
  ), 'amount');
  if (!Number.isFinite(result.total) || result.scanned !== size) throw new Error('C3 produziu resultado inválido.');
  return { records: size, matched: result.matched, total: result.total };
}

function scenarioC4(size) {
  const columns = createEnterpriseColumns(size);
  const cache = new SharedFilterCache();
  const key = 'period>=12|status=1';
  const factory = () => {
    const indexes = [];
    for (let index = 0; index < size; index += 1) {
      if (columns.period[index] >= 12 && columns.status[index] === 1) indexes.push(index);
    }
    return indexes;
  };
  const indicators = Array.from({ length: 5 }, () => cache.get(key, factory).length);
  if (cache.executions !== 1 || new Set(indicators).size !== 1) throw new Error('C4 não reutilizou o filtro compartilhado.');
  return { records: size, indicators: indicators.length, filter_executions: cache.executions, matched: indicators[0] };
}

function scenarioC5(size) {
  const values = new Float64Array(size);
  values.fill(1);
  const aggregate = new IncrementalSum(values);
  const result = aggregate.update(Math.floor(size / 2), 10);
  if (result.total !== size + 9 || result.delta !== 9) throw new Error('C5 não aplicou cálculo por diferença.');
  return { records: size, delta: result.delta, total: result.total };
}

function runBenchmarks(profileName = 'standard') {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Perfil desconhecido: ${profileName}`);
  const engineApi = loadRuntime();
  const results = {
    generated_at: new Date().toISOString(),
    profile: profileName,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    scenarios: {},
  };
  results.scenarios.C1 = measure(() => scenarioC1(engineApi, profile.c1), profile.repetitions);
  results.scenarios.C2 = measure(() => scenarioC2(engineApi, profile.c2), profile.repetitions);
  results.scenarios.C3 = measure(() => scenarioC3(profile.c3), profile.repetitions);
  results.scenarios.C4 = measure(() => scenarioC4(profile.c3), profile.repetitions);
  results.scenarios.C5 = measure(() => scenarioC5(profile.c5), profile.repetitions);
  return results;
}

function parseArguments(argv) {
  const args = { profile: process.env.BENCHMARK_PROFILE || 'standard', output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') args.profile = argv[index + 1];
    if (argv[index] === '--output') args.output = argv[index + 1];
  }
  return args;
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2));
  const results = runBenchmarks(args.profile);
  const serialized = `${JSON.stringify(results, null, 2)}\n`;
  if (args.output) {
    const destination = path.resolve(args.output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, serialized);
  }
  process.stdout.write(serialized);
}

module.exports = { PROFILES, percentile, measure, runBenchmarks, scenarioC3, scenarioC4, scenarioC5 };
