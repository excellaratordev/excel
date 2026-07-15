(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const state = { folderId: null, folders: [], workbooks: [] };
  const dialog = $('#form-dialog');
  const title = $('#dialog-title');
  const fields = $('#dialog-fields');
  const save = $('#dialog-save');

  async function api(url, options = {}) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro inesperado.');
    return data;
  }

  function openForm(name, html, handler) {
    title.textContent = name;
    fields.innerHTML = html;
    save.onclick = async (event) => {
      event.preventDefault();
      try { await handler(new FormData(dialog.querySelector('form'))); dialog.close(); await refreshAll(); }
      catch (error) { alert(error.message); }
    };
    dialog.showModal();
  }

  async function loadFiles() {
    const query = state.folderId ? `?folder_id=${state.folderId}` : '';
    const data = await api(`/api/manager${query}`);
    state.folders = data.folders;
    state.workbooks = data.workbooks;
    $('#current-folder').textContent = state.folderId ? `Pasta #${state.folderId}` : '';
    const items = $('#items');
    items.innerHTML = '';
    if (state.folderId) {
      const back = document.createElement('article');
      back.className = 'item';
      back.innerHTML = '<div><div class="icon">↩️</div><strong>Voltar</strong><small>Pasta anterior</small></div>';
      back.onclick = () => { state.folderId = null; loadFiles(); };
      items.append(back);
    }
    for (const folder of state.folders) {
      const item = document.createElement('article');
      item.className = 'item';
      item.innerHTML = `<div><div class="icon">📁</div><strong></strong><small>Pasta</small></div><div class="item-actions"><button>Abrir</button><button>Excluir</button></div>`;
      item.querySelector('strong').textContent = folder.name;
      const [open, remove] = item.querySelectorAll('button');
      open.onclick = () => { state.folderId = folder.id; loadFiles(); };
      remove.onclick = async () => { if (confirm(`Excluir a pasta ${folder.name} e seu conteúdo?`)) { await api(`/api/folders/${folder.id}`, { method: 'DELETE' }); await loadFiles(); } };
      items.append(item);
    }
    for (const workbook of state.workbooks) {
      const item = document.createElement('article');
      item.className = 'item';
      item.innerHTML = `<div><div class="icon">📊</div><strong></strong><small></small></div><div class="item-actions"><button>Abrir</button><button>Excluir</button></div>`;
      item.querySelector('strong').textContent = workbook.name;
      item.querySelector('small').textContent = `Atualizada ${new Date(workbook.updated_at).toLocaleString('pt-BR')}`;
      const [open, remove] = item.querySelectorAll('button');
      open.onclick = () => location.href = `/sheet/${workbook.id}`;
      remove.onclick = async () => { if (confirm(`Excluir ${workbook.name}?`)) { await api(`/api/workbooks/${workbook.id}`, { method: 'DELETE' }); await loadFiles(); } };
      items.append(item);
    }
    if (!items.children.length) items.innerHTML = '<p>Nenhum arquivo nesta pasta.</p>';
  }

  async function loadVariables() {
    const list = await api('/api/variables');
    $('#variables-list').innerHTML = list.length ? list.map(v => `<div class="row"><strong>${v.name}</strong><span>${JSON.stringify(v.value)}</span><span>${v.scope}</span><button data-delete-variable="${v.id}">Excluir</button></div>`).join('') : '<div class="row">Nenhuma variável cadastrada.</div>';
    document.querySelectorAll('[data-delete-variable]').forEach(button => button.onclick = async () => { await api(`/api/variables/${button.dataset.deleteVariable}`, { method: 'DELETE' }); loadVariables(); });
  }

  async function loadPermissions() {
    const list = await api('/api/permissions');
    $('#permissions-list').innerHTML = list.length ? list.map(p => `<div class="row"><strong>${p.grantee_email}</strong><span>${p.resource_type} #${p.folder_id || p.workbook_id}</span><span>${p.permission}</span><button data-delete-permission="${p.id}">Excluir</button></div>`).join('') : '<div class="row">Nenhuma permissão cadastrada.</div>';
    document.querySelectorAll('[data-delete-permission]').forEach(button => button.onclick = async () => { await api(`/api/permissions/${button.dataset.deletePermission}`, { method: 'DELETE' }); loadPermissions(); });
  }

  async function refreshAll() { await Promise.all([loadFiles(), loadVariables(), loadPermissions()]); }

  $('#new-folder').onclick = () => openForm('Nova pasta', '<label>Nome</label><input name="name" required>', async form => api('/api/folders', { method: 'POST', body: JSON.stringify({ name: form.get('name'), parent_id: state.folderId }) }));
  $('#new-sheet').onclick = () => openForm('Nova planilha', '<label>Nome</label><input name="name" value="Nova Planilha" required>', async form => { const book = await api('/api/workbooks', { method: 'POST', body: JSON.stringify({ name: form.get('name'), folder_id: state.folderId }) }); location.href = `/sheet/${book.id}`; });
  $('#new-variable').onclick = () => openForm('Nova variável', '<label>Nome</label><input name="name" required><label>Valor</label><input name="value"><label>Escopo</label><select name="scope"><option value="global">Global</option><option value="folder">Pasta atual</option></select><label>Descrição</label><textarea name="description"></textarea>', async form => api('/api/variables', { method: 'POST', body: JSON.stringify({ name: form.get('name'), value: form.get('value'), scope: form.get('scope'), folder_id: form.get('scope') === 'folder' ? state.folderId : null, description: form.get('description') }) }));
  $('#new-permission').onclick = () => openForm('Nova permissão', '<label>Tipo</label><select name="resource_type"><option value="folder">Pasta atual</option><option value="workbook">Planilha</option></select><label>ID da planilha</label><input name="workbook_id" type="number"><label>E-mail</label><input name="email" type="email" required><label>Nível</label><select name="permission"><option value="view">Visualizar</option><option value="edit">Editar</option><option value="admin">Administrar</option></select>', async form => api('/api/permissions', { method: 'POST', body: JSON.stringify({ resource_type: form.get('resource_type'), folder_id: form.get('resource_type') === 'folder' ? state.folderId : null, workbook_id: form.get('resource_type') === 'workbook' ? Number(form.get('workbook_id')) : null, grantee_email: form.get('email'), permission: form.get('permission') }) }));
  $('#root-button').onclick = () => { state.folderId = null; loadFiles(); };
  document.querySelectorAll('.nav').forEach(button => button.onclick = () => { document.querySelectorAll('.nav,.view').forEach(el => el.classList.remove('active')); button.classList.add('active'); $(`#${button.dataset.view}-view`).classList.add('active'); });
  refreshAll().catch(error => alert(error.message));
})();