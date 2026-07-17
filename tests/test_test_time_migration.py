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


def test_test_time_migration_has_no_group_cell_limit() -> None:
    migration = Path("supabase/migrations/20260717170000_create_test_time_observability.sql").read_text(encoding="utf-8")

    assert "10000" not in migration
    assert "MAX_GROUP_CELLS" not in migration
    assert "cell_count" not in migration
