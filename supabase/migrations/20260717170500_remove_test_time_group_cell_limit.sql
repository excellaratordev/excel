begin;

create or replace function public.validate_test_time_group()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  session_row public.test_time_sessions%rowtype;
  workbook_row public.workbooks%rowtype;
begin
  select * into session_row from public.test_time_sessions where id = new.session_id;
  select * into workbook_row from public.workbooks where id = new.workbook_id;

  if session_row.id is null then
    raise exception 'Sessão Test Time não encontrada.';
  end if;
  if session_row.status not in ('setup', 'running') then
    raise exception 'A sessão Test Time já foi encerrada.';
  end if;
  if workbook_row.id is null or workbook_row.project_id is distinct from session_row.project_id then
    raise exception 'O arquivo monitorado deve pertencer ao projeto do teste.';
  end if;

  new.project_id := session_row.project_id;
  new.workbook_name := workbook_row.name;
  new.file_kind := workbook_row.file_kind;
  new.pipeline_stage := workbook_row.pipeline_stage;
  new.stage_number := public.test_time_stage_number(workbook_row.pipeline_stage);
  new.mode := case
    when workbook_row.pipeline_stage = 'publication' then 'elementar'
    when workbook_row.file_kind = 'base' then 'base'
    else 'sheet'
  end;
  new.updated_at := clock_timestamp();

  if new.stage_number = 0 then
    raise exception 'Etapa de arquivo inválida para Test Time.';
  end if;
  return new;
end;
$$;

commit;
