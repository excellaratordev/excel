use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{BTreeSet, HashMap};
use std::mem;
use std::slice;
use std::str;
use std::sync::atomic::{AtomicUsize, Ordering};

mod workbook;

pub const ABI_VERSION: u32 = 4;
const IR_VERSION: u32 = 1;
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
const MAX_RANGE_CELLS: usize = 4096;
static LAST_RESULT_LEN: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Blank,
    Number(f64),
    Boolean(bool),
    Text(String),
    Formula(String),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellCoordinate {
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CellPatch {
    pub coordinate: CellCoordinate,
    pub value: CellValue,
}

#[derive(Debug, Deserialize)]
struct EvaluationRequest {
    formula: String,
    #[serde(default)]
    cells: HashMap<String, JsonValue>,
}

#[derive(Debug, Deserialize)]
struct CompileRequest {
    formula: String,
}

#[derive(Debug, Serialize)]
struct EvaluationResponse {
    status: &'static str,
    value: JsonValue,
    value_type: &'static str,
    dependencies: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Blank,
    Number(f64),
    Boolean(bool),
    Text(String),
    Error(String),
    Array(Vec<Vec<Value>>),
}

impl Value {
    fn from_json(value: &JsonValue) -> Self {
        match value {
            JsonValue::Null => Self::Blank,
            JsonValue::Bool(value) => Self::Boolean(*value),
            JsonValue::Number(value) => value
                .as_f64()
                .map(Self::Number)
                .unwrap_or(Self::Error("#NUM!".into())),
            JsonValue::String(value) if value.starts_with('#') => Self::Error(value.clone()),
            JsonValue::String(value) => Self::Text(value.clone()),
            JsonValue::Array(rows) => {
                let matrix = if rows.iter().all(JsonValue::is_array) {
                    rows.iter()
                        .map(|row| {
                            row.as_array()
                                .map(|items| items.iter().map(Self::from_json).collect())
                                .unwrap_or_default()
                        })
                        .collect()
                } else {
                    rows.iter()
                        .map(|item| vec![Self::from_json(item)])
                        .collect()
                };
                Self::Array(matrix)
            }
            JsonValue::Object(_) => Self::Error("#VALOR!".into()),
        }
    }

    fn to_json(&self) -> JsonValue {
        match self {
            Self::Blank => JsonValue::Null,
            Self::Number(value) => json!(value),
            Self::Boolean(value) => json!(value),
            Self::Text(value) | Self::Error(value) => json!(value),
            Self::Array(rows) => JsonValue::Array(
                rows.iter()
                    .map(|row| JsonValue::Array(row.iter().map(Self::to_json).collect()))
                    .collect(),
            ),
        }
    }

    fn value_type(&self) -> &'static str {
        match self {
            Self::Blank => "blank",
            Self::Number(_) => "number",
            Self::Boolean(_) => "boolean",
            Self::Text(_) => "text",
            Self::Error(_) => "error",
            Self::Array(_) => "array",
        }
    }

    fn first_error(&self) -> Option<Value> {
        match self {
            Self::Error(_) => Some(self.clone()),
            Self::Array(rows) => rows.iter().flatten().find_map(Self::first_error),
            _ => None,
        }
    }

    fn flatten(&self, output: &mut Vec<Value>) {
        match self {
            Self::Array(rows) => {
                for value in rows.iter().flatten() {
                    value.flatten(output);
                }
            }
            value => output.push(value.clone()),
        }
    }
}

#[derive(Debug, Clone)]
struct EngineError {
    code: &'static str,
    message: String,
    unsupported: bool,
}

impl EngineError {
    fn syntax(message: impl Into<String>) -> Self {
        Self {
            code: "#NOME?",
            message: message.into(),
            unsupported: false,
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "#N/D",
            message: message.into(),
            unsupported: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    String(String),
    Ident(String),
    Op(String),
    LParen,
    RParen,
    Arg,
    Colon,
    End,
}

struct Tokenizer {
    chars: Vec<char>,
    index: usize,
}

impl Tokenizer {
    fn new(source: &str) -> Self {
        Self {
            chars: source.chars().collect(),
            index: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn next_char(&mut self) -> Option<char> {
        let value = self.peek()?;
        self.index += 1;
        Some(value)
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.index += 1;
        }
    }

    fn next_token(&mut self) -> Result<Token, EngineError> {
        self.skip_whitespace();
        let Some(character) = self.peek() else {
            return Ok(Token::End);
        };

        if character == '"' {
            return self.read_string();
        }
        if character == '\'' || character == '!' {
            return Err(EngineError::unsupported(
                "Referências externas ainda não são suportadas pelo núcleo Rust/Wasm.",
            ));
        }
        if character.is_ascii_digit()
            || ((character == ',' || character == '.')
                && self
                    .chars
                    .get(self.index + 1)
                    .is_some_and(char::is_ascii_digit))
        {
            return self.read_number();
        }

        let pair: String = self.chars.iter().skip(self.index).take(2).collect();
        if matches!(pair.as_str(), "<=" | ">=" | "<>") {
            self.index += 2;
            return Ok(Token::Op(pair));
        }
        if "+-*/^&=<>%".contains(character) {
            self.index += 1;
            return Ok(Token::Op(character.to_string()));
        }

        match character {
            '(' => {
                self.index += 1;
                return Ok(Token::LParen);
            }
            ')' => {
                self.index += 1;
                return Ok(Token::RParen);
            }
            ';' => {
                self.index += 1;
                return Ok(Token::Arg);
            }
            ':' => {
                self.index += 1;
                return Ok(Token::Colon);
            }
            ',' => {
                self.index += 1;
                return Ok(Token::Arg);
            }
            _ => {}
        }

        if character.is_alphabetic() || matches!(character, '_' | '$') {
            return Ok(Token::Ident(self.read_identifier()));
        }
        Err(EngineError::syntax(format!(
            "Caractere inesperado: {character}"
        )))
    }

    fn read_string(&mut self) -> Result<Token, EngineError> {
        self.index += 1;
        let mut output = String::new();
        while let Some(character) = self.next_char() {
            if character == '"' {
                if self.peek() == Some('"') {
                    output.push('"');
                    self.index += 1;
                    continue;
                }
                return Ok(Token::String(output));
            }
            output.push(character);
        }
        Err(EngineError::syntax("Texto sem fechamento."))
    }

    fn read_number(&mut self) -> Result<Token, EngineError> {
        let mut raw = String::new();
        while self
            .peek()
            .is_some_and(|value| value.is_ascii_digit() || value == '.' || value == ',')
        {
            raw.push(self.next_char().unwrap());
        }
        let normalized = if raw.contains(',') && raw.contains('.') {
            raw.replace('.', "").replacen(',', ".", 1)
        } else if raw.contains(',') {
            raw.replacen(',', ".", 1)
        } else if looks_like_thousands(&raw) {
            raw.replace('.', "")
        } else {
            raw.clone()
        };
        normalized
            .parse::<f64>()
            .map(Token::Number)
            .map_err(|_| EngineError::syntax(format!("Número inválido: {raw}")))
    }

    fn read_identifier(&mut self) -> String {
        let mut output = String::new();
        while self
            .peek()
            .is_some_and(|value| value.is_alphanumeric() || matches!(value, '_' | '.' | '-' | '$'))
        {
            output.push(self.next_char().unwrap());
        }
        output
    }
}

fn looks_like_thousands(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split('.').collect();
    parts.len() > 1
        && (1..=3).contains(&parts[0].len())
        && parts[1..]
            .iter()
            .all(|part| part.len() == 3 && part.chars().all(|value| value.is_ascii_digit()))
}

#[derive(Debug, Clone)]
struct CellReference {
    row: usize,
    col: usize,
}

#[derive(Debug, Clone)]
enum Ast {
    Literal(Value),
    Reference(CellReference),
    Range(CellReference, CellReference),
    Unary(String, Box<Ast>),
    Percent(Box<Ast>),
    Binary(String, Box<Ast>, Box<Ast>),
    Call(String, Vec<Ast>),
}

struct Parser {
    tokenizer: Tokenizer,
    current: Token,
}

impl Parser {
    fn new(formula: &str) -> Result<Self, EngineError> {
        let source = formula.trim().strip_prefix('=').unwrap_or(formula.trim());
        let mut tokenizer = Tokenizer::new(source);
        let current = tokenizer.next_token()?;
        Ok(Self { tokenizer, current })
    }

    fn advance(&mut self) -> Result<Token, EngineError> {
        let previous = self.current.clone();
        self.current = self.tokenizer.next_token()?;
        Ok(previous)
    }

    fn parse(mut self) -> Result<Ast, EngineError> {
        let value = self.parse_comparison()?;
        if self.current != Token::End {
            return Err(EngineError::syntax(format!(
                "Token inesperado: {:?}",
                self.current
            )));
        }
        Ok(value)
    }

    fn parse_comparison(&mut self) -> Result<Ast, EngineError> {
        let mut left = self.parse_concat()?;
        while matches!(&self.current, Token::Op(value) if matches!(value.as_str(), "=" | "<>" | "<" | ">" | "<=" | ">="))
        {
            let Token::Op(operator) = self.advance()? else {
                unreachable!()
            };
            let right = self.parse_concat()?;
            left = Ast::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_concat(&mut self) -> Result<Ast, EngineError> {
        let mut left = self.parse_additive()?;
        while self.current == Token::Op("&".into()) {
            self.advance()?;
            let right = self.parse_additive()?;
            left = Ast::Binary("&".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> Result<Ast, EngineError> {
        let mut left = self.parse_multiplicative()?;
        while matches!(&self.current, Token::Op(value) if value == "+" || value == "-") {
            let Token::Op(operator) = self.advance()? else {
                unreachable!()
            };
            let right = self.parse_multiplicative()?;
            left = Ast::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<Ast, EngineError> {
        let mut left = self.parse_power()?;
        while matches!(&self.current, Token::Op(value) if value == "*" || value == "/") {
            let Token::Op(operator) = self.advance()? else {
                unreachable!()
            };
            let right = self.parse_power()?;
            left = Ast::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_power(&mut self) -> Result<Ast, EngineError> {
        let left = self.parse_unary()?;
        if self.current == Token::Op("^".into()) {
            self.advance()?;
            let right = self.parse_power()?;
            return Ok(Ast::Binary("^".into(), Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Ast, EngineError> {
        if matches!(&self.current, Token::Op(value) if value == "+" || value == "-") {
            let Token::Op(operator) = self.advance()? else {
                unreachable!()
            };
            return Ok(Ast::Unary(operator, Box::new(self.parse_unary()?)));
        }
        let mut value = self.parse_primary()?;
        while self.current == Token::Op("%".into()) {
            self.advance()?;
            value = Ast::Percent(Box::new(value));
        }
        Ok(value)
    }

    fn parse_primary(&mut self) -> Result<Ast, EngineError> {
        match self.advance()? {
            Token::Number(value) => Ok(Ast::Literal(Value::Number(value))),
            Token::String(value) => Ok(Ast::Literal(Value::Text(value))),
            Token::Ident(value) => self.parse_identifier(value),
            Token::LParen => {
                let value = self.parse_comparison()?;
                if self.current != Token::RParen {
                    return Err(EngineError::syntax("Parêntese sem fechamento."));
                }
                self.advance()?;
                Ok(value)
            }
            token => Err(EngineError::syntax(format!(
                "Expressão inválida: {token:?}"
            ))),
        }
    }

    fn parse_identifier(&mut self, value: String) -> Result<Ast, EngineError> {
        let normalized = normalize_function_name(&value);
        if self.current == Token::LParen {
            self.advance()?;
            let mut args = Vec::new();
            if self.current != Token::RParen {
                loop {
                    args.push(self.parse_comparison()?);
                    if self.current == Token::Arg {
                        self.advance()?;
                        continue;
                    }
                    break;
                }
            }
            if self.current != Token::RParen {
                return Err(EngineError::syntax("Chamada de função sem fechamento."));
            }
            self.advance()?;
            return Ok(Ast::Call(normalized, args));
        }
        if matches!(normalized.as_str(), "VERDADEIRO" | "TRUE") {
            return Ok(Ast::Literal(Value::Boolean(true)));
        }
        if matches!(normalized.as_str(), "FALSO" | "FALSE") {
            return Ok(Ast::Literal(Value::Boolean(false)));
        }
        let start = parse_cell_reference(&value)?;
        if self.current == Token::Colon {
            self.advance()?;
            let Token::Ident(end) = self.advance()? else {
                return Err(EngineError::syntax("Fim de intervalo inválido."));
            };
            return Ok(Ast::Range(start, parse_cell_reference(&end)?));
        }
        Ok(Ast::Reference(start))
    }
}

fn normalize_function_name(value: &str) -> String {
    value
        .trim()
        .to_uppercase()
        .chars()
        .filter_map(|character| match character {
            '.' => None,
            'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => Some('A'),
            'É' | 'È' | 'Ê' | 'Ë' => Some('E'),
            'Í' | 'Ì' | 'Î' | 'Ï' => Some('I'),
            'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => Some('O'),
            'Ú' | 'Ù' | 'Û' | 'Ü' => Some('U'),
            'Ç' => Some('C'),
            other => Some(other),
        })
        .collect()
}

fn parse_cell_reference(value: &str) -> Result<CellReference, EngineError> {
    let normalized = value.replace('$', "").to_uppercase();
    let split = normalized
        .find(|character: char| character.is_ascii_digit())
        .ok_or_else(|| EngineError::syntax(format!("Referência inválida: {value}")))?;
    let (letters, digits) = normalized.split_at(split);
    if letters.is_empty()
        || letters.len() > 3
        || digits.is_empty()
        || digits.starts_with('0')
        || !letters.chars().all(|value| value.is_ascii_alphabetic())
        || !digits.chars().all(|value| value.is_ascii_digit())
    {
        return Err(EngineError::syntax(format!("Referência inválida: {value}")));
    }
    let mut col = 0usize;
    for character in letters.chars() {
        col = col * 26 + (character as usize - 'A' as usize + 1);
    }
    let row = digits
        .parse::<usize>()
        .map_err(|_| EngineError::syntax("Linha inválida."))?;
    Ok(CellReference {
        row: row - 1,
        col: col - 1,
    })
}

fn column_name(mut index: usize) -> String {
    index += 1;
    let mut output = String::new();
    while index > 0 {
        let remainder = (index - 1) % 26;
        output.insert(0, char::from_u32(('A' as u32) + remainder as u32).unwrap());
        index = (index - 1) / 26;
    }
    output
}

fn cell_name(reference: &CellReference) -> String {
    format!("{}{}", column_name(reference.col), reference.row + 1)
}

fn collect_dependencies(ast: &Ast, output: &mut BTreeSet<String>) -> Result<(), EngineError> {
    match ast {
        Ast::Reference(reference) => {
            output.insert(cell_name(reference));
        }
        Ast::Range(start, end) => {
            let top = start.row.min(end.row);
            let bottom = start.row.max(end.row);
            let left = start.col.min(end.col);
            let right = start.col.max(end.col);
            let total = (bottom - top + 1).saturating_mul(right - left + 1);
            if total > MAX_RANGE_CELLS {
                return Err(EngineError::unsupported(format!(
                    "Intervalo excede o limite experimental de {MAX_RANGE_CELLS} células."
                )));
            }
            for row in top..=bottom {
                for col in left..=right {
                    output.insert(cell_name(&CellReference { row, col }));
                }
            }
        }
        Ast::Unary(_, value) | Ast::Percent(value) => collect_dependencies(value, output)?,
        Ast::Binary(_, left, right) => {
            collect_dependencies(left, output)?;
            collect_dependencies(right, output)?;
        }
        Ast::Call(_, args) => {
            for arg in args {
                collect_dependencies(arg, output)?;
            }
        }
        Ast::Literal(_) => {}
    }
    Ok(())
}

struct Evaluator<'a> {
    cells: &'a HashMap<String, JsonValue>,
}

impl<'a> Evaluator<'a> {
    fn evaluate(&self, ast: &Ast) -> Result<Value, EngineError> {
        match ast {
            Ast::Literal(value) => Ok(value.clone()),
            Ast::Reference(reference) => Ok(self.read_cell(reference)),
            Ast::Range(start, end) => self.evaluate_range(start, end),
            Ast::Unary(operator, value) => {
                let value = self.evaluate(value)?;
                self.map_scalar(value, |item| {
                    let number = to_number(&item)?;
                    Ok(Value::Number(if operator == "-" {
                        -number
                    } else {
                        number
                    }))
                })
            }
            Ast::Percent(value) => {
                let value = self.evaluate(value)?;
                self.map_scalar(value, |item| Ok(Value::Number(to_number(&item)? / 100.0)))
            }
            Ast::Binary(operator, left, right) => {
                let left = self.evaluate(left)?;
                let right = self.evaluate(right)?;
                broadcast_binary(operator, left, right)
            }
            Ast::Call(name, args) => self.evaluate_call(name, args),
        }
    }

    fn read_cell(&self, reference: &CellReference) -> Value {
        self.cells
            .get(&cell_name(reference))
            .map(Value::from_json)
            .unwrap_or(Value::Blank)
    }

    fn evaluate_range(
        &self,
        start: &CellReference,
        end: &CellReference,
    ) -> Result<Value, EngineError> {
        let top = start.row.min(end.row);
        let bottom = start.row.max(end.row);
        let left = start.col.min(end.col);
        let right = start.col.max(end.col);
        let total = (bottom - top + 1).saturating_mul(right - left + 1);
        if total > MAX_RANGE_CELLS {
            return Err(EngineError::unsupported(format!(
                "Intervalo excede o limite experimental de {MAX_RANGE_CELLS} células."
            )));
        }
        Ok(Value::Array(
            (top..=bottom)
                .map(|row| {
                    (left..=right)
                        .map(|col| self.read_cell(&CellReference { row, col }))
                        .collect()
                })
                .collect(),
        ))
    }

    fn map_scalar<F>(&self, value: Value, mapper: F) -> Result<Value, EngineError>
    where
        F: Fn(Value) -> Result<Value, EngineError> + Copy,
    {
        match value {
            Value::Array(rows) => Ok(Value::Array(
                rows.into_iter()
                    .map(|row| {
                        row.into_iter()
                            .map(|item| {
                                mapper(item).unwrap_or_else(|error| Value::Error(error.code.into()))
                            })
                            .collect()
                    })
                    .collect(),
            )),
            item => mapper(item),
        }
    }

    fn evaluate_call(&self, name: &str, args: &[Ast]) -> Result<Value, EngineError> {
        match name {
            "SE" | "IF" => {
                let condition = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("SE exige uma condição."))?;
                let condition = self.evaluate(condition)?;
                if let Some(error) = condition.first_error() {
                    return Ok(error);
                }
                if truthy(&condition)? {
                    args.get(1)
                        .map(|value| self.evaluate(value))
                        .unwrap_or(Ok(Value::Boolean(true)))
                } else {
                    args.get(2)
                        .map(|value| self.evaluate(value))
                        .unwrap_or(Ok(Value::Boolean(false)))
                }
            }
            "E" | "AND" => {
                for arg in args {
                    let value = self.evaluate(arg)?;
                    if let Some(error) = value.first_error() {
                        return Ok(error);
                    }
                    if !truthy(&value)? {
                        return Ok(Value::Boolean(false));
                    }
                }
                Ok(Value::Boolean(true))
            }
            "OU" | "OR" => {
                for arg in args {
                    let value = self.evaluate(arg)?;
                    if let Some(error) = value.first_error() {
                        return Ok(error);
                    }
                    if truthy(&value)? {
                        return Ok(Value::Boolean(true));
                    }
                }
                Ok(Value::Boolean(false))
            }
            "NAO" | "NÃO" | "NOT" => {
                let value = self.evaluate(
                    args.first()
                        .ok_or_else(|| EngineError::syntax("NÃO exige um argumento."))?,
                )?;
                Ok(Value::Boolean(!truthy(&value)?))
            }
            "SEERRO" | "IFERROR" => {
                let value = self.evaluate(
                    args.first()
                        .ok_or_else(|| EngineError::syntax("SEERRO exige um valor."))?,
                )?;
                if value.first_error().is_some() {
                    args.get(1)
                        .map(|fallback| self.evaluate(fallback))
                        .unwrap_or(Ok(Value::Blank))
                } else {
                    Ok(value)
                }
            }
            "SOMA" | "SUM" => self.aggregate(args, Aggregate::Sum),
            "MEDIA" | "MÉDIA" | "AVERAGE" => self.aggregate(args, Aggregate::Average),
            "MINIMO" | "MÍNIMO" | "MIN" => self.aggregate(args, Aggregate::Min),
            "MAXIMO" | "MÁXIMO" | "MAX" => self.aggregate(args, Aggregate::Max),
            "CONTNUM" | "COUNT" => self.aggregate(args, Aggregate::Count),
            "CONTSE" | "COUNTIF" => self.count_ifs(args),
            "CONTSES" | "COUNTIFS" => self.count_ifs(args),
            "SOMASE" | "SUMIF" => self.sum_if(args),
            "SOMASES" | "SUMIFS" => self.conditional_aggregate(args, ConditionalAggregate::Sum),
            "MEDIASE" | "AVERAGEIF" => self.average_if(args),
            "MEDIASES" | "AVERAGEIFS" => {
                self.conditional_aggregate(args, ConditionalAggregate::Average)
            }
            "PROCV" | "VLOOKUP" => self.vlookup(args),
            "PROCX" | "XLOOKUP" => self.xlookup(args),
            "INDICE" | "INDEX" => self.index_function(args),
            "CORRESP" | "MATCH" => self.match_function(args),
            "ABS" => {
                let value = self.evaluate(
                    args.first()
                        .ok_or_else(|| EngineError::syntax("ABS exige um argumento."))?,
                )?;
                self.map_scalar(value, |item| Ok(Value::Number(to_number(&item)?.abs())))
            }
            "ARRED" | "ROUND" => {
                let value = self.evaluate(
                    args.first()
                        .ok_or_else(|| EngineError::syntax("ARRED exige um valor."))?,
                )?;
                let digits = args
                    .get(1)
                    .map(|value| self.evaluate(value))
                    .transpose()?
                    .unwrap_or(Value::Number(0.0));
                let digits = to_number(&digits)?.trunc().clamp(-15.0, 15.0) as i32;
                let factor = 10_f64.powi(digits.abs());
                self.map_scalar(value, |item| {
                    let number = to_number(&item)?;
                    let rounded = if digits >= 0 {
                        (number * factor).round() / factor
                    } else {
                        (number / factor).round() * factor
                    };
                    Ok(Value::Number(rounded))
                })
            }
            _ => Err(EngineError::unsupported(format!(
                "Função ainda não implementada em Rust/Wasm: {name}"
            ))),
        }
    }


    fn evaluated_arguments(&self, args: &[Ast]) -> Result<Vec<Value>, EngineError> {
        args.iter().map(|arg| self.evaluate(arg)).collect()
    }

    fn count_ifs(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.is_empty() || args.len() % 2 != 0 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let evaluated = self.evaluated_arguments(args)?;
        let mut ranges = Vec::new();
        let mut criteria = Vec::new();
        let mut expected_len = None;
        for pair in evaluated.chunks_exact(2) {
            let range = flatten_owned(pair[0].clone());
            if let Some(length) = expected_len {
                if range.len() != length {
                    return Ok(Value::Error("#VALOR!".into()));
                }
            } else {
                expected_len = Some(range.len());
            }
            ranges.push(range);
            criteria.push(first_scalar(pair[1].clone()));
        }
        let length = expected_len.unwrap_or(0);
        let count = (0..length)
            .filter(|index| {
                ranges
                    .iter()
                    .zip(criteria.iter())
                    .all(|(range, criterion)| matches_criterion(&range[*index], criterion))
            })
            .count();
        Ok(Value::Number(count as f64))
    }

    fn sum_if(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let criteria_range = self.evaluate(&args[0])?;
        let criterion = self.evaluate(&args[1])?;
        let sum_range = if let Some(range) = args.get(2) {
            self.evaluate(range)?
        } else {
            criteria_range.clone()
        };
        conditional_aggregate_values(
            sum_range,
            vec![(criteria_range, criterion)],
            ConditionalAggregate::Sum,
        )
    }

    fn average_if(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let criteria_range = self.evaluate(&args[0])?;
        let criterion = self.evaluate(&args[1])?;
        let average_range = if let Some(range) = args.get(2) {
            self.evaluate(range)?
        } else {
            criteria_range.clone()
        };
        conditional_aggregate_values(
            average_range,
            vec![(criteria_range, criterion)],
            ConditionalAggregate::Average,
        )
    }

    fn conditional_aggregate(
        &self,
        args: &[Ast],
        mode: ConditionalAggregate,
    ) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() % 2 == 0 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let values = self.evaluate(&args[0])?;
        let mut criteria = Vec::new();
        for pair in args[1..].chunks_exact(2) {
            criteria.push((self.evaluate(&pair[0])?, self.evaluate(&pair[1])?));
        }
        conditional_aggregate_values(values, criteria, mode)
    }

    fn vlookup(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() > 4 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup = first_scalar(self.evaluate(&args[0])?);
        let table = to_matrix(self.evaluate(&args[1])?);
        let column = to_number(&first_scalar(self.evaluate(&args[2])?))?.trunc() as isize - 1;
        if column < 0 || table.iter().any(|row| column as usize >= row.len()) {
            return Ok(Value::Error("#REF!".into()));
        }
        let approximate = args
            .get(3)
            .map(|arg| self.evaluate(arg))
            .transpose()?
            .map(first_scalar)
            .map(|value| truthy(&value))
            .transpose()?
            .unwrap_or(true);
        let selected = if approximate {
            let mut candidate = None;
            for row in &table {
                if row
                    .first()
                    .is_some_and(|value| compare_values(value, &lookup) <= 0)
                {
                    candidate = Some(row);
                } else {
                    break;
                }
            }
            candidate
        } else {
            table
                .iter()
                .find(|row| row.first().is_some_and(|value| compare_values(value, &lookup) == 0))
        };
        Ok(selected
            .and_then(|row| row.get(column as usize))
            .cloned()
            .unwrap_or(Value::Error("#N/D".into())))
    }

    fn xlookup(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() > 4 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup = first_scalar(self.evaluate(&args[0])?);
        let lookup_values = flatten_owned(self.evaluate(&args[1])?);
        let return_values = flatten_owned(self.evaluate(&args[2])?);
        let fallback = args
            .get(3)
            .map(|arg| self.evaluate(arg))
            .transpose()?
            .map(first_scalar)
            .unwrap_or(Value::Error("#N/D".into()));
        let index = lookup_values
            .iter()
            .position(|value| compare_values(value, &lookup) == 0);
        Ok(index
            .and_then(|index| return_values.get(index).cloned())
            .unwrap_or(fallback))
    }

    fn index_function(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.is_empty() || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let matrix = to_matrix(self.evaluate(&args[0])?);
        let row = args
            .get(1)
            .map(|arg| self.evaluate(arg))
            .transpose()?
            .map(first_scalar)
            .map(|value| to_number(&value))
            .transpose()?
            .unwrap_or(1.0)
            .trunc() as isize
            - 1;
        let column = args
            .get(2)
            .map(|arg| self.evaluate(arg))
            .transpose()?
            .map(first_scalar)
            .map(|value| to_number(&value))
            .transpose()?
            .unwrap_or(1.0)
            .trunc() as isize
            - 1;
        if row < 0 || column < 0 {
            return Ok(Value::Error("#REF!".into()));
        }
        Ok(matrix
            .get(row as usize)
            .and_then(|values| values.get(column as usize))
            .cloned()
            .unwrap_or(Value::Error("#REF!".into())))
    }

    fn match_function(&self, args: &[Ast]) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup = first_scalar(self.evaluate(&args[0])?);
        let values = flatten_owned(self.evaluate(&args[1])?);
        let match_type = args
            .get(2)
            .map(|arg| self.evaluate(arg))
            .transpose()?
            .map(first_scalar)
            .map(|value| to_number(&value))
            .transpose()?
            .unwrap_or(1.0)
            .trunc() as i32;
        let index = if match_type == 0 {
            values
                .iter()
                .position(|value| compare_values(value, &lookup) == 0)
        } else {
            let mut candidate = None;
            if match_type > 0 {
                for (index, value) in values.iter().enumerate() {
                    if compare_values(value, &lookup) <= 0 {
                        candidate = Some(index);
                    } else {
                        break;
                    }
                }
            } else {
                for (index, value) in values.iter().enumerate() {
                    if compare_values(value, &lookup) >= 0 {
                        candidate = Some(index);
                    } else {
                        break;
                    }
                }
            }
            candidate
        };
        Ok(index
            .map(|index| Value::Number((index + 1) as f64))
            .unwrap_or(Value::Error("#N/D".into())))
    }

    fn aggregate(&self, args: &[Ast], mode: Aggregate) -> Result<Value, EngineError> {
        let mut values = Vec::new();
        for arg in args {
            let value = self.evaluate(arg)?;
            if let Some(error) = value.first_error() {
                return Ok(error);
            }
            value.flatten(&mut values);
        }
        let numbers: Vec<f64> = values
            .into_iter()
            .filter_map(|value| match value {
                Value::Number(number) if number.is_finite() => Some(number),
                _ => None,
            })
            .collect();
        match mode {
            Aggregate::Sum => Ok(Value::Number(numbers.iter().sum())),
            Aggregate::Average => {
                if numbers.is_empty() {
                    Ok(Value::Error("#DIV/0!".into()))
                } else {
                    Ok(Value::Number(
                        numbers.iter().sum::<f64>() / numbers.len() as f64,
                    ))
                }
            }
            Aggregate::Min => numbers
                .into_iter()
                .reduce(f64::min)
                .map(Value::Number)
                .ok_or_else(|| EngineError::syntax("MÍNIMO não recebeu números.")),
            Aggregate::Max => numbers
                .into_iter()
                .reduce(f64::max)
                .map(Value::Number)
                .ok_or_else(|| EngineError::syntax("MÁXIMO não recebeu números.")),
            Aggregate::Count => Ok(Value::Number(numbers.len() as f64)),
        }
    }
}

#[derive(Copy, Clone)]
enum Aggregate {
    Sum,
    Average,
    Min,
    Max,
    Count,
}


#[derive(Copy, Clone)]
enum ConditionalAggregate {
    Sum,
    Average,
}

fn first_scalar(value: Value) -> Value {
    match value {
        Value::Array(rows) => rows
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .unwrap_or(Value::Blank),
        value => value,
    }
}

fn flatten_owned(value: Value) -> Vec<Value> {
    let mut output = Vec::new();
    value.flatten(&mut output);
    output
}

fn to_matrix(value: Value) -> Vec<Vec<Value>> {
    match value {
        Value::Array(rows) => rows,
        value => vec![vec![value]],
    }
}

fn criterion_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) if value.is_finite() => Some(*value),
        Value::Text(value) => {
            let raw = value.trim();
            if raw.is_empty() {
                return Some(0.0);
            }
            let normalized = raw.replace('.', "").replace(',', ".");
            normalized.parse::<f64>().ok().filter(|value| value.is_finite())
        }
        _ => None,
    }
}

fn values_equal_strict(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Blank, Value::Blank) => true,
        (Value::Number(left), Value::Number(right)) => left == right,
        (Value::Boolean(left), Value::Boolean(right)) => left == right,
        (Value::Text(left), Value::Text(right)) => left == right,
        (Value::Error(left), Value::Error(right)) => left == right,
        _ => false,
    }
}

#[derive(Clone, Copy)]
enum WildcardToken {
    AnyMany,
    AnyOne,
    Literal(char),
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let mut tokens = Vec::new();
    let mut escaped = false;
    for character in pattern.to_lowercase().chars() {
        if escaped {
            tokens.push(WildcardToken::Literal(character));
            escaped = false;
            continue;
        }
        match character {
            '~' => escaped = true,
            '*' => tokens.push(WildcardToken::AnyMany),
            '?' => tokens.push(WildcardToken::AnyOne),
            other => tokens.push(WildcardToken::Literal(other)),
        }
    }
    if escaped {
        tokens.push(WildcardToken::Literal('~'));
    }

    let characters: Vec<char> = value.to_lowercase().chars().collect();
    let mut previous = vec![false; characters.len() + 1];
    previous[0] = true;
    for token in tokens {
        let mut current = vec![false; characters.len() + 1];
        match token {
            WildcardToken::AnyMany => {
                current[0] = previous[0];
                for index in 1..=characters.len() {
                    current[index] = previous[index] || current[index - 1];
                }
            }
            WildcardToken::AnyOne => {
                for index in 1..=characters.len() {
                    current[index] = previous[index - 1];
                }
            }
            WildcardToken::Literal(expected) => {
                for index in 1..=characters.len() {
                    current[index] = previous[index - 1] && characters[index - 1] == expected;
                }
            }
        }
        previous = current;
    }
    previous[characters.len()]
}

fn matches_criterion(value: &Value, criterion: &Value) -> bool {
    let Value::Text(raw_criterion) = criterion else {
        return values_equal_strict(value, criterion);
    };
    let operators = ["<=", ">=", "<>", "=", "<", ">"];
    let (operator, expected) = operators
        .iter()
        .find_map(|operator| {
            raw_criterion
                .strip_prefix(operator)
                .map(|expected| (*operator, expected))
        })
        .unwrap_or(("=", raw_criterion.as_str()));

    if operator == "=" && (expected.contains('*') || expected.contains('?')) {
        return wildcard_matches(expected, &value_as_text(value));
    }

    let left_number = criterion_number(value);
    let right_number = criterion_number(&Value::Text(expected.to_string()));
    let comparison = match (left_number, right_number) {
        (Some(left), Some(right)) => left.partial_cmp(&right),
        _ => value_as_text(value)
            .to_lowercase()
            .partial_cmp(&expected.to_lowercase()),
    };
    let Some(comparison) = comparison else {
        return false;
    };
    match operator {
        "<>" => comparison != std::cmp::Ordering::Equal,
        "<" => comparison == std::cmp::Ordering::Less,
        ">" => comparison == std::cmp::Ordering::Greater,
        "<=" => comparison != std::cmp::Ordering::Greater,
        ">=" => comparison != std::cmp::Ordering::Less,
        _ => comparison == std::cmp::Ordering::Equal,
    }
}

fn conditional_aggregate_values(
    values: Value,
    criteria: Vec<(Value, Value)>,
    mode: ConditionalAggregate,
) -> Result<Value, EngineError> {
    let values = flatten_owned(values);
    let mut criteria_ranges = Vec::new();
    let mut criteria_values = Vec::new();
    for (range, criterion) in criteria {
        let range = flatten_owned(range);
        if range.len() != values.len() {
            return Ok(Value::Error("#VALOR!".into()));
        }
        criteria_ranges.push(range);
        criteria_values.push(first_scalar(criterion));
    }
    let accepted: Vec<Value> = values
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| {
            criteria_ranges
                .iter()
                .zip(criteria_values.iter())
                .all(|(range, criterion)| matches_criterion(&range[index], criterion))
                .then_some(value)
        })
        .collect();
    if let Some(error) = accepted.iter().find_map(Value::first_error) {
        return Ok(error);
    }
    let numbers: Vec<f64> = accepted
        .into_iter()
        .filter_map(|value| match value {
            Value::Number(value) if value.is_finite() => Some(value),
            _ => None,
        })
        .collect();
    match mode {
        ConditionalAggregate::Sum => Ok(Value::Number(numbers.iter().sum())),
        ConditionalAggregate::Average if numbers.is_empty() => {
            Ok(Value::Error("#DIV/0!".into()))
        }
        ConditionalAggregate::Average => Ok(Value::Number(
            numbers.iter().sum::<f64>() / numbers.len() as f64,
        )),
    }
}

fn to_number(value: &Value) -> Result<f64, EngineError> {
    match value {
        Value::Blank => Ok(0.0),
        Value::Number(value) if value.is_finite() => Ok(*value),
        Value::Boolean(value) => Ok(if *value { 1.0 } else { 0.0 }),
        Value::Text(value) => {
            let normalized = value.trim().replace('.', "").replacen(',', ".", 1);
            normalized.parse::<f64>().map_err(|_| EngineError {
                code: "#VALOR!",
                message: "Texto não pode ser convertido em número.".into(),
                unsupported: false,
            })
        }
        Value::Error(value) => Err(EngineError {
            code: "#ERRO!",
            message: value.clone(),
            unsupported: false,
        }),
        Value::Array(_) => Err(EngineError {
            code: "#VALOR!",
            message: "Matriz não pode ser usada como escalar.".into(),
            unsupported: false,
        }),
        _ => Err(EngineError {
            code: "#NUM!",
            message: "Número inválido.".into(),
            unsupported: false,
        }),
    }
}

fn truthy(value: &Value) -> Result<bool, EngineError> {
    match value {
        Value::Blank => Ok(false),
        Value::Boolean(value) => Ok(*value),
        Value::Number(value) => Ok(*value != 0.0),
        Value::Text(value) => Ok(!value.is_empty()),
        Value::Error(value) => Err(EngineError {
            code: "#ERRO!",
            message: value.clone(),
            unsupported: false,
        }),
        Value::Array(rows) => rows
            .first()
            .and_then(|row| row.first())
            .map(truthy)
            .unwrap_or(Ok(false)),
    }
}

fn compare_values(left: &Value, right: &Value) -> i8 {
    match (left, right) {
        (Value::Blank, Value::Blank) => 0,
        (Value::Blank, _) => 1,
        (_, Value::Blank) => -1,
        (Value::Number(left), Value::Number(right)) => match left.partial_cmp(right) {
            Some(std::cmp::Ordering::Less) => -1,
            Some(std::cmp::Ordering::Greater) => 1,
            _ => 0,
        },
        _ => {
            let left = value_as_text(left).to_lowercase();
            let right = value_as_text(right).to_lowercase();
            if left < right {
                -1
            } else if left > right {
                1
            } else {
                0
            }
        }
    }
}

fn value_as_text(value: &Value) -> String {
    match value {
        Value::Blank => String::new(),
        Value::Number(value) => value.to_string(),
        Value::Boolean(value) => {
            if *value {
                "VERDADEIRO".into()
            } else {
                "FALSO".into()
            }
        }
        Value::Text(value) | Value::Error(value) => value.clone(),
        Value::Array(_) => "[matriz]".into(),
    }
}

fn scalar_binary(operator: &str, left: Value, right: Value) -> Result<Value, EngineError> {
    if let Value::Error(_) = left {
        return Ok(left);
    }
    if let Value::Error(_) = right {
        return Ok(right);
    }
    if matches!(operator, "=" | "<>" | "<" | ">" | "<=" | ">=") {
        let comparison = compare_values(&left, &right);
        let result = match operator {
            "=" => comparison == 0,
            "<>" => comparison != 0,
            "<" => comparison < 0,
            ">" => comparison > 0,
            "<=" => comparison <= 0,
            ">=" => comparison >= 0,
            _ => false,
        };
        return Ok(Value::Boolean(result));
    }
    if operator == "&" {
        return Ok(Value::Text(format!(
            "{}{}",
            value_as_text(&left),
            value_as_text(&right)
        )));
    }
    let left = to_number(&left)?;
    let right = to_number(&right)?;
    match operator {
        "+" => Ok(Value::Number(left + right)),
        "-" => Ok(Value::Number(left - right)),
        "*" => Ok(Value::Number(left * right)),
        "/" if right == 0.0 => Ok(Value::Error("#DIV/0!".into())),
        "/" => Ok(Value::Number(left / right)),
        "^" => {
            let value = left.powf(right);
            if value.is_finite() {
                Ok(Value::Number(value))
            } else {
                Ok(Value::Error("#NUM!".into()))
            }
        }
        _ => Err(EngineError::unsupported(format!(
            "Operador não implementado: {operator}"
        ))),
    }
}

fn broadcast_binary(operator: &str, left: Value, right: Value) -> Result<Value, EngineError> {
    match (left, right) {
        (Value::Array(left), Value::Array(right)) => {
            let height = left.len().max(right.len());
            let width = left
                .first()
                .map(Vec::len)
                .unwrap_or(1)
                .max(right.first().map(Vec::len).unwrap_or(1));
            if !matrix_compatible(&left, height, width) || !matrix_compatible(&right, height, width)
            {
                return Ok(Value::Error("#VALOR!".into()));
            }
            Ok(Value::Array(
                (0..height)
                    .map(|row| {
                        (0..width)
                            .map(|col| {
                                scalar_binary(
                                    operator,
                                    matrix_value(&left, row, col),
                                    matrix_value(&right, row, col),
                                )
                                .unwrap_or_else(|error| Value::Error(error.code.into()))
                            })
                            .collect()
                    })
                    .collect(),
            ))
        }
        (Value::Array(matrix), scalar) => Ok(Value::Array(
            matrix
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|item| {
                            scalar_binary(operator, item, scalar.clone())
                                .unwrap_or_else(|error| Value::Error(error.code.into()))
                        })
                        .collect()
                })
                .collect(),
        )),
        (scalar, Value::Array(matrix)) => Ok(Value::Array(
            matrix
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|item| {
                            scalar_binary(operator, scalar.clone(), item)
                                .unwrap_or_else(|error| Value::Error(error.code.into()))
                        })
                        .collect()
                })
                .collect(),
        )),
        (left, right) => scalar_binary(operator, left, right),
    }
}

fn matrix_compatible(matrix: &[Vec<Value>], height: usize, width: usize) -> bool {
    (matrix.len() == 1 || matrix.len() == height)
        && matrix
            .iter()
            .all(|row| row.len() == 1 || row.len() == width)
}

fn matrix_value(matrix: &[Vec<Value>], row: usize, col: usize) -> Value {
    let source_row = if matrix.len() == 1 { 0 } else { row };
    let values = matrix.get(source_row).cloned().unwrap_or_default();
    let source_col = if values.len() == 1 { 0 } else { col };
    values.get(source_col).cloned().unwrap_or(Value::Blank)
}


fn ast_to_ir(ast: &Ast) -> JsonValue {
    match ast {
        Ast::Literal(value) => json!({
            "type": "literal",
            "value": value.to_json(),
        }),
        Ast::Reference(reference) => json!({
            "type": "reference",
            "row": reference.row,
            "col": reference.col,
        }),
        Ast::Range(start, end) => json!({
            "type": "range",
            "start": {"row": start.row, "col": start.col},
            "end": {"row": end.row, "col": end.col},
        }),
        Ast::Unary(operator, value) => json!({
            "type": "unary",
            "operator": operator,
            "value": ast_to_ir(value),
        }),
        Ast::Percent(value) => json!({
            "type": "percent",
            "value": ast_to_ir(value),
        }),
        Ast::Binary(operator, left, right) => json!({
            "type": "binary",
            "operator": operator,
            "left": ast_to_ir(left),
            "right": ast_to_ir(right),
        }),
        Ast::Call(name, args) => json!({
            "type": "call",
            "name": name,
            "args": args.iter().map(ast_to_ir).collect::<Vec<_>>(),
        }),
    }
}

fn compile_formula(formula: &str) -> JsonValue {
    let ast = match Parser::new(formula).and_then(Parser::parse) {
        Ok(ast) => ast,
        Err(error) => {
            return json!({
                "status": if error.unsupported { "unsupported" } else { "error" },
                "ir_version": IR_VERSION,
                "ast": JsonValue::Null,
                "dependencies": [],
                "error": error.message,
            })
        }
    };
    let mut dependencies = BTreeSet::new();
    if let Err(error) = collect_dependencies(&ast, &mut dependencies) {
        return json!({
            "status": if error.unsupported { "unsupported" } else { "error" },
            "ir_version": IR_VERSION,
            "ast": ast_to_ir(&ast),
            "dependencies": dependencies.into_iter().collect::<Vec<_>>(),
            "error": error.message,
        });
    }
    json!({
        "status": "ok",
        "ir_version": IR_VERSION,
        "ast": ast_to_ir(&ast),
        "dependencies": dependencies.into_iter().collect::<Vec<_>>(),
        "error": JsonValue::Null,
    })
}

pub fn validate_operation_json(payload: &str) -> bool {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_str::<JsonValue>(payload) else {
        return false;
    };
    value
        .get("id")
        .and_then(JsonValue::as_str)
        .is_some_and(|value| !value.is_empty())
        && value
            .get("kind")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.is_empty())
}

fn evaluate_request(payload: &str) -> EvaluationResponse {
    let request = match serde_json::from_str::<EvaluationRequest>(payload) {
        Ok(request) => request,
        Err(error) => {
            return EvaluationResponse {
                status: "error",
                value: json!("#VALOR!"),
                value_type: "error",
                dependencies: Vec::new(),
                error: Some(format!("Envelope de avaliação inválido: {error}")),
            }
        }
    };
    let ast = match Parser::new(&request.formula).and_then(Parser::parse) {
        Ok(ast) => ast,
        Err(error) => return response_from_error(error, Vec::new()),
    };
    let mut dependencies = BTreeSet::new();
    if let Err(error) = collect_dependencies(&ast, &mut dependencies) {
        return response_from_error(error, dependencies.into_iter().collect());
    }
    match (Evaluator {
        cells: &request.cells,
    })
    .evaluate(&ast)
    {
        Ok(value) => EvaluationResponse {
            status: "ok",
            value: value.to_json(),
            value_type: value.value_type(),
            dependencies: dependencies.into_iter().collect(),
            error: None,
        },
        Err(error) => response_from_error(error, dependencies.into_iter().collect()),
    }
}

fn response_from_error(error: EngineError, dependencies: Vec<String>) -> EvaluationResponse {
    EvaluationResponse {
        status: if error.unsupported {
            "unsupported"
        } else {
            "error"
        },
        value: json!(error.code),
        value_type: "error",
        dependencies,
        error: Some(error.message),
    }
}

fn write_result(payload: String) -> *mut u8 {
    let bytes = payload.as_bytes();
    LAST_RESULT_LEN.store(bytes.len(), Ordering::Relaxed);
    if bytes.is_empty() {
        return std::ptr::null_mut();
    }
    let pointer = superexcel_alloc(bytes.len());
    if pointer.is_null() {
        return pointer;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
    }
    pointer
}

#[no_mangle]
pub extern "C" fn superexcel_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn superexcel_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_dealloc(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    drop(Vec::from_raw_parts(pointer, 0, len));
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_validate_operation(pointer: *const u8, len: usize) -> u32 {
    if pointer.is_null() || len == 0 || len > MAX_PAYLOAD_BYTES {
        return 0;
    }
    let bytes = slice::from_raw_parts(pointer, len);
    match str::from_utf8(bytes) {
        Ok(payload) if validate_operation_json(payload) => 1,
        _ => 0,
    }
}


#[no_mangle]
pub unsafe extern "C" fn superexcel_compile_formula(pointer: *const u8, len: usize) -> *mut u8 {
    if pointer.is_null() || len == 0 || len > MAX_PAYLOAD_BYTES {
        return write_result(
            json!({
                "status": "error",
                "ir_version": IR_VERSION,
                "ast": JsonValue::Null,
                "dependencies": [],
                "error": "Payload de compilação inválido.",
            })
            .to_string(),
        );
    }
    let bytes = slice::from_raw_parts(pointer, len);
    let response = match str::from_utf8(bytes) {
        Ok(payload) => match serde_json::from_str::<CompileRequest>(payload) {
            Ok(request) => compile_formula(&request.formula),
            Err(error) => json!({
                "status": "error",
                "ir_version": IR_VERSION,
                "ast": JsonValue::Null,
                "dependencies": [],
                "error": format!("Envelope de compilação inválido: {error}"),
            }),
        },
        Err(_) => json!({
            "status": "error",
            "ir_version": IR_VERSION,
            "ast": JsonValue::Null,
            "dependencies": [],
            "error": "Payload não está em UTF-8.",
        }),
    };
    write_result(response.to_string())
}

#[no_mangle]
pub unsafe extern "C" fn superexcel_evaluate_formula(pointer: *const u8, len: usize) -> *mut u8 {
    if pointer.is_null() || len == 0 || len > MAX_PAYLOAD_BYTES {
        return write_result(
            serde_json::to_string(&EvaluationResponse {
                status: "error",
                value: json!("#VALOR!"),
                value_type: "error",
                dependencies: Vec::new(),
                error: Some("Payload de avaliação inválido.".into()),
            })
            .unwrap(),
        );
    }
    let bytes = slice::from_raw_parts(pointer, len);
    let response = match str::from_utf8(bytes) {
        Ok(payload) => evaluate_request(payload),
        Err(_) => EvaluationResponse {
            status: "error",
            value: json!("#VALOR!"),
            value_type: "error",
            dependencies: Vec::new(),
            error: Some("Payload não está em UTF-8.".into()),
        },
    };
    write_result(serde_json::to_string(&response).unwrap())
}

#[no_mangle]
pub extern "C" fn superexcel_last_result_len() -> usize {
    LAST_RESULT_LEN.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluate(formula: &str, cells: JsonValue) -> EvaluationResponse {
        evaluate_request(&json!({ "formula": formula, "cells": cells }).to_string())
    }

    #[test]
    fn abi_is_version_four() {
        assert_eq!(superexcel_abi_version(), 4);
    }

    #[test]
    fn validates_structural_operation_envelope() {
        assert!(validate_operation_json(
            r#"{"id":"op-1","kind":"cells.patch","changes":[]}"#
        ));
        assert!(!validate_operation_json(r#"{"kind":"cells.patch"}"#));
        assert!(!validate_operation_json("not-json"));
    }

    #[test]
    fn evaluates_operator_precedence() {
        let response = evaluate("=1+2*3", json!({}));
        assert_eq!(response.status, "ok");
        assert_eq!(response.value, json!(7.0));
    }

    #[test]
    fn evaluates_references_ranges_and_sum() {
        let response = evaluate(
            "=SOMA(A1:A3)+B1",
            json!({"A1": 2, "A2": 3, "A3": 5, "B1": 10}),
        );
        assert_eq!(response.value, json!(20.0));
        assert_eq!(response.dependencies, vec!["A1", "A2", "A3", "B1"]);
    }

    #[test]
    fn evaluates_lazy_if() {
        let response = evaluate("=SE(A1>10;\"alto\";\"baixo\")", json!({"A1": 12}));
        assert_eq!(response.value, json!("alto"));
    }

    #[test]
    fn evaluates_conditional_business_functions() {
        let response = evaluate(
            "=SOMASES(D1:D4;A1:A4;\"Pago\";B1:B4;\">=10\")",
            json!({
                "A1": "Pago", "A2": "Pendente", "A3": "Pago", "A4": "Pago",
                "B1": 10, "B2": 20, "B3": 8, "B4": 30,
                "D1": 100, "D2": 200, "D3": 300, "D4": 400
            }),
        );
        assert_eq!(response.status, "ok");
        assert_eq!(response.value, json!(500.0));

        let count = evaluate(
            "=CONT.SES(A1:A4;\"Pago\";B1:B4;\">=10\")",
            json!({
                "A1": "Pago", "A2": "Pendente", "A3": "Pago", "A4": "Pago",
                "B1": 10, "B2": 20, "B3": 8, "B4": 30
            }),
        );
        assert_eq!(count.value, json!(2.0));
    }

    #[test]
    fn evaluates_lookup_business_functions() {
        let xlookup = evaluate(
            "=PROCX(\"B\";A1:A3;B1:B3;\"ausente\")",
            json!({"A1": "A", "A2": "B", "A3": "C", "B1": 10, "B2": 20, "B3": 30}),
        );
        assert_eq!(xlookup.value, json!(20.0));

        let index_match = evaluate(
            "=INDICE(B1:B3;CORRESP(\"C\";A1:A3;0))",
            json!({"A1": "A", "A2": "B", "A3": "C", "B1": 10, "B2": 20, "B3": 30}),
        );
        assert_eq!(index_match.value, json!(30.0));
    }

    #[test]
    fn compiles_versioned_intermediate_representation() {
        let compiled = compile_formula("=SOMASES(D1:D4;A1:A4;\"Pago\")");
        assert_eq!(compiled["status"], json!("ok"));
        assert_eq!(compiled["ir_version"], json!(1));
        assert_eq!(compiled["ast"]["type"], json!("call"));
        assert_eq!(compiled["ast"]["name"], json!("SOMASES"));
    }

    #[test]
    fn reports_unsupported_functions_for_javascript_fallback() {
        let response = evaluate("=FILTRO(A1:A2;B1:B2)", json!({}));
        assert_eq!(response.status, "unsupported");
    }

    #[test]
    fn cell_contract_supports_formulas() {
        let patch = CellPatch {
            coordinate: CellCoordinate { row: 2, col: 3 },
            value: CellValue::Formula("=A1+1".to_string()),
        };
        assert_eq!(patch.coordinate.row, 2);
    }
}
