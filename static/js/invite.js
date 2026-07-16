(() => {
  'use strict';

  const code = document.documentElement.dataset.inviteCode || '';
  const title = document.querySelector('#invite-title');
  const status = document.querySelector('#invite-status');
  const errorElement = document.querySelector('#invite-error');
  const retry = document.querySelector('#invite-retry');
  const PROJECT_STORAGE = 'super-excel-current-project';

  async function acceptInvite() {
    retry.hidden = true;
    errorElement.textContent = '';
    title.textContent = 'Aceitando convite...';
    status.textContent = 'Estamos vinculando sua conta Google ao projeto compartilhado.';

    await window.SuperExcelAuth.ready;
    const response = await fetch(`/api/share-links/${encodeURIComponent(code)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Não foi possível aceitar o convite.');

    localStorage.setItem(PROJECT_STORAGE, String(output.project_id));
    title.textContent = 'Convite aceito';
    status.textContent = `Abrindo o projeto ${output.project_name || 'compartilhado'}...`;
    window.setTimeout(() => window.location.replace('/files'), 700);
  }

  retry.addEventListener('click', () => {
    acceptInvite().catch(showError);
  });

  function showError(error) {
    console.error(error);
    title.textContent = 'Não foi possível aceitar o convite';
    status.textContent = 'Confira se o link ainda está válido e tente novamente.';
    errorElement.textContent = error.message;
    retry.hidden = false;
  }

  acceptInvite().catch(showError);
})();
