(() => {
  'use strict';

  const DEFAULT_ROW_CHUNK = 64;
  const DEFAULT_COL_CHUNK = 32;

  function coordinateKey(row, col) {
    return `${Number(row)}:${Number(col)}`;
  }

  function parseCoordinateKey(key) {
    const [row, col] = String(key).split(':').map(Number);
    return { row, col };
  }

  class DependencyGraph {
    constructor(options = {}) {
      this.rowChunk = Math.max(1, Number(options.rowChunk) || DEFAULT_ROW_CHUNK);
      this.colChunk = Math.max(1, Number(options.colChunk) || DEFAULT_COL_CHUNK);
      this.dependencies = new Map();
      this.exactDependents = new Map();
      this.rangeBuckets = new Map();
    }

    chunkKey(row, col) {
      return `${Math.floor(row / this.rowChunk)}:${Math.floor(col / this.colChunk)}`;
    }

    bucketsForRange(range) {
      const firstRow = Math.floor(range.top / this.rowChunk);
      const lastRow = Math.floor(range.bottom / this.rowChunk);
      const firstCol = Math.floor(range.left / this.colChunk);
      const lastCol = Math.floor(range.right / this.colChunk);
      const result = [];
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let col = firstCol; col <= lastCol; col += 1) result.push(`${row}:${col}`);
      }
      return result;
    }

    removeFormula(formulaKey) {
      const previous = this.dependencies.get(formulaKey);
      if (!previous) return;

      for (const dependencyKey of previous.cells) {
        const dependents = this.exactDependents.get(dependencyKey);
        if (!dependents) continue;
        dependents.delete(formulaKey);
        if (!dependents.size) this.exactDependents.delete(dependencyKey);
      }

      for (const bucketKey of previous.buckets) {
        const dependents = this.rangeBuckets.get(bucketKey);
        if (!dependents) continue;
        dependents.delete(formulaKey);
        if (!dependents.size) this.rangeBuckets.delete(bucketKey);
      }

      this.dependencies.delete(formulaKey);
    }

    setFormula(formulaKey, dependencies = {}) {
      this.removeFormula(formulaKey);
      const cells = new Set(dependencies.cells || []);
      const ranges = (dependencies.ranges || []).map(range => ({ ...range }));
      const buckets = new Set();

      for (const dependencyKey of cells) {
        if (!this.exactDependents.has(dependencyKey)) this.exactDependents.set(dependencyKey, new Set());
        this.exactDependents.get(dependencyKey).add(formulaKey);
      }

      for (const range of ranges) {
        for (const bucketKey of this.bucketsForRange(range)) {
          buckets.add(bucketKey);
          if (!this.rangeBuckets.has(bucketKey)) this.rangeBuckets.set(bucketKey, new Set());
          this.rangeBuckets.get(bucketKey).add(formulaKey);
        }
      }

      this.dependencies.set(formulaKey, { cells, ranges, buckets });
    }

    directDependents(cellKey) {
      const { row, col } = parseCoordinateKey(cellKey);
      const result = new Set(this.exactDependents.get(cellKey) || []);
      const candidates = this.rangeBuckets.get(this.chunkKey(row, col)) || [];

      for (const formulaKey of candidates) {
        const definition = this.dependencies.get(formulaKey);
        if (!definition) continue;
        if (definition.ranges.some(range => (
          row >= range.top && row <= range.bottom && col >= range.left && col <= range.right
        ))) result.add(formulaKey);
      }
      return result;
    }

    collectAffected(changedKeys) {
      const affected = new Set();
      const queue = [];
      for (const key of changedKeys || []) {
        if (affected.has(key)) continue;
        affected.add(key);
        queue.push(key);
      }

      for (let index = 0; index < queue.length; index += 1) {
        for (const dependent of this.directDependents(queue[index])) {
          if (affected.has(dependent)) continue;
          affected.add(dependent);
          queue.push(dependent);
        }
      }
      return affected;
    }

    clear() {
      this.dependencies.clear();
      this.exactDependents.clear();
      this.rangeBuckets.clear();
    }

    stats() {
      let exactEdges = 0;
      let rangeEdges = 0;
      for (const definition of this.dependencies.values()) {
        exactEdges += definition.cells.size;
        rangeEdges += definition.ranges.length;
      }
      return {
        nodes: this.dependencies.size,
        edges: exactEdges + rangeEdges,
        exact_edges: exactEdges,
        range_edges: rangeEdges,
        range_buckets: this.rangeBuckets.size,
      };
    }
  }

  window.SuperExcelDependencyGraph = Object.freeze({
    DependencyGraph,
    coordinateKey,
    parseCoordinateKey,
  });
})();
