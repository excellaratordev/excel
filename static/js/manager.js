(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = {
    folderId: null,
    currentFolder: null,
    folders: [],
    workbooks: [],
    dragged: null,
    moving: false,
  };
  const dialog = $('#form-dialog');
  const title = $('#dialog-title');
  const fields = $('#dialog-fields');
  const save = $('#dialog-save');
  const dragMime = 'application/x-super-excel-item';

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro inesperado.');
    return data;
  }

  function openForm(name, html, handler) {
    title.textContent = name;
    fields.innerHTML = html;
    save.onclick = async event => {
      event.preventDefault();
      try {
        await handler(new FormData(dialog.querySelector('form')));
        dialog.close();
        await refreshAll();
      } catch (error) {
        alert(error.message);
      }
    };
    dialog.showModal();
  }

  function normalizeFolderId(value) {
    return value === null || value === undefined || value === '' ? null : Number(value);
  }

  function sameFolder(left, right) {
    return normalizeFolderId(left) === normalizeFolderId(right);
  }

  function readDragPayload(event) {
    if (state.dragged) return state.dragged;
    const raw = event.dataTransfer?.getData(dragMime)
      || event.dataTransfer?.getData('text/plain');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && ['folder', 'workbook'].includes(parsed.type) ? parsed : null;
    } catch {
      return null;
    }
  }

  function canDrop(payload, targetFolderId) {
    if (!payload || state.moving) return false;
    const target = normalizeFolderId(targetFolderId);
    if (sameFolder(payload.parentId, target)) return false;
    if (payload.type === 'folder' && Number(payload.id) === target) return false;
    return true;
  }

  function clearDropStyles() {
    document.querySelectorAll('.drop-target').forEach(element => {
      element.classList.remove('drop-target');
    });
  }

  function makeDraggable(element, payload) {
    element.draggable = true;
    element.dataset.dragType = payload.type;
    element.dataset.dragId = String(payload.id);
    element.title = payload.type === 'folder'
      ? 'Arraste esta pasta para outra pasta'
      : 'Arraste esta planilha para uma pasta';

    element.addEventListener('dragstart', event => {
      if (event.target.closest('button')) {
        event.preventDefault();
        return;
      }
      state.dragged = payload;
      element.classList.add('dragging');
      element.setAttribute('aria-grabbed', 'true');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(dragMime, JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', JSON.stringify(payload));
    });

    element.addEventListener('dragend', () => {
      state.dragged = null;
      element.classList.remove('dragging');
      element.setAttribute('aria-grabbed', 'false');
      clearDropStyles();
    });
  }

  function makeDropTarget(element, targetFolderId) {
    element.addEventListener('dragenter', event => {
      if (!canDrop(readDragPayload(event), targetFolderId)) return;
      event.preventDefault();
      element.classList.add('drop-target');
    });

    element.addEventListener('dragover', event => {
      if (!canDrop(readDragPayload(event), targetFolderId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      element.classList.add('drop-target');
    });

    element.addEventListener('dragleave', event => {
      if (!element.contains(event.relatedTarget)) element.classList.remove('drop-target');
    });

    element.addEventListener('drop', async event => {
      const payload = readDragPayload(event);
      element.classList.remove('drop-target');
      if (!canDrop(payload, targetFolderId)) return;
      event.preventDefault();
      event.stopPropagation();

      state.moving = true;
      document.body.classList.add('is-moving');
      try {
        if (payload.type === 'folder') {
          await api(`/api/folders/${payload.id}/move`, {
            method: 'PATCH',
            body: JSON.stringify({ parent_id: normalizeFolderId(targetFolderId) }),
          });
        } else {
          await api(`/api/workbooks/${payload.id}/move`, {
            method: 'PATCH',
            body: JSON.stringify({ folder_id: normalizeFolderId(targetFolderId) }),
          });
        }
        await loadFiles();
      } catch (error) {
        alert(error.message);
      } finally {
        state.moving = false;
        state.dragged = null;
        document.body.classList.remove('is-moving');
        clearDropStyles();
      }
    });
  }

  function createBackItem() {
    const back = document.createElement('article');
    back.className = 'item back-item';
    const parentId = state.currentFolder?.parent_id ?? null;
    back.innerHTML = '<div><div class="icon">↩️</div><strong>Voltar</strong><small>Solte aqui para mover à pasta anterior</small></div>';
    back.onclick = () => {
      state.folderId = normalizeFolderId(parentId);
      loadFiles();
    };
    makeDropTarget(back, parentId);
    return back;
  }

  function createFolderItem(folder) {
    const item = document.createElement('article');
    item.className = 'item folder-item';
    item.innerHTML = '<div><div class="icon">📁</div><strong></strong><small>Pasta · solte itens aqui</small></div><div class="item-actions"><button>Abrir</button><button>Excluir</button></div>';
    item.querySelector('strong').textContent = folder.name;
    const [open, remove] = item.querySelectorAll('button');
    open.onclick = () => {
      state.folderId = folder.id;
      loadFiles();
    };
    remove.onclick = async () => {
      if (!confirm(`Excluir a pasta ${folder.name} e seu conteúdo?`)) return;
      await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
      await loadFiles();
    };

    makeDraggable(item, {
      type: 'folder',
      id: folder.id,
      name: folder.name,
      parentId: folder.parent_id,
    });
    makeDropTarget(item, folder.id);
    return item;
  }

  function createWorkbookItem(workbook) {
    const item = document.createElement('article');
    item.className = 'item workbook-item';
    item.innerHTML = '<div><div class="icon">📊</div><strong></strong><small></small></div><div class="item-actions"><button>Abrir</button><button>Excluir</button></div>';
    item.querySelector('strong').textContent = workbook.name;
    item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
    const [open, remove] = item.querySelectorAll('button');
    open.onclick = () => { location.href = `/sheet/${workbook.id}`; };
    remove.onclick = async () => {
      if (!confirm(`Excluir ${workbook.name}?`)) return;
      await api(`/api/workbooks/${workbook.id}`, { method: 'DELETE' });
      await loadFiles();
    };

    makeDraggable(item, {
      type: 'workbook',
      id: workbook.id,
      name: workbook.name,
      parentId: workbook.folder_id,
    });
    return item;
  }

  async function loadFiles() {
    const query = state.folderId ? `?folder_id=${state.folderId}` : '';
    const data = await api(`/api/manager${query}`);
    state.currentFolder = data.current_folder || null;
    state.folders = data.folders;
    state.workbooks = data.workbooks;

    $('#current-folder').textContent = state.currentFolder ? `› ${state.currentFolder.name}` : '';
    const items = $('#items');
    items.innerHTML = '';

    if (state.currentFolder) items.append(createBackItem());
    state.folders.forEach(folder => items.append(createFolderItem(folder)));
    state.workbooks.forEach(workbook => items.append(createWorkbookItem(workbook)));

    if (!items.children.length) {
      items.innerHTML = '<p class="empty-state">Nenhum arquivo nesta pasta. Arraste itens para cá a partir da pasta anterior.</p>';
    }
  }

  async function loadVariables() {
    const list = await api('/api/variables');
    $('#variables-list').innerHTML = list.length
      ? list.map(variable => `<div class="row"><strong>${variable.name}</strong><span>${JSON.stringify(variable.value)}</span><span>${variable.scope}</span><button data-delete-variable="${variable.id}">Excluir</button></div>`).join('')
      : '<div class="row">Nenhuma variável cadastrada.</div>';
    document.querySelectorAll('[data-delete-variable]').forEach(button => {
      button.onclick = async () => {
        await api(`/api/variables/${button.dataset.deleteVariable}`, { method: 'DELETE' });
        loadVariables();
      };
    });
  }

  async function loadPermissions() {
    const list = await api('/api/permissions');
    $('#permissions-list').innerHTML = list.length
      ? list.map(permission => `<div class="row"><strong>${permission.grantee_email}</strong><span>${permission.resource_type} #${permission.folder_id || permission.workbook_id}</span><span>${permission.permission}</span><button data-delete-permission="${permission.id}">Excluir</button></div>`).join('')
      : '<div class="row">Nenhuma permissão cadastrada.</div>';
    document.querySelectorAll('[data-delete-permission]').forEach(button => {
      button.onclick = async () => {
        await api(`/api/permissions/${button.dataset.deletePermission}`, { method: 'DELETE' });
        loadPermissions();
      };
    });
  }

  async function refreshAll() {
    await Promise.all([loadFiles(), loadVariables(), loadPermissions()]);
  }

  $('#new-folder').onclick = () => openForm(
    'Nova pasta',
    '<label>Nome</label><input name="name" required>',
    async form => api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name: form.get('name'), parent_id: state.folderId }),
    }),
  );

  $('#new-sheet').onclick = () => openForm(
    'Nova planilha',
    '<label>Nome</label><input name="name" value="Nova Planilha" required>',
    async form => {
      const book = await api('/api/workbooks', {
        method: 'POST',
        body: JSON.stringify({ name: form.get('name'), folder_id: state.folderId }),
      });
      location.href = `/sheet/${book.id}`;
    },
  );

  $('#new-variable').onclick = () => openForm(
    'Nova variável',
    '<label>Nome</label><input name="name" required><label>Valor</label><input name="value"><label>Escopo</label><select name="scope"><option value="global">Global</option><option value="folder">Pasta atual</option></select><label>Descrição</label><textarea name="description"></textarea>',
    async form => api('/api/variables', {
      method: 'POST',
      body: JSON.stringify({
        name: form.get('name'),
        value: form.get('value'),
        scope: form.get('scope'),
        folder_id: form.get('scope') === 'folder' ? state.folderId : null,
        description: form.get('description'),
      }),
    }),
  );

  $('#new-permission').onclick = () => openForm(
    'Nova permissão',
    '<label>Tipo</label><select name="resource_type"><option value="folder">Pasta atual</option><option value="workbook">Planilha</option></select><label>ID da planilha</label><input name="workbook_id" type="number"><label>E-mail</label><input name="email" type="email" required><label>Nível</label><select name="permission"><option value="view">Visualizar</option><option value="edit">Editar</option><option value="admin">Administrar</option></select>',
    async form => api('/api/permissions', {
      method: 'POST',
      body: JSON.stringify({
        resource_type: form.get('resource_type'),
        folder_id: form.get('resource_type') === 'folder' ? state.folderId : null,
        workbook_id: form.get('resource_type') === 'workbook' ? Number(form.get('workbook_id')) : null,
        grantee_email: form.get('email'),
        permission: form.get('permission'),
      }),
    }),
  );

  const rootButton = $('#root-button');
  rootButton.onclick = () => {
    state.folderId = null;
    loadFiles();
  };
  makeDropTarget(rootButton, null);

  document.querySelectorAll('.nav').forEach(button => {
    button.onclick = () => {
      document.querySelectorAll('.nav,.view').forEach(element => element.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.view}-view`).classList.add('active');
    };
  });

  refreshAll().catch(error => alert(error.message));
})();