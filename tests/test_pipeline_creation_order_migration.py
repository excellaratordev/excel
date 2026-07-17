from pathlib import Path


def test_pipeline_creation_order_is_enforced_in_database() -> None:
    source = Path(
        "supabase/migrations/20260717103000_enforce_pipeline_creation_order.sql"
    ).read_text(encoding="utf-8")
    assert "workbooks_enforce_pipeline_creation_order" in source
    assert "Crie uma Base de entrada antes da primeira Planilha" in source
    assert "Crie uma Planilha de cálculo antes da primeira Base 2" in source
    assert "Crie uma Base 2 tratada antes da primeira Elementar" in source
    assert "before insert on public.workbooks" in source
