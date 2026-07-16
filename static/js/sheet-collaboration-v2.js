(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const app = window.SuperExcelApp;
  const meta = window.SuperExcelInitialMeta || {};
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

  if (!app) return;

  let revision = Number(meta.revision || 0);
  let role = meta.role || 'viewer';
  let projectId = meta.project_id || null;
  let saving = false;
  let saveTimer = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let pendingRemote = null;
  let onlineCount = 1;
  let lastRemoteActivity = 0;
  let pendingName = null;
  const pendingChanges = new Map();

  function currentEmail() {
    return window.SuperExcelAuth.session?.user?.email?.toLowerCase() || '';
  }

  function cellKey(change) {
    return `${change.row}:${change.col}`;
  }

  function setCollaboration(text, detail = '', stateClass = '') {
    collaborationState.textContent = text;
    if (detail) collaborationDetail.textContent = detail;
    collaborationSummary.classList.remove('is-saving', 'is-error', 'is-synced');
    if (stateClass) collaborationSummary.classList.add(stateClass);
  }

  function renderPresence(list) {
    collaborators.innerHTML = '';
    const people = Array.isArray(list) ? list : [];
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

  function queueChanges(changes) {
    if (role === 'viewer') return;
    for (const change of changes || []) {
      const row = Number(change.row);
      const col = Number(change.col);
      if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
      pendingChanges.set(`${row}:${col}`, { row, col, value: change.value ?? null });
    }
    scheduleSave(pendingChanges.size > 1500 ? 50 : 320);
  }

  function scheduleSave(delay = 320) {
    if (role === 'viewer') return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => flushSave().catch(handleError), delay);
  }

  function restoreBatch(batch, name) {
    for (const change of batch) {
      const key = cellKey(change);
      if (!pendingChanges.has(key)) pendingChanges.set(key, change);
    }
    if (name && !pendingName) pendingName = name;
  }

  async function flushSave(options = {}) {
    if (!workbookId || role === 'viewer' || saving) return;
    if (!pendingChanges.size && !pendingName) return;

    clearTimeout(saveTimer);
    const batch = [...pendingChanges.values()];
    const name = pendingName;
    pendingChanges.clear();
    pendingName = null;
    const baseRevision = revision;
    let catchUpAfterSave = false;
    saving = true;
    setCollaboration('Salvando...', `${batch.length} célula(s)`, 'is-saving');

    try {
      const response = await fetch(`/api/workbooks/${workbookId}/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: batch, name, base_revision: revision }),
        keepalive: Boolean(options.keepalive),
      });
      const output = await response.json();
      if (!response.ok) throw new Error(output.error || 'Erro ao sincronizar alterações.');
      const confirmedRevision = Number(output.revision || baseRevision + 1);
      projectId = output.project_id || projectId;
      catchUpAfterSave = confirmedRevision > baseRevision;
      if (catchUpAfterSave) {
        setCollaboration('Confirmando...', `Revisão ${confirmedRevision}`, 'is-saving');
        status.textContent = 'Alterações enviadas; recebendo a versão consolidada...';
      } else {
        revision = confirmedRevision;
        setCollaboration('Sincronizado', `Revisão ${revision}`, 'is-synced');
        status.textContent = `Sincronizado — revisão ${revision}`;
      }
      status.classList.remove('error');
    } catch (error) {
      restoreBatch(batch, name);
      throw error;
    } finally {
      saving = false;
      if (catchUpAfterSave) window.setTimeout(() => checkRemote().catch(handleError), 0);
      if (pendingChanges.size || pendingName) scheduleSave(80);
    }
  }

  function handleError(error) {
    console.error(error);
    setCollaboration('Falha ao sincronizar', error.message, 'is-error');
    status.textContent = error.message;
    status.classList.add('error');
  }

  function userIsActivelyEditing() {
    return app.isEditing() || document.activeElement === formulaInput;
  }

  function filterRemoteChanges(changes) {
    return (changes || []).filter(change => !pendingChanges.has(cellKey(change)));
  }

  async function fetchSnapshot() {
    const response = await fetch(`/api/workbooks/${workbookId}`);
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao atualizar planilha.');
    app.replaceSnapshot({ ...(output.data || {}), name: output.name || output.data?.name });
    revision = Number(output.revision || revision);
    role = output.role || role;
    projectId = output.project_id || projectId;
  }

  async function applyRemotePayload(output) {
    if (!output) return;
    if (output.mode === 'snapshot') {
      app.replaceSnapshot({ ...(output.data || {}), name: output.name || output.data?.name });
      revision = Number(output.revision || revision);
      return;
    }

    const events = Array.isArray(output.events) ? output.events : [];
    for (const event of events) {
      const changes = filterRemoteChanges(event.changes);
      const result = app.applyRemoteChanges(changes, { name: event.name });
      if (result.requiresReload) {
        await fetchSnapshot();
        return;
      }
      revision = Math.max(revision, Number(event.revision || 0));
      if (event.user_email && event.user_email !== currentEmail()) {
        lastRemoteActivity = Date.now();
        status.textContent = `Alterado por ${event.user_email}`;
      }
    }
    revision = Math.max(revision, Number(output.revision || 0));
    if (events.length) setCollaboration('Sincronizado', `Revisão ${revision}`, 'is-synced');
  }

  async function checkRemote() {
    if (!workbookId || saving || !navigator.onLine) return;
    const response = await fetch(`/api/workbooks/${workbookId}/changes?after_revision=${revision}`);
    if (response.status === 204) return;
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao verificar alterações externas.');
    if (userIsActivelyEditing()) {
      pendingRemote = output;
      setCollaboration('Outra pessoa editou', 'Aplicando ao terminar a célula', 'is-saving');
      return;
    }
    await applyRemotePayload(output);
  }

  function nextPollDelay() {
    if (document.hidden) return 6000;
    if (onlineCount > 1 || Date.now() - lastRemoteActivity < 12000) return 700;
    return 1600;
  }

  async function pollLoop() {
    clearTimeout(pollTimer);
    try {
      if (pendingRemote && !userIsActivelyEditing()) {
        const output = pendingRemote;
        pendingRemote = null;
        await applyRemotePayload(output);
      } else {
        await checkRemote();
      }
    } catch (error) {
      handleError(error);
    } finally {
      pollTimer = window.setTimeout(pollLoop, nextPollDelay());
    }
  }

  async function heartbeat() {
    if (!workbookId || document.hidden || !navigator.onLine) return;
    const response = await fetch(`/api/workbooks/${workbookId}/presence`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao atualizar presença.');
    renderPresence(output.online || []);
  }

  function heartbeatLoop() {
    clearTimeout(heartbeatTimer);
    heartbeat().catch(console.error).finally(() => {
      heartbeatTimer = window.setTimeout(heartbeatLoop, document.hidden ? 30000 : 15000);
    });
  }

  window.addEventListener('superexcel:changes', event => queueChanges(event.detail?.changes));
  window.addEventListener('superexcel:name', event => {
    if (role === 'viewer') return;
    pendingName = event.detail?.name || nameInput.value.trim() || 'Minha Planilha';
    scheduleSave(500);
  });

  saveButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingName = nameInput.value.trim() || 'Minha Planilha';
    flushSave().catch(handleError);
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
      pendingName = nameInput.value.trim() || 'Minha Planilha';
      flushSave().catch(handleError);
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkRemote().catch(handleError);
      heartbeat().catch(console.error);
    }
  });

  window.addEventListener('online', () => {
    setCollaboration('Reconectando...', 'Enviando alterações pendentes', 'is-saving');
    flushSave().catch(handleError);
    checkRemote().catch(handleError);
  });

  window.addEventListener('offline', () => {
    setCollaboration('Sem conexão', 'As alterações ficarão no navegador', 'is-error');
  });

  window.addEventListener('pagehide', () => {
    app.flushLocal();
    if (pendingChanges.size || pendingName) flushSave({ keepalive: true }).catch(() => {});
    if (workbookId) fetch(`/api/workbooks/${workbookId}/presence`, { method: 'DELETE', keepalive: true }).catch(() => {});
  });

  async function initialize() {
    await window.SuperExcelAuth.ready;
    if (role === 'viewer') enableReadOnly();
    document.body.classList.remove('sheet-loading');
    setCollaboration('Sincronizado', `Revisão ${revision}`, 'is-synced');
    if (workbookId) {
      await heartbeat();
      pollLoop();
      heartbeatLoop();
    }
  }

  initialize().catch(error => {
    handleError(error);
    document.body.classList.remove('sheet-loading');
  });
})();