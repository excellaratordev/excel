(() => {
  'use strict';

  const ABI_VERSION = 2;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function instantiateModule(source, imports) {
    const response = typeof source === 'string' || source instanceof URL ? await fetch(source) : source;
    if (!(response instanceof Response)) return WebAssembly.instantiate(response, imports);
    try {
      return await WebAssembly.instantiateStreaming(response.clone(), imports);
    } catch (error) {
      console.debug('Wasm sem streaming; usando ArrayBuffer.', error);
      return WebAssembly.instantiate(await response.arrayBuffer(), imports);
    }
  }

  async function instantiate(source, imports = {}) {
    const result = await instantiateModule(source, imports);
    const instance = result.instance || result;
    const exports = instance.exports;
    const required = [
      'memory',
      'superexcel_abi_version',
      'superexcel_alloc',
      'superexcel_dealloc',
      'superexcel_validate_operation',
      'superexcel_evaluate_formula',
      'superexcel_last_result_len',
    ];
    for (const name of required) {
      if (!(name in exports)) throw new Error(`Módulo Wasm sem export obrigatório: ${name}.`);
    }
    const version = exports.superexcel_abi_version();
    if (version !== ABI_VERSION) throw new Error(`ABI Wasm incompatível: esperado ${ABI_VERSION}, recebido ${version}.`);

    function writePayload(payload) {
      const bytes = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const pointer = exports.superexcel_alloc(bytes.length);
      if (!pointer && bytes.length) throw new Error('Falha ao reservar memória no módulo Wasm.');
      if (bytes.length) new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      return { pointer, bytes };
    }

    function validateOperation(operation) {
      const { pointer, bytes } = writePayload(operation);
      try {
        return exports.superexcel_validate_operation(pointer, bytes.length) === 1;
      } finally {
        exports.superexcel_dealloc(pointer, bytes.length);
      }
    }

    function evaluateFormula(requestOrFormula, cells = {}) {
      const request = typeof requestOrFormula === 'string'
        ? { formula: requestOrFormula, cells }
        : requestOrFormula;
      const { pointer, bytes } = writePayload(request);
      let resultPointer = 0;
      let resultLength = 0;
      try {
        resultPointer = exports.superexcel_evaluate_formula(pointer, bytes.length);
        resultLength = Number(exports.superexcel_last_result_len());
        if (!resultPointer || !resultLength) throw new Error('O núcleo Wasm não retornou uma resposta.');
        const output = decoder.decode(new Uint8Array(exports.memory.buffer, resultPointer, resultLength));
        return JSON.parse(output);
      } finally {
        exports.superexcel_dealloc(pointer, bytes.length);
        if (resultPointer && resultLength) exports.superexcel_dealloc(resultPointer, resultLength);
      }
    }

    return Object.freeze({ instance, exports, version, validateOperation, evaluateFormula });
  }

  const api = Object.freeze({ ABI_VERSION, instantiate });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperExcelWasmContract = api;
})();
