(() => {
  'use strict';

  function assertColumnLengths(columns) {
    const lengths = Object.values(columns || {}).map(column => column?.length ?? 0);
    if (!lengths.length) return 0;
    const expected = lengths[0];
    if (lengths.some(length => length !== expected)) throw new Error('As colunas precisam ter o mesmo tamanho.');
    return expected;
  }

  function filterSum(columns, predicate, valueColumn) {
    const length = assertColumnLengths(columns);
    const values = columns[valueColumn];
    if (!values) throw new Error(`Coluna numérica não encontrada: ${valueColumn}`);
    let total = 0;
    let matched = 0;
    for (let index = 0; index < length; index += 1) {
      if (!predicate(columns, index)) continue;
      const value = Number(values[index]);
      if (Number.isFinite(value)) total += value;
      matched += 1;
    }
    return { total, matched, scanned: length };
  }

  class SharedFilterCache {
    constructor() {
      this.cache = new Map();
      this.executions = 0;
    }

    get(key, factory) {
      if (this.cache.has(key)) return this.cache.get(key);
      this.executions += 1;
      const result = factory();
      this.cache.set(key, result);
      return result;
    }

    invalidate(key = null) {
      if (key === null) this.cache.clear();
      else this.cache.delete(key);
    }
  }

  class IncrementalSum {
    constructor(values = []) {
      this.values = Float64Array.from(values, value => Number(value) || 0);
      this.total = 0;
      for (const value of this.values) this.total += value;
    }

    update(index, nextValue) {
      if (!Number.isInteger(index) || index < 0 || index >= this.values.length) throw new RangeError('Índice fora do intervalo.');
      const normalized = Number(nextValue) || 0;
      const previous = this.values[index];
      this.values[index] = normalized;
      this.total += normalized - previous;
      return { previous, next: normalized, total: this.total, delta: normalized - previous };
    }
  }

  const api = { assertColumnLengths, filterSum, SharedFilterCache, IncrementalSum };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SuperExcelEnterpriseKernel = api;
})();
