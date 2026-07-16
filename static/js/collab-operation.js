(() => {
  'use strict';

  const DEVICE_KEY = 'superexcel-device-id-v1';
  const TAB_KEY = 'superexcel-tab-id-v1';
  const SEQUENCE_KEY = 'superexcel-client-sequence-v1';
  const MAX_SEEN = 20000;
  const seen = new Map();

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function storedId(storage, key) {
    let value = storage.getItem(key);
    if (!value) {
      value = uuid();
      storage.setItem(key, value);
    }
    return value;
  }

  const deviceId = storedId(localStorage, DEVICE_KEY);
  const tabId = storedId(sessionStorage, TAB_KEY);
  const clientId = `${deviceId}:${tabId}`;

  function nextSequence() {
    const current = Number.parseInt(sessionStorage.getItem(SEQUENCE_KEY) || '0', 10);
    const next = Number.isFinite(current) ? current + 1 : 1;
    sessionStorage.setItem(SEQUENCE_KEY, String(next));
    return next;
  }

  function normalizeChanges(changes) {
    const deduplicated = new Map();
    for (const item of Array.isArray(changes) ? changes : []) {
      const row = Number(item?.row);
      const col = Number(item?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      deduplicated.set(`${row}:${col}`, { row, col, value: item.value ?? null });
    }
    return [...deduplicated.values()];
  }

  function create({ workbookId, knownRevision = 0, changes = [], kind = 'cells.patch', name = null }) {
    const operation = {
      version: 1,
      op_id: uuid(),
      workbook_id: Number(workbookId),
      client_id: clientId,
      client_seq: nextSequence(),
      known_revision: Math.max(0, Number(knownRevision) || 0),
      kind: String(kind || 'cells.patch').slice(0, 80),
      changes: normalizeChanges(changes),
      created_at: Date.now(),
    };
    const normalizedName = String(name || '').trim();
    if (normalizedName) operation.name = normalizedName.slice(0, 120);
    return operation;
  }

  function validate(operation, workbookId) {
    if (!operation || typeof operation !== 'object') return false;
    const operationId = String(operation.op_id || '');
    if (operationId.length < 8 || operationId.length > 160) return false;
    if (Number(operation.workbook_id) !== Number(workbookId)) return false;
    if (!Array.isArray(operation.changes)) return false;
    return operation.changes.every(change => {
      const row = Number(change?.row);
      const col = Number(change?.col);
      return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0;
    });
  }

  function markSeen(opId) {
    const key = String(opId || '');
    if (!key) return;
    seen.delete(key);
    seen.set(key, Date.now());
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
  }

  function hasSeen(opId) {
    return seen.has(String(opId || ''));
  }

  function fromServerEvent(event, workbookId) {
    return {
      version: 1,
      op_id: event.op_id || `revision:${workbookId}:${event.revision}`,
      workbook_id: Number(workbookId),
      client_id: event.client_id || 'server-legacy',
      client_seq: event.client_seq ?? null,
      known_revision: event.known_revision ?? null,
      kind: event.kind || 'legacy.patch',
      changes: normalizeChanges(event.changes),
      name: event.name || null,
      created_at: event.created_at || null,
      server_revision: Number(event.revision || 0),
      user_email: event.user_email || null,
    };
  }

  window.SuperExcelOperations = Object.freeze({
    clientId,
    create,
    validate,
    normalizeChanges,
    markSeen,
    hasSeen,
    fromServerEvent,
  });
})();