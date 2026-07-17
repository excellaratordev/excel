from pathlib import Path


def template() -> str:
    return Path("templates/index.html").read_text(encoding="utf-8")


def script(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_automatic_clients_load_before_elementar_sheet() -> None:
    source = template()
    source_sync = source.index("js/elementar-source-sync.js")
    auto_publish = source.index("js/elementar-auto-publish-client.js")
    elementar_sheet = source.index("js/elementar-sheet.js")
    assert source_sync < auto_publish < elementar_sheet
    assert "publicado automaticamente quando o conteúdo muda" in source
    assert "Publicar agora" in source


def test_source_sync_filters_by_dependency_ranges_and_confirmed_revision() -> None:
    source = script("static/js/elementar-source-sync.js")
    assert "/api/elementar/sources/${workbookId}/dependencies" in source
    assert "/api/elementar/sources/${workbookId}/calculated-snapshot" in source
    assert "intersects(row, col)" in source
    assert "SuperExcelOperationStore?.count" in source
    assert "collaboration-config" in source
    assert "changed_cells" in source
    assert "reclassifyRecentCells" in source


def test_recalculated_coordinates_are_exposed_to_selective_sync() -> None:
    source = script("static/js/calculation/render-bridge.js")
    assert "coordinates: [...rendered.values()]" in source
    assert "runtime === activeRuntime" in source
    assert "SuperExcelActiveRuntime" in source


def test_live_json_is_automatically_sent_to_server() -> None:
    source = script("static/js/elementar-auto-publish-client.js")
    assert "/api/elementar/workbooks/${workbookId}/auto-publish" in source
    assert "MutationObserver" in source
    assert "declarationFingerprint" in source
    assert "button.click()" in source
    assert "lastSubmittedFingerprint" in source
