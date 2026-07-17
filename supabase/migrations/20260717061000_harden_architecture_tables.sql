begin;

alter table public.project_roles enable row level security;
alter table public.workbook_checkpoints enable row level security;
alter table public.workbook_chunks enable row level security;
alter table public.workbook_telemetry_samples enable row level security;

revoke all on table public.project_roles from anon, authenticated;
revoke all on table public.workbook_checkpoints from anon, authenticated;
revoke all on table public.workbook_chunks from anon, authenticated;
revoke all on table public.workbook_telemetry_samples from anon, authenticated;
revoke all on table public.workbook_telemetry_latest from anon, authenticated;

grant select, insert, update, delete on table public.project_roles to service_role;
grant select, insert, update, delete on table public.workbook_checkpoints to service_role;
grant select, insert, update, delete on table public.workbook_chunks to service_role;
grant select, insert, update, delete on table public.workbook_telemetry_samples to service_role;
grant select on table public.workbook_telemetry_latest to service_role;
grant usage, select on all sequences in schema public to service_role;

alter view public.workbook_telemetry_latest set (security_invoker = true);

commit;
