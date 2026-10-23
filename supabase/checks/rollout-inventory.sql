-- Read-only inventory. Run in the Supabase SQL editor BEFORE and AFTER 20261023_access_control.sql
-- and keep both outputs (they are the record of the previous and the new access rules).
-- Changes nothing.

-- 1. Policies on the app's tables (before: expect "Public access …" with qual = true)
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects',
                    'app_members', 'app_usage', 'app_usage_limits', 'app_prompt_versions')
order by tablename, policyname;

-- 2. Table privileges held by the API roles (after: anon has none; authenticated only on the 4 shared tables + select on app_members)
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
  and table_name in ('gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects',
                     'app_members', 'app_usage', 'app_usage_limits', 'app_prompt_versions')
group by table_name, grantee
order by table_name, grantee;

-- 3. Other objects that read these tables (views and functions) — alternate access paths to review.
--    Recursive with no depth limit (same coverage as the migration): views built on other views at any
--    depth and in any schema, with their shortest depth (1 = reads a table directly). Cycle-safe: a view
--    already on the current path is never visited again.
with recursive deps(oid, depth, path) as (
  select v.oid, 1, array[v.oid]
  from pg_depend d
  join pg_rewrite rw on rw.oid = d.objid
  join pg_class v on v.oid = rw.ev_class
  join pg_class t on t.oid = d.refobjid
  where t.relnamespace = 'public'::regnamespace
    and t.relname in ('gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects',
                      'app_members', 'app_usage', 'app_usage_limits', 'app_prompt_versions')
    and v.relkind in ('v', 'm') and v.oid <> t.oid
  union
  select v.oid, deps.depth + 1, deps.path || v.oid
  from deps
  join pg_depend d on d.refobjid = deps.oid
  join pg_rewrite rw on rw.oid = d.objid
  join pg_class v on v.oid = rw.ev_class
  where v.relkind in ('v', 'm') and not v.oid = any (deps.path)
)
select deps.oid::regclass as dependent_view, c.relkind, min(depth) as depth,
       has_table_privilege('anon', deps.oid, 'select') as anon_can_select,
       has_table_privilege('authenticated', deps.oid, 'select') as authenticated_can_select
from deps join pg_class c on c.oid = deps.oid
group by deps.oid, c.relkind
order by depth, 1;

select n.nspname as schema, p.proname as function, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'extensions', 'graphql', 'graphql_public', 'realtime', 'vault', 'pgsodium', 'supabase_functions', 'net', 'cron')
  and p.prosrc ~* '(gsc_uploads|search_queries|ad_keywords|keyword_projects)'
order by 1, 2;

-- 4. Everything else in the public schema (other apps may share this Supabase project)
select table_name from information_schema.tables where table_schema = 'public' order by 1;

-- 5. Row counts — compare before and after (the migration must not change them)
select 'gsc_uploads' as t, count(*) from gsc_uploads
union all select 'search_queries', count(*) from search_queries
union all select 'ad_keywords', count(*) from ad_keywords
union all select 'keyword_projects', count(*) from keyword_projects;

-- 6. After the migration: members (no emails are stored in the repository; this shows them only to you)
-- select email, role, status, user_id is not null as signed_in from app_members order by role, status, email;
