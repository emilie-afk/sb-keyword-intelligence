// Migration compatibility, run against a real Postgres engine (PGlite = Postgres 16 in WASM).
// Covers: fresh database, upgrade after the first migration, upgrade from the combined file that was
// briefly shipped in the GSC-first build, re-running, wrong order, and the exact rows the app writes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { projectKeywordRows } from '../src/lib/supabase.js'
import { newProject, newKeyword, createCategoryGroup, serializeProject } from '../src/lib/workspace.js'

const read = f => readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8')
const SCHEMA = read('schema.sql')
const V1 = read('migrations/20261021_keyword_projects.sql')
const V2 = read('migrations/20261022_gsc_evidence.sql')
// The combined variant (v1 + evidence columns) that shipped in the GSC-first build — the exact file from commit 2079c1c.
// This is what is currently in the local project folder, so it may be the version someone applies first.
const COMBINED = readFileSync(new URL('./fixtures/20261021_keyword_projects.combined-2079c1c.sql', import.meta.url), 'utf8')

async function db() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  return pg
}
const columns = async (pg, table) =>
  (await pg.query(`select column_name, data_type from information_schema.columns where table_name = $1`, [table])).rows
    .reduce((m, r) => ({ ...m, [r.column_name]: r.data_type }), {})

const EXPECTED_AD_KEYWORD_COLUMNS = ['project_id', 'ad_group', 'landing_url', 'base_keyword', 'seed_queries', 'edited_from',
  'gsc_scope', 'gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position', 'gsc_period_start', 'gsc_period_end']

// Write a project + mirror rows exactly as src/lib/supabase.js does
async function appWrite(pg) {
  const g = createCategoryGroup('Gift Boxes')
  const ev = { scope: 'site-wide', source: 'gsc_api', periodStart: '2026-04-24', periodEnd: '2026-10-21', clicks: 3, impressions: 400, ctr: 0.75, position: 7.5 }
  g.keywords = [
    newKeyword('succulent gift box', 'gsc_observed', { evidence: [ev] }),
    newKeyword('buy succulent gift box', 'ai_expansion', { seedRefs: ['succulent gift box'] }),
    newKeyword('succulent gift boxes', 'manual', { editedFrom: 'succulent gift box' }),
  ]
  const project = newProject({ name: 'Test', adGroups: [g] })
  const { rows: [p] } = await pg.query(
    `insert into keyword_projects (name, mode, selected_categories, page_urls, ad_group_count, keyword_count, save_status, data, gsc_source, gsc_date_start, gsc_date_end)
     values ($1, $2, $3, $4, $5, $6, 'saving', $7::jsonb, 'gsc_api', '2026-04-24', '2026-10-21') returning id`,
    ['Test', 'category', ['Gift Boxes'], [], 1, 3, JSON.stringify(serializeProject(project))],
  )
  for (const r of projectKeywordRows(project, p.id)) {
    const cols = Object.keys(r)
    await pg.query(`insert into ad_keywords (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map(c => r[c]))
  }
  await pg.query(`update keyword_projects set save_status = 'complete' where id = $1`, [p.id])
  return p.id
}

describe('migrations (real Postgres)', () => {
  it('fresh database: v1 then v2, both re-runnable in any order afterwards', async () => {
    const pg = await db()
    await pg.exec(V1)
    await pg.exec(V2)
    await pg.exec(V2) // idempotent
    await pg.exec(V1) // re-running v1 after v2 is also safe
    const cols = await columns(pg, 'ad_keywords')
    for (const c of EXPECTED_AD_KEYWORD_COLUMNS) expect(cols).toHaveProperty(c)
    const id = await appWrite(pg)
    const rows = (await pg.query('select base_keyword, source, gsc_clicks, gsc_scope, seed_queries, edited_from from ad_keywords where project_id = $1 and match_type = $2 order by base_keyword', [id, 'broad'])).rows
    expect(rows).toEqual([
      { base_keyword: 'buy succulent gift box', source: 'ai_expansion', gsc_clicks: null, gsc_scope: null, seed_queries: ['succulent gift box'], edited_from: null },
      { base_keyword: 'succulent gift box', source: 'gsc_observed', gsc_clicks: 3, gsc_scope: 'site-wide', seed_queries: null, edited_from: null },
      { base_keyword: 'succulent gift boxes', source: 'manual', gsc_clicks: null, gsc_scope: null, seed_queries: null, edited_from: 'succulent gift box' },
    ])
    const saved = (await pg.query('select save_status, data from keyword_projects where id = $1', [id])).rows[0]
    expect(saved.save_status).toBe('complete')
    expect(saved.data.adGroups[0].keywords[1].seedRefs).toEqual(['succulent gift box'])
  })

  it('upgrade: v1 applied earlier with existing data, then v2 — nothing lost', async () => {
    const pg = await db()
    await pg.exec(V1)
    const { rows: [u] } = await pg.query(`insert into gsc_uploads (source, rows_count) values ('csv_upload', 1) returning id`)
    await pg.query(`insert into ad_keywords (upload_id, keyword, match_type, category, source, is_gap_category) values ($1, '"succulent gift box"', 'phrase', 'Gift Boxes', 'suggested', true)`, [u.id])
    await pg.query(`insert into keyword_projects (name, mode, data) values ('Old project', 'category', '{"version":1}')`)
    await pg.exec(V2)
    const legacy = (await pg.query('select keyword, source, upload_id, gsc_clicks, seed_queries from ad_keywords')).rows
    expect(legacy).toEqual([{ keyword: '"succulent gift box"', source: 'suggested', upload_id: u.id, gsc_clicks: null, seed_queries: null }])
    expect((await pg.query('select name, data from keyword_projects')).rows).toEqual([{ name: 'Old project', data: { version: 1 } }])
    await appWrite(pg)
  })

  it('upgrade from the combined file shipped in the GSC-first build (float columns already present)', async () => {
    const pg = await db()
    await pg.exec(COMBINED)
    const before = await columns(pg, 'ad_keywords')
    expect(before).not.toHaveProperty('edited_from')
    await pg.exec(V2)
    const after = await columns(pg, 'ad_keywords')
    expect(after.gsc_ctr).toBe('double precision') // float == double precision: no type conflict
    expect(after).toHaveProperty('edited_from')
    await appWrite(pg)
  })

  it('v2 without v1 fails with a clear message and changes nothing', async () => {
    const pg = await db()
    await expect(pg.exec(V2)).rejects.toThrow(/Apply supabase\/migrations\/20261021_keyword_projects.sql first/)
    expect(await columns(pg, 'ad_keywords')).not.toHaveProperty('gsc_scope')
  })

  it('gsc_scope only accepts page / site-wide', async () => {
    const pg = await db()
    await pg.exec(V1)
    await pg.exec(V2)
    await expect(pg.query(`insert into ad_keywords (keyword, gsc_scope) values ('x', 'everywhere')`)).rejects.toThrow(/ad_keywords_gsc_scope_check/)
  })
})
