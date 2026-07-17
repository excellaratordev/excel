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
  const overviewRole = $('#overview-role');
  const roleBadge = $('#project-role');
  const folderCount = $('#folder-count');
  const workbookCount = $('#workbook-count');
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

  function itemType(element) {
    if (element.classList.contains('back-item')) return 'back';
    if (element.classList.contains('folder-item')) return 'folder';
    if (element.classList.contains('workbook-item')) return 'workbook';
    return 'other';
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
    if (overviewRole) overviewRole.textContent = role;
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
    const type = itemType(element);
    const name = element.querySelector('strong')?.textContent?.trim() || '';
    element.dataset.itemType = type;
    element.dataset.itemName = normalize(name);

    if (!element.querySelector('.item-type-label') && type !== 'back') {
      const label = document.createElement('span');
      label.className = 'item-type-label';
      label.textContent = type === 'folder' ? 'Pasta' : 'Planilha';
      element.querySelector('.icon')?.insertAdjacentElement('afterend', label);
    }

    if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
    if (element.dataset.uiDecorated === 'true') return;
    element.dataset.uiDecorated = 'true';
    if (type === 'folder' || type === 'workbook') {
      element.setAttribute('aria-label', `${type === 'folder' ? 'Pasta' : 'Planilha'} ${name}`);
      element.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        element.querySelector('.item-actions button')?.click();
      });
    }
  }

  function compareItems(left, right) {
    const leftType = itemType(left);
    const rightType = itemType(right);
    if (leftType === 'back') return -1;
    if (rightType === 'back') return 1;

    const mode = sort.value;
    if (mode === 'type') {
      const rank = { folder: 0, workbook: 1, other: 2 };
      const difference = (rank[leftType] ?? 3) - (rank[rightType] ?? 3);
      if (difference) return difference;
    }
    if (mode === 'updated') {
      const difference = itemTimestamp(right) - itemTimestamp(left);
      if (difference) return difference;
    }

    const leftName = left.querySelector('strong')?.textContent || '';
    const rightName = right.querySelector('strong')?.textContent || '';
    return leftName.localeCompare(rightName, 'pt-BR', { sensitivity: 'base' });
  }

  function refresh() {
    if (updating) return;
    updating = true;
    try {
      const cards = [...items.querySelectorAll(':scope > .item')];
      cards.forEach(decorate);

      const sorted = [...cards].sort(compareItems);
      const orderChanged = sorted.some((card, index) => cards[index] !== card);
      if (orderChanged) sorted.forEach(card => items.append(card));

      const query = normalize(search.value.trim());
      let visible = 0;
      let folders = 0;
      let workbooks = 0;

      for (const card of sorted) {
        const type = itemType(card);
        if (type === 'folder') folders += 1;
        if (type === 'workbook') workbooks += 1;
        const matches = type === 'back' || !query || card.dataset.itemName.includes(query);
        card.classList.toggle('is-filtered', !matches);
        if (matches && type !== 'back') visible += 1;
      }

      const nativeEmpty = items.querySelector('.empty-state:not(.search-empty-state)');
      let searchEmpty = items.querySelector('.search-empty-state');
      if (nativeEmpty) {
        nativeEmpty.hidden = false;
        const mode = query && !visible ? 'search' : 'native';
        if (nativeEmpty.dataset.mode !== mode) {
          nativeEmpty.dataset.mode = mode;
          nativeEmpty.innerHTML = mode === 'search'
            ? '<strong>Nenhum resultado encontrado</strong><span>Tente outro nome ou limpe a pesquisa.</span>'
            : '<strong>Nenhum arquivo nesta pasta</strong><span>Crie uma pasta ou planilha para começar.</span>';
        }
        searchEmpty?.remove();
      } else if (query && !visible) {
        if (!searchEmpty) {
          searchEmpty = document.createElement('div');
          searchEmpty.className = 'empty-state search-empty-state';
          searchEmpty.innerHTML = '<strong>Nenhum resultado encontrado</strong><span>Tente outro nome ou limpe a pesquisa.</span>';
          items.append(searchEmpty);
        }
      } else {
        searchEmpty?.remove();
      }

      if (folderCount) folderCount.textContent = String(folders);
      if (workbookCount) workbookCount.textContent = String(workbooks);
      if (visibleCount) visibleCount.textContent = `${visible} item${visible === 1 ? '' : 's'}`;
      if (fileContext) {
        const folder = $('#current-folder')?.textContent?.replace(/^›\s*/, '').trim();
        fileContext.textContent = folder
          ? `Organizando arquivos em ${folder}`
          : 'Centralize planilhas, pastas e recursos do projeto.';
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

  applyLayout(layout);
  refresh();
})();
