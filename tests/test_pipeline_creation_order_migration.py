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


def test_file_dependency_targets_have_a_covering_index() -> None:
    source = Path(
        "supabase/migrations/20260717104000_index_file_dependency_targets.sql"
    ).read_text(encoding="utf-8")
    assert "file_dependencies_target_idx" in source
    assert "(target_workbook_id, source_workbook_id)" in source
