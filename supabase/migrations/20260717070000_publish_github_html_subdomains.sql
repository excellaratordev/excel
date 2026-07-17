begin;

create or replace function public.github_default_site_slug(
  repository_full_name text,
  project_identifier bigint
)
returns text
language sql
immutable
set search_path = public
as $$
  select
    left(
      coalesce(
        nullif(
          trim(both '-' from regexp_replace(
            lower(split_part(coalesce(repository_full_name, ''), '/', 2)),
            '[^a-z0-9]+',
            '-',
            'g'
          )),
          ''
        ),
        'site'
      ),
      40
    ) || '-' || project_identifier::text;
$$;

alter table public.github_connections
  add column if not exists site_slug text,
  add column if not exists site_enabled boolean not null default true;

update public.github_connections
set site_slug = public.github_default_site_slug(repository_full_name, project_id)
where site_slug is null or btrim(site_slug) = '';

alter table public.github_connections
  alter column site_slug set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'github_connections_site_slug_format'
      and conrelid = 'public.github_connections'::regclass
  ) then
    alter table public.github_connections
      add constraint github_connections_site_slug_format
      check (
        char_length(site_slug) between 3 and 63
        and site_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
      );
  end if;
end;
$$;

create unique index if not exists github_connections_site_slug_uidx
  on public.github_connections (site_slug);

create or replace function public.github_assign_site_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.site_slug is null or btrim(new.site_slug) = '' then
    new.site_slug := public.github_default_site_slug(new.repository_full_name, new.project_id);
  end if;
  new.site_slug := lower(new.site_slug);
  return new;
end;
$$;

drop trigger if exists github_connections_assign_site_slug on public.github_connections;
create trigger github_connections_assign_site_slug
before insert or update of repository_full_name, project_id, site_slug
on public.github_connections
for each row execute function public.github_assign_site_slug();

alter table public.github_template_files
  add column if not exists site_path text;

update public.github_template_files
set site_path = regexp_replace(path, '^.*templates/', '')
where site_path is null or btrim(site_path) = '';

alter table public.github_template_files
  alter column site_path set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'github_template_files_site_path_safe'
      and conrelid = 'public.github_template_files'::regclass
  ) then
    alter table public.github_template_files
      add constraint github_template_files_site_path_safe
      check (
        site_path <> ''
        and site_path !~ '(^|/)\.\.(/|$)'
        and site_path !~ '^/'
        and lower(site_path) like '%.html'
      );
  end if;
end;
$$;

create index if not exists github_template_files_site_path_idx
  on public.github_template_files (github_connection_id, site_path);

create or replace function public.github_assign_site_path()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.site_path := regexp_replace(new.path, '^.*templates/', '');
  return new;
end;
$$;

drop trigger if exists github_template_files_assign_site_path on public.github_template_files;
create trigger github_template_files_assign_site_path
before insert or update of path
on public.github_template_files
for each row execute function public.github_assign_site_path();

commit;
