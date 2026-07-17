begin;

create table if not exists public.treated_base_bindings (
  target_workbook_id bigint primary key references public.workbooks(id) on delete cascade,
  project_id bigint not null references public.projects(id) on delete cascade,
  source_workbook_id bigint not null references public.workbooks(id) on delete cascade,
  source_name text not null,
  source_range text not null,
  top_row integer not null check (top_row >= 0),
  bottom_row integer not null check (bottom_row >= top_row),
  left_col integer not null check (left_col >= 0),
  right_col integer not null check (right_col >= left_col),
  header_row boolean not null default true,
  source_revision bigint not null default 0 check (source_revision >= 0),
  synced_at timestamptz,
  synced_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text
);

create index if not exists treated_base_bindings_source_idx
  on public.treated_base_bindings (source_workbook_id, target_workbook_id);

create table if not exists public.treated_base_source_snapshots (
  source_workbook_id bigint primary key references public.workbooks(id) on delete cascade,
  revision bigint not null check (revision > 0),
  payload jsonb not null default '{"version":1,"cells":[]}'::jsonb,
  payload_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  constraint treated_base_source_snapshot_payload_check check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(coalesce(payload -> 'cells', '[]'::jsonb)) = 'array'
  )
);

create or replace function public.validate_treated_base_binding()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  source_row public.workbooks%rowtype;
  target_row public.workbooks%rowtype;
begin
  select * into source_row from public.workbooks where id = new.source_workbook_id;
  select * into target_row from public.workbooks where id = new.target_workbook_id;

  if source_row.id is null
     or source_row.file_kind is distinct from 'spreadsheet'
     or source_row.pipeline_stage is distinct from 'calculation' then
    raise exception 'A origem da Base 2 deve ser uma Planilha da etapa 2.';
  end if;

  if target_row.id is null
     or target_row.file_kind is distinct from 'base'
     or target_row.pipeline_stage is distinct from 'treated' then
    raise exception 'O destino deve ser uma Base 2 tratada.';
  end if;

  if source_row.project_id is distinct from target_row.project_id
     or new.project_id is distinct from source_row.project_id then
    raise exception 'Planilha e Base 2 devem pertencer ao mesmo projeto.';
  end if;

  if (new.bottom_row - new.top_row + 1)::bigint
     * (new.right_col - new.left_col + 1)::bigint > 100000 then
    raise exception 'A seleção da Base 2 excede 100.000 células.';
  end if;

  return new;
end;
$$;

drop trigger if exists treated_base_bindings_validate on public.treated_base_bindings;
create trigger treated_base_bindings_validate
before insert or update on public.treated_base_bindings
for each row execute function public.validate_treated_base_binding();

create or replace function public.validate_treated_base_source_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  source_row public.workbooks%rowtype;
begin
  select * into source_row from public.workbooks where id = new.source_workbook_id;
  if source_row.id is null
     or source_row.file_kind is distinct from 'spreadsheet'
     or source_row.pipeline_stage is distinct from 'calculation' then
    raise exception 'O snapshot tratado exige uma Planilha da etapa 2.';
  end if;
  return new;
end;
$$;

drop trigger if exists treated_base_source_snapshots_validate on public.treated_base_source_snapshots;
create trigger treated_base_source_snapshots_validate
before insert or update on public.treated_base_source_snapshots
for each row execute function public.validate_treated_base_source_snapshot();

create or replace function public.materialize_treated_base(
  p_target_workbook_id bigint,
  p_source_workbook_id bigint,
  p_source_revision bigint,
  p_source_range text,
  p_columns jsonb,
  p_rows jsonb,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.workbooks%rowtype;
  target_row public.workbooks%rowtype;
  target_revision bigint;
  inserted_columns integer := 0;
  inserted_rows integer := 0;
begin
  select * into source_row from public.workbooks where id = p_source_workbook_id for share;
  select * into target_row from public.workbooks where id = p_target_workbook_id for update;

  if source_row.id is null
     or source_row.file_kind is distinct from 'spreadsheet'
     or source_row.pipeline_stage is distinct from 'calculation' then
    raise exception 'A origem deve ser uma Planilha da etapa 2.';
  end if;

  if target_row.id is null
     or target_row.file_kind is distinct from 'base'
     or target_row.pipeline_stage is distinct from 'treated' then
    raise exception 'O destino deve ser uma Base 2 tratada.';
  end if;

  if source_row.project_id is distinct from target_row.project_id then
    raise exception 'Planilha e Base 2 devem pertencer ao mesmo projeto.';
  end if;

  if jsonb_typeof(p_columns) is distinct from 'array'
     or jsonb_array_length(p_columns) = 0
     or jsonb_array_length(p_columns) > 300 then
    raise exception 'Estrutura de colunas inválida.';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Estrutura de registros inválida.';
  end if;

  delete from public.base_rows where workbook_id = p_target_workbook_id;
  delete from public.base_columns where workbook_id = p_target_workbook_id;

  insert into public.base_columns (
    workbook_id,
    column_key,
    name,
    data_type,
    position,
    required,
    updated_at
  )
  select
    p_target_workbook_id,
    item.value ->> 'column_key',
    item.value ->> 'name',
    coalesce(item.value ->> 'data_type', 'text'),
    coalesce((item.value ->> 'position')::integer, item.ordinality::integer - 1),
    coalesce((item.value ->> 'required')::boolean, false),
    now()
  from jsonb_array_elements(p_columns) with ordinality as item(value, ordinality);
  get diagnostics inserted_columns = row_count;

  insert into public.base_rows (
    workbook_id,
    row_order,
    values,
    revision,
    created_by_email,
    updated_by_email,
    updated_at
  )
  select
    p_target_workbook_id,
    coalesce((item.value ->> 'row_order')::bigint, item.ordinality::bigint - 1),
    coalesce(item.value -> 'values', '{}'::jsonb),
    1,
    p_actor,
    p_actor,
    now()
  from jsonb_array_elements(p_rows) with ordinality as item(value, ordinality);
  get diagnostics inserted_rows = row_count;

  update public.treated_base_bindings
     set source_revision = p_source_revision,
         source_range = p_source_range,
         synced_at = now(),
         synced_by_email = p_actor,
         updated_at = now(),
         updated_by_email = p_actor
   where target_workbook_id = p_target_workbook_id
     and source_workbook_id = p_source_workbook_id;

  update public.workbooks
     set updated_by_email = p_actor,
         updated_at = now()
   where id = p_target_workbook_id;

  select revision into target_revision
  from public.workbooks
  where id = p_target_workbook_id;

  return jsonb_build_object(
    'target_workbook_id', p_target_workbook_id,
    'source_workbook_id', p_source_workbook_id,
    'source_revision', p_source_revision,
    'source_range', p_source_range,
    'column_count', inserted_columns,
    'row_count', inserted_rows,
    'target_revision', target_revision
  );
end;
$$;

revoke all on function public.materialize_treated_base(bigint, bigint, bigint, text, jsonb, jsonb, text) from public;
grant execute on function public.materialize_treated_base(bigint, bigint, bigint, text, jsonb, jsonb, text) to service_role;

alter table public.treated_base_bindings enable row level security;
alter table public.treated_base_source_snapshots enable row level security;

commit;
