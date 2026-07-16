(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const app = window.SuperExcelApp;
  const meta = window.SuperExcelInitialMeta || {};
  const operations = window.SuperExcelOperations;
  const operationStore = window.SuperExcelOperationStore;
  const saveButton = document.querySelector('#save-button');
  const undoButton = document.querySelector('#undo-button');
  const redoButton = document.querySelector('#redo-button');
  const nameInput = document.querySelector('#workbook-name');
  const formulaInput = document.querySelector('#formula-input');
  const grid = document.querySelector('#spreadsheet');
  const status = document.querySelector('#status-message');
  const collaborationState = document.querySelector('#collaboration-state');
  const collaborationDetail = document.querySelector('#collaboration-detail');
  const collaborationSummary = document.querySelector('.collaboration-summary');
  const collaborators = document.querySelector('#collaborators');

  if (!app || !operations || !operationStore) return;

  let revision = Number(meta.revision || 0);
  let role = meta.role || 'viewer';
  let projectId = meta.project_id || null;
  const realtimeTopic = meta.realtime_topic || `workbook:${workbookId}`;
  let realtimeChannel = null;
  let realtimeConnected = false;
  let broadcastChannel = null;
  let persistTimer = null;
  let persistRunning = false;
  let pollTimer = null;
  let onlineCount = 1;
  let lastRemoteActivity = 0;
  let targetRevision = revision;
  const deferredOperations = new Map();
  const pendingOperationCells = new Map();
  const operationCells = new Map();

  function currentUser() {
    return window.SuperExcelAuth.session?.user || {};
  }

  function currentEmail() {
    return currentUser().email?.toLowerCase() || '';
  }

  function setCollaboration(text, detail = '', stateClass = '') {
    collaborationState.textContent = text;
    if (detail) collaborationDetail.textContent = detail;
    collaborationSummary.classList.remove('is-saving', 'is-error', 'is-synced');
    if (stateClass) collaborationSummary.classList.add(stateClass);
  }

  function cellKey(change) {
    return `${Number(change.row)}:${Number(change.col)}`;
  }

  function editingCell() {
    const element = grid.querySelector('.cell.editing');
    if (!element) return null;
    return { row: Number(element.dataset.row), col: Number(element.dataset.col) };
  }

  function trackPending(operation) {
    const keys = [];
    for (const change of operation.changes || []) {
      const key = cellKey(change);
      keys.push(key);
      pendingOperationCells.set(key, operation.op_id);
    }
    operationCells.set(operation.op_id, keys);
  }

  function untrackPending(opIds) {
    for (const opId of opIds) {
      const keys = operationCells.get(opId) || [];
      for (const key of keys) {
        if (pendingOperationCells.get(key) === opId) pendingOperationCells.delete(key);
      }
      operationCells.delete(opId);
    }
  }

  function renderPresence(list) {
    collaborators.innerHTML = '';
    const unique = new Map();
    for (const person of Array.isArray(list) ? list : []) {
      const key = String(person.user_email || person.user_id || person.client_id || Math.random()).toLowerCase();
      if (!unique.has(key)) unique.set(key, person);
    }
    const people = [...unique.values()];
    onlineCount = Math.max(1, people.length);
    for (const person of people.slice(0, 4)) {
      const name = person.user_name || person.user_email || 'Usuário';
      let element;
      if (person.avatar_url) {
        element = document.createElement('img');
        element.className = 'collaborator-avatar';
        element.src = person.avatar_url;
        element.alt = name;
      } else {
        element = document.createElement('span');
        element.className = 'collaborator-fallback';
        element.textContent = name.slice(0, 1).toUpperCase();
      }
      element.title = `${name}${person.user_email ? ` — ${person.user_email}` : ''}`;
      collaborators.append(element);
    }
    if (people.length > 4) {
      const more = document.createElement('span');
      more.className = 'collaborator-fallback collaborator-more';
      more.textContent = `+${people.length - 4}`;
      collaborators.append(more);
    }
    collaborationDetail.textContent = `${onlineCount} pessoa(s) online`;
  }

  function enableReadOnly() {
    document.body.classList.add('sheet-readonly');
    nameInput.disabled = true;
    formulaInput.disabled = true;
    saveButton.disabled = true;
    ['#new-button', '#clear-button', '#example-button', '#import-input', '#undo-button', '#redo-button'].forEach(selector => {
      const element = document.querySelector(selector);
      if (element) element.disabled = true;
    });
    const blocker = event => {
      if (event.type === 'keydown') {
        const editingKey = event.key === 'Delete' || event.key === 'Backspace' || event.key === 'F2'
          || (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1);
        if (!editingKey) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      status.textContent = 'Acesso somente para visualização';
    };
    grid.addEventListener('dblclick', blocker, true);
    grid.addEventListener('keydown', blocker, true);
    grid.addEventListener('paste', blocker, true);
    formulaInput.addEventListener('input', blocker, true);
    const banner = document.createElement('div');
    banner.className = 'viewer-banner';
    banner.textContent = 'Você está neste projeto como visualizador.';
    document.body.append(banner);
  }

  function kindFromReason(reason) {
    const normalized = String(reason || 'edit').replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase();
    return `cells.${normalized}`.slice(0, 80);
  }

  function sendFast(operation) {
    try {
      broadcastChannel?.postMessage(operation);
    } catch (error) {
      console.warn('Falha no canal entre abas.', error);
    }
    if (realtimeConnected && realtimeChannel) {
      realtimeChannel.send({ type: 'broadcast', event: 'operation', payload: operation }).catch(error => {
        console.warn('Falha no canal rápido remoto.', error);
      });
    }
  }

  async function enqueueLocalOperation(changes, reason, name) {
    if (role === 'viewer' || !workbookId) return;
    const operation = operations.create({
      workbookId,
      knownRevision: revision,
      changes,
      kind: kindFromReason(reason),
      name,
    });
    operations.markSeen(operation.op_id);
    trackPending(operation);
    sendFast(operation);
    await operationStore.put(operation);
    schedulePersist(operation.changes.length > 1500 ? 20 : 140);
    setCollaboration('Alteração enviada', 'Confirmando no servidor', 'is-saving');
  }

  async function enqueueNameOperation(name) {
    if (role === 'viewer' || !workbookId) return;
    const operation = operations.create({
      workbookId,
      knownRevision: revision,
      changes: [],
      kind: 'workbook.rename',
      name,
    });
    operations.markSeen(operation.op_id);
    sendFast(operation);
    await operationStore.put(operation);
    schedulePersist(250);
  }

  function schedulePersist(delay = 140) {
    if (role === 'viewer') return;
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => flushOutbox().catch(handleError), delay);
  }

  async function flushOutbox(options = {}) {
    if (!workbookId || role === 'viewer' || persistRunning || !navigator.onLine) return;
    const batch = await operationStore.list(workbookId, 50);
    if (!batch.length) {
      setCollaboration(realtimeConnected ? 'Ao vivo' : 'Sincronizado', `Revisão ${revision}`, 'is-synced');
      return;
    }

    persistRunning = true;
    clearTimeout(persistTimer);
    setCollaboration('Salvando...', `${batch.length} operação(ões)`, 'is-saving');
    try {
      const response = await fetch(`/api/workbooks/${workbookId}/operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: batch }),
        keepalive: Boolean(options.keepalive),
      });
      const output = await response.json();
      if (!response.ok) throw new Error(output.error || 'Erro ao persistir operações.');

      const confirmedIds = (output.results || []).map(item => String(item.op_id || '')).filter(Boolean);
      await operationStore.remove(confirmedIds);
      untrackPending(confirmedIds);
      targetRevision = Math.max(targetRevision, Number(output.current_revision || revision));
      status.classList.remove('error');
      status.textContent = `Operações confirmadas; sincronizando revisão ${targetRevision}...`;
    } finally {
      persistRunning = false;
    }

    await checkRemote();
    if (await operationStore.count(workbookId)) schedulePersist(30);
  }

  function applyOperation(operation, options = {}) {
    if (!operations.validate(operation, workbookId)) return;
    const active = editingCell();
    const immediate = [];
    const deferred = [];

    for (const change of operation.changes || []) {
      const conflictsWithCurrentEdit = active && active.row === Number(change.row) && active.col === Number(change.col);
      if (conflictsWithCurrentEdit) deferred.push(change);
      else immediate.push(change);
    }

    let applicable = immediate;
    if (options.authoritative) {
      applicable = immediate.filter(change => {
        const pendingOpId = pendingOperationCells.get(cellKey(change));
        return !pendingOpId || pendingOpId === operation.op_id;
      });
    }

    if (applicable.length || operation.name) {
      app.applyRemoteChanges(applicable, { name: operation.name || undefined });
    }
    if (deferred.length) {
      deferredOperations.set(operation.op_id, { ...operation, changes: deferred, authoritative: Boolean(options.authoritative) });
    }
  }

  function receiveFastOperation(operation, source = 'fast') {
    if (!operations.validate(operation, workbookId)) return;
    if (operations.hasSeen(operation.op_id)) return;
    operations.markSeen(operation.op_id);
    applyOperation(operation, { authoritative: false });
    lastRemoteActivity = Date.now();
    const author = operation.user_email || operation.client_id;
    status.textContent = `Alteração recebida${author ? ` de ${author}` : ''} (${source})`;
  }

  async function applyServerEvent(event) {
    const eventRevision = Number(event.revision || 0);
    if (eventRevision <= revision) return;
    if (eventRevision !== revision + 1) {
      await fetchSnapshotWithPending();
      return;
    }

    const operation = operations.fromServerEvent(event, workbookId);
    operations.markSeen(operation.op_id);
    applyOperation(operation, { authoritative: true });
    revision = eventRevision;
    targetRevision = Math.max(targetRevision, revision);
    if (event.user_email && event.user_email !== currentEmail()) {
      lastRemoteActivity = Date.now();
      status.textContent = `Alterado por ${event.user_email}`;
    }
  }

  async function replayPendingOperations() {
    if (role === 'viewer') return;
    const pending = await operationStore.list(workbookId, 1000);
    for (const operation of pending) {
      operations.markSeen(operation.op_id);
      trackPending(operation);
      app.applyRemoteChanges(operation.changes || [], { name: operation.name || undefined });
      sendFast(operation);
    }
    if (pending.length) schedulePersist(20);
  }

  async function fetchSnapshotWithPending() {
    const response = await fetch(`/api/workbooks/${workbookId}`);
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao atualizar planilha.');
    app.replaceSnapshot({ ...(output.data || {}), name: output.name || output.data?.name });
    revision = Number(output.revision || revision);
    targetRevision = revision;
    role = output.role || role;
    projectId = output.project_id || projectId;

    if (role !== 'viewer') {
      const pending = await operationStore.list(workbookId, 1000);
      for (const operation of pending) app.applyRemoteChanges(operation.changes || [], { name: operation.name || undefined });
    }
  }

  async function applyRemotePayload(output) {
    if (!output) return;
    if (output.mode === 'snapshot') {
      await fetchSnapshotWithPending();
      return;
    }
    for (const event of Array.isArray(output.events) ? output.events : []) await applyServerEvent(event);
    targetRevision = Math.max(targetRevision, Number(output.revision || revision));
    if (revision >= targetRevision) setCollaboration(realtimeConnected ? 'Ao vivo' : 'Sincronizado', `Revisão ${revision}`, 'is-synced');
  }

  async function checkRemote() {
    if (!workbookId || !navigator.onLine) return;
    const response = await fetch(`/api/workbooks/${workbookId}/changes?after_revision=${revision}`);
    if (response.status === 204) {
      if (revision >= targetRevision) setCollaboration(realtimeConnected ? 'Ao vivo' : 'Sincronizado', `Revisão ${revision}`, 'is-synced');
      return;
    }
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao verificar alterações externas.');
    await applyRemotePayload(output);
  }

  function drainDeferredOperations() {
    const active = editingCell();
    for (const [opId, operation] of deferredOperations) {
      const stillBlocked = active && operation.changes.some(change => active.row === Number(change.row) && active.col === Number(change.col));
      if (stillBlocked) continue;
      deferredOperations.delete(opId);
      const changes = operation.authoritative
        ? operation.changes.filter(change => {
          const pendingOpId = pendingOperationCells.get(cellKey(change));
          return !pendingOpId || pendingOpId === operation.op_id;
        })
        : operation.changes;
      app.applyRemoteChanges(changes, { name: operation.name || undefined });
    }
  }

  function nextPollDelay() {
    if (realtimeConnected) return document.hidden ? 30000 : 7000;
    if (document.hidden) return 6000;
    if (onlineCount > 1 || Date.now() - lastRemoteActivity < 12000) return 700;
    return 1600;
  }

  async function pollLoop() {
    clearTimeout(pollTimer);
    try {
      await checkRemote();
    } catch (error) {
      handleError(error);
    } finally {
      pollTimer = window.setTimeout(pollLoop, nextPollDelay());
    }
  }

  function presencePayloads() {
    if (!realtimeChannel) return [];
    const state = realtimeChannel.presenceState() || {};
    return Object.values(state).flatMap(value => Array.isArray(value) ? value : []);
  }

  async function setupRealtime() {
    const client = window.SuperExcelAuth.client;
    const user = currentUser();
    if (!client || !workbookId || !user.id) return;
    const metadata = user.user_metadata || {};
    const tabId = operations.clientId.split(':').at(-1);

    realtimeChannel = client
      .channel(realtimeTopic, {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: `${user.id}:${tabId}` },
        },
      })
      .on('broadcast', { event: 'operation' }, message => receiveFastOperation(message.payload, 'tempo real'))
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'workbook_changes', filter: `workbook_id=eq.${workbookId}` },
        payload => {
          const record = payload.new || {};
          const event = {
            revision: record.revision,
            op_id: record.op_id,
            client_id: record.client_id,
            client_seq: record.client_seq,
            known_revision: record.known_revision,
            kind: record.operation_kind,
            user_email: record.user_email,
            changes: record.changes,
            name: record.workbook_name,
            created_at: record.created_at,
          };
          applyServerEvent(event).catch(handleError);
        },
      )
      .on('presence', { event: 'sync' }, () => renderPresence(presencePayloads()))
      .subscribe(async connectionStatus => {
        if (connectionStatus === 'SUBSCRIBED') {
          realtimeConnected = true;
          await realtimeChannel.track({
            user_id: user.id,
            user_email: user.email || '',
            user_name: metadata.full_name || metadata.name || user.email || 'Usuário',
            avatar_url: metadata.avatar_url || metadata.picture || '',
            client_id: operations.clientId,
            online_at: new Date().toISOString(),
          });
          setCollaboration('Ao vivo', `${onlineCount} pessoa(s) online`, 'is-synced');
          checkRemote().catch(handleError);
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(connectionStatus)) {
          realtimeConnected = false;
          setCollaboration('Reconectando...', 'Usando sincronização de segurança', 'is-saving');
        }
      });
  }

  function setupBroadcastChannel() {
    if (!('BroadcastChannel' in window)) return;
    broadcastChannel = new BroadcastChannel(`superexcel:${realtimeTopic}`);
    broadcastChannel.onmessage = event => receiveFastOperation(event.data, 'outra aba');
  }

  function handleError(error) {
    console.error(error);
    setCollaboration('Falha ao sincronizar', error.message, 'is-error');
    status.textContent = error.message;
    status.classList.add('error');
  }

  window.addEventListener('superexcel:changes', event => {
    enqueueLocalOperation(event.detail?.changes || [], event.detail?.reason, event.detail?.name).catch(handleError);
  });
  window.addEventListener('superexcel:name', event => {
    enqueueNameOperation(event.detail?.name || nameInput.value.trim() || 'Minha Planilha').catch(handleError);
  });

  saveButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    flushOutbox().catch(handleError);
  }, true);

  document.addEventListener('keydown', event => {
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) redoButton?.click();
      else undoButton?.click();
    } else if (key === 'y') {
      event.preventDefault();
      event.stopImmediatePropagation();
      redoButton?.click();
    } else if (key === 's') {
      event.preventDefault();
      event.stopImmediatePropagation();
      flushOutbox().catch(handleError);
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      flushOutbox().catch(handleError);
      checkRemote().catch(handleError);
    }
  });

  window.addEventListener('online', () => {
    setCollaboration('Reconectando...', 'Enviando operações pendentes', 'is-saving');
    flushOutbox().catch(handleError);
    checkRemote().catch(handleError);
  });

  window.addEventListener('offline', () => {
    realtimeConnected = false;
    setCollaboration('Sem conexão', 'Operações protegidas no navegador', 'is-error');
  });

  window.addEventListener('pagehide', () => {
    app.flushLocal();
    flushOutbox({ keepalive: true }).catch(() => {});
    broadcastChannel?.close();
    if (realtimeChannel) {
      realtimeChannel.untrack().catch(() => {});
      window.SuperExcelAuth.client?.removeChannel(realtimeChannel).catch(() => {});
    }
  });

  async function initialize() {
    await window.SuperExcelAuth.ready;
    await operationStore.ready;
    if (role === 'viewer') enableReadOnly();
    setupBroadcastChannel();
    await replayPendingOperations();
    document.body.classList.remove('sheet-loading');
    setCollaboration('Conectando ao vivo...', `Revisão ${revision}`, 'is-saving');
    if (workbookId) {
      await setupRealtime();
      pollLoop();
      window.setInterval(drainDeferredOperations, 50);
    }
  }

  initialize().catch(error => {
    handleError(error);
    document.body.classList.remove('sheet-loading');
  });
})();