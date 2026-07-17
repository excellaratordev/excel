(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  if (!engineApi?.create) throw new Error('Runtime de cálculo não foi carregado.');

  const numberFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 });
  const dateFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' });
  const originalCreate = engineApi.create.bind(engineApi);
  let scheduled = false;
  let activeRuntime = null;

  function displayValue(runtime, row, col) {
    const coordinate = { sheet: 0, row, col };
    const value = runtime.getCellValue(coordinate);
    if (value == null) return '';
    if (typeof value === 'object' && value.value !== undefined) return String(value.value);
    if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
    if (typeof value === 'number') {
      const type = String(runtime.getCellValueDetailedType(coordinate));
      if (type.includes('DATE')) {
        const date = new Date(Date.UTC(1899, 11, 30));
        date.setUTCDate(date.getUTCDate() + Math.floor(value));
        return dateFormatter.format(date);
      }
      return numberFormatter.format(value);
    }
    return String(value);
  }

  function renderAffected() {
    scheduled = false;
    const runtime = activeRuntime;
    if (!runtime?.consumeAffectedCells) return;

    const rendered = new Set();
    for (let round = 0; round < 4; round += 1) {
      const affected = runtime.consumeAffectedCells();
      if (!affected.length) break;

      for (const coordinate of affected) {
        const row = Number(coordinate.row);
        const col = Number(coordinate.col);
        const key = `${row}:${col}`;
        if (rendered.has(key)) continue;
        rendered.add(key);

        const target = document.querySelector(`#spreadsheet .cell[data-row="${row}"][data-col="${col}"]`);
        if (!target || target.classList.contains('editing')) continue;
        const value = displayValue(runtime, row, col);
        target.textContent = value;
        target.classList.toggle('error-cell', value.startsWith('#'));
      }
    }

    if (rendered.size) {
      window.dispatchEvent(new CustomEvent('superexcel:rendered', {
        detail: { cells: rendered.size },
      }));
    }
  }

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(renderAffected);
  }

  function install(runtime) {
    activeRuntime = runtime;
    for (const methodName of ['setCellContents', 'resumeEvaluation', 'undo', 'redo']) {
      const original = runtime[methodName]?.bind(runtime);
      if (!original) continue;
      runtime[methodName] = (...args) => {
        const result = original(...args);
        scheduleRender();
        return result;
      };
    }
    return runtime;
  }

  engineApi.create = data => install(originalCreate(data));
})();
