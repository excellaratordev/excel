from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

DEFAULT_ROWS = 60
DEFAULT_COLS = 26


def compact_empty_workbook(name: str) -> dict[str, Any]:
    return {
        "version": 1,
        "name": str(name or "Minha Planilha"),
        "rows": DEFAULT_ROWS,
        "cols": DEFAULT_COLS,
        "cells": [],
    }


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def iter_non_empty_cells(payload: dict[str, Any]) -> Iterator[tuple[int, int, Any]]:
    cells = payload.get("cells")
    if payload.get("storage") == "sparse" or (
        isinstance(cells, list) and cells and isinstance(cells[0], dict)
    ):
        for item in cells if isinstance(cells, list) else []:
            if not isinstance(item, dict):
                continue
            try:
                row = int(item.get("r"))
                col = int(item.get("c"))
            except (TypeError, ValueError):
                continue
            value = item.get("v")
            if row >= 0 and col >= 0 and value not in (None, ""):
                yield row, col, value
        return

    if not isinstance(cells, list):
        return
    for row_index, row in enumerate(cells):
        if not isinstance(row, list):
            continue
        for col_index, value in enumerate(row):
            if value not in (None, ""):
                yield row_index, col_index, value


def inspect_workbook_payload(payload: Any) -> dict[str, int | str]:
    if not isinstance(payload, dict):
        payload = {}

    rows = _positive_int(payload.get("rows"), DEFAULT_ROWS)
    cols = _positive_int(payload.get("cols"), DEFAULT_COLS)
    storage = "sparse" if payload.get("storage") == "sparse" else "dense"
    cells = payload.get("cells")
    if isinstance(cells, list) and cells and isinstance(cells[0], dict):
        storage = "sparse"

    filled_cells = 0
    formula_cells = 0
    value_bytes = 0
    last_used_row = -1
    last_used_col = -1

    for row, col, value in iter_non_empty_cells(payload):
        filled_cells += 1
        last_used_row = max(last_used_row, row)
        last_used_col = max(last_used_col, col)
        if isinstance(value, str) and value.lstrip().startswith("="):
            formula_cells += 1
        try:
            value_bytes += len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            value_bytes += len(str(value).encode("utf-8"))

    dense_slots = rows * cols if storage == "dense" else 0
    structural_bytes = filled_cells * 40
    dense_pointer_bytes = dense_slots * 8
    estimated_bytes = value_bytes + structural_bytes + dense_pointer_bytes

    return {
        "schema_version": _positive_int(payload.get("version"), 1),
        "storage": storage,
        "rows": rows,
        "cols": cols,
        "logical_cells": rows * cols,
        "dense_slots": dense_slots,
        "filled_cells": filled_cells,
        "formula_cells": formula_cells,
        "last_used_row": last_used_row,
        "last_used_col": last_used_col,
        "value_bytes": value_bytes,
        "estimated_payload_memory_bytes": estimated_bytes,
    }
