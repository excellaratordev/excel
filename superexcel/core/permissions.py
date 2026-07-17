from __future__ import annotations

from collections.abc import Iterable, Mapping


ALL_CAPABILITIES = frozenset({
    "project.view",
    "project.rename",
    "project.delete",
    "workbook.create",
    "workbook.view",
    "workbook.edit",
    "workbook.rename",
    "workbook.move",
    "workbook.delete",
    "workbook.export",
    "sheet.create",
    "sheet.view",
    "sheet.edit",
    "sheet.delete",
    "cell.edit",
    "formula.edit",
    "format.edit",
    "structure.edit",
    "data.import",
    "data.export",
    "history.view",
    "history.restore",
    "automation.view",
    "automation.edit",
    "automation.run",
    "members.view",
    "members.manage",
    "roles.view",
    "roles.manage",
    "telemetry.view",
})

DEFAULT_ROLE_RANK = {
    "viewer": 0,
    "editor": 1,
    "admin": 2,
    "owner": 3,
}

_VIEWER = frozenset({
    "project.view",
    "workbook.view",
    "sheet.view",
    "history.view",
    "telemetry.view",
})

_EDITOR = _VIEWER | frozenset({
    "workbook.create",
    "workbook.edit",
    "workbook.rename",
    "workbook.move",
    "workbook.export",
    "sheet.create",
    "sheet.edit",
    "sheet.delete",
    "cell.edit",
    "formula.edit",
    "format.edit",
    "structure.edit",
    "data.import",
    "data.export",
    "automation.view",
    "automation.run",
})

_ADMIN = _EDITOR | frozenset({
    "project.rename",
    "workbook.delete",
    "history.restore",
    "automation.edit",
    "members.view",
    "members.manage",
    "roles.view",
})

DEFAULT_ROLE_CAPABILITIES: Mapping[str, frozenset[str]] = {
    "viewer": _VIEWER,
    "editor": _EDITOR,
    "admin": _ADMIN,
    "owner": ALL_CAPABILITIES,
}


def normalize_role(role: object) -> str:
    return str(role or "").strip().lower()


def normalize_capabilities(values: Iterable[object]) -> frozenset[str]:
    capabilities = frozenset(str(value).strip() for value in values if str(value).strip())
    unknown = capabilities - ALL_CAPABILITIES
    if unknown:
        raise ValueError(f"Capacidades desconhecidas: {', '.join(sorted(unknown))}")
    return capabilities


def capabilities_for_role(
    role: object,
    custom_roles: Mapping[str, Iterable[object]] | None = None,
) -> frozenset[str]:
    normalized_role = normalize_role(role)
    if custom_roles and normalized_role in custom_roles:
        return normalize_capabilities(custom_roles[normalized_role])
    return DEFAULT_ROLE_CAPABILITIES.get(normalized_role, frozenset())


def role_allows(
    role: object,
    capability: str,
    custom_roles: Mapping[str, Iterable[object]] | None = None,
) -> bool:
    normalized_capability = str(capability or "").strip()
    if normalized_capability not in ALL_CAPABILITIES:
        return False
    return normalized_capability in capabilities_for_role(role, custom_roles)
