from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend import (
    api_error,
    current_email,
    db,
    fetch_one,
    get_folder,
    json_body,
    parse_nullable_id,
    parse_required_id,
    require_project,
)

files_api = Blueprint("files_api", __name__)


@files_api.get("/api/manager")
def manager_data():
    project_id, error_text = parse_required_id(request.args.get("project_id"), "Projeto")
    if error_text:
        return jsonify({"error": error_text}), 400
    project, role, error = require_project(project_id, "viewer")
    if error:
        return error
    folder_id, error_text = parse_nullable_id(request.args.get("folder_id"), "Pasta")
    if error_text:
        return jsonify({"error": error_text}), 400
    current_folder = None
    if folder_id is not None:
        current_folder, response = get_folder(folder_id)
        if not response.ok:
            return api_error(response, "Erro ao abrir pasta")
        if not current_folder or int(current_folder.get("project_id") or 0) != project_id:
            return jsonify({"error": "Pasta não encontrada neste projeto."}), 404
    folder_filter = "is.null" if folder_id is None else f"eq.{folder_id}"
    folders = db("GET", "folders", params={"select": "id,name,parent_id,project_id,updated_at", "project_id": f"eq.{project_id}", "parent_id": folder_filter, "order": "name.asc"})
    books = db("GET", "workbooks", params={"select": "id,name,folder_id,project_id,revision,created_at,updated_at,updated_by_email", "project_id": f"eq.{project_id}", "folder_id": folder_filter, "order": "name.asc"})
    if not folders.ok:
        return api_error(folders, "Erro ao listar pastas")
    if not books.ok:
        return api_error(books, "Erro ao listar planilhas")
    return jsonify({"project": project, "role": role, "current_folder": current_folder, "folders": folders.json(), "workbooks": books.json()})


@files_api.post("/api/folders")
def create_folder():
    body = json_body()
    project_id, error_text = parse_required_id(body.get("project_id"), "Projeto")
    if error_text:
        return jsonify({"error": error_text}), 400
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Informe o nome da pasta."}), 400
    parent_id, error_text = parse_nullable_id(body.get("parent_id"), "Pasta de destino")
    if error_text:
        return jsonify({"error": error_text}), 400
    if parent_id is not None:
        parent, response = get_folder(parent_id)
        if not response.ok:
            return api_error(response, "Erro ao validar a pasta")
        if not parent or int(parent.get("project_id") or 0) != project_id:
            return jsonify({"error": "Pasta de destino não pertence ao projeto."}), 400
    response = db("POST", "folders", payload={"name": name, "parent_id": parent_id, "project_id": project_id, "created_by_email": current_email()}, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma pasta com esse nome neste local."}), 409
    return jsonify(response.json()[0]) if response.ok else api_error(response, "Erro ao criar pasta")


@files_api.patch("/api/folders/<int:folder_id>/move")
def move_folder(folder_id: int):
    folder, response = get_folder(folder_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar pasta")
    if not folder:
        return jsonify({"error": "Pasta não encontrada."}), 404
    project_id = int(folder.get("project_id") or 0)
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    target_id, error_text = parse_nullable_id(json_body().get("parent_id"), "Pasta de destino")
    if error_text:
        return jsonify({"error": error_text}), 400
    if target_id == folder_id:
        return jsonify({"error": "Uma pasta não pode ser movida para dentro dela mesma."}), 400
    response = db("GET", "folders", params={"select": "id,name,parent_id,project_id", "project_id": f"eq.{project_id}"})
    if not response.ok:
        return api_error(response, "Erro ao validar as pastas")
    folders = {int(row["id"]): row for row in response.json()}
    if target_id is not None and target_id not in folders:
        return jsonify({"error": "Pasta de destino não encontrada neste projeto."}), 404
    ancestor_id = target_id
    visited: set[int] = set()
    while ancestor_id is not None:
        if ancestor_id == folder_id:
            return jsonify({"error": "Uma pasta não pode ser movida para dentro de uma de suas subpastas."}), 400
        if ancestor_id in visited:
            return jsonify({"error": "A estrutura de pastas contém um ciclo inválido."}), 409
        visited.add(ancestor_id)
        ancestor = folders.get(ancestor_id)
        ancestor_id = int(ancestor["parent_id"]) if ancestor and ancestor.get("parent_id") is not None else None
    response = db("PATCH", "folders", params={"id": f"eq.{folder_id}"}, payload={"parent_id": target_id}, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma pasta com esse nome no destino."}), 409
    return jsonify(response.json()[0]) if response.ok and response.json() else api_error(response, "Erro ao mover pasta")


@files_api.delete("/api/folders/<int:folder_id>")
def delete_folder(folder_id: int):
    folder, response = get_folder(folder_id)
    if not response.ok:
        return api_error(response, "Erro ao localizar pasta")
    if not folder:
        return jsonify({"error": "Pasta não encontrada."}), 404
    _, _, error = require_project(int(folder.get("project_id") or 0), "editor")
    if error:
        return error
    response = db("DELETE", "folders", params={"id": f"eq.{folder_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir pasta")


@files_api.get("/api/variables")
def list_variables():
    project_id, error_text = parse_required_id(request.args.get("project_id"), "Projeto")
    if error_text:
        return jsonify({"error": error_text}), 400
    _, _, error = require_project(project_id, "viewer")
    if error:
        return error
    response = db("GET", "external_variables", params={"select": "*", "project_id": f"eq.{project_id}", "order": "scope.asc,name.asc"})
    return jsonify(response.json()) if response.ok else api_error(response, "Erro ao listar variáveis")


@files_api.post("/api/variables")
def save_variable():
    body = json_body()
    project_id, error_text = parse_required_id(body.get("project_id"), "Projeto")
    if error_text:
        return jsonify({"error": error_text}), 400
    _, _, error = require_project(project_id, "editor")
    if error:
        return error
    name = str(body.get("name", "")).strip().upper()
    if not name:
        return jsonify({"error": "Informe o nome da variável."}), 400
    response = db("POST", "external_variables", payload={
        "project_id": project_id,
        "name": name,
        "value": body.get("value"),
        "scope": body.get("scope", "global"),
        "folder_id": body.get("folder_id"),
        "workbook_id": body.get("workbook_id"),
        "description": str(body.get("description", "")),
    }, prefer="return=representation")
    if response.status_code == 409:
        return jsonify({"error": "Já existe uma variável com esse nome neste escopo."}), 409
    return jsonify(response.json()[0]) if response.ok else api_error(response, "Erro ao salvar variável")


@files_api.delete("/api/variables/<int:variable_id>")
def delete_variable(variable_id: int):
    variable, response = fetch_one("external_variables", {"select": "id,project_id", "id": f"eq.{variable_id}"})
    if not response.ok:
        return api_error(response, "Erro ao localizar variável")
    if not variable:
        return jsonify({"error": "Variável não encontrada."}), 404
    _, _, error = require_project(int(variable.get("project_id") or 0), "editor")
    if error:
        return error
    response = db("DELETE", "external_variables", params={"id": f"eq.{variable_id}"}, prefer="return=representation")
    return jsonify({"deleted": bool(response.json())}) if response.ok else api_error(response, "Erro ao excluir variável")
