(() => {
  'use strict';

  const workbookId = Number(document.documentElement.dataset.workbookId || 0);
  if (!workbookId || window.parent === window) return;

  const subscriptions = new Map();
  let hydrated = false;
  let publishTimer = null;
  let pollTimer = null;

  function runtime() {
    const value = window.SuperExcelActiveRuntime;
    return value?.getCellValue ? value : null;
  }

  function normalizeCells(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const output = [];
    for (const item of value.slice(0, 5000)) {
      const row = Number(item?.r ?? item?.row);
      const col = Number(item?.c ?? item?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      const key = `${row}:${col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ r: row, c: col });
    }
    return output;
  }

  function jsonValue(activeRuntime, row, col) {
    const coordinate = { sheet: 0, row, col };
    let value = activeRuntime.getCellValue(coordinate);
    if (value && value.__superexcelTyped) value = value.value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) value = value.value;
    const type = String(activeRuntime.getCellValueDetailedType?.(coordinate) || '');
    if (typeof value === 'number' && type.includes('DATE')) {
      const date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + Math.floor(value));
      return { value: date.toISOString().slice(0, 10), type: 'DATE' };
    }
    if (value === undefined) value = null;
    return { value, type: type || null };
  }

  function post(message) {
    try {
      window.parent.postMessage(message, location.origin);
    } catch (error) {
      console.debug('Ponte de valores indisponível.', error);
    }
  }

  function announceReady() {
    if (!runtime()) return false;
    hydrated = true;
    post({ type: 'superexcel:value-bridge-ready', workbookId });
    return true;
  }

  function publish(subscriptionId) {
    const activeRuntime = runtime();
    const cells = subscriptions.get(subscriptionId);
    if (!activeRuntime || !cells?.length) return;
    const values = cells.map(cell => {
      const result = jsonValue(activeRuntime, cell.r, cell.c);
      return { r: cell.r, c: cell.c, v: result.value, t: result.type };
    });
    post({
      type: 'superexcel:value-bridge-values',
      workbookId,
      subscriptionId,
      values,
      observedAt: new Date().toISOString(),
    });
  }

  function publishAll() {
    publishTimer = null;
    if (!hydrated && !announceReady()) return;
    subscriptions.forEach((_, subscriptionId) => publish(subscriptionId));
  }

  function schedulePublish(delay = 80) {
    if (publishTimer) window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(publishAll, delay);
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const message = event.data || {};
    if (message.type !== 'superexcel:value-subscribe') return;
    if (Number(message.workbookId) !== workbookId) return;
    const subscriptionId = String(message.subscriptionId || 'default');
    subscriptions.set(subscriptionId, normalizeCells(message.cells));
    if (!hydrated) announceReady();
    schedulePublish(0);
  });

  window.addEventListener('superexcel:hydrated', () => {
    hydrated = true;
    announceReady();
    schedulePublish(0);
  });
  window.addEventListener('superexcel:changes', () => schedulePublish());
  window.addEventListener('superexcel:rendered', () => schedulePublish());
  window.addEventListener('online', () => schedulePublish(0));

  let attempts = 0;
  const readyTimer = window.setInterval(() => {
    attempts += 1;
    if (announceReady() || attempts > 120) window.clearInterval(readyTimer);
  }, 250);

  pollTimer = window.setInterval(() => {
    if (subscriptions.size) schedulePublish(0);
  }, 1800);

  window.addEventListener('pagehide', () => {
    if (publishTimer) window.clearTimeout(publishTimer);
    if (pollTimer) window.clearInterval(pollTimer);
    window.clearInterval(readyTimer);
  }, { once: true });
})();
