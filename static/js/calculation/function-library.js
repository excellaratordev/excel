(() => {
  'use strict';

  const ERROR_PREFIX = '#';

  function isError(value) {
    return typeof value === 'string' && value.startsWith(ERROR_PREFIX);
  }

  function typed(value, type) {
    return { __superexcelTyped: true, value, type };
  }

  function unwrap(value) {
    return value && value.__superexcelTyped ? value.value : value;
  }

  function toMatrix(value) {
    if (!Array.isArray(value)) return [[value]];
    if (!value.length) return [];
    return Array.isArray(value[0]) ? value : value.map(item => [item]);
  }

  function flatten(value) {
    if (!Array.isArray(value)) return [unwrap(value)];
    return value.flat(Infinity).map(unwrap);
  }

  function isBlank(value) {
    const unwrapped = unwrap(value);
    return unwrapped === null || unwrapped === undefined || unwrapped === '';
  }

  function firstError(values) {
    return flatten(values).find(isError) || null;
  }

  function numericValues(values) {
    return flatten(values).filter(value => typeof value === 'number' && Number.isFinite(value));
  }

  function normalizeComparable(value) {
    const unwrapped = unwrap(value);
    return typeof unwrapped === 'string' ? unwrapped.toLocaleLowerCase('pt-BR') : unwrapped;
  }

  function compareValues(left, right) {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    if (isBlank(a) && isBlank(b)) return 0;
    if (isBlank(a)) return 1;
    if (isBlank(b)) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'pt-BR', { numeric: true, sensitivity: 'base' });
  }

  function wildcardToRegex(pattern) {
    const escaped = String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/~\*/g, '\u0000')
      .replace(/~\?/g, '\u0001')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\u0000/g, '\\*')
      .replace(/\u0001/g, '\\?');
    return new RegExp(`^${escaped}$`, 'iu');
  }

  function matchesCriterion(value, criterion) {
    const actual = unwrap(value);
    const expectedCriterion = unwrap(criterion);
    if (typeof expectedCriterion !== 'string') return actual === expectedCriterion;

    const match = expectedCriterion.match(/^(<=|>=|<>|=|<|>)(.*)$/u);
    const operator = match ? match[1] : '=';
    const expected = match ? match[2] : expectedCriterion;
    const numericExpected = Number(String(expected).replaceAll('.', '').replace(',', '.'));
    const numericActual = typeof actual === 'number' ? actual : Number(String(actual).replaceAll('.', '').replace(',', '.'));
    const bothNumeric = Number.isFinite(numericExpected) && Number.isFinite(numericActual);

    if (operator === '=' && /[*?]/u.test(expected)) return wildcardToRegex(expected).test(String(actual ?? ''));

    const left = bothNumeric ? numericActual : normalizeComparable(actual ?? '');
    const right = bothNumeric ? numericExpected : normalizeComparable(expected);
    switch (operator) {
      case '<>': return left !== right;
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      default: return left === right;
    }
  }

  function sum(values) {
    const error = firstError(values);
    if (error) return error;
    return numericValues(values).reduce((total, value) => total + value, 0);
  }

  function average(values) {
    const error = firstError(values);
    if (error) return error;
    const numbers = numericValues(values);
    return numbers.length ? sum(numbers) / numbers.length : '#DIV/0!';
  }

  function conditionalAggregate(args, mode) {
    const [valueRange, ...pairs] = args;
    const values = flatten(valueRange);
    if (pairs.length % 2 !== 0) return '#VALOR!';
    const criteriaRanges = [];
    const criteria = [];
    for (let index = 0; index < pairs.length; index += 2) {
      const range = flatten(pairs[index]);
      if (range.length !== values.length) return '#VALOR!';
      criteriaRanges.push(range);
      criteria.push(pairs[index + 1]);
    }
    const accepted = values.filter((value, index) => (
      criteriaRanges.every((range, criterionIndex) => matchesCriterion(range[index], criteria[criterionIndex]))
    ));
    if (mode === 'sum') return sum(accepted);
    if (mode === 'average') return average(accepted);
    return accepted.length;
  }

  function countIfs(args) {
    if (!args.length || args.length % 2 !== 0) return '#VALOR!';
    const ranges = [];
    const criteria = [];
    let length = null;
    for (let index = 0; index < args.length; index += 2) {
      const range = flatten(args[index]);
      if (length === null) length = range.length;
      if (range.length !== length) return '#VALOR!';
      ranges.push(range);
      criteria.push(args[index + 1]);
    }
    let count = 0;
    for (let row = 0; row < length; row += 1) {
      if (ranges.every((range, index) => matchesCriterion(range[row], criteria[index]))) count += 1;
    }
    return count;
  }

  function sumIf(args) {
    const [criteriaRange, criterion, sumRange = criteriaRange] = args;
    return conditionalAggregate([sumRange, criteriaRange, criterion], 'sum');
  }

  function averageIf(args) {
    const [criteriaRange, criterion, averageRange = criteriaRange] = args;
    return conditionalAggregate([averageRange, criteriaRange, criterion], 'average');
  }

  function vlookup(args) {
    const [lookupValue, rawTable, rawColumnIndex, approximate = true] = args;
    const table = toMatrix(rawTable);
    const columnIndex = Math.trunc(Number(rawColumnIndex)) - 1;
    if (columnIndex < 0 || table.some(row => columnIndex >= row.length)) return '#REF!';
    if (!approximate) {
      const row = table.find(item => compareValues(item[0], lookupValue) === 0);
      return row ? row[columnIndex] : '#N/D';
    }
    let candidate = null;
    for (const row of table) {
      if (compareValues(row[0], lookupValue) <= 0) candidate = row;
      else break;
    }
    return candidate ? candidate[columnIndex] : '#N/D';
  }

  function xlookup(args) {
    const [lookupValue, lookupRange, returnRange, ifNotFound = '#N/D'] = args;
    const lookup = flatten(lookupRange);
    const returns = flatten(returnRange);
    const index = lookup.findIndex(value => compareValues(value, lookupValue) === 0);
    return index >= 0 && index < returns.length ? returns[index] : ifNotFound;
  }

  function indexFunction(args) {
    const [range, rawRow = 1, rawColumn = 1] = args;
    const matrix = toMatrix(range);
    const row = Math.trunc(Number(rawRow)) - 1;
    const column = Math.trunc(Number(rawColumn)) - 1;
    if (row < 0 || column < 0 || row >= matrix.length || column >= (matrix[row]?.length || 0)) return '#REF!';
    return matrix[row][column];
  }

  function matchFunction(args) {
    const [lookupValue, range, rawMatchType = 1] = args;
    const values = flatten(range);
    const matchType = Math.trunc(Number(rawMatchType));
    if (matchType === 0) {
      const index = values.findIndex(value => compareValues(value, lookupValue) === 0);
      return index >= 0 ? index + 1 : '#N/D';
    }
    let candidate = -1;
    if (matchType > 0) {
      for (let index = 0; index < values.length; index += 1) {
        if (compareValues(values[index], lookupValue) <= 0) candidate = index;
        else break;
      }
    } else {
      for (let index = 0; index < values.length; index += 1) {
        if (compareValues(values[index], lookupValue) >= 0) candidate = index;
        else break;
      }
    }
    return candidate >= 0 ? candidate + 1 : '#N/D';
  }

  function filterFunction(args) {
    const [sourceValue, includeValue, ifEmpty = '#CALC!'] = args;
    const source = toMatrix(sourceValue);
    const include = toMatrix(includeValue);
    const height = source.length;
    const width = source[0]?.length || 0;
    let result = [];

    if (include.length === height && include.every(row => row.length === 1)) {
      result = source.filter((_, rowIndex) => Boolean(unwrap(include[rowIndex][0])));
    } else if (include.length === 1 && include[0].length === width) {
      const columns = include[0]
        .map((value, index) => Boolean(unwrap(value)) ? index : -1)
        .filter(index => index >= 0);
      result = source.map(row => columns.map(index => row[index]));
    } else if (include.length === height && include.every(row => row.length === width)) {
      result = source.filter((_, rowIndex) => include[rowIndex].every(value => Boolean(unwrap(value))));
    } else {
      return '#VALOR!';
    }

    return result.length && result.some(row => row.length) ? result : [[ifEmpty]];
  }

  function uniqueFunction(args) {
    const [range] = args;
    const matrix = toMatrix(range);
    const seen = new Set();
    const result = [];
    for (const row of matrix) {
      const key = JSON.stringify(row.map(unwrap));
      if (seen.has(key)) continue;
      seen.add(key);
      result.push([...row]);
    }
    return result;
  }

  function sortFunction(args) {
    const [range, rawSortIndex = 1, rawSortOrder = 1, byColumn = false] = args;
    const matrix = toMatrix(range).map(row => [...row]);
    const sortIndex = Math.max(0, Math.trunc(Number(rawSortIndex)) - 1);
    const direction = Number(rawSortOrder) === -1 ? -1 : 1;
    if (byColumn) {
      if (!matrix.length) return matrix;
      const columns = matrix[0].map((_, column) => matrix.map(row => row[column]));
      columns.sort((left, right) => compareValues(left[sortIndex], right[sortIndex]) * direction);
      return matrix.map((_, row) => columns.map(column => column[row]));
    }
    matrix.sort((left, right) => compareValues(left[sortIndex], right[sortIndex]) * direction);
    return matrix;
  }

  function textFunction(args) {
    const [rawValue, rawFormat] = args;
    const value = unwrap(rawValue);
    const format = String(unwrap(rawFormat) ?? '');
    if (typeof value !== 'number') return String(value ?? '');
    const decimalPart = format.split(',')[1] || '';
    const fractionDigits = (decimalPart.match(/[0#]/g) || []).length;
    const options = { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
    if (/R\$/iu.test(format)) {
      return new Intl.NumberFormat('pt-BR', {
        ...options,
        style: 'currency',
        currency: 'BRL',
        currencyDisplay: 'symbol',
      }).format(value).replace(/\u00a0/gu, ' ');
    }
    if (/[0#]/u.test(format)) {
      return new Intl.NumberFormat('pt-BR', { ...options, useGrouping: format.includes('.') }).format(value);
    }
    return String(value);
  }

  function execute(name, args) {
    const normalized = String(name || '').toUpperCase();
    switch (normalized) {
      case 'SOMA': case 'SUM': return sum(args);
      case 'MEDIA': case 'AVERAGE': return average(args);
      case 'MAXIMO': case 'MAX': {
        const error = firstError(args); if (error) return error;
        const values = numericValues(args); return values.length ? Math.max(...values) : 0;
      }
      case 'MINIMO': case 'MIN': {
        const error = firstError(args); if (error) return error;
        const values = numericValues(args); return values.length ? Math.min(...values) : 0;
      }
      case 'CONT.NUM': case 'COUNT': return numericValues(args).length;
      case 'CONT.VALORES': case 'COUNTA': return flatten(args).filter(value => !isBlank(value)).length;
      case 'CONT.SE': case 'COUNTIF': return countIfs(args);
      case 'CONT.SES': case 'COUNTIFS': return countIfs(args);
      case 'SOMASE': case 'SUMIF': return sumIf(args);
      case 'SOMASES': case 'SUMIFS': return conditionalAggregate(args, 'sum');
      case 'MEDIASE': case 'AVERAGEIF': return averageIf(args);
      case 'MEDIASES': case 'AVERAGEIFS': return conditionalAggregate(args, 'average');
      case 'PROCV': case 'VLOOKUP': return vlookup(args);
      case 'PROCX': case 'XLOOKUP': return xlookup(args);
      case 'INDICE': case 'INDEX': return indexFunction(args);
      case 'CORRESP': case 'MATCH': return matchFunction(args);
      case 'FILTRO': case 'FILTER': return filterFunction(args);
      case 'UNICO': case 'UNIQUE': return uniqueFunction(args);
      case 'CLASSIFICAR': case 'SORT': return sortFunction(args);
      case 'CONCAT': return flatten(args).map(value => isBlank(value) ? '' : String(value)).join('');
      case 'TEXTO.JUNTAR': case 'TEXTJOIN': {
        const [delimiter = '', ignoreEmpty = true, ...values] = args;
        return flatten(values)
          .filter(value => !ignoreEmpty || !isBlank(value))
          .map(value => String(value ?? ''))
          .join(String(delimiter ?? ''));
      }
      case 'ESQUERDA': case 'LEFT': {
        const [value = '', count = 1] = args;
        return String(value ?? '').slice(0, Math.max(0, Math.trunc(Number(count))));
      }
      case 'DIREITA': case 'RIGHT': {
        const [value = '', count = 1] = args;
        const length = Math.max(0, Math.trunc(Number(count)));
        return length ? String(value ?? '').slice(-length) : '';
      }
      case 'TEXTO': case 'TEXT': return textFunction(args);
      case 'HOJE': case 'TODAY': {
        const now = new Date();
        const utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const excelEpoch = Date.UTC(1899, 11, 30);
        return typed(Math.floor((utc - excelEpoch) / 86400000), 'DATE');
      }
      case 'VERDADEIRO': case 'TRUE': return true;
      case 'FALSO': case 'FALSE': return false;
      default: return '#NOME?';
    }
  }

  window.SuperExcelFunctionLibrary = Object.freeze({
    compareValues,
    execute,
    flatten,
    isBlank,
    isError,
    matchesCriterion,
    toMatrix,
    typed,
    unwrap,
  });
})();
