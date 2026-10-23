-- SB Keyword Intelligence — access control (members, RLS, usage limits, private prompts)
--
-- Replaces the public ("using (true)") policies with approved-member access.
-- Run AFTER schema.sql, 20261021_keyword_projects.sql and 20261022_gsc_evidence.sql.
-- Repeatable: safe to run more than once. Data-preserving: no rows in the existing tables are
-- changed or deleted; only policies and grants change, and new tables/functions are added.
--
-- Contains no real email addresses. The owner is added afterwards with a private procedure
-- (see SECURITY-ROLLOUT.md):   select app_private.bootstrap_owner('<OWNER_EMAIL>');
--
-- Access model
--   anon (publishable key only) ...... nothing
--   authenticated, not approved ...... own membership row only (read), via app_my_access()
--   approved member .................. shared team data: gsc_uploads, search_queries, ad_keywords, keyword_projects
--   owner ............................ members management (app_admin_* functions); prompts via the server
--   service_role (server only) ....... prompts, usage tables (never sent to the browser)

begin;

do $$
begin
  if to_regclass('public.gsc_uploads') is null or to_regclass('public.search_queries') is null
     or to_regclass('public.ad_keywords') is null then
    raise exception 'Apply supabase/schema.sql first';
  end if;
  if to_regclass('public.keyword_projects') is null then
    raise exception 'Apply supabase/migrations/20261021_keyword_projects.sql and 20261022_gsc_evidence.sql first';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null or to_regclass('auth.identities') is null then
    raise exception 'Supabase Auth (auth.uid, auth.users) is required';
  end if;
end $$;

create schema if not exists app_private;
revoke all on schema app_private from public;
revoke all on schema app_private from anon, authenticated;
grant usage on schema app_private to authenticated;   -- RLS policies call the predicates below

-- ─────────────────────────────────────────────
-- 1. Members
-- ─────────────────────────────────────────────
create table if not exists public.app_members (
  email        text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  user_id      uuid unique references auth.users(id) on delete set null,
  role         text not null default 'member' check (role in ('owner', 'member')),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid
);

-- Role of the current request's user, or null. Requires: approved row linked to this user,
-- confirmed email that still matches the membership email, not banned.
create or replace function app_private.member_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.app_members m
  join auth.users u on u.id = m.user_id
  where m.user_id = auth.uid()
    and m.status = 'approved'
    and u.email_confirmed_at is not null
    and lower(u.email) = m.email
    and (u.banned_until is null or u.banned_until < now())
    -- Only Google sign-ins count: an account created another way with the same email can't claim a membership
    and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'google')
$$;
create or replace function app_private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$ select app_private.member_role() is not null $$;
create or replace function app_private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce(app_private.member_role() = 'owner', false) $$;

revoke all on function app_private.member_role() from public, anon, authenticated;
revoke all on function app_private.is_member() from public, anon, authenticated;
revoke all on function app_private.is_owner() from public, anon, authenticated;
grant execute on function app_private.member_role() to authenticated;
grant execute on function app_private.is_member() to authenticated;
grant execute on function app_private.is_owner() to authenticated;

-- Owner rows can only be created, changed or removed by the private bootstrap procedure.
-- The one exception: linking the owner's user id on first sign-in (nothing else may change).
create or replace function app_private.protect_owner_rows() returns trigger
language plpgsql set search_path = '' as $$
declare
  allowed boolean := coalesce(current_setting('app.allow_owner_change', true), '') = 'on';
begin
  if allowed then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.role = 'owner' then raise exception 'Owner membership can only be set by the owner bootstrap procedure' using errcode = '42501'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.role = 'owner' then raise exception 'The owner cannot be removed' using errcode = '42501'; end if;
    return old;
  end if;
  -- UPDATE
  if old.role = 'owner' then
    if new.role = old.role and new.status = old.status and new.email = old.email
       and ((old.user_id is null and new.user_id is not null)    -- first sign-in links the owner's user id
         or (old.user_id is not null and new.user_id is null)) then -- the owner's auth user was deleted
      return new;
    end if;
    raise exception 'The owner cannot be changed' using errcode = '42501';
  end if;
  if new.role = 'owner' then raise exception 'Members cannot be promoted to owner' using errcode = '42501'; end if;
  return new;
end $$;
revoke all on function app_private.protect_owner_rows() from public, anon, authenticated;

drop trigger if exists app_members_protect_owner on public.app_members;
create trigger app_members_protect_owner before insert or update or delete on public.app_members
  for each row execute function app_private.protect_owner_rows();

-- Private: create or restore the owner. Run in the SQL editor only (not executable by any API role).
create or replace function app_private.bootstrap_owner(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if position('@' in v_email) < 2 then raise exception 'Provide the owner email address'; end if;
  perform set_config('app.allow_owner_change', 'on', true);
  insert into public.app_members (email, role, status, decided_at)
  values (v_email, 'owner', 'approved', now())
  on conflict (email) do update set role = 'owner', status = 'approved', decided_at = now();
  perform set_config('app.allow_owner_change', '', true);
end $$;
revoke all on function app_private.bootstrap_owner(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function app_private.bootstrap_owner(text) from service_role;
  end if;
end $$;

-- ─────────────────────────────────────────────
-- 2. Usage limits (durable, per user per UTC day)
-- ─────────────────────────────────────────────
create table if not exists public.app_usage_limits (
  action      text primary key,
  daily_limit int not null check (daily_limit >= 0)
);
insert into public.app_usage_limits (action, daily_limit) values
  ('validate', 5000), ('keywords', 500), ('headlines', 500), ('fetch_page', 1000), ('admin', 1000)
on conflict (action) do nothing;

create table if not exists public.app_usage (
  user_id uuid not null,
  day     date not null,
  action  text not null,
  count   int  not null default 0,
  primary key (user_id, day, action)
);

-- ─────────────────────────────────────────────
-- 3. Prompt configuration (private; read by the server with the service-role key)
-- ─────────────────────────────────────────────
create table if not exists public.app_prompt_versions (
  id         bigint generated always as identity primary key,
  name       text not null default 'ad_generation',
  version    int  not null,
  config     jsonb not null,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid,
  is_active  boolean not null default false,
  unique (name, version)
);
create unique index if not exists app_prompt_versions_one_active on public.app_prompt_versions (name) where is_active;

-- Versions are immutable (only is_active may change), and the active version can't be deleted
create or replace function app_private.protect_prompt_versions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.is_active then raise exception 'Activate another version before deleting the active one'; end if;
    return old;
  end if;
  if new.config is distinct from old.config or new.name <> old.name or new.version <> old.version then
    raise exception 'Prompt versions are immutable — create a new version instead';
  end if;
  return new;
end $$;
revoke all on function app_private.protect_prompt_versions() from public, anon, authenticated;
drop trigger if exists app_prompt_versions_immutable on public.app_prompt_versions;
create trigger app_prompt_versions_immutable before update or delete on public.app_prompt_versions
  for each row execute function app_private.protect_prompt_versions();

-- Server-only helpers (service_role): create a version, activate a version
create or replace function public.app_create_prompt_version(p_name text, p_config jsonb, p_note text, p_created_by uuid, p_activate boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform pg_advisory_xact_lock(hashtext('app_prompt_versions:' || p_name));
  select coalesce(max(version), 0) + 1 into v from public.app_prompt_versions where name = p_name;
  insert into public.app_prompt_versions (name, version, config, note, created_by) values (p_name, v, p_config, p_note, p_created_by);
  if p_activate then
    update public.app_prompt_versions set is_active = false where name = p_name and is_active;
    update public.app_prompt_versions set is_active = true where name = p_name and version = v;
  end if;
  return v;
end $$;
create or replace function public.app_activate_prompt_version(p_name text, p_version int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.app_prompt_versions where name = p_name and version = p_version) then
    raise exception 'Unknown prompt version';
  end if;
  update public.app_prompt_versions set is_active = false where name = p_name and is_active and version <> p_version;
  update public.app_prompt_versions set is_active = true where name = p_name and version = p_version;
end $$;
revoke all on function public.app_create_prompt_version(text, jsonb, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.app_activate_prompt_version(text, int) from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- 4. Member-facing functions (called with the user's own session)
-- ─────────────────────────────────────────────

-- Current user's access. On first sign-in: links a pre-approved row by verified email, or files a
-- pending request. Never approves anyone.
create or replace function public.app_my_access() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  m public.app_members;
begin
  if v_uid is null then return jsonb_build_object('status', 'anonymous'); end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then return jsonb_build_object('status', 'unverified'); end if;
  if not exists (select 1 from auth.identities i where i.user_id = v_uid and i.provider = 'google') then
    return jsonb_build_object('status', 'unverified');
  end if;

  select * into m from public.app_members where user_id = v_uid;
  if not found then
    select * into m from public.app_members where email = v_email for update;
    if found then
      if m.user_id is not null and m.user_id <> v_uid then return jsonb_build_object('status', 'conflict'); end if;
      update public.app_members set user_id = v_uid where email = v_email returning * into m;
    else
      if (select count(*) from public.app_members where status = 'pending') >= 200 then
        return jsonb_build_object('status', 'closed');
      end if;
      insert into public.app_members (email, user_id, role, status) values (v_email, v_uid, 'member', 'pending') returning * into m;
    end if;
  end if;
  if m.email <> v_email then return jsonb_build_object('status', 'email_changed'); end if;
  return jsonb_build_object('status', m.status, 'role', m.role, 'email', m.email);
end $$;

-- Server-side gate for every protected endpoint: approved member (+ owner if required) and durable
-- per-user daily usage limit. One call per request; nothing is cached, so revocation applies at once.
create or replace function public.app_authorize(p_action text, p_require_owner boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_limit int;
  v_count int;
begin
  if v_uid is null then return jsonb_build_object('allowed', false, 'code', 'unauthenticated'); end if;
  v_role := app_private.member_role();
  if v_role is null then return jsonb_build_object('allowed', false, 'code', 'not_member'); end if;
  if p_require_owner and v_role <> 'owner' then return jsonb_build_object('allowed', false, 'code', 'not_owner'); end if;
  select daily_limit into v_limit from public.app_usage_limits where action = p_action;
  if not found then return jsonb_build_object('allowed', false, 'code', 'unknown_action'); end if;
  if v_limit <= 0 then return jsonb_build_object('allowed', false, 'code', 'rate_limited', 'limit', v_limit); end if;
  insert into public.app_usage as u (user_id, day, action, count)
  values (v_uid, (now() at time zone 'utc')::date, p_action, 1)
  on conflict (user_id, day, action) do update set count = u.count + 1 where u.count < v_limit
  returning u.count into v_count;
  if v_count is null then return jsonb_build_object('allowed', false, 'code', 'rate_limited', 'limit', v_limit); end if;
  return jsonb_build_object('allowed', true, 'role', v_role, 'user_id', v_uid, 'used', v_count, 'limit', v_limit);
end $$;

-- Owner-only member management (also checked by the Netlify function before calling these)
create or replace function public.app_admin_list_members()
returns table (email text, role text, status text, requested_at timestamptz, decided_at timestamptz, signed_in boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_owner() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query select m.email, m.role, m.status, m.requested_at, m.decided_at, m.user_id is not null
    from public.app_members m order by (m.role = 'owner') desc, (m.status = 'pending') desc, m.email;
end $$;

create or replace function public.app_admin_set_member(p_email text, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not app_private.is_owner() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if position('@' in v_email) < 2 then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  if p_status not in ('approved', 'revoked', 'pending') then raise exception 'Unknown status' using errcode = '22023'; end if;
  if exists (select 1 from public.app_members where email = v_email and role = 'owner') then
    raise exception 'The owner cannot be changed' using errcode = 'P0001';
  end if;
  insert into public.app_members (email, role, status, decided_at, decided_by)
  values (v_email, 'member', p_status, now(), auth.uid())
  on conflict (email) do update set status = excluded.status, decided_at = now(), decided_by = auth.uid();
end $$;

create or replace function public.app_admin_remove_member(p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not app_private.is_owner() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.app_members where email = v_email and role = 'owner') then
    raise exception 'The owner cannot be removed' using errcode = 'P0001';
  end if;
  delete from public.app_members where email = v_email and role = 'member';
end $$;

-- Owner: discard all waiting requests at once (e.g. after a flood of sign-ups)
create or replace function public.app_admin_clear_pending() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not app_private.is_owner() then raise exception 'Not authorized' using errcode = '42501'; end if;
  delete from public.app_members where status = 'pending' and role = 'member';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.app_admin_clear_pending() from public, anon, authenticated;
grant execute on function public.app_admin_clear_pending() to authenticated;
revoke all on function public.app_my_access() from public, anon, authenticated;
revoke all on function public.app_authorize(text, boolean) from public, anon, authenticated;
revoke all on function public.app_admin_list_members() from public, anon, authenticated;
revoke all on function public.app_admin_set_member(text, text) from public, anon, authenticated;
revoke all on function public.app_admin_remove_member(text) from public, anon, authenticated;
grant execute on function public.app_my_access() to authenticated;
grant execute on function public.app_authorize(text, boolean) to authenticated;
grant execute on function public.app_admin_list_members() to authenticated;
grant execute on function public.app_admin_set_member(text, text) to authenticated;
grant execute on function public.app_admin_remove_member(text) to authenticated;

-- ─────────────────────────────────────────────
-- 5. Replace ALL existing policies and grants on the protected tables
-- ─────────────────────────────────────────────
do $$
declare
  r record;
  t text;
  shared_tables text[] := array['gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects'];
  private_tables text[] := array['app_members', 'app_usage', 'app_usage_limits', 'app_prompt_versions'];
begin
  -- Remove every existing policy (whatever its name) before installing member policies
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename = any (shared_tables || private_tables) loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;

  foreach t in array shared_tables || private_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;

  -- Shared team data: approved members (and the owner) only — every command
  foreach t in array shared_tables loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy members_select on public.%I for select to authenticated using ((select app_private.is_member()))', t);
    execute format('create policy members_insert on public.%I for insert to authenticated with check ((select app_private.is_member()))', t);
    execute format('create policy members_update on public.%I for update to authenticated using ((select app_private.is_member())) with check ((select app_private.is_member()))', t);
    execute format('create policy members_delete on public.%I for delete to authenticated using ((select app_private.is_member()))', t);
  end loop;

  -- Membership rows: a user may read their own row; the owner may read all. No direct writes
  -- (requests, approvals and removals go through the functions above).
  grant select on public.app_members to authenticated;
  create policy own_or_owner_select on public.app_members for select to authenticated
    using (user_id = (select auth.uid()) or (select app_private.is_owner()));

  -- app_usage, app_usage_limits, app_prompt_versions: no API access except the service role.

  -- Server role (Netlify Functions only). Exists in every Supabase project.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach t in array shared_tables || private_tables loop
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end loop;
    grant execute on function public.app_create_prompt_version(text, jsonb, text, uuid, boolean) to service_role;
    grant execute on function public.app_activate_prompt_version(text, int) to service_role;
  end if;

  -- Alternate access paths: views (and materialized views) over protected tables run with their
  -- owner's rights and would bypass RLS — including views built on other views, at any depth and in
  -- any schema. Close them all for the API roles and report them for review.
  for r in with recursive deps(oid) as (
             select v.oid
             from pg_depend d
             join pg_rewrite rw on rw.oid = d.objid
             join pg_class v on v.oid = rw.ev_class
             join pg_class tb on tb.oid = d.refobjid
             where tb.relnamespace = 'public'::regnamespace and tb.relname = any (shared_tables || private_tables)
               and v.relkind in ('v', 'm') and v.oid <> tb.oid
             union
             select v.oid
             from deps
             join pg_depend d on d.refobjid = deps.oid
             join pg_rewrite rw on rw.oid = d.objid
             join pg_class v on v.oid = rw.ev_class
             where v.relkind in ('v', 'm') and v.oid <> deps.oid
           )
           select distinct deps.oid::regclass::text as name
           from deps join pg_class c on c.oid = deps.oid
           where c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) loop
    execute format('revoke all on %s from public, anon, authenticated', r.name);
    raise notice 'View % reads protected tables (directly or through other views) — API access revoked; review before re-granting', r.name;
  end loop;
end $$;

commit;
