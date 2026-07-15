(() => {
  'use strict';

  const engineApi = window.SuperExcelFormulaEngine;
  if (!engineApi) return;

  const originalNormalizeFormula = engineApi.normalizeFormula.bind(engineApi);
  const originalCreate = engineApi.create.bind(engineApi);

  function translateEnglishBooleans(formula) {
    return formula
      .split('"')
      .map((part, index) => {
        if (index % 2 === 1) return part;
        return part
          .replace(/\bTRUE\b(?!\s*\()/giu, 'VERDADEIRO')
          .replace(/\bFALSE\b(?!\s*\()/giu, 'FALSO');
      })
      .join('"');
  }

  function findClosingParenthesis(text, openIndex) {
    let depth = 0;
    let inString = false;

    for (let index = openIndex; index < text.length; index += 1) {
      const character = text[index];

      if (character === '"') {
        if (inString && text[index + 1] === '"') {
          index += 1;
          continue;
        }
        inString = !inString;
        continue;
      }

      if (inString) continue;
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }

    return -1;
  }

  function countTopLevelSeparators(text) {
    let depth = 0;
    let separators = 0;
    let inString = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

      if (character === '"') {
        if (inString && text[index + 1] === '"') {
          index += 1;
          continue;
        }
        inString = !inString;
        continue;
      }

      if (inString) continue;
      if (character === '(') depth += 1;
      else if (character === ')') depth = Math.max(0, depth - 1);
      else if (character === ';' && depth === 0) separators += 1;
    }

    return separators;
  }

  function addDefaultFalseToIf(formula) {
    let result = '';
    let index = 0;

    while (index < formula.length) {
      const match = formula.slice(index).match(/(^|[^A-ZÀ-Ü0-9_.])SE\s*\(/iu);
      if (!match) {
        result += formula.slice(index);
        break;
      }

      const matchStart = index + match.index;
      const functionStart = matchStart + match[1].length;
      const openIndex = formula.indexOf('(', functionStart);
      const closeIndex = findClosingParenthesis(formula, openIndex);

      if (closeIndex < 0) {
        result += formula.slice(index);
        break;
      }

      result += formula.slice(index, openIndex + 1);
      let inner = formula.slice(openIndex + 1, closeIndex);
      inner = addDefaultFalseToIf(inner);

      // SE(condição; valor_se_verdadeiro) passa a usar FALSO como terceiro argumento.
      if (countTopLevelSeparators(inner) === 1) inner += ';FALSO()';

      result += `${inner})`;
      index = closeIndex + 1;
    }

    return result;
  }

  function normalizeFormula(formula) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
    const translated = translateEnglishBooleans(formula);
    const normalized = originalNormalizeFormula(translated);
    return addDefaultFalseToIf(normalized);
  }

  function normalizeDataForEngine(data) {
    return data.map((row) => row.map(normalizeFormula));
  }

  engineApi.normalizeFormula = normalizeFormula;
  engineApi.normalizeDataForEngine = normalizeDataForEngine;
  engineApi.create = (data) => originalCreate(normalizeDataForEngine(data));
})();
