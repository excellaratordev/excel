(() => {
  'use strict';

  const parserApi = window.SuperExcelFormulaParser;
  const graphApi = window.SuperExcelDependencyGraph;
  const functions = window.SuperExcelFunctionLibrary;
  if (!parserApi || !graphApi || !functions) throw new Error('Módulos do motor de cálculo não foram carregados.');

  const { DependencyGraph, coordinateKey, parseCoordinateKey } = graphApi;

  function isFormula(value) {
    return typeof value === 'string' && value.trimStart().startsWith('=');
  }

  function isBlank(value) {
    return value === null || value === undefined || value === '';
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeFormula(value) {
    if (!isFormula(value)) return value;
    return String(value).trim();
  }

  function normalizeDataForEngine(data) {
    return (Array.isArray(data) ? data : []).map(row => (
      (Array.isArray(row) ? row : []).map(normalizeFormula)
    ));
  }

  function normalizedMatrix(value) {
    if (!Array.isArray(value)) return [[value]];
    if (!value.length) return [];
    return Array.isArray(value[0]) ? value : value.map(item => [item]);
  }

  function unwrapTyped(value) {
    if (value && value.__superexcelTyped) return { value: value.value, type: value.type || null };
    return { value, type: null };
  }

  function isError(value) {
    return functions.isError(value);
  }

  function toNumber(value) {
    const unwrapped = functions.unwrap(value);
    if (isError(unwrapped)) return unwrapped;
    if (isBlank(unwrapped)) return 0;
    if (typeof unwrapped === 'number') return Number.isFinite(unwrapped) ? unwrapped : '#NUM!';
    if (typeof unwrapped === 'boolean') return unwrapped ? 1 : 0;
    const normalized = String(unwrapped).trim().replaceAll('.', '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : '#VALOR!';
  }

  function applyScalarBinary(operator, leftValue, rightValue) {
    const left = functions.unwrap(leftValue);
    const right = functions.unwrap(rightValue);
    if (isError(left)) return left;
    if (isError(right)) return right;

    if (['=', '<>', '<', '>', '<=', '>='].includes(operator)) {
      const comparison = functions.compareValues(left, right);
      switch (operator) {
        case '=': return comparison === 0;
        case '<>': return comparison !== 0;
        case '<': return comparison < 0;
        case '>': return comparison > 0;
        case '<=': return comparison <= 0;
        case '>=': return comparison >= 0;
        default: return false;
      }
    }

    if (operator === '&') return `${isBlank(left) ? '' : left}${isBlank(right) ? '' : right}`;
    const numericLeft = toNumber(left);
    const numericRight = toNumber(right);
    if (isError(numericLeft)) return numericLeft;
    if (isError(numericRight)) return numericRight;

    switch (operator) {
      case '+': return numericLeft + numericRight;
      case '-': return numericLeft - numericRight;
      case '*': return numericLeft * numericRight;
      case '/': return numericRight === 0 ? '#DIV/0!' : numericLeft / numericRight;
      case '^': {
        const value = numericLeft ** numericRight;
        return Number.isFinite(value) ? value : '#NUM!';
      }
      default: return '#NOME?';
    }
  }

  function broadcastBinary(operator, left, right) {
    const leftIsArray = Array.isArray(left);
    const rightIsArray = Array.isArray(right);
    if (!leftIsArray && !rightIsArray) return applyScalarBinary(operator, left, right);

    const leftMatrix = normalizedMatrix(left);
    const rightMatrix = normalizedMatrix(right);
    const height = Math.max(leftMatrix.length || 1, rightMatrix.length || 1);
    const width = Math.max(leftMatrix[0]?.length || 1, rightMatrix[0]?.length || 1);

    function valueAt(matrix, row, col) {
      const sourceRow = matrix.length === 1 ? 0 : row;
      const rowValues = matrix[sourceRow] || [];
      const sourceCol = rowValues.length === 1 ? 0 : col;
      return rowValues[sourceCol];
    }

    const compatible = matrix => (
      (matrix.length === 1 || matrix.length === height)
      && matrix.every(row => row.length === 1 || row.length === width)
    );
    if (!compatible(leftMatrix) || !compatible(rightMatrix)) return '#VALOR!';

    return Array.from({ length: height }, (_, row) => (
      Array.from({ length: width }, (_, col) => (
        applyScalarBinary(operator, valueAt(leftMatrix, row, col), valueAt(rightMatrix, row, col))
      ))
    ));
  }

  class FormulaRuntime {
    constructor(data = []) {
      this.rows = Math.max(1, Array.isArray(data) ? data.length : 1);
      this.cols = Math.max(1, ...(Array.isArray(data) ? data.map(row => Array.isArray(row) ? row.length : 0) : [1]));
      this.raw = new Map();
      this.formulas = new Set();
      this.parsed = new Map();
      this.parseErrors = new Map();
      this.cache = new Map();
      this.graph = new DependencyGraph();
      this.spillValues = new Map();
      this.spillTargets = new Map();
      this.lastAffected = new Set();
      this.undoStack = [];
      this.redoStack = [];
      this.suspendDepth = 0;
      this.pendingTransaction = null;
      this.pendingChanged = new Set();
      this.replayingHistory = false;
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.lastCalculationMs = 0;
      this.totalCalculationMs = 0;
      this.calculationCount = 0;

      const normalized = normalizeDataForEngine(data);
      for (let row = 0; row < normalized.length; row += 1) {
        for (let col = 0; col < normalized[row].length; col += 1) {
          const value = normalized[row][col];
          if (!isBlank(value)) this._defineCell(coordinateKey(row, col), value);
        }
      }
      this.lastAffected.clear();
      this.undoStack.length = 0;
    }

    _recordChange(key, before, after) {
      if (this.replayingHistory) return;
      if (!this.pendingTransaction) this.pendingTransaction = new Map();
      const existing = this.pendingTransaction.get(key);
      this.pendingTransaction.set(key, {
        key,
        before: existing ? existing.before : cloneValue(before),
        after: cloneValue(after),
      });
    }

    _commitTransaction() {
      if (!this.pendingTransaction?.size) {
        this.pendingTransaction = null;
        return;
      }
      const changes = [...this.pendingTransaction.values()]
        .filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after));
      this.pendingTransaction = null;
      if (!changes.length) return;
      this.undoStack.push(changes);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }

    _clearSpill(ownerKey) {
      const targets = this.spillTargets.get(ownerKey);
      if (!targets) return new Set();
      const removed = new Set();
      for (const key of targets) {
        const spill = this.spillValues.get(key);
        if (spill?.owner === ownerKey) {
          this.spillValues.delete(key);
          removed.add(key);
        }
      }
      this.spillTargets.delete(ownerKey);
      return removed;
    }

    _defineCell(key, value) {
      const normalized = normalizeFormula(value);
      this.graph.removeFormula(key);
      this.formulas.delete(key);
      this.parsed.delete(key);
      this.parseErrors.delete(key);

      if (isBlank(normalized)) this.raw.delete(key);
      else this.raw.set(key, normalized);

      if (!isFormula(normalized)) return;
      this.formulas.add(key);
      try {
        const ast = parserApi.parse(normalized);
        this.parsed.set(key, ast);
        this.graph.setFormula(key, parserApi.collectDependencies(ast));
      } catch (error) {
        this.parseErrors.set(key, error?.code || '#NOME?');
      }
    }

    _invalidate(changedKeys) {
      const pending = new Set(changedKeys || []);
      const affected = new Set();

      while (pending.size) {
        const current = [...pending];
        pending.clear();
        const expanded = this.graph.collectAffected(current);
        for (const key of expanded) {
          if (affected.has(key)) continue;
          affected.add(key);
          this.cache.delete(key);
          if (this.formulas.has(key)) {
            for (const spillKey of this._clearSpill(key)) {
              if (!affected.has(spillKey)) pending.add(spillKey);
            }
          }
        }
      }

      for (const key of affected) this.lastAffected.add(key);
      return affected;
    }

    _queueChanged(keys) {
      for (const key of keys) this.pendingChanged.add(key);
      if (this.suspendDepth === 0) {
        this._invalidate(this.pendingChanged);
        this.pendingChanged.clear();
        this._commitTransaction();
      }
    }

    _setRaw(key, value) {
      const previous = this.raw.get(key) ?? null;
      const normalized = normalizeFormula(value);
      this._recordChange(key, previous, normalized ?? null);
      const changed = new Set([key, ...this._clearSpill(key)]);
      this._defineCell(key, normalized);
      this._queueChanged(changed);
    }

    setCellContents(origin, matrix) {
      const startRow = Number(origin?.row) || 0;
      const startCol = Number(origin?.col) || 0;
      const values = Array.isArray(matrix) ? matrix : [[matrix]];
      const ownsTransaction = this.suspendDepth === 0;
      if (ownsTransaction) this.suspendEvaluation();
      try {
        for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
          const row = Array.isArray(values[rowOffset]) ? values[rowOffset] : [values[rowOffset]];
          for (let colOffset = 0; colOffset < row.length; colOffset += 1) {
            const targetRow = startRow + rowOffset;
            const targetCol = startCol + colOffset;
            this.rows = Math.max(this.rows, targetRow + 1);
            this.cols = Math.max(this.cols, targetCol + 1);
            this._setRaw(coordinateKey(targetRow, targetCol), row[colOffset]);
          }
        }
      } finally {
        if (ownsTransaction) this.resumeEvaluation();
      }
    }

    suspendEvaluation() {
      this.suspendDepth += 1;
      if (this.suspendDepth === 1 && !this.pendingTransaction) this.pendingTransaction = new Map();
    }

    resumeEvaluation() {
      if (this.suspendDepth <= 0) return;
      this.suspendDepth -= 1;
      if (this.suspendDepth > 0) return;
      this._invalidate(this.pendingChanged);
      this.pendingChanged.clear();
      this._commitTransaction();
    }

    _readCell(row, col, stack) {
      const key = coordinateKey(row, col);
      if (this.raw.has(key)) return this._evaluateCell(key, stack);
      const spill = this.spillValues.get(key);
      return spill ? spill.value : null;
    }

    _evaluateRange(node, stack) {
      const top = Math.min(node.start.row, node.end.row);
      const bottom = Math.max(node.start.row, node.end.row);
      const left = Math.min(node.start.col, node.end.col);
      const right = Math.max(node.start.col, node.end.col);
      return Array.from({ length: bottom - top + 1 }, (_, rowOffset) => (
        Array.from({ length: right - left + 1 }, (_, colOffset) => (
          this._readCell(top + rowOffset, left + colOffset, stack)
        ))
      ));
    }

    _evaluateCall(node, stack) {
      const name = node.name;
      const evaluate = argument => this._evaluateAst(argument, stack);

      if (['SE', 'IF'].includes(name)) {
        const condition = evaluate(node.args[0]);
        if (isError(condition)) return condition;
        return condition ? evaluate(node.args[1]) : (node.args.length > 2 ? evaluate(node.args[2]) : false);
      }
      if (['SES', 'IFS'].includes(name)) {
        for (let index = 0; index < node.args.length; index += 2) {
          const condition = evaluate(node.args[index]);
          if (isError(condition)) return condition;
          if (condition) return node.args[index + 1] ? evaluate(node.args[index + 1]) : true;
        }
        return '#N/D';
      }
      if (['E', 'AND'].includes(name)) {
        for (const argument of node.args) {
          const value = evaluate(argument);
          if (isError(value)) return value;
          if (!value) return false;
        }
        return true;
      }
      if (['OU', 'OR'].includes(name)) {
        for (const argument of node.args) {
          const value = evaluate(argument);
          if (isError(value)) return value;
          if (value) return true;
        }
        return false;
      }
      if (['SEERRO', 'IFERROR'].includes(name)) {
        const value = evaluate(node.args[0]);
        return isError(value) ? evaluate(node.args[1]) : value;
      }

      return functions.execute(name, node.args.map(evaluate));
    }

    _evaluateAst(node, stack) {
      switch (node?.type) {
        case 'literal': return node.value;
        case 'reference': return this._readCell(node.row, node.col, stack);
        case 'range': return this._evaluateRange(node, stack);
        case 'unary': {
          const value = this._evaluateAst(node.value, stack);
          if (Array.isArray(value)) return normalizedMatrix(value).map(row => row.map(item => (
            node.operator === '-' ? applyScalarBinary('*', item, -1) : toNumber(item)
          )));
          const numeric = toNumber(value);
          return isError(numeric) ? numeric : (node.operator === '-' ? -numeric : numeric);
        }
        case 'percent': {
          const value = this._evaluateAst(node.value, stack);
          return Array.isArray(value)
            ? normalizedMatrix(value).map(row => row.map(item => applyScalarBinary('/', item, 100)))
            : applyScalarBinary('/', value, 100);
        }
        case 'binary': return broadcastBinary(
          node.operator,
          this._evaluateAst(node.left, stack),
          this._evaluateAst(node.right, stack),
        );
        case 'call': return this._evaluateCall(node, stack);
        default: return '#NOME?';
      }
    }

    _applySpill(ownerKey, rawMatrix) {
      const matrix = normalizedMatrix(rawMatrix);
      if (!matrix.length || !matrix[0]?.length) return { value: null, type: null };
      const origin = parseCoordinateKey(ownerKey);
      const targets = new Set();

      for (let row = 0; row < matrix.length; row += 1) {
        for (let col = 0; col < matrix[row].length; col += 1) {
          if (row === 0 && col === 0) continue;
          const key = coordinateKey(origin.row + row, origin.col + col);
          const existingSpill = this.spillValues.get(key);
          if (this.raw.has(key) || (existingSpill && existingSpill.owner !== ownerKey)) return { value: '#DESPEJAR!', type: null };
          targets.add(key);
        }
      }

      this._clearSpill(ownerKey);
      for (let row = 0; row < matrix.length; row += 1) {
        for (let col = 0; col < matrix[row].length; col += 1) {
          if (row === 0 && col === 0) continue;
          const key = coordinateKey(origin.row + row, origin.col + col);
          const unwrapped = unwrapTyped(matrix[row][col]);
          this.spillValues.set(key, { owner: ownerKey, value: unwrapped.value, type: unwrapped.type });
          this.lastAffected.add(key);
        }
      }
      if (targets.size) this.spillTargets.set(ownerKey, targets);

      const downstream = this.graph.collectAffected(targets);
      for (const key of downstream) {
        if (key === ownerKey || targets.has(key)) continue;
        this.cache.delete(key);
        this.lastAffected.add(key);
      }

      return unwrapTyped(matrix[0][0]);
    }

    _evaluateCell(key, stack = new Set()) {
      if (this.cache.has(key)) {
        this.cacheHits += 1;
        return this.cache.get(key).value;
      }
      if (!this.raw.has(key)) return this.spillValues.get(key)?.value ?? null;
      const rawValue = this.raw.get(key);
      if (!isFormula(rawValue)) return rawValue;
      if (stack.has(key)) return '#CIRC!';
      if (this.parseErrors.has(key)) return this.parseErrors.get(key);

      this.cacheMisses += 1;
      const started = performance.now();
      stack.add(key);
      let evaluated;
      try {
        evaluated = this._evaluateAst(this.parsed.get(key), stack);
      } catch (error) {
        console.warn('Erro ao avaliar fórmula.', error);
        evaluated = '#ERRO!';
      } finally {
        stack.delete(key);
      }

      let result;
      if (Array.isArray(evaluated)) result = this._applySpill(key, evaluated);
      else result = unwrapTyped(evaluated);

      const elapsed = performance.now() - started;
      this.lastCalculationMs = elapsed;
      this.totalCalculationMs += elapsed;
      this.calculationCount += 1;
      this.cache.set(key, { value: result.value, type: result.type });
      return result.value;
    }

    getCellValue(coordinate) {
      const row = Number(coordinate?.row) || 0;
      const col = Number(coordinate?.col) || 0;
      return this._readCell(row, col, new Set());
    }

    getCellValueDetailedType(coordinate) {
      const key = coordinateKey(Number(coordinate?.row) || 0, Number(coordinate?.col) || 0);
      this.getCellValue(coordinate);
      if (this.cache.has(key)) return this.cache.get(key).type || this._inferType(this.cache.get(key).value);
      if (this.spillValues.has(key)) return this.spillValues.get(key).type || this._inferType(this.spillValues.get(key).value);
      return this._inferType(this.raw.get(key));
    }

    _inferType(value) {
      if (typeof value === 'number') return 'NUMBER';
      if (typeof value === 'boolean') return 'BOOLEAN';
      if (typeof value === 'string') return 'STRING';
      return 'EMPTY';
    }

    consumeAffectedCells() {
      const result = [...this.lastAffected].map(parseCoordinateKey);
      this.lastAffected.clear();
      return result;
    }

    getSheetSerialized() {
      let lastRow = -1;
      let lastCol = -1;
      for (const key of this.raw.keys()) {
        const { row, col } = parseCoordinateKey(key);
        lastRow = Math.max(lastRow, row);
        lastCol = Math.max(lastCol, col);
      }
      if (lastRow < 0 || lastCol < 0) return [];
      const result = Array.from({ length: lastRow + 1 }, () => Array(lastCol + 1).fill(null));
      for (const [key, value] of this.raw) {
        const { row, col } = parseCoordinateKey(key);
        result[row][col] = value;
      }
      return result;
    }

    _applyHistory(changes, direction) {
      this.replayingHistory = true;
      this.suspendEvaluation();
      try {
        for (const change of changes) this._setRaw(change.key, direction === 'undo' ? change.before : change.after);
      } finally {
        this.resumeEvaluation();
        this.replayingHistory = false;
        this.pendingTransaction = null;
      }
    }

    isThereSomethingToUndo() {
      return this.undoStack.length > 0;
    }

    isThereSomethingToRedo() {
      return this.redoStack.length > 0;
    }

    undo() {
      const changes = this.undoStack.pop();
      if (!changes) return;
      this._applyHistory(changes, 'undo');
      this.redoStack.push(changes);
    }

    redo() {
      const changes = this.redoStack.pop();
      if (!changes) return;
      this._applyHistory(changes, 'redo');
      this.undoStack.push(changes);
    }

    getStats() {
      const graph = this.graph.stats();
      const totalCacheRequests = this.cacheHits + this.cacheMisses;
      return {
        dependency_nodes: graph.nodes,
        dependency_edges: graph.edges,
        exact_dependency_edges: graph.exact_edges,
        range_dependency_edges: graph.range_edges,
        range_buckets: graph.range_buckets,
        cache_entries: this.cache.size,
        cache_bytes: this.cache.size * 72 + this.spillValues.size * 56,
        cache_hit_ratio: totalCacheRequests ? this.cacheHits / totalCacheRequests : 0,
        calculation_ms: this.lastCalculationMs,
        calculation_average_ms: this.calculationCount ? this.totalCalculationMs / this.calculationCount : 0,
        formula_cells: this.formulas.size,
        stored_cells: this.raw.size,
        spill_cells: this.spillValues.size,
      };
    }

    destroy() {
      this.raw.clear();
      this.formulas.clear();
      this.parsed.clear();
      this.parseErrors.clear();
      this.cache.clear();
      this.graph.clear();
      this.spillValues.clear();
      this.spillTargets.clear();
      this.lastAffected.clear();
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }
  }

  window.SuperExcelFormulaEngine = {
    engineName: 'SuperExcel Incremental Runtime',
    engineVersion: '0.1.0',
    create(data) {
      return new FormulaRuntime(normalizeDataForEngine(data));
    },
    normalizeFormula,
    normalizeDataForEngine,
  };
})();
