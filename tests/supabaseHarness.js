// A Supabase-like Postgres for security tests (PGlite = Postgres 16 in WASM).
// Recreates what matters for RLS: the anon / authenticated / service_role API roles, Supabase's
// default grants (every new public table and function is granted to anon and authenticated),
// auth.users, auth.uid() from the request's JWT claims, and a minimal PostgREST stand-in that
// verifies HS256 JWTs (signature + expiry) before running a statement as the claimed role.
// Identities are synthetic.
import { readFileSync } from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const read = f => readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8')
export const SQL = {
  schema: read('schema.sql'),
  v1: read('migrations/20261021_keyword_projects.sql'),
  v2: read('migrations/20261022_gsc_evidence.sql'),
  access: read('migrations/20261023_access_control.sql'),
}

const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz
  );
  create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, provider text not null);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`

// Fresh database in the state production was in before this change (public policies), plus optional seed rows
export async function legacyDatabase() {
  const pg = new PGlite()
  await pg.exec(SUPABASE_BOOTSTRAP)
  // The schema as it was in production: public "using (true)" policies on every table
  await pg.exec(SQL.schema)
  await pg.exec(SQL.v1)
  await pg.exec(SQL.v2)
  for (const t of ['gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects']) {
    await pg.exec(`create policy "Public access for ${t}" on ${t} for all using (true) with check (true)`)
  }
  return pg
}

export async function securedDatabase() {
  const pg = await legacyDatabase()
  await pg.exec(SQL.access)
  return pg
}

export async function addUser(pg, email, { confirmed = true, provider = 'google' } = {}) {
  const id = randomUUID()
  await pg.query('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)', [id, email, confirmed ? new Date() : null])
  await pg.query('insert into auth.identities (user_id, provider) values ($1, $2)', [id, provider])
  return id
}

// Run SQL as an API role with the given JWT claims (what PostgREST does per request)
export async function as(pg, role, claims, sql, params = []) {
  await pg.exec('begin')
  try {
    await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims || {})])
    await pg.exec(`set local role ${role}`)
    const r = await pg.query(sql, params)
    await pg.exec('commit')
    return r.rows
  } catch (err) {
    await pg.exec('rollback')
    throw err
  }
}
export const asAnon = (pg, sql, params) => as(pg, 'anon', { role: 'anon' }, sql, params)
export const asUser = (pg, uid, sql, params) => as(pg, 'authenticated', { sub: uid, role: 'authenticated' }, sql, params)
export const asService = (pg, sql, params) => as(pg, 'service_role', { role: 'service_role' }, sql, params)

// ── JWTs (HS256, like a Supabase project's legacy JWT secret) ──
export const JWT_SECRET = 'test-only-jwt-secret-not-a-real-value'
const b64u = b => Buffer.from(b).toString('base64url')
export function signJwt(payload, secret = JWT_SECRET) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }))
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
function verifyJwt(token) {
  const [head, body, sig] = String(token || '').split('.')
  if (!head || !body || !sig) return null
  const expected = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  if (expected !== sig) return null
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null
  return claims
}
export const userToken = (uid, extra = {}) => signJwt({ sub: uid, role: 'authenticated', ...extra })

// Minimal PostgREST for /rest/v1/rpc/<fn> and /rest/v1/<table>: verifies the JWT, then runs as its role.
// Records every request so tests can prove a rejected call never reached the database.
export const ANON_KEY = 'test-publishable-key'
export const SERVICE_KEY = 'test-service-key'
export function fakeSupabaseFetch(pg) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
    calls.push({ path: u.pathname, headers })
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (headers.apikey !== ANON_KEY && headers.apikey !== SERVICE_KEY) return reply(401, { message: 'Invalid API key' })
    const bearer = (headers.authorization || '').replace(/^Bearer /, '')
    let role = 'anon'
    let claims = { role: 'anon' }
    if (bearer === SERVICE_KEY) { role = 'service_role'; claims = { role } } else if (bearer && bearer !== ANON_KEY) {
      const c = verifyJwt(bearer)
      if (!c) return reply(401, { code: 'PGRST301', message: 'JWT invalid or expired' })
      role = c.role
      claims = c
    }
    try {
      if (u.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = u.pathname.split('/').pop()
        const args = JSON.parse(init.body || '{}')
        const names = Object.keys(args)
        const rows = await as(pg, role, claims, `select to_jsonb(r) as v from ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) r`, names.map(n => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n])))
        const vals = rows.map(r => (r.v && typeof r.v === 'object' && fn in r.v ? r.v[fn] : r.v))
        const isSet = ['app_admin_list_members'].includes(fn)
        return reply(200, isSet ? vals : vals[0] ?? null)
      }
      const table = u.pathname.replace('/rest/v1/', '')
      const where = []
      const params = []
      for (const [k, v] of u.searchParams) {
        if (k === 'select' || k === 'order' || k === 'limit') continue
        const [op, val] = v.split(/\.(.*)/s)
        if (op === 'eq') { params.push(val); where.push(`${k}::text = $${params.length}`) }
        if (op === 'is') where.push(`${k} is ${val === 'true' ? 'true' : val === 'false' ? 'false' : 'null'}`)
      }
      const rows = await as(pg, role, claims, `select * from ${table}${where.length ? ` where ${where.join(' and ')}` : ''}`, params)
      return reply(200, rows)
    } catch (err) {
      const denied = /permission denied|Not authorized|42501/.test(err.message) || err.code === '42501'
      return reply(denied ? 403 : 400, { code: err.code, message: err.message })
    }
  }
  return { fetchImpl, calls }
}
