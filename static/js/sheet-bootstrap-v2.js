(() => {
  'use strict';

  const root = document.documentElement;
  const workbookId = Number(root.dataset.workbookId || 0);
  const legacyCollaboration = new URLSearchParams(window.location.search).get('collab') === 'v2';
  const DEFAULT_ROWS = 60;
  const DEFAULT_COLS = 26;
  const SOFT_ROWS = 250;
  const SOFT_COLS = 40;
  const MAX_ROWS = 5000;
  const MAX_COLS = 300;

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function columnIndex(name) {
    let result = 0;
    for (const letter of String(name).toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
    return Math.max(0, result - 1);
  }

  function dimensionsFromPayload(payload) {
    const cells = Array.isArray(payload?.cells) ? payload.cells : [];
    const declaredRows = positiveInteger(payload?.rows, cells.length || DEFAULT_ROWS);
    const declaredCols = positiveInteger(
      payload?.cols,
      cells.reduce((largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 0), DEFAULT_COLS),
    );
    let lastUsedRow = -1;
    let lastUsedCol = -1;
    let lastReferencedRow = -1;
    let lastReferencedCol = -1;
    const referencePattern = /\$?([A-Z]{1,3})\$?(\d+)/giu;

    cells.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, colIndex) => {
        if (value === null || value === undefined || value === '') return;
        lastUsedRow = Math.max(lastUsedRow, rowIndex);
        lastUsedCol = Math.max(lastUsedCol, colIndex);
        if (typeof value !== 'string' || !value.trimStart().startsWith('=')) return;
        referencePattern.lastIndex = 0;
        let match;
        while ((match = referencePattern.exec(value)) !== null) {
          lastReferencedCol = Math.max(lastReferencedCol, columnIndex(match[1]));
          lastReferencedRow = Math.max(lastReferencedRow, Number(match[2]) - 1);
        }
      });
    });

    return {
      rows: Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, Math.min(declaredRows, SOFT_ROWS), lastUsedRow + 31, lastReferencedRow + 1)),
      cols: Math.min(MAX_COLS, Math.max(DEFAULT_COLS, Math.min(declaredCols, SOFT_COLS), lastUsedCol + 8, lastReferencedCol + 1)),
    };
  }

  function dimensionsFromRenderSnapshot(snapshot) {
    return {
      rows: Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, positiveInteger(snapshot?.rows, DEFAULT_ROWS))),
      cols: Math.min(MAX_COLS, Math.max(DEFAULT_COLS, positiveInteger(snapshot?.cols, DEFAULT_COLS))),
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

  async function fetchJson(path, allowEmpty = false) {
    const response = await fetch(path);
    if (allowEmpty && response.status === 204) return null;
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || `Erro ao carregar ${path}.`);
    return output;
  }

  async function initialize() {
    await window.SuperExcelAuth.ready;

    let renderSnapshot = window.SuperExcelSnapshotBoot?.current || null;
    if (workbookId) {
      try {
        const serverSnapshot = await fetchJson(`/api/workbooks/${workbookId}/render-snapshot`, true);
        if (serverSnapshot?.payload) {
          renderSnapshot = serverSnapshot.payload;
          window.SuperExcelSnapshotBoot?.render(renderSnapshot, 'server');
          window.SuperExcelSnapshotBoot?.saveLocal(renderSnapshot);
        }
      } catch (error) {
        console.debug('Snapshot remoto indisponível; usando cache local.', error);
      }
    }

    window.SuperExcelInitialWorkbook = {
      version: 1,
      name: renderSnapshot?.name || 'Minha Planilha',
      rows: renderSnapshot?.rows || DEFAULT_ROWS,
      cols: renderSnapshot?.cols || DEFAULT_COLS,
      cells: [],
    };
    window.SuperExcelInitialMeta = { revision: 0, project_id: null, role: 'viewer', realtime_topic: null };
    window.SuperExcelGridSize = Object.freeze(
      renderSnapshot ? dimensionsFromRenderSnapshot(renderSnapshot) : { rows: DEFAULT_ROWS, cols: DEFAULT_COLS },
    );

    if (!legacyCollaboration) {
      await loadScript('/static/js/collab-operation.js');
      await loadScript('/static/js/collab-operation-store.js');
    }
    await loadScript('/static/js/app-v2.js');

    if (!workbookId) {
      document.body.classList.remove('sheet-loading');
      window.dispatchEvent(new CustomEvent('superexcel:hydrated', { detail: { revision: 0 } }));
      return;
    }

    const [output, collaboration] = await Promise.all([
      fetchJson(`/api/workbooks/${workbookId}`),
      fetchJson(`/api/workbooks/${workbookId}/collaboration-config`),
    ]);
    const workbook = output.data || { version: 1, cells: [] };
    workbook.name = output.name || workbook.name || 'Minha Planilha';
    window.SuperExcelInitialWorkbook = workbook;
    window.SuperExcelInitialMeta = {
      revision: Number(output.revision || collaboration.revision || 1),
      project_id: output.project_id || collaboration.project_id,
      role: output.role || collaboration.role || 'viewer',
      updated_at: output.updated_at,
      updated_by_email: output.updated_by_email,
      realtime_topic: collaboration.realtime_topic,
    };

    const actualDimensions = dimensionsFromPayload(workbook);
    const currentDimensions = window.SuperExcelGridSize || {};
    if (actualDimensions.rows > Number(currentDimensions.rows || 0) || actualDimensions.cols > Number(currentDimensions.cols || 0)) {
      console.warn('A planilha excede a grade criada pelo snapshot; a grade virtualizada eliminará esta limitação.');
    }

    window.SuperExcelApp.replaceSnapshot(workbook);
    document.body.classList.remove('sheet-loading');
    window.dispatchEvent(new CustomEvent('superexcel:hydrated', {
      detail: { revision: window.SuperExcelInitialMeta.revision },
    }));

    await loadScript(legacyCollaboration
      ? '/static/js/sheet-collaboration-v2.js'
      : '/static/js/sheet-collaboration-v3.js');
  }

  initialize().catch(error => {
    console.error(error);
    document.body.classList.remove('sheet-loading');
    window.SuperExcelSnapshotBoot?.hide();
    const status = document.querySelector('#status-message');
    if (status) {
      status.textContent = error.message || 'Erro ao abrir a planilha.';
      status.classList.add('error');
    }
  });
})();
