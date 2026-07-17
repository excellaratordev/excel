'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function loadRuntime() {
  global.window = global;
  for (const file of [
    'formula-parser.js',
    'dependency-graph.js',
    'function-library.js',
    'formula-runtime.js',
    'logical-library.js',
  ]) {
    require(path.join(__dirname, '../static/js/calculation', file));
  }
  return global.SuperExcelFormulaEngine;
}

const PROFILES = {
  ci: { formulas: 600, vector: 1200, switchCases: 80, repetitions: 3 },
  standard: { formulas: 5000, vector: 10000, switchCases: 300, repetitions: 5 },
  official: { formulas: 30000, vector: 100000, switchCases: 1000, repetitions: 5 },
};

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil((percentileValue / 100) * ordered.length) - 1));
  return ordered[index] || 0;
}

function measure(setup, run, repetitions) {
  const samples = [];
  let detail = null;
  for (let index = 0; index < repetitions; index += 1) {
    const context = setup();
    const started = performance.now();
    detail = run(context);
    samples.push(performance.now() - started);
    context?.engine?.destroy?.();
  }
  return {
    samples_ms: samples,
    average_ms: samples.reduce((total, value) => total + value, 0) / samples.length,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    detail,
  };
}

function benchmarkLazyIf(engineApi, size, repetitions) {
  return measure(
    () => ({ engine: engineApi.create(Array.from({ length: size }, () => ['=SE(FALSO();1/0;1)'])) }),
    ({ engine }) => {
      let total = 0;
      for (let row = 0; row < size; row += 1) total += engine.getCellValue({ row, col: 0 });
      if (total !== size) throw new Error(`L1 incorreto: ${total}`);
      return { formulas: size, total, stats: engine.getStats() };
    },
    repetitions,
  );
}

function benchmarkShortCircuit(engineApi, size, repetitions) {
  const matrix = Array.from({ length: size }, (_, row) => [
    row % 2 === 0 ? '=E(FALSO();1/0>0)' : '=OU(VERDADEIRO();1/0>0)',
  ]);
  return measure(
    () => ({ engine: engineApi.create(matrix) }),
    ({ engine }) => {
      let falseCount = 0;
      let trueCount = 0;
      for (let row = 0; row < size; row += 1) {
        if (engine.getCellValue({ row, col: 0 })) trueCount += 1;
        else falseCount += 1;
      }
      if (falseCount + trueCount !== size) throw new Error('L2 perdeu resultados.');
      return { formulas: size, falseCount, trueCount, stats: engine.getStats() };
    },
    repetitions,
  );
}

function benchmarkVectorIf(engineApi, size, repetitions) {
  const threshold = Math.floor(size / 2);
  const matrix = Array.from({ length: size }, (_, row) => [row + 1]);
  matrix[0][1] = `=SE(A1:A${size}>${threshold};1;0)`;
  return measure(
    () => ({ engine: engineApi.create(matrix) }),
    ({ engine }) => {
      const first = engine.getCellValue({ row: 0, col: 1 });
      const last = engine.getCellValue({ row: size - 1, col: 1 });
      if (first !== 0 || last !== 1) throw new Error(`L3 incorreto: ${first}/${last}`);
      return { values: size, threshold, stats: engine.getStats() };
    },
    repetitions,
  );
}

function switchFormula(caseCount, target) {
  const pairs = [];
  for (let index = 0; index < caseCount; index += 1) pairs.push(String(index), String(index * 10));
  return `=PARÂMETRO(${target};${pairs.join(';')};-1)`;
}

function benchmarkSwitch(engineApi, caseCount, repetitions) {
  const target = caseCount - 1;
  return measure(
    () => ({ engine: engineApi.create([[switchFormula(caseCount, target)]]) }),
    ({ engine }) => {
      const result = engine.getCellValue({ row: 0, col: 0 });
      if (result !== target * 10) throw new Error(`L4 incorreto: ${result}`);
      return { cases: caseCount, result, stats: engine.getStats() };
    },
    repetitions,
  );
}

function benchmarkErrorRouting(engineApi, size, repetitions) {
  const matrix = Array.from({ length: size }, (_, row) => [
    row % 2 === 0 ? '=SENÃODISP(NÃO.DISP();0)' : '=SEERRO(1/0;0)',
  ]);
  return measure(
    () => ({ engine: engineApi.create(matrix) }),
    ({ engine }) => {
      let total = 0;
      for (let row = 0; row < size; row += 1) total += engine.getCellValue({ row, col: 0 });
      if (total !== 0) throw new Error(`L5 incorreto: ${total}`);
      return { formulas: size, total, stats: engine.getStats() };
    },
    repetitions,
  );
}

function parseArguments(argv) {
  const result = { profile: 'ci', output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') result.profile = argv[++index] || result.profile;
    else if (argv[index] === '--output') result.output = argv[++index] || null;
  }
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const profile = PROFILES[args.profile];
  if (!profile) throw new Error(`Perfil lógico desconhecido: ${args.profile}`);
  const engineApi = loadRuntime();
  const output = {
    generated_at: new Date().toISOString(),
    profile: args.profile,
    engine: engineApi.engineName,
    logical_engine_version: global.SuperExcelLogicalLibrary?.version || null,
    scenarios: {
      L1_lazy_if: benchmarkLazyIf(engineApi, profile.formulas, profile.repetitions),
      L2_short_circuit: benchmarkShortCircuit(engineApi, profile.formulas, profile.repetitions),
      L3_vector_if: benchmarkVectorIf(engineApi, profile.vector, profile.repetitions),
      L4_switch: benchmarkSwitch(engineApi, profile.switchCases, profile.repetitions),
      L5_error_routing: benchmarkErrorRouting(engineApi, profile.formulas, profile.repetitions),
    },
  };

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, serialized);
  }
  process.stdout.write(serialized);
}

main();
