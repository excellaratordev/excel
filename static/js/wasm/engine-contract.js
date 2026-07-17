(() => {
  'use strict';

  const ABI_VERSION = 1;

  async function instantiate(source, imports = {}) {
    const response = typeof source === 'string' || source instanceof URL ? await fetch(source) : source;
    const result = response instanceof Response
      ? await WebAssembly.instantiateStreaming(response, imports)
      : await WebAssembly.instantiate(source, imports);
    const instance = result.instance || result;
    const exports = instance.exports;
    if (typeof exports.superexcel_abi_version !== 'function') throw new Error('Módulo Wasm sem contrato Super Excel.');
    const version = exports.superexcel_abi_version();
    if (version !== ABI_VERSION) throw new Error(`ABI Wasm incompatível: esperado ${ABI_VERSION}, recebido ${version}.`);

    function validateOperation(operation) {
      const bytes = new TextEncoder().encode(JSON.stringify(operation));
      const pointer = exports.superexcel_alloc(bytes.length);
      if (!pointer && bytes.length) throw new Error('Falha ao reservar memória no módulo Wasm.');
      try {
        new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
        return exports.superexcel_validate_operation(pointer, bytes.length) === 1;
      } finally {
        exports.superexcel_dealloc(pointer, bytes.length);
      }
    }

    return { instance, exports, version, validateOperation };
  }

  const api = { ABI_VERSION, instantiate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperExcelWasmContract = api;
})();
