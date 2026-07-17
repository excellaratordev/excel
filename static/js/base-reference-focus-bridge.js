(() => {
  'use strict';

  const panel = document.querySelector('#base-reference-panel');
  const grid = document.querySelector('#base-reference-grid');
  const formula = document.querySelector('#formula-input');
  const select = document.querySelector('#base-reference-select');
  const openButton = document.querySelector('#base-reference-open-file');
  if (!panel || !grid || !formula) return;

  let caret = { start: 0, end: 0 };

  function remember(target) {
    if (!target || !Number.isInteger(target.selectionStart) || !Number.isInteger(target.selectionEnd)) return;
    caret = { start: target.selectionStart, end: target.selectionEnd };
  }

  ['input', 'select', 'keyup', 'pointerup', 'focus'].forEach(type => {
    formula.addEventListener(type, () => remember(formula));
  });

  document.addEventListener('blur', event => {
    const target = event.target;
    const related = event.relatedTarget;
    if (!(target === formula || target?.classList?.contains('virtual-grid-editor'))) return;
    if (!related || !panel.contains(related)) return;
    remember(target);
    event.stopImmediatePropagation();
  }, true);

  grid.addEventListener('pointerdown', () => {
    formula.focus({ preventScroll: true });
    const limit = formula.value.length;
    const start = Math.max(0, Math.min(limit, caret.start));
    const end = Math.max(start, Math.min(limit, caret.end));
    formula.setSelectionRange(start, end);
  }, true);

  openButton?.addEventListener('click', () => {
    const sourceId = Number(select?.value || 0);
    if (!sourceId) return;
    window.open(`/base/${sourceId}`, '_blank', 'noopener');
  });
})();
