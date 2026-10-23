// Row-level security, run as the real API roles (anon / authenticated) — never as the table owner.
// Synthetic identities only.
import { describe, it, expect, beforeAll } from 'vitest'
import { legacyDatabase, securedDatabase, addUser, asAnon, asUser, asService, SQL } from './supabaseHarness.js'

const OWNER = 'owner@example.test'
const MEMBER = 'member@example.test'
const STRANGER = 'stranger@example.test'
const TABLES = ['gsc_uploads', 'search_queries', 'ad_keywords', 'keyword_projects']

async function seedData(pg) {
  const { rows: [u] } = await pg.query(`insert into gsc_uploads (source, rows_count) values ('csv_upload', 1) returning id`)
  await pg.query(`insert into search_queries (upload_id, query, clicks, impressions) values ($1, 'succulent gift box', 3, 40)`, [u.id])
  const { rows: [p] } = await pg.query(`insert into keyword_projects (name, mode, data) values ('Shared project', 'category', '{"version":2}') returning id`)
  await pg.query(`insert into ad_keywords (upload_id, project_id, keyword, match_type, source) values ($1, $2, '"succulent gift box"', 'phrase', 'gsc_observed')`, [u.id, p.id])
  return { uploadId: u.id, projectId: p.id }
}

// Production-like: legacy public policies + existing data, then the migration, owner bootstrap, a member
let pg, ids, owner, member, stranger
beforeAll(async () => {
  pg = await legacyDatabase()
  ids = await seedData(pg)
  await pg.exec(SQL.access)
  await pg.query(`select app_private.bootstrap_owner($1)`, [OWNER])
  owner = await addUser(pg, OWNER)
  member = await addUser(pg, MEMBER)
  stranger = await addUser(pg, STRANGER)
  expect((await asUser(pg, owner, 'select app_my_access() v'))[0].v).toMatchObject({ status: 'approved', role: 'owner' })
  expect((await asUser(pg, member, 'select app_my_access() v'))[0].v).toMatchObject({ status: 'pending', role: 'member' })
  await asUser(pg, owner, `select app_admin_set_member($1, 'approved')`, [MEMBER])
  await asUser(pg, stranger, 'select app_my_access()') // files a pending request
}, 60000)

const denied = p => expect(p).rejects.toThrow(/permission denied|Not authorized|cannot|42501|row-level security/i)

describe('migration replaces public access and preserves data', () => {
  it('baseline: before the migration, the publishable key alone can read and write everything', async () => {
    const db = await legacyDatabase()
    await seedData(db)
    for (const t of TABLES) expect((await asAnon(db, `select * from ${t}`)).length).toBe(1)
    await asAnon(db, `update keyword_projects set name = 'changed by anon'`)
    expect((await db.query('select name from keyword_projects')).rows[0].name).toBe('changed by anon')
  })
  it('no permissive or public policy remains; all existing rows are kept', async () => {
    const policies = (await pg.query(`select tablename, policyname, roles::text, qual, with_check from pg_policies where schemaname = 'public'`)).rows
    expect(policies.some(p => /Public access/.test(p.policyname))).toBe(false)
    for (const p of policies) {
      expect(p.roles).not.toMatch(/public|anon/)
      expect(p.qual ?? '').not.toBe('true')
      expect(p.with_check ?? '').not.toBe('true')
    }
    for (const t of TABLES) expect((await pg.query(`select count(*)::int n from ${t}`)).rows[0].n).toBe(1)
  })
  it('is repeatable', async () => {
    const again = await securedDatabase()
    await again.exec(SQL.access)
    await again.exec(SQL.access)
    const n = (await again.query(`select count(*)::int n from pg_policies where schemaname = 'public' and tablename = 'gsc_uploads'`)).rows[0].n
    expect(n).toBe(4)
  })
  it('fresh install (schema + migrations) never creates public access', async () => {
    for (const f of [SQL.schema, SQL.v1, SQL.v2]) expect(f).not.toMatch(/using\s*\(\s*true\s*\)/i)
  })
  it('the read-only rollout inventory runs and reports the new rules', async () => {
    const inv = (await import('node:fs')).readFileSync(new URL('../supabase/checks/rollout-inventory.sql', import.meta.url), 'utf8')
    await pg.exec(inv)
    const grants = (await pg.query(`select grantee, table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'`)).rows
    expect(grants.filter(g => TABLES.includes(g.table_name) || g.table_name.startsWith('app_'))).toEqual([])
  })
  it('nested views (a view on a view, any depth, any schema) are closed too', async () => {
    const db = await legacyDatabase()
    await seedData(db)
    await db.exec(`create view inner_v as select keyword from ad_keywords;
      create view outer_v as select * from inner_v;
      create view outermost_v as select * from outer_v;
      create schema reporting; grant usage on schema reporting to anon, authenticated;
      create view reporting.export_v as select * from outer_v; grant select on reporting.export_v to anon, authenticated;
      grant select on inner_v, outer_v, outermost_v to anon, authenticated`)
    expect((await asAnon(db, 'select * from outermost_v')).length).toBe(1) // exposed before the migration
    await db.exec(SQL.access)
    for (const v of ['inner_v', 'outer_v', 'outermost_v', 'reporting.export_v']) {
      await denied(asAnon(db, `select * from ${v}`))
      await denied(asUser(db, await addUser(db, `${v}@example.test`), `select * from ${v}`))
    }
    const inv = (await import('node:fs')).readFileSync(new URL('../supabase/checks/rollout-inventory.sql', import.meta.url), 'utf8')
    const section = inv.slice(inv.indexOf('with recursive'), inv.indexOf('order by depth, 1;') + 'order by depth, 1;'.length)
    const rows = (await db.query(section)).rows
    expect(rows.map(r => [String(r.dependent_view), r.depth, r.anon_can_select])).toEqual(expect.arrayContaining([
      ['inner_v', 1, false], ['outer_v', 2, false], ['outermost_v', 3, false], ['reporting.export_v', 3, false],
    ]))
  })
  it('a 25-deep chain of views is fully closed and fully listed by the inventory (no depth limit)', async () => {
    const db = await legacyDatabase()
    await seedData(db)
    let sql = 'create view chain_1 as select keyword from ad_keywords;'
    for (let i = 2; i <= 25; i++) sql += `create view chain_${i} as select * from chain_${i - 1};`
    await db.exec(sql + 'grant select on all tables in schema public to anon')
    expect((await asAnon(db, 'select * from chain_25')).length).toBe(1)
    await db.exec(SQL.access)
    await denied(asAnon(db, 'select * from chain_25'))
    const inv = (await import('node:fs')).readFileSync(new URL('../supabase/checks/rollout-inventory.sql', import.meta.url), 'utf8')
    expect(inv).not.toMatch(/depth\s*<\s*\d+/)
    const section = inv.slice(inv.indexOf('with recursive'), inv.indexOf('order by depth, 1;') + 'order by depth, 1;'.length)
    const rows = (await db.query(section)).rows.filter(r => String(r.dependent_view).startsWith('chain_'))
    expect(rows).toHaveLength(25)
    expect(Math.max(...rows.map(r => r.depth))).toBe(25)
    expect(rows.every(r => r.anon_can_select === false && r.authenticated_can_select === false)).toBe(true)
  })
  it('a view over protected tables is closed to the API roles', async () => {
    const db = await legacyDatabase()
    await db.exec(`create view keyword_export as select keyword from ad_keywords`)
    await db.exec(SQL.access)
    await denied(asAnon(db, 'select * from keyword_export'))
  })
})

describe('anonymous (publishable key only)', () => {
  it('cannot read or modify any protected table', async () => {
    for (const t of [...TABLES, 'app_members', 'app_usage', 'app_usage_limits', 'app_prompt_versions']) {
      await denied(asAnon(pg, `select * from ${t}`))
      await denied(asAnon(pg, `delete from ${t}`))
    }
    await denied(asAnon(pg, `insert into gsc_uploads (source) values ('csv_upload')`))
    await denied(asAnon(pg, `update keyword_projects set name = 'x'`))
  })
  it('cannot call member or owner functions', async () => {
    for (const fn of ['app_my_access()', `app_authorize('keywords')`, 'app_admin_list_members()', `app_admin_set_member('${STRANGER}', 'approved')`]) {
      await denied(asAnon(pg, `select ${fn}`))
    }
  })
})

describe('signed in but not approved', () => {
  it('sees no shared data and cannot write', async () => {
    for (const t of TABLES) expect(await asUser(pg, stranger, `select * from ${t}`)).toEqual([])
    await denied(asUser(pg, stranger, `insert into keyword_projects (name, mode) values ('x', 'category')`))
    await asUser(pg, stranger, `update keyword_projects set name = 'hijacked'`)
    await asUser(pg, stranger, `delete from ad_keywords`)
    expect((await pg.query(`select name from keyword_projects`)).rows[0].name).toBe('Shared project')
    expect((await pg.query(`select count(*)::int n from ad_keywords`)).rows[0].n).toBe(1)
  })
  it('cannot approve or promote itself, by any path', async () => {
    await denied(asUser(pg, stranger, `update app_members set status = 'approved' where email = $1`, [STRANGER]))
    await denied(asUser(pg, stranger, `insert into app_members (email, status) values ('x@example.test', 'approved')`))
    await denied(asUser(pg, stranger, `select app_admin_set_member($1, 'approved')`, [STRANGER]))
    await denied(asUser(pg, stranger, `select app_private.bootstrap_owner($1)`, [STRANGER]))
    expect((await asUser(pg, stranger, 'select app_my_access() v'))[0].v.status).toBe('pending')
    expect((await asUser(pg, stranger, `select app_authorize('keywords') v`))[0].v).toMatchObject({ allowed: false, code: 'not_member' })
  })
  it('sees only its own membership row', async () => {
    expect((await asUser(pg, stranger, 'select email from app_members')).map(r => r.email)).toEqual([STRANGER])
  })
  it('an unverified email is never linked or approved', async () => {
    const id = await addUser(pg, 'unverified@example.test', { confirmed: false })
    expect((await asUser(pg, id, 'select app_my_access() v'))[0].v.status).toBe('unverified')
  })
  it('client-supplied claims (email, role) grant nothing', async () => {
    const forged = await addUser(pg, 'forger@example.test')
    const rows = await import('./supabaseHarness.js').then(h => h.as(pg, 'authenticated',
      { sub: forged, role: 'authenticated', email: OWNER, app_role: 'owner', user_role: 'owner' }, 'select count(*)::int n from keyword_projects'))
    expect(rows[0].n).toBe(0)
  })
})

describe('approved member', () => {
  it('reads and writes the shared historical data (all commands)', async () => {
    expect((await asUser(pg, member, 'select name from keyword_projects')).map(r => r.name)).toEqual(['Shared project'])
    expect((await asUser(pg, member, 'select count(*)::int n from search_queries'))[0].n).toBe(1)
    const [p] = await asUser(pg, member, `insert into keyword_projects (name, mode) values ('Member project', 'category') returning id`)
    await asUser(pg, member, `insert into ad_keywords (project_id, keyword) values ($1, 'x')`, [p.id])
    await asUser(pg, member, `update keyword_projects set save_status = 'complete' where id = $1`, [p.id])
    expect((await asUser(pg, owner, 'select count(*)::int n from keyword_projects'))[0].n).toBe(2)
    await asUser(pg, member, `delete from keyword_projects where id = $1`, [p.id])
    expect((await pg.query(`select count(*)::int n from ad_keywords where project_id = $1`, [p.id])).rows[0].n).toBe(0)
  })
  it('cannot manage members, promote itself or alter the owner', async () => {
    await denied(asUser(pg, member, 'select * from app_admin_list_members()'))
    await denied(asUser(pg, member, `select app_admin_set_member($1, 'approved')`, [STRANGER]))
    await denied(asUser(pg, member, `select app_admin_set_member($1, 'revoked')`, [OWNER]))
    await denied(asUser(pg, member, `select app_admin_remove_member($1)`, [OWNER]))
    await denied(asUser(pg, member, `update app_members set role = 'owner' where email = $1`, [MEMBER]))
    expect((await asUser(pg, member, `select app_authorize('admin', true) v`))[0].v).toMatchObject({ allowed: false, code: 'not_owner' })
  })
  it('cannot read prompts or usage tables', async () => {
    await pg.query(`select app_create_prompt_version('ad_generation', '{"x":1}', 'test', null, true)`)
    await denied(asUser(pg, member, 'select * from app_prompt_versions'))
    await denied(asUser(pg, member, 'select * from app_usage'))
    await denied(asUser(pg, member, `select app_create_prompt_version('ad_generation', '{}', null, null, true)`))
    await denied(asUser(pg, owner, 'select * from app_prompt_versions')) // owner reads prompts only through the server
    expect((await asService(pg, 'select count(*)::int n from app_prompt_versions'))[0].n).toBe(1)
  })
})

describe('owner', () => {
  it('has full data access and manages members', async () => {
    expect((await asUser(pg, owner, 'select count(*)::int n from gsc_uploads'))[0].n).toBe(1)
    const list = await asUser(pg, owner, 'select email, role, status from app_admin_list_members()')
    expect(list[0]).toEqual({ email: OWNER, role: 'owner', status: 'approved' })
    expect(list.map(r => r.email)).toEqual(expect.arrayContaining([MEMBER, STRANGER]))
    await asUser(pg, owner, `select app_admin_set_member('invitee@example.test', 'approved')`) // pre-approve by email
    const invitee = await addUser(pg, 'Invitee@Example.test')
    expect((await asUser(pg, invitee, 'select app_my_access() v'))[0].v).toMatchObject({ status: 'approved', role: 'member' })
    expect((await asUser(pg, invitee, 'select count(*)::int n from keyword_projects'))[0].n).toBe(1)
  })
  it('cannot be removed or demoted through the app — not even by itself', async () => {
    await denied(asUser(pg, owner, `select app_admin_set_member($1, 'revoked')`, [OWNER]))
    await denied(asUser(pg, owner, `select app_admin_remove_member($1)`, [OWNER]))
    await denied(asService(pg, `delete from app_members where email = $1`, [OWNER]))
    await denied(asService(pg, `update app_members set status = 'revoked' where email = $1`, [OWNER]))
    await denied(asService(pg, `update app_members set role = 'owner' where email = $1`, [MEMBER]))
    await denied(asService(pg, `select app_private.bootstrap_owner($1)`, [MEMBER]))
    expect((await pg.query(`select role, status from app_members where email = $1`, [OWNER])).rows[0]).toEqual({ role: 'owner', status: 'approved' })
  })
})

describe('review follow-ups', () => {
  it('an account that did not sign in with Google cannot claim a membership by email', async () => {
    const db = await securedDatabase()
    await db.query('select app_private.bootstrap_owner($1)', [OWNER])
    const impostor = await addUser(db, OWNER, { provider: 'email' }) // same address, password sign-up
    expect((await asUser(db, impostor, 'select app_my_access() v'))[0].v.status).toBe('unverified')
    expect((await db.query('select user_id from app_members where email = $1', [OWNER])).rows[0].user_id).toBeNull()
    expect((await asUser(db, impostor, `select app_authorize('admin', true) v`))[0].v.allowed).toBe(false)
    const real = await addUser(db, OWNER)
    expect((await asUser(db, real, 'select app_my_access() v'))[0].v).toMatchObject({ status: 'approved', role: 'owner' })
  })
  it('a linked email-provider identity loses access (role requires a Google identity)', async () => {
    const db = await securedDatabase()
    await db.query('select app_private.bootstrap_owner($1)', [OWNER])
    const id = await addUser(db, OWNER)
    await asUser(db, id, 'select app_my_access()')
    await db.query(`delete from auth.identities where user_id = $1`, [id])
    expect((await asUser(db, id, `select app_authorize('admin', true) v`))[0].v.code).toBe('not_member')
  })
  it('the owner can discard a flood of waiting requests; members cannot', async () => {
    const db = await securedDatabase()
    await db.query('select app_private.bootstrap_owner($1)', [OWNER])
    const o = await addUser(db, OWNER)
    await asUser(db, o, 'select app_my_access()')
    for (let i = 0; i < 3; i++) await asUser(db, await addUser(db, `spam${i}@example.test`), 'select app_my_access()')
    expect((await asUser(db, o, 'select app_admin_clear_pending() n'))[0].n).toBe(3)
    expect((await db.query(`select count(*)::int n from app_members`)).rows[0].n).toBe(1)
    await denied(asUser(db, await addUser(db, 'x@example.test'), 'select app_admin_clear_pending()'))
  })
  it("deleting the owner's auth user unlinks the row instead of failing; the owner stays owner", async () => {
    const db = await securedDatabase()
    await db.query('select app_private.bootstrap_owner($1)', [OWNER])
    const o = await addUser(db, OWNER)
    await asUser(db, o, 'select app_my_access()')
    await db.query('delete from auth.users where id = $1', [o])
    expect((await db.query('select role, status, user_id from app_members where email = $1', [OWNER])).rows[0]).toEqual({ role: 'owner', status: 'approved', user_id: null })
  })
})

describe('revocation and usage limits', () => {
  it('revoking a member blocks data and the server gate immediately (no token change needed)', async () => {
    const temp = await addUser(pg, 'temp@example.test')
    await asUser(pg, owner, `select app_admin_set_member('temp@example.test', 'approved')`)
    await asUser(pg, temp, 'select app_my_access()')
    expect((await asUser(pg, temp, `select app_authorize('validate') v`))[0].v.allowed).toBe(true)
    await asUser(pg, owner, `select app_admin_set_member('temp@example.test', 'revoked')`)
    expect((await asUser(pg, temp, `select app_authorize('validate') v`))[0].v).toMatchObject({ allowed: false, code: 'not_member' })
    expect(await asUser(pg, temp, 'select * from keyword_projects')).toEqual([])
  })
  it('daily limits are durable and per user', async () => {
    await pg.query(`update app_usage_limits set daily_limit = 2 where action = 'keywords'`)
    const results = []
    for (let i = 0; i < 3; i++) results.push((await asUser(pg, member, `select app_authorize('keywords') v`))[0].v)
    expect(results.map(r => r.allowed)).toEqual([true, true, false])
    expect(results[2].code).toBe('rate_limited')
    expect((await asUser(pg, owner, `select app_authorize('keywords') v`))[0].v.allowed).toBe(true)
    expect((await asUser(pg, member, `select app_authorize('no_such_action') v`))[0].v.code).toBe('unknown_action')
    await pg.query(`update app_usage_limits set daily_limit = 500 where action = 'keywords'`)
  })
})
