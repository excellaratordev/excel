from __future__ import annotations

import re
from typing import Any

from flask import request

import elementar_automation_routes
from backend import current_email, db, get_workbook
from superexcel.core.file_pipeline import FILE_KIND_BASE, STAGE_TREATED


BASE_MUTATION_RE = re.compile(r"^/api/bases/(\d+)/(?:rows|columns)(?:/|$)")
MAX_AUTO_ROW = 5000
MAX_AUTO_COL = 300
MAX_AUTO_CELLS = 100_000


def _dependencies(workbook_id: int) -> list[dict[str, Any]]:
    response = db(
        "GET",
        "elementar_dependencies",
        params={
            "select": "id,elementar_workbook_id,source_workbook_id,top_row,bottom_row,left_col,right_col",
            "source_workbook_id": f"eq.{workbook_id}",
            "order": "top_row.asc,left_col.asc",
        },
    )
    return response.json() if response.ok and isinstance(response.json(), list) else []


def _columns(workbook_id: int) -> list[dict[str, Any]]:
    response = db(
        "GET",
        "base_columns",
        params={
            "select": "column_key,name,position",
            "workbook_id": f"eq.{workbook_id}",
            "order": "position.asc,id.asc",
        },
    )
    return response.json() if response.ok and isinstance(response.json(), list) else []


def _snapshot_cells(workbook_id: int, dependencies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    columns = _columns(workbook_id)
    if not columns or not dependencies:
        return []

    requested: dict[int, set[int]] = {}
    total = 0
    for dependency in dependencies:
        top = max(0, int(dependency["top_row"]))
        bottom = min(MAX_AUTO_ROW - 1, int(dependency["bottom_row"]))
        left = max(0, int(dependency["left_col"]))
        right = min(MAX_AUTO_COL - 1, int(dependency["right_col"]), len(columns) - 1)
        if bottom < top or right < left:
            continue
        area = (bottom - top + 1) * (right - left + 1)
        total += area
        if total > MAX_AUTO_CELLS:
            raise ValueError("Os intervalos Elementar da Base 2 excedem 100 mil células.")
        for row in range(top, bottom + 1):
            requested.setdefault(row, set()).update(range(left, right + 1))

    cells: list[dict[str, Any]] = []
    for col in sorted(requested.get(0, set())):
        cells.append({"r": 0, "c": col, "v": columns[col]["name"], "t": "TEXT"})

    data_rows = sorted(row for row in requested if row > 0)
    if not data_rows:
        return cells

    first_sheet_row = data_rows[0]
    last_sheet_row = data_rows[-1]
    response = db(
        "GET",
        "base_rows",
        params={
            "select": "row_order,values",
            "workbook_id": f"eq.{workbook_id}",
            "order": "row_order.asc,id.asc",
            "offset": str(first_sheet_row - 1),
            "limit": str(last_sheet_row - first_sheet_row + 1),
        },
    )
    if not response.ok:
        raise RuntimeError("Não foi possível montar o snapshot da Base 2.")

    for index, row in enumerate(response.json()):
        sheet_row = first_sheet_row + index
        values = row.get("values") or {}
        for col in sorted(requested.get(sheet_row, set())):
            value = values.get(columns[col]["column_key"])
            if value is None or value == "":
                continue
            cells.append({"r": sheet_row, "c": col, "v": value})
    return cells


def refresh_treated_base(workbook_id: int) -> dict[str, Any]:
    workbook, response = get_workbook(workbook_id)
    if not response.ok or not workbook:
        return {"status": "missing"}
    if workbook.get("file_kind") != FILE_KIND_BASE or workbook.get("pipeline_stage") != STAGE_TREATED:
        return {"status": "ignored"}

    dependencies = _dependencies(workbook_id)
    if not dependencies:
        return {"status": "unused"}

    cells = _snapshot_cells(workbook_id, dependencies)
    revision = int(workbook.get("revision") or 0)
    _, error = elementar_automation_routes.save_source_snapshot(
        workbook_id,
        revision,
        cells,
        current_email() or elementar_automation_routes.SYSTEM_PUBLISHER,
    )
    if error:
        return {"status": "snapshot-error"}

    results = elementar_automation_routes.refresh_impacted(
        workbook_id,
        [],
        current_email() or elementar_automation_routes.SYSTEM_PUBLISHER,
    )
    return {
        "status": "processed",
        "published": sum(1 for item in results if item.get("status") == "published"),
        "unchanged": sum(1 for item in results if item.get("status") == "unchanged"),
        "pending": sum(1 for item in results if item.get("status") == "pending"),
    }


def install(app) -> None:
    elementar_automation_routes.MAX_SNAPSHOT_CELLS = MAX_AUTO_CELLS

    @app.after_request
    def refresh_elementar_after_base_mutation(response):
        if request.method not in {"POST", "PATCH", "DELETE"} or response.status_code >= 400:
            return response
        match = BASE_MUTATION_RE.match(request.path)
        if not match:
            return response
        try:
            result = refresh_treated_base(int(match.group(1)))
            response.headers["X-Elementar-Base-Refresh"] = str(result.get("status") or "unknown")
            if result.get("published"):
                response.headers["X-Elementar-Published"] = str(result["published"])
        except Exception as error:  # A gravação relacional não deve ser desfeita por falha de publicação.
            app.logger.exception("Falha ao atualizar Elementar a partir da Base 2: %s", error)
            response.headers["X-Elementar-Base-Refresh"] = "deferred"
        return response
