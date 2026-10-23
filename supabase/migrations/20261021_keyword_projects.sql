-- SB Keyword Intelligence — keyword projects (Ad Keywords workspace)
-- Applied to production on 2026-10-21, when it still created a public policy (now removed from this file).
-- Safe to run more than once. Does not modify or delete existing data.

-- ─────────────────────────────────────────────
-- 1. keyword_projects — one row per saved keyword project (GSC upload optional)
--    `data` holds the full project (ad groups, landing pages, page snapshots, selected products,
--    keywords, match types, sources, headlines) and is written in a single statement, so a project
--    is never half-saved. `save_status` tracks the ad_keywords mirror (step 2 below).
-- ─────────────────────────────────────────────
create table if not exists keyword_projects (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  name                text not null,
  mode                text not null check (mode in ('category', 'collection', 'product')),
  selected_categories text[] not null default '{}',
  page_urls           text[] not null default '{}',     -- collection/product URLs in the project
  gsc_upload_id       uuid references gsc_uploads(id) on delete set null,  -- optional GSC analysis
  gsc_source          text,
  gsc_date_start      date,
  gsc_date_end        date,
  ad_group_count      int not null default 0,
  keyword_count       int not null default 0,          -- unique base keywords
  save_status         text not null default 'saving' check (save_status in ('saving', 'complete', 'failed')),
  data                jsonb not null default '{}'::jsonb
);

alter table keyword_projects enable row level security;

-- No public policy. Approved-member access is installed by 20261023_access_control.sql.
-- (An earlier version of this file created an always-true policy; it is removed here and by 20261023.)
drop policy if exists "Public access for keyword_projects" on keyword_projects;

create index if not exists idx_keyword_projects_updated_at on keyword_projects(updated_at desc);


-- ─────────────────────────────────────────────
-- 2. ad_keywords — add project columns so saved projects keep feeding the content engine.
--    Existing rows (linked by upload_id) are untouched; new project rows may have upload_id = null.
-- ─────────────────────────────────────────────
alter table ad_keywords add column if not exists project_id   uuid references keyword_projects(id) on delete cascade;
alter table ad_keywords add column if not exists ad_group     text;
alter table ad_keywords add column if not exists landing_url  text;
alter table ad_keywords add column if not exists base_keyword text;

create index if not exists idx_ad_keywords_project_id on ad_keywords(project_id);

-- Source values used from now on: 'from_gsc' | 'ai_suggested' | 'manual'
-- (older rows may contain 'suggested', which the app reads as 'ai_suggested').
