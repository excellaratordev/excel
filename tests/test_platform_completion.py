from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_roles_admin_is_loaded_before_manager_navigation_binding():
    template = read("templates/manager.html")
    assert 'data-view="roles"' in template
    assert 'id="roles-view"' in template
    assert "js/roles-manager.js" in template
    assert template.index("js/roles-manager.js") > template.index("js/manager.js")


def test_architecture_migration_is_integral_and_idempotent():
    migration = read("supabase/migrations/20260717022658_architecture_completion.sql")
    for relation in (
        "project_roles",
        "workbook_checkpoints",
        "workbook_chunks",
        "workbook_telemetry_samples",
        "workbook_telemetry_latest",
    ):
        assert relation in migration
    assert "add column if not exists op_id" in migration
    assert "create unique index if not exists workbook_changes_workbook_op_id_uidx" in migration


def test_security_hardening_protects_internal_tables():
    migration = read("supabase/migrations/20260717061000_harden_architecture_tables.sql")
    assert migration.count("enable row level security") == 4
    assert "security_invoker = true" in migration
    assert "revoke all" in migration


def test_ci_runs_benchmarks_collaboration_and_wasm():
    workflow = read(".github/workflows/ci.yml")
    assert "calculation-benchmarks.js" in workflow
    assert "collaboration-simulator.js" in workflow
    assert "wasm32-unknown-unknown" in workflow
    assert "cargo test" in workflow
