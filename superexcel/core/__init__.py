"""Tipos e políticas independentes de framework."""

from .permissions import (
    ALL_CAPABILITIES,
    DEFAULT_ROLE_CAPABILITIES,
    DEFAULT_ROLE_RANK,
    capabilities_for_role,
    role_allows,
)
from .workbook_payload import compact_empty_workbook, inspect_workbook_payload

__all__ = [
    "ALL_CAPABILITIES",
    "DEFAULT_ROLE_CAPABILITIES",
    "DEFAULT_ROLE_RANK",
    "capabilities_for_role",
    "role_allows",
    "compact_empty_workbook",
    "inspect_workbook_payload",
]
