from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from backend import db


def get_nested(payload: dict[str, Any], path: str) -> tuple[bool, Any]:
    current: Any = payload
    for part in [item for item in str(path).split(".") if item]:
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current


def install(routes) -> None:
    def replace_dependencies(
        elementar_workbook_id: int,
        definition_revision: int,
        declarations: list[dict[str, Any]],
        payload: dict[str, Any] | None = None,
        source_revisions: dict[str, int] | None = None,
    ) -> tuple[list[dict[str, Any]] | None, str | None]:
        source_revisions = source_revisions or {}
        rows = []
        for index, declaration in enumerate(declarations):
            try:
                source_id = int(declaration["workbook_id"])
                key = str(declaration["key"]).strip()
                workbook_name = str(declaration["workbook_name"]).strip()
                source_range = str(declaration["range"]).replace("$", "").upper()
                bounds = routes.parse_range(source_range)
            except (KeyError, TypeError, ValueError):
                return None, "Declaração Elementar inválida."
            if not key or not workbook_name:
                return None, "Declaração Elementar inválida."
            found, last_value = get_nested(payload or {}, key)
            rows.append({
                "elementar_workbook_id": elementar_workbook_id,
                "source_workbook_id": source_id,
                "declaration_key": key,
                "workbook_name": workbook_name,
                "source_range": source_range,
                "declaration_cell": str(declaration.get("cell") or ""),
                "declaration_order": index,
                "definition_revision": definition_revision,
                "last_value": last_value if found else None,
                "last_source_revision": int(source_revisions.get(str(source_id)) or 0) if found else 0,
                **bounds,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        response = db(
            "DELETE",
            "elementar_dependencies",
            params={"elementar_workbook_id": f"eq.{elementar_workbook_id}"},
            prefer="return=minimal",
        )
        if not response.ok:
            return None, "Erro ao substituir dependências Elementar."
        if rows:
            response = db("POST", "elementar_dependencies", payload=rows, prefer="return=representation")
            if not response.ok:
                return None, "Erro ao registrar dependências Elementar."
        return rows, None

    def resolve_dependency_value(dependency: dict[str, Any], values: dict[tuple[int, int], Any]) -> Any:
        matrix = []
        for row in range(int(dependency["top_row"]), int(dependency["bottom_row"]) + 1):
            current = []
            for col in range(int(dependency["left_col"]), int(dependency["right_col"]) + 1):
                value = values.get((row, col))
                if isinstance(value, str) and value.startswith("#"):
                    raise ValueError(
                        f"{dependency['workbook_name']} contém o erro {value} dentro de {dependency['source_range']}."
                    )
                current.append(value)
            matrix.append(current)
        return routes.matrix_to_json(matrix)

    def publish_from_snapshots(
        elementar_workbook_id: int,
        created_by: str = routes.SYSTEM_PUBLISHER,
        changed_source_id: int | None = None,
    ) -> dict[str, Any]:
        config = routes.config_for(elementar_workbook_id)
        if not config or not bool(config.get("auto_publish", True)):
            return {"status": "disabled"}
        response = db(
            "GET",
            "elementar_dependencies",
            params={
                "select": "*",
                "elementar_workbook_id": f"eq.{elementar_workbook_id}",
                "order": "declaration_order.asc",
            },
        )
        if not response.ok:
            return {"status": "error", "error": "Erro ao carregar dependências Elementar."}
        dependencies = response.json()
        if not dependencies:
            return {"status": "pending", "reason": "A Elementar ainda não possui dependências publicadas."}

        if changed_source_id is not None:
            snapshots = routes.load_source_snapshots([changed_source_id])
            snapshot = snapshots.get(changed_source_id)
            if not snapshot:
                return {"status": "pending", "missing_sources": [changed_source_id]}
            values = routes.cell_map(snapshot)
            for dependency in dependencies:
                if int(dependency["source_workbook_id"]) != changed_source_id:
                    continue
                try:
                    resolved_value = resolve_dependency_value(dependency, values)
                except ValueError as error:
                    return {"status": "error", "error": str(error)}
                response = db(
                    "PATCH",
                    "elementar_dependencies",
                    params={"id": f"eq.{dependency['id']}"},
                    payload={
                        "last_value": resolved_value,
                        "last_source_revision": int(snapshot["revision"]),
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                    prefer="return=minimal",
                )
                if not response.ok:
                    return {"status": "error", "error": "Erro ao atualizar valor dependente."}
                dependency["last_value"] = resolved_value
                dependency["last_source_revision"] = int(snapshot["revision"])

        pending = [
            int(item["source_workbook_id"])
            for item in dependencies
            if int(item.get("last_source_revision") or 0) <= 0
        ]
        if pending:
            return {"status": "pending", "missing_sources": sorted(set(pending))}

        output: dict[str, Any] = {}
        declarations: list[dict[str, Any]] = []
        try:
            for dependency in dependencies:
                routes.set_nested(output, dependency["declaration_key"], dependency.get("last_value"))
                declarations.append({
                    "key": dependency["declaration_key"],
                    "workbook_name": dependency["workbook_name"],
                    "workbook_id": int(dependency["source_workbook_id"]),
                    "range": dependency["source_range"],
                    "cell": dependency.get("declaration_cell") or "",
                })
        except ValueError as error:
            return {"status": "error", "error": str(error)}

        source_revisions: dict[str, int] = {}
        for dependency in dependencies:
            source_id = str(int(dependency["source_workbook_id"]))
            source_revisions[source_id] = max(
                source_revisions.get(source_id, 0),
                int(dependency.get("last_source_revision") or 0),
            )
        definition_revision = max(int(item["definition_revision"]) for item in dependencies)
        return routes.create_publication(
            config,
            output,
            definition_revision,
            source_revisions,
            declarations,
            created_by,
        )

    def refresh_impacted(source_workbook_id: int, changed_cells: list[dict[str, int]], created_by: str) -> list[dict[str, Any]]:
        dependencies = routes.dependencies_for_source(source_workbook_id)
        if changed_cells:
            dependencies = [
                dependency
                for dependency in dependencies
                if any(routes.cell_hits_dependency(cell, dependency) for cell in changed_cells)
            ]
        elementar_ids = sorted({int(item["elementar_workbook_id"]) for item in dependencies})
        return [
            {
                "workbook_id": elementar_id,
                **publish_from_snapshots(elementar_id, created_by, source_workbook_id),
            }
            for elementar_id in elementar_ids
        ]

    routes.replace_dependencies = replace_dependencies
    routes.publish_from_snapshots = publish_from_snapshots
    routes.refresh_impacted = refresh_impacted
