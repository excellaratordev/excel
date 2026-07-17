(() => {
  'use strict';

  class FormulaSyntaxError extends Error {
    constructor(message, position = -1) {
      super(position >= 0 ? `${message} na posição ${position + 1}.` : message);
      this.name = 'FormulaSyntaxError';
      this.code = '#NOME?';
      this.position = position;
    }
  }

  function normalizeFunctionName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toUpperCase();
  }

  function isCellReference(value) {
    return /^\$?[A-Z]{1,3}\$?[1-9]\d*$/iu.test(String(value || ''));
  }

  function columnIndex(name) {
    const letters = String(name).replaceAll('$', '').toUpperCase();
    let result = 0;
    for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
    return result - 1;
  }

  function parseCellReference(value) {
    const match = String(value || '').match(/^\$?([A-Z]{1,3})\$?([1-9]\d*)$/iu);
    if (!match) throw new FormulaSyntaxError(`Referência inválida: ${value}`);
    return { row: Number(match[2]) - 1, col: columnIndex(match[1]) };
  }

  class Tokenizer {
    constructor(input) {
      this.input = String(input || '');
      this.index = 0;
    }

    next() {
      this.skipWhitespace();
      if (this.index >= this.input.length) return { type: 'EOF', value: '', position: this.index };

      const position = this.index;
      const character = this.input[this.index];

      if (character === '"') return this.readString();
      if (/\d/u.test(character) || ((character === ',' || character === '.') && /\d/u.test(this.input[this.index + 1] || ''))) {
        return this.readNumber();
      }

      const pair = this.input.slice(this.index, this.index + 2);
      if (['<=', '>=', '<>'].includes(pair)) {
        this.index += 2;
        return { type: 'OP', value: pair, position };
      }

      if ('+-*/^&=<>%'.includes(character)) {
        this.index += 1;
        return { type: 'OP', value: character, position };
      }

      const punctuation = {
        '(': 'LPAREN',
        ')': 'RPAREN',
        ';': 'ARG',
        ',': 'ARG',
        ':': 'COLON',
      };
      if (punctuation[character]) {
        this.index += 1;
        return { type: punctuation[character], value: character, position };
      }

      if (/[\p{L}_$]/u.test(character)) return this.readIdentifier();
      throw new FormulaSyntaxError(`Caractere inesperado: ${character}`, position);
    }

    skipWhitespace() {
      while (/\s/u.test(this.input[this.index] || '')) this.index += 1;
    }

    readString() {
      const position = this.index;
      this.index += 1;
      let value = '';
      while (this.index < this.input.length) {
        const character = this.input[this.index];
        if (character === '"') {
          if (this.input[this.index + 1] === '"') {
            value += '"';
            this.index += 2;
            continue;
          }
          this.index += 1;
          return { type: 'STRING', value, position };
        }
        value += character;
        this.index += 1;
      }
      throw new FormulaSyntaxError('Texto sem fechamento', position);
    }

    readNumber() {
      const position = this.index;
      let raw = '';
      while (/[\d.,]/u.test(this.input[this.index] || '')) {
        raw += this.input[this.index];
        this.index += 1;
      }

      let normalized = raw;
      if (raw.includes(',') && raw.includes('.')) normalized = raw.replaceAll('.', '').replace(',', '.');
      else if (raw.includes(',')) normalized = raw.replace(',', '.');
      else if (/^\d{1,3}(?:\.\d{3})+$/u.test(raw)) normalized = raw.replaceAll('.', '');

      const value = Number(normalized);
      if (!Number.isFinite(value)) throw new FormulaSyntaxError(`Número inválido: ${raw}`, position);
      return { type: 'NUMBER', value, position };
    }

    readIdentifier() {
      const position = this.index;
      let value = '';
      while (/[\p{L}\p{N}_.\-$]/u.test(this.input[this.index] || '')) {
        value += this.input[this.index];
        this.index += 1;
      }
      return { type: 'IDENT', value, position };
    }
  }

  class Parser {
    constructor(formula) {
      const source = String(formula || '').trim();
      this.tokenizer = new Tokenizer(source.startsWith('=') ? source.slice(1) : source);
      this.current = this.tokenizer.next();
    }

    parse() {
      const result = this.parseComparison();
      if (this.current.type !== 'EOF') throw new FormulaSyntaxError(`Token inesperado: ${this.current.value}`, this.current.position);
      return result;
    }

    advance() {
      const previous = this.current;
      this.current = this.tokenizer.next();
      return previous;
    }

    accept(type, value = null) {
      if (this.current.type !== type) return null;
      if (value !== null && this.current.value !== value) return null;
      return this.advance();
    }

    expect(type, value = null) {
      const token = this.accept(type, value);
      if (!token) throw new FormulaSyntaxError(`Esperado ${value ?? type}`, this.current.position);
      return token;
    }

    parseComparison() {
      let left = this.parseConcat();
      while (this.current.type === 'OP' && ['=', '<>', '<', '>', '<=', '>='].includes(this.current.value)) {
        const operator = this.advance().value;
        left = { type: 'binary', operator, left, right: this.parseConcat() };
      }
      return left;
    }

    parseConcat() {
      let left = this.parseAdditive();
      while (this.accept('OP', '&')) left = { type: 'binary', operator: '&', left, right: this.parseAdditive() };
      return left;
    }

    parseAdditive() {
      let left = this.parseMultiplicative();
      while (this.current.type === 'OP' && ['+', '-'].includes(this.current.value)) {
        const operator = this.advance().value;
        left = { type: 'binary', operator, left, right: this.parseMultiplicative() };
      }
      return left;
    }

    parseMultiplicative() {
      let left = this.parsePower();
      while (this.current.type === 'OP' && ['*', '/'].includes(this.current.value)) {
        const operator = this.advance().value;
        left = { type: 'binary', operator, left, right: this.parsePower() };
      }
      return left;
    }

    parsePower() {
      let left = this.parseUnary();
      if (this.accept('OP', '^')) left = { type: 'binary', operator: '^', left, right: this.parsePower() };
      return left;
    }

    parseUnary() {
      if (this.current.type === 'OP' && ['+', '-'].includes(this.current.value)) {
        const operator = this.advance().value;
        return { type: 'unary', operator, value: this.parseUnary() };
      }
      let result = this.parsePrimary();
      while (this.accept('OP', '%')) result = { type: 'percent', value: result };
      return result;
    }

    parsePrimary() {
      if (this.current.type === 'NUMBER') return { type: 'literal', value: this.advance().value };
      if (this.current.type === 'STRING') return { type: 'literal', value: this.advance().value };

      if (this.current.type === 'IDENT') {
        const token = this.advance();
        const normalized = normalizeFunctionName(token.value);

        if (this.accept('LPAREN')) {
          const args = [];
          if (!this.accept('RPAREN')) {
            do {
              args.push(this.parseComparison());
            } while (this.accept('ARG'));
            this.expect('RPAREN');
          }
          return { type: 'call', name: normalized, originalName: token.value, args };
        }

        if (['VERDADEIRO', 'TRUE'].includes(normalized)) return { type: 'literal', value: true };
        if (['FALSO', 'FALSE'].includes(normalized)) return { type: 'literal', value: false };

        if (isCellReference(token.value)) {
          const start = parseCellReference(token.value);
          if (this.accept('COLON')) {
            const endToken = this.expect('IDENT');
            if (!isCellReference(endToken.value)) throw new FormulaSyntaxError('O fim do intervalo é inválido', endToken.position);
            return { type: 'range', start, end: parseCellReference(endToken.value) };
          }
          return { type: 'reference', ...start };
        }

        throw new FormulaSyntaxError(`Nome não reconhecido: ${token.value}`, token.position);
      }

      if (this.accept('LPAREN')) {
        const value = this.parseComparison();
        this.expect('RPAREN');
        return value;
      }

      throw new FormulaSyntaxError(`Expressão inválida: ${this.current.value}`, this.current.position);
    }
  }

  function parse(formula) {
    return new Parser(formula).parse();
  }

  function collectDependencies(ast) {
    const cells = new Set();
    const ranges = [];

    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'reference') {
        cells.add(`${node.row}:${node.col}`);
        return;
      }
      if (node.type === 'range') {
        ranges.push({
          top: Math.min(node.start.row, node.end.row),
          bottom: Math.max(node.start.row, node.end.row),
          left: Math.min(node.start.col, node.end.col),
          right: Math.max(node.start.col, node.end.col),
        });
        return;
      }
      if (node.left) visit(node.left);
      if (node.right) visit(node.right);
      if (node.value && typeof node.value === 'object') visit(node.value);
      for (const argument of node.args || []) visit(argument);
    }

    visit(ast);
    return { cells, ranges };
  }

  window.SuperExcelFormulaParser = Object.freeze({
    FormulaSyntaxError,
    collectDependencies,
    normalizeFunctionName,
    parse,
    parseCellReference,
  });
})();
