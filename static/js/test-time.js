(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const isBasePage = Boolean(document.querySelector('#base-grid-viewport'));
  const addressBox = document.querySelector('#cell-address');
  const liveJson = document.querySelector('#elementar-live-json');
  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const declarationPattern = /^\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.-]*)\s*=\s*'((?:[^']|'')+)'\s*!\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\s*$/iu;
  const ACTIVE_STATE_POLL_MS = 2500;
  const OPEN_PANEL_POLL_MS = 5000;
  const BASE_POLL_MS = 250;
  const SHEET_POLL_MS = 120;
  const MAX_PREVIEW_ITEMS = 24;

  const state = {
    workbook: null,
    session: null,
    groups: [],
    events: [],
    selection: null,
    panelOpen: false,
    selectMode: false,
    baseDrag: null,
    stateTimer: null,
    observeTimer: null,
    stateLoading: false,
    observing: false,
    localHashes: new Map(),
    localSamples: new Map(),
    pendingEpoch: new Map(),
    runKey: '',
    broadcast: null,
    initialized: false,
  };

  const ui = {};

  function epochNow() {
    if (Number.isFinite(performance.timeOrigin) && typeof performance.now === 'function') {
      return performance.timeOrigin + performance.now();
    }
    return Date.now();
  }

  function columnName(index) {
    let result = '';
    for (let number = Number(index) + 1; number; number = Math.floor((number - 1) / 26)) {
      result = String.fromCharCode(65 + ((number - 1) % 26)) + result;
    }
    return result;
  }

  function columnIndex(name) {
    let result = 0;
    for (const letter of String(name).replaceAll('$', '').toUpperCase()) {
      result = result * 26 + letter.charCodeAt(0) - 64;
    }
    return result - 1;
  }

  function parseCell(value) {
    const match = String(value || '').replaceAll('$', '').trim().toUpperCase().match(/^([A-Z]{1,3})([1-9]\d*)$/u);
    return match ? { row: Number(match[2]) - 1, col: columnIndex(match[1]) } : null;
  }

  function parseReference(value) {
    const [startText, endText = startText] = String(value || '').split(':');
    const start = parseCell(startText);
    const end = parseCell(endText);
    if (!start || !end) return null;
    return { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col };
  }

  function bounds(selection = state.selection) {
    if (!selection) return null;
    return {
      top: Math.min(selection.startRow, selection.endRow),
      bottom: Math.max(selection.startRow, selection.endRow),
      left: Math.min(selection.startCol, selection.endCol),
      right: Math.max(selection.startCol, selection.endCol),
    };
  }

  function reference(selection = state.selection) {
    const range = bounds(selection);
    if (!range) return '';
    const start = `${columnName(range.left)}${range.top + 1}`;
    const end = `${columnName(range.right)}${range.bottom + 1}`;
    return start === end ? start : `${start}:${end}`;
  }

  function intersects(group, row, col) {
    return row >= Number(group.top_row) && row <= Number(group.bottom_row)
      && col >= Number(group.left_col) && col <= Number(group.right_col);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      cache: options.cache || 'no-store',
      ...options,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro no Test Time.');
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function can(required) {
    return roleRank[state.workbook?.role || 'viewer'] >= roleRank[required];
  }

  function buildUi() {
    const actions = document.querySelector(isBasePage ? '.base-actions' : '.top-actions');
    if (!actions || document.querySelector('#test-time-button')) return;

    ui.button = document.createElement('button');
    ui.button.id = 'test-time-button';
    ui.button.type = 'button';
    ui.button.className = 'test-time-button';
    ui.button.innerHTML = '<span aria-hidden="true">⏱</span><span>Test Time</span><i aria-hidden="true"></i>';
    ui.button.setAttribute('aria-pressed', 'false');
    actions.prepend(ui.button);

    ui.panel = document.createElement('aside');
    ui.panel.id = 'test-time-panel';
    ui.panel.className = 'test-time-panel';
    ui.panel.hidden = true;
    ui.panel.innerHTML = `
      <header class="test-time-header">
        <div class="test-time-heading"><span class="test-time-mark">⏱</span><div><strong>Test Time</strong><small>Tempo entre as quatro fases</small></div></div>
        <button id="test-time-close" type="button" aria-label="Fechar Test Time">×</button>
      </header>
      <div class="test-time-body">
        <section class="test-time-card">
          <div class="test-time-title"><div><span id="test-time-session-state" class="test-time-state">Sem teste</span><strong id="test-time-session-name">Nenhuma sessão criada</strong></div><span id="test-time-stage" class="test-time-stage">Fase</span></div>
          <input id="test-time-name" maxlength="120" placeholder="Nome do teste, ex.: Pedido 1428">
          <div class="test-time-actions"><button id="test-time-new" type="button">Novo teste</button><button id="test-time-start" class="primary" type="button">Iniciar</button><button id="test-time-stop" type="button">Encerrar</button></div>
          <div id="test-time-clock" class="test-time-clock">Configure os grupos e inicie o teste.</div>
        </section>
        <section class="test-time-card">
          <div class="test-time-title"><strong>Células desta fase</strong><span id="test-time-current-reference" class="test-time-reference">Nenhuma seleção</span></div>
          <p class="test-time-help">Selecione uma célula ou intervalo. Qualquer alteração dentro do grupo será registrada.</p>
          <input id="test-time-group-name" maxlength="120" placeholder="Nome do grupo, ex.: Total calculado">
          <div class="test-time-actions two"><button id="test-time-select" type="button">Selecionar células</button><button id="test-time-add" class="primary" type="button">Adicionar à lista</button></div>
        </section>
        <section class="test-time-card"><div class="test-time-title"><strong>Lista monitorada</strong><span id="test-time-group-count">0 grupos</span></div><div id="test-time-groups" class="test-time-groups"></div></section>
        <section class="test-time-card"><div class="test-time-title"><strong>Linha do tempo</strong><span id="test-time-event-count">0 eventos</span></div><div class="test-time-timeline-head"><span>Fase e grupo</span><span>Horário exato</span><span>Desde início</span></div><div id="test-time-timeline" class="test-time-timeline"></div></section>
      </div>`;
    document.body.append(ui.panel);

    ui.selectionBar = document.createElement('div');
    ui.selectionBar.id = 'test-time-selection-bar';
    ui.selectionBar.className = 'test-time-selection-bar';
    ui.selectionBar.hidden = true;
    ui.selectionBar.innerHTML = '<div><span>⏱ Selecionando</span><strong id="test-time-selection-reference">A1</strong></div><div><button id="test-time-selection-cancel" type="button">Cancelar</button><button id="test-time-selection-done" class="primary" type="button">Concluir</button></div>';
    document.body.append(ui.selectionBar);

    Object.assign(ui, {
      close: ui.panel.querySelector('#test-time-close'),
      sessionState: ui.panel.querySelector('#test-time-session-state'),
      sessionName: ui.panel.querySelector('#test-time-session-name'),
      stage: ui.panel.querySelector('#test-time-stage'),
      nameInput: ui.panel.querySelector('#test-time-name'),
      newButton: ui.panel.querySelector('#test-time-new'),
      startButton: ui.panel.querySelector('#test-time-start'),
      stopButton: ui.panel.querySelector('#test-time-stop'),
      clock: ui.panel.querySelector('#test-time-clock'),
      currentReference: ui.panel.querySelector('#test-time-current-reference'),
      groupNameInput: ui.panel.querySelector('#test-time-group-name'),
      selectButton: ui.panel.querySelector('#test-time-select'),
      addButton: ui.panel.querySelector('#test-time-add'),
      groups: ui.panel.querySelector('#test-time-groups'),
      groupCount: ui.panel.querySelector('#test-time-group-count'),
      timeline: ui.panel.querySelector('#test-time-timeline'),
      eventCount: ui.panel.querySelector('#test-time-event-count'),
      selectionReference: ui.selectionBar.querySelector('#test-time-selection-reference'),
      selectionCancel: ui.selectionBar.querySelector('#test-time-selection-cancel'),
      selectionDone: ui.selectionBar.querySelector('#test-time-selection-done'),
    });

    ui.button.addEventListener('click', () => setPanelOpen(!state.panelOpen));
    ui.close.addEventListener('click', () => setPanelOpen(false));
    ui.newButton.addEventListener('click', createSession);
    ui.startButton.addEventListener('click', startSession);
    ui.stopButton.addEventListener('click', stopSession);
    ui.selectButton.addEventListener('click', beginSelection);
    ui.selectionCancel.addEventListener('click', cancelSelection);
    ui.selectionDone.addEventListener('click', finishSelection);
    ui.addButton.addEventListener('click', addGroup);
  }

  function setPanelOpen(open) {
    state.panelOpen = Boolean(open);
    ui.panel.hidden = !state.panelOpen;
    ui.button.classList.toggle('active', state.panelOpen);
    ui.button.setAttribute('aria-pressed', String(state.panelOpen));
    document.body.classList.toggle('test-time-panel-open', state.panelOpen);
    if (state.panelOpen) loadState(true);
    updateStatePolling();
  }

  function updateStatePolling() {
    if (state.stateTimer) window.clearInterval(state.stateTimer);
    state.stateTimer = null;
    const running = state.session?.status === 'running';
    const interval = running
      ? ACTIVE_STATE_POLL_MS
      : state.panelOpen
        ? OPEN_PANEL_POLL_MS
        : 0;
    if (!interval) return;
    state.stateTimer = window.setInterval(() => {
      if (!document.hidden) loadState(true);
    }, interval);
  }

  function setSelection(selection) {
    state.selection = selection;
    const text = reference();
    ui.currentReference.textContent = text || 'Nenhuma seleção';
    ui.selectionReference.textContent = text || 'Nenhuma seleção';
    ui.addButton.disabled = !text || !can('editor');
    renderBaseSelection();
  }

  function updateSheetSelection() {
    if (!addressBox) return;
    const selection = parseReference(addressBox.textContent.trim());
    if (selection) setSelection(selection);
  }

  function beginSelection() {
    state.selectMode = true;
    setPanelOpen(false);
    ui.selectionBar.hidden = false;
    document.body.classList.add('test-time-selecting');
    if (!isBasePage) {
      document.querySelector('#spreadsheet')?.focus({ preventScroll: true });
      updateSheetSelection();
    }
  }

  function finishSelection() {
    state.selectMode = false;
    state.baseDrag = null;
    ui.selectionBar.hidden = true;
    document.body.classList.remove('test-time-selecting');
    setPanelOpen(true);
  }

  function cancelSelection() {
    finishSelection();
  }

  function baseHit(target) {
    const cell = target?.closest?.('.base-grid-cell');
    const rowElement = cell?.closest?.('.base-grid-row');
    if (!cell || !rowElement || cell.classList.contains('system') || cell.classList.contains('action')) return null;
    const col = [...rowElement.children].indexOf(cell) - 1;
    const row = Number(rowElement.dataset.rowIndex);
    return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 ? { row, col } : null;
  }

  function renderBaseSelection() {
    if (!isBasePage) return;
    const range = bounds();
    document.querySelectorAll('.test-time-cell-selected,.test-time-range-top,.test-time-range-bottom,.test-time-range-left,.test-time-range-right').forEach(cell => {
      cell.classList.remove('test-time-cell-selected', 'test-time-range-top', 'test-time-range-bottom', 'test-time-range-left', 'test-time-range-right');
    });
    if (!range) return;
    document.querySelectorAll('.base-grid-row').forEach(rowElement => {
      const row = Number(rowElement.dataset.rowIndex);
      if (row < range.top || row > range.bottom) return;
      [...rowElement.children].forEach((cell, position) => {
        const col = position - 1;
        if (col < range.left || col > range.right || cell.classList.contains('system') || cell.classList.contains('action')) return;
        cell.classList.add('test-time-cell-selected');
        if (row === range.top) cell.classList.add('test-time-range-top');
        if (row === range.bottom) cell.classList.add('test-time-range-bottom');
        if (col === range.left) cell.classList.add('test-time-range-left');
        if (col === range.right) cell.classList.add('test-time-range-right');
      });
    });
  }

  function installSelectionBridges() {
    if (addressBox) {
      new MutationObserver(updateSheetSelection).observe(addressBox, { childList: true, characterData: true, subtree: true });
      document.addEventListener('mouseup', () => requestAnimationFrame(updateSheetSelection));
      document.addEventListener('keyup', () => requestAnimationFrame(updateSheetSelection));
      updateSheetSelection();
    }
    if (!isBasePage) return;
    const layer = document.querySelector('#base-grid-layer');
    if (layer) new MutationObserver(renderBaseSelection).observe(layer, { childList: true, subtree: true });
    document.querySelector('#base-grid-viewport')?.addEventListener('scroll', renderBaseSelection, { passive: true });
    document.addEventListener('pointerdown', event => {
      if (!state.selectMode) return;
      const hit = baseHit(event.target);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      state.baseDrag = { ...hit, pointerId: event.pointerId };
      setSelection({ startRow: hit.row, startCol: hit.col, endRow: hit.row, endCol: hit.col });
    }, true);
    document.addEventListener('pointermove', event => {
      if (!state.selectMode || !state.baseDrag) return;
      const hit = baseHit(document.elementFromPoint(event.clientX, event.clientY));
      if (!hit) return;
      event.preventDefault();
      setSelection({ startRow: state.baseDrag.row, startCol: state.baseDrag.col, endRow: hit.row, endCol: hit.col });
    }, true);
    document.addEventListener('pointerup', () => { state.baseDrag = null; }, true);
  }

  function statusLabel(value) {
    return value === 'running' ? 'Em execução' : value === 'setup' ? 'Configurando' : value === 'stopped' ? 'Encerrado' : 'Sem teste';
  }

  function stageLabel(number) {
    return ({ 1: 'Base', 2: 'Planilha', 3: 'Base 2', 4: 'Elementar' })[Number(number)] || 'Fase';
  }

  function renderState() {
    if (!state.workbook) return;
    ui.stage.textContent = `Fase ${state.workbook.stage_number} · ${state.workbook.stage_label}`;
    ui.stage.dataset.stage = String(state.workbook.stage_number);
    ui.sessionState.textContent = statusLabel(state.session?.status);
    ui.sessionState.dataset.state = state.session?.status || 'none';
    ui.sessionName.textContent = state.session?.name || 'Nenhuma sessão criada';
    ui.nameInput.value = state.session?.status === 'setup' ? state.session.name || '' : '';
    ui.nameInput.disabled = Boolean(state.session && state.session.status !== 'stopped');
    const open = state.session && ['setup', 'running'].includes(state.session.status);
    ui.newButton.disabled = !can('editor') || Boolean(open);
    ui.startButton.disabled = !can('editor') || state.session?.status !== 'setup' || !state.groups.length;
    ui.stopButton.disabled = !can('editor') || !open;
    ui.selectButton.disabled = !can('editor') || !open;
    ui.addButton.disabled = ui.selectButton.disabled || !reference();
    if (state.session?.status === 'running') {
      ui.clock.textContent = `Iniciado às ${formatExact(Number(state.session.started_client_epoch_ms || 0))} · relógio de alta resolução ativo`;
      ui.button.classList.add('running');
    } else {
      ui.clock.textContent = state.session?.status === 'stopped' ? `Encerrado em ${formatServer(state.session.stopped_at)}.` : 'Configure os grupos e inicie o teste.';
      ui.button.classList.remove('running');
    }
    renderGroups();
    renderTimeline();
    updateObservationLoop();
    updateStatePolling();
  }

  function renderGroups() {
    ui.groups.replaceChildren();
    ui.groupCount.textContent = `${state.groups.length} grupo${state.groups.length === 1 ? '' : 's'}`;
    if (!state.groups.length) return appendEmpty(ui.groups, 'Abra cada fase, selecione as células e adicione os grupos à mesma sessão.');
    state.groups.forEach(group => {
      const card = document.createElement('article');
      card.className = 'test-time-group';
      card.dataset.stage = String(group.stage_number);
      const badge = document.createElement('span');
      badge.className = 'test-time-stage-badge';
      badge.textContent = String(group.stage_number);
      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = group.group_name;
      const detail = document.createElement('small');
      detail.textContent = `${stageLabel(group.stage_number)} · ${group.workbook_name} · ${group.reference}`;
      content.append(title, detail);
      const baseline = document.createElement('span');
      baseline.className = 'test-time-baseline';
      baseline.textContent = group.last_value_hash ? 'Monitorando' : 'Sem baseline';
      card.append(badge, content, baseline);
      if (can('editor') && state.session && ['setup', 'running'].includes(state.session.status)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'test-time-remove';
        remove.textContent = '×';
        remove.title = `Remover ${group.group_name}`;
        remove.addEventListener('click', () => deleteGroup(group.id));
        card.append(remove);
      }
      ui.groups.append(card);
    });
  }

  function appendEmpty(target, text) {
    const empty = document.createElement('div');
    empty.className = 'test-time-empty';
    empty.textContent = text;
    target.append(empty);
  }

  function formatExact(epoch) {
    if (!Number.isFinite(epoch) || epoch <= 0) return '—';
    const date = new Date(epoch);
    const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
    const microseconds = Math.round((((epoch % 1000) + 1000) % 1000) * 1000).toString().padStart(6, '0');
    return `${time}.${microseconds}`;
  }

  function formatServer(value) {
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR', { hour12: false });
  }

  function formatDelta(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return '—';
    if (Math.abs(ms) < 1000) return `${ms.toFixed(3)} ms`;
    if (Math.abs(ms) < 60000) return `${(ms / 1000).toFixed(3)} s`;
    return `${(ms / 60000).toFixed(2)} min`;
  }

  function renderTimeline() {
    ui.timeline.replaceChildren();
    ui.eventCount.textContent = `${state.events.length} evento${state.events.length === 1 ? '' : 's'}`;
    if (!state.session) return appendEmpty(ui.timeline, 'Crie uma sessão para comparar as quatro fases.');
    if (!state.events.length) return appendEmpty(ui.timeline, state.session.status === 'running' ? 'Baseline registrado. Altere uma célula monitorada.' : 'Nenhuma alteração foi registrada.');
    const started = Number(state.session.started_client_epoch_ms || 0);
    let previous = started || Number(state.events[0].client_epoch_ms);
    state.events.forEach((event, index) => {
      const epoch = Number(event.client_epoch_ms);
      const row = document.createElement('article');
      row.className = 'test-time-event';
      row.dataset.stage = String(event.stage_number);
      const main = document.createElement('div');
      main.className = 'test-time-event-main';
      const badge = document.createElement('span');
      badge.className = 'test-time-stage-badge';
      badge.textContent = String(event.stage_number);
      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = event.group_name;
      const detail = document.createElement('small');
      const changed = Array.isArray(event.changed_cells) && event.changed_cells.length ? ` · ${event.changed_cells.slice(0, 4).join(', ')}` : '';
      detail.textContent = `${event.workbook_name} · ${event.reference}${changed}`;
      content.append(title, detail);
      main.append(badge, content);
      const exact = document.createElement('time');
      exact.textContent = formatExact(epoch);
      exact.title = `Servidor recebeu em ${formatServer(event.server_received_at)} · epoch ${epoch.toFixed(3)} ms`;
      const delta = document.createElement('div');
      delta.className = 'test-time-delta';
      const fromStart = document.createElement('strong');
      fromStart.textContent = formatDelta(epoch - started);
      const fromPrevious = document.createElement('small');
      fromPrevious.textContent = index === 0 ? 'primeiro evento' : `+${formatDelta(epoch - previous)}`;
      delta.append(fromStart, fromPrevious);
      row.append(main, exact, delta);
      ui.timeline.append(row);
      previous = epoch;
    });
  }

  async function loadState(quiet = false) {
    if (state.stateLoading) return;
    state.stateLoading = true;
    try {
      const output = await api(`/api/test-time/workbooks/${workbookId}`);
      state.workbook = output.workbook;
      state.session = output.session || null;
      state.groups = Array.isArray(output.groups) ? output.groups : [];
      state.events = Array.isArray(output.events) ? output.events : [];
      const runKey = state.session?.status === 'running' ? `${state.session.id}:${state.session.started_client_epoch_ms}` : '';
      if (runKey !== state.runKey) {
        state.runKey = runKey;
        state.localHashes.clear();
        state.localSamples.clear();
        state.pendingEpoch.clear();
      }
      if (!state.broadcast && state.workbook?.project_id) {
        try {
          state.broadcast = new BroadcastChannel(`superexcel-test-time-${state.workbook.project_id}`);
          state.broadcast.addEventListener('message', () => loadState(true));
        } catch {}
      }
      renderState();
    } catch (error) {
      if (!quiet) showError(error.message);
    } finally {
      state.stateLoading = false;
    }
  }

  function announce() {
    try { state.broadcast?.postMessage({ type: 'changed', at: Date.now() }); } catch {}
  }

  function showError(message) {
    ui.clock.textContent = message || 'Erro no Test Time.';
    ui.clock.classList.add('error');
    setTimeout(() => ui.clock?.classList.remove('error'), 3500);
  }

  async function createSession() {
    try {
      const output = await api(`/api/test-time/workbooks/${workbookId}/sessions`, { method: 'POST', body: JSON.stringify({ name: ui.nameInput.value.trim() || 'Teste de propagação' }) });
      state.session = output.session;
      announce();
      await loadState(true);
    } catch (error) { showError(error.message); }
  }

  async function startSession() {
    if (!state.session) return;
    try {
      await api(`/api/test-time/sessions/${state.session.id}/start`, { method: 'POST', body: JSON.stringify({ client_epoch_ms: epochNow() }) });
      state.localHashes.clear();
      state.localSamples.clear();
      announce();
      await loadState(true);
      scheduleObserve(0);
    } catch (error) { showError(error.message); }
  }

  async function stopSession() {
    if (!state.session) return;
    try {
      await api(`/api/test-time/sessions/${state.session.id}/stop`, { method: 'POST', body: '{}' });
      announce();
      await loadState(true);
    } catch (error) { showError(error.message); }
  }

  async function ensureSession() {
    if (state.session && ['setup', 'running'].includes(state.session.status)) return state.session;
    const output = await api(`/api/test-time/workbooks/${workbookId}/sessions`, { method: 'POST', body: JSON.stringify({ name: ui.nameInput.value.trim() || 'Teste de propagação' }) });
    return output.session;
  }

  async function addGroup() {
    const selected = reference();
    if (!selected) return showError('Selecione uma célula ou intervalo primeiro.');
    try {
      const session = await ensureSession();
      const [start, end = start] = selected.split(':');
      await api(`/api/test-time/sessions/${session.id}/groups`, {
        method: 'POST',
        body: JSON.stringify({ workbook_id: workbookId, group_name: ui.groupNameInput.value.trim() || `${state.workbook.stage_label} ${selected}`, start, end }),
      });
      ui.groupNameInput.value = '';
      announce();
      await loadState(true);
      scheduleObserve(0);
    } catch (error) { showError(error.message); }
  }

  async function deleteGroup(groupId) {
    try {
      await api(`/api/test-time/groups/${groupId}`, { method: 'DELETE' });
      state.localHashes.delete(Number(groupId));
      state.localSamples.delete(Number(groupId));
      state.pendingEpoch.delete(Number(groupId));
      announce();
      await loadState(true);
    } catch (error) { showError(error.message); }
  }

  function runtimeValue(runtime, row, col) {
    const coordinate = { sheet: 0, row, col };
    let value = runtime.getCellValue(coordinate);
    if (value && value.__superexcelTyped) value = value.value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) value = value.value;
    const type = String(runtime.getCellValueDetailedType?.(coordinate) || '');
    if (typeof value === 'number' && type.includes('DATE')) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + Math.floor(value));
      value = date.toISOString().slice(0, 10);
    }
    return value === undefined ? null : value;
  }

  function payloadEntries(snapshot) {
    const cells = Array.isArray(snapshot?.cells) ? snapshot.cells : [];
    const sparse = snapshot?.storage === 'sparse' || (cells.length && !Array.isArray(cells[0]));
    if (sparse) return cells.map(item => ({ row: Number(item?.r), col: Number(item?.c), value: item?.v ?? item?.value ?? null })).filter(item => Number.isInteger(item.row) && Number.isInteger(item.col));
    const output = [];
    cells.forEach((row, rowIndex) => Array.isArray(row) && row.forEach((value, col) => output.push({ row: rowIndex, col, value })));
    return output;
  }

  function nested(target, path) {
    let current = target;
    for (const part of String(path).split('.').filter(Boolean)) {
      if (!current || typeof current !== 'object' || !(part in current)) return null;
      current = current[part];
    }
    return current;
  }

  function livePayload() {
    try { return JSON.parse(liveJson?.textContent || ''); } catch { return null; }
  }

  function sampleElementar(group) {
    const payload = livePayload();
    const snapshot = window.SuperExcelApp?.getSnapshot?.();
    if (!payload || !snapshot) return null;
    const items = [];
    payloadEntries(snapshot).forEach(item => {
      if (!intersects(group, item.row, item.col) || typeof item.value !== 'string') return;
      const match = item.value.match(declarationPattern);
      if (match) items.push({ a: `${columnName(item.col)}${item.row + 1}`, k: match[1], v: nested(payload, match[1]) });
    });
    return items.length ? { mode: 'elementar', reference: group.reference, items } : null;
  }

  function sampleSheet(group) {
    if (group.mode === 'elementar') {
      const elementar = sampleElementar(group);
      if (elementar) return elementar;
    }
    const runtime = window.SuperExcelActiveRuntime;
    if (!runtime?.getCellValue) return null;
    const items = [];
    for (let row = Number(group.top_row); row <= Number(group.bottom_row); row += 1) {
      for (let col = Number(group.left_col); col <= Number(group.right_col); col += 1) {
        items.push({ a: `${columnName(col)}${row + 1}`, v: runtimeValue(runtime, row, col) });
      }
    }
    return { mode: group.mode, reference: group.reference, items };
  }

  async function sampleBase(group) {
    const output = await api(`/api/test-time/groups/${group.id}/base-snapshot`);
    return { mode: 'base', reference: group.reference, revision: output.revision, items: (output.cells || []).map(item => ({ a: `${columnName(Number(item.c))}${Number(item.r) + 1}`, v: item.v ?? null })) };
  }

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
  }

  async function hashValue(value) {
    const text = JSON.stringify(stable(value));
    if (crypto.subtle?.digest) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}${text.length.toString(16).padStart(8, '0')}`;
  }

  function changedAddresses(previous, current) {
    if (!previous?.items || !current?.items) return [];
    const before = new Map(previous.items.map(item => [item.a || item.k, JSON.stringify(stable(item.v))]));
    const after = new Map(current.items.map(item => [item.a || item.k, JSON.stringify(stable(item.v))]));
    const changed = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(key) !== after.get(key)) changed.push(key);
      if (changed.length >= 100) break;
    }
    return changed;
  }

  function preview(sample) {
    return { mode: sample.mode, reference: sample.reference, total: sample.items?.length || 0, items: sample.items?.slice(0, MAX_PREVIEW_ITEMS) || [], revision: sample.revision || null };
  }

  async function observeGroup(group) {
    const sample = group.mode === 'base' ? await sampleBase(group) : sampleSheet(group);
    if (!sample) return;
    const id = Number(group.id);
    const hash = await hashValue(sample);
    if (state.localHashes.get(id) === hash) return;
    const observedAt = state.pendingEpoch.get(id) || epochNow();
    const output = await api(`/api/test-time/groups/${group.id}/observe`, {
      method: 'POST',
      body: JSON.stringify({ value_hash: hash, value_preview: preview(sample), changed_cells: changedAddresses(state.localSamples.get(id), sample), client_epoch_ms: observedAt }),
    });
    state.localHashes.set(id, hash);
    state.localSamples.set(id, sample);
    state.pendingEpoch.delete(id);
    if (output?.result?.status === 'event') { announce(); loadState(true); }
  }

  async function observeAll() {
    if (state.observing || state.session?.status !== 'running' || document.hidden) return;
    const groups = state.groups.filter(group => Number(group.workbook_id) === workbookId);
    if (!groups.length) return;
    state.observing = true;
    try {
      for (const group of groups) {
        try { await observeGroup(group); } catch (error) { console.debug('Observação Test Time adiada.', error); }
      }
    } finally { state.observing = false; }
  }

  function scheduleObserve(delay = 0) {
    if (state.session?.status === 'running') setTimeout(observeAll, delay);
  }

  function markChanged(cells) {
    const list = (cells || []).map(item => ({ row: Number(item?.row ?? item?.r), col: Number(item?.col ?? item?.c) })).filter(item => Number.isInteger(item.row) && Number.isInteger(item.col));
    const now = epochNow();
    state.groups.filter(group => Number(group.workbook_id) === workbookId).forEach(group => {
      if (!list.length || list.some(cell => intersects(group, cell.row, cell.col))) state.pendingEpoch.set(Number(group.id), now);
    });
    scheduleObserve(0);
  }

  function updateObservationLoop() {
    if (state.observeTimer) clearInterval(state.observeTimer);
    state.observeTimer = null;
    if (state.session?.status !== 'running') return;
    state.observeTimer = setInterval(observeAll, state.workbook?.mode === 'base' ? BASE_POLL_MS : SHEET_POLL_MS);
    scheduleObserve(0);
  }

  function installObservationBridges() {
    window.addEventListener('superexcel:changes', event => markChanged(event.detail?.changes));
    window.addEventListener('superexcel:rendered', event => markChanged(event.detail?.coordinates));
    ['superexcel:hydrated', 'superexcel:base-reference-inserted', 'superexcel:elementar-source-synced', 'superexcel:treated-base-source-synced'].forEach(name => window.addEventListener(name, () => markChanged([])));
    if (liveJson) new MutationObserver(() => markChanged([])).observe(liveJson, { childList: true, characterData: true, subtree: true });
    window.addEventListener('focus', () => {
      if (state.panelOpen || state.session?.status === 'running') loadState(true);
      scheduleObserve(0);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (state.panelOpen || state.session?.status === 'running') loadState(true);
        scheduleObserve(0);
      }
    });
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    buildUi();
    installSelectionBridges();
    installObservationBridges();
    // O Test Time é opcional. Nenhuma consulta é feita até o usuário abrir
    // o painel; durante uma sessão ativa o próprio renderState inicia o polling.
  }

  window.addEventListener('pagehide', () => {
    if (state.stateTimer) clearInterval(state.stateTimer);
    if (state.observeTimer) clearInterval(state.observeTimer);
    try { state.broadcast?.close?.(); } catch {}
  }, { once: true });

  if (window.SuperExcelAuth?.ready) window.SuperExcelAuth.ready.then(initialize).catch(error => console.error('Test Time:', error));
  else window.addEventListener('load', initialize, { once: true });
})();
