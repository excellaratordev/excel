'use strict';

const fs = require('node:fs');
const path = require('node:path');

class DeterministicRandom {
  constructor(seed = 123456789) { this.state = seed >>> 0; }
  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

class CollaborationServer {
  constructor() {
    this.revision = 0;
    this.cells = new Map();
    this.operations = [];
    this.operationIds = new Set();
    this.conflicts = [];
  }

  apply(operation, receivedAt) {
    if (this.operationIds.has(operation.id)) return { duplicate: true, revision: this.revision };
    const previous = this.cells.get(operation.cell);
    this.revision += 1;
    const event = { ...operation, revision: this.revision, receivedAt };
    if (previous && operation.knownRevision < previous.revision && previous.clientId !== operation.clientId) {
      this.conflicts.push({ cell: operation.cell, previous, incoming: event, resolution: 'last-server-revision-wins' });
    }
    this.cells.set(operation.cell, { value: operation.value, revision: this.revision, clientId: operation.clientId });
    this.operations.push(event);
    this.operationIds.add(operation.id);
    return { duplicate: false, revision: this.revision, event };
  }

  deltas(afterRevision) { return this.operations.filter(operation => operation.revision > afterRevision); }
}

class CollaborationClient {
  constructor(id, server) {
    this.id = id;
    this.server = server;
    this.seq = 0;
    this.knownRevision = 0;
    this.local = new Map();
    this.queue = [];
    this.online = true;
    this.receivedIds = new Set();
  }

  edit(cell, value, at = 0) {
    this.seq += 1;
    const operation = {
      id: `${this.id}:${this.seq}`,
      clientId: this.id,
      clientSeq: this.seq,
      knownRevision: this.knownRevision,
      cell,
      value,
      createdAt: at,
    };
    this.local.set(cell, value);
    this.queue.push(operation);
    return operation;
  }

  flush(receivedAt = 0) {
    if (!this.online) return [];
    const acknowledgements = [];
    while (this.queue.length) {
      const operation = this.queue.shift();
      const result = this.server.apply(operation, receivedAt);
      this.knownRevision = Math.max(this.knownRevision, result.revision);
      acknowledgements.push({ operation, result });
    }
    return acknowledgements;
  }

  receive(events) {
    for (const event of events) {
      if (this.receivedIds.has(event.id)) continue;
      this.receivedIds.add(event.id);
      this.local.set(event.cell, event.value);
      this.knownRevision = Math.max(this.knownRevision, event.revision);
    }
  }

  reconcileDelta() {
    const events = this.server.deltas(this.knownRevision);
    this.receive(events);
    return events;
  }
}

function scenarioR1() {
  const server = new CollaborationServer();
  const clients = [new CollaborationClient('A', server), new CollaborationClient('B', server)];
  for (let index = 0; index < 300; index += 1) {
    clients[0].edit(`A${index + 1}`, index, index);
    clients[1].edit(`B${index + 1}`, index * 2, index);
    clients[0].flush(index * 2);
    clients[1].flush(index * 2 + 1);
  }
  for (const client of clients) client.receive(server.deltas(0));
  if (server.operations.length !== 600 || server.operationIds.size !== 600) throw new Error('R1 perdeu ou duplicou operações.');
  return { operations: 600, lost: 0, duplicated: 0, final_revision: server.revision };
}

function scenarioR2() {
  const server = new CollaborationServer();
  const first = new CollaborationClient('A', server);
  const second = new CollaborationClient('B', server);
  first.edit('A1', 'primeiro', 1);
  second.edit('A1', 'segundo', 1);
  first.flush(10);
  second.flush(11);
  first.receive(server.deltas(0));
  second.receive(server.deltas(0));
  const finalValue = server.cells.get('A1')?.value;
  if (finalValue !== 'segundo' || server.conflicts.length !== 1) throw new Error('R2 não resolveu o conflito de forma auditável.');
  return { final_value: finalValue, conflicts: server.conflicts.length, rule: 'last-server-revision-wins' };
}

function scenarioR3() {
  const server = new CollaborationServer();
  const random = new DeterministicRandom(42);
  const clients = Array.from({ length: 20 }, (_, index) => new CollaborationClient(`U${index + 1}`, server));
  const latencies = [];
  const scheduled = [];
  for (const client of clients) {
    for (let index = 0; index < 100; index += 1) {
      const createdAt = index * 20;
      const operation = client.edit(`${client.id}:${index}`, index, createdAt);
      const latency = 20 + Math.floor(random.next() * 130);
      scheduled.push({ client, operation, receivedAt: createdAt + latency, latency });
    }
  }
  scheduled.sort((left, right) => left.receivedAt - right.receivedAt || left.operation.id.localeCompare(right.operation.id));
  for (const item of scheduled) {
    const queueIndex = item.client.queue.findIndex(operation => operation.id === item.operation.id);
    item.client.queue.splice(queueIndex, 1);
    const result = server.apply(item.operation, item.receivedAt);
    item.client.knownRevision = Math.max(item.client.knownRevision, result.revision);
    latencies.push(item.latency);
  }
  if (server.operations.length !== 2000) throw new Error('R3 perdeu operações.');
  return { users: 20, operations: 2000, p50_ms: percentile(latencies, 50), p95_ms: percentile(latencies, 95), p99_ms: percentile(latencies, 99) };
}

function scenarioR4() {
  const server = new CollaborationServer();
  const online = new CollaborationClient('online', server);
  const offline = new CollaborationClient('offline', server);
  offline.online = false;
  for (let index = 0; index < 50; index += 1) {
    offline.edit(`O${index}`, index, index * 6000);
    online.edit(`N${index}`, index, index * 6000);
    online.flush(index * 6000 + 50);
  }
  offline.online = true;
  const queued = offline.queue.length;
  const recovered = offline.reconcileDelta();
  offline.flush(300001);
  if (queued !== 50 || recovered.length !== 50 || server.operations.length !== 100 || offline.queue.length) {
    throw new Error('R4 falhou ao reconciliar fila offline.');
  }
  return { offline_minutes: 5, queued_operations: queued, recovered_events: recovered.length, lost: 0 };
}

function scenarioR5() {
  const server = new CollaborationServer();
  const producer = new CollaborationClient('producer', server);
  const consumer = new CollaborationClient('consumer', server);
  for (let index = 0; index < 100; index += 1) {
    producer.edit(`A${index + 1}`, index, index);
    producer.flush(index);
  }
  consumer.receive(server.operations.slice(0, 40));
  const before = consumer.knownRevision;
  const delta = consumer.reconcileDelta();
  if (before !== 40 || delta.length !== 60 || consumer.knownRevision !== 100) throw new Error('R5 não recuperou somente o delta necessário.');
  return { revision_before: before, delta_events: delta.length, snapshot_required: false, revision_after: consumer.knownRevision };
}

function runSimulation() {
  return {
    generated_at: new Date().toISOString(),
    scenarios: { R1: scenarioR1(), R2: scenarioR2(), R3: scenarioR3(), R4: scenarioR4(), R5: scenarioR5() },
  };
}

function parseArguments(argv) {
  const outputIndex = argv.indexOf('--output');
  return { output: outputIndex >= 0 ? argv[outputIndex + 1] : null };
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2));
  const serialized = `${JSON.stringify(runSimulation(), null, 2)}\n`;
  if (args.output) {
    const destination = path.resolve(args.output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, serialized);
  }
  process.stdout.write(serialized);
}

module.exports = { CollaborationServer, CollaborationClient, percentile, scenarioR1, scenarioR2, scenarioR3, scenarioR4, scenarioR5, runSimulation };
