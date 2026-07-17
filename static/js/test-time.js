(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const isBasePage = Boolean(document.querySelector('#base-grid-viewport'));
  const addressBox = document.querySelector('#cell-address');
  const liveJson = document.querySelector('#elementar-live-json');
  const roleRank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
  const declarationPattern = /^\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.-]*)\s*=\s*'((?:[^']|'')+)'\s*!\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\s*$/iu;
  const POLL_STATE_MS = 700;
  const POLL_BASE_MS = 250;
  const POLL_SHEET_MS = 120;
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
    localItems: new Map(),
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
    if (!match) return null;
    return { row: Number(match[2]) - 1, col: columnIndex(match[1]) };
  }

  function parseReference(value) {
    const [startText, endText = startText] = String(value || '').split(':');
    const start = parseCell(startText);
    const end = parseCell(endText);
    if (!start || !end) return null;
    return {
      startRow: start.row,
      startCol: start.col,
      endRow: end.row,
      endCol: end.col,
    };
  }

  function selectionBounds(selection = state.selection) {
    if (!selection) return null;
    return {
      top: Math.min(selection.startRow, selection.endRow),
      bottom: Math.max(selection.startRow, selection.endRow),
      left: Math.min(selection.startCol, selection.endCol),
      right: Math.max(selection.startCol, selection.endCol),
    };
  }

  function selectionReference(selection = state.selection) {
    const bounds = selectionBounds(selection);
    if (!bounds) return '';
    const start = `${columnName(bounds.left)}${bounds.top + 1}`;
    const end = `${columnName(bounds.right)}${bounds.bottom + 1}`;
    return start === end ? start : `${start}:${end}`;
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
        <div class="test-time-heading">
          <span class="test-time-mark">⏱</span>
          <div><strong>Test Time</strong><small>Tempo de propagação entre as quatro fases</small></div>
        </div>
        <button id="test-time-close" type="button" aria-label="Fechar Test Time">×</button>
      </header>
      <div class="test-time-body">
        <section class="test-time-session-card">
          <div class="test-time-session-title">
            <div><span id="test-time-session-state" class="test-time-state">Sem teste</span><strong id="test-time-session-name">Nenhuma sessão criada</strong></div>
            <span id="test-time-stage" class="test-time-stage">Fase</span>
          </div>
          <input id="test-time-name" maxlength="120" placeholder="Nome do teste, ex.: Pedido 1428">
          <div class="test-time-session-actions">
            <button id="test-time-new" type="button">Novo teste</button>
            <button id="test-time-start" class="primary" type="button">Iniciar</button>
            <button id="test-time-stop" type="button">Encerrar</button>
          </div>
          <div id="test-time-clock" class="test-time-clock">Configure os grupos e inicie o teste.</div>
        </section>

        <section class="test-time-selection-card">
          <div class="test-time-section-title"><strong>Células desta fase</strong><span id="test-time-current-reference">Nenhuma seleção</span></div>
          <p>Selecione uma célula ou um intervalo. Qualquer alteração dentro do grupo será registrada.</p>
          <input id="test-time-group-name" maxlength="120" placeholder="Nome do grupo, ex.: Total calculado">
          <div class="test-time-selection-actions">
            <button id="test-time-select" type="button">Selecionar células</button>
            <button id="test-time-add" class="primary" type="button">Adicionar à lista</button>
          </div>
        </section>

        <section class="test-time-groups-section">
          <div class="test-time-section-title"><strong>Lista monitorada</strong><span id="test-time-group-count">0 grupos</span></div>
          <div id="test-time-groups" class="test-time-groups"></div>
        </section>

        <section class="test-time-timeline-section">
          <div class="test-time-section-title"><strong>Linha do tempo</strong><span id="test-time-event-count">0 eventos</span></div>
          <div class="test-time-timeline-head"><span>Fase e grupo</span><span>Horário exato</span><span>Desde início</span></div>
          <div id="test-time-timeline" class="test-time-timeline"></div>
        </section>
      </div>`;
    document.body.append(ui.panel);

    ui.selectionBar = document.createElement('div');
    ui.selectionBar.id = 'test-time-selection-bar';
    ui.selectionBar.className = 'test-time-selection-bar';
    ui.selectionBar.hidden = true;
    ui.selectionBar.innerHTML = `
      <div><span>⏱ Selecionando</span><strong id="test-time-selection-bar-reference">A1</strong></div>
      <div><button id="test-time-selection-cancel" type="button">Cancelar</button><button id="test-time-selection-done" class="primary" type="button">Concluir</button></div>`;
    document.body.append(ui.selectionBar);

    ui.close = ui.panel.querySelector('#test-time-close');
    ui.sessionState = ui.panel.querySelector('#test-time-session-state');
    ui.sessionName = ui.panel.querySelector('#test-time-session-name');
    ui.stage = ui.panel.querySelector('#test-time-stage');
    ui.nameInput = ui.panel.querySelector('#test-time-name');
    ui.newButton = ui.panel.querySelector('#test-time-new');
    ui.startButton = ui.panel.querySelector('#test-time-start');
    ui.stopButton = ui.panel.querySelector('#test-time-stop');
    ui.clock = ui.panel.querySelector('#test-time-clock');
    ui.currentReference = ui.panel.querySelector('#test-time-current-reference');
    ui.groupNameInput = ui.panel.querySelector('#test-time-group-name');
    ui.selectButton = ui.panel.querySelector('#test-time-select');
    ui.addButton = ui.panel.querySelector('#test-time-add');
    ui.groups = ui.panel.querySelector('#test-time-groups');
    ui.groupCount = ui.panel.querySelector('#test-time-group-count');
    ui.timeline = ui.panel.querySelector('#test-time-timeline');
    ui.eventCount = ui.panel.querySelector('#test-time-event-count');
    ui.selectionBarReference = ui.selectionBar.querySelector('#test-time-selection-bar-reference');
    ui.selectionCancel = ui.selectionBar.querySelector('#test-time-selection-cancel');
    ui.selectionDone = ui.selectionBar.querySelector('#test-time-selection-done');

    ui.button.addEventListener('click', () => setPanelOpen(!state.panelOpen));
    ui.close.addEventListener('click', () => setPanelOpen(false));
    ui.newButton.addEventListener('click', createSession);
    ui.startButton.addEventListener('click', startSession);
    ui.stopButton.addEventListener('click', stopSession);
    ui.selectButton.addEventListener('click', beginSelectionMode);
    ui.selectionCancel.addEventListener('click', cancelSelectionMode);
    ui.selectionDone.addEventListener('click', finishSelectionMode);
    ui.addButton.addEventListener('click', addGroup);
  }

  function setPanelOpen(open) {
    state.panelOpen = Boolean(open);
    ui.panel.hidden = !state.panelOpen;
    ui.button.classList.toggle('active', state.panelOpen);
    ui.button.setAttribute('aria-pressed', String(state.panelOpen));
    document.body.classList.toggle('test-time-panel-open', state.panelOpen);
    if (state.panelOpen) loadState({ quiet: true });
  }

  function setSelection(selection) {
    state.selection = selection;
    const reference = selectionReference();
    if (ui.currentReference) ui.currentReference.textContent = reference || 'Nenhuma seleção';
    if (ui.selectionBarReference) ui.selectionBarReference.textContent = reference || 'Nenhuma seleção';
    if (ui.addButton) ui.addButton.disabled = !reference || !can('editor');
    if (isBasePage) renderBaseSelection();
  }

  function updateSheetSelection() {
    if (!addressBox) return;
    const parsed = parseReference(addressBox.textContent.trim());
    if (parsed) setSelection(parsed);
  }

  function beginSelectionMode() {
    state.selectMode = true;
    setPanelOpen(false);
    ui.selectionBar.hidden = false;
    document.body.classList.add('test-time-selecting');
    if (!isBasePage) {
      document.querySelector('#spreadsheet')?.focus({ preventScroll: true });
      updateSheetSelection();
    }
  }

  function finishSelectionMode() {
    state.selectMode = false;
    ui.selectionBar.hidden = true;
    document.body.classList.remove('test-time-selecting');
    state.baseDrag = null;
    setPanelOpen(true);
  }

  function cancelSelectionMode() {
    state.selectMode = false;
    ui.selectionBar.hidden = true;
    document.body.classList.remove('test-time-selecting');
    state.baseDrag = null;
    renderBaseSelection();
    setPanelOpen(true);
  }

  function baseCellFromEventTarget(target) {
    const cell = target?.closest?.('.base-grid-cell');
    const rowElement = cell?.closest?.('.base-grid-row');
    if (!cell || !rowElement || cell.classList.contains('system') || cell.classList.contains('action')) return null;
    const children = [...rowElement.children];
    const position = children.indexOf(cell);
    const row = Number(rowElement.dataset.rowIndex);
    const col = position - 1;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return null;
    return { row, col, cell };
  }

  function renderBaseSelection() {
    if (!isBasePage) return;
    const bounds = selectionBounds();
    document.querySelectorAll('.base-grid-cell.test-time-cell-selected, .base-grid-cell.test-time-range-top, .base-grid-cell.test-time-range-bottom, .base-grid-cell.test-time-range-left, .base-grid-cell.test-time-range-right')
      .forEach(cell => cell.classList.remove('test-time-cell-selected', 'test-time-range-top', 'test-time-range-bottom', 'test-time-range-left', 'test-time-range-right'));
    if (!bounds) return;
    document.querySelectorAll('.base-grid-row').forEach(rowElement => {
      const row = Number(rowElement.dataset.rowIndex);
      if (row < bounds.top || row > bounds.bottom) return;
      [...rowElement.children].forEach((cell, position) => {
        const col = position - 1;
        if (col < bounds.left || col > bounds.right || cell.classList.contains('system') || cell.classList.contains('action')) return;
        cell.classList.add('test-time-cell-selected');
        if (row === bounds.top) cell.classList.add('test-time-range-top');
        if (row === bounds.bottom) cell.classList.add('test-time-range-bottom');
        if (col === bounds.left) cell.classList.add('test-time-range-left');
        if (col === bounds.right) cell.classList.add('test-time-range-right');
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

    if (isBasePage) {
      const layer = document.querySelector('#base-grid-layer');
      if (layer) new MutationObserver(renderBaseSelection).observe(layer, { childList: true, subtree: true });
      document.querySelector('#base-grid-viewport')?.addEventListener('scroll', renderBaseSelection, { passive: true });

      document.addEventListener('pointerdown', event => {
        if (!state.selectMode) return;
        const hit = baseCellFromEventTarget(event.target);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        state.baseDrag = { row: hit.row, col: hit.col, pointerId: event.pointerId };
        setSelection({ startRow: hit.row, startCol: hit.col, endRow: hit.row, endCol: hit.col });
      }, true);

      document.addEventListener('pointermove', event => {
        if (!state.selectMode || !state.baseDrag) return;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const hit = baseCellFromEventTarget(target);
        if (!hit) return;
        event.preventDefault();
        setSelection({
          startRow: state.baseDrag.row,
          startCol: state.baseDrag.col,
          endRow: hit.row,
          endCol: hit.col,
        });
      }, true);

      document.addEventListener('pointerup', () => {
        state.baseDrag = null;
      }, true);
    }
  }

  function sessionStatusText(status) {
    if (status === 'running') return 'Em execução';
    if (status === 'setup') return 'Configurando';
    if (status === 'stopped') return 'Encerrado';
    return 'Sem teste';
  }

  function renderState() {
    const workbook = state.workbook;
    const session = state.session;
    if (!workbook) return;

    ui.stage.textContent = `Fase ${workbook.stage_number} · ${workbook.stage_label}`;
    ui.stage.dataset.stage = String(workbook.stage_number);
    ui.sessionState.textContent = sessionStatusText(session?.status);
    ui.sessionState.dataset.state = session?.status || 'none';
    ui.sessionName.textContent = session?.name || 'Nenhuma sessão criada';
    ui.nameInput.value = session?.status === 'setup' ? session.name || '' : '';
    ui.nameInput.disabled = Boolean(session && session.status !== 'stopped');

    const hasEditableSession = session && ['setup', 'running'].includes(session.status);
    ui.newButton.disabled = !can('editor') || Boolean(hasEditableSession);
    ui.startButton.disabled = !can('editor') || session?.status !== 'setup' || state.groups.length === 0;
    ui.stopButton.disabled = !can('editor') || !session || !['setup', 'running'].includes(session.status);
    ui.selectButton.disabled = !can('editor') || !session || !['setup', 'running'].includes(session.status);
    ui.addButton.disabled = ui.selectButton.disabled || !selectionReference();

    if (session?.status === 'running') {
      const start = Number(session.started_client_epoch_ms || 0);
      ui.clock.textContent = start > 0
        ? `Iniciado às ${formatExactTime(start)} · relógio de alta resolução ativo`
        : 'Teste em execução.';
      ui.button.classList.add('running');
    } else {
      ui.clock.textContent = session?.status === 'stopped'
        ? `Encerrado em ${formatServerTime(session.stopped_at)}.`
        : 'Configure os grupos e inicie o teste.';
      ui.button.classList.remove('running');
    }

    renderGroups();
    renderTimeline();
    updateObservationLoop();
  }

  function stageLabel(stageNumber) {
    return ({ 1: 'Base', 2: 'Planilha', 3: 'Base 2', 4: 'Elementar' })[Number(stageNumber)] || 'Fase';
  }

  function renderGroups() {
    ui.groups.replaceChildren();
    ui.groupCount.textContent = `${state.groups.length} grupo${state.groups.length === 1 ? '' : 's'}`;
    if (!state.groups.length) {
      const empty = document.createElement('div');
      empty.className = 'test-time-empty';
      empty.textContent = 'Abra cada fase, selecione as células e adicione os grupos à mesma sessão.';
      ui.groups.append(empty);
      return;
    }

    state.groups.forEach(group => {
      const card = document.createElement('article');
      card.className = 'test-time-group';
      card.dataset.stage = String(group.stage_number);

      const stage = document.createElement('span');
      stage.className = 'test-time-group-stage';
      stage.textContent = String(group.stage_number);

      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = group.group_name;
      const detail = document.createElement('small');
      detail.textContent = `${stageLabel(group.stage_number)} · ${group.workbook_name} · ${group.reference}`;
      content.append(title, detail);

      const stateBadge = document.createElement('span');
      stateBadge.className = 'test-time-group-baseline';
      stateBadge.textContent = group.last_value_hash ? 'Monitorando' : 'Sem baseline';

      card.append(stage, content, stateBadge);
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

  function formatExactTime(epochMs) {
    const value = Number(epochMs);
    if (!Number.isFinite(value)) return '—';
    const date = new Date(value);
    const base = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
    const withinSecond = ((value % 1000) + 1000) % 1000;
    const microseconds = Math.round(withinSecond * 1000).toString().padStart(6, '0');
    return `${base}.${microseconds}`;
  }

  function formatServerTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('pt-BR', { hour12: false });
  }

  function formatDelta(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds)) return '—';
    if (Math.abs(milliseconds) < 1000) return `${milliseconds.toFixed(3)} ms`;
    if (Math.abs(milliseconds) < 60000) return `${(milliseconds / 1000).toFixed(3)} s`;
    return `${(milliseconds / 60000).toFixed(2)} min`;
  }

  function renderTimeline() {
    ui.timeline.replaceChildren();
    ui.eventCount.textContent = `${state.events.length} evento${state.events.length === 1 ? '' : 's'}`;
    const started = Number(state.session?.started_client_epoch_ms || 0);
    if (!state.session) {
      const empty = document.createElement('div');
      empty.className = 'test-time-empty';
      empty.textContent = 'Crie uma sessão para comparar as quatro fases.';
      ui.timeline.append(empty);
      return;
    }
    if (!state.events.length) {
      const empty = document.createElement('div');
      empty.className = 'test-time-empty';
      empty.textContent = state.session.status === 'running'
        ? 'Baseline registrado. Altere uma célula monitorada para gerar o primeiro horário.'
        : 'Nenhuma alteração foi registrada nesta sessão.';
      ui.timeline.append(empty);
      return;
    }

    let previousEpoch = started || Number(state.events[0].client_epoch_ms);
    state.events.forEach((event, index) => {
      const epoch = Number(event.client_epoch_ms);
      const row = document.createElement('article');
      row.className = 'test-time-event';
      row.dataset.stage = String(event.stage_number);

      const identity = document.createElement('div');
      const badge = document.createElement('span');
      badge.className = 'test-time-event-stage';
      badge.textContent = String(event.stage_number);
      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = event.group_name;
      const detail = document.createElement('small');
      const changed = Array.isArray(event.changed_cells) && event.changed_cells.length
        ? ` · ${event.changed_cells.slice(0, 4).join(', ')}`
        : '';
      detail.textContent = `${event.workbook_name} · ${event.reference}${changed}`;
      text.append(title, detail);
      identity.append(badge, text);

      const exact = document.createElement('time');
      exact.textContent = formatExactTime(epoch);
      exact.title = `Servidor recebeu em ${formatServerTime(event.server_received_at)} · epoch ${epoch.toFixed(3)} ms`;

      const delta = document.createElement('div');
      const fromStart = document.createElement('strong');
      fromStart.textContent = formatDelta(epoch - started);
      const fromPrevious = document.createElement('small');
      fromPrevious.textContent = index === 0 ? 'primeiro evento' : `+${formatDelta(epoch - previousEpoch)}`;
      delta.append(fromStart, fromPrevious);

      row.append(identity, exact, delta);
      ui.timeline.append(row);
      previousEpoch = epoch;
    });
  }

  async function loadState({ quiet = false } = {}) {
    if (state.stateLoading) return;
    state.stateLoading = true;
    try {
      const output = await api(`/api/test-time/workbooks/${workbookId}`);
      const previousProject = state.workbook?.project_id;
      state.workbook = output.workbook;
      state.session = output.session || null;
      state.groups = Array.isArray(output.groups) ? output.groups : [];
      state.events = Array.isArray(output.events) ? output.events : [];

      const runKey = state.session?.status === 'running'
        ? `${state.session.id}:${state.session.started_client_epoch_ms}`
        : '';
      if (runKey !== state.runKey) {
        state.runKey = runKey;
        state.localHashes.clear();
        state.localItems.clear();
      }

      if (!state.broadcast && state.workbook?.project_id) {
        try {
          state.broadcast = new BroadcastChannel(`superexcel-test-time-${state.workbook.project_id}`);
          state.broadcast.addEventListener('message', () => loadState({ quiet: true }));
        } catch {}
      } else if (previousProject && previousProject !== state.workbook?.project_id) {
        state.broadcast?.close?.();
        state.broadcast = null;
      }
      renderState();
    } catch (error) {
      if (!quiet) showError(error.message);
    } finally {
      state.stateLoading = false;
    }
  }

  function announceChange() {
    try { state.broadcast?.postMessage({ type: 'changed', at: Date.now() }); } catch {}
  }

  function showError(message) {
    if (!ui.clock) return;
    ui.clock.textContent = message || 'Erro no Test Time.';
    ui.clock.classList.add('error');
    window.setTimeout(() => ui.clock?.classList.remove('error'), 3500);
  }

  async function createSession() {
    try {
      const output = await api(`/api/test-time/workbooks/${workbookId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ name: ui.nameInput.value.trim() || 'Teste de propagação' }),
      });
      state.session = output.session;
      announceChange();
      await loadState({ quiet: true });
    } catch (error) {
      showError(error.message);
    }
  }

  async function startSession() {
    if (!state.session) return;
    try {
      await api(`/api/test-time/sessions/${state.session.id}/start`, {
        method: 'POST',
        body: JSON.stringify({ client_epoch_ms: epochNow() }),
      });
      state.localHashes.clear();
      state.localItems.clear();
      announceChange();
      await loadState({ quiet: true });
      scheduleObserve(0);
    } catch (error) {
      showError(error.message);
    }
  }

  async function stopSession() {
    if (!state.session) return;
    try {
      await api(`/api/test-time/sessions/${state.session.id}/stop`, { method: 'POST', body: '{}' });
      announceChange();
      await loadState({ quiet: true });
    } catch (error) {
      showError(error.message);
    }
  }

  async function ensureOpenSession() {
    if (state.session && ['setup', 'running'].includes(state.session.status)) return state.session;
    const output = await api(`/api/test-time/workbooks/${workbookId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name: ui.nameInput.value.trim() || 'Teste de propagação' }),
    });
    state.session = output.session;
    return state.session;
  }

  async function addGroup() {
    const reference = selectionReference();
    if (!reference) {
      showError('Selecione uma célula ou intervalo primeiro.');
      return;
    }
    try {
      const session = await ensureOpenSession();
      const [start, end = start] = reference.split(':');
      await api(`/api/test-time/sessions/${session.id}/groups`, {
        method: 'POST',
        body: JSON.stringify({
          workbook_id: workbookId,
          group_name: ui.groupNameInput.value.trim() || `${state.workbook.stage_label} ${reference}`,
          start,
          end,
        }),
      });
      ui.groupNameInput.value = '';
      announceChange();
      await loadState({ quiet: true });
      scheduleObserve(0);
    } catch (error) {
      showError(error.message);
    }
  }

  async function deleteGroup(groupId) {
    try {
      await api(`/api/test-time/groups/${groupId}`, { method: 'DELETE' });
      state.localHashes.delete(Number(groupId));
      state.localItems.delete(Number(groupId));
      announceChange();
      await loadState({ quiet: true });
    } catch (error) {
      showError(error.message);
    }
  }

  function normalizeRuntimeValue(runtime, row, col) {
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
    if (sparse) {
      return cells.map(item => ({
        row: Number(item?.r),
        col: Number(item?.c),
        value: item?.v ?? item?.value ?? null,
      })).filter(item => Number.isInteger(item.row) && Number.isInteger(item.col));
    }
    const output = [];
    cells.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, col) => output.push({ row: rowIndex, col, value }));
    });
    return output;
  }

  function getNested(target, path) {
    let current = target;
    for (const part of String(path).split('.').filter(Boolean)) {
      if (!current || typeof current !== 'object' || !(part in current)) return null;
      current = current[part];
    }
    return current;
  }

  function parseLiveJson() {
    if (!liveJson) return null;
    try {
      return JSON.parse(liveJson.textContent || '');
    } catch {
      return null;
    }
  }

  function sampleElementar(group) {
    const payload = parseLiveJson();
    const snapshot = window.SuperExcelApp?.getSnapshot?.();
    if (!payload || !snapshot) return null;
    const declarations = [];
    for (const item of payloadEntries(snapshot)) {
      if (item.row < group.top_row || item.row > group.bottom_row || item.col < group.left_col || item.col > group.right_col) continue;
      if (typeof item.value !== 'string') continue;
      const match = item.value.match(declarationPattern);
      if (!match) continue;
      declarations.push({
        address: `${columnName(item.col)}${item.row + 1}`,
        key: match[1],
        value: getNested(payload, match[1]),
      });
    }
    if (!declarations.length) return null;
    return {
      mode: 'elementar',
      reference: group.reference,
      items: declarations.map(item => ({ k: item.key, a: item.address, v: item.value })),
    };
  }

  function sampleSheet(group) {
    if (group.mode === 'elementar') {
      const output = sampleElementar(group);
      if (output) return output;
    }
    const runtime = window.SuperExcelActiveRuntime;
    if (!runtime?.getCellValue) return null;
    const items = [];
    for (let row = Number(group.top_row); row <= Number(group.bottom_row); row += 1) {
      for (let col = Number(group.left_col); col <= Number(group.right_col); col += 1) {
        items.push({ a: `${columnName(col)}${row + 1}`, v: normalizeRuntimeValue(runtime, row, col) });
      }
    }
    return { mode: group.mode, reference: group.reference, items };
  }

  async function sampleBase(group) {
    const output = await api(`/api/test-time/groups/${group.id}/base-snapshot`);
    return {
      mode: 'base',
      reference: group.reference,
      revision: output.revision,
      items: (output.cells || []).map(item => ({
        a: `${columnName(Number(item.c))}${Number(item.r) + 1}`,
        v: item.v ?? null,
      })),
    };
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    }
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return null;
    return value;
  }

  async function hashValue(value) {
    const text = JSON.stringify(stableValue(value));
    if (crypto.subtle?.digest) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}${text.length.toString(16).padStart(8, '0')}`;
  }

  function changedAddresses(previous, current) {
    if (!previous || !Array.isArray(previous.items) || !Array.isArray(current.items)) return [];
    const before = new Map(previous.items.map(item => [item.a || item.k, JSON.stringify(stableValue(item.v))]));
    const after = new Map(current.items.map(item => [item.a || item.k, JSON.stringify(stableValue(item.v))]));
    const changed = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(key) !== after.get(key)) changed.push(key);
      if (changed.length >= 100) break;
    }
    return changed;
  }

  function previewValue(sample) {
    return {
      mode: sample.mode,
      reference: sample.reference,
      total: Array.isArray(sample.items) ? sample.items.length : 0,
      items: Array.isArray(sample.items) ? sample.items.slice(0, MAX_PREVIEW_ITEMS) : [],
      revision: sample.revision || null,
    };
  }

  async function observeGroup(group) {
    const sample = group.mode === 'base' ? await sampleBase(group) : sampleSheet(group);
    if (!sample) return;
    const hash = await hashValue(sample);
    const groupId = Number(group.id);
    if (state.localHashes.get(groupId) === hash) return;
    const changed = changedAddresses(state.localItems.get(groupId), sample);
    const observedAt = epochNow();
    const output = await api(`/api/test-time/groups/${group.id}/observe`, {
      method: 'POST',
      body: JSON.stringify({
        value_hash: hash,
        value_preview: previewValue(sample),
        changed_cells: changed,
        client_epoch_ms: observedAt,
      }),
    });
    state.localHashes.set(groupId, hash);
    state.localItems.set(groupId, sample);
    const status = output?.result?.status;
    if (status === 'event') {
      announceChange();
      loadState({ quiet: true });
    }
  }

  async function observeAll() {
    if (state.observing || state.session?.status !== 'running' || document.hidden) return;
    const groups = state.groups.filter(group => Number(group.workbook_id) === workbookId);
    if (!groups.length) return;
    state.observing = true;
    try {
      for (const group of groups) {
        try { await observeGroup(group); }
        catch (error) { console.debug('Observação Test Time adiada.', error); }
      }
    } finally {
      state.observing = false;
    }
  }

  function scheduleObserve(delay = 0) {
    if (state.session?.status !== 'running') return;
    window.setTimeout(observeAll, delay);
  }

  function updateObservationLoop() {
    if (state.observeTimer) window.clearInterval(state.observeTimer);
    state.observeTimer = null;
    if (state.session?.status !== 'running') return;
    const delay = state.workbook?.mode === 'base' ? POLL_BASE_MS : POLL_SHEET_MS;
    state.observeTimer = window.setInterval(observeAll, delay);
    scheduleObserve(0);
  }

  function installObservationTriggers() {
    ['superexcel:changes', 'superexcel:rendered', 'superexcel:hydrated', 'superexcel:base-reference-inserted', 'superexcel:elementar-source-synced', 'superexcel:treated-base-source-synced']
      .forEach(name => window.addEventListener(name, () => scheduleObserve(0)));
    if (liveJson) new MutationObserver(() => scheduleObserve(0)).observe(liveJson, { childList: true, characterData: true, subtree: true });
    window.addEventListener('focus', () => {
      loadState({ quiet: true });
      scheduleObserve(0);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadState({ quiet: true });
        scheduleObserve(0);
      }
    });
  }

  async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    buildUi();
    installSelectionBridges();
    installObservationTriggers();
    await loadState({ quiet: false });
    state.stateTimer = window.setInterval(() => loadState({ quiet: true }), POLL_STATE_MS);
  }

  window.addEventListener('pagehide', () => {
    if (state.stateTimer) window.clearInterval(state.stateTimer);
    if (state.observeTimer) window.clearInterval(state.observeTimer);
    try { state.broadcast?.close?.(); } catch {}
  }, { once: true });

  if (window.SuperExcelAuth?.ready) {
    window.SuperExcelAuth.ready.then(initialize).catch(error => console.error('Test Time:', error));
  } else {
    window.addEventListener('load', initialize, { once: true });
  }
})();
