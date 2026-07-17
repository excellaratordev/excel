(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  const storageKey = workbookId ? `superexcel:render-snapshot:${workbookId}` : null;
  const layer = document.querySelector('#snapshot-layer');
  let current = null;

  function valid(snapshot) {
    return Boolean(snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.cells));
  }

  function readLocal() {
    if (!storageKey) return null;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return valid(value) ? value : null;
    } catch {
      return null;
    }
  }

  function render(snapshot, source = 'local') {
    if (!layer || !valid(snapshot)) return false;
    current = snapshot;
    const rows = Math.max(1, Math.min(120, Number(snapshot.rows) || 60));
    const cols = Math.max(1, Math.min(50, Number(snapshot.cols) || 26));
    const values = new Map();
    for (const item of snapshot.cells) {
      const row = Number(item?.r);
      const col = Number(item?.c);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rows || col >= cols) continue;
      values.set(`${row}:${col}`, String(item?.d ?? ''));
    }

    const shell = document.createElement('div');
    shell.className = 'snapshot-shell';
    const header = document.createElement('div');
    header.className = 'snapshot-header';
    const title = document.createElement('strong');
    title.textContent = snapshot.name || 'Planilha';
    const state = document.createElement('span');
    state.textContent = source === 'server' ? 'Abrindo versão salva…' : 'Abrindo instantaneamente…';
    header.append(title, state);

    const viewport = document.createElement('div');
    viewport.className = 'snapshot-viewport';
    const table = document.createElement('table');
    table.className = 'snapshot-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.append(document.createElement('th'));
    for (let col = 0; col < cols; col += 1) {
      const th = document.createElement('th');
      let name = '';
      for (let value = col + 1; value; value = Math.floor((value - 1) / 26)) {
        name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
      }
      th.textContent = name;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (let row = 0; row < rows; row += 1) {
      const tr = document.createElement('tr');
      const rowHeader = document.createElement('th');
      rowHeader.textContent = String(row + 1);
      tr.append(rowHeader);
      for (let col = 0; col < cols; col += 1) {
        const td = document.createElement('td');
        td.textContent = values.get(`${row}:${col}`) || '';
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    viewport.append(table);
    shell.append(header, viewport);
    layer.replaceChildren(shell);
    layer.hidden = false;
    document.body.classList.add('snapshot-visible');
    return true;
  }

  function hide() {
    if (!layer) return;
    layer.hidden = true;
    document.body.classList.remove('snapshot-visible');
  }

  function saveLocal(snapshot) {
    if (!storageKey || !valid(snapshot)) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
      current = snapshot;
    } catch (error) {
      console.debug('Snapshot local não pôde ser salvo.', error);
    }
  }

  window.SuperExcelSnapshotBoot = Object.freeze({
    render,
    hide,
    saveLocal,
    readLocal,
    get current() { return current; },
  });

  const local = readLocal();
  if (local) render(local, 'local');
})();
