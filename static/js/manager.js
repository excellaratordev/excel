(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const roleLabels = { viewer: 'Visualizador', editor: 'Editor', admin: 'Administrador', owner: 'Proprietário' };
  const state = {
    projectId: null,
    project: null,
    role: 'viewer',
    projects: [],
    folderId: null,
    currentFolder: null,
    folders: [],
    workbooks: [],
    dragged: null,
    moving: false,
    activeView: 'files',
  };

  const dialog = $('#form-dialog');
  const title = $('#dialog-title');
  const fields = $('#dialog-fields');
  const save = $('#dialog-save');
  const dragMime = 'application/x-super-excel-item';
  const PROJECT_STORAGE = 'super-excel-current-project';

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
    return data;
  }

  function hasRole(required) {
    return roleRank[state.role] >= roleRank[required];
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function openForm(name, html, handler) {
    title.textContent = name;
    fields.innerHTML = html;
    save.onclick = async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await handler(new FormData(dialog.querySelector('form')));
        dialog.close();
      } catch (error) {
        alert(error.message);
      } finally {
        save.disabled = false;
      }
    };
    dialog.showModal();
    requestAnimationFrame(() => fields.querySelector('input,select,textarea')?.focus());
  }

  function normalizeFolderId(value) {
    return value === null || value === undefined || value === '' ? null : Number(value);
  }

  function sameFolder(left, right) {
    return normalizeFolderId(left) === normalizeFolderId(right);
  }

  function setProject(projectId) {
    const project = state.projects.find(item => Number(item.id) === Number(projectId));
    if (!project) return;
    state.projectId = Number(project.id);
    state.project = project;
    state.role = project.role || 'viewer';
    state.folderId = null;
    state.currentFolder = null;
    localStorage.setItem(PROJECT_STORAGE, String(state.projectId));
    $('#project-select').value = String(state.projectId);
    $('#project-role').textContent = roleLabels[state.role] || state.role;
    updateCapabilities();
  }

  function updateCapabilities() {
    const editable = hasRole('editor');
    const administrable = hasRole('admin');
    $('#new-folder').disabled = !editable;
    $('#new-sheet').disabled = !editable;
    $('#new-variable').disabled = !editable;
    $('#new-member').disabled = !administrable;
    $('#rename-project').disabled = !administrable;
    document.body.dataset.projectRole = state.role;
  }

  async function loadProjects(preferredId = null) {
    state.projects = await api('/api/projects');
    const select = $('#project-select');
    select.innerHTML = '';
    state.projects.forEach(project => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      select.append(option);
    });
    const stored = preferredId || Number(localStorage.getItem(PROJECT_STORAGE));
    const initial = state.projects.find(project => Number(project.id) === Number(stored)) || state.projects[0];
    if (!initial) throw new Error('Nenhum projeto disponível.');
    setProject(initial.id);
    await refreshCurrentProject();
  }

  async function refreshCurrentProject() {
    await Promise.all([loadFiles(), loadVariables(), loadMembers()]);
  }

  function readDragPayload(event) {
    if (state.dragged) return state.dragged;
    const raw = event.dataTransfer?.getData(dragMime) || event.dataTransfer?.getData('text/plain');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && ['folder', 'workbook'].includes(parsed.type) ? parsed : null;
    } catch {
      return null;
    }
  }

  function canDrop(payload, targetFolderId) {
    if (!hasRole('editor') || !payload || state.moving) return false;
    const target = normalizeFolderId(targetFolderId);
    if (Number(payload.projectId) !== Number(state.projectId)) return false;
    if (sameFolder(payload.parentId, target)) return false;
    if (payload.type === 'folder' && Number(payload.id) === target) return false;
    return true;
  }

  function clearDropStyles() {
    document.querySelectorAll('.drop-target').forEach(element => element.classList.remove('drop-target'));
  }

  function makeDraggable(element, payload) {
    if (!hasRole('editor')) return;
    element.draggable = true;
    element.title = payload.type === 'folder' ? 'Arraste esta pasta para outra pasta' : 'Arraste esta planilha para uma pasta';
    element.addEventListener('dragstart', event => {
      if (event.target.closest('button')) {
        event.preventDefault();
        return;
      }
      state.dragged = payload;
      element.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(dragMime, JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', JSON.stringify(payload));
    });
    element.addEventListener('dragend', () => {
      state.dragged = null;
      element.classList.remove('dragging');
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
        const endpoint = payload.type === 'folder'
          ? `/api/folders/${payload.id}/move`
          : `/api/workbooks/${payload.id}/move`;
        const body = payload.type === 'folder'
          ? { parent_id: normalizeFolderId(targetFolderId) }
          : { folder_id: normalizeFolderId(targetFolderId) };
        await api(endpoint, { method: 'PATCH', body: JSON.stringify(body) });
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
    item.innerHTML = '<div><div class="icon">📁</div><strong></strong><small>Pasta · solte itens aqui</small></div><div class="item-actions"><button>Abrir</button><button class="danger-action">Excluir</button></div>';
    item.querySelector('strong').textContent = folder.name;
    const [open, remove] = item.querySelectorAll('button');
    open.onclick = () => {
      state.folderId = folder.id;
      loadFiles();
    };
    remove.hidden = !hasRole('editor');
    remove.onclick = async () => {
      if (!confirm(`Excluir a pasta ${folder.name} e seu conteúdo?`)) return;
      await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
      await loadFiles();
    };
    makeDraggable(item, { type: 'folder', id: folder.id, name: folder.name, parentId: folder.parent_id, projectId: state.projectId });
    makeDropTarget(item, folder.id);
    return item;
  }

  function createWorkbookItem(workbook) {
    const item = document.createElement('article');
    item.className = 'item workbook-item';
    item.innerHTML = '<div><div class="icon">📊</div><strong></strong><small></small><span class="editor-line"></span></div><div class="item-actions"><button>Abrir</button><button class="danger-action">Excluir</button></div>';
    item.querySelector('strong').textContent = workbook.name;
    item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
    item.querySelector('.editor-line').textContent = workbook.updated_by_email ? `por ${workbook.updated_by_email}` : '';
    const [open, remove] = item.querySelectorAll('button');
    open.onclick = () => { location.href = `/sheet/${workbook.id}`; };
    remove.hidden = !hasRole('editor');
    remove.onclick = async () => {
      if (!confirm(`Excluir ${workbook.name}?`)) return;
      await api(`/api/workbooks/${workbook.id}`, { method: 'DELETE' });
      await loadFiles();
    };
    makeDraggable(item, { type: 'workbook', id: workbook.id, name: workbook.name, parentId: workbook.folder_id, projectId: state.projectId });
    return item;
  }

  async function loadFiles() {
    if (!state.projectId) return;
    const query = new URLSearchParams({ project_id: String(state.projectId) });
    if (state.folderId) query.set('folder_id', String(state.folderId));
    const data = await api(`/api/manager?${query}`);
    state.project = data.project;
    state.role = data.role;
    const projectEntry = state.projects.find(item => Number(item.id) === state.projectId);
    if (projectEntry) projectEntry.role = state.role;
    updateCapabilities();
    state.currentFolder = data.current_folder || null;
    state.folders = data.folders;
    state.workbooks = data.workbooks;
    $('#current-folder').textContent = state.currentFolder ? `› ${state.currentFolder.name}` : '';
    const items = $('#items');
    items.innerHTML = '';
    if (state.currentFolder) items.append(createBackItem());
    state.folders.forEach(folder => items.append(createFolderItem(folder)));
    state.workbooks.forEach(workbook => items.append(createWorkbookItem(workbook)));
    if (!items.children.length) items.innerHTML = '<p class="empty-state">Nenhum arquivo nesta pasta.</p>';
  }

  async function loadVariables() {
    if (!state.projectId) return;
    const list = await api(`/api/variables?project_id=${state.projectId}`);
    $('#variables-list').innerHTML = list.length
      ? list.map(variable => `<div class="row"><strong>${escapeHtml(variable.name)}</strong><span>${escapeHtml(JSON.stringify(variable.value))}</span><span>${escapeHtml(variable.scope)}</span>${hasRole('editor') ? `<button data-delete-variable="${variable.id}">Excluir</button>` : '<span></span>'}</div>`).join('')
      : '<div class="row empty-row">Nenhuma variável cadastrada.</div>';
    document.querySelectorAll('[data-delete-variable]').forEach(button => {
      button.onclick = async () => {
        await api(`/api/variables/${button.dataset.deleteVariable}`, { method: 'DELETE' });
        await loadVariables();
      };
    });
  }

  async function loadMembers() {
    if (!state.projectId) return;
    const data = await api(`/api/projects/${state.projectId}/members`);
    state.role = data.current_role;
    updateCapabilities();
    const currentEmail = window.SuperExcelAuth.session?.user?.email?.toLowerCase();
    $('#members-list').innerHTML = data.members.map(member => {
      const isOwner = member.role === 'owner';
      const isSelf = member.email.toLowerCase() === currentEmail;
      const canManage = hasRole('admin') && !isOwner;
      const canLeave = isSelf && !isOwner;
      const roleControl = canManage
        ? `<select data-member-role="${member.id}"><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Visualizador</option><option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Editor</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Administrador</option></select>`
        : `<span class="role-pill">${roleLabels[member.role] || member.role}</span>`;
      const action = canManage || canLeave ? `<button data-remove-member="${member.id}">${canLeave && !canManage ? 'Sair' : 'Remover'}</button>` : '<span></span>';
      return `<div class="member-row"><strong>${escapeHtml(member.email)}</strong>${roleControl}<span>${member.invited_by_email ? `Adicionado por ${escapeHtml(member.invited_by_email)}` : ''}</span>${action}</div>`;
    }).join('') || '<div class="row empty-row">Nenhum membro.</div>';

    document.querySelectorAll('[data-member-role]').forEach(select => {
      select.onchange = async () => {
        try {
          await api(`/api/projects/${state.projectId}/members/${select.dataset.memberRole}`, {
            method: 'PATCH',
            body: JSON.stringify({ role: select.value }),
          });
          await loadMembers();
        } catch (error) {
          alert(error.message);
          await loadMembers();
        }
      };
    });
    document.querySelectorAll('[data-remove-member]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('Remover este membro do projeto?')) return;
        await api(`/api/projects/${state.projectId}/members/${button.dataset.removeMember}`, { method: 'DELETE' });
        if (button.textContent === 'Sair') await loadProjects();
        else await loadMembers();
      };
    });
  }

  $('#project-select').onchange = async event => {
    setProject(event.target.value);
    await refreshCurrentProject();
  };

  $('#new-project').onclick = () => openForm(
    'Novo projeto compartilhado',
    '<label>Nome do projeto</label><input name="name" maxlength="120" required>',
    async form => {
      const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: form.get('name') }) });
      await loadProjects(project.id);
    },
  );

  $('#rename-project').onclick = () => openForm(
    'Renomear projeto',
    `<label>Novo nome</label><input name="name" maxlength="120" value="${escapeHtml(state.project?.name || '')}" required>`,
    async form => {
      await api(`/api/projects/${state.projectId}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name') }) });
      await loadProjects(state.projectId);
    },
  );

  $('#new-folder').onclick = () => openForm(
    'Nova pasta',
    '<label>Nome</label><input name="name" required>',
    async form => {
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ project_id: state.projectId, name: form.get('name'), parent_id: state.folderId }) });
      await loadFiles();
    },
  );

  $('#new-sheet').onclick = () => openForm(
    'Nova planilha',
    '<label>Nome</label><input name="name" value="Nova Planilha" required>',
    async form => {
      const book = await api('/api/workbooks', { method: 'POST', body: JSON.stringify({ project_id: state.projectId, name: form.get('name'), folder_id: state.folderId }) });
      location.href = `/sheet/${book.id}`;
    },
  );

  $('#new-variable').onclick = () => openForm(
    'Nova variável',
    '<label>Nome</label><input name="name" required><label>Valor</label><input name="value"><label>Escopo</label><select name="scope"><option value="global">Projeto inteiro</option><option value="folder">Pasta atual</option></select><label>Descrição</label><textarea name="description"></textarea>',
    async form => {
      await api('/api/variables', {
        method: 'POST',
        body: JSON.stringify({
          project_id: state.projectId,
          name: form.get('name'),
          value: form.get('value'),
          scope: form.get('scope'),
          folder_id: form.get('scope') === 'folder' ? state.folderId : null,
          description: form.get('description'),
        }),
      });
      await loadVariables();
    },
  );

  $('#new-member').onclick = () => openForm(
    'Adicionar membro',
    '<label>Gmail da pessoa</label><input name="email" type="email" placeholder="pessoa@gmail.com" required><label>Nível de acesso</label><select name="role"><option value="editor">Editor — pode alterar arquivos</option><option value="viewer">Visualizador — somente leitura</option><option value="admin">Administrador — gerencia membros</option></select><p class="form-help">A pessoa verá o projeto automaticamente ao entrar com este mesmo Gmail.</p>',
    async form => {
      await api(`/api/projects/${state.projectId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), role: form.get('role') }),
      });
      await loadMembers();
    },
  );

  const rootButton = $('#root-button');
  rootButton.onclick = () => {
    state.folderId = null;
    loadFiles();
  };
  makeDropTarget(rootButton, null);

  document.querySelectorAll('.nav').forEach(button => {
    button.onclick = () => {
      state.activeView = button.dataset.view;
      document.querySelectorAll('.nav,.view').forEach(element => element.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.view}-view`).classList.add('active');
    };
  });

  async function initialize() {
    await window.SuperExcelAuth.ready;
    await loadProjects();
    window.setInterval(() => {
      if (document.hidden || state.moving || dialog.open) return;
      if (state.activeView === 'files') loadFiles().catch(console.error);
      else if (state.activeView === 'variables') loadVariables().catch(console.error);
      else if (state.activeView === 'members') loadMembers().catch(console.error);
    }, 5000);
  }

  initialize().catch(error => alert(error.message));
})();
