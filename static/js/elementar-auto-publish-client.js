(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId) return;

  const declarationPattern = /^\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.-]*)\s*=\s*'((?:[^']|'')+)'\s*!\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\s*$/iu;
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
    lastSubmittedFingerprint: '',
    publishing: false,
  };

  function declarationFingerprint() {
    const payload = window.SuperExcelApp?.getSnapshot?.();
    const values = Array.isArray(payload?.cells) ? payload.cells : [];
    const declarations = [];
    const sparse = payload?.storage === 'sparse' || (values.length && !Array.isArray(values[0]));
    if (sparse) {
      for (const item of values) {
        const value = item?.v ?? item?.value;
        if (typeof value !== 'string' || !declarationPattern.test(value.trim())) continue;
        declarations.push(`${Number(item?.r)}:${Number(item?.c)}:${value.trim()}`);
      }
    } else {
      values.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) return;
        row.forEach((value, col) => {
          if (typeof value === 'string' && declarationPattern.test(value.trim())) {
            declarations.push(`${rowIndex}:${col}:${value.trim()}`);
          }
        });
      });
    }
    return declarations.sort().join('|');
  }

  function validLivePublication() {
    const panel = document.querySelector('#elementar-live-panel');
    const code = document.querySelector('#elementar-live-json');
    const button = document.querySelector('#elementar-publish-button');
    if (!panel || !code || !button || panel.hidden || panel.dataset.liveState !== 'ready' || button.disabled) return null;
    const json = code.textContent?.trim() || '';
    if (!json || json.startsWith('//')) return null;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return {
        json,
        fingerprint: `${declarationFingerprint()}\n${json}`,
      };
    } catch {
      return null;
    }
  }

  function scheduleAutomaticPublish(delay = 720) {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.timer = null;
      if (state.publishing) return;
      const publication = validLivePublication();
      if (!publication || publication.fingerprint === state.lastSubmittedFingerprint) return;
      const button = document.querySelector('#elementar-publish-button');
      if (!button) return;
      state.publishing = true;
      state.lastSubmittedFingerprint = publication.fingerprint;
      button.click();
      window.setTimeout(() => {
        const status = document.querySelector('#elementar-status');
        const panel = document.querySelector('#elementar-live-panel');
        if (status?.classList.contains('error') || panel?.dataset.liveState === 'error') {
          state.lastSubmittedFingerprint = '';
        }
        state.publishing = false;
        const current = validLivePublication();
        if (current && current.fingerprint !== state.lastSubmittedFingerprint) scheduleAutomaticPublish(350);
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
    window.addEventListener('superexcel:changes', () => scheduleAutomaticPublish(900));
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
