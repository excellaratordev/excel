(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const declarationPattern = /^\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.-]*)\s*=\s*'((?:[^']|'')+)'\s*!\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\s*$/iu;
  const LIVE_REFRESH_MS = 8000;
  const LIVE_DEBOUNCE_MS = 420;

  const state = {
    config: null,
    preview: null,
    role: 'viewer',
    initialized: false,
    refreshTimer: null,
    refreshSequence: 0,
    liveInterval: null,
  };

  const $ = selector => document.querySelector(selector);
  const panel = $('#elementar-panel');
  const modeButton = $('#elementar-mode-button');
  const enableButton = $('#elementar-enable-button');
  const publishButton = $('#elementar-publish-button');
  const settingsButton = $('#elementar-settings-button');
  const status = $('#elementar-status');
  const endpoint = $('#elementar-endpoint');
  const version = $('#elementar-version');
  const slugInput = $('#elementar-slug');
  const visibilitySelect = $('#elementar-visibility');
  const settingsDialog = $('#elementar-settings-dialog');
  const livePanel = $('#elementar-live-panel');
  const liveCode = $('#elementar-live-json');
  const liveSummary = $('#elementar-live-summary');
  const liveState = $('#elementar-live-state');
  const liveRefreshButton = $('#elementar-live-refresh');
  const liveCopyButton = $('#elementar-live-copy');

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
    return data;
  }

  function can(required) { return roleRank[state.role] >= roleRank[required]; }

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', error);
  }

  function setLiveState(message, mode = 'idle') {
    if (liveState) liveState.textContent = message;
    if (livePanel) livePanel.dataset.liveState = mode;
  }

  function absoluteUrl(path) { return path ? new URL(path, location.origin).href : ''; }

  function currentEndpoint() {
    if (!state.config) return '';
    return absoluteUrl(state.config.visibility === 'public'
      ? state.config.public_endpoint
      : state.config.authenticated_endpoint);
  }

  function stopLivePolling() {
    if (state.liveInterval) window.clearInterval(state.liveInterval);
    state.liveInterval = null;
  }

  function ensureLivePolling() {
    stopLivePolling();
    if (!state.config?.enabled) return;
    state.liveInterval = window.setInterval(() => {
      if (document.hidden || state.refreshTimer) return;
      refreshLivePreview({ announce: false, preserveWhileLoading: true });
    }, LIVE_REFRESH_MS);
  }

  function renderConfig() {
    if (!state.config?.enabled) {
      panel.hidden = true;
      livePanel.hidden = true;
      modeButton.hidden = true;
      enableButton.hidden = !can('editor');
      document.body.classList.remove('elementar-workbook');
      stopLivePolling();
      return;
    }

    document.body.classList.add('elementar-workbook');
    panel.hidden = false;
    livePanel.hidden = false;
    modeButton.hidden = false;
    enableButton.hidden = true;
    modeButton.textContent = '◈ Elementar';
    modeButton.classList.add('active');
    publishButton.disabled = !can('editor') || !state.preview;
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
    setStatus(latest?.created_at
      ? `Última publicação em ${new Date(latest.created_at).toLocaleString('pt-BR')}. O JSON à direita é atualizado ao vivo.`
      : 'O JSON à direita é atualizado ao vivo. Publique quando estiver pronto.');
    ensureLivePolling();
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

  function isBlank(value) { return value === null || value === undefined || value === ''; }

  function payloadEntries(snapshot) {
    const cells = Array.isArray(snapshot?.cells) ? snapshot.cells : [];
    const sparse = snapshot?.storage === 'sparse' || (cells.length > 0 && !Array.isArray(cells[0]));
    if (sparse) {
      return cells
        .map(item => ({ row: Number(item?.r), col: Number(item?.c), value: item?.v ?? item?.value ?? null }))
        .filter(item => Number.isInteger(item.row) && Number.isInteger(item.col) && item.row >= 0 && item.col >= 0);
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
    payloadEntries(snapshot).forEach(({ row, col, value }) => {
      if (typeof value !== 'string') return;
      const text = value.trim();
      if (!text || text.startsWith('#') || text.startsWith('//')) return;
      const match = text.match(declarationPattern);
      if (!match) {
        if (text.includes('=') || text.includes('!')) invalid.push(cellAddress(row, col));
        return;
      }
      const key = match[1];
      if (seen.has(key)) throw new Error(`O elemento ${key} foi declarado mais de uma vez.`);
      seen.add(key);
      declarations.push({
        key,
        workbook_name: match[2].replaceAll("''", "'"),
        range: match[3].replaceAll('$', '').toUpperCase(),
        cell: cellAddress(row, col),
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
      if (!Number.isFinite(value)) {
        throw new Error(`${sourceName}!${cellAddress(row, col)} não é um número JSON válido.`);
      }
    }
    return value === undefined ? null : value;
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
    const validHeaders = headers.every(Boolean) && new Set(headers).size === headers.length;
    if (validHeaders) {
      return matrix
        .slice(1)
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
        if (Object.prototype.hasOwnProperty.call(current, part)) {
          throw new Error(`Conflito no elemento ${path}.`);
        }
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

  function renderLivePreview(preview) {
    if (!preview) return;
    if (liveCode) liveCode.textContent = JSON.stringify(preview.payload, null, 2);
    if (liveSummary) {
      liveSummary.textContent = `${preview.declarations.length} elemento(s) · ${preview.sources.length} origem(ns) · ${preview.selectedCells.toLocaleString('pt-BR')} célula(s)`;
    }
    if (liveCopyButton) liveCopyButton.disabled = false;
    setLiveState(`Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ready');
  }

  function renderLiveError(error) {
    if (liveCode) liveCode.textContent = `// JSON indisponível\n// ${error.message || 'Não foi possível gerar a saída.'}`;
    if (liveSummary) liveSummary.textContent = 'Corrija a declaração ou a planilha de origem para continuar.';
    if (liveCopyButton) liveCopyButton.disabled = true;
    setLiveState('JSON inválido', 'error');
  }

  function invalidatePreview(message = 'Atualizando…') {
    state.refreshSequence += 1;
    state.preview = null;
    publishButton.disabled = true;
    if (liveCopyButton) liveCopyButton.disabled = true;
    setLiveState(message, 'pending');
  }

  async function buildPreview({ announce = false, preserveWhileLoading = false } = {}) {
    if (!window.SuperExcelApp) throw new Error('A planilha ainda está carregando.');
    const sequence = ++state.refreshSequence;
    const declarations = parseDeclarations(window.SuperExcelApp.getSnapshot());

    if (!preserveWhileLoading && liveCode) liveCode.textContent = '// Gerando JSON ao vivo…';
    setLiveState('Atualizando…', 'loading');
    if (announce) setStatus('Carregando e calculando as planilhas de origem...');

    const resolved = await api(`/api/elementar/workbooks/${workbookId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ references: declarations }),
    });
    if (sequence !== state.refreshSequence) return null;

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
        selectedCells += (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
        if (selectedCells > 100000) {
          throw new Error('A Elementar excede 100.000 células selecionadas.');
        }

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

    if (sequence !== state.refreshSequence) return null;
    const preview = {
      payload: result,
      declarations: resolved.references,
      definitionRevision: Number(resolved.definition_revision),
      sources: resolved.sources.map(source => ({ id: Number(source.id), revision: Number(source.revision) })),
      selectedCells,
    };
    state.preview = preview;
    publishButton.disabled = !can('editor');
    renderLivePreview(preview);
    if (announce) setStatus('JSON ao vivo atualizado. Publique quando estiver pronto.');
    return preview;
  }

  async function refreshLivePreview(options = {}) {
    if (!state.config?.enabled) return null;
    const expectedSequence = state.refreshSequence + 1;
    try {
      return await buildPreview(options);
    } catch (error) {
      if (state.refreshSequence !== expectedSequence) return null;
      state.preview = null;
      publishButton.disabled = true;
      renderLiveError(error);
      setStatus(error.message || 'Não foi possível gerar o JSON.', true);
      return null;
    }
  }

  function scheduleLivePreview(delay = LIVE_DEBOUNCE_MS) {
    if (!state.config?.enabled) return;
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    invalidatePreview('Alterações pendentes');
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      refreshLivePreview({ announce: false });
    }, delay);
  }

  async function publish() {
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }
    const preview = await refreshLivePreview({ announce: true, preserveWhileLoading: true });
    if (!preview) throw new Error('O JSON precisa estar válido antes da publicação.');

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
      state.preview = preview;
      renderConfig();
      renderLivePreview(preview);
      setStatus(`Versão ${output.last_publication_version} publicada com sucesso.`);
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

  function waitForHydration() {
    if (window.SuperExcelApp && !document.body.classList.contains('sheet-loading')) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(finish, 12000);
      window.addEventListener('superexcel:hydrated', finish, { once: true });
    });
  }

  enableButton?.addEventListener('click', async () => {
    enableButton.disabled = true;
    try {
      const output = await api(`/api/elementar/workbooks/${workbookId}/enable`, {
        method: 'POST',
        body: '{}',
      });
      state.config = { enabled: true, role: state.role, ...output };
      renderConfig();
      await waitForHydration();
      refreshLivePreview({ announce: true });
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      enableButton.disabled = false;
    }
  });

  modeButton?.addEventListener('click', () => {
    livePanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  });
  publishButton?.addEventListener('click', () => publish().catch(error => setStatus(error.message, true)));
  settingsButton?.addEventListener('click', () => settingsDialog?.showModal());
  liveRefreshButton?.addEventListener('click', () => refreshLivePreview({ announce: true }));

  liveCopyButton?.addEventListener('click', async () => {
    if (!state.preview) return;
    const json = JSON.stringify(state.preview.payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      const previous = liveCopyButton.textContent;
      liveCopyButton.textContent = 'Copiado';
      window.setTimeout(() => { liveCopyButton.textContent = previous; }, 1400);
    } catch {
      window.prompt('Copie o JSON:', json);
    }
  });

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
      const output = await api(`/api/elementar/workbooks/${workbookId}/rotate-token`, {
        method: 'POST',
        body: '{}',
      });
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
    button.addEventListener('click', () => {
      document.querySelector(`#${button.dataset.closeElementarDialog}`)?.close();
    });
  });

  window.addEventListener('superexcel:changes', () => scheduleLivePreview());
  window.addEventListener('superexcel:hydrated', () => {
    if (state.config?.enabled) scheduleLivePreview(80);
  });
  window.addEventListener('focus', () => {
    if (state.config?.enabled && !state.refreshTimer) {
      refreshLivePreview({ announce: false, preserveWhileLoading: true });
    }
  });
  window.addEventListener('online', () => {
    if (state.config?.enabled) refreshLivePreview({ announce: false });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.config?.enabled && !state.refreshTimer) {
      refreshLivePreview({ announce: false, preserveWhileLoading: true });
    }
  });
  window.addEventListener('pagehide', stopLivePolling);

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    await window.SuperExcelAuth.ready;
    await loadConfig();
    if (!state.config?.enabled) return;
    await waitForHydration();
    await refreshLivePreview({ announce: false });
  }

  initialize().catch(error => {
    renderLiveError(error);
    setStatus(error.message, true);
  });
})();
