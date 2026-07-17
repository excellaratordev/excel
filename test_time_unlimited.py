from __future__ import annotations

from typing import Any

import test_time_routes as routes


def normalize_range(start: Any, end: Any = None) -> dict[str, Any]:
    start_row, start_col = routes.parse_cell(start)
    end_row, end_col = routes.parse_cell(end or start)
    top, bottom = sorted((start_row, end_row))
    left, right = sorted((start_col, end_col))
    first = f"{routes.column_name(left)}{top + 1}"
    last = f"{routes.column_name(right)}{bottom + 1}"
    return {
        "top_row": top,
        "bottom_row": bottom,
        "left_col": left,
        "right_col": right,
        "reference": first if first == last else f"{first}:{last}",
        "cell_count": (bottom - top + 1) * (right - left + 1),
    }


# Route functions resolve this global at request time. Replacing it removes the
# former per-group cell cap without changing the API contract.
routes.normalize_range = normalize_range

test_time_api = routes.test_time_api
column_index = routes.column_index
column_name = routes.column_name
