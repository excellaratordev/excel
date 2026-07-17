begin;

create index if not exists file_dependencies_target_idx
  on public.file_dependencies (target_workbook_id, source_workbook_id);

commit;
