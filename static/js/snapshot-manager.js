(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const numberFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 10 });
  const dateFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' });
  let hydrated = false;
  let timer = null;
  let saving = false;

  function displayValue(row, col, fallback) {
    const runtime = window.SuperExcelActiveRuntime;
    if (!runtime?.getCellValue) return fallback == null ? '' : String(fallback);
    try {
      const coordinate = { sheet: 0, row, col };
      const value = runtime.getCellValue(coordinate);
      if (value == null) return '';
      if (typeof value === 'object' && value.value !== undefined) return String(value.value);
      if (typeof value === 'boolean') return value ? 'VERDADEIRO' : 'FALSO';
      if (typeof value === 'number') {
        const type = String(runtime.getCellValueDetailedType?.(coordinate) || '');
        if (type.includes('DATE')) {
          const date = new Date(Date.UTC(1899, 11, 30));
          date.setUTCDate(date.getUTCDate() + Math.floor(value));
          return dateFormatter.format(date);
        }
        return numberFormatter.format(value);
      }
      return String(value);
    } catch {
      return fallback == null ? '' : String(fallback);
    }
  }

  function sourceEntries(payload) {
    const output = [];
    const values = Array.isArray(payload?.cells) ? payload.cells : [];
    const sparse = payload?.storage === 'sparse' || (values.length > 0 && !Array.isArray(values[0]));
    if (sparse) {
      for (const item of values) {
        const row = Number(item?.r);
        const col = Number(item?.c);
        if (Number.isInteger(row) && Number.isInteger(col)) output.push({ row, col, value: item?.v });
      }
      return output;
    }
    values.forEach((rowValues, row) => {
      if (!Array.isArray(rowValues)) return;
      rowValues.forEach((value, col) => output.push({ row, col, value }));
    });
    return output;
  }

  function capture() {
    const app = window.SuperExcelApp;
    if (!app) return null;
    const logicalRows = Math.max(1, Number(app.rows) || 60);
    const logicalCols = Math.max(1, Number(app.cols) || 26);
    const visibleRows = Math.min(120, logicalRows);
    const visibleCols = Math.min(50, logicalCols);
    const captured = new Map();

    document.querySelectorAll('#spreadsheet .cell').forEach(element => {
      const row = Number(element.dataset.row);
      const col = Number(element.dataset.col);
      if (row >= visibleRows || col >= visibleCols) return;
      const display = element.textContent || '';
      if (display) captured.set(`${row}:${col}`, { r: row, c: col, d: display });
    });

    const payload = app.getSnapshot?.();
    for (const item of sourceEntries(payload)) {
      if (item.row < 0 || item.col < 0 || item.row >= visibleRows || item.col >= visibleCols) continue;
      const key = `${item.row}:${item.col}`;
      if (captured.has(key)) continue;
      const display = displayValue(item.row, item.col, item.value);
      if (display) captured.set(key, { r: item.row, c: item.col, d: display });
    }

    return {
      version: 1,
      name: document.querySelector('#workbook-name')?.value || 'Planilha',
      rows: logicalRows,
      cols: logicalCols,
      visible_rows: visibleRows,
      visible_cols: visibleCols,
      cells: [...captured.values()].sort((left, right) => left.r - right.r || left.c - right.c),
      generated_at: new Date().toISOString(),
    };
  }

  async function saveServer(snapshot) {
    if (!hydrated || saving || !snapshot || !navigator.onLine) return;
    saving = true;
    try {
      const pending = await window.SuperExcelOperationStore?.count?.(workbookId) || 0;
      if (pending > 0) {
        window.setTimeout(() => saveServer(snapshot), 1000);
        return;
      }

      const configResponse = await fetch(`/api/workbooks/${workbookId}/collaboration-config`);
      const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(config.error || 'Falha ao obter revisão atual.');
      const response = await fetch(`/api/workbooks/${workbookId}/render-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: Number(config.revision || 0), payload: snapshot }),
        keepalive: true,
      });
      if (response.status === 409) return;
      if (!response.ok) {
        const output = await response.json().catch(() => ({}));
        throw new Error(output.error || 'Falha ao salvar snapshot visual.');
      }
    } catch (error) {
      console.debug('Snapshot visual não foi enviado.', error);
    } finally {
      saving = false;
    }
  }

  function persist() {
    clearTimeout(timer);
    timer = null;
    const snapshot = capture();
    if (!snapshot) return;
    window.SuperExcelSnapshotBoot?.saveLocal(snapshot);
    saveServer(snapshot);
  }

  function schedule(delay = 500) {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(persist, { timeout: 1200 });
      else persist();
    }, delay);
  }

  window.addEventListener('superexcel:hydrated', () => {
    hydrated = true;
    window.SuperExcelSnapshotBoot?.hide();
    schedule(150);
  });
  window.addEventListener('superexcel:changes', () => schedule(450));
  window.addEventListener('superexcel:rendered', () => schedule(450));
  window.addEventListener('superexcel:name', () => schedule(450));
  window.addEventListener('beforeunload', () => {
    const snapshot = capture();
    if (snapshot) window.SuperExcelSnapshotBoot?.saveLocal(snapshot);
  });
})();
