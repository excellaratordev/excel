from __future__ import annotations

from collections.abc import Callable
from typing import Any

from flask import jsonify, request

from superexcel.core.permissions import capabilities_for_role, role_allows


ENDPOINT_CAPABILITIES = {
    "projects_api.projects_list": "project.view",
    "projects_api.projects_update": "project.rename",
    "projects_api.projects_delete": "project.delete",
    "projects_api.members_list": "members.view",
    "projects_api.members_add": "members.manage",
    "projects_api.members_update": "members.manage",
    "projects_api.members_delete": "members.view",
    "projects_api.share_link_create": "members.manage",
    "files_api.manager_data": "project.view",
    "files_api.create_folder": "folder.create",
    "files_api.move_folder": "folder.move",
    "files_api.delete_folder": "folder.delete",
    "files_api.list_variables": "variables.view",
    "files_api.save_variable": "variables.edit",
    "files_api.delete_variable": "variables.edit",
    "workbooks_api.list_workbooks": "workbook.view",
    "workbooks_api.get_workbook_route": "workbook.view",
    "workbooks_api.sync_workbook": "workbook.view",
    "workbooks_api.move_workbook": "workbook.move",
    "workbooks_api.delete_workbook": "workbook.delete",
    "workbooks_api.presence": "workbook.view",
    "workbooks_api.presence_leave": "workbook.view",
    "collaboration_api.collaboration_config": "workbook.view",
    "collaboration_api.apply_operations": "cell.edit",
    "collaboration_api.patch_workbook": "cell.edit",
    "collaboration_api.workbook_changes": "workbook.view",
    "telemetry_api.record_workbook_telemetry": "telemetry.view",
    "telemetry_api.workbook_telemetry": "telemetry.view",
    "telemetry_api.project_telemetry": "telemetry.view",
}


def install(backend_module: Any) -> None:
    original_get_project_role: Callable = backend_module.get_project_role
    original_list_user_projects: Callable = backend_module.list_user_projects

    def custom_roles(project_id: int) -> dict[str, list[str]]:
        response = backend_module.db(
            "GET",
            "project_roles",
            params={
                "select": "name,capabilities",
                "project_id": f"eq.{int(project_id)}",
                "is_active": "eq.true",
            },
        )
        if not response.ok:
            return {}
        result = {}
        rows = response.json()
        for row in rows if isinstance(rows, list) else []:
            name = str(row.get("name") or "").strip().lower()
            values = row.get("capabilities")
            if name and isinstance(values, list):
                result[name] = [str(value) for value in values]
        return result

    def capability_for_request(minimum_role: str) -> str | None:
        explicit = str(minimum_role or "").strip()
        if "." in explicit:
            return explicit
        mapped = ENDPOINT_CAPABILITIES.get(str(request.endpoint or ""))
        if mapped:
            return mapped
        if request.endpoint == "workbooks_api.save_workbook":
            body = request.get_json(silent=True) or {}
            return "workbook.edit" if body.get("id") else "workbook.create"
        return None

    def require_project(project_id: int, minimum_role: str = "viewer"):
        project, role, response = original_get_project_role(project_id)
        if response is not None:
            return None, None, backend_module.api_error(response, "Erro ao verificar o projeto")
        if not project:
            return None, None, (jsonify({"error": "Projeto não encontrado."}), 404)
        if role is None:
            return None, None, (jsonify({"error": "Você não possui acesso a este projeto."}), 403)
        roles = custom_roles(project_id)
        capability = capability_for_request(minimum_role)
        allowed = role_allows(role, capability, roles) if capability else (
            backend_module.ROLE_RANK.get(role, -1) >= backend_module.ROLE_RANK.get(minimum_role, 10)
        )
        if not allowed:
            return None, None, (
                jsonify({"error": "Você não possui permissão para esta ação.", "required_capability": capability}),
                403,
            )
        enriched = dict(project)
        enriched["capabilities"] = sorted(capabilities_for_role(role, roles))
        return enriched, role, None

    def list_user_projects():
        projects = original_list_user_projects()
        for project in projects:
            role = project.get("role") or "viewer"
            project["capabilities"] = sorted(capabilities_for_role(role, custom_roles(int(project["id"]))))
        return projects

    backend_module.get_project_custom_roles = custom_roles
    backend_module.require_project = require_project
    backend_module.list_user_projects = list_user_projects
