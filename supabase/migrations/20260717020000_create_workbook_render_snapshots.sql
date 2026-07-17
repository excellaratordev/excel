create table if not exists public.workbook_render_snapshots (
  workbook_id bigint primary key references public.workbooks(id) on delete cascade,
  revision bigint not null check (revision >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workbook_render_snapshots enable row level security;

create index if not exists workbook_render_snapshots_revision_idx
  on public.workbook_render_snapshots (workbook_id, revision desc);
