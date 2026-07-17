(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const context = {
    projectId: null,
    folderId: null,
    workbooks: [],
    dependencies: [],
    loaded: false,
    transforming: false,
    scheduled: false,
  };

  const STAGES = [
    { key: 'source', number: '1', title: 'Base', subtitle: 'Dados brutos relacionais', icon: '▤', create: 'new-base-source' },
    { key: 'calculation', number: '2', title: 'Planilhas', subtitle: 'Fórmulas e regras de negócio', icon: '▦', create: 'new-sheet' },
    { key: 'treated', number: '3', title: 'Base 2', subtitle: 'Dados tratados e estáveis', icon: '▥', create: 'new-base-treated' },
    { key: 'publication', number: '4', title: 'Elementar', subtitle: 'JSON publicado para o site', icon: '◈', create: 'new-elementar' },
  ];

  async function api(url, options = {}) {
    const response = await nativeFetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Erro inesperado.');
    return data;
  }

  window.fetch = async function pipelineAwareFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
      if (url.origin === location.origin && url.pathname === '/api/manager' && response.ok) {
        context.projectId = Number(url.searchParams.get('project_id')) || null;
        context.folderId = Number(url.searchParams.get('folder_id')) || null;
        context.loaded = false;
        response.clone().json().then(data => {
          context.workbooks = Array.isArray(data?.workbooks) ? data.workbooks : [];
          context.dependencies = Array.isArray(data?.dependencies) ? data.dependencies : [];
          context.loaded = true;
          scheduleTransform();
        }).catch(error => {
          context.loaded = true;
          console.debug(error);
        });
      }
    } catch (error) {
      console.debug('Pipeline manager:', error);
    }
    return response;
  };

  function stageDefinition(key) {
    return STAGES.find(stage => stage.key === key) || STAGES[1];
  }

  function createLane(stage) {
    const section = document.createElement('section');
    section.className = 'pipeline-lane';
    section.dataset.stage = stage.key;
    section.innerHTML = `
      <header class="pipeline-lane-head">
        <span class="pipeline-lane-number">${stage.number}</span>
        <div class="pipeline-lane-title"><strong>${stage.title}</strong><small>${stage.subtitle}</small></div>
        <button type="button" data-stage-create="${stage.create}" title="Criar em ${stage.title}">＋</button>
      </header>
      <div class="pipeline-lane-items" data-stage-items="${stage.key}"></div>`;
    section.querySelector('[data-stage-create]').addEventListener('click', event => {
      document.getElementById(event.currentTarget.dataset.stageCreate)?.click();
    });
    return section;
  }

  function decorateWorkbook(card, workbook) {
    if (!card || !workbook) return;
    const stage = stageDefinition(workbook.pipeline_stage);
    card.dataset.workbookId = String(workbook.id);
    card.dataset.fileKind = workbook.file_kind || 'spreadsheet';
    card.dataset.pipelineStage = stage.key;
    card.classList.remove('stage-source', 'stage-calculation', 'stage-treated', 'stage-publication');
    card.classList.add(`stage-${stage.key}`);

    const icon = card.querySelector('.icon');
    if (icon) icon.textContent = stage.icon;

    card.querySelector('.pipeline-stage-badge')?.remove();
    card.querySelector('.pipeline-kind-detail')?.remove();
    const badge = document.createElement('span');
    badge.className = 'pipeline-stage-badge';
    badge.textContent = stage.title;
    const detail = document.createElement('span');
    detail.className = 'pipeline-kind-detail';
    detail.textContent = workbook.file_kind === 'base'
      ? 'Tabela relacional · sem fórmulas'
      : workbook.file_kind === 'elementar'
        ? 'Publicação JSON'
        : 'Motor de cálculo';
    card.querySelector('strong')?.insertAdjacentElement('afterend', detail);
    detail.insertAdjacentElement('afterend', badge);

    const open = card.querySelector('.item-actions button');
    if (open) {
      open.onclick = () => {
        location.href = workbook.file_kind === 'base' ? `/base/${workbook.id}` : `/sheet/${workbook.id}`;
      };
    }
  }

  function emptyLane(container, stage) {
    const empty = document.createElement('div');
    empty.className = 'pipeline-lane-empty';
    empty.innerHTML = `<strong>Nenhum arquivo</strong><span>Crie um arquivo na etapa ${stage.number}.</span>`;
    container.append(empty);
  }

  function transformItems() {
    const root = document.querySelector('#items');
    if (!root || context.transforming || !context.loaded) return;
    const existingBoard = root.querySelector(':scope > .pipeline-board');
    if (existingBoard) return;

    const cards = [...root.querySelectorAll(':scope > .workbook-item')];
    const folderCards = [...root.querySelectorAll(':scope > .folder-item, :scope > .back-item')];
    if (cards.length !== context.workbooks.length) return;
    if (!cards.length && !folderCards.length && !context.workbooks.length) return;

    context.transforming = true;
    try {
      cards.forEach((card, index) => decorateWorkbook(card, context.workbooks[index]));

      const folders = document.createElement('div');
      folders.className = 'pipeline-folders';
      folderCards.forEach(card => folders.append(card));

      const board = document.createElement('div');
      board.className = 'pipeline-board';
      const lanes = new Map();
      STAGES.forEach(stage => {
        const lane = createLane(stage);
        lanes.set(stage.key, lane.querySelector('.pipeline-lane-items'));
        board.append(lane);
      });

      cards.forEach(card => {
        const stage = card.dataset.pipelineStage || 'calculation';
        (lanes.get(stage) || lanes.get('calculation')).append(card);
      });
      STAGES.forEach(stage => {
        const container = lanes.get(stage.key);
        if (!container.querySelector('.workbook-item')) emptyLane(container, stage);
      });

      root.innerHTML = '';
      if (folders.children.length) root.append(folders);
      root.append(board);
      root.dispatchEvent(new CustomEvent('superexcel:pipeline-rendered', { bubbles: true }));
    } finally {
      context.transforming = false;
    }
  }

  function scheduleTransform() {
    if (context.scheduled) return;
    context.scheduled = true;
    requestAnimationFrame(() => {
      context.scheduled = false;
      transformItems();
    });
  }

  function updateCapability() {
    const editable = ['editor', 'admin', 'owner'].includes(document.body.dataset.projectRole || 'viewer');
    ['new-base-source', 'new-base-treated'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.disabled = !editable;
    });
    document.querySelectorAll('[data-stage-create]').forEach(button => {
      const target = document.getElementById(button.dataset.stageCreate);
      button.disabled = Boolean(target?.disabled);
    });
  }

  function openBaseForm(stage) {
    const dialog = document.querySelector('#form-dialog');
    const title = document.querySelector('#dialog-title');
    const fields = document.querySelector('#dialog-fields');
    const save = document.querySelector('#dialog-save');
    if (!dialog || !title || !fields || !save) return;
    const treated = stage === 'treated';
    title.textContent = treated ? 'Nova Base 2 tratada' : 'Nova Base de entrada';
    fields.innerHTML = `
      <label>Nome</label>
      <input name="name" maxlength="120" value="${treated ? 'Nova Base 2' : 'Nova Base'}" required>
      <p class="form-help">${treated
        ? 'Recebe resultados estabilizados das planilhas e não executa fórmulas.'
        : 'Armazena dados brutos diretamente no banco relacional e não executa fórmulas.'}</p>`;
    save.onclick = async event => {
      event.preventDefault();
      const name = String(new FormData(dialog.querySelector('form')).get('name') || '').trim();
      if (!name || !context.projectId) return;
      save.disabled = true;
      try {
        const base = await api('/api/bases', {
          method: 'POST',
          body: JSON.stringify({
            project_id: context.projectId,
            folder_id: context.folderId,
            name,
            pipeline_stage: stage,
          }),
        });
        location.href = `/base/${base.id}`;
      } catch (error) {
        alert(error.message);
      } finally {
        save.disabled = false;
      }
    };
    dialog.showModal();
    requestAnimationFrame(() => fields.querySelector('input')?.focus());
  }

  document.querySelector('#new-base-source')?.addEventListener('click', () => openBaseForm('source'));
  document.querySelector('#new-base-treated')?.addEventListener('click', () => openBaseForm('treated'));

  const items = document.querySelector('#items');
  if (items) {
    new MutationObserver(scheduleTransform).observe(items, { childList: true });
    items.addEventListener('superexcel:pipeline-rendered', updateCapability);
  }
  new MutationObserver(updateCapability).observe(document.body, { attributes: true, attributeFilter: ['data-project-role'] });
  updateCapability();
})();
