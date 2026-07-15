(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const saveButton = document.querySelector('#save-button');
  const undoButton = document.querySelector('#undo-button');
  const redoButton = document.querySelector('#redo-button');
  const nameInput = document.querySelector('#workbook-name');
  const status = document.querySelector('#status-message');
  const AUTOSAVE = 'super-excel-autosave-v1';
  const PRELOAD_MARKER = 'super-excel-preloaded-workbook';

  async function preloadWorkbook() {
    try {
      await window.SuperExcelAuth.ready;

      if (!workbookId) {
        document.body.classList.remove('sheet-loading');
        return;
      }

      if (sessionStorage.getItem(PRELOAD_MARKER) === String(workbookId)) {
        sessionStorage.removeItem(PRELOAD_MARKER);
        document.body.classList.remove('sheet-loading');
        return;
      }

      status.textContent = 'Carregando planilha...';
      const response = await fetch(`/api/workbooks/${workbookId}`);
      const output = await response.json();
      if (!response.ok) throw new Error(output.error || 'Erro ao abrir planilha.');

      const workbook = output.data || {};
      workbook.name = output.name || workbook.name || 'Minha Planilha';
      localStorage.setItem(AUTOSAVE, JSON.stringify(workbook));
      sessionStorage.setItem(PRELOAD_MARKER, String(workbookId));
      window.location.reload();
    } catch (error) {
      console.error(error);
      document.body.classList.remove('sheet-loading');
      status.textContent = error.message;
      status.classList.add('error');
      window.setTimeout(() => window.location.replace('/files'), 2500);
    }
  }

  preloadWorkbook();

  if (saveButton && workbookId) {
    saveButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await window.SuperExcelAuth.ready;
        status.textContent = 'Salvando...';
        status.classList.remove('error');
        const data = JSON.parse(localStorage.getItem(AUTOSAVE) || '{}');
        const response = await fetch('/api/workbooks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: workbookId, name: nameInput.value.trim(), data }),
        });
        const output = await response.json();
        if (!response.ok) throw new Error(output.error || 'Erro ao salvar.');
        status.textContent = `Planilha salva: ${output.name}`;
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('error');
      }
    }, true);
  }

  document.addEventListener('keydown', (event) => {
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
    }
  }, true);
})();
