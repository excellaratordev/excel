(() => {
  'use strict';

  const meta = window.SuperExcelInitialMeta || {};
  const capabilities = new Set(meta.capabilities || []);
  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  const canEdit = capabilities.has('cell.edit') || (!workbookId && meta.role !== 'viewer');
  if (canEdit) return;

  const formula = document.querySelector('#formula-input');
  const cellEditor = document.querySelector('.virtual-grid-editor');
  const grid = document.querySelector('#spreadsheet');
  const status = document.querySelector('#status-message');
  const nameInput = document.querySelector('#workbook-name');

  document.body.classList.add('sheet-readonly');
  if (formula) formula.disabled = true;
  if (cellEditor) cellEditor.disabled = true;
  if (nameInput) nameInput.disabled = true;

  for (const selector of [
    '#new-button', '#clear-button', '#example-button', '#import-input',
    '#undo-button', '#redo-button', '#save-button',
  ]) {
    const element = document.querySelector(selector);
    if (element) element.disabled = true;
  }

  const block = event => {
    if (event.type === 'keydown') {
      const modifier = event.ctrlKey || event.metaKey;
      const editingKey = ['Delete', 'Backspace', 'F2'].includes(event.key)
        || (modifier && event.key.toLowerCase() === 'x')
        || (!modifier && !event.altKey && event.key.length === 1);
      if (!editingKey) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (status) {
      status.textContent = 'Você não possui a capacidade cell.edit';
      status.classList.add('error');
    }
  };

  grid?.addEventListener('dblclick', block, true);
  grid?.addEventListener('keydown', block, true);
  grid?.addEventListener('paste', block, true);
  grid?.addEventListener('cut', block, true);
  grid?.addEventListener('drop', block, true);
  formula?.addEventListener('beforeinput', block, true);
  cellEditor?.addEventListener('beforeinput', block, true);
  nameInput?.addEventListener('beforeinput', block, true);

  const banner = document.createElement('div');
  banner.className = 'viewer-banner';
  banner.textContent = 'Você possui acesso somente para visualização.';
  document.body.append(banner);
})();
