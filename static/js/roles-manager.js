(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const select = $('#project-select');
  const view = $('#roles-view');
  const nav = document.querySelector('[data-view="roles"]');
  const list = $('#roles-list');
  const membersList = $('#role-members-list');
  const status = $('#roles-status');
  const createButton = $('#new-role');
  const dialog = $('#role-dialog');
  const form = dialog?.querySelector('form');
  const nameInput = dialog?.querySelector('[name="role_name"]');
  const capabilitiesRoot = $('#role-capabilities');
  const dialogTitle = $('#role-dialog-title');
  const saveButton = $('#role-dialog-save');
  const memberForm = $('#role-member-form');
  const memberEmail = $('#role-member-email');
  const memberRole = $('#role-member-role');
  const state = { projectId: null, payload: null, members: [], editingRole: null };

  if (!select || !view || !nav || !list || !membersList || !dialog || !form) return;

  const GROUPS = [
    ['Projeto', ['project.view', 'project.rename', 'project.delete']],
    ['Pastas', ['folder.create', 'folder.move', 'folder.delete']],
    ['Planilhas', ['workbook.create', 'workbook.view', 'workbook.edit', 'workbook.rename', 'workbook.move', 'workbook.delete', 'workbook.export']],
    ['Abas e células', ['sheet.create', 'sheet.view', 'sheet.edit', 'sheet.delete', 'cell.edit', 'formula.edit', 'format.edit', 'structure.edit']],
    ['Dados', ['variables.view', 'variables.edit', 'data.import', 'data.export']],
    ['Histórico e automação', ['history.view', 'history.restore', 'automation.view', 'automation.edit', 'automation.run']],
    ['Administração', ['members.view', 'members.manage', 'roles.view', 'roles.manage', 'telemetry.view']],
  ];

  const LABELS = {
    'project.view': 'Visualizar projeto', 'project.rename': 'Renomear projeto', 'project.delete': 'Excluir projeto',
    'folder.create': 'Criar pastas', 'folder.move': 'Mover pastas', 'folder.delete': 'Excluir pastas',
    'workbook.create': 'Criar planilhas', 'workbook.view': 'Visualizar planilhas', 'workbook.edit': 'Editar planilhas',
    'workbook.rename': 'Renomear planilhas', 'workbook.move': 'Mover planilhas', 'workbook.delete': 'Excluir planilhas', 'workbook.export': 'Exportar planilhas',
    'sheet.create': 'Criar abas', 'sheet.view': 'Visualizar abas', 'sheet.edit': 'Editar abas', 'sheet.delete': 'Excluir abas',
    'cell.edit': 'Editar células', 'formula.edit': 'Editar fórmulas', 'format.edit': 'Editar formatação', 'structure.edit': 'Alterar estrutura',
    'variables.view': 'Visualizar variáveis', 'variables.edit': 'Editar variáveis', 'data.import': 'Importar dados', 'data.export': 'Exportar dados',
    'history.view': 'Visualizar histórico', 'history.restore': 'Restaurar histórico', 'automation.view': 'Visualizar automações',
    'automation.edit': 'Editar automações', 'automation.run': 'Executar automações', 'members.view': 'Visualizar membros',
    'members.manage': 'Gerenciar membros', 'roles.view': 'Visualizar roles', 'roles.manage': 'Gerenciar roles', 'telemetry.view': 'Visualizar telemetria',
  };

  async function api(url, options = {}) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro inesperado.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function setStatus(message = '', error = false) {
    status.textContent = message;
    status.classList.toggle('error-text', error);
  }

  function roleCapabilities(roleName) {
    return state.payload?.roles.find(role => role.name === roleName)?.capabilities || [];
  }

  function canManage() {
    return roleCapabilities(state.payload?.current_role).includes('roles.manage');
  }

  function activeRoles() {
    return (state.payload?.roles || []).filter(role => role.preset || role.is_active);
  }

  function updateSummary() {
    const roles = state.payload?.roles || [];
    $('#roles-total').textContent = String(roles.length);
    $('#roles-custom-total').textContent = String(roles.filter(role => !role.preset).length);
    $('#roles-capabilities-total').textContent = String(state.payload?.all_capabilities?.length || 0);
  }

  function roleSelectOptions(selected, includeOwner = false) {
    return activeRoles()
      .filter(role => includeOwner || role.name !== 'owner')
      .map(role => `<option value="${escapeHtml(role.name)}" ${role.name === selected ? 'selected' : ''}>${escapeHtml(role.name)}</option>`)
      .join('');
  }

  function renderRoles() {
    const manageable = canManage();
    createButton.hidden = !manageable;
    const roles = state.payload?.roles || [];
    list.innerHTML = roles.map(role => {
      const capabilities = role.capabilities || [];
      const stateLabel = role.preset ? 'Padrão' : (role.is_active ? 'Ativa' : 'Inativa');
      const actions = role.preset
        ? `<button type="button" data-copy-role="${escapeHtml(role.name)}">Duplicar</button>`
        : manageable
          ? `<button type="button" data-edit-role="${role.id}">Editar</button><button type="button" data-toggle-role="${role.id}">${role.is_active ? 'Desativar' : 'Ativar'}</button><button class="danger-action" type="button" data-delete-role="${role.id}">Excluir</button>`
          : '';
      return `<article class="role-card ${role.is_active === false ? 'is-inactive' : ''}">
        <div class="role-card-head"><div><span class="role-state">${stateLabel}</span><h3>${escapeHtml(role.name)}</h3></div><strong>${capabilities.length}</strong></div>
        <p>${capabilities.slice(0, 6).map(capability => escapeHtml(LABELS[capability] || capability)).join(' · ') || 'Nenhuma capacidade'}</p>
        ${capabilities.length > 6 ? `<small>+${capabilities.length - 6} capacidades</small>` : '<small>&nbsp;</small>'}
        <div class="role-card-actions">${actions}</div>
      </article>`;
    }).join('') || '<div class="empty-state">Nenhuma role disponível.</div>';

    list.querySelectorAll('[data-copy-role]').forEach(button => button.onclick = () => openRoleDialog(
      state.payload.roles.find(role => role.name === button.dataset.copyRole), true,
    ));
    list.querySelectorAll('[data-edit-role]').forEach(button => button.onclick = () => openRoleDialog(
      state.payload.roles.find(role => String(role.id) === button.dataset.editRole), false,
    ));
    list.querySelectorAll('[data-toggle-role]').forEach(button => button.onclick = () => toggleRole(button.dataset.toggleRole));
    list.querySelectorAll('[data-delete-role]').forEach(button => button.onclick = () => deleteRole(button.dataset.deleteRole));
  }

  function renderMembers() {
    const manageable = canManage();
    memberForm.hidden = !manageable;
    memberRole.innerHTML = roleSelectOptions('editor');
    membersList.innerHTML = state.members.map(member => {
      const owner = member.role === 'owner';
      const control = manageable && !owner
        ? `<select data-role-member="${member.id}">${roleSelectOptions(member.role)}</select>`
        : `<span class="role-pill">${escapeHtml(member.role)}</span>`;
      return `<div class="role-member-row"><div><strong>${escapeHtml(member.email)}</strong><small>${member.invited_by_email ? `Adicionado por ${escapeHtml(member.invited_by_email)}` : owner ? 'Proprietário do projeto' : ''}</small></div>${control}</div>`;
    }).join('') || '<div class="empty-state">Nenhum membro cadastrado.</div>';
    membersList.querySelectorAll('[data-role-member]').forEach(control => {
      control.onchange = async () => {
        control.disabled = true;
        try {
          await api(`/api/projects/${state.projectId}/access-members/${control.dataset.roleMember}`, {
            method: 'PATCH', body: JSON.stringify({ role: control.value }),
          });
          setStatus('Role do membro atualizada.');
          await load();
        } catch (error) {
          setStatus(error.message, true);
          await load();
        }
      };
    });
  }

  function renderCapabilities(selected = []) {
    const selectedSet = new Set(selected);
    const allowed = new Set(state.payload?.all_capabilities || []);
    capabilitiesRoot.innerHTML = GROUPS.map(([group, capabilities]) => {
      const available = capabilities.filter(capability => allowed.has(capability));
      if (!available.length) return '';
      return `<fieldset><legend>${group}</legend>${available.map(capability => `<label><input type="checkbox" name="capability" value="${capability}" ${selectedSet.has(capability) ? 'checked' : ''}><span>${escapeHtml(LABELS[capability] || capability)}</span><code>${capability}</code></label>`).join('')}</fieldset>`;
    }).join('');
  }

  function openRoleDialog(role = null, copy = false) {
    state.editingRole = role && !copy && !role.preset ? role : null;
    dialogTitle.textContent = state.editingRole ? 'Editar role' : role ? `Duplicar ${role.name}` : 'Nova role';
    nameInput.value = state.editingRole ? role.name : '';
    nameInput.disabled = false;
    renderCapabilities(role?.capabilities || []);
    dialog.showModal();
    requestAnimationFrame(() => nameInput.focus());
  }

  async function saveRole(event) {
    event.preventDefault();
    saveButton.disabled = true;
    try {
      const capabilities = [...form.querySelectorAll('[name="capability"]:checked')].map(input => input.value);
      const payload = { name: nameInput.value.trim(), capabilities };
      const endpoint = state.editingRole
        ? `/api/projects/${state.projectId}/roles/${state.editingRole.id}`
        : `/api/projects/${state.projectId}/roles`;
      await api(endpoint, { method: state.editingRole ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      dialog.close();
      setStatus('Role salva com sucesso.');
      await load();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function toggleRole(id) {
    const role = state.payload.roles.find(item => String(item.id) === String(id));
    if (!role) return;
    await api(`/api/projects/${state.projectId}/roles/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !role.is_active }) });
    setStatus(`Role ${role.is_active ? 'desativada' : 'ativada'}.`);
    await load();
  }

  async function deleteRole(id) {
    const role = state.payload.roles.find(item => String(item.id) === String(id));
    if (!role || !confirm(`Excluir permanentemente a role ${role.name}?`)) return;
    try {
      await api(`/api/projects/${state.projectId}/roles/${id}`, { method: 'DELETE' });
      setStatus('Role excluída.');
      await load();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function addMember(event) {
    event.preventDefault();
    const submit = memberForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/projects/${state.projectId}/access-members`, {
        method: 'POST', body: JSON.stringify({ email: memberEmail.value.trim(), role: memberRole.value }),
      });
      memberEmail.value = '';
      setStatus('Membro adicionado ou atualizado.');
      await load();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      submit.disabled = false;
    }
  }

  async function load() {
    const projectId = Number(select.value || 0);
    if (!projectId) return;
    state.projectId = projectId;
    setStatus('Carregando roles e membros…');
    try {
      const [payload, members] = await Promise.all([
        api(`/api/projects/${projectId}/roles`),
        api(`/api/projects/${projectId}/members`),
      ]);
      state.payload = payload;
      state.members = members.members || [];
      nav.hidden = false;
      updateSummary();
      renderRoles();
      renderMembers();
      setStatus(canManage() ? 'Administração completa disponível.' : 'Visualização das roles do projeto.');
    } catch (error) {
      state.payload = null;
      state.members = [];
      if (error.status === 403) {
        nav.hidden = true;
        if (view.classList.contains('active')) document.querySelector('[data-view="files"]')?.click();
      }
      list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      membersList.innerHTML = '';
      setStatus(error.message, true);
    }
  }

  createButton.onclick = () => openRoleDialog();
  form.addEventListener('submit', saveRole);
  dialog.querySelector('[data-role-cancel]').onclick = () => dialog.close();
  memberForm.addEventListener('submit', addMember);
  nav.addEventListener('click', () => load().catch(error => setStatus(error.message, true)));
  select.addEventListener('change', () => {
    if (view.classList.contains('active')) load().catch(error => setStatus(error.message, true));
  });

  window.SuperExcelAuth?.ready?.then(() => {
    const wait = () => Number(select.value || 0) ? load() : setTimeout(wait, 50);
    wait();
  }).catch(error => setStatus(error.message, true));
})();
