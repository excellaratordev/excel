(() => {
  'use strict';

  const ERROR_VALUE = '#VALOR!';
  const ERROR_NA = '#N/D';
  const COMPARISON_OPERATORS = new Set(['=', '<>', '<', '>', '<=', '>=']);

  function normalizeName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toUpperCase();
  }

  function unwrap(value) {
    return value && value.__superexcelTyped ? value.value : value;
  }

  function normalizeError(value) {
    const unwrapped = unwrap(value);
    if (typeof unwrapped !== 'string') return unwrapped;
    return unwrapped.toUpperCase().replace('#N/A', ERROR_NA);
  }

  function isError(value) {
    const unwrapped = unwrap(value);
    return typeof unwrapped === 'string' && unwrapped.startsWith('#');
  }

  function isNaError(value) {
    return normalizeError(value) === ERROR_NA;
  }

  function isBlank(value) {
    const unwrapped = unwrap(value);
    return unwrapped === null || unwrapped === undefined || unwrapped === '';
  }

  function toMatrix(value) {
    if (!Array.isArray(value)) return [[value]];
    if (!value.length) return [];
    return Array.isArray(value[0]) ? value : value.map(item => [item]);
  }

  function flatten(value) {
    if (!Array.isArray(value)) return [value];
    return value.flat(Infinity);
  }

  function defaultCompare(leftValue, rightValue) {
    const left = unwrap(leftValue);
    const right = unwrap(rightValue);
    if (isBlank(left) && isBlank(right)) return 0;
    if (isBlank(left)) return -1;
    if (isBlank(right)) return 1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
    return String(left).localeCompare(String(right), 'pt-BR', { numeric: true, sensitivity: 'base' });
  }

  function compareOperator(operator, leftValue, rightValue, compareValues = defaultCompare) {
    const left = unwrap(leftValue);
    const right = unwrap(rightValue);
    if (isError(left)) return normalizeError(left);
    if (isError(right)) return normalizeError(right);
    if (!COMPARISON_OPERATORS.has(operator)) return '#NOME?';
    const comparison = compareValues(left, right);
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

  function matrixShape(matrix) {
    return {
      rows: matrix.length,
      cols: matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    };
  }

  function valueAt(value, row, col, rows, cols) {
    if (!Array.isArray(value)) return value;
    const matrix = toMatrix(value);
    const shape = matrixShape(matrix);
    if (!shape.rows || !shape.cols) return null;
    if ((shape.rows !== 1 && shape.rows !== rows) || (shape.cols !== 1 && shape.cols !== cols)) return ERROR_VALUE;
    const sourceRow = shape.rows === 1 ? 0 : row;
    const sourceCol = shape.cols === 1 ? 0 : col;
    return matrix[sourceRow]?.[sourceCol] ?? null;
  }

  function broadcastComparison(operator, leftValue, rightValue, compareValues = defaultCompare) {
    if (!Array.isArray(leftValue) && !Array.isArray(rightValue)) {
      return compareOperator(operator, leftValue, rightValue, compareValues);
    }
    const leftShape = matrixShape(toMatrix(leftValue));
    const rightShape = matrixShape(toMatrix(rightValue));
    const rows = Math.max(leftShape.rows || 1, rightShape.rows || 1);
    const cols = Math.max(leftShape.cols || 1, rightShape.cols || 1);
    return Array.from({ length: rows }, (_, row) => (
      Array.from({ length: cols }, (_, col) => compareOperator(
        operator,
        valueAt(leftValue, row, col, rows, cols),
        valueAt(rightValue, row, col, rows, cols),
        compareValues,
      ))
    ));
  }

  function scalarLogical(value, { blankAsFalse = true, textMode = 'error' } = {}) {
    const unwrapped = unwrap(value);
    if (isError(unwrapped)) return { error: normalizeError(unwrapped) };
    if (typeof unwrapped === 'boolean') return { accepted: true, value: unwrapped };
    if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return { accepted: true, value: unwrapped !== 0 };
    if (isBlank(unwrapped)) return blankAsFalse ? { accepted: true, value: false } : { accepted: false };
    if (typeof unwrapped === 'string') {
      const normalized = normalizeName(unwrapped.trim());
      if (['VERDADEIRO', 'TRUE'].includes(normalized)) return { accepted: true, value: true };
      if (['FALSO', 'FALSE'].includes(normalized)) return { accepted: true, value: false };
      if (textMode === 'ignore') return { accepted: false };
    }
    return { error: ERROR_VALUE };
  }

  function logicalEntries(node, value) {
    const fromRange = node?.type === 'range';
    const result = [];
    for (const item of Array.isArray(value) ? flatten(value) : [value]) {
      const converted = scalarLogical(item, {
        blankAsFalse: !fromRange,
        textMode: fromRange ? 'ignore' : 'error',
      });
      if (converted.error) return { error: converted.error, values: [] };
      if (converted.accepted) result.push(converted.value);
    }
    return { values: result };
  }

  function scalarCondition(value) {
    if (Array.isArray(value)) return { error: ERROR_VALUE };
    return scalarLogical(value, { blankAsFalse: true, textMode: 'error' });
  }

  function validateCount(args, minimum, maximum = minimum) {
    const count = Array.isArray(args) ? args.length : 0;
    return count >= minimum && count <= maximum;
  }

  function mapCondition(value) {
    const matrix = toMatrix(value);
    return matrix.map(row => row.map(item => {
      const converted = scalarLogical(item, { blankAsFalse: true, textMode: 'error' });
      return converted.error || converted.value;
    }));
  }

  function selectByMask(maskValue, trueValue, falseValue) {
    const mask = toMatrix(maskValue);
    const { rows, cols } = matrixShape(mask);
    return mask.map((maskRow, row) => maskRow.map((condition, col) => {
      if (isError(condition)) return normalizeError(condition);
      return valueAt(condition ? trueValue : falseValue, row, col, rows, cols);
    }));
  }

  function replaceErrors(value, fallback, predicate) {
    if (!Array.isArray(value)) return predicate(value) ? fallback : value;
    const matrix = toMatrix(value);
    const { rows, cols } = matrixShape(matrix);
    return matrix.map((rowValues, row) => rowValues.map((item, col) => (
      predicate(item) ? valueAt(fallback, row, col, rows, cols) : item
    )));
  }

  function definition(name, aliases, description, syntax, example) {
    return Object.freeze({
      name,
      aliases: Object.freeze([...aliases]),
      category: 'Lógica',
      description,
      syntax,
      example,
    });
  }

  const catalog = Object.freeze([
    definition('SE', ['IF'], 'Retorna um valor quando a condição é verdadeira e outro quando é falsa, avaliando somente o ramo necessário.', 'SE(condição; valor_se_verdadeiro; [valor_se_falso])', '=SE(B2>=1000;"Meta atingida";"Abaixo da meta")'),
    definition('SES', ['IFS'], 'Testa condições em sequência e retorna o resultado associado à primeira condição verdadeira.', 'SES(condição1; resultado1; [condição2; resultado2]; ...)', '=SES(B2>=1000;"Alta";B2>=500;"Média";VERDADEIRO();"Baixa")'),
    definition('E', ['AND'], 'Retorna VERDADEIRO quando todas as condições são verdadeiras e interrompe no primeiro falso.', 'E(condição1; [condição2]; ...)', '=E(B2>0;C2="Pago")'),
    definition('OU', ['OR'], 'Retorna VERDADEIRO quando alguma condição é verdadeira e interrompe na primeira verdadeira.', 'OU(condição1; [condição2]; ...)', '=OU(C2="Pago";C2="Parcial")'),
    definition('NÃO', ['NAO', 'NOT'], 'Inverte um valor lógico.', 'NÃO(lógico)', '=NÃO(C2="Cancelado")'),
    definition('OUEXCL', ['XOR'], 'Retorna VERDADEIRO quando uma quantidade ímpar de condições é verdadeira.', 'OUEXCL(lógico1; [lógico2]; ...)', '=OUEXCL(B2>0;C2="Pago")'),
    definition('SEERRO', ['IFERROR'], 'Retorna um valor alternativo somente quando a expressão produz qualquer erro.', 'SEERRO(valor; valor_se_erro)', '=SEERRO(A2/B2;0)'),
    definition('SENÃODISP', ['SENAODISP', 'IFNA'], 'Retorna um valor alternativo somente quando a expressão produz #N/D.', 'SENÃODISP(valor; valor_se_não_disponível)', '=SENÃODISP(PROCX(A2;F2:F20;G2:G20);"Não encontrado")'),
    definition('PARÂMETRO', ['PARAMETRO', 'SWITCH'], 'Compara uma expressão com opções e avalia somente o resultado da primeira correspondência.', 'PARÂMETRO(expressão; valor1; resultado1; [valor2; resultado2]; ...; [padrão])', '=PARÂMETRO(B2;"P";"Pendente";"A";"Aprovado";"Outro")'),
    definition('ÉCÉL.VAZIA', ['ECEL.VAZIA', 'ISBLANK'], 'Verifica se o valor está vazio.', 'ÉCÉL.VAZIA(valor)', '=ÉCÉL.VAZIA(A2)'),
    definition('ÉLÓGICO', ['ELOGICO', 'ISLOGICAL'], 'Verifica se o valor é VERDADEIRO ou FALSO.', 'ÉLÓGICO(valor)', '=ÉLÓGICO(A2)'),
    definition('ÉNÚM', ['ENUM', 'ISNUMBER'], 'Verifica se o valor é numérico.', 'ÉNÚM(valor)', '=ÉNÚM(A2)'),
    definition('ÉTEXTO', ['ETEXTO', 'ISTEXT'], 'Verifica se o valor é texto.', 'ÉTEXTO(valor)', '=ÉTEXTO(A2)'),
    definition('ÉERRO', ['EERRO', 'ISERROR'], 'Verifica se o valor contém qualquer erro.', 'ÉERRO(valor)', '=ÉERRO(A2/B2)'),
    definition('ÉERROS', ['EERROS', 'ISERR'], 'Verifica se o valor contém um erro diferente de #N/D.', 'ÉERROS(valor)', '=ÉERROS(A2/B2)'),
    definition('ÉNÃO.DISP', ['ENAODISP', 'ISNA'], 'Verifica especificamente se o valor é #N/D.', 'ÉNÃO.DISP(valor)', '=ÉNÃO.DISP(PROCX(A2;F2:F20;G2:G20))'),
    definition('NÃO.DISP', ['NAODISP', 'NA'], 'Retorna o erro #N/D para indicar que um valor não está disponível.', 'NÃO.DISP()', '=NÃO.DISP()'),
    definition('VERDADEIRO', ['TRUE'], 'Retorna o valor lógico verdadeiro.', 'VERDADEIRO()', '=VERDADEIRO()'),
    definition('FALSO', ['FALSE'], 'Retorna o valor lógico falso.', 'FALSO()', '=FALSO()'),
  ]);

  const handlers = new Map();
  function register(names, handler) {
    for (const name of names) handlers.set(normalizeName(name), handler);
  }

  register(['SE', 'IF'], (args, context) => {
    if (!validateCount(args, 2, 3)) return ERROR_VALUE;
    const condition = context.evaluate(args[0]);
    if (isError(condition)) return normalizeError(condition);
    if (!Array.isArray(condition)) {
      const converted = scalarCondition(condition);
      if (converted.error) return converted.error;
      context.record?.('condition_branches', 1);
      if (converted.value) return context.evaluate(args[1]);
      return args.length > 2 ? context.evaluate(args[2]) : false;
    }

    const mask = mapCondition(condition);
    const values = flatten(mask);
    const needsTrue = values.some(value => value === true);
    const needsFalse = values.some(value => value === false);
    const trueValue = needsTrue ? context.evaluate(args[1]) : null;
    const falseValue = needsFalse ? (args.length > 2 ? context.evaluate(args[2]) : false) : null;
    context.record?.('condition_branches', Number(needsTrue) + Number(needsFalse));
    return selectByMask(mask, trueValue, falseValue);
  });

  register(['SES', 'IFS'], (args, context) => {
    if (args.length < 2 || args.length % 2 !== 0) return ERROR_VALUE;
    for (let index = 0; index < args.length; index += 2) {
      const condition = context.evaluate(args[index]);
      if (isError(condition)) return normalizeError(condition);
      const converted = scalarCondition(condition);
      if (converted.error) return converted.error;
      if (converted.value) {
        context.record?.('short_circuits', 1);
        return context.evaluate(args[index + 1]);
      }
    }
    return ERROR_NA;
  });

  register(['E', 'AND'], (args, context) => {
    if (!validateCount(args, 1, 255)) return ERROR_VALUE;
    let accepted = 0;
    for (const node of args) {
      const entries = logicalEntries(node, context.evaluate(node));
      if (entries.error) return entries.error;
      accepted += entries.values.length;
      if (entries.values.some(value => !value)) {
        context.record?.('short_circuits', 1);
        return false;
      }
    }
    return accepted ? true : ERROR_VALUE;
  });

  register(['OU', 'OR'], (args, context) => {
    if (!validateCount(args, 1, 255)) return ERROR_VALUE;
    let accepted = 0;
    for (const node of args) {
      const entries = logicalEntries(node, context.evaluate(node));
      if (entries.error) return entries.error;
      accepted += entries.values.length;
      if (entries.values.some(Boolean)) {
        context.record?.('short_circuits', 1);
        return true;
      }
    }
    return accepted ? false : ERROR_VALUE;
  });

  register(['NAO', 'NOT'], (args, context) => {
    if (!validateCount(args, 1)) return ERROR_VALUE;
    const evaluated = context.evaluate(args[0]);
    if (Array.isArray(evaluated)) {
      return toMatrix(evaluated).map(row => row.map(value => {
        const converted = scalarLogical(value, { blankAsFalse: true, textMode: 'error' });
        return converted.error || !converted.value;
      }));
    }
    const converted = scalarCondition(evaluated);
    return converted.error || !converted.value;
  });

  register(['OUEXCL', 'XOR'], (args, context) => {
    if (!validateCount(args, 1, 254)) return ERROR_VALUE;
    let accepted = 0;
    let truthy = 0;
    for (const node of args) {
      const entries = logicalEntries(node, context.evaluate(node));
      if (entries.error) return entries.error;
      accepted += entries.values.length;
      truthy += entries.values.filter(Boolean).length;
    }
    return accepted ? truthy % 2 === 1 : ERROR_VALUE;
  });

  register(['SEERRO', 'IFERROR'], (args, context) => {
    if (!validateCount(args, 2)) return ERROR_VALUE;
    const value = context.evaluate(args[0]);
    const hasError = Array.isArray(value) ? flatten(value).some(isError) : isError(value);
    if (!hasError) return value;
    const fallback = context.evaluate(args[1]);
    context.record?.('error_fallbacks', 1);
    return replaceErrors(value, fallback, isError);
  });

  register(['SENAODISP', 'IFNA'], (args, context) => {
    if (!validateCount(args, 2)) return ERROR_VALUE;
    const value = context.evaluate(args[0]);
    const hasNa = Array.isArray(value) ? flatten(value).some(isNaError) : isNaError(value);
    if (!hasNa) return value;
    const fallback = context.evaluate(args[1]);
    context.record?.('error_fallbacks', 1);
    return replaceErrors(value, fallback, isNaError);
  });

  register(['PARAMETRO', 'SWITCH'], (args, context) => {
    if (args.length < 3) return ERROR_VALUE;
    const expression = context.evaluate(args[0]);
    if (isError(expression)) return normalizeError(expression);
    if (Array.isArray(expression)) return ERROR_VALUE;
    const remaining = args.length - 1;
    const hasDefault = remaining % 2 === 1;
    const pairLimit = hasDefault ? args.length - 1 : args.length;
    for (let index = 1; index < pairLimit; index += 2) {
      const candidate = context.evaluate(args[index]);
      if (isError(candidate)) return normalizeError(candidate);
      if (context.compare(expression, candidate) === 0) {
        context.record?.('short_circuits', 1);
        return context.evaluate(args[index + 1]);
      }
    }
    return hasDefault ? context.evaluate(args[args.length - 1]) : ERROR_NA;
  });

  register(['ECEL.VAZIA', 'ISBLANK'], (args, context) => validateCount(args, 1) ? isBlank(context.evaluate(args[0])) : ERROR_VALUE);
  register(['ELOGICO', 'ISLOGICAL'], (args, context) => validateCount(args, 1) ? typeof unwrap(context.evaluate(args[0])) === 'boolean' : ERROR_VALUE);
  register(['ENUM', 'ISNUMBER'], (args, context) => {
    if (!validateCount(args, 1)) return ERROR_VALUE;
    const value = unwrap(context.evaluate(args[0]));
    return typeof value === 'number' && Number.isFinite(value);
  });
  register(['ETEXTO', 'ISTEXT'], (args, context) => {
    if (!validateCount(args, 1)) return ERROR_VALUE;
    const value = unwrap(context.evaluate(args[0]));
    return typeof value === 'string' && !isError(value);
  });
  register(['EERRO', 'ISERROR'], (args, context) => validateCount(args, 1) ? isError(context.evaluate(args[0])) : ERROR_VALUE);
  register(['EERROS', 'ISERR'], (args, context) => {
    if (!validateCount(args, 1)) return ERROR_VALUE;
    const value = context.evaluate(args[0]);
    return isError(value) && !isNaError(value);
  });
  register(['ENAODISP', 'ISNA'], (args, context) => validateCount(args, 1) ? isNaError(context.evaluate(args[0])) : ERROR_VALUE);
  register(['NAODISP', 'NA'], args => validateCount(args, 0) ? ERROR_NA : ERROR_VALUE);
  register(['VERDADEIRO', 'TRUE'], args => validateCount(args, 0) ? true : ERROR_VALUE);
  register(['FALSO', 'FALSE'], args => validateCount(args, 0) ? false : ERROR_VALUE);

  function evaluateCall(node, context = {}) {
    const handler = handlers.get(normalizeName(node?.name));
    if (!handler) return { handled: false, value: undefined };
    const compareValues = context.compareValues || window.SuperExcelFunctionLibrary?.compareValues || defaultCompare;
    return {
      handled: true,
      value: handler(node.args || [], {
        evaluate: typeof context.evaluate === 'function' ? context.evaluate : (() => ERROR_VALUE),
        compare: (left, right) => compareValues(unwrap(left), unwrap(right)),
        record: context.record,
      }),
    };
  }

  function mergeCatalog() {
    const current = window.SuperExcelFormulaCatalog;
    if (!current?.items) return;
    const logicalNames = new Set(catalog.map(item => normalizeName(item.name)));
    const preserved = current.items.filter(item => !logicalNames.has(normalizeName(item.name)));
    const items = Object.freeze([...preserved, ...catalog]);
    window.SuperExcelFormulaCatalog = Object.freeze({
      ...current,
      version: Number(current.version || 1) + 1,
      items,
      categories: Object.freeze([...new Set(items.map(item => item.category))]),
      count: items.length,
    });
  }

  function attachRuntime() {
    const engineApi = window.SuperExcelFormulaEngine;
    if (!engineApi?.create) return false;
    const probe = engineApi.create([]);
    const prototype = Object.getPrototypeOf(probe);
    probe.destroy?.();
    if (!prototype || prototype.__superExcelLogicalAttached) return Boolean(prototype);

    const originalEvaluateCall = prototype._evaluateCall;
    const originalEvaluateAst = prototype._evaluateAst;
    const originalGetStats = prototype.getStats;

    prototype._evaluateCall = function patchedEvaluateCall(node, stack) {
      const logical = evaluateCall(node, {
        evaluate: argument => this._evaluateAst(argument, stack),
        compareValues: window.SuperExcelFunctionLibrary?.compareValues,
        record: (metric, amount = 1) => {
          if (!this.__logicalStats) this.__logicalStats = Object.create(null);
          this.__logicalStats[metric] = (this.__logicalStats[metric] || 0) + amount;
        },
      });
      if (logical.handled) {
        if (!this.__logicalStats) this.__logicalStats = Object.create(null);
        this.__logicalStats.calls = (this.__logicalStats.calls || 0) + 1;
        return logical.value;
      }
      return originalEvaluateCall.call(this, node, stack);
    };

    prototype._evaluateAst = function patchedEvaluateAst(node, stack) {
      if (node?.type === 'binary' && COMPARISON_OPERATORS.has(node.operator)) {
        return broadcastComparison(
          node.operator,
          this._evaluateAst(node.left, stack),
          this._evaluateAst(node.right, stack),
          window.SuperExcelFunctionLibrary?.compareValues,
        );
      }
      return originalEvaluateAst.call(this, node, stack);
    };

    prototype.getStats = function patchedGetStats() {
      const stats = originalGetStats.call(this);
      const logical = this.__logicalStats || {};
      return {
        ...stats,
        logical_calls: logical.calls || 0,
        logical_short_circuits: logical.short_circuits || 0,
        logical_condition_branches: logical.condition_branches || 0,
        logical_error_fallbacks: logical.error_fallbacks || 0,
      };
    };

    Object.defineProperty(prototype, '__superExcelLogicalAttached', { value: true });
    return true;
  }

  window.SuperExcelLogicalLibrary = Object.freeze({
    version: 1,
    catalog,
    compareOperator,
    broadcastComparison,
    evaluateCall,
    isError,
    isNaError,
    normalizeName,
    scalarLogical,
    attachRuntime,
  });

  mergeCatalog();
  attachRuntime();
})();
