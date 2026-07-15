(() => {
  'use strict';

  if (!window.HyperFormula?.HyperFormula) {
    throw new Error('HyperFormula não foi carregado. Verifique sua conexão com a internet.');
  }

  const {
    HyperFormula: HF,
    FunctionPlugin,
    FunctionArgumentType,
    SimpleRangeValue,
    ArraySize,
    CellError,
    ErrorType,
  } = window.HyperFormula;

  function cloneLanguage(language) {
    return {
      errors: { ...language.errors },
      functions: { ...language.functions },
      langCode: 'ptBR',
      ui: { ...language.ui, NEW_SHEET_PREFIX: 'Planilha' },
    };
  }

  const ptBR = cloneLanguage(window.HyperFormula.languages.ptPT);
  Object.assign(ptBR.functions, {
    IFS: 'SES',
    FILTER: 'HF.FILTRO',
    TEXTJOIN: 'TEXTO.JUNTAR',
    TEXT: 'HF.TEXTO',
  });

  if (!HF.getRegisteredLanguagesCodes().includes('ptBR')) {
    HF.registerLanguage('ptBR', ptBR);
  }

  const isBlank = (value) => value === null || value === undefined || value === '';

  function normalizeFormula(formula) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
    return formula
      .split('"')
      .map((part, index) => {
        if (index % 2 === 1) return part;
        return part
          .replace(/\bVERDADEIRO\b(?!\s*\()/giu, 'VERDADEIRO()')
          .replace(/\bFALSO\b(?!\s*\()/giu, 'FALSO()');
      })
      .join('"');
  }

  function normalizeDataForEngine(data) {
    return data.map((row) => row.map(normalizeFormula));
  }

  function normalizeComparable(value) {
    if (typeof value === 'string') return value.toLocaleLowerCase('pt-BR');
    return value;
  }

  function compareValues(a, b) {
    if (isBlank(a) && isBlank(b)) return 0;
    if (isBlank(a)) return 1;
    if (isBlank(b)) return -1;
    const left = normalizeComparable(a);
    const right = normalizeComparable(b);
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right), 'pt-BR', { numeric: true, sensitivity: 'base' });
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
    if (typeof criterion !== 'string') return value === criterion;
    const match = criterion.match(/^(<=|>=|<>|=|<|>)(.*)$/u);
    const operator = match ? match[1] : '=';
    const expected = match ? match[2] : criterion;
    const numericExpected = Number(String(expected).replaceAll('.', '').replace(',', '.'));
    const numericValue = typeof value === 'number' ? value : Number(String(value).replaceAll('.', '').replace(',', '.'));
    const bothNumeric = Number.isFinite(numericExpected) && Number.isFinite(numericValue);

    if (operator === '=' && /[*?]/u.test(expected)) {
      return wildcardToRegex(expected).test(String(value ?? ''));
    }

    const left = bothNumeric ? numericValue : normalizeComparable(value ?? '');
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

  function rangeDimensionsFromAst(ast) {
    const argument = ast?.args?.[0];
    if (!argument?.start || !argument?.end) return ArraySize.scalar();
    return new ArraySize(
      argument.end.col - argument.start.col + 1,
      argument.end.row - argument.start.row + 1,
    );
  }

  class BrazilianExcelPlugin extends FunctionPlugin {
    averageIfs(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_AVERAGEIFS'),
        (averageRange, firstCriteriaRange, firstCriterion, ...rest) => {
          const ranges = [firstCriteriaRange];
          const criteria = [firstCriterion];
          for (let index = 0; index < rest.length; index += 2) {
            ranges.push(rest[index]);
            criteria.push(rest[index + 1]);
          }
          const averageData = averageRange.data.flat();
          const criteriaData = ranges.map((range) => range.data.flat());
          if (criteriaData.some((values) => values.length !== averageData.length)) {
            return new CellError(ErrorType.VALUE, 'Os intervalos de MÉDIASES precisam ter o mesmo tamanho.');
          }
          const accepted = averageData.filter((value, index) => {
            if (typeof value !== 'number') return false;
            return criteriaData.every((values, criterionIndex) => matchesCriterion(values[index], criteria[criterionIndex]));
          });
          if (accepted.length === 0) {
            return new CellError(ErrorType.DIV_BY_ZERO, 'Nenhum valor atende aos critérios.');
          }
          return accepted.reduce((total, value) => total + value, 0) / accepted.length;
        },
      );
    }

    concat(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_CONCAT'),
        (...values) => values
          .flatMap((value) => value instanceof SimpleRangeValue ? value.data.flat() : [value])
          .filter((value) => !isBlank(value))
          .map(String)
          .join(''),
      );
    }

    filter(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_FILTER'),
        (sourceRange, includeRange, ifEmpty) => {
          const source = sourceRange.data.map((row) => [...row]);
          const include = includeRange.data;
          const height = source.length;
          const width = source[0]?.length ?? 0;
          let result;

          if (include.length === height && include.every((row) => row.length === 1)) {
            result = source.filter((_, rowIndex) => Boolean(include[rowIndex][0]));
            while (result.length < height) result.push(Array(width).fill(null));
          } else if (include.length === 1 && include[0].length === width) {
            const selectedColumns = include[0]
              .map((value, index) => Boolean(value) ? index : -1)
              .filter((index) => index >= 0);
            result = source.map((row) => selectedColumns.map((columnIndex) => row[columnIndex]));
            result = result.map((row) => [...row, ...Array(width).fill(null)].slice(0, width));
          } else if (include.length === height && include.every((row) => row.length === width)) {
            result = source.filter((_, rowIndex) => include[rowIndex].every(Boolean));
            while (result.length < height) result.push(Array(width).fill(null));
          } else {
            return new CellError(ErrorType.VALUE, 'O intervalo de inclusão do FILTRO é incompatível com os dados.');
          }

          const hasResult = result.some((row) => row.some((value) => !isBlank(value)));
          if (!hasResult && !isBlank(ifEmpty)) result[0][0] = ifEmpty;
          return SimpleRangeValue.onlyValues(result);
        },
      );
    }

    filterSize(ast) {
      return rangeDimensionsFromAst(ast);
    }

    text(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_TEXT'),
        (value, format) => {
          if (typeof value !== 'number') return String(value ?? '');
          const normalizedFormat = String(format ?? '');
          const decimalPart = normalizedFormat.split(',')[1] ?? '';
          const fractionDigits = (decimalPart.match(/[0#]/g) ?? []).length;
          const options = { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
          if (/R\$/iu.test(normalizedFormat)) {
            return new Intl.NumberFormat('pt-BR', {
              ...options,
              style: 'currency',
              currency: 'BRL',
              currencyDisplay: 'symbol',
            }).format(value).replace(/\u00a0/gu, ' ');
          }
          if (/[0#]/u.test(normalizedFormat)) {
            return new Intl.NumberFormat('pt-BR', {
              ...options,
              useGrouping: normalizedFormat.includes('.'),
            }).format(value);
          }
          return String(value);
        },
      );
    }

    unique(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_UNIQUE'),
        (range) => {
          const source = range.data.flat();
          const seen = new Set();
          const uniqueValues = [];
          for (const value of source) {
            const key = `${typeof value}:${JSON.stringify(value)}`;
            if (!seen.has(key)) {
              seen.add(key);
              uniqueValues.push(value);
            }
          }
          while (uniqueValues.length < source.length) uniqueValues.push(null);
          return SimpleRangeValue.onlyValues(uniqueValues.map((value) => [value]));
        },
      );
    }

    uniqueSize(ast) {
      const argument = ast?.args?.[0];
      if (!argument?.start || !argument?.end) return ArraySize.scalar();
      const width = argument.end.col - argument.start.col + 1;
      const height = argument.end.row - argument.start.row + 1;
      return new ArraySize(1, width * height);
    }

    sort(ast, state) {
      return this.runFunction(
        ast.args,
        state,
        this.metadata('BR_SORT'),
        (range, sortIndex, sortOrder, byColumn) => {
          const data = range.data.map((row) => [...row]);
          const direction = sortOrder === -1 ? -1 : 1;
          const index = Math.max(0, sortIndex - 1);
          if (byColumn) {
            const columns = data[0].map((_, columnIndex) => data.map((row) => row[columnIndex]));
            columns.sort((a, b) => compareValues(a[index], b[index]) * direction);
            return SimpleRangeValue.onlyValues(data.map((_, rowIndex) => columns.map((column) => column[rowIndex])));
          }
          data.sort((a, b) => compareValues(a[index], b[index]) * direction);
          return SimpleRangeValue.onlyValues(data);
        },
      );
    }

    sortSize(ast) {
      return rangeDimensionsFromAst(ast);
    }
  }

  BrazilianExcelPlugin.implementedFunctions = {
    BR_AVERAGEIFS: {
      method: 'averageIfs',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.SCALAR },
      ],
      repeatLastArgs: 2,
    },
    BR_CONCAT: {
      method: 'concat',
      parameters: [{ argumentType: FunctionArgumentType.ANY }],
      repeatLastArgs: 1,
    },
    BR_FILTER: {
      method: 'filter',
      sizeOfResultArrayMethod: 'filterSize',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.ANY, defaultValue: '' },
      ],
    },
    BR_TEXT: {
      method: 'text',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.STRING },
      ],
    },
    BR_UNIQUE: {
      method: 'unique',
      sizeOfResultArrayMethod: 'uniqueSize',
      parameters: [{ argumentType: FunctionArgumentType.RANGE }],
    },
    BR_SORT: {
      method: 'sort',
      sizeOfResultArrayMethod: 'sortSize',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.INTEGER, defaultValue: 1 },
        { argumentType: FunctionArgumentType.INTEGER, defaultValue: 1 },
        { argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false },
      ],
    },
  };

  const translations = {
    ptBR: {
      BR_AVERAGEIFS: 'MÉDIASES',
      BR_CONCAT: 'CONCAT',
      BR_FILTER: 'FILTRO',
      BR_UNIQUE: 'ÚNICO',
      BR_SORT: 'CLASSIFICAR',
      BR_TEXT: 'TEXTO',
    },
  };

  HF.registerFunctionPlugin(BrazilianExcelPlugin, translations);

  window.SuperExcelFormulaEngine = {
    create(data) {
      return HF.buildFromArray(normalizeDataForEngine(data), {
        language: 'ptBR',
        licenseKey: 'gpl-v3',
        functionArgSeparator: ';',
        decimalSeparator: ',',
        thousandSeparator: '.',
        dateFormats: ['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD'],
        timeFormats: ['HH:mm', 'HH:mm:ss'],
        smartRounding: true,
        useArrayArithmetic: true,
      });
    },
    normalizeFormula,
    normalizeDataForEngine,
    HF,
  };
})();
