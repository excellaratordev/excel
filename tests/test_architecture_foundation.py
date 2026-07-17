from __future__ import annotations

import pytest

from superexcel.core.permissions import (
    ALL_CAPABILITIES,
    capabilities_for_role,
    role_allows,
)
from superexcel.core.workbook_payload import (
    compact_empty_workbook,
    inspect_workbook_payload,
)
from superexcel.telemetry.registry import TelemetryRegistry
from telemetry_routes import normalize_metrics


def test_empty_workbook_is_compact():
    payload = compact_empty_workbook("Financeiro")

    assert payload == {
        "version": 1,
        "name": "Financeiro",
        "rows": 60,
        "cols": 26,
        "cells": [],
    }


def test_inspects_dense_and_sparse_payloads():
    dense = inspect_workbook_payload({
        "version": 1,
        "rows": 100,
        "cols": 20,
        "cells": [[1, "=A1*2", None]],
    })
    sparse = inspect_workbook_payload({
        "version": 2,
        "storage": "sparse",
        "rows": 1_000_000,
        "cols": 10_000,
        "cells": [
            {"r": 0, "c": 0, "v": 1},
            {"r": 0, "c": 1, "v": "=A1*2"},
        ],
    })

    assert dense["storage"] == "dense"
    assert dense["dense_slots"] == 2000
    assert dense["filled_cells"] == 2
    assert dense["formula_cells"] == 1

    assert sparse["storage"] == "sparse"
    assert sparse["dense_slots"] == 0
    assert sparse["logical_cells"] == 10_000_000_000
    assert sparse["filled_cells"] == 2
    assert sparse["formula_cells"] == 1
    assert sparse["estimated_payload_memory_bytes"] < dense["estimated_payload_memory_bytes"]


def test_default_roles_are_capability_presets():
    assert role_allows("viewer", "workbook.view")
    assert role_allows("viewer", "telemetry.view")
    assert not role_allows("viewer", "cell.edit")
    assert role_allows("editor", "cell.edit")
    assert not role_allows("editor", "members.manage")
    assert role_allows("admin", "members.manage")
    assert capabilities_for_role("owner") == ALL_CAPABILITIES


def test_custom_role_can_override_default_presets():
    custom = {"vendedor": ["project.view", "workbook.view", "cell.edit"]}

    assert role_allows("vendedor", "cell.edit", custom)
    assert not role_allows("vendedor", "data.export", custom)


def test_unknown_custom_capability_is_rejected():
    with pytest.raises(ValueError):
        capabilities_for_role("custom", {"custom": ["unknown.permission"]})


def test_telemetry_metrics_are_bounded_and_normalized():
    normalized, error = normalize_metrics({
        "heap_used_bytes": 1234.0,
        "render_ms": 8.5,
        "ignored": "value",
    })

    assert error is None
    assert normalized == {"heap_used_bytes": 1234, "render_ms": 8.5}


def test_telemetry_registry_keeps_summary():
    registry = TelemetryRegistry()
    registry.record(10, {"heap_used_bytes": 100, "render_ms": 10})
    registry.record(10, {"heap_used_bytes": 140, "render_ms": 20})

    summary = registry.summary(10)

    assert summary["sample_count"] == 2
    assert summary["latest"]["heap_used_bytes"] == 140
    assert summary["average"]["heap_used_bytes"] == 120
    assert summary["maximum"]["render_ms"] == 20
