(() => {
  'use strict';

  function key(row, col) {
    return `${Number(row)}:${Number(col)}`;
  }

  function parseKey(value) {
    const [row, col] = String(value).split(':').map(Number);
    return { row, col };
  }

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function isFilled(value) {
    return value !== null && value !== undefined && value !== '';
  }

  class SparseWorkbookStore {
    constructor(payload = {}, options = {}) {
      this.defaultRows = positiveInteger(options.defaultRows, 60);
      this.defaultCols = positiveInteger(options.defaultCols, 26);
      this.maxRows = positiveInteger(options.maxRows, 1_000_000);
      this.maxCols = positiveInteger(options.maxCols, 10_000);
      this.values = new Map();
      this.rows = this.defaultRows;
      this.cols = this.defaultCols;
      this.name = 'Minha Planilha';
      this.load(payload);
    }

    load(payload = {}) {
      this.values.clear();
      const source = payload && typeof payload === 'object' ? payload : {};
      this.name = String(source.name || 'Minha Planilha');
      this.rows = Math.min(this.maxRows, positiveInteger(source.rows, this.defaultRows));
      this.cols = Math.min(this.maxCols, positiveInteger(source.cols, this.defaultCols));
      const cells = Array.isArray(source.cells) ? source.cells : [];
      const sparse = source.storage === 'sparse' || (cells.length > 0 && !Array.isArray(cells[0]));

      if (sparse) {
        for (const item of cells) {
          const row = Number(item?.r);
          const col = Number(item?.c);
          if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
          if (row >= this.maxRows || col >= this.maxCols || !isFilled(item?.v)) continue;
          this.values.set(key(row, col), item.v);
          this.rows = Math.max(this.rows, row + 1);
          this.cols = Math.max(this.cols, col + 1);
        }
        return this;
      }

      cells.forEach((rowValues, row) => {
        if (!Array.isArray(rowValues) || row >= this.maxRows) return;
        rowValues.forEach((value, col) => {
          if (col >= this.maxCols || !isFilled(value)) return;
          this.values.set(key(row, col), value);
          this.rows = Math.max(this.rows, row + 1);
          this.cols = Math.max(this.cols, col + 1);
        });
      });
      return this;
    }

    get(row, col) {
      return this.values.get(key(row, col)) ?? null;
    }

    has(row, col) {
      return this.values.has(key(row, col));
    }

    set(row, col, value) {
      const numericRow = Number(row);
      const numericCol = Number(col);
      if (!Number.isInteger(numericRow) || !Number.isInteger(numericCol)
        || numericRow < 0 || numericCol < 0
        || numericRow >= this.maxRows || numericCol >= this.maxCols) {
        throw new RangeError('Célula fora dos limites da planilha.');
      }
      const previous = this.get(numericRow, numericCol);
      if (isFilled(value)) this.values.set(key(numericRow, numericCol), value);
      else this.values.delete(key(numericRow, numericCol));
      this.rows = Math.max(this.rows, numericRow + 1);
      this.cols = Math.max(this.cols, numericCol + 1);
      return previous;
    }

    apply(changes = []) {
      const result = [];
      for (const change of Array.isArray(changes) ? changes : []) {
        const row = Number(change?.row);
        const col = Number(change?.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
        const value = change?.value ?? null;
        const before = this.set(row, col, value);
        result.push({ row, col, before, value });
      }
      return result;
    }

    clear() {
      this.values.clear();
      this.rows = this.defaultRows;
      this.cols = this.defaultCols;
      this.name = 'Minha Planilha';
    }

    *entries() {
      const ordered = [...this.values.entries()].sort((left, right) => {
        const a = parseKey(left[0]);
        const b = parseKey(right[0]);
        return a.row - b.row || a.col - b.col;
      });
      for (const [coordinate, value] of ordered) {
        const { row, col } = parseKey(coordinate);
        yield { row, col, value };
      }
    }

    rowSegments() {
      const rows = new Map();
      for (const item of this.entries()) {
        if (!rows.has(item.row)) rows.set(item.row, []);
        rows.get(item.row).push(item);
      }
      const segments = [];
      for (const [row, items] of rows) {
        let start = null;
        let values = [];
        let previousCol = -2;
        for (const item of items) {
          if (start === null || item.col !== previousCol + 1) {
            if (start !== null) segments.push({ row, col: start, values: [values] });
            start = item.col;
            values = [];
          }
          values.push(item.value);
          previousCol = item.col;
        }
        if (start !== null) segments.push({ row, col: start, values: [values] });
      }
      return segments;
    }

    toPayload(name = this.name) {
      return {
        version: 2,
        storage: 'sparse',
        name: String(name || 'Minha Planilha'),
        rows: this.rows,
        cols: this.cols,
        cells: [...this.entries()].map(({ row, col, value }) => ({ r: row, c: col, v: value })),
      };
    }

    clonePayload(name = this.name) {
      return JSON.parse(JSON.stringify(this.toPayload(name)));
    }

    stats() {
      let formulaCells = 0;
      let valueBytes = 0;
      for (const { value } of this.entries()) {
        if (typeof value === 'string' && value.trimStart().startsWith('=')) formulaCells += 1;
        try { valueBytes += new Blob([JSON.stringify(value)]).size; }
        catch { valueBytes += String(value).length * 2; }
      }
      return {
        rows: this.rows,
        cols: this.cols,
        stored_cells: this.values.size,
        formula_cells: formulaCells,
        estimated_store_bytes: this.values.size * 72 + valueBytes,
      };
    }
  }

  window.SuperExcelSparseStore = Object.freeze({
    SparseWorkbookStore,
    coordinateKey: key,
    parseCoordinateKey: parseKey,
    isFilled,
  });
})();
