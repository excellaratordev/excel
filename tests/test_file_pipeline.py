from __future__ import annotations

import pytest

from base_routes import formula_like, normalize_key, normalize_typed_value
from elementar_routes import parse_range
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    FILE_KIND_ELEMENTAR,
    FILE_KIND_SPREADSHEET,
    STAGE_CALCULATION,
    STAGE_PUBLICATION,
    STAGE_SOURCE,
    STAGE_TREATED,
    allowed_transition,
    normalize_file_identity,
    relational_payload,
)


def test_four_valid_file_identities() -> None:
    assert normalize_file_identity(FILE_KIND_BASE, STAGE_SOURCE) == (FILE_KIND_BASE, STAGE_SOURCE)
    assert normalize_file_identity(FILE_KIND_SPREADSHEET, STAGE_CALCULATION) == (
        FILE_KIND_SPREADSHEET,
        STAGE_CALCULATION,
    )
    assert normalize_file_identity(FILE_KIND_BASE, STAGE_TREATED) == (FILE_KIND_BASE, STAGE_TREATED)
    assert normalize_file_identity(FILE_KIND_ELEMENTAR, STAGE_PUBLICATION) == (
        FILE_KIND_ELEMENTAR,
        STAGE_PUBLICATION,
    )


@pytest.mark.parametrize(
    ("kind", "stage"),
    [
        (FILE_KIND_BASE, STAGE_CALCULATION),
        (FILE_KIND_SPREADSHEET, STAGE_SOURCE),
        (FILE_KIND_SPREADSHEET, STAGE_PUBLICATION),
        (FILE_KIND_ELEMENTAR, STAGE_TREATED),
    ],
)
def test_invalid_file_identity_is_rejected(kind: str, stage: str) -> None:
    with pytest.raises(ValueError):
        normalize_file_identity(kind, stage)


def test_only_forward_single_stage_transitions_are_allowed() -> None:
    assert allowed_transition(STAGE_SOURCE, STAGE_CALCULATION)
    assert allowed_transition(STAGE_CALCULATION, STAGE_TREATED)
    assert allowed_transition(STAGE_TREATED, STAGE_PUBLICATION)
    assert not allowed_transition(STAGE_SOURCE, STAGE_TREATED)
    assert not allowed_transition(STAGE_CALCULATION, STAGE_PUBLICATION)
    assert not allowed_transition(STAGE_PUBLICATION, STAGE_SOURCE)
    assert not allowed_transition(STAGE_CALCULATION, STAGE_CALCULATION)


def test_relational_payload_has_no_cell_matrix_or_formula_runtime() -> None:
    payload = relational_payload("Clientes", STAGE_SOURCE)
    assert payload == {
        "version": 1,
        "storage": "relational",
        "name": "Clientes",
        "pipeline_stage": STAGE_SOURCE,
    }
    assert "cells" not in payload
    assert "formulas" not in payload


def test_base_rejects_formula_like_values_recursively() -> None:
    assert formula_like("=SOMA(A1:A2)")
    assert formula_like({"regra": [1, " =SE(A1;1;0)"]})
    assert not formula_like("valor = 10")
    assert not formula_like({"texto": "normal", "numero": 10})
    with pytest.raises(ValueError, match="não aceitam fórmulas"):
        normalize_typed_value("=1+1", "text")
    with pytest.raises(ValueError, match="não aceitam fórmulas"):
        normalize_typed_value({"x": "=A1"}, "json")


def test_base_values_are_normalized_by_relational_type() -> None:
    assert normalize_typed_value("12,5", "number") == 12.5
    assert normalize_typed_value("10", "number") == 10
    assert normalize_typed_value("sim", "boolean") is True
    assert normalize_typed_value("não", "boolean") is False
    assert normalize_typed_value("2026-07-17", "date") == "2026-07-17"
    assert normalize_typed_value('{"status":"ok"}', "json") == {"status": "ok"}


def test_column_keys_are_database_safe_and_stable() -> None:
    assert normalize_key("Razão Social") == "razao_social"
    assert normalize_key("123 Cliente") == "campo_123_cliente"
    assert normalize_key("___") == "campo"


def test_elementar_ranges_map_to_relational_coordinates() -> None:
    assert parse_range("$B$2:D10") == {
        "top": 1,
        "bottom": 9,
        "left": 1,
        "right": 3,
    }
