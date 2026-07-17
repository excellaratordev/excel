from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from flask import Blueprint, jsonify, request

from backend import api_error, current_email, db, get_workbook, json_body, require_project
from base_routes import list_columns, parse_total
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    FILE_KIND_SPREADSHEET,
    STAGE_CALCULATION,
    STAGE_SOURCE,
    allowed_transition,
)


base_reference_api = Blueprint("base_reference_api", __name__)

CELL_RE = re.compile(r"^\$?([A-Z]{1,3})\$?([1-9]\d*)$", re.IGNORECASE)
MAX_REFERENCES = 100
MAX_REFERENCE_CELLS = 100_000
MAX_WINDOW_SIZE = 500


def column_index(name: str) -> int:
    result = 0
    for letter in name.upper():
        result = result * 26 + ord(letter) - 64
    return result - 1


def parse_cell(value: Any) -> tuple[int, int]:
    match = CELL_RE.fullmatch(str(value or "").strip())
    if not match:
        raise ValueError(f"Referência inválida: {value}.")
    return int(match.group(2)) - 1, column_index(match.group(1))


def require_calculation_workbook(workbook_id: int, minimum_role: str = "viewer"):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, api_error(response, "Erro ao localizar a Planilha")
    if not workbook:
        return None, None, (jsonify({"error": "Planilha não encontrada."}), 404)
    if not (
        workbook.get("file_kind") == FILE_KIND_SPREADSHEET
        and workbook.get("pipeline_stage") == STAGE_CALCULATION
    ):
        return None, None, (
            jsonify({"error": "O painel Base está disponível somente em Planilhas de cálculo."}),
            409,
        )
    _, role, error = require_project(int(workbook.get("project_id") or 0), minimum_role)
    if error:
        return None, None, error
    return workbook, role, None


def list_source_bases(project_id: int) -> tuple[list[dict[str, Any]], Any]:
    response = db(
        "GET",
        "workbooks",
        params={
            "select": "id,name,project_id,folder_id,revision,file_kind,pipeline_stage,updated_at,updated_by_email",
            "project_id": f"eq.{project_id}",
            "file_kind": f"eq.{FILE_KIND_BASE}",
            "pipeline_stage": f"eq.{STAGE_SOURCE}",
            "order": "name.asc,id.asc",
        },
    )
    return (response.json() if response.ok else []), response


def source_maps(project_id: int):
    bases, response = list_source_bases(project_id)
    by_id = {int(item["id"]): item for item in bases}
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in bases:
        by_name[str(item.get("name") or "").strip().casefold()].append(item)
    return bases, by_id, by_name, response


def resolve_source(
    reference: dict[str, Any],
    by_id: dict[int, dict[str, Any]],
    by_name: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any] | None, str | None, int]:
    source_id = reference.get("source_id")
    if source_id not in (None, ""):
        try:
            source = by_id.get(int(source_id))
        except (TypeError, ValueError):
            source = None
        if not source:
            return None, "A Base informada não pertence à entrada deste projeto.", 404
        return source, None, 200

    name = str(reference.get("source") or reference.get("source_name") or "").strip()
    if not name:
        return None, "Informe o nome da Base na referência.", 400
    matches = by_name.get(name.casefold(), [])
    if not matches:
        return None, f"Base de entrada não encontrada: {name}.", 404
    if len(matches) > 1:
        return None, (
            f"Há mais de uma Base chamada {name}. Renomeie as Bases para que os nomes sejam únicos no projeto."
        ), 409
    return matches[0], None, 200


def validate_source_transition(source: dict[str, Any], target: dict[str, Any]) -> bool:
    return (
        int(source.get("project_id") or 0) == int(target.get("project_id") or 0)
        and allowed_transition(source.get("pipeline_stage"), target.get("pipeline_stage"))
    )


@base_reference_api.get("/api/workbooks/<int:workbook_id>/base-sources")
def list_available_sources(workbook_id: int):
    workbook, role, error = require_calculation_workbook(workbook_id)
    if error:
        return error
    project_id = int(workbook["project_id"])
    bases, response = list_source_bases(project_id)
    if not response.ok:
        return api_error(response, "Erro ao listar Bases de entrada")
    dependencies = db(
        "GET",
        "file_dependencies",
        params={
            "select": "source_workbook_id",
            "project_id": f"eq.{project_id}",
            "target_workbook_id": f"eq.{workbook_id}",
        },
    )
    if not dependencies.ok:
        return api_error(dependencies, "Erro ao listar dependências da Planilha")
    linked = {int(item["source_workbook_id"]) for item in dependencies.json()}
    return jsonify({
        "workbook_id": workbook_id,
        "project_id": project_id,
        "role": role,
        "sources": [
            {
                "id": int(item["id"]),
                "name": item["name"],
                "revision": int(item.get("revision") or 1),
                "updated_at": item.get("updated_at"),
                "updated_by_email": item.get("updated_by_email"),
                "linked": int(item["id"]) in linked,
            }
            for item in bases
        ],
    })


@base_reference_api.get("/api/workbooks/<int:workbook_id>/base-sources/<int:source_id>")
def read_source_window(workbook_id: int, source_id: int):
    workbook, role, error = require_calculation_workbook(workbook_id)
    if error:
        return error
    source, response = get_workbook(source_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar a Base")
    if not source or not validate_source_transition(source, workbook):
        return jsonify({"error": "Esta Base não pode alimentar a Planilha atual."}), 409
    try:
        offset = max(0, int(request.args.get("offset", "0")))
        limit = min(MAX_WINDOW_SIZE, max(1, int(request.args.get("limit", "200"))))
    except ValueError:
        return jsonify({"error": "Janela da Base inválida."}), 400

    columns, columns_response = list_columns(source_id)
    if not columns_response.ok:
        return api_error(columns_response, "Erro ao carregar colunas da Base")
    rows = db(
        "GET",
        "base_rows",
        params={
            "select": "id,row_order,values,revision,updated_at,updated_by_email",
            "workbook_id": f"eq.{source_id}",
            "order": "row_order.asc,id.asc",
            "offset": str(offset),
            "limit": str(limit),
        },
        prefer="count=exact",
    )
    if not rows.ok:
        return api_error(rows, "Erro ao carregar registros da Base")
    result = rows.json()
    return jsonify({
        "role": role,
        "source": {
            "id": int(source["id"]),
            "name": source["name"],
            "revision": int(source.get("revision") or 1),
            "updated_at": source.get("updated_at"),
        },
        "columns": columns,
        "rows": result,
        "window": {
            "offset": offset,
            "limit": limit,
            "returned": len(result),
            "total": parse_total(rows, offset + len(result)),
        },
    })


@base_reference_api.post("/api/workbooks/<int:workbook_id>/base-reference-values")
def materialize_reference_values(workbook_id: int):
    workbook, role, error = require_calculation_workbook(workbook_id)
    if error:
        return error
    references = json_body().get("references")
    if not isinstance(references, list) or not references or len(references) > MAX_REFERENCES:
        return jsonify({"error": "Informe entre 1 e 100 referências de Base."}), 400

    project_id = int(workbook["project_id"])
    _, by_id, by_name, response = source_maps(project_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar Bases de entrada")

    normalized: list[dict[str, Any]] = []
    total_cells = 0
    for item in references:
        if not isinstance(item, dict):
            return jsonify({"error": "Referência de Base inválida."}), 400
        source, message, status = resolve_source(item, by_id, by_name)
        if message:
            return jsonify({"error": message}), status
        try:
            start_row, start_col = parse_cell(item.get("start"))
            end_row, end_col = parse_cell(item.get("end") or item.get("start"))
        except ValueError as validation_error:
            return jsonify({"error": str(validation_error)}), 400
        top, bottom = sorted((start_row, end_row))
        left, right = sorted((start_col, end_col))
        area = (bottom - top + 1) * (right - left + 1)
        total_cells += area
        if total_cells > MAX_REFERENCE_CELLS:
            return jsonify({"error": "As referências excedem 100.000 células externas."}), 413
        normalized.append({
            "source": source,
            "top": top,
            "bottom": bottom,
            "left": left,
            "right": right,
        })

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for item in normalized:
        grouped[int(item["source"]["id"])].append(item)

    output_sources = []
    for source_id, items in grouped.items():
        source = items[0]["source"]
        columns, columns_response = list_columns(source_id)
        if not columns_response.ok:
            return api_error(columns_response, "Erro ao carregar colunas da Base")
        cell_map: dict[tuple[int, int], Any] = {}
        for item in items:
            if item["right"] >= len(columns):
                return jsonify({
                    "error": f"A Base {source['name']} não possui a coluna solicitada."
                }), 400
            height = item["bottom"] - item["top"] + 1
            rows = db(
                "GET",
                "base_rows",
                params={
                    "select": "row_order,values",
                    "workbook_id": f"eq.{source_id}",
                    "order": "row_order.asc,id.asc",
                    "offset": str(item["top"]),
                    "limit": str(height),
                },
            )
            if not rows.ok:
                return api_error(rows, "Erro ao materializar intervalo da Base")
            for row_offset, row in enumerate(rows.json()):
                logical_row = item["top"] + row_offset
                values = row.get("values") if isinstance(row.get("values"), dict) else {}
                for col in range(item["left"], item["right"] + 1):
                    key = str(columns[col]["column_key"])
                    cell_map[(logical_row, col)] = values.get(key)

        output_sources.append({
            "id": source_id,
            "name": source["name"],
            "revision": int(source.get("revision") or 1),
            "cells": [
                {"r": row, "c": col, "v": value}
                for (row, col), value in sorted(cell_map.items())
            ],
        })

    return jsonify({
        "workbook_id": workbook_id,
        "role": role,
        "cell_count": total_cells,
        "sources": output_sources,
    })


@base_reference_api.post("/api/workbooks/<int:workbook_id>/base-dependencies/sync")
def sync_base_dependencies(workbook_id: int):
    workbook, _, error = require_calculation_workbook(workbook_id, "editor")
    if error:
        return error
    requested = json_body().get("sources")
    if not isinstance(requested, list) or len(requested) > MAX_REFERENCES:
        return jsonify({"error": "Lista de Bases inválida."}), 400

    project_id = int(workbook["project_id"])
    _, by_id, by_name, response = source_maps(project_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar Bases de entrada")

    desired: dict[int, dict[str, Any]] = {}
    for item in requested:
        reference = item if isinstance(item, dict) else {"source": item}
        source, message, status = resolve_source(reference, by_id, by_name)
        if message:
            return jsonify({"error": message}), status
        desired[int(source["id"])] = source

    current_response = db(
        "GET",
        "file_dependencies",
        params={
            "select": "id,source_workbook_id",
            "project_id": f"eq.{project_id}",
            "target_workbook_id": f"eq.{workbook_id}",
        },
    )
    if not current_response.ok:
        return api_error(current_response, "Erro ao carregar dependências atuais")
    current = {int(item["source_workbook_id"]): item for item in current_response.json()}

    missing = [source_id for source_id in desired if source_id not in current]
    if missing:
        insert_response = db(
            "POST",
            "file_dependencies",
            params={"on_conflict": "source_workbook_id,target_workbook_id"},
            payload=[
                {
                    "project_id": project_id,
                    "source_workbook_id": source_id,
                    "target_workbook_id": workbook_id,
                    "created_by_email": current_email(),
                }
                for source_id in missing
            ],
            prefer="resolution=ignore-duplicates,return=minimal",
        )
        if not insert_response.ok:
            return api_error(insert_response, "Erro ao registrar dependências da Base")

    obsolete_ids = [str(item["id"]) for source_id, item in current.items() if source_id not in desired]
    if obsolete_ids:
        delete_response = db(
            "DELETE",
            "file_dependencies",
            params={"id": f"in.({','.join(obsolete_ids)})"},
            prefer="return=minimal",
        )
        if not delete_response.ok:
            return api_error(delete_response, "Erro ao remover dependências antigas")

    return jsonify({
        "workbook_id": workbook_id,
        "source_ids": sorted(desired),
        "dependency_count": len(desired),
    })
