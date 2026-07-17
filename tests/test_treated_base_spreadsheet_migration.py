from pathlib import Path


def test_treated_base_sync_schema_and_atomic_materialization() -> None:
    migration = Path("supabase/migrations/20260717143000_create_treated_base_spreadsheet_sync.sql").read_text(encoding="utf-8")

    assert "create table if not exists public.treated_base_bindings" in migration
    assert "create table if not exists public.treated_base_source_snapshots" in migration
    assert "create or replace function public.materialize_treated_base" in migration
    assert "pipeline_stage is distinct from 'calculation'" in migration
    assert "pipeline_stage is distinct from 'treated'" in migration
    assert "delete from public.base_rows" in migration
    assert "delete from public.base_columns" in migration
    assert "insert into public.base_columns" in migration
    assert "insert into public.base_rows" in migration
    assert "grant execute on function public.materialize_treated_base" in migration
