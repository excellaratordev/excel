from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path


class IdCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if attributes.get("id"):
            self.ids.append(str(attributes["id"]))


def manager_template() -> str:
    return Path("templates/manager.html").read_text(encoding="utf-8")


def test_manager_template_has_unique_ids() -> None:
    parser = IdCollector()
    parser.feed(manager_template())

    duplicates = sorted({item for item in parser.ids if parser.ids.count(item) > 1})

    assert duplicates == []


def test_manager_template_preserves_required_controls() -> None:
    parser = IdCollector()
    parser.feed(manager_template())
    ids = set(parser.ids)

    required = {
        "project-select",
        "project-role",
        "new-project",
        "rename-project",
        "new-folder",
        "new-sheet",
        "root-button",
        "current-folder",
        "items",
        "new-variable",
        "new-member",
        "new-invite",
        "github-connect",
        "github-sync",
        "github-disconnect",
        "form-dialog",
        "dialog-title",
        "dialog-fields",
        "dialog-save",
        "file-search",
        "file-sort",
        "view-grid",
        "view-list",
    }

    assert required <= ids


def test_manager_ui_extension_loads_after_manager_core() -> None:
    template = manager_template()

    core_position = template.index("js/manager.js")
    ui_position = template.index("js/manager-ui.js")
    github_position = template.index("js/github-connector.js")

    assert core_position < ui_position < github_position


def test_manager_topbar_uses_independent_groups_and_override_styles() -> None:
    template = manager_template()

    assert "css/manager-topbar.css" in template
    assert '<div class="project-switcher">' in template
    assert '<div class="actions" aria-label="Ações de arquivos">' in template
    assert '<div class="topbar-account">' in template
    assert template.index('class="brand-block"') < template.index('class="project-switcher"')
    assert template.index('class="project-switcher"') < template.index('class="actions" aria-label="Ações de arquivos"')
    assert template.index('class="actions" aria-label="Ações de arquivos"') < template.index('class="topbar-account"')
