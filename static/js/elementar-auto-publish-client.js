(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const originalFetch = window.fetch.bind(window);
  const legacyPublishPath = `/api/elementar/workbooks/${workbookId}/publish`;
  const automaticPublishPath = `/api/elementar/workbooks/${workbookId}/auto-publish`;

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && new URL(url, location.origin).pathname === legacyPublishPath) {
      const replacement = new URL(url, location.origin);
      replacement.pathname = automaticPublishPath;
      if (typeof input === 'string') return originalFetch(replacement.href, init);
      return originalFetch(new Request(replacement.href, input), init);
    }
    return originalFetch(input, init);
  };

  const state = {
    timer: null,
    lastSubmittedJson: '',
    publishing: false,
  };

  function validLiveJson() {
    const panel = document.querySelector('#elementar-live-panel');
    const code = document.querySelector('#elementar-live-json');
    const button = document.querySelector('#elementar-publish-button');
    if (!panel || !code || !button || panel.hidden || panel.dataset.liveState !== 'ready' || button.disabled) return null;
    const text = code.textContent?.trim() || '';
    if (!text || text.startsWith('//')) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? text : null;
    } catch {
      return null;
    }
  }

  function scheduleAutomaticPublish(delay = 720) {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      if (state.publishing) return;
      const text = validLiveJson();
      if (!text || text === state.lastSubmittedJson) return;
      const button = document.querySelector('#elementar-publish-button');
      if (!button) return;
      state.publishing = true;
      state.lastSubmittedJson = text;
      button.click();
      window.setTimeout(() => {
        const status = document.querySelector('#elementar-status');
        const panel = document.querySelector('#elementar-live-panel');
        if (status?.classList.contains('error') || panel?.dataset.liveState === 'error') {
          state.lastSubmittedJson = '';
        }
        state.publishing = false;
        if (validLiveJson() && validLiveJson() !== state.lastSubmittedJson) scheduleAutomaticPublish(350);
      }, 1800);
    }, delay);
  }

  function observe() {
    const panel = document.querySelector('#elementar-live-panel');
    const code = document.querySelector('#elementar-live-json');
    const button = document.querySelector('#elementar-publish-button');
    if (!panel || !code || !button) return false;
    const observer = new MutationObserver(() => scheduleAutomaticPublish());
    observer.observe(panel, { attributes: true, attributeFilter: ['data-live-state', 'hidden'] });
    observer.observe(code, { childList: true, characterData: true, subtree: true });
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    scheduleAutomaticPublish(1000);
    return true;
  }

  if (!observe()) {
    const ready = new MutationObserver(() => {
      if (!observe()) return;
      ready.disconnect();
    });
    ready.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
