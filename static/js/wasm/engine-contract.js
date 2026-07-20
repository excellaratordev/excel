(() => {
  'use strict';

  const ABI_VERSION = 7;
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
      'superexcel_compile_formula',
      'superexcel_last_result_len',
      'superexcel_workbook_create',
      'superexcel_workbook_apply',
      'superexcel_workbook_get_cell',
      'superexcel_workbook_get_spill',
      'superexcel_workbook_stats',
      'superexcel_workbook_destroy',
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

    function readJsonResult(resultPointer) {
      const resultLength = Number(exports.superexcel_last_result_len());
      if (!resultPointer || !resultLength) throw new Error('O núcleo Wasm não retornou uma resposta.');
      try {
        const output = decoder.decode(new Uint8Array(exports.memory.buffer, resultPointer, resultLength));
        return JSON.parse(output);
      } finally {
        exports.superexcel_dealloc(resultPointer, resultLength);
      }
    }

    function withPayload(payload, callback) {
      const { pointer, bytes } = writePayload(payload);
      try {
        return callback(pointer, bytes.length);
      } finally {
        exports.superexcel_dealloc(pointer, bytes.length);
      }
    }

    function validateOperation(operation) {
      return withPayload(operation, (pointer, length) => (
        exports.superexcel_validate_operation(pointer, length) === 1
      ));
    }

    function evaluateFormula(requestOrFormula, cells = {}) {
      const request = typeof requestOrFormula === 'string'
        ? { formula: requestOrFormula, cells }
        : requestOrFormula;
      return withPayload(request, (pointer, length) => (
        readJsonResult(exports.superexcel_evaluate_formula(pointer, length))
      ));
    }

    function compileFormula(formula) {
      return withPayload({ formula }, (pointer, length) => (
        readJsonResult(exports.superexcel_compile_formula(pointer, length))
      ));
    }

    function createWorkbook(requestOrCells = {}) {
      const request = requestOrCells && Object.prototype.hasOwnProperty.call(requestOrCells, 'cells')
        ? requestOrCells
        : { cells: requestOrCells || {} };
      return withPayload(request, (pointer, length) => (
        readJsonResult(exports.superexcel_workbook_create(pointer, length))
      ));
    }

    function applyWorkbook(handle, requestOrChanges = {}) {
      const request = requestOrChanges && Object.prototype.hasOwnProperty.call(requestOrChanges, 'changes')
        ? requestOrChanges
        : { changes: requestOrChanges || {} };
      return withPayload(request, (pointer, length) => (
        readJsonResult(exports.superexcel_workbook_apply(Number(handle) || 0, pointer, length))
      ));
    }

    function getWorkbookCell(handle, cell) {
      return withPayload({ cell }, (pointer, length) => (
        readJsonResult(exports.superexcel_workbook_get_cell(Number(handle) || 0, pointer, length))
      ));
    }

    function getWorkbookSpill(handle, cell) {
      return withPayload({ cell }, (pointer, length) => (
        readJsonResult(exports.superexcel_workbook_get_spill(Number(handle) || 0, pointer, length))
      ));
    }

    function getWorkbookStats(handle) {
      return readJsonResult(exports.superexcel_workbook_stats(Number(handle) || 0));
    }

    function destroyWorkbook(handle) {
      return exports.superexcel_workbook_destroy(Number(handle) || 0) === 1;
    }

    return Object.freeze({
      instance,
      exports,
      version,
      validateOperation,
      evaluateFormula,
      compileFormula,
      createWorkbook,
      applyWorkbook,
      getWorkbookCell,
      getWorkbookSpill,
      getWorkbookStats,
      destroyWorkbook,
    });
  }

  const api = Object.freeze({ ABI_VERSION, instantiate });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperExcelWasmContract = api;
})();
