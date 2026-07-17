(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  const parserApi = window.SuperExcelFormulaParser;
  if (!engineApi || !parserApi || engineApi.externalReferencesInstalled) return;

  const originalCreate = engineApi.create.bind(engineApi);
  const probe = originalCreate([]);
  const prototype = Object.getPrototypeOf(probe);
  probe.destroy?.();

  function ensure(instance) {
    if (!instance.externalSources) instance.externalSources = new Map();
    if (!instance.externalDependents) instance.externalDependents = new Map();
    if (!instance.formulaExternalSources) instance.formulaExternalSources = new Map();
    if (!instance.externalReferenceCount) instance.externalReferenceCount = 0;
  }

  function removeFormulaDependencies(instance, formulaKey) {
    ensure(instance);
    const previous = instance.formulaExternalSources.get(formulaKey);
    if (!previous) return;
    for (const sourceKey of previous) {
      const dependents = instance.externalDependents.get(sourceKey);
      if (!dependents) continue;
      dependents.delete(formulaKey);
      if (!dependents.size) instance.externalDependents.delete(sourceKey);
    }
    instance.externalReferenceCount = Math.max(0, instance.externalReferenceCount - previous.size);
    instance.formulaExternalSources.delete(formulaKey);
  }

  function registerFormulaDependencies(instance, formulaKey, ast) {
    ensure(instance);
    const dependencies = parserApi.collectDependencies(ast);
    const sourceKeys = new Set((dependencies.external || []).map(item => item.sourceKey));
    if (!sourceKeys.size) return;
    instance.formulaExternalSources.set(formulaKey, sourceKeys);
    instance.externalReferenceCount += sourceKeys.size;
    for (const sourceKey of sourceKeys) {
      if (!instance.externalDependents.has(sourceKey)) instance.externalDependents.set(sourceKey, new Set());
      instance.externalDependents.get(sourceKey).add(formulaKey);
    }
  }

  function invalidateSources(instance, sourceKeys) {
    ensure(instance);
    const seeds = new Set();
    for (const sourceKey of sourceKeys) {
      for (const formulaKey of instance.externalDependents.get(sourceKey) || []) seeds.add(formulaKey);
    }
    if (!seeds.size) return;
    const affected = instance.graph?.collectAffected?.(seeds) || seeds;
    for (const key of affected) {
      instance.cache?.delete?.(key);
      instance.lastAffected?.add?.(key);
      if (instance.formulas?.has?.(key)) {
        for (const spillKey of instance._clearSpill?.(key) || []) instance.lastAffected?.add?.(spillKey);
      }
    }
  }

  function sourcePayload(source, previous = null) {
    const revision = Number(source?.revision || 0);
    const keepPrevious = previous && Number(previous.revision || 0) === revision;
    const cells = keepPrevious ? new Map(previous.cells) : new Map();
    for (const item of Array.isArray(source?.cells) ? source.cells : []) {
      const row = Number(item?.r ?? item?.row);
      const col = Number(item?.c ?? item?.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
      cells.set(`${row}:${col}`, item?.v ?? item?.value ?? null);
    }
    return {
      id: Number(source?.id || previous?.id || 0) || null,
      name: String(source?.name || previous?.name || ''),
      revision,
      cells,
    };
  }

  const originalDefineCell = prototype._defineCell;
  prototype._defineCell = function defineCellWithExternalReferences(key, value) {
    removeFormulaDependencies(this, key);
    const result = originalDefineCell.call(this, key, value);
    const ast = this.parsed?.get?.(key);
    if (ast) registerFormulaDependencies(this, key, ast);
    return result;
  };

  const originalEvaluateAst = prototype._evaluateAst;
  prototype._evaluateAst = function evaluateAstWithExternalReferences(node, stack) {
    ensure(this);
    if (node?.type === 'externalReference') {
      const source = this.externalSources.get(node.sourceKey);
      if (!source) return '#REF!';
      return source.cells.get(`${node.row}:${node.col}`) ?? null;
    }
    if (node?.type === 'externalRange') {
      const source = this.externalSources.get(node.sourceKey);
      if (!source) return '#REF!';
      const top = Math.min(node.start.row, node.end.row);
      const bottom = Math.max(node.start.row, node.end.row);
      const left = Math.min(node.start.col, node.end.col);
      const right = Math.max(node.start.col, node.end.col);
      return Array.from({ length: bottom - top + 1 }, (_, rowOffset) => (
        Array.from({ length: right - left + 1 }, (_, colOffset) => (
          source.cells.get(`${top + rowOffset}:${left + colOffset}`) ?? null
        ))
      ));
    }
    return originalEvaluateAst.call(this, node, stack);
  };

  prototype.setExternalSources = function setExternalSources(sources, options = {}) {
    ensure(this);
    const changed = new Set();
    if (options.replace) {
      for (const key of this.externalSources.keys()) changed.add(key);
      this.externalSources.clear();
    }
    for (const item of Array.isArray(sources) ? sources : []) {
      const sourceKey = parserApi.normalizeSourceName(item?.name);
      if (!sourceKey) continue;
      const previous = this.externalSources.get(sourceKey);
      const next = sourcePayload(item, previous);
      this.externalSources.set(sourceKey, next);
      changed.add(sourceKey);
    }
    invalidateSources(this, changed);
    return {
      source_count: this.externalSources.size,
      cell_count: [...this.externalSources.values()].reduce((total, source) => total + source.cells.size, 0),
      changed_sources: [...changed],
    };
  };

  prototype.getExternalDependencies = function getExternalDependencies() {
    ensure(this);
    const references = [];
    for (const ast of this.parsed?.values?.() || []) {
      references.push(...(parserApi.collectDependencies(ast).external || []));
    }
    return references;
  };

  const originalStats = prototype.getStats;
  prototype.getStats = function getStatsWithExternalReferences() {
    ensure(this);
    const stats = originalStats.call(this);
    return {
      ...stats,
      external_sources: this.externalSources.size,
      external_cells: [...this.externalSources.values()].reduce((total, source) => total + source.cells.size, 0),
      external_dependency_edges: this.externalReferenceCount,
    };
  };

  const originalDestroy = prototype.destroy;
  prototype.destroy = function destroyWithExternalReferences() {
    ensure(this);
    this.externalSources.clear();
    this.externalDependents.clear();
    this.formulaExternalSources.clear();
    this.externalReferenceCount = 0;
    return originalDestroy.call(this);
  };

  engineApi.create = function createWithExternalReferences(data, options = {}) {
    const instance = originalCreate(data);
    ensure(instance);
    if (Array.isArray(options.externalSources)) {
      instance.setExternalSources(options.externalSources, { replace: true });
    }
    return instance;
  };
  engineApi.externalReferencesInstalled = true;
})();
