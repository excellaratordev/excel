'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const monitorPath = path.join(__dirname, '../../static/js/performance-telemetry.js');

function defineGlobal(name, value) {
  Object.defineProperty(global, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function installBrowserStubs(memory) {
  const display = {
    textContent: '',
    title: '',
    dataset: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };

  defineGlobal('window', global);
  defineGlobal('document', {
    documentElement: { dataset: { workbookId: '' } },
    querySelector(selector) { return selector === '#memory-usage' ? display : null; },
    addEventListener() {},
  });
  defineGlobal('performance', { memory });
  defineGlobal('navigator', {});
  defineGlobal('CustomEvent', class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  });
  defineGlobal('dispatchEvent', () => true);
  defineGlobal('setInterval', () => 1);
  defineGlobal('clearTimeout', () => {});
  return display;
}

test('exibe memória da aba em MB e publica o monitor no frontend', async () => {
  const mib = 1024 * 1024;
  const display = installBrowserStubs({
    usedJSHeapSize: 12.5 * mib,
    totalJSHeapSize: 24 * mib,
    jsHeapSizeLimit: 128 * mib,
  });

  delete require.cache[require.resolve(monitorPath)];
  require(monitorPath);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(display.textContent, 'RAM: 12,5 MB');
  assert.equal(display.dataset.memoryState, 'normal');
  assert.match(display.title, /Atualização a cada segundo/);
  assert.equal(global.SuperExcelMemoryMonitor.formatMemory(2.25 * mib), '2,3 MB');
});
