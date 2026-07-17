begin;

alter table public.base_rows
  add column if not exists formulas jsonb not null default '{}'::jsonb;

alter table public.base_rows
  drop constraint if exists base_rows_formulas_object_check;

alter table public.base_rows
  add constraint base_rows_formulas_object_check
  check (jsonb_typeof(formulas) = 'object');

-- Values beginning with = that were already saved in a treated Base are moved
-- to formula metadata. The downstream relational value becomes null until the
-- calculation sheet supplies the actual result.
with migrated as (
  select
    row_data.id,
    coalesce(
      jsonb_object_agg(cell.key, cell.value)
        filter (
          where jsonb_typeof(cell.value) = 'string'
            and left(ltrim(cell.value #>> '{}'), 1) = '='
        ),
      '{}'::jsonb
    ) as formulas,
    coalesce(
      jsonb_object_agg(
        cell.key,
        case
          when jsonb_typeof(cell.value) = 'string'
            and left(ltrim(cell.value #>> '{}'), 1) = '='
          then 'null'::jsonb
          else cell.value
        end
      ),
      '{}'::jsonb
    ) as values
  from public.base_rows as row_data
  join public.workbooks as workbook
    on workbook.id = row_data.workbook_id
   and workbook.file_kind = 'base'
   and workbook.pipeline_stage = 'treated'
  cross join lateral jsonb_each(row_data.values) as cell
  group by row_data.id
)
update public.base_rows as row_data
set formulas = row_data.formulas || migrated.formulas,
    values = migrated.values,
    updated_at = clock_timestamp()
from migrated
where migrated.id = row_data.id
  and migrated.formulas <> '{}'::jsonb;

create index if not exists base_rows_formulas_gin_idx
  on public.base_rows using gin (formulas);

create or replace function public.set_treated_base_formula_result(
  p_workbook_id bigint,
  p_row_id bigint,
  p_column_key text,
  p_formula text,
  p_value jsonb,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  workbook_row public.workbooks%rowtype;
  row_data public.base_rows%rowtype;
  current_formula text;
  calculated_at timestamptz := clock_timestamp();
begin
  select * into workbook_row
  from public.workbooks
  where id = p_workbook_id;

  if workbook_row.id is null
     or workbook_row.file_kind is distinct from 'base'
     or workbook_row.pipeline_stage is distinct from 'treated' then
    raise exception 'O resultado calculado exige uma Base 2 tratada.';
  end if;

  if p_column_key is null or btrim(p_column_key) = '' then
    raise exception 'Coluna da fórmula inválida.';
  end if;

  if not exists (
    select 1
    from public.base_columns as base_column
    where base_column.workbook_id = p_workbook_id
      and base_column.column_key = p_column_key
  ) then
    raise exception 'Coluna da fórmula não encontrada.';
  end if;

  select * into row_data
  from public.base_rows
  where id = p_row_id
    and workbook_id = p_workbook_id
  for update;

  if row_data.id is null then
    raise exception 'Registro da fórmula não encontrado.';
  end if;

  current_formula := row_data.formulas ->> p_column_key;
  if current_formula is distinct from p_formula then
    return jsonb_build_object(
      'status', 'stale',
      'row_id', p_row_id,
      'column_key', p_column_key,
      'formula', current_formula
    );
  end if;

  update public.base_rows
     set values = jsonb_set(
           coalesce(values, '{}'::jsonb),
           array[p_column_key],
           coalesce(p_value, 'null'::jsonb),
           true
         ),
         updated_by_email = p_actor,
         updated_at = calculated_at
   where id = p_row_id
     and workbook_id = p_workbook_id;

  return jsonb_build_object(
    'status', 'updated',
    'row_id', p_row_id,
    'column_key', p_column_key,
    'formula', p_formula,
    'value', p_value,
    'updated_at', calculated_at
  );
end;
$$;

commit;
