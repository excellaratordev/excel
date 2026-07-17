from __future__ import annotations

import json
import re
import secrets
import unicodedata
from typing import Any

from flask import Blueprint, jsonify, make_response, request

from backend import api_error, current_email, db, fetch_one, get_workbook, json_body, require_project
from superexcel.core.file_pipeline import (
    FILE_KIND_BASE,
    STAGE_PUBLICATION,
    STAGE_TREATED,
    is_elementar,
)


elementar_api = Blueprint("elementar_api", __name__)
MAX_REFS, MAX_SOURCES = 100, 20
MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES = 20 * 1024 * 1024, 2 * 1024 * 1024
MAX_SOURCE_CELLS = 250_000
MAX_SOURCE_ROW = 100_000
RANGE_RE = re.compile(r"^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def slugify(value: Any) -> str:
    value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:72] or "elementar"


def config_for(workbook_id: int):
    return fetch_one("elementar_configs", {"select": "*", "workbook_id": f"eq.{workbook_id}"})


def access(workbook_id: int, role="viewer"):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, api_error(response, "Erro ao abrir a Elementar")
    if not workbook:
        return None, None, (jsonify({"error": "Arquivo não encontrado."}), 404)
    _, current_role, error = require_project(int(workbook["project_id"]), role)
    return workbook, current_role, error


def publication(config):
    if not config.get("last_publication_id"):
        return None
    row, response = fetch_one("elementar_publications", {
        "select": "id,version,definition_revision,source_revisions,declarations,created_by_email,created_at",
        "id": f"eq.{config['last_publication_id']}",
    })
    return row if response.ok else None


def view(config, current_role=None):
    public = f"/public/elementar/{config['public_token']}" if config["visibility"] == "public" else None
    return {
        "enabled": True,
        "convertible": False,
        "role": current_role,
        "workbook_id": int(config["workbook_id"]),
        "project_id": int(config["project_id"]),
        "file_kind": "elementar",
        "pipeline_stage": STAGE_PUBLICATION,
        "slug": config["slug"],
        "visibility": config["visibility"],
        "public_token": config["public_token"],
        "last_publication_version": int(config.get("last_publication_version") or 0),
        "publication": publication(config),
        "authenticated_endpoint": f"/api/elementar/data/{config['slug']}",
        "public_endpoint": public,
    }


def ensure(workbook, create=False):
    if not is_elementar(workbook):
        return None, (
            jsonify({
                "error": "Uma Elementar deve ser criada na etapa 4 do pipeline. Uma planilha comum não pode ser convertida.",
            }),
            409,
        )
    row, response = config_for(int(workbook["id"]))
    if not response.ok:
        return None, api_error(response, "Erro ao verificar a configuração Elementar")
    if row or not create:
        return row, None
    payload = {
        "workbook_id": int(workbook["id"]),
        "project_id": int(workbook["project_id"]),
        "slug": f"{slugify(workbook.get('name'))}-{workbook['id']}",
        "visibility": "private",
        "public_token": secrets.token_urlsafe(32),
        "created_by_email": current_email(),
    }
    response = db("POST", "elementar_configs", payload=payload, prefer="return=representation")
    return (response.json()[0], None) if response.ok and response.json() else (None, api_error(response, "Erro ao ativar a Elementar"))


def normalize_refs(value):
    if not isinstance(value, list) or not value or len(value) > MAX_REFS:
        return None, "A Elementar precisa ter entre 1 e 100 declarações."
    output, keys = [], set()
    for item in value:
        if not isinstance(item, dict):
            return None, "Declaração inválida."
        key = str(item.get("key", "")).strip()
        name = str(item.get("workbook_name", "")).strip()
        address = str(item.get("range", "")).strip().upper()
        if not key or not name or not RANGE_RE.fullmatch(address):
            return None, f"Declaração inválida: {key or 'sem nome'}."
        if key in keys:
            return None, f"O elemento {key} foi declarado mais de uma vez."
        keys.add(key)
        output.append({"key": key, "workbook_name": name, "range": address, "cell": str(item.get("cell", ""))})
    return output, None


def column_index(name: str) -> int:
    result = 0
    for character in str(name).replace("$", "").upper():
        result = result * 26 + ord(character) - 64
    return result - 1


def parse_address(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?(\d+)", str(value).upper())
    if not match:
        raise ValueError("Intervalo inválido.")
    row = int(match.group(2)) - 1
    col = column_index(match.group(1))
    if row < 0 or row >= MAX_SOURCE_ROW or col < 0:
        raise ValueError(f"A Elementar aceita linhas até {MAX_SOURCE_ROW}.")
    return row, col


def parse_range(value: str) -> dict[str, int]:
    start_text, *end_text = str(value).split(":", 1)
    start = parse_address(start_text)
    end = parse_address(end_text[0] if end_text else start_text)
    return {
        "top": min(start[0], end[0]),
        "bottom": max(start[0], end[0]),
        "left": min(start[1], end[1]),
        "right": max(start[1], end[1]),
    }


def base_columns(workbook_id: int) -> tuple[list[dict[str, Any]], Any]:
    response = db("GET", "base_columns", params={
        "select": "id,column_key,name,data_type,position",
        "workbook_id": f"eq.{workbook_id}",
        "order": "position.asc,id.asc",
    })
    return (response.json() if response.ok else []), response


def relational_source_payload(source: dict[str, Any], references: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str | None]:
    columns, response = base_columns(int(source["id"]))
    if not response.ok:
        return None, "Erro ao carregar as colunas da Base 2."
    bounds = []
    area = 0
    try:
        for reference in references:
            current = parse_range(reference["range"])
            if current["right"] >= len(columns):
                return None, f"A Base 2 {source['name']} não possui a coluna usada em {reference['range']}."
            area += (current["bottom"] - current["top"] + 1) * (current["right"] - current["left"] + 1)
            bounds.append(current)
    except ValueError as error:
        return None, str(error)
    if area > MAX_SOURCE_CELLS:
        return None, f"As declarações de {source['name']} excedem {MAX_SOURCE_CELLS:,} células."

    requested: dict[int, set[int]] = {}
    for current in bounds:
        for row in range(current["top"], current["bottom"] + 1):
            requested.setdefault(row, set()).update(range(current["left"], current["right"] + 1))

    cells: list[dict[str, Any]] = []
    for col in sorted(requested.get(0, set())):
        cells.append({"r": 0, "c": col, "v": columns[col]["name"]})

    data_rows = sorted(row for row in requested if row > 0)
    if data_rows:
        first_sheet_row, last_sheet_row = data_rows[0], data_rows[-1]
        offset = first_sheet_row - 1
        limit = last_sheet_row - first_sheet_row + 1
        response = db("GET", "base_rows", params={
            "select": "row_order,values",
            "workbook_id": f"eq.{source['id']}",
            "order": "row_order.asc,id.asc",
            "offset": str(offset),
            "limit": str(limit),
        })
        if not response.ok:
            return None, "Erro ao carregar os registros da Base 2."
        for index, row in enumerate(response.json()):
            sheet_row = first_sheet_row + index
            for col in sorted(requested.get(sheet_row, set())):
                value = (row.get("values") or {}).get(columns[col]["column_key"])
                if value is not None and value != "":
                    cells.append({"r": sheet_row, "c": col, "v": value})

    payload = {
        "version": 1,
        "storage": "sparse",
        "name": source["name"],
        "rows": max((item["bottom"] for item in bounds), default=0) + 1,
        "cols": max((item["right"] for item in bounds), default=-1) + 1,
        "cells": cells,
        "source": "relational-base",
        "pipeline_stage": STAGE_TREATED,
    }
    return payload, None


def replace_file_dependencies(project_id: int, target_id: int, source_ids: list[int]) -> Any | None:
    response = db(
        "DELETE",
        "file_dependencies",
        params={"target_workbook_id": f"eq.{target_id}"},
        prefer="return=minimal",
    )
    if not response.ok:
        return api_error(response, "Erro ao atualizar o pipeline da Elementar")
    if not source_ids:
        return None
    response = db(
        "POST",
        "file_dependencies",
        payload=[{
            "project_id": project_id,
            "source_workbook_id": source_id,
            "target_workbook_id": target_id,
            "created_by_email": current_email(),
        } for source_id in source_ids],
        prefer="return=minimal",
    )
    return None if response.ok else api_error(response, "Erro ao registrar as origens tratadas")


@elementar_api.get("/api/elementar")
def list_elementar():
    try:
        project_id = int(request.args.get("project_id", ""))
    except ValueError:
        return jsonify({"error": "Projeto inválido."}), 400
    _, _, error = require_project(project_id, "viewer")
    if error:
        return error
    response = db("GET", "elementar_configs", params={
        "select": "workbook_id,project_id,slug,visibility,last_publication_version,updated_at",
        "project_id": f"eq.{project_id}",
        "order": "updated_at.desc",
    })
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar Elementares")


@elementar_api.post("/api/elementar/workbooks/<int:workbook_id>/enable")
def enable(workbook_id):
    workbook, role, error = access(workbook_id, "editor")
    if error:
        return error
    config, error = ensure(workbook, True)
    return error or jsonify(view(config, role))


@elementar_api.get("/api/elementar/workbooks/<int:workbook_id>")
def get_config(workbook_id):
    workbook, role, error = access(workbook_id)
    if error:
        return error
    config, response = config_for(workbook_id)
    if not response.ok:
        return api_error(response, "Erro ao carregar a Elementar")
    if config:
        return jsonify(view(config, role))
    return jsonify({
        "enabled": False,
        "convertible": False,
        "role": role,
        "workbook_id": workbook_id,
        "project_id": workbook["project_id"],
        "file_kind": workbook.get("file_kind"),
        "pipeline_stage": workbook.get("pipeline_stage"),
    })


@elementar_api.patch("/api/elementar/workbooks/<int:workbook_id>/settings")
def settings(workbook_id):
    workbook, role, error = access(workbook_id, "editor")
    if error:
        return error
    config, error = ensure(workbook)
    if error:
        return error
    if not config:
        return jsonify({"error": "Este arquivo não é Elementar."}), 404
    body = json_body()
    slug = str(body.get("slug", config["slug"])).strip().lower()
    visibility = str(body.get("visibility", config["visibility"])).lower()
    if not SLUG_RE.fullmatch(slug) or visibility not in {"private", "public"}:
        return jsonify({"error": "Slug ou visibilidade inválidos."}), 400
    response = db("PATCH", "elementar_configs", params={"workbook_id": f"eq.{workbook_id}"},
                  payload={"slug": slug, "visibility": visibility}, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Este identificador já está em uso."}), 409
    return jsonify(view(response.json()[0], role)) if response.ok and response.json() else api_error(response, "Erro ao configurar a Elementar")


@elementar_api.post("/api/elementar/workbooks/<int:workbook_id>/rotate-token")
def rotate_token(workbook_id):
    workbook, role, error = access(workbook_id, "admin")
    if error:
        return error
    config, error = ensure(workbook)
    if error:
        return error
    if not config:
        return jsonify({"error": "Este arquivo não é Elementar."}), 404
    response = db("PATCH", "elementar_configs", params={"workbook_id": f"eq.{workbook_id}"},
                  payload={"public_token": secrets.token_urlsafe(32)}, prefer="return=representation")
    return jsonify(view(response.json()[0], role)) if response.ok and response.json() else api_error(response, "Erro ao trocar o token")


@elementar_api.delete("/api/elementar/workbooks/<int:workbook_id>")
def disable(workbook_id):
    _, _, error = access(workbook_id, "editor")
    if error:
        return error
    return jsonify({
        "error": "Elementar é a etapa 4 do pipeline e não pode ser convertida. Exclua o arquivo para removê-la.",
    }), 409


@elementar_api.post("/api/elementar/workbooks/<int:workbook_id>/resolve")
def resolve(workbook_id):
    workbook, _, error = access(workbook_id, "editor")
    if error:
        return error
    config, error = ensure(workbook)
    if error:
        return error
    if not config:
        return jsonify({"error": "Este arquivo não é Elementar."}), 404
    refs, message = normalize_refs(json_body().get("references"))
    if message:
        return jsonify({"error": message}), 400

    project_id = int(workbook["project_id"])
    response = db("GET", "workbooks", params={
        "select": "id,name,project_id,revision,file_kind,pipeline_stage,updated_at",
        "project_id": f"eq.{project_id}",
        "file_kind": f"eq.{FILE_KIND_BASE}",
        "pipeline_stage": f"eq.{STAGE_TREATED}",
        "order": "name.asc,id.asc",
    })
    if not response.ok:
        return api_error(response, "Erro ao localizar as Bases tratadas")
    by_name: dict[str, list[dict[str, Any]]] = {}
    for item in response.json():
        by_name.setdefault(str(item["name"]).casefold(), []).append(item)

    selected: dict[int, dict[str, Any]] = {}
    refs_by_source: dict[int, list[dict[str, Any]]] = {}
    resolved = []
    for ref in refs:
        matches = by_name.get(ref["workbook_name"].casefold(), [])
        if not matches:
            return jsonify({
                "error": f"Base 2 não encontrada: {ref['workbook_name']}. A Elementar só pode consumir dados tratados da etapa 3.",
            }), 404
        if len(matches) > 1:
            return jsonify({"error": f"Há mais de uma Base 2 chamada {ref['workbook_name']} neste projeto."}), 409
        source_id = int(matches[0]["id"])
        selected[source_id] = matches[0]
        refs_by_source.setdefault(source_id, []).append(ref)
        resolved.append({**ref, "workbook_id": source_id})
    if len(selected) > MAX_SOURCES:
        return jsonify({"error": "A Elementar excede 20 Bases tratadas de origem."}), 400

    sources = []
    total_size = 0
    for source_id, source in selected.items():
        payload, payload_error = relational_source_payload(source, refs_by_source[source_id])
        if payload_error:
            return jsonify({"error": payload_error}), 400
        result = {**source, "payload": payload}
        total_size += len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        sources.append(result)
    if total_size > MAX_SOURCE_BYTES:
        return jsonify({"error": "As Bases tratadas selecionadas excedem 20 MB."}), 413

    dependency_error = replace_file_dependencies(project_id, workbook_id, sorted(selected))
    if dependency_error:
        return dependency_error
    return jsonify({
        "definition_revision": int(workbook.get("revision") or 1),
        "references": resolved,
        "sources": sources,
    })


def validate_sources(value):
    if not isinstance(value, list) or len(value) > MAX_SOURCES:
        return None
    try:
        output = [{"id": int(item["id"]), "revision": int(item["revision"])} for item in value]
    except (KeyError, TypeError, ValueError):
        return None
    return output if len({item["id"] for item in output}) == len(output) else None


@elementar_api.post("/api/elementar/workbooks/<int:workbook_id>/publish")
def publish(workbook_id):
    workbook, role, error = access(workbook_id, "editor")
    if error:
        return error
    config, error = ensure(workbook)
    if error:
        return error
    if not config:
        return jsonify({"error": "Este arquivo não é Elementar."}), 404
    body = json_body()
    payload = body.get("payload")
    if not isinstance(payload, dict):
        return jsonify({"error": "A saída precisa ser um objeto JSON."}), 400
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        definition_revision = int(body["definition_revision"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Publicação inválida."}), 400
    if len(encoded) > MAX_OUTPUT_BYTES:
        return jsonify({"error": "A saída excede 2 MB."}), 413
    if definition_revision != int(workbook.get("revision") or 1):
        return jsonify({"error": "A Elementar mudou. Gere a prévia novamente."}), 409
    sources = validate_sources(body.get("sources"))
    if sources is None or not isinstance(body.get("declarations"), list):
        return jsonify({"error": "Origens ou declarações inválidas."}), 400

    revisions = {}
    for source in sources:
        row, response = get_workbook(source["id"])
        if not response.ok or not row:
            return jsonify({"error": "Uma Base 2 não está mais disponível."}), 409
        if int(row.get("project_id") or 0) != int(workbook["project_id"]):
            return jsonify({"error": "A origem tratada pertence a outro projeto."}), 409
        if row.get("file_kind") != FILE_KIND_BASE or row.get("pipeline_stage") != STAGE_TREATED:
            return jsonify({"error": f"{row.get('name')} não é uma Base 2 tratada."}), 409
        if int(row.get("revision") or 1) != source["revision"]:
            return jsonify({"error": f"A Base 2 {row.get('name')} mudou. Gere a prévia novamente."}), 409
        revisions[str(source["id"])] = source["revision"]

    latest = db("GET", "elementar_publications", params={
        "select": "version",
        "workbook_id": f"eq.{workbook_id}",
        "order": "version.desc",
        "limit": "1",
    })
    if not latest.ok:
        return api_error(latest, "Erro ao versionar a publicação")
    version = int(latest.json()[0]["version"]) + 1 if latest.json() else 1
    record = {
        "workbook_id": workbook_id,
        "project_id": int(workbook["project_id"]),
        "version": version,
        "payload": payload,
        "definition_revision": definition_revision,
        "source_revisions": revisions,
        "declarations": body["declarations"],
        "created_by_email": current_email(),
    }
    response = db("POST", "elementar_publications", payload=record, prefer="return=representation")
    if response.status_code == 409:
        record["version"] += 1
        response = db("POST", "elementar_publications", payload=record, prefer="return=representation")
    if not response.ok or not response.json():
        return api_error(response, "Erro ao publicar a Elementar")
    published = response.json()[0]
    response = db("PATCH", "elementar_configs", params={"workbook_id": f"eq.{workbook_id}"}, payload={
        "last_publication_id": published["id"],
        "last_publication_version": published["version"],
        "published_at": published.get("created_at"),
    }, prefer="return=representation")
    return jsonify({**view(response.json()[0], role), "payload_bytes": len(encoded)}) if response.ok and response.json() else api_error(response, "Erro ao ativar a publicação")


def serve(config):
    if not config.get("last_publication_id"):
        return jsonify({"error": "Esta Elementar ainda não foi publicada."}), 404
    row, response = fetch_one("elementar_publications", {
        "select": "id,version,payload,created_at",
        "id": f"eq.{config['last_publication_id']}",
    })
    if not response.ok or not row:
        return jsonify({"error": "Publicação não encontrada."}), 404
    etag = f'"elementar-{config["workbook_id"]}-{row["version"]}"'
    output = make_response("", 304) if request.headers.get("If-None-Match") == etag else make_response(jsonify(row["payload"]))
    output.headers.update({
        "ETag": etag,
        "X-Elementar-Version": str(row["version"]),
        "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
    })
    if row.get("created_at"):
        output.headers["X-Elementar-Published-At"] = str(row["created_at"])
    return output


@elementar_api.get("/api/elementar/data/<slug>")
def private_data(slug):
    config, response = fetch_one("elementar_configs", {"select": "*", "slug": f"eq.{slug}"})
    if not response.ok or not config:
        return jsonify({"error": "Elementar não encontrada."}), 404
    _, _, error = require_project(int(config["project_id"]), "viewer")
    return error or serve(config)


@elementar_api.get("/public/elementar/<token>")
def public_data(token):
    config, response = fetch_one("elementar_configs", {
        "select": "*",
        "public_token": f"eq.{token}",
        "visibility": "eq.public",
    })
    if not response.ok or not config:
        return jsonify({"error": "Elementar pública não encontrada."}), 404
    output = make_response(serve(config))
    output.headers["Access-Control-Allow-Origin"] = "*"
    output.headers["Access-Control-Expose-Headers"] = "ETag, X-Elementar-Version, X-Elementar-Published-At"
    return output
