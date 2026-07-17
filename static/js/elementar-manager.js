(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const context = { projectId: null, folderId: null, workbooks: [], elementarIds: new Set() };

  function api(url, options = {}) {
    return nativeFetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    }).then(async response => {
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
      return data;
    });
  }

  function decorateWorkbooks() {
    const cards = [...document.querySelectorAll('#items .workbook-item')];
    cards.forEach((card, index) => {
      const workbook = context.workbooks[index];
      if (!workbook) return;
      card.dataset.workbookId = String(workbook.id);
      card.querySelector('.elementar-badge')?.remove();
      const icon = card.querySelector('.icon');
      if (context.elementarIds.has(Number(workbook.id))) {
        if (icon) icon.textContent = '◈';
        const badge = document.createElement('span');
        badge.className = 'elementar-badge';
        badge.textContent = 'Elementar';
        card.querySelector('strong')?.insertAdjacentElement('afterend', badge);
      } else if (icon) {
        icon.textContent = '📊';
      }
    });
  }

  async function refreshElementarIds() {
    if (!context.projectId) return;
    try {
      const list = await api(`/api/elementar?project_id=${context.projectId}`);
      context.elementarIds = new Set(list.map(item => Number(item.workbook_id)));
      window.setTimeout(decorateWorkbooks, 0);
      window.setTimeout(decorateWorkbooks, 80);
    } catch (error) {
      console.debug('Não foi possível carregar os marcadores Elementar.', error);
    }
  }

  window.fetch = async function elementarAwareFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
      if (url.origin === location.origin && url.pathname === '/api/manager' && response.ok) {
        context.projectId = Number(url.searchParams.get('project_id')) || null;
        context.folderId = Number(url.searchParams.get('folder_id')) || null;
        response.clone().json().then(data => {
          context.workbooks = Array.isArray(data?.workbooks) ? data.workbooks : [];
          refreshElementarIds();
        }).catch(console.debug);
      }
    } catch (error) {
      console.debug(error);
    }
    return response;
  };

  const button = document.querySelector('#new-elementar');
  const dialog = document.querySelector('#elementar-create-dialog');
  const form = dialog?.querySelector('form');
  const nameInput = dialog?.querySelector('[name="name"]');
  const saveButton = dialog?.querySelector('[data-elementar-create]');
  const errorMessage = dialog?.querySelector('[data-elementar-create-error]');

  function updateCapability() {
    if (!button) return;
    const role = document.body.dataset.projectRole || 'viewer';
    button.disabled = !['editor', 'admin', 'owner'].includes(role);
  }

  new MutationObserver(updateCapability).observe(document.body, { attributes: true, attributeFilter: ['data-project-role'] });
  updateCapability();

  button?.addEventListener('click', () => {
    if (!dialog) return;
    if (nameInput) nameInput.value = 'Nova Elementar';
    if (errorMessage) errorMessage.textContent = '';
    dialog.showModal();
    requestAnimationFrame(() => nameInput?.focus());
  });

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!context.projectId) {
      if (errorMessage) errorMessage.textContent = 'Aguarde o carregamento do projeto.';
      return;
    }
    const name = String(new FormData(form).get('name') || '').trim();
    if (!name) return;
    saveButton.disabled = true;
    if (errorMessage) errorMessage.textContent = '';
    try {
      const workbook = await api('/api/workbooks', {
        method: 'POST',
        body: JSON.stringify({
          project_id: context.projectId,
          folder_id: context.folderId,
          name,
        }),
      });
      await api(`/api/elementar/workbooks/${workbook.id}/enable`, { method: 'POST', body: '{}' });
      location.href = `/sheet/${workbook.id}`;
    } catch (error) {
      if (errorMessage) errorMessage.textContent = error.message;
    } finally {
      saveButton.disabled = false;
    }
  });

  dialog?.querySelector('[data-elementar-cancel]')?.addEventListener('click', () => dialog.close());
})();
