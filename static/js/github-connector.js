(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const state = {
    projectId: null,
    role: 'viewer',
    connection: null,
    files: [],
    loading: false,
    reloadTimer: null,
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function hasRole(required) {
    return roleRank[state.role] >= roleRank[required];
  }

  function projectContext() {
    const projectId = Number($('#project-select')?.value || 0);
    const role = document.body.dataset.projectRole || 'viewer';
    return { projectId, role };
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString('pt-BR') : 'Ainda não sincronizado';
  }

  function setMessage(message = '', type = '') {
    const element = $('#github-message');
    if (!element) return;
    element.textContent = message;
    element.className = `integration-message${type ? ` ${type}` : ''}`;
  }

  function renderFiles() {
    const list = $('#github-files-list');
    const count = $('#github-file-count');
    if (!list || !count) return;
    count.textContent = `${state.files.length} HTML${state.files.length === 1 ? '' : 's'}`;
    list.innerHTML = state.files.length
      ? state.files.map(file => `
          <div class="github-file-row">
            <div>
              <strong>${escapeHtml(file.name)}</strong>
              <span>${escapeHtml(file.path)}</span>
            </div>
            <span>${formatBytes(file.size_bytes)}</span>
            <code>${escapeHtml(String(file.commit_sha || '').slice(0, 8))}</code>
            <span>${escapeHtml(formatDate(file.synced_at))}</span>
          </div>
        `).join('')
      : '<div class="empty-row github-empty">Nenhum HTML encontrado dentro de uma pasta templates.</div>';
  }

  function renderConnection(data) {
    state.connection = data.connection;
    state.files = data.files || [];
    state.role = data.role || state.role;

    const disconnected = $('#github-disconnected');
    const connected = $('#github-connected');
    const unconfigured = $('#github-unconfigured');
    const connectButton = $('#github-connect');
    const syncButton = $('#github-sync');
    const disconnectButton = $('#github-disconnect');

    unconfigured.hidden = data.configured;
    disconnected.hidden = !data.configured || Boolean(state.connection);
    connected.hidden = !state.connection;

    connectButton.disabled = !hasRole('admin') || !data.configured;
    syncButton.disabled = !hasRole('editor') || !state.connection;
    disconnectButton.disabled = !hasRole('admin') || !state.connection;

    if (!state.connection) {
      renderFiles();
      return;
    }

    $('#github-repository').textContent = state.connection.repository_full_name;
    $('#github-repository-link').href = `https://github.com/${state.connection.repository_full_name}`;
    $('#github-branch').textContent = state.connection.branch;
    $('#github-status').textContent = state.connection.status === 'active'
      ? 'Ativo'
      : state.connection.status === 'syncing'
        ? 'Sincronizando'
        : 'Erro';
    $('#github-last-sync').textContent = formatDate(state.connection.last_sync_at);
    $('#github-last-sha').textContent = state.connection.last_sync_sha
      ? state.connection.last_sync_sha.slice(0, 12)
      : '—';

    if (state.connection.last_error) setMessage(state.connection.last_error, 'error');
    else setMessage('Somente arquivos .html dentro de pastas templates são sincronizados.', 'success');

    renderFiles();
  }

  async function loadConnection() {
    const context = projectContext();
    if (!context.projectId || state.loading) return;
    state.projectId = context.projectId;
    state.role = context.role;
    state.loading = true;
    try {
      const data = await api(`/api/github/connection?project_id=${state.projectId}`);
      if (state.projectId !== projectContext().projectId) return;
      renderConnection(data);
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      state.loading = false;
    }
  }

  function scheduleLoad() {
    window.clearTimeout(state.reloadTimer);
    state.reloadTimer = window.setTimeout(loadConnection, 80);
  }

  $('#github-connect').onclick = async () => {
    const repository = $('#github-repository-input').value.trim();
    const branch = $('#github-branch-input').value.trim();
    if (!repository) {
      setMessage('Informe o repositório no formato proprietário/repositorio.', 'error');
      return;
    }
    const button = $('#github-connect');
    button.disabled = true;
    setMessage('Abrindo o GitHub para instalar o conector...');
    try {
      const result = await api('/api/github/connect', {
        method: 'POST',
        body: JSON.stringify({
          project_id: state.projectId,
          repository,
          branch: branch || null,
        }),
      });
      window.location.assign(result.authorization_url);
    } catch (error) {
      setMessage(error.message, 'error');
      button.disabled = !hasRole('admin');
    }
  };

  $('#github-sync').onclick = async () => {
    const button = $('#github-sync');
    button.disabled = true;
    setMessage('Sincronizando os HTMLs do repositório...');
    try {
      const result = await api('/api/github/sync', {
        method: 'POST',
        body: JSON.stringify({ project_id: state.projectId }),
      });
      setMessage(`${result.files} HTMLs sincronizados.`, 'success');
      await loadConnection();
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      button.disabled = !hasRole('editor');
    }
  };

  $('#github-disconnect').onclick = async () => {
    if (!window.confirm('Desconectar este repositório do projeto? Os HTMLs importados também serão removidos.')) return;
    const button = $('#github-disconnect');
    button.disabled = true;
    try {
      await api('/api/github/connection', {
        method: 'DELETE',
        body: JSON.stringify({ project_id: state.projectId }),
      });
      setMessage('Repositório desconectado.', 'success');
      await loadConnection();
    } catch (error) {
      setMessage(error.message, 'error');
      button.disabled = !hasRole('admin');
    }
  };

  const select = $('#project-select');
  if (select) {
    select.addEventListener('change', scheduleLoad);
    new MutationObserver(scheduleLoad).observe(select, { childList: true, subtree: true, attributes: true });
  }
  new MutationObserver(scheduleLoad).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-project-role'],
  });

  const params = new URLSearchParams(window.location.search);
  if (params.has('github') || params.has('github_error')) {
    const nav = document.querySelector('.nav[data-view="github"]');
    nav?.click();
    if (params.get('github') === 'connected') setMessage('GitHub conectado e sincronizado.', 'success');
    if (params.get('github_error')) setMessage(params.get('github_error'), 'error');
    window.history.replaceState({}, '', '/files');
  }

  window.SuperExcelAuth.ready.then(scheduleLoad).catch(error => setMessage(error.message, 'error'));
})();
