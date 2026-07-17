begin;

with active_publications as (
  select
    config.workbook_id as elementar_workbook_id,
    publication.definition_revision,
    publication.source_revisions,
    publication.declarations,
    publication.payload
  from public.elementar_configs as config
  join public.elementar_publications as publication
    on publication.id = config.last_publication_id
  where jsonb_typeof(publication.declarations) = 'array'
),
expanded as (
  select
    active.*,
    declaration.value as declaration,
    (declaration.ordinality - 1)::integer as declaration_order,
    upper(replace(declaration.value ->> 'range', '$', '')) as range_text
  from active_publications as active
  cross join lateral jsonb_array_elements(active.declarations)
    with ordinality as declaration(value, ordinality)
),
addresses as (
  select
    expanded.*,
    split_part(range_text, ':', 1) as start_address,
    coalesce(
      nullif(split_part(range_text, ':', 2), ''),
      split_part(range_text, ':', 1)
    ) as end_address
  from expanded
),
parts as (
  select
    addresses.*,
    substring(start_address from '^[A-Z]{1,3}') as start_column,
    substring(end_address from '^[A-Z]{1,3}') as end_column,
    substring(start_address from '[0-9]+$')::integer - 1 as start_row,
    substring(end_address from '[0-9]+$')::integer - 1 as end_row
  from addresses
  where start_address ~ '^[A-Z]{1,3}[0-9]+$'
    and end_address ~ '^[A-Z]{1,3}[0-9]+$'
    and declaration ? 'key'
    and declaration ? 'workbook_id'
    and declaration ? 'workbook_name'
),
bounds as (
  select
    parts.*,
    case length(start_column)
      when 1 then ascii(substr(start_column, 1, 1)) - 65
      when 2 then (ascii(substr(start_column, 1, 1)) - 64) * 26
                  + ascii(substr(start_column, 2, 1)) - 65
      when 3 then (ascii(substr(start_column, 1, 1)) - 64) * 676
                  + (ascii(substr(start_column, 2, 1)) - 64) * 26
                  + ascii(substr(start_column, 3, 1)) - 65
    end as start_col,
    case length(end_column)
      when 1 then ascii(substr(end_column, 1, 1)) - 65
      when 2 then (ascii(substr(end_column, 1, 1)) - 64) * 26
                  + ascii(substr(end_column, 2, 1)) - 65
      when 3 then (ascii(substr(end_column, 1, 1)) - 64) * 676
                  + (ascii(substr(end_column, 2, 1)) - 64) * 26
                  + ascii(substr(end_column, 3, 1)) - 65
    end as end_col
  from parts
)
insert into public.elementar_dependencies (
  elementar_workbook_id,
  source_workbook_id,
  declaration_key,
  workbook_name,
  source_range,
  declaration_cell,
  declaration_order,
  top_row,
  bottom_row,
  left_col,
  right_col,
  definition_revision,
  last_value,
  last_source_revision,
  updated_at
)
select
  elementar_workbook_id,
  (declaration ->> 'workbook_id')::bigint,
  declaration ->> 'key',
  declaration ->> 'workbook_name',
  range_text,
  coalesce(declaration ->> 'cell', ''),
  declaration_order,
  least(start_row, end_row),
  greatest(start_row, end_row),
  least(start_col, end_col),
  greatest(start_col, end_col),
  definition_revision,
  payload #> string_to_array(declaration ->> 'key', '.'),
  coalesce((source_revisions ->> (declaration ->> 'workbook_id'))::bigint, 0),
  now()
from bounds
where start_row >= 0
  and end_row >= 0
  and start_col >= 0
  and end_col >= 0
on conflict (elementar_workbook_id, declaration_key)
do update set
  source_workbook_id = excluded.source_workbook_id,
  workbook_name = excluded.workbook_name,
  source_range = excluded.source_range,
  declaration_cell = excluded.declaration_cell,
  declaration_order = excluded.declaration_order,
  top_row = excluded.top_row,
  bottom_row = excluded.bottom_row,
  left_col = excluded.left_col,
  right_col = excluded.right_col,
  definition_revision = excluded.definition_revision,
  last_value = excluded.last_value,
  last_source_revision = excluded.last_source_revision,
  updated_at = now();

commit;
