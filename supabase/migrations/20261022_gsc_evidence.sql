-- SB Keyword Intelligence — GSC evidence columns (GSC-first keyword workflow)
-- NOT YET APPLIED TO PRODUCTION.
--
-- Run AFTER 20261021_keyword_projects.sql. Safe on:
--   • a fresh database where 20261021 was just applied
--   • a database where 20261021 was applied earlier (any time)
--   • a database where this file was already applied (idempotent — every statement is guarded)
-- Additive only: no data is changed or deleted, no column types are altered.

-- Guard: fail with a clear message if the first migration hasn't been applied
do $$
begin
  if to_regclass('public.keyword_projects') is null then
    raise exception 'Apply supabase/migrations/20261021_keyword_projects.sql first';
  end if;
  if to_regclass('public.ad_keywords') is null then
    raise exception 'ad_keywords table missing — apply supabase/schema.sql first';
  end if;
end $$;

-- keyword_projects: make sure every column the app writes exists (repairs a partially created table)
alter table keyword_projects add column if not exists created_at          timestamptz not null default now();
alter table keyword_projects add column if not exists updated_at          timestamptz not null default now();
alter table keyword_projects add column if not exists selected_categories text[]      not null default '{}';
alter table keyword_projects add column if not exists page_urls           text[]      not null default '{}';
alter table keyword_projects add column if not exists gsc_upload_id       uuid references gsc_uploads(id) on delete set null;
alter table keyword_projects add column if not exists gsc_source          text;
alter table keyword_projects add column if not exists gsc_date_start      date;
alter table keyword_projects add column if not exists gsc_date_end        date;
alter table keyword_projects add column if not exists ad_group_count      int         not null default 0;
alter table keyword_projects add column if not exists keyword_count       int         not null default 0;
alter table keyword_projects add column if not exists save_status         text        not null default 'saving';
alter table keyword_projects add column if not exists data                jsonb       not null default '{}'::jsonb;
-- (seeds, evidence, reporting periods and seed references live inside `data` — no new project columns needed)

-- ad_keywords: project linkage (repeated from 20261021 in case it was partially applied)
alter table ad_keywords add column if not exists project_id   uuid references keyword_projects(id) on delete cascade;
alter table ad_keywords add column if not exists ad_group     text;
alter table ad_keywords add column if not exists landing_url  text;
alter table ad_keywords add column if not exists base_keyword text;

-- ad_keywords: GSC evidence. Metrics are only set for observed GSC queries;
-- AI expansions list the seed queries they came from and have no metrics.
alter table ad_keywords add column if not exists seed_queries     text[];
alter table ad_keywords add column if not exists edited_from      text;   -- observed query a manual keyword was edited from
alter table ad_keywords add column if not exists gsc_scope        text;   -- 'page' | 'site-wide'
alter table ad_keywords add column if not exists gsc_clicks       int;
alter table ad_keywords add column if not exists gsc_impressions  int;
alter table ad_keywords add column if not exists gsc_ctr          double precision;
alter table ad_keywords add column if not exists gsc_position     double precision;
alter table ad_keywords add column if not exists gsc_period_start date;
alter table ad_keywords add column if not exists gsc_period_end   date;

-- Scope values are constrained (added only once; NOT VALID so existing rows are never rechecked)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_keywords_gsc_scope_check') then
    alter table ad_keywords add constraint ad_keywords_gsc_scope_check
      check (gsc_scope is null or gsc_scope in ('page', 'site-wide')) not valid;
  end if;
end $$;

create index if not exists idx_ad_keywords_project_id on ad_keywords(project_id);

-- Source values used from now on: 'gsc_observed' | 'ai_expansion' | 'manual'
-- (older rows may contain 'from_gsc', 'suggested' or 'ai_suggested'; the app reads them as observed / AI expansion).
