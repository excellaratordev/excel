from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_base_editor_is_relational_and_virtualized() -> None:
    template = read("templates/base.html")
    script = read("static/js/base-grid.js")
    assert "base-grid-spacer" in template
    assert "base-grid-layer" in template
    assert "PostgreSQL relacional" in template
    assert "Cálculo</span><strong>Desativado" in template
    assert "formula-runtime.js" not in template
    assert "runtime-bridge.js" not in template
    assert "ROW_HEIGHT = 38" in script
    assert "visibleBounds" in script
    assert "ensureRange" in script
    assert "/api/bases/${workbookId}" in script
    assert "formulaLike" in script


def test_manager_exposes_exactly_four_pipeline_stages() -> None:
    template = read("templates/manager.html")
    script = read("static/js/file-pipeline-manager.js")
    styles = read("static/css/pipeline-manager.css")
    for stage in ("source", "calculation", "treated", "publication"):
        assert f'id="{stage}-count"' in template
        assert f"data-stage=\"{stage}\"" in script or f"key: '{stage}'" in script
    assert "Base → Planilhas → Base 2 → Elementar" in template
    assert "new-base-source" in template
    assert "new-base-treated" in template
    assert "pipeline-board" in styles
    assert "grid-template-columns: repeat(4" in styles


def test_base_files_open_in_relational_editor() -> None:
    script = read("static/js/file-pipeline-manager.js")
    app = read("app.py")
    assert "workbook.file_kind === 'base' ? `/base/${workbook.id}`" in script
    assert '@app.get("/base/<int:workbook_id>")' in app
    assert "register_blueprint(base_api)" in app


def test_elementar_conversion_is_removed_from_regular_sheets() -> None:
    client = read("static/js/elementar-auto-publish-client.js")
    routes = read("elementar_routes.py")
    assert "enableButton.hidden = true" in client
    assert "Uma planilha comum não pode ser convertida" in routes
    assert "pipeline_stage" in routes
    assert "STAGE_TREATED" in routes
    assert "Base 2 não encontrada" in routes


def test_treated_base_changes_reuse_automatic_elementar_publication() -> None:
    source = read("base_elementar_automation.py")
    assert "elementar_dependencies" in source
    assert "save_source_snapshot" in source
    assert "refresh_impacted" in source
    assert "X-Elementar-Base-Refresh" in source
