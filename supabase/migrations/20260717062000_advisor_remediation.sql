begin;

alter function public.github_touch_updated_at() set search_path = public;

create index if not exists external_variables_folder_id_idx
  on public.external_variables (folder_id)
  where folder_id is not null;

create index if not exists external_variables_workbook_id_idx
  on public.external_variables (workbook_id)
  where workbook_id is not null;

create index if not exists folders_parent_id_idx
  on public.folders (parent_id)
  where parent_id is not null;

create index if not exists resource_permissions_folder_id_idx
  on public.resource_permissions (folder_id)
  where folder_id is not null;

create index if not exists resource_permissions_workbook_id_idx
  on public.resource_permissions (workbook_id)
  where workbook_id is not null;

create index if not exists workbooks_folder_id_idx
  on public.workbooks (folder_id)
  where folder_id is not null;

drop policy if exists architecture_backend_only on public.project_roles;
create policy architecture_backend_only on public.project_roles
  for all to anon, authenticated using (false) with check (false);

drop policy if exists architecture_backend_only on public.workbook_checkpoints;
create policy architecture_backend_only on public.workbook_checkpoints
  for all to anon, authenticated using (false) with check (false);

drop policy if exists architecture_backend_only on public.workbook_chunks;
create policy architecture_backend_only on public.workbook_chunks
  for all to anon, authenticated using (false) with check (false);

drop policy if exists architecture_backend_only on public.workbook_telemetry_samples;
create policy architecture_backend_only on public.workbook_telemetry_samples
  for all to anon, authenticated using (false) with check (false);

comment on function public.can_read_workbook_change(bigint) is
  'Intentional SECURITY DEFINER helper restricted to authenticated and service_role; used only by workbook_changes RLS membership checks.';

commit;
