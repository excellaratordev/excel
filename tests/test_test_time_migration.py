from pathlib import Path


def test_test_time_schema_records_client_and_server_timestamps() -> None:
    migration = Path("supabase/migrations/20260717170000_create_test_time_observability.sql").read_text(encoding="utf-8")

    assert "create table if not exists public.test_time_sessions" in migration
    assert "create table if not exists public.test_time_groups" in migration
    assert "create table if not exists public.test_time_events" in migration
    assert "client_epoch_ms numeric(20,3)" in migration
    assert "client_observed_at timestamptz" in migration
    assert "server_received_at timestamptz not null default clock_timestamp()" in migration
    assert "create or replace function public.observe_test_time_group" in migration
    assert "create or replace function public.start_test_time_session" in migration
    assert "stage_number smallint" in migration


def test_final_test_time_validation_has_no_cell_limit() -> None:
    migration = Path("supabase/migrations/20260717170500_remove_test_time_group_cell_limit.sql").read_text(encoding="utf-8")

    assert "create or replace function public.validate_test_time_group" in migration
    assert "10000" not in migration
    assert "cell_count" not in migration
    assert "new.stage_number := public.test_time_stage_number" in migration
