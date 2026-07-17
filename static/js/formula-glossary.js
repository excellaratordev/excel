(() => {
  'use strict';

  let initialized = false;

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR');
  }

  function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    return Promise.resolve();
  }

  function init() {
    if (initialized) return;
    const catalog = window.SuperExcelFormulaCatalog;
    const button = document.querySelector('#functions-button');
    const dialog = document.querySelector('#functions-dialog');
    const list = document.querySelector('#functions-list');
    const search = document.querySelector('#functions-search');
    const category = document.querySelector('#functions-category');
    const count = document.querySelector('#functions-result-count');
    const titleCount = document.querySelector('#functions-total-count');
    const formulaInput = document.querySelector('#formula-input');

    if (!catalog?.items?.length || !button || !dialog || !list || !search || !category) return;
    initialized = true;

    button.textContent = `Fórmulas (${catalog.count})`;
    button.title = 'Abrir glossário de fórmulas';
    if (titleCount) titleCount.textContent = String(catalog.count);

    category.replaceChildren(new Option('Todas as categorias', ''));
    for (const item of catalog.categories) category.append(new Option(item, item));

    function matches(item) {
      const query = normalize(search.value.trim());
      const categoryMatch = !category.value || item.category === category.value;
      if (!categoryMatch) return false;
      if (!query) return true;
      const haystack = normalize([
        item.name,
        ...item.aliases,
        item.category,
        item.description,
        item.syntax,
        item.example,
      ].join(' '));
      return haystack.includes(query);
    }

    function useExample(example) {
      dialog.close();
      formulaInput?.focus();
      if (!formulaInput || formulaInput.disabled || formulaInput.readOnly) return;
      formulaInput.value = example;
      formulaInput.dispatchEvent(new Event('input', { bubbles: true }));
      formulaInput.select();
      const status = document.querySelector('#status-message');
      if (status) status.textContent = 'Exemplo colocado na barra de fórmulas. Pressione Enter para aplicar.';
    }

    function createCard(item) {
      const card = document.createElement('article');
      card.className = 'formula-glossary-card';
      card.dataset.category = item.category;

      const heading = document.createElement('div');
      heading.className = 'formula-glossary-heading';

      const identity = document.createElement('div');
      identity.className = 'formula-glossary-identity';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const aliases = document.createElement('span');
      aliases.textContent = item.aliases.length ? `Também aceita: ${item.aliases.join(', ')}` : 'Nome único';
      identity.append(name, aliases);

      const categoryBadge = document.createElement('span');
      categoryBadge.className = 'formula-category-badge';
      categoryBadge.textContent = item.category;
      heading.append(identity, categoryBadge);

      const description = document.createElement('p');
      description.className = 'formula-description';
      description.textContent = item.description;

      const syntaxBlock = document.createElement('div');
      syntaxBlock.className = 'formula-code-block';
      syntaxBlock.innerHTML = '<span>Sintaxe</span><code></code>';
      syntaxBlock.querySelector('code').textContent = item.syntax;

      const exampleBlock = document.createElement('div');
      exampleBlock.className = 'formula-code-block formula-example-block';
      exampleBlock.innerHTML = '<span>Exemplo de uso</span><code></code>';
      exampleBlock.querySelector('code').textContent = item.example;

      const actions = document.createElement('div');
      actions.className = 'formula-glossary-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copiar exemplo';
      copy.onclick = async () => {
        const previous = copy.textContent;
        try {
          await copyText(item.example);
          copy.textContent = 'Copiado';
        } catch {
          copy.textContent = 'Não foi possível copiar';
        }
        window.setTimeout(() => { copy.textContent = previous; }, 1400);
      };
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'primary';
      use.textContent = 'Usar na célula';
      use.onclick = () => useExample(item.example);
      actions.append(copy, use);

      card.append(heading, description, syntaxBlock, exampleBlock, actions);
      return card;
    }

    function render() {
      const filtered = catalog.items.filter(matches);
      list.replaceChildren(...filtered.map(createCard));
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'formula-glossary-empty';
        empty.innerHTML = '<strong>Nenhuma fórmula encontrada</strong><span>Tente outro termo ou selecione todas as categorias.</span>';
        list.append(empty);
      }
      if (count) count.textContent = `${filtered.length} de ${catalog.count} fórmulas`;
    }

    button.onclick = () => {
      render();
      dialog.showModal();
      window.setTimeout(() => search.focus(), 0);
    };
    search.addEventListener('input', render);
    category.addEventListener('change', render);
    render();
  }

  window.addEventListener('superexcel:ready', init, { once: true });
  if (window.SuperExcelApp) init();
})();