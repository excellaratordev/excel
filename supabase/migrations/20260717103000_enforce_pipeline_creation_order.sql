begin;

create or replace function public.enforce_file_stage_creation_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pipeline_stage = 'source' then
    return new;
  end if;

  if new.pipeline_stage = 'calculation'
     and not exists (
       select 1
       from public.workbooks as predecessor
       where predecessor.project_id = new.project_id
         and predecessor.file_kind = 'base'
         and predecessor.pipeline_stage = 'source'
     ) then
    raise exception 'Crie uma Base de entrada antes da primeira Planilha de cálculo.';
  end if;

  if new.pipeline_stage = 'treated'
     and not exists (
       select 1
       from public.workbooks as predecessor
       where predecessor.project_id = new.project_id
         and predecessor.file_kind = 'spreadsheet'
         and predecessor.pipeline_stage = 'calculation'
     ) then
    raise exception 'Crie uma Planilha de cálculo antes da primeira Base 2 tratada.';
  end if;

  if new.pipeline_stage = 'publication'
     and not exists (
       select 1
       from public.workbooks as predecessor
       where predecessor.project_id = new.project_id
         and predecessor.file_kind = 'base'
         and predecessor.pipeline_stage = 'treated'
     ) then
    raise exception 'Crie uma Base 2 tratada antes da primeira Elementar.';
  end if;

  return new;
end;
$$;

drop trigger if exists workbooks_enforce_pipeline_creation_order on public.workbooks;
create trigger workbooks_enforce_pipeline_creation_order
before insert on public.workbooks
for each row execute function public.enforce_file_stage_creation_order();

commit;
