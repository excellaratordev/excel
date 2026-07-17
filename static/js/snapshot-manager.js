(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  let hydrated = false;
  let timer = null;
  let saving = false;

  function capture() {
    const app = window.SuperExcelApp;
    if (!app) return null;
    const maxRows = Math.min(120, Number(app.rows) || 60);
    const maxCols = Math.min(50, Number(app.cols) || 26);
    const cells = [];
    document.querySelectorAll('#spreadsheet .cell').forEach(element => {
      const row = Number(element.dataset.row);
      const col = Number(element.dataset.col);
      if (row >= maxRows || col >= maxCols) return;
      const display = element.textContent || '';
      if (!display) return;
      cells.push({ r: row, c: col, d: display });
    });
    return {
      version: 1,
      name: document.querySelector('#workbook-name')?.value || 'Planilha',
      rows: maxRows,
      cols: maxCols,
      cells,
      generated_at: new Date().toISOString(),
    };
  }

  async function saveServer(snapshot) {
    if (!hydrated || saving || !snapshot || !navigator.onLine) return;
    saving = true;
    try {
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
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(persist, { timeout: 1200 });
      } else {
        persist();
      }
    }, delay);
  }

  window.addEventListener('superexcel:hydrated', () => {
    hydrated = true;
    window.SuperExcelSnapshotBoot?.hide();
    schedule(150);
  });
  window.addEventListener('superexcel:changes', () => schedule(450));
  window.addEventListener('superexcel:name', () => schedule(450));
  window.addEventListener('beforeunload', () => {
    const snapshot = capture();
    if (snapshot) window.SuperExcelSnapshotBoot?.saveLocal(snapshot);
  });
})();
