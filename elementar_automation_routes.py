from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, jsonify

from backend import api_error, current_email, db, fetch_one, get_workbook, json_body, require_project


elementar_automation_api = Blueprint("elementar_automation_api", __name__)

MAX_SNAPSHOT_CELLS = 100_000
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
SYSTEM_PUBLISHER = "elementar-auto@system.local"


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def col_index(name: str) -> int:
    result = 0
    for letter in name.replace("$", "").upper():
        result = result * 26 + ord(letter) - 64
    return result - 1


def parse_cell_address(value: str) -> tuple[int, int]:
    text = str(value).replace("$", "").upper()
    split = 0
    while split < len(text) and text[split].isalpha():
        split += 1
    if split == 0 or split == len(text):
        raise ValueError("Endereço de célula inválido.")
    col = col_index(text[:split])
    row = int(text[split:]) - 1
    if row < 0 or col < 0:
        raise ValueError("Endereço de célula inválido.")
    return row, col


def parse_range(value: str) -> dict[str, int]:
    parts = str(value).split(":", 1)
    start = parse_cell_address(parts[0])
    end = parse_cell_address(parts[1] if len(parts) == 2 else parts[0])
    return {
        "top_row": min(start[0], end[0]),
        "bottom_row": max(start[0], end[0]),
        "left_col": min(start[1], end[1]),
        "right_col": max(start[1], end[1]),
    }


def is_blank(value: Any) -> bool:
    return value is None or value == ""


def trim_vector(values: list[Any]) -> list[Any]:
    output = list(values)
    while output and is_blank(output[-1]):
        output.pop()
    return output


def matrix_to_json(matrix: list[list[Any]]) -> Any:
    if not matrix:
        return []
    if len(matrix) == 1 and len(matrix[0]) == 1:
        return matrix[0][0]
    if len(matrix) == 1:
        return trim_vector(matrix[0])
    if all(len(row) == 1 for row in matrix):
        return trim_vector([row[0] for row in matrix])
    headers = [str(value or "").strip() for value in matrix[0]]
    valid_headers = all(headers) and len(set(headers)) == len(headers)
    if valid_headers:
        return [
            {header: row[index] if index < len(row) else None for index, header in enumerate(headers)}
            for row in matrix[1:]
            if any(not is_blank(value) for value in row)
        ]
    return [row for row in matrix if any(not is_blank(value) for value in row)]


def set_nested(target: dict[str, Any], path: str, value: Any) -> None:
    parts = [part for part in str(path).split(".") if part]
    if not parts:
        raise ValueError("Nome de elemento inválido.")
    current = target
    for index, part in enumerate(parts):
        if index == len(parts) - 1:
            if part in current:
                raise ValueError(f"Conflito no elemento {path}.")
            current[part] = value
            return
        existing = current.get(part)
        if existing is None:
            current[part] = {}
        elif not isinstance(existing, dict):
            raise ValueError(f"O caminho {path} entra em conflito com outro elemento.")
        current = current[part]


def normalize_cells(value: Any) -> tuple[list[dict[str, Any]] | None, str | None]:
    if not isinstance(value, list) or len(value) > MAX_SNAPSHOT_CELLS:
        return None, f"Envie no máximo {MAX_SNAPSHOT_CELLS} células calculadas."
    output: dict[tuple[int, int], dict[str, Any]] = {}
    for item in value:
        if not isinstance(item, dict):
            return None, "Célula calculada inválida."
        try:
            row = int(item.get("r"))
            col = int(item.get("c"))
        except (TypeError, ValueError):
            return None, "Coordenadas calculadas inválidas."
        if row < 0 or row >= 5000 or col < 0 or col >= 300:
            return None, "Célula calculada fora do limite permitido."
        cell = {"r": row, "c": col, "v": item.get("v")}
        if item.get("t"):
            cell["t"] = str(item.get("t"))[:24]
        output[(row, col)] = cell
    cells = list(output.values())
    try:
        encoded = canonical_json({"cells": cells})
    except (TypeError, ValueError):
        return None, "Os valores calculados não formam um JSON válido."
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        return None, "O snapshot calculado excede 4 MB."
    return cells, None


def normalize_changed_cells(value: Any) -> list[dict[str, int]]:
    if not isinstance(value, list):
        return []
    output = []
    for item in value[:MAX_SNAPSHOT_CELLS]:
        if not isinstance(item, dict):
            continue
        try:
            row = int(item.get("row", item.get("r")))
            col = int(item.get("col", item.get("c")))
        except (TypeError, ValueError):
            continue
        if row >= 0 and col >= 0:
            output.append({"row": row, "col": col})
    return output


def cell_hits_dependency(cell: dict[str, int], dependency: dict[str, Any]) -> bool:
    return (
        int(dependency["top_row"]) <= cell["row"] <= int(dependency["bottom_row"])
        and int(dependency["left_col"]) <= cell["col"] <= int(dependency["right_col"])
    )


def dependencies_for_source(source_workbook_id: int) -> list[dict[str, Any]]:
    response = db(
        "GET",
        "elementar_dependencies",
        params={
            "select": "elementar_workbook_id,source_workbook_id,declaration_key,workbook_name,source_range,declaration_cell,declaration_order,top_row,bottom_row,left_col,right_col,definition_revision",
            "source_workbook_id": f"eq.{source_workbook_id}",
            "order": "elementar_workbook_id.asc,declaration_order.asc",
        },
    )
    return response.json() if response.ok and isinstance(response.json(), list) else []


def config_for(workbook_id: int) -> dict[str, Any] | None:
    row, response = fetch_one(
        "elementar_configs",
        {"select": "*", "workbook_id": f"eq.{workbook_id}"},
    )
    return row if response.ok else None


def publication_view(config: dict[str, Any]) -> dict[str, Any]:
    public = f"/public/elementar/{config['public_token']}" if config.get("visibility") == "public" else None
    return {
        "enabled": True,
        "workbook_id": int(config["workbook_id"]),
        "project_id": int(config["project_id"]),
        "slug": config["slug"],
        "visibility": config["visibility"],
        "public_token": config["public_token"],
        "auto_publish": bool(config.get("auto_publish", True)),
        "last_publication_version": int(config.get("last_publication_version") or 0),
        "last_payload_hash": config.get("last_payload_hash"),
        "authenticated_endpoint": f"/api/elementar/data/{config['slug']}",
        "public_endpoint": public,
    }


def save_source_snapshot(source_workbook_id: int, revision: int, cells: list[dict[str, Any]], email: str | None) -> tuple[dict[str, Any] | None, Any | None]:
    payload = {
        "version": 1,
        "cells": cells,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    digest = content_hash(payload)
    response = db(
        "POST",
        "elementar_source_snapshots",
        params={"on_conflict": "source_workbook_id"},
        payload={
            "source_workbook_id": source_workbook_id,
            "revision": revision,
            "payload": payload,
            "payload_hash": digest,
            "updated_by_email": email,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not response.ok:
        return None, api_error(response, "Erro ao salvar valores calculados")
    rows = response.json()
    return (rows[0] if rows else {"source_workbook_id": source_workbook_id, "revision": revision}), None


def load_source_snapshots(source_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not source_ids:
        return {}
    response = db(
        "GET",
        "elementar_source_snapshots",
        params={
            "select": "source_workbook_id,revision,payload,payload_hash,updated_at",
            "source_workbook_id": f"in.({','.join(map(str, source_ids))})",
        },
    )
    if not response.ok:
        return {}
    return {int(row["source_workbook_id"]): row for row in response.json()}


def cell_map(snapshot: dict[str, Any]) -> dict[tuple[int, int], Any]:
    output: dict[tuple[int, int], Any] = {}
    for item in (snapshot.get("payload") or {}).get("cells", []):
        try:
            row, col = int(item["r"]), int(item["c"])
        except (KeyError, TypeError, ValueError):
            continue
        output[(row, col)] = item.get("v")
    return output


def latest_publication(config: dict[str, Any]) -> dict[str, Any] | None:
    publication_id = config.get("last_publication_id")
    if not publication_id:
        return None
    row, response = fetch_one(
        "elementar_publications",
        {"select": "id,version,payload,payload_hash,created_at", "id": f"eq.{publication_id}"},
    )
    return row if response.ok else None


def create_publication(
    config: dict[str, Any],
    payload: dict[str, Any],
    definition_revision: int,
    source_revisions: dict[str, int],
    declarations: list[dict[str, Any]],
    created_by: str,
) -> dict[str, Any]:
    encoded = canonical_json(payload)
    if len(encoded) > MAX_OUTPUT_BYTES:
        return {"status": "error", "error": "A saída Elementar excede 2 MB."}
    digest = hashlib.sha256(encoded).hexdigest()
    latest = latest_publication(config)
    latest_hash = config.get("last_payload_hash") or (latest or {}).get("payload_hash")
    if not latest_hash and latest and isinstance(latest.get("payload"), dict):
        latest_hash = content_hash(latest["payload"])
    if latest_hash == digest:
        return {
            "status": "unchanged",
            "version": int(config.get("last_publication_version") or 0),
            "payload_hash": digest,
        }

    latest_version = db(
        "GET",
        "elementar_publications",
        params={
            "select": "version",
            "workbook_id": f"eq.{config['workbook_id']}",
            "order": "version.desc",
            "limit": "1",
        },
    )
    if not latest_version.ok:
        return {"status": "error", "error": "Erro ao versionar a publicação."}
    version = int(latest_version.json()[0]["version"]) + 1 if latest_version.json() else 1
    record = {
        "workbook_id": int(config["workbook_id"]),
        "project_id": int(config["project_id"]),
        "version": version,
        "payload": payload,
        "payload_hash": digest,
        "definition_revision": definition_revision,
        "source_revisions": source_revisions,
        "declarations": declarations,
        "created_by_email": created_by or SYSTEM_PUBLISHER,
    }
    response = db("POST", "elementar_publications", payload=record, prefer="return=representation")
    if response.status_code == 409:
        record["version"] += 1
        response = db("POST", "elementar_publications", payload=record, prefer="return=representation")
    if not response.ok or not response.json():
        return {"status": "error", "error": "Erro ao criar publicação automática."}
    published = response.json()[0]
    response = db(
        "PATCH",
        "elementar_configs",
        params={"workbook_id": f"eq.{config['workbook_id']}"},
        payload={
            "last_publication_id": published["id"],
            "last_publication_version": published["version"],
            "last_payload_hash": digest,
            "published_at": published.get("created_at"),
        },
        prefer="return=representation",
    )
    if not response.ok:
        return {"status": "error", "error": "A publicação foi criada, mas não pôde ser ativada."}
    return {
        "status": "published",
        "publication_id": int(published["id"]),
        "version": int(published["version"]),
        "payload_hash": digest,
        "payload_bytes": len(encoded),
    }


def publish_from_snapshots(elementar_workbook_id: int, created_by: str = SYSTEM_PUBLISHER) -> dict[str, Any]:
    config = config_for(elementar_workbook_id)
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
    source_ids = sorted({int(item["source_workbook_id"]) for item in dependencies})
    snapshots = load_source_snapshots(source_ids)
    missing = [source_id for source_id in source_ids if source_id not in snapshots]
    if missing:
        return {"status": "pending", "missing_sources": missing}

    maps = {source_id: cell_map(snapshot) for source_id, snapshot in snapshots.items()}
    output: dict[str, Any] = {}
    declarations: list[dict[str, Any]] = []
    try:
        for dependency in dependencies:
            source_id = int(dependency["source_workbook_id"])
            values = maps[source_id]
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
            set_nested(output, dependency["declaration_key"], matrix_to_json(matrix))
            declarations.append({
                "key": dependency["declaration_key"],
                "workbook_name": dependency["workbook_name"],
                "workbook_id": source_id,
                "range": dependency["source_range"],
                "cell": dependency.get("declaration_cell") or "",
            })
    except ValueError as error:
        return {"status": "error", "error": str(error)}

    source_revisions = {str(source_id): int(snapshots[source_id]["revision"]) for source_id in source_ids}
    definition_revision = max(int(item["definition_revision"]) for item in dependencies)
    return create_publication(
        config,
        output,
        definition_revision,
        source_revisions,
        declarations,
        created_by,
    )


def refresh_impacted(source_workbook_id: int, changed_cells: list[dict[str, int]], created_by: str) -> list[dict[str, Any]]:
    dependencies = dependencies_for_source(source_workbook_id)
    if changed_cells:
        dependencies = [
            dependency
            for dependency in dependencies
            if any(cell_hits_dependency(cell, dependency) for cell in changed_cells)
        ]
    elementar_ids = sorted({int(item["elementar_workbook_id"]) for item in dependencies})
    return [
        {"workbook_id": elementar_id, **publish_from_snapshots(elementar_id, created_by)}
        for elementar_id in elementar_ids
    ]


def replace_dependencies(
    elementar_workbook_id: int,
    definition_revision: int,
    declarations: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]] | None, str | None]:
    rows = []
    for index, declaration in enumerate(declarations):
        try:
            source_id = int(declaration["workbook_id"])
            key = str(declaration["key"]).strip()
            workbook_name = str(declaration["workbook_name"]).strip()
            source_range = str(declaration["range"]).replace("$", "").upper()
            bounds = parse_range(source_range)
        except (KeyError, TypeError, ValueError):
            return None, "Declaração Elementar inválida."
        if not key or not workbook_name:
            return None, "Declaração Elementar inválida."
        rows.append({
            "elementar_workbook_id": elementar_workbook_id,
            "source_workbook_id": source_id,
            "declaration_key": key,
            "workbook_name": workbook_name,
            "source_range": source_range,
            "declaration_cell": str(declaration.get("cell") or ""),
            "declaration_order": index,
            "definition_revision": definition_revision,
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


@elementar_automation_api.get("/api/elementar/sources/<int:source_workbook_id>/dependencies")
def source_dependencies(source_workbook_id: int):
    workbook, response = get_workbook(source_workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    _, role, error = require_project(int(workbook["project_id"]), "viewer")
    if error:
        return error
    dependencies = dependencies_for_source(source_workbook_id)
    ranges = []
    seen = set()
    for item in dependencies:
        key = (
            int(item["top_row"]), int(item["bottom_row"]),
            int(item["left_col"]), int(item["right_col"]),
        )
        if key in seen:
            continue
        seen.add(key)
        ranges.append({
            "top": key[0], "bottom": key[1], "left": key[2], "right": key[3],
        })
    return jsonify({
        "source_workbook_id": source_workbook_id,
        "revision": int(workbook.get("revision") or 0),
        "role": role,
        "ranges": ranges,
        "dependency_count": len(dependencies),
    })


@elementar_automation_api.post("/api/elementar/sources/<int:source_workbook_id>/calculated-snapshot")
def calculated_snapshot(source_workbook_id: int):
    workbook, response = get_workbook(source_workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    _, _, error = require_project(int(workbook["project_id"]), "editor")
    if error:
        return error
    body = json_body()
    try:
        revision = int(body.get("revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão calculada inválida."}), 400
    current_revision = int(workbook.get("revision") or 0)
    if revision != current_revision:
        return jsonify({
            "error": "Os valores calculados pertencem a uma revisão desatualizada.",
            "current_revision": current_revision,
        }), 409
    cells, message = normalize_cells(body.get("cells"))
    if message:
        return jsonify({"error": message}), 400
    _, save_error = save_source_snapshot(source_workbook_id, revision, cells or [], current_email())
    if save_error:
        return save_error
    changed_cells = normalize_changed_cells(body.get("changed_cells"))
    results = refresh_impacted(source_workbook_id, changed_cells, current_email() or SYSTEM_PUBLISHER)
    return jsonify({
        "source_workbook_id": source_workbook_id,
        "revision": revision,
        "results": results,
        "published": sum(1 for item in results if item.get("status") == "published"),
        "unchanged": sum(1 for item in results if item.get("status") == "unchanged"),
        "pending": sum(1 for item in results if item.get("status") == "pending"),
    })


@elementar_automation_api.post("/api/elementar/workbooks/<int:workbook_id>/auto-publish")
def auto_publish(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar a Elementar")
    if not workbook:
        return jsonify({"error": "Planilha não encontrada."}), 404
    _, role, error = require_project(int(workbook["project_id"]), "editor")
    if error:
        return error
    config = config_for(workbook_id)
    if not config:
        return jsonify({"error": "Esta planilha não é Elementar."}), 404
    body = json_body()
    payload = body.get("payload")
    declarations = body.get("declarations")
    sources = body.get("sources")
    if not isinstance(payload, dict) or not isinstance(declarations, list) or not isinstance(sources, list):
        return jsonify({"error": "Publicação automática inválida."}), 400
    try:
        definition_revision = int(body.get("definition_revision"))
    except (TypeError, ValueError):
        return jsonify({"error": "Revisão da Elementar inválida."}), 400
    if definition_revision != int(workbook.get("revision") or 0):
        return jsonify({"error": "A definição Elementar mudou durante o cálculo."}), 409

    source_revisions: dict[str, int] = {}
    for item in sources:
        try:
            source_id = int(item["id"])
            revision = int(item["revision"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "Origem Elementar inválida."}), 400
        source, source_response = get_workbook(source_id)
        if not source_response.ok or not source:
            return jsonify({"error": "Uma origem não está disponível."}), 409
        if int(source.get("revision") or 0) != revision:
            return jsonify({"error": f"A planilha {source.get('name')} mudou durante o cálculo."}), 409
        source_revisions[str(source_id)] = revision

    _, message = replace_dependencies(workbook_id, definition_revision, declarations)
    if message:
        return jsonify({"error": message}), 400

    for source_snapshot in body.get("source_cells", []):
        if not isinstance(source_snapshot, dict):
            continue
        try:
            source_id = int(source_snapshot["id"])
            revision = int(source_snapshot["revision"])
        except (KeyError, TypeError, ValueError):
            continue
        if source_revisions.get(str(source_id)) != revision:
            continue
        cells, cells_error = normalize_cells(source_snapshot.get("cells"))
        if cells_error:
            return jsonify({"error": cells_error}), 400
        _, save_error = save_source_snapshot(source_id, revision, cells or [], current_email())
        if save_error:
            return save_error

    result = create_publication(
        config,
        payload,
        definition_revision,
        source_revisions,
        declarations,
        current_email() or SYSTEM_PUBLISHER,
    )
    if result.get("status") == "error":
        return jsonify({"error": result.get("error")}), 409
    refreshed_config = config_for(workbook_id) or config
    return jsonify({
        **publication_view(refreshed_config),
        "role": role,
        **result,
    })
