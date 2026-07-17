from pathlib import Path

from treated_base_formula_routes import is_formula, parse_direct_reference


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_direct_planilha_reference_parser() -> None:
    assert parse_direct_reference("='Planilha de Pedidos'!A1") == {
        "source_name": "Planilha de Pedidos",
        "column": "A",
        "row": 1,
        "address": "A1",
    }
    assert parse_direct_reference(" = 'João''s'!$BC$27 ") == {
        "source_name": "João's",
        "column": "BC",
        "row": 27,
        "address": "BC27",
    }
    assert parse_direct_reference("=Pedidos!B2") == {
        "source_name": "Pedidos",
        "column": "B",
        "row": 2,
        "address": "B2",
    }


def test_formula_detection_remains_unrestricted() -> None:
    assert is_formula("=1+1")
    assert is_formula("  ='Planilha'!A1")
    assert not is_formula("valor = 10")


def test_treated_base_formulas_store_expression_and_result_separately() -> None:
    routes = read("treated_base_formula_routes.py")
    migration = read("supabase/migrations/20260717183000_add_treated_base_formula_values.sql")
    app = read("app.py")

    assert '"formulas": merged_formulas' in routes
    assert 'merged_values[key] = None' in routes
    assert "rpc/set_treated_base_formula_result" in routes
    assert "add column if not exists formulas jsonb" in migration.lower()
    assert "set_treated_base_formula_result" in migration
    assert "jsonb_set" in migration
    assert "treated_base_formula_api" in app
