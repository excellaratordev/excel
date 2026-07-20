use super::{FormulaNode, Workbook};
use crate::{
    cell_name, compare_values, matches_criterion, scalar_binary, to_number, truthy, Ast,
    CellRange, CellReference, EngineError, Value, MAX_RANGE_CELLS,
};
use std::collections::HashSet;

#[derive(Debug, Clone)]
enum WorkbookEvalValue {
    Scalar(Value),
    Range(CellRange),
}

impl WorkbookEvalValue {
    fn len(&self) -> usize {
        match self {
            Self::Scalar(_) => 1,
            Self::Range(range) => range.cell_count(),
        }
    }

    fn dimensions(&self) -> (usize, usize) {
        match self {
            Self::Scalar(_) => (1, 1),
            Self::Range(range) => (
                range.bottom - range.top + 1,
                range.right - range.left + 1,
            ),
        }
    }
}

#[derive(Copy, Clone)]
enum SparseAggregate {
    Sum,
    Average,
    Min,
    Max,
    Count,
}

#[derive(Copy, Clone)]
enum SparseConditionalAggregate {
    Sum,
    Average,
}

#[derive(Default)]
struct NumericAccumulator {
    sum: f64,
    count: usize,
    min: Option<f64>,
    max: Option<f64>,
}

impl NumericAccumulator {
    fn accept(&mut self, value: Value) -> Option<Value> {
        match value {
            Value::Error(_) => Some(value),
            Value::Number(number) if number.is_finite() => {
                self.sum += number;
                self.count += 1;
                self.min = Some(self.min.map_or(number, |current| current.min(number)));
                self.max = Some(self.max.map_or(number, |current| current.max(number)));
                None
            }
            _ => None,
        }
    }

    fn finish(self, mode: SparseAggregate) -> Result<Value, EngineError> {
        match mode {
            SparseAggregate::Sum => Ok(Value::Number(self.sum)),
            SparseAggregate::Average if self.count == 0 => {
                Ok(Value::Error("#DIV/0!".into()))
            }
            SparseAggregate::Average => {
                Ok(Value::Number(self.sum / self.count as f64))
            }
            SparseAggregate::Min => self
                .min
                .map(Value::Number)
                .ok_or_else(|| EngineError::syntax("MÍNIMO não recebeu números.")),
            SparseAggregate::Max => self
                .max
                .map(Value::Number)
                .ok_or_else(|| EngineError::syntax("MÁXIMO não recebeu números.")),
            SparseAggregate::Count => Ok(Value::Number(self.count as f64)),
        }
    }
}

impl Workbook {
    pub(super) fn should_use_sparse(&self, node: &FormulaNode) -> bool {
        node.range_dependencies
            .iter()
            .any(|range| range.cell_count() > MAX_RANGE_CELLS)
    }

    pub(super) fn evaluate_sparse_formula(
        &mut self,
        ast: &Ast,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        match self.evaluate_sparse_ast(ast, stack)? {
            WorkbookEvalValue::Scalar(value) => Ok(value),
            WorkbookEvalValue::Range(_) => Err(EngineError::unsupported(
                "Resultado matricial esparso ainda não é autoritativo no workbook Rust.",
            )),
        }
    }

    fn evaluate_sparse_ast(
        &mut self,
        ast: &Ast,
        stack: &mut HashSet<String>,
    ) -> Result<WorkbookEvalValue, EngineError> {
        match ast {
            Ast::Literal(value) => Ok(WorkbookEvalValue::Scalar(value.clone())),
            Ast::Reference(reference) => {
                let value = self.evaluate_cell_inner(&cell_name(reference), stack)?;
                Ok(WorkbookEvalValue::Scalar(value))
            }
            Ast::Range(start, end) => Ok(WorkbookEvalValue::Range(
                CellRange::from_references(start, end),
            )),
            Ast::Unary(operator, value) => {
                let evaluated = self.evaluate_sparse_ast(value, stack)?;
                let value = self.require_sparse_scalar(evaluated)?;
                let number = to_number(&value)?;
                Ok(WorkbookEvalValue::Scalar(Value::Number(
                    if operator == "-" { -number } else { number },
                )))
            }
            Ast::Percent(value) => {
                let evaluated = self.evaluate_sparse_ast(value, stack)?;
                let value = self.require_sparse_scalar(evaluated)?;
                Ok(WorkbookEvalValue::Scalar(Value::Number(
                    to_number(&value)? / 100.0,
                )))
            }
            Ast::Binary(operator, left, right) => {
                let left = self.evaluate_sparse_ast(left, stack)?;
                let right = self.evaluate_sparse_ast(right, stack)?;
                let left = self.require_sparse_scalar(left)?;
                let right = self.require_sparse_scalar(right)?;
                Ok(WorkbookEvalValue::Scalar(scalar_binary(
                    operator, left, right,
                )?))
            }
            Ast::Call(name, args) => self.evaluate_sparse_call(name, args, stack),
        }
    }

    fn require_sparse_scalar(
        &self,
        value: WorkbookEvalValue,
    ) -> Result<Value, EngineError> {
        match value {
            WorkbookEvalValue::Scalar(value) => Ok(value),
            WorkbookEvalValue::Range(_) => Err(EngineError::unsupported(
                "Operações matriciais em ranges grandes ainda usam fallback JavaScript.",
            )),
        }
    }

    fn sparse_first_scalar(
        &mut self,
        value: &WorkbookEvalValue,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        self.sparse_value_at(value, 0, stack)
    }

    fn sparse_value_at(
        &mut self,
        value: &WorkbookEvalValue,
        index: usize,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        match value {
            WorkbookEvalValue::Scalar(value) => {
                Ok(if index == 0 { value.clone() } else { Value::Blank })
            }
            WorkbookEvalValue::Range(range) => {
                if index >= range.cell_count() {
                    return Ok(Value::Blank);
                }
                let width = range.right - range.left + 1;
                let row = range.top + index / width;
                let col = range.left + index % width;
                self.streamed_range_positions = self.streamed_range_positions.saturating_add(1);
                self.sparse_value_at_coordinate(row, col, stack)
            }
        }
    }

    fn sparse_value_at_position(
        &mut self,
        value: &WorkbookEvalValue,
        row: usize,
        col: usize,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        match value {
            WorkbookEvalValue::Scalar(value) => Ok(if row == 0 && col == 0 {
                value.clone()
            } else {
                Value::Blank
            }),
            WorkbookEvalValue::Range(range) => {
                let (height, width) = value.dimensions();
                if row >= height || col >= width {
                    return Ok(Value::Blank);
                }
                self.streamed_range_positions = self.streamed_range_positions.saturating_add(1);
                self.sparse_value_at_coordinate(range.top + row, range.left + col, stack)
            }
        }
    }

    fn sparse_value_at_coordinate(
        &mut self,
        row: usize,
        col: usize,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        let key = self.occupied_cells.get(&(row, col)).cloned();
        let Some(key) = key else {
            return Ok(Value::Blank);
        };
        self.sparse_cells_resolved = self.sparse_cells_resolved.saturating_add(1);
        self.evaluate_cell_inner(&key, stack)
    }

    fn occupied_keys_in_range(&self, range: &CellRange) -> Vec<String> {
        self.occupied_cells
            .range((range.top, 0)..=(range.bottom, usize::MAX))
            .filter(|((_, col), _)| (range.left..=range.right).contains(col))
            .map(|(_, key)| key.clone())
            .collect()
    }

    fn evaluate_sparse_call(
        &mut self,
        name: &str,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<WorkbookEvalValue, EngineError> {
        let value = match name {
            "SE" | "IF" => {
                let condition = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("SE exige uma condição."))?;
                let evaluated = self.evaluate_sparse_ast(condition, stack)?;
                let condition = self.sparse_first_scalar(&evaluated, stack)?;
                if let Some(error) = condition.first_error() {
                    return Ok(WorkbookEvalValue::Scalar(error));
                }
                if truthy(&condition)? {
                    args.get(1)
                        .map(|value| self.evaluate_sparse_ast(value, stack))
                        .unwrap_or(Ok(WorkbookEvalValue::Scalar(Value::Boolean(true))))?
                } else {
                    args.get(2)
                        .map(|value| self.evaluate_sparse_ast(value, stack))
                        .unwrap_or(Ok(WorkbookEvalValue::Scalar(Value::Boolean(false))))?
                }
            }
            "E" | "AND" => {
                for arg in args {
                    let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                    let value = self.sparse_first_scalar(&evaluated, stack)?;
                    if let Some(error) = value.first_error() {
                        return Ok(WorkbookEvalValue::Scalar(error));
                    }
                    if !truthy(&value)? {
                        return Ok(WorkbookEvalValue::Scalar(Value::Boolean(false)));
                    }
                }
                WorkbookEvalValue::Scalar(Value::Boolean(true))
            }
            "OU" | "OR" => {
                for arg in args {
                    let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                    let value = self.sparse_first_scalar(&evaluated, stack)?;
                    if let Some(error) = value.first_error() {
                        return Ok(WorkbookEvalValue::Scalar(error));
                    }
                    if truthy(&value)? {
                        return Ok(WorkbookEvalValue::Scalar(Value::Boolean(true)));
                    }
                }
                WorkbookEvalValue::Scalar(Value::Boolean(false))
            }
            "NAO" | "NÃO" | "NOT" => {
                let arg = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("NÃO exige um argumento."))?;
                let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                let value = self.sparse_first_scalar(&evaluated, stack)?;
                WorkbookEvalValue::Scalar(Value::Boolean(!truthy(&value)?))
            }
            "SEERRO" | "IFERROR" => {
                let arg = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("SEERRO exige um valor."))?;
                let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                match evaluated {
                    WorkbookEvalValue::Scalar(value) if value.first_error().is_some() => args
                        .get(1)
                        .map(|fallback| self.evaluate_sparse_ast(fallback, stack))
                        .unwrap_or(Ok(WorkbookEvalValue::Scalar(Value::Blank)))?,
                    value => value,
                }
            }
            "SOMA" | "SUM" => WorkbookEvalValue::Scalar(
                self.sparse_aggregate(args, SparseAggregate::Sum, stack)?,
            ),
            "MEDIA" | "MÉDIA" | "AVERAGE" => WorkbookEvalValue::Scalar(
                self.sparse_aggregate(args, SparseAggregate::Average, stack)?,
            ),
            "MINIMO" | "MÍNIMO" | "MIN" => WorkbookEvalValue::Scalar(
                self.sparse_aggregate(args, SparseAggregate::Min, stack)?,
            ),
            "MAXIMO" | "MÁXIMO" | "MAX" => WorkbookEvalValue::Scalar(
                self.sparse_aggregate(args, SparseAggregate::Max, stack)?,
            ),
            "CONTNUM" | "COUNT" => WorkbookEvalValue::Scalar(
                self.sparse_aggregate(args, SparseAggregate::Count, stack)?,
            ),
            "CONTSE" | "COUNTIF" | "CONTSES" | "COUNTIFS" => {
                WorkbookEvalValue::Scalar(self.sparse_count_ifs(args, stack)?)
            }
            "SOMASE" | "SUMIF" => {
                WorkbookEvalValue::Scalar(self.sparse_sum_if(args, stack)?)
            }
            "SOMASES" | "SUMIFS" => WorkbookEvalValue::Scalar(
                self.sparse_conditional_aggregate(
                    args,
                    SparseConditionalAggregate::Sum,
                    stack,
                )?,
            ),
            "MEDIASE" | "AVERAGEIF" => {
                WorkbookEvalValue::Scalar(self.sparse_average_if(args, stack)?)
            }
            "MEDIASES" | "AVERAGEIFS" => WorkbookEvalValue::Scalar(
                self.sparse_conditional_aggregate(
                    args,
                    SparseConditionalAggregate::Average,
                    stack,
                )?,
            ),
            "PROCV" | "VLOOKUP" => {
                WorkbookEvalValue::Scalar(self.sparse_vlookup(args, stack)?)
            }
            "PROCX" | "XLOOKUP" => {
                WorkbookEvalValue::Scalar(self.sparse_xlookup(args, stack)?)
            }
            "INDICE" | "INDEX" => {
                WorkbookEvalValue::Scalar(self.sparse_index(args, stack)?)
            }
            "CORRESP" | "MATCH" => {
                WorkbookEvalValue::Scalar(self.sparse_match(args, stack)?)
            }
            "ABS" => {
                let arg = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("ABS exige um argumento."))?;
                let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                let value = self.require_sparse_scalar(evaluated)?;
                WorkbookEvalValue::Scalar(Value::Number(to_number(&value)?.abs()))
            }
            "ARRED" | "ROUND" => {
                let arg = args
                    .first()
                    .ok_or_else(|| EngineError::syntax("ARRED exige um valor."))?;
                let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                let value = self.require_sparse_scalar(evaluated)?;
                let digits = if let Some(arg) = args.get(1) {
                    let evaluated = self.evaluate_sparse_ast(arg, stack)?;
                    let value = self.sparse_first_scalar(&evaluated, stack)?;
                    to_number(&value)?.trunc().clamp(-15.0, 15.0) as i32
                } else {
                    0
                };
                let factor = 10_f64.powi(digits.abs());
                let number = to_number(&value)?;
                let rounded = if digits >= 0 {
                    (number * factor).round() / factor
                } else {
                    (number / factor).round() * factor
                };
                WorkbookEvalValue::Scalar(Value::Number(rounded))
            }
            _ => {
                return Err(EngineError::unsupported(format!(
                    "Função ainda não implementada no avaliador esparso Rust/Wasm: {name}"
                )))
            }
        };
        Ok(value)
    }

    fn sparse_aggregate(
        &mut self,
        args: &[Ast],
        mode: SparseAggregate,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        let mut accumulator = NumericAccumulator::default();
        for arg in args {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            match evaluated {
                WorkbookEvalValue::Scalar(value) => {
                    if let Some(error) = accumulator.accept(value) {
                        return Ok(error);
                    }
                }
                WorkbookEvalValue::Range(range) => {
                    self.sparse_range_evaluations =
                        self.sparse_range_evaluations.saturating_add(1);
                    let keys = self.occupied_keys_in_range(&range);
                    self.range_positions_avoided = self.range_positions_avoided.saturating_add(
                        range.cell_count().saturating_sub(keys.len()) as u64,
                    );
                    self.sparse_cells_resolved =
                        self.sparse_cells_resolved.saturating_add(keys.len() as u64);
                    for key in keys {
                        let value = self.evaluate_cell_inner(&key, stack)?;
                        if let Some(error) = accumulator.accept(value) {
                            return Ok(error);
                        }
                    }
                }
            }
        }
        accumulator.finish(mode)
    }

    fn sparse_count_ifs(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.is_empty() || args.len() % 2 != 0 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let mut ranges = Vec::new();
        let mut criteria = Vec::new();
        let mut expected_len = None;
        for pair in args.chunks_exact(2) {
            let range = self.evaluate_sparse_ast(&pair[0], stack)?;
            let criterion = self.evaluate_sparse_ast(&pair[1], stack)?;
            let criterion = self.sparse_first_scalar(&criterion, stack)?;
            if let Some(length) = expected_len {
                if range.len() != length {
                    return Ok(Value::Error("#VALOR!".into()));
                }
            } else {
                expected_len = Some(range.len());
            }
            ranges.push(range);
            criteria.push(criterion);
        }
        let mut count = 0usize;
        for index in 0..expected_len.unwrap_or(0) {
            let mut accepted = true;
            for (range, criterion) in ranges.iter().zip(criteria.iter()) {
                let value = self.sparse_value_at(range, index, stack)?;
                if !matches_criterion(&value, criterion) {
                    accepted = false;
                    break;
                }
            }
            if accepted {
                count += 1;
            }
        }
        Ok(Value::Number(count as f64))
    }

    fn sparse_sum_if(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let criteria_range = self.evaluate_sparse_ast(&args[0], stack)?;
        let criterion_value = self.evaluate_sparse_ast(&args[1], stack)?;
        let criterion = self.sparse_first_scalar(&criterion_value, stack)?;
        let sum_range = if let Some(range) = args.get(2) {
            self.evaluate_sparse_ast(range, stack)?
        } else {
            criteria_range.clone()
        };
        self.sparse_conditional_values(
            sum_range,
            vec![(criteria_range, criterion)],
            SparseConditionalAggregate::Sum,
            stack,
        )
    }

    fn sparse_average_if(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let criteria_range = self.evaluate_sparse_ast(&args[0], stack)?;
        let criterion_value = self.evaluate_sparse_ast(&args[1], stack)?;
        let criterion = self.sparse_first_scalar(&criterion_value, stack)?;
        let average_range = if let Some(range) = args.get(2) {
            self.evaluate_sparse_ast(range, stack)?
        } else {
            criteria_range.clone()
        };
        self.sparse_conditional_values(
            average_range,
            vec![(criteria_range, criterion)],
            SparseConditionalAggregate::Average,
            stack,
        )
    }

    fn sparse_conditional_aggregate(
        &mut self,
        args: &[Ast],
        mode: SparseConditionalAggregate,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() % 2 == 0 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let values = self.evaluate_sparse_ast(&args[0], stack)?;
        let mut criteria = Vec::new();
        for pair in args[1..].chunks_exact(2) {
            let range = self.evaluate_sparse_ast(&pair[0], stack)?;
            let criterion_value = self.evaluate_sparse_ast(&pair[1], stack)?;
            let criterion = self.sparse_first_scalar(&criterion_value, stack)?;
            criteria.push((range, criterion));
        }
        self.sparse_conditional_values(values, criteria, mode, stack)
    }

    fn sparse_conditional_values(
        &mut self,
        values: WorkbookEvalValue,
        criteria: Vec<(WorkbookEvalValue, Value)>,
        mode: SparseConditionalAggregate,
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        let length = values.len();
        if criteria.iter().any(|(range, _)| range.len() != length) {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let mut sum = 0.0;
        let mut count = 0usize;
        for index in 0..length {
            let mut accepted = true;
            for (range, criterion) in &criteria {
                let value = self.sparse_value_at(range, index, stack)?;
                if !matches_criterion(&value, criterion) {
                    accepted = false;
                    break;
                }
            }
            if !accepted {
                continue;
            }
            match self.sparse_value_at(&values, index, stack)? {
                Value::Error(value) => return Ok(Value::Error(value)),
                Value::Number(value) if value.is_finite() => {
                    sum += value;
                    count += 1;
                }
                _ => {}
            }
        }
        match mode {
            SparseConditionalAggregate::Sum => Ok(Value::Number(sum)),
            SparseConditionalAggregate::Average if count == 0 => {
                Ok(Value::Error("#DIV/0!".into()))
            }
            SparseConditionalAggregate::Average => Ok(Value::Number(sum / count as f64)),
        }
    }

    fn sparse_vlookup(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() > 4 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup_value = self.evaluate_sparse_ast(&args[0], stack)?;
        let lookup = self.sparse_first_scalar(&lookup_value, stack)?;
        let table = self.evaluate_sparse_ast(&args[1], stack)?;
        let column_value = self.evaluate_sparse_ast(&args[2], stack)?;
        let column = to_number(&self.sparse_first_scalar(&column_value, stack)?)?.trunc()
            as isize
            - 1;
        let (rows, columns) = table.dimensions();
        if column < 0 || column as usize >= columns {
            return Ok(Value::Error("#REF!".into()));
        }
        let approximate = if let Some(arg) = args.get(3) {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            truthy(&self.sparse_first_scalar(&evaluated, stack)?)?
        } else {
            true
        };
        let mut selected = None;
        for row in 0..rows {
            let value = self.sparse_value_at_position(&table, row, 0, stack)?;
            let comparison = compare_values(&value, &lookup);
            if approximate {
                if comparison <= 0 {
                    selected = Some(row);
                } else {
                    break;
                }
            } else if comparison == 0 {
                selected = Some(row);
                break;
            }
        }
        match selected {
            Some(row) => self.sparse_value_at_position(&table, row, column as usize, stack),
            None => Ok(Value::Error("#N/D".into())),
        }
    }

    fn sparse_xlookup(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 3 || args.len() > 4 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup_value = self.evaluate_sparse_ast(&args[0], stack)?;
        let lookup = self.sparse_first_scalar(&lookup_value, stack)?;
        let lookup_values = self.evaluate_sparse_ast(&args[1], stack)?;
        let return_values = self.evaluate_sparse_ast(&args[2], stack)?;
        if lookup_values.len() != return_values.len() {
            return Ok(Value::Error("#VALOR!".into()));
        }
        for index in 0..lookup_values.len() {
            let value = self.sparse_value_at(&lookup_values, index, stack)?;
            if compare_values(&value, &lookup) == 0 {
                return self.sparse_value_at(&return_values, index, stack);
            }
        }
        if let Some(arg) = args.get(3) {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            self.sparse_first_scalar(&evaluated, stack)
        } else {
            Ok(Value::Error("#N/D".into()))
        }
    }

    fn sparse_index(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.is_empty() || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let matrix = self.evaluate_sparse_ast(&args[0], stack)?;
        let row = if let Some(arg) = args.get(1) {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            to_number(&self.sparse_first_scalar(&evaluated, stack)?)?.trunc() as isize - 1
        } else {
            0
        };
        let column = if let Some(arg) = args.get(2) {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            to_number(&self.sparse_first_scalar(&evaluated, stack)?)?.trunc() as isize - 1
        } else {
            0
        };
        if row < 0 || column < 0 {
            return Ok(Value::Error("#REF!".into()));
        }
        let (rows, columns) = matrix.dimensions();
        if row as usize >= rows || column as usize >= columns {
            return Ok(Value::Error("#REF!".into()));
        }
        self.sparse_value_at_position(&matrix, row as usize, column as usize, stack)
    }

    fn sparse_match(
        &mut self,
        args: &[Ast],
        stack: &mut HashSet<String>,
    ) -> Result<Value, EngineError> {
        if args.len() < 2 || args.len() > 3 {
            return Ok(Value::Error("#VALOR!".into()));
        }
        let lookup_value = self.evaluate_sparse_ast(&args[0], stack)?;
        let lookup = self.sparse_first_scalar(&lookup_value, stack)?;
        let values = self.evaluate_sparse_ast(&args[1], stack)?;
        let match_type = if let Some(arg) = args.get(2) {
            let evaluated = self.evaluate_sparse_ast(arg, stack)?;
            to_number(&self.sparse_first_scalar(&evaluated, stack)?)?.trunc() as i32
        } else {
            1
        };
        let mut candidate = None;
        for index in 0..values.len() {
            let value = self.sparse_value_at(&values, index, stack)?;
            let comparison = compare_values(&value, &lookup);
            if match_type == 0 {
                if comparison == 0 {
                    candidate = Some(index);
                    break;
                }
            } else if match_type > 0 {
                if comparison <= 0 {
                    candidate = Some(index);
                } else {
                    break;
                }
            } else if comparison >= 0 {
                candidate = Some(index);
            } else {
                break;
            }
        }
        Ok(candidate
            .map(|index| Value::Number((index + 1) as f64))
            .unwrap_or(Value::Error("#N/D".into())))
    }
}
