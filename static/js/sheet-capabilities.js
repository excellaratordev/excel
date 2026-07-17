(() => {
  'use strict';
  const capabilities = new Set(window.SuperExcelInitialMeta?.capabilities || []);
  if (!capabilities.size || capabilities.has('cell.edit')) return;
  const formula = document.querySelector('#formula-input');
  const grid = document.querySelector('#spreadsheet');
  const status = document.querySelector('#status-message');
  document.body.classList.add('sheet-readonly');
  if (formula) formula.disabled = true;
  for (const selector of ['#new-button', '#clear-button', '#example-button', '#import-input', '#undo-button', '#redo-button', '#save-button']) {
    const element = document.querySelector(selector);
    if (element) element.disabled = true;
  }
  const block = event => {
    const keyAllowed = event.type !== 'keydown' || (!['Delete', 'Backspace', 'F2'].includes(event.key) && (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1));
    if (keyAllowed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (status) status.textContent = 'Você não possui a capacidade cell.edit';
  };
  grid?.addEventListener('dblclick', block, true);
  grid?.addEventListener('keydown', block, true);
  grid?.addEventListener('paste', block, true);
})();
