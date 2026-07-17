begin;

create index if not exists elementar_configs_last_publication_idx
  on public.elementar_configs (last_publication_id)
  where last_publication_id is not null;

create index if not exists elementar_publications_project_idx
  on public.elementar_publications (project_id, version desc);

commit;
