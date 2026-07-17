from __future__ import annotations

import json
from datetime import date, datetime
from types import ModuleType
from typing import Any

MAX_CELL_BYTES = 256 * 1024


def formula_like(_: Any) -> bool:
    """Formula-like values are allowed in every Base column."""
    return False


def normalize_typed_value(value: Any, data_type: str) -> Any:
    if value is None or value == "":
        return None
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_CELL_BYTES:
        raise ValueError("O valor da célula excede 256 KB.")

    # Expressions are deliberately stored verbatim regardless of the declared
    # relational type. Evaluation and dependency resolution are separate layers.
    if isinstance(value, str) and value.lstrip().startswith("="):
        return value

    if data_type == "text":
        return str(value)
    if data_type == "number":
        if isinstance(value, bool):
            raise ValueError("Valor numérico inválido.")
        number = float(str(value).replace(",", "."))
        return int(number) if number.is_integer() else number
    if data_type == "boolean":
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {"true", "1", "sim", "verdadeiro"}:
            return True
        if normalized in {"false", "0", "nao", "não", "falso"}:
            return False
        raise ValueError("Valor booleano inválido.")
    if data_type == "date":
        return date.fromisoformat(str(value)[:10]).isoformat()
    if data_type == "datetime":
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    if data_type == "json":
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError as error:
                raise ValueError("JSON inválido.") from error
        json.dumps(value, ensure_ascii=False, allow_nan=False)
        return value
    raise ValueError("Tipo de coluna inválido.")


def install(base_routes: ModuleType) -> None:
    base_routes.formula_like = formula_like
    base_routes.normalize_typed_value = normalize_typed_value
