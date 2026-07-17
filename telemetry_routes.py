from __future__ import annotations

import math
from typing import Any

from flask import Blueprint, jsonify

from backend import api_error, current_email, db, get_workbook, json_body, require_project
from superexcel.core.workbook_payload import inspect_workbook_payload
from superexcel.telemetry import registry

telemetry_api = Blueprint("telemetry_api", __name__)
NUMERIC_METRICS = {
    "heap_used_bytes", "heap_total_bytes", "heap_limit_bytes", "device_memory_gb",
    "dom_cells", "loaded_cells", "logical_cells", "filled_cells", "formula_cells", "dependency_nodes",
    "dependency_edges", "cache_bytes", "cache_hit_ratio", "pending_operations",
    "calculation_ms", "render_ms", "collaboration_latency_ms", "local_latency_ms", "snapshot_count",
    "delta_recovery_count", "checkpoint_recovery_count", "chunk_count", "stored_cells", "store_bytes",
}
MAX_ABSOLUTE_VALUE = 10**15


def normalize_metrics(value: Any) -> tuple[dict[str, int | float], str | None]:
    if not isinstance(value, dict):
        return {}, "Métricas inválidas."
    normalized: dict[str, int | float] = {}
    for key, raw_value in value.items():
        if key not in NUMERIC_METRICS or isinstance(raw_value, bool):
            continue
        try:
            number = float(raw_value)
        except (TypeError, ValueError):
            return {}, f"Métrica inválida: {key}."
        if not math.isfinite(number) or number < 0 or number > MAX_ABSOLUTE_VALUE:
            return {}, f"Métrica fora do limite: {key}."
        normalized[key] = int(number) if number.is_integer() else number
    if not normalized:
        return {}, "Nenhuma métrica reconhecida foi enviada."
    return normalized, None


def workbook_access(workbook_id: int):
    workbook, response = get_workbook(workbook_id)
    if not response.ok:
        return None, None, None, api_error(response, "Erro ao localizar planilha")
    if not workbook:
        return None, None, None, (jsonify({"error": "Planilha não encontrada."}), 404)
    project, role, error = require_project(int(workbook.get("project_id") or 0), "telemetry.view")
    if error:
        return None, None, None, error
    return workbook, project, role, None


@telemetry_api.post("/api/workbooks/<int:workbook_id>/telemetry")
def record_workbook_telemetry(workbook_id: int):
    workbook, _, role, error = workbook_access(workbook_id)
    if error:
        return error
    body = json_body()
    metrics, error_text = normalize_metrics(body.get("metrics", body))
    if error_text:
        return jsonify({"error": error_text}), 400
    sample: dict[str, Any] = {
        **metrics,
        "revision": int(workbook.get("revision") or 0),
        "user_email": current_email(),
        "role": role,
    }
    client_version = str(body.get("client_version") or "").strip()
    if client_version:
        sample["client_version"] = client_version[:80]
    recorded = registry.record(workbook_id, sample)
    response = db(
        "POST",
        "workbook_telemetry_samples",
        payload={
            "workbook_id": workbook_id,
            "project_id": int(workbook.get("project_id") or 0),
            "revision": int(workbook.get("revision") or 0),
            "user_email": current_email(),
            "client_version": client_version[:80] or None,
            "metrics": metrics,
        },
        prefer="return=minimal",
    )
    return jsonify({"workbook_id": workbook_id, "recorded": recorded, "persisted": response.ok})


@telemetry_api.get("/api/workbooks/<int:workbook_id>/telemetry")
def workbook_telemetry(workbook_id: int):
    workbook, project, _, error = workbook_access(workbook_id)
    if error:
        return error
    payload_workbook, response = get_workbook(workbook_id, include_payload=True)
    if not response.ok:
        return api_error(response, "Erro ao inspecionar planilha")
    samples = db(
        "GET",
        "workbook_telemetry_samples",
        params={
            "select": "revision,user_email,client_version,metrics,created_at",
            "workbook_id": f"eq.{workbook_id}",
            "order": "created_at.desc",
            "limit": "120",
        },
    )
    return jsonify({
        "workbook": {"id": workbook_id, "name": workbook.get("name"), "project_id": workbook.get("project_id"), "revision": workbook.get("revision")},
        "capabilities": project.get("capabilities", []),
        "payload": inspect_workbook_payload((payload_workbook or {}).get("payload")),
        "runtime": registry.summary(workbook_id),
        "samples": samples.json() if samples.ok else [],
    })


@telemetry_api.get("/api/projects/<int:project_id>/telemetry")
def project_telemetry(project_id: int):
    project, _, error = require_project(project_id, "telemetry.view")
    if error:
        return error
    response = db("GET", "workbooks", params={"select": "id,name,revision,updated_at", "project_id": f"eq.{project_id}", "order": "name.asc"})
    if not response.ok:
        return api_error(response, "Erro ao listar métricas das planilhas")
    workbooks = response.json()
    summaries = registry.summaries([int(item["id"]) for item in workbooks])
    latest = db(
        "GET",
        "workbook_telemetry_latest",
        params={"select": "workbook_id,revision,metrics,created_at", "project_id": f"eq.{project_id}"},
    )
    latest_by_id = {int(item["workbook_id"]): item for item in latest.json()} if latest.ok else {}
    return jsonify({
        "project_id": project_id,
        "capabilities": project.get("capabilities", []),
        "workbooks": [{**item, "runtime": summaries[int(item["id"])], "persistent": latest_by_id.get(int(item["id"]))} for item in workbooks],
    })
