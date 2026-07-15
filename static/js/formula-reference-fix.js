(() => {
  'use strict';

  const grid = document.querySelector('#spreadsheet');
  const formulaInput = document.querySelector('#formula-input');
  if (!grid || !formulaInput) return;

  let activeReference = null;
  let pendingFormulaPointer = false;

  function clearActiveReference() {
    activeReference = null;
  }

  function isFormulaPickingMode() {
    return document.activeElement === formulaInput && formulaInput.value.trimStart().startsWith('=');
  }

  function selectionIsAtReferenceEnd() {
    if (!activeReference) return false;
    return (
      formulaInput.value === activeReference.formula &&
      formulaInput.selectionStart === activeReference.end &&
      formulaInput.selectionEnd === activeReference.end
    );
  }

  function rememberLastReference() {
    const caret = formulaInput.selectionStart ?? formulaInput.value.length;
    const beforeCaret = formulaInput.value.slice(0, caret);
    const match = beforeCaret.match(/(?:^|[^A-Z0-9_])([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?)$/iu);

    if (!match) {
      clearActiveReference();
      return;
    }

    const reference = match[1];
    const end = caret;
    const start = end - reference.length;
    activeReference = {
      start,
      end,
      formula: formulaInput.value,
    };
  }

  grid.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || !event.target.closest('.cell')) return;

      if (!isFormulaPickingMode()) {
        pendingFormulaPointer = false;
        clearActiveReference();
        return;
      }

      // Enquanto o usuário não digitou um operador ou separador novo,
      // um novo clique substitui a referência escolhida anteriormente.
      if (selectionIsAtReferenceEnd()) {
        formulaInput.setSelectionRange(activeReference.start, activeReference.end);
      } else if (activeReference) {
        clearActiveReference();
      }

      pendingFormulaPointer = true;
    },
    true
  );

  window.addEventListener('mouseup', () => {
    if (!pendingFormulaPointer) return;
    pendingFormulaPointer = false;

    // O app posiciona o cursor via requestAnimationFrame ao terminar o arraste.
    // Este segundo callback roda depois e memoriza exatamente o intervalo inserido.
    requestAnimationFrame(() => {
      if (isFormulaPickingMode()) rememberLastReference();
      else clearActiveReference();
    });
  });

  formulaInput.addEventListener('input', clearActiveReference);
  formulaInput.addEventListener('pointerdown', clearActiveReference);
  formulaInput.addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) clearActiveReference();
  });
})();
