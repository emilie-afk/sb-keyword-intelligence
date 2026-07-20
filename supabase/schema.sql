-- SB Keyword Intelligence — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste & run
-- This adds 3 new tables to your existing project without touching anything else

-- ─────────────────────────────────────────────
-- 1. gsc_uploads — one row per analysis run
-- ─────────────────────────────────────────────
create table if not exists gsc_uploads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  source        text not null,       -- 'gsc_api' or 'csv_upload'
  date_start    date,                -- start of the GSC date range
  date_end      date,                -- end of the GSC date range
  rows_count    int,                 -- number of queries in this upload
  total_clicks  int,
  total_impressions int,
  site_url      text default 'succulentsbox.com'
);

-- Anyone with the anon key can read/write (site is protected by Netlify password)
alter table gsc_uploads enable row level security;

create policy "Public access for gsc_uploads"
  on gsc_uploads for all
  using (true)
  with check (true);


-- ─────────────────────────────────────────────
-- 2. search_queries — every query from each upload
-- ─────────────────────────────────────────────
create table if not exists search_queries (
  id            uuid primary key default gen_random_uuid(),
  upload_id     uuid references gsc_uploads(id) on delete cascade,
  query         text not null,
  clicks        int,
  impressions   int,
  ctr           float,              -- stored as percentage e.g. 1.23 (not 0.0123)
  position      float,
  category      text,              -- Succulents | Houseplants | Air Plants | Succulent Subscription | Gift Boxes | Branded | Other
  buying_intent boolean,
  is_branded    boolean,
  created_at    timestamptz default now()
);

alter table search_queries enable row level security;

create policy "Public access for search_queries"
  on search_queries for all
  using (true)
  with check (true);

-- Index for fast lookups by upload
create index if not exists idx_search_queries_upload_id on search_queries(upload_id);
create index if not exists idx_search_queries_category on search_queries(category);


-- ─────────────────────────────────────────────
-- 3. ad_keywords — generated keywords for Google Ads
-- ─────────────────────────────────────────────
create table if not exists ad_keywords (
  id              uuid primary key default gen_random_uuid(),
  upload_id       uuid references gsc_uploads(id) on delete cascade,
  keyword         text not null,
  match_type      text,              -- 'broad' | 'phrase' | 'exact'
  category        text,
  headline_1      text,
  headline_2      text,
  headline_3      text,
  source          text,              -- 'from_gsc' or 'suggested' (gap categories)
  is_gap_category boolean default false,
  created_at      timestamptz default now()
);

alter table ad_keywords enable row level security;

create policy "Public access for ad_keywords"
  on ad_keywords for all
  using (true)
  with check (true);

-- Index for fast lookups
create index if not exists idx_ad_keywords_upload_id on ad_keywords(upload_id);
create index if not exists idx_ad_keywords_category on ad_keywords(category);
