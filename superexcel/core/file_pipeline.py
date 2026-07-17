from __future__ import annotations

from typing import Any


FILE_KIND_BASE = "base"
FILE_KIND_SPREADSHEET = "spreadsheet"
FILE_KIND_ELEMENTAR = "elementar"

STAGE_SOURCE = "source"
STAGE_CALCULATION = "calculation"
STAGE_TREATED = "treated"
STAGE_PUBLICATION = "publication"

FILE_KINDS = {
    FILE_KIND_BASE,
    FILE_KIND_SPREADSHEET,
    FILE_KIND_ELEMENTAR,
}
PIPELINE_STAGES = {
    STAGE_SOURCE,
    STAGE_CALCULATION,
    STAGE_TREATED,
    STAGE_PUBLICATION,
}

VALID_IDENTITIES = {
    (FILE_KIND_BASE, STAGE_SOURCE),
    (FILE_KIND_SPREADSHEET, STAGE_CALCULATION),
    (FILE_KIND_BASE, STAGE_TREATED),
    (FILE_KIND_ELEMENTAR, STAGE_PUBLICATION),
}

ALLOWED_TRANSITIONS = {
    (STAGE_SOURCE, STAGE_CALCULATION),
    (STAGE_CALCULATION, STAGE_TREATED),
    (STAGE_TREATED, STAGE_PUBLICATION),
}

STAGE_LABELS = {
    STAGE_SOURCE: "Base",
    STAGE_CALCULATION: "Planilhas",
    STAGE_TREATED: "Base 2",
    STAGE_PUBLICATION: "Elementar",
}


def normalize_file_identity(
    file_kind: Any,
    pipeline_stage: Any,
    *,
    default_kind: str = FILE_KIND_SPREADSHEET,
    default_stage: str = STAGE_CALCULATION,
) -> tuple[str, str]:
    kind = str(file_kind or default_kind).strip().lower()
    stage = str(pipeline_stage or default_stage).strip().lower()
    if (kind, stage) not in VALID_IDENTITIES:
        raise ValueError(
            "Tipo e etapa incompatíveis. Use Base, Planilhas, Base 2 ou Elementar."
        )
    return kind, stage


def allowed_transition(source_stage: Any, target_stage: Any) -> bool:
    return (
        str(source_stage or "").strip().lower(),
        str(target_stage or "").strip().lower(),
    ) in ALLOWED_TRANSITIONS


def is_base(workbook: dict[str, Any] | None) -> bool:
    return bool(workbook and workbook.get("file_kind") == FILE_KIND_BASE)


def is_calculation_workbook(workbook: dict[str, Any] | None) -> bool:
    return bool(
        workbook
        and workbook.get("file_kind") == FILE_KIND_SPREADSHEET
        and workbook.get("pipeline_stage") == STAGE_CALCULATION
    )


def is_elementar(workbook: dict[str, Any] | None) -> bool:
    return bool(
        workbook
        and workbook.get("file_kind") == FILE_KIND_ELEMENTAR
        and workbook.get("pipeline_stage") == STAGE_PUBLICATION
    )


def relational_payload(name: str, stage: str) -> dict[str, Any]:
    if stage not in {STAGE_SOURCE, STAGE_TREATED}:
        raise ValueError("Uma Base deve estar na entrada ou na saída tratada.")
    return {
        "version": 1,
        "storage": "relational",
        "name": str(name),
        "pipeline_stage": stage,
    }
