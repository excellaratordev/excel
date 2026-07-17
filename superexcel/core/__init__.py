"""Tipos e políticas independentes de framework."""

from .file_pipeline import (
    ALLOWED_TRANSITIONS,
    FILE_KIND_BASE,
    FILE_KIND_ELEMENTAR,
    FILE_KIND_SPREADSHEET,
    PIPELINE_STAGES,
    STAGE_CALCULATION,
    STAGE_PUBLICATION,
    STAGE_SOURCE,
    STAGE_TREATED,
    allowed_transition,
    normalize_file_identity,
    relational_payload,
)
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
    "FILE_KIND_BASE",
    "FILE_KIND_SPREADSHEET",
    "FILE_KIND_ELEMENTAR",
    "STAGE_SOURCE",
    "STAGE_CALCULATION",
    "STAGE_TREATED",
    "STAGE_PUBLICATION",
    "PIPELINE_STAGES",
    "ALLOWED_TRANSITIONS",
    "normalize_file_identity",
    "allowed_transition",
    "relational_payload",
]
