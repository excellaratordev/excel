(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const items = $('#items');
  const search = $('#file-search');
  const sort = $('#file-sort');
  const gridButton = $('#view-grid');
  const listButton = $('#view-list');
  const projectSelect = $('#project-select');
  const projectName = $('#workspace-project-name');
  const sidebarRole = $('#workspace-project-role');
  const roleBadge = $('#project-role');
  const visibleCount = $('#visible-count');
  const fileContext = $('#files-context');
  const STORAGE_KEY = 'super-excel-files-layout';

  if (!items || !search || !sort) return;

  let updating = false;
  let layout = localStorage.getItem(STORAGE_KEY) === 'list' ? 'list' : 'grid';

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function itemTimestamp(element) {
    const text = element.querySelector('small')?.textContent || '';
    const match = text.match(/Atualizada\s+(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})(?::(\d{2}))?/i);
    if (!match) return 0;
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0)).getTime();
  }

  function syncProxyButtons() {
    document.querySelectorAll('[data-proxy-click]').forEach(button => {
      const target = document.getElementById(button.dataset.proxyClick);
      button.disabled = Boolean(target?.disabled);
    });
  }

  function syncProjectIdentity() {
    const selected = projectSelect?.selectedOptions?.[0]?.textContent?.trim() || 'Projeto';
    if (projectName) projectName.textContent = selected;
    const role = roleBadge?.textContent?.trim() || 'Carregando acesso';
    if (sidebarRole) sidebarRole.textContent = role;
  }

  function applyLayout(nextLayout) {
    layout = nextLayout === 'list' ? 'list' : 'grid';
    items.dataset.layout = layout;
    gridButton?.classList.toggle('active', layout === 'grid');
    listButton?.classList.toggle('active', layout === 'list');
    gridButton?.setAttribute('aria-pressed', String(layout === 'grid'));
    listButton?.setAttribute('aria-pressed', String(layout === 'list'));
    localStorage.setItem(STORAGE_KEY, layout);
  }

  function decorate(element) {
    if (!element.classList.contains('item')) return;
    const name = element.querySelector('strong')?.textContent?.trim() || '';
    element.dataset.itemName = normalize(name);
    if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
    if (element.dataset.uiDecorated === 'true') return;
    element.dataset.uiDecorated = 'true';
    element.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      element.querySelector('.item-actions button')?.click();
    });
  }

  function compareCards(left, right) {
    if (sort.value === 'updated') {
      const difference = itemTimestamp(right) - itemTimestamp(left);
      if (difference) return difference;
    }
    const leftName = left.querySelector('strong')?.textContent || '';
    const rightName = right.querySelector('strong')?.textContent || '';
    return leftName.localeCompare(rightName, 'pt-BR', { sensitivity: 'base' });
  }

  function sortLane(container) {
    if (!container) return;
    const cards = [...container.querySelectorAll(':scope > .workbook-item')];
    cards.sort(compareCards).forEach(card => container.append(card));
    const empty = container.querySelector(':scope > .pipeline-lane-empty');
    if (empty) container.append(empty);
  }

  function refresh() {
    if (updating) return;
    updating = true;
    try {
      const cards = [...items.querySelectorAll('.workbook-item')];
      const folders = [...items.querySelectorAll('.folder-item')];
      cards.forEach(decorate);
      folders.forEach(decorate);
      items.querySelectorAll('.pipeline-lane-items').forEach(sortLane);

      const query = normalize(search.value.trim());
      let visible = 0;
      const counts = { source: 0, calculation: 0, treated: 0, publication: 0 };

      cards.forEach(card => {
        const stage = card.dataset.pipelineStage || 'calculation';
        counts[stage] = (counts[stage] || 0) + 1;
        const matches = !query || card.dataset.itemName.includes(query);
        card.classList.toggle('is-filtered', !matches);
        if (matches) visible += 1;
      });
      folders.forEach(folder => {
        const matches = !query || folder.dataset.itemName.includes(query);
        folder.classList.toggle('is-filtered', !matches);
      });

      items.querySelectorAll('.pipeline-lane').forEach(lane => {
        const stage = lane.dataset.stage;
        const empty = lane.querySelector('.pipeline-lane-empty');
        const visibleInLane = [...lane.querySelectorAll('.workbook-item')].some(card => !card.classList.contains('is-filtered'));
        if (empty) {
          empty.hidden = Boolean(counts[stage]) || Boolean(query && visibleInLane);
          if (query && !visibleInLane) {
            empty.hidden = false;
            empty.innerHTML = '<strong>Nenhum resultado</strong><span>Nenhum arquivo desta etapa corresponde à busca.</span>';
          }
        }
      });

      Object.entries(counts).forEach(([stage, count]) => {
        const target = document.getElementById(`${stage}-count`);
        if (target) target.textContent = String(count);
      });
      if (visibleCount) visibleCount.textContent = `${visible} arquivo${visible === 1 ? '' : 's'}`;
      if (fileContext) {
        const folder = $('#current-folder')?.textContent?.replace(/^›\s*/, '').trim();
        fileContext.textContent = folder
          ? `Pipeline organizado dentro de ${folder}.`
          : 'Dados entram por uma Base, são calculados nas planilhas, estabilizados na Base 2 e publicados pela Elementar.';
      }
      syncProjectIdentity();
      syncProxyButtons();
    } finally {
      updating = false;
    }
  }

  search.addEventListener('input', refresh);
  sort.addEventListener('change', refresh);
  gridButton?.addEventListener('click', () => applyLayout('grid'));
  listButton?.addEventListener('click', () => applyLayout('list'));
  projectSelect?.addEventListener('change', () => requestAnimationFrame(syncProjectIdentity));
  document.querySelectorAll('[data-proxy-click]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.proxyClick)?.click());
  });

  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
      event.preventDefault();
      search.focus();
    }
  });

  const observer = new MutationObserver(() => requestAnimationFrame(refresh));
  observer.observe(items, { childList: true, subtree: true, characterData: true });
  if (roleBadge) observer.observe(roleBadge, { childList: true, subtree: true, characterData: true });
  items.addEventListener('superexcel:pipeline-rendered', refresh);

  applyLayout(layout);
  refresh();
})();
