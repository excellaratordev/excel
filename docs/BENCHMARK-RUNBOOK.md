# Benchmark runbook

## Calculation scenarios C1–C5

Run the reduced CI profile:

```bash
node benchmarks/calculation-benchmarks.js --profile ci --output artifacts/calculation-benchmarks.json
```

Run the official sizes from `BENCHMARK.md`:

```bash
node benchmarks/calculation-benchmarks.js --profile official --output artifacts/calculation-benchmarks.json
```

The official profile executes:

- C1: 100,000 cells in a linear dependency chain;
- C2: 10,000 independent dependents;
- C3: one million columnar records filtered by period, status and owner;
- C4: five indicators sharing one cached filter;
- C5: one changed record updating a one-million-row aggregate by delta.

Each result contains all samples, average, p50, p95 and p99. CI uses smaller C1/C2 sizes to protect pull-request duration while still validating the same code paths.

## Collaboration scenarios R1–R5

```bash
node benchmarks/collaboration-simulator.js --output artifacts/collaboration-simulation.json
```

The simulator validates idempotency, deterministic conflict resolution, twenty concurrent users, a five-minute offline queue and revision-gap recovery using deltas instead of a complete snapshot.
