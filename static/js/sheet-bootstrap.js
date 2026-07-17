(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const legacyCollaboration = new URLSearchParams(window.location.search).get('collab') === 'v2';
  const DEFAULT_ROWS = 60;
  const DEFAULT_COLS = 26;
  const MAX_ROWS = 5000;
  const MAX_COLS = 300;

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function dimensionsFromPayload(payload) {
    const cells = Array.isArray(payload?.cells) ? payload.cells : [];
    let lastRow = -1;
    let lastCol = -1;
    const sparse = payload?.storage === 'sparse' || (cells.length > 0 && !Array.isArray(cells[0]));
    if (sparse) {
      for (const item of cells) {
        const row = Number(item?.r);
        const col = Number(item?.c);
        if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
        lastRow = Math.max(lastRow, row);
        lastCol = Math.max(lastCol, col);
      }
    } else {
      cells.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) return;
        row.forEach((value, colIndex) => {
          if (value === null || value === undefined || value === '') return;
          lastRow = Math.max(lastRow, rowIndex);
          lastCol = Math.max(lastCol, colIndex);
        });
      });
    }
    return {
      rows: Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, positiveInteger(payload?.rows, DEFAULT_ROWS), lastRow + 1)),
      cols: Math.min(MAX_COLS, Math.max(DEFAULT_COLS, positiveInteger(payload?.cols, DEFAULT_COLS), lastCol + 1)),
    };
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = path;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Não foi possível carregar ${path}.`));
      document.body.append(script);
    });
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || `Erro ao carregar ${path}.`);
    return output;
  }

  async function initialize() {
    await window.SuperExcelAuth.ready;
    let workbook = { version: 2, storage: 'sparse', name: 'Minha Planilha', rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: [] };
    let meta = { revision: 0, project_id: null, role: 'editor', capabilities: [], realtime_topic: null };

    if (workbookId) {
      const [output, collaboration, access] = await Promise.all([
        fetchJson(`/api/workbooks/${workbookId}`),
        fetchJson(`/api/workbooks/${workbookId}/collaboration-config`),
        fetchJson(`/api/workbooks/${workbookId}/capabilities`),
      ]);
      workbook = output.data || workbook;
      workbook.name = output.name || workbook.name || 'Minha Planilha';
      meta = {
        revision: Number(output.revision || collaboration.revision || 1),
        project_id: output.project_id || collaboration.project_id,
        role: output.role || collaboration.role || 'viewer',
        capabilities: access.capabilities || output.capabilities || collaboration.capabilities || [],
        updated_at: output.updated_at,
        updated_by_email: output.updated_by_email,
        realtime_topic: collaboration.realtime_topic,
      };
    }

    window.SuperExcelInitialWorkbook = workbook;
    window.SuperExcelInitialMeta = meta;
    window.SuperExcelGridSize = Object.freeze(dimensionsFromPayload(workbook));

    if (legacyCollaboration) {
      await loadScript('/static/js/app-v2.js');
      await loadScript('/static/js/sheet-collaboration-v2.js');
      return;
    }

    await loadScript('/static/js/grid/sparse-store.js');
    await loadScript('/static/js/grid/viewport.js');
    await loadScript('/static/js/collab-operation.js');
    await loadScript('/static/js/collab-operation-store.js');
    await loadScript('/static/js/app-v3.js');
    await loadScript('/static/js/sheet-capabilities.js');
    await loadScript('/static/js/sheet-collaboration-v3.js');
  }

  initialize().catch(error => {
    console.error(error);
    document.body.classList.remove('sheet-loading');
    const status = document.querySelector('#status-message');
    if (status) { status.textContent = error.message || 'Erro ao abrir a planilha.'; status.classList.add('error'); }
  });
})();
