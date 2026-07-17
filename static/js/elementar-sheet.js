(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const declarationPattern = /^\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.-]*)\s*=\s*'((?:[^']|'')+)'\s*!\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\s*$/iu;
  const state = { config: null, preview: null, role: 'viewer', initialized: false };
  const $ = selector => document.querySelector(selector);
  const panel = $('#elementar-panel');
  const modeButton = $('#elementar-mode-button');
  const enableButton = $('#elementar-enable-button');
  const previewButton = $('#elementar-preview-button');
  const publishButton = $('#elementar-publish-button');
  const settingsButton = $('#elementar-settings-button');
  const status = $('#elementar-status');
  const endpoint = $('#elementar-endpoint');
  const version = $('#elementar-version');
  const slugInput = $('#elementar-slug');
  const visibilitySelect = $('#elementar-visibility');
  const previewDialog = $('#elementar-preview-dialog');
  const previewCode = $('#elementar-preview-json');
  const previewSummary = $('#elementar-preview-summary');
  const settingsDialog = $('#elementar-settings-dialog');

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
    return data;
  }

  function can(required) {
    return roleRank[state.role] >= roleRank[required];
  }

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', error);
  }

  function absoluteUrl(path) {
    return path ? new URL(path, location.origin).href : '';
  }

  function currentEndpoint() {
    if (!state.config) return '';
    return absoluteUrl(state.config.visibility === 'public'
      ? state.config.public_endpoint
      : state.config.authenticated_endpoint);
  }

  function renderConfig() {
    if (!state.config?.enabled) {
      panel.hidden = true;
      modeButton.hidden = true;
      enableButton.hidden = !can('editor');
      document.body.classList.remove('elementar-workbook');
      return;
    }
    document.body.classList.add('elementar-workbook');
    panel.hidden = false;
    modeButton.hidden = false;
    enableButton.hidden = true;
    modeButton.textContent = '◈ Elementar';
    modeButton.classList.add('active');
    publishButton.disabled = !can('editor') || !state.preview;
    previewButton.disabled = !can('editor');
    settingsButton.disabled = !can('editor');
    const rotateButton = $('#elementar-rotate-token');
    const disableButton = $('#elementar-disable');
    if (rotateButton) rotateButton.hidden = !can('admin');
    if (disableButton) disableButton.disabled = !can('editor');
    if (slugInput) slugInput.value = state.config.slug || '';
    if (visibilitySelect) visibilitySelect.value = state.config.visibility || 'private';
    if (endpoint) {
      endpoint.textContent = currentEndpoint() || 'Publique e escolha a visibilidade para gerar o endpoint.';
      endpoint.title = endpoint.textContent;
    }
    if (version) {
      version.textContent = state.config.last_publication_version
        ? `v${state.config.last_publication_version}`
        : 'Não publicada';
    }
    const latest = state.config.publication;
    if (latest?.created_at) {
      setStatus(`Última publicação em ${new Date(latest.created_at).toLocaleString('pt-BR')}.`);
    } else {
      setStatus('Declare os elementos, gere uma prévia e publique o JSON.');
    }
  }

  function colIndex(name) {
    let result = 0;
    for (const letter of String(name).replaceAll('$', '').toUpperCase()) {
      result = result * 26 + letter.charCodeAt(0) - 64;
    }
    return result - 1;
  }

  function parseCellAddress(value) {
    const match = String(value).replaceAll('$', '').toUpperCase().match(/^([A-Z]{1,3})(\d+)$/u);
    if (!match) throw new Error(`Endereço de célula inválido: ${value}.`);
    return { row: Number(match[2]) - 1, col: colIndex(match[1]) };
  }

  function parseRange(value) {
    const [startText, endText = startText] = String(value).split(':');
    const start = parseCellAddress(startText);
    const end = parseCellAddress(endText);
    return {
      top: Math.min(start.row, end.row),
      bottom: Math.max(start.row, end.row),
      left: Math.min(start.col, end.col),
      right: Math.max(start.col, end.col),
    };
  }

  function cellAddress(row, col) {
    let name = '';
    for (let number = col + 1; number; number = Math.floor((number - 1) / 26)) {
      name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
    }
    return `${name}${row + 1}`;
  }

  function payloadEntries(snapshot) {
    const cells = Array.isArray(snapshot?.cells) ? snapshot.cells : [];
    const sparse = snapshot?.storage === 'sparse' || (cells.length > 0 && !Array.isArray(cells[0]));
    if (sparse) {
      return cells.map(item => ({
        row: Number(item?.r),
        col: Number(item?.c),
        value: item?.v ?? item?.value ?? null,
      })).filter(item => Number.isInteger(item.row) && Number.isInteger(item.col) && item.row >= 0 && item.col >= 0);
    }
    const entries = [];
    cells.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, col) => {
        if (!isBlank(value)) entries.push({ row: rowIndex, col, value });
      });
    });
    return entries;
  }

  function payloadMatrix(payload) {
    const entries = payloadEntries(payload);
    let lastRow = -1;
    let lastCol = -1;
    entries.forEach(item => {
      lastRow = Math.max(lastRow, item.row);
      lastCol = Math.max(lastCol, item.col);
    });
    if (lastRow < 0 || lastCol < 0) return [];
    const matrix = Array.from({ length: lastRow + 1 }, () => Array(lastCol + 1).fill(null));
    entries.forEach(item => { matrix[item.row][item.col] = item.value; });
    return matrix;
  }

  function parseDeclarations(snapshot) {
    const declarations = [];
    const seen = new Set();
    const invalid = [];
    payloadEntries(snapshot).forEach(({ row: rowIndex, col: colIndexValue, value }) => {
      if (typeof value !== 'string') return;
      const text = value.trim();
      if (!text || text.startsWith('#') || text.startsWith('//')) return;
      const match = text.match(declarationPattern);
      if (!match) {
        if (text.includes('=') || text.includes('!')) invalid.push(cellAddress(rowIndex, colIndexValue));
        return;
      }
      const key = match[1];
      if (seen.has(key)) throw new Error(`O elemento ${key} foi declarado mais de uma vez.`);
      seen.add(key);
      declarations.push({
        key,
        workbook_name: match[2].replaceAll("''", "'"),
        range: match[3].replaceAll('$', '').toUpperCase(),
        cell: cellAddress(rowIndex, colIndexValue),
      });
    });
    if (invalid.length) {
      throw new Error(`Declaração inválida em ${invalid.slice(0, 6).join(', ')}. Use nome='Planilha'!A1:D100.`);
    }
    if (!declarations.length) {
      throw new Error("Nenhuma declaração encontrada. Exemplo: pedidos='Planilha de Pedidos'!A1:D100");
    }
    return declarations;
  }

  function isBlank(value) {
    return value === null || value === undefined || value === '';
  }

  function jsonValue(engine, row, col, sourceName) {
    const coordinate = { sheet: 0, row, col };
    let value = engine.getCellValue(coordinate);
    if (value && value.__superexcelTyped) value = value.value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) value = value.value;
    if (typeof value === 'string' && value.startsWith('#')) {
      throw new Error(`${sourceName}!${cellAddress(row, col)} contém o erro ${value}.`);
    }
    if (typeof value === 'number') {
      const detailedType = String(engine.getCellValueDetailedType?.(coordinate) || '');
      if (detailedType.includes('DATE')) {
        const date = new Date(Date.UTC(1899, 11, 30));
        date.setUTCDate(date.getUTCDate() + Math.floor(value));
        return date.toISOString().slice(0, 10);
      }
      if (!Number.isFinite(value)) throw new Error(`${sourceName}!${cellAddress(row, col)} não é um número JSON válido.`);
    }
    if (value === undefined) return null;
    return value;
  }

  function trimVector(values) {
    const result = [...values];
    while (result.length && isBlank(result[result.length - 1])) result.pop();
    return result;
  }

  function matrixToJson(matrix) {
    if (matrix.length === 1 && matrix[0].length === 1) return matrix[0][0];
    if (matrix.length === 1) return trimVector(matrix[0]);
    if (matrix.every(row => row.length === 1)) return trimVector(matrix.map(row => row[0]));

    const headers = matrix[0].map(value => String(value ?? '').trim());
    const uniqueHeaders = new Set(headers);
    const validHeaders = headers.every(Boolean) && uniqueHeaders.size === headers.length;
    if (validHeaders) {
      return matrix.slice(1)
        .filter(row => row.some(value => !isBlank(value)))
        .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
    }
    return matrix.filter(row => row.some(value => !isBlank(value)));
  }

  function setNested(target, path, value) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) throw new Error('Nome de elemento inválido.');
    let current = target;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (last) {
        if (Object.prototype.hasOwnProperty.call(current, part)) throw new Error(`Conflito no elemento ${path}.`);
        current[part] = value;
        return;
      }
      if (current[part] === undefined) current[part] = {};
      if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
        throw new Error(`O caminho ${path} entra em conflito com outro elemento.`);
      }
      current = current[part];
    });
  }

  async function buildPreview() {
    if (!window.SuperExcelApp) throw new Error('A planilha ainda está carregando.');
    const snapshot = window.SuperExcelApp.getSnapshot();
    const declarations = parseDeclarations(snapshot);
    setStatus('Carregando e calculando as planilhas de origem...');
    const resolved = await api(`/api/elementar/workbooks/${workbookId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ references: declarations }),
    });
    const sourceMap = new Map(resolved.sources.map(source => [Number(source.id), source]));
    const engines = new Map();
    const result = {};
    let selectedCells = 0;
    try {
      for (const declaration of resolved.references) {
        const source = sourceMap.get(Number(declaration.workbook_id));
        if (!source) throw new Error(`Origem ausente para ${declaration.key}.`);
        let engine = engines.get(Number(source.id));
        if (!engine) {
          engine = window.SuperExcelFormulaEngine.create(payloadMatrix(source.payload || {}));
          engines.set(Number(source.id), engine);
        }
        const bounds = parseRange(declaration.range);
        const count = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
        selectedCells += count;
        if (selectedCells > 100000) throw new Error('A Elementar excede 100.000 células selecionadas.');
        const matrix = [];
        for (let row = bounds.top; row <= bounds.bottom; row += 1) {
          const values = [];
          for (let col = bounds.left; col <= bounds.right; col += 1) {
            values.push(jsonValue(engine, row, col, source.name));
          }
          matrix.push(values);
        }
        setNested(result, declaration.key, matrixToJson(matrix));
      }
    } finally {
      engines.forEach(engine => engine.destroy());
    }

    state.preview = {
      payload: result,
      declarations: resolved.references,
      definitionRevision: Number(resolved.definition_revision),
      sources: resolved.sources.map(source => ({ id: Number(source.id), revision: Number(source.revision) })),
      selectedCells,
    };
    publishButton.disabled = !can('editor');
    previewCode.textContent = JSON.stringify(result, null, 2);
    previewSummary.textContent = `${resolved.references.length} elemento(s) · ${resolved.sources.length} origem(ns) · ${selectedCells.toLocaleString('pt-BR')} célula(s)`;
    previewDialog.showModal();
    setStatus('Prévia gerada. Revise o JSON antes de publicar.');
    return state.preview;
  }

  async function publish() {
    const preview = state.preview || await buildPreview();
    setStatus('Publicando JSON...');
    publishButton.disabled = true;
    try {
      const output = await api(`/api/elementar/workbooks/${workbookId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          payload: preview.payload,
          declarations: preview.declarations,
          definition_revision: preview.definitionRevision,
          sources: preview.sources,
        }),
      });
      state.config = { enabled: true, role: state.role, ...output };
      state.preview = null;
      renderConfig();
      setStatus(`Versão ${output.last_publication_version} publicada com sucesso.`);
      previewDialog.close();
    } finally {
      publishButton.disabled = !can('editor') || !state.preview;
    }
  }

  async function loadConfig() {
    const output = await api(`/api/elementar/workbooks/${workbookId}`);
    state.role = output.role || 'viewer';
    state.config = output;
    renderConfig();
  }

  enableButton?.addEventListener('click', async () => {
    enableButton.disabled = true;
    try {
      const output = await api(`/api/elementar/workbooks/${workbookId}/enable`, { method: 'POST', body: '{}' });
      state.config = { enabled: true, role: state.role, ...output };
      renderConfig();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      enableButton.disabled = false;
    }
  });

  modeButton?.addEventListener('click', () => panel?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  previewButton?.addEventListener('click', () => buildPreview().catch(error => setStatus(error.message, true)));
  publishButton?.addEventListener('click', () => publish().catch(error => setStatus(error.message, true)));
  settingsButton?.addEventListener('click', () => settingsDialog?.showModal());

  $('#elementar-copy-endpoint')?.addEventListener('click', async () => {
    const value = currentEndpoint();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Endpoint copiado.');
    } catch {
      window.prompt('Copie o endpoint:', value);
    }
  });

  settingsDialog?.querySelector('form')?.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const output = await api(`/api/elementar/workbooks/${workbookId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ slug: slugInput.value, visibility: visibilitySelect.value }),
      });
      state.config = { enabled: true, role: state.role, ...output };
      renderConfig();
      settingsDialog.close();
      setStatus('Configurações salvas.');
    } catch (error) {
      $('#elementar-settings-error').textContent = error.message;
    }
  });

  $('#elementar-rotate-token')?.addEventListener('click', async () => {
    if (!confirm('Trocar o token invalida imediatamente o endpoint público anterior. Continuar?')) return;
    try {
      const output = await api(`/api/elementar/workbooks/${workbookId}/rotate-token`, { method: 'POST', body: '{}' });
      state.config = { enabled: true, role: state.role, ...output };
      renderConfig();
      setStatus('Token público trocado.');
    } catch (error) {
      $('#elementar-settings-error').textContent = error.message;
    }
  });

  $('#elementar-disable')?.addEventListener('click', async () => {
    if (!confirm('Desativar o formato Elementar? As publicações e o endpoint serão removidos. A planilha continuará existindo.')) return;
    try {
      await api(`/api/elementar/workbooks/${workbookId}`, { method: 'DELETE' });
      state.config = { enabled: false, role: state.role };
      state.preview = null;
      renderConfig();
      settingsDialog.close();
      setStatus('Formato Elementar desativado.');
    } catch (error) {
      $('#elementar-settings-error').textContent = error.message;
    }
  });

  document.querySelectorAll('[data-close-elementar-dialog]').forEach(button => {
    button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeElementarDialog}`)?.close());
  });

  window.addEventListener('superexcel:changes', () => {
    if (!state.preview) return;
    state.preview = null;
    publishButton.disabled = true;
    setStatus('A definição mudou. Gere uma nova prévia antes de publicar.');
  });

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    await window.SuperExcelAuth.ready;
    await loadConfig();
  }

  initialize().catch(error => setStatus(error.message, true));
})();
