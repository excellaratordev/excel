(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
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
  const AUTOSAVE = 'super-excel-autosave-v1';
  const PRELOAD_MARKER = `super-excel-preloaded-${workbookId}`;
  const META_KEY = `super-excel-meta-${workbookId}`;

  let revision = 0;
  let projectId = null;
  let role = 'viewer';
  let basePayload = null;
  let lastLocalText = '';
  let dirty = false;
  let saving = false;
  let saveTimer = null;
  let pendingRemote = null;
  let reloadAfterSave = false;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function parseLocal() {
    try {
      return JSON.parse(localStorage.getItem(AUTOSAVE) || '{}');
    } catch {
      return {};
    }
  }

  function stable(value) {
    return JSON.stringify(value ?? null);
  }

  function currentUserEmail() {
    return window.SuperExcelAuth.session?.user?.email?.toLowerCase() || '';
  }

  function setCollaboration(text, detail = '', stateClass = '') {
    collaborationState.textContent = text;
    collaborationDetail.textContent = detail;
    collaborationSummary.classList.remove('is-saving', 'is-error', 'is-synced');
    if (stateClass) collaborationSummary.classList.add(stateClass);
  }

  function updateMeta(extra = {}) {
    const meta = {
      revision,
      project_id: projectId,
      role,
      updated_at: extra.updated_at || new Date().toISOString(),
      updated_by_email: extra.updated_by_email || currentUserEmail(),
    };
    sessionStorage.setItem(META_KEY, JSON.stringify(meta));
    return meta;
  }

  function prepareReload(payload, meta) {
    localStorage.setItem(AUTOSAVE, JSON.stringify(payload));
    sessionStorage.setItem(META_KEY, JSON.stringify(meta));
    sessionStorage.setItem(PRELOAD_MARKER, '1');
    window.location.reload();
  }

  function mergePayload(base, local, remote) {
    const merged = clone(remote || {});
    const baseCells = Array.isArray(base?.cells) ? base.cells : [];
    const localCells = Array.isArray(local?.cells) ? local.cells : [];
    const remoteCells = Array.isArray(remote?.cells) ? remote.cells : [];
    const rowCount = Math.max(baseCells.length, localCells.length, remoteCells.length, 1);
    const colCount = Math.max(
      Number(base?.cols || 0),
      Number(local?.cols || 0),
      Number(remote?.cols || 0),
      ...baseCells.map(row => Array.isArray(row) ? row.length : 0),
      ...localCells.map(row => Array.isArray(row) ? row.length : 0),
      ...remoteCells.map(row => Array.isArray(row) ? row.length : 0),
      1,
    );

    merged.cells = Array.from({ length: rowCount }, (_, row) =>
      Array.from({ length: colCount }, (_, col) => remoteCells[row]?.[col] ?? null));
    let conflicts = 0;

    for (let row = 0; row < rowCount; row += 1) {
      for (let col = 0; col < colCount; col += 1) {
        const baseValue = baseCells[row]?.[col] ?? null;
        const localValue = localCells[row]?.[col] ?? null;
        const remoteValue = remoteCells[row]?.[col] ?? null;
        const localChanged = stable(localValue) !== stable(baseValue);
        if (!localChanged) continue;
        const remoteChanged = stable(remoteValue) !== stable(baseValue);
        if (remoteChanged && stable(remoteValue) !== stable(localValue)) conflicts += 1;
        merged.cells[row][col] = localValue;
      }
    }

    merged.version = Math.max(Number(remote?.version || 1), Number(local?.version || 1));
    merged.rows = Math.max(Number(remote?.rows || rowCount), Number(local?.rows || rowCount), rowCount);
    merged.cols = Math.max(Number(remote?.cols || colCount), Number(local?.cols || colCount), colCount);
    const localNameChanged = String(local?.name || '') !== String(base?.name || '');
    merged.name = localNameChanged ? local.name : (remote?.name || local?.name || 'Minha Planilha');
    return { payload: merged, conflicts };
  }

  function renderPresence(list) {
    collaborators.innerHTML = '';
    const visible = (list || []).slice(0, 4);
    visible.forEach(person => {
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
    });
    if ((list || []).length > 4) {
      const more = document.createElement('span');
      more.className = 'collaborator-fallback collaborator-more';
      more.textContent = `+${list.length - 4}`;
      collaborators.append(more);
    }
    collaborationDetail.textContent = `${(list || []).length || 1} pessoa(s) online`;
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
    const banner = document.createElement('div');
    banner.className = 'viewer-banner';
    banner.textContent = 'Você está neste projeto como visualizador.';
    document.body.append(banner);
  }

  function scheduleSave(delay = 900) {
    if (role === 'viewer') return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => flushSave().catch(handleError), delay);
  }

  async function postSnapshot(snapshot, baseRevision) {
    const response = await fetch('/api/workbooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: workbookId,
        name: snapshot.name || nameInput.value.trim() || 'Minha Planilha',
        data: snapshot,
        base_revision: baseRevision,
      }),
    });
    const output = await response.json();
    return { response, output };
  }

  async function flushSave() {
    if (role === 'viewer' || saving || !dirty) return;
    saving = true;
    clearTimeout(saveTimer);
    setCollaboration('Salvando...', 'Enviando alterações', 'is-saving');
    status.textContent = 'Salvando alterações compartilhadas...';

    try {
      let snapshot = parseLocal();
      snapshot.name = nameInput.value.trim() || snapshot.name || 'Minha Planilha';
      let result = await postSnapshot(snapshot, revision);
      if (result.response.status === 409 && result.output?.conflict && result.output.current) {
        const remote = result.output.current;
        const merge = mergePayload(basePayload || {}, snapshot, remote.data || {});
        snapshot = merge.payload;
        revision = Number(remote.revision || revision);
        projectId = remote.project_id || projectId;
        basePayload = clone(remote.data || {});
        localStorage.setItem(AUTOSAVE, JSON.stringify(snapshot));
        lastLocalText = JSON.stringify(snapshot);
        reloadAfterSave = true;
        result = await postSnapshot(snapshot, revision);
        if (!result.response.ok) throw new Error(result.output?.error || 'Não foi possível mesclar as alterações.');
        status.textContent = merge.conflicts
          ? `${merge.conflicts} conflito(s) na mesma célula; sua última alteração foi mantida.`
          : 'Alterações de várias pessoas foram mescladas.';
      } else if (!result.response.ok) {
        throw new Error(result.output?.error || 'Erro ao salvar.');
      }

      revision = Number(result.output.revision || revision + 1);
      basePayload = clone(snapshot);
      updateMeta(result.output);
      const currentText = localStorage.getItem(AUTOSAVE) || '';
      dirty = currentText !== JSON.stringify(snapshot);
      lastLocalText = currentText;
      status.classList.remove('error');
      setCollaboration('Sincronizado', `Revisão ${revision}`, 'is-synced');
      if (!status.textContent.includes('conflito') && !status.textContent.includes('mescladas')) {
        status.textContent = `Planilha sincronizada — revisão ${revision}`;
      }

      if (reloadAfterSave) {
        reloadAfterSave = false;
        prepareReload(snapshot, updateMeta(result.output));
        return;
      }
      if (dirty) scheduleSave(350);
    } finally {
      saving = false;
    }
  }

  function handleError(error) {
    console.error(error);
    setCollaboration('Falha ao sincronizar', error.message, 'is-error');
    status.textContent = error.message;
    status.classList.add('error');
    saving = false;
  }

  function userIsActivelyEditing() {
    return document.activeElement === formulaInput || document.querySelector('.cell.editing');
  }

  async function checkRemote() {
    if (saving || !revision) return;
    const response = await fetch(`/api/workbooks/${workbookId}/sync?after_revision=${revision}`);
    if (response.status === 204) return;
    const remote = await response.json();
    if (!response.ok) throw new Error(remote.error || 'Erro ao verificar alterações externas.');
    if (userIsActivelyEditing()) {
      pendingRemote = remote;
      setCollaboration('Outra pessoa editou', 'Aguardando você terminar a célula', 'is-saving');
      return;
    }
    await applyRemoteUpdate(remote);
  }

  async function applyRemoteUpdate(remote) {
    if (!remote || Number(remote.revision || 0) <= revision) return;
    const current = parseLocal();
    const currentText = JSON.stringify(current);
    const hasLocalChanges = dirty || currentText !== JSON.stringify(basePayload || {});
    if (hasLocalChanges && role !== 'viewer') {
      const merge = mergePayload(basePayload || {}, current, remote.data || {});
      revision = Number(remote.revision);
      projectId = remote.project_id || projectId;
      basePayload = clone(remote.data || {});
      localStorage.setItem(AUTOSAVE, JSON.stringify(merge.payload));
      lastLocalText = JSON.stringify(merge.payload);
      dirty = true;
      reloadAfterSave = true;
      status.textContent = merge.conflicts
        ? `Mesclando alterações; ${merge.conflicts} célula(s) tiveram conflito.`
        : 'Mesclando alterações feitas por outra pessoa...';
      await flushSave();
      return;
    }
    revision = Number(remote.revision);
    projectId = remote.project_id || projectId;
    basePayload = clone(remote.data || {});
    dirty = false;
    setCollaboration('Atualizando...', `Alterado por ${remote.updated_by_email || 'outro membro'}`, 'is-saving');
    prepareReload(remote.data, {
      revision,
      project_id: projectId,
      role: remote.role || role,
      updated_at: remote.updated_at,
      updated_by_email: remote.updated_by_email,
    });
  }

  async function heartbeat() {
    const response = await fetch(`/api/workbooks/${workbookId}/presence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao atualizar presença.');
    renderPresence(output.online || []);
  }

  function watchLocalChanges() {
    window.setInterval(() => {
      const currentText = localStorage.getItem(AUTOSAVE) || '';
      if (currentText === lastLocalText) return;
      lastLocalText = currentText;
      dirty = true;
      setCollaboration('Alterações locais', 'Aguardando sincronização', 'is-saving');
      scheduleSave();
    }, 450);
  }

  async function initializeCollaboration(meta) {
    revision = Number(meta.revision || 1);
    projectId = meta.project_id;
    role = meta.role || 'viewer';
    basePayload = parseLocal();
    lastLocalText = JSON.stringify(basePayload);
    dirty = false;
    document.body.classList.remove('sheet-loading');
    setCollaboration('Sincronizado', `Revisão ${revision}`, 'is-synced');
    if (role === 'viewer') enableReadOnly();
    watchLocalChanges();
    await heartbeat();
    window.setInterval(() => heartbeat().catch(console.error), 12000);
    window.setInterval(() => checkRemote().catch(handleError), 2000);
    window.setInterval(() => {
      if (pendingRemote && !userIsActivelyEditing()) {
        const remote = pendingRemote;
        pendingRemote = null;
        applyRemoteUpdate(remote).catch(handleError);
      }
    }, 500);
  }

  async function preloadWorkbook() {
    await window.SuperExcelAuth.ready;
    if (!workbookId) {
      document.body.classList.remove('sheet-loading');
      return;
    }
    if (sessionStorage.getItem(PRELOAD_MARKER) === '1') {
      sessionStorage.removeItem(PRELOAD_MARKER);
      const meta = JSON.parse(sessionStorage.getItem(META_KEY) || '{}');
      await initializeCollaboration(meta);
      return;
    }
    status.textContent = 'Carregando planilha compartilhada...';
    const response = await fetch(`/api/workbooks/${workbookId}`);
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Erro ao abrir planilha.');
    const workbook = output.data || {};
    workbook.name = output.name || workbook.name || 'Minha Planilha';
    prepareReload(workbook, {
      revision: output.revision || 1,
      project_id: output.project_id,
      role: output.role || 'viewer',
      updated_at: output.updated_at,
      updated_by_email: output.updated_by_email,
    });
  }

  saveButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    dirty = true;
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
      if (role !== 'viewer') {
        dirty = true;
        flushSave().catch(handleError);
      }
    }
  }, true);

  window.addEventListener('pagehide', () => {
    if (!workbookId) return;
    fetch(`/api/workbooks/${workbookId}/presence`, { method: 'DELETE', keepalive: true }).catch(() => {});
    if (dirty && role !== 'viewer') flushSave().catch(() => {});
  });

  preloadWorkbook().catch(error => {
    handleError(error);
    document.body.classList.remove('sheet-loading');
    window.setTimeout(() => window.location.replace('/files'), 3000);
  });
})();
