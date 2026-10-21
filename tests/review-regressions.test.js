// Regression tests for the pre-release review of the GSC-first workflow (points 1–7).
// Point 8 (migrations) is covered in migrations.test.js against a real Postgres engine.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createStore, newProject, createPageGroup, ensureCategoryGroups, findSeeds, runKeywordGeneration, updateGroup,
  setSeedSelection, addManualSeed, editKeyword, evidenceProblem, projectRows, rowsToCsv, serializeProject,
  deserializeProject, buildHeadlineBatches, runHeadlineBatches, datasetRef, addDerivedSeed,
} from '../src/lib/workspace.js'
import { processQueries } from '../src/lib/categorize.js'
import { primaryEvidence, suggestTheme, FLAG_LABELS } from '../src/lib/seedMatching.js'
import { queryAllRows, fetchPageQueries, GscError } from '../src/lib/gscApi.js'
import { saveProject, setClient, projectKeywordRows } from '../src/lib/supabase.js'
import { mockApi, mockSupabase, jsonResponse } from './helpers.js'

const row = (query, clicks, impressions, position = 8) => ({ query, clicks, impressions, ctr: impressions ? (clicks / impressions) * 100 : 0, position })
const apiDataset = (rows, start = '2026-04-24', end = '2026-10-21') => ({ queries: processQueries(rows), source: 'gsc_api', dateStart: start, dateEnd: end, uploadId: null })
const SITE = [row('calico kitten crassula', 3, 400), row('calico kitten succulent', 0, 85), row('buy crassula', 2, 150), row('zz plant', 30, 3000)]
const productPage = {
  type: 'product', url: 'https://succulentsbox.com/products/calico-kitten-crassula', handle: 'calico-kitten-crassula',
  title: 'Calico Kitten Crassula', description: 'Variegated crassula', productType: 'Succulent', tags: [], variants: [], details: [],
}
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }

let store
beforeEach(() => { store = createStore(newProject()) })
const ctx = () => ({ getProject: store.getProject, setProject: store.setProject })
const g0 = () => store.getProject().adGroups[0]
const addProduct = (extra = {}) => { const g = createPageGroup(productPage, extra); store.setProject(p => ({ ...p, adGroups: [...p.adGroups, g] })); return g }

// Mock GSC endpoint that serves rows page by page using startRow/rowLimit
function gscPages(total, status = 200) {
  const bodies = []
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body)
    bodies.push(body)
    if (status !== 200) return jsonResponse({ error: { message: 'denied' } }, status)
    const n = Math.max(0, Math.min(body.rowLimit, total - body.startRow))
    return jsonResponse({ rows: Array.from({ length: n }, (_, i) => ({ keys: [`q${body.startRow + i}`], clicks: 0, impressions: 1, ctr: 0, position: 9 })) })
  }
  return { fetchImpl, bodies }
}

describe('1 · page-level retrieval: reporting period, pagination, incomplete label', () => {
  it('paginates with startRow until a short page', async () => {
    const { fetchImpl, bodies } = gscPages(7)
    const res = await queryAllRows('tok', { startDate: 'a', endDate: 'b', dimensions: ['query'] }, { fetchImpl, pageSize: 3 })
    expect(res.rows).toHaveLength(7)
    expect(res.incomplete).toBe(false)
    expect(bodies.map(b => b.startRow)).toEqual([0, 3, 6])
  })

  it('labels results incomplete when the row cap stops pagination', async () => {
    const { fetchImpl } = gscPages(50)
    const res = await queryAllRows('tok', {}, { fetchImpl, pageSize: 10, maxRows: 20 })
    expect(res).toMatchObject({ incomplete: true })
    expect(res.rows).toHaveLength(20)
  })

  it('page-level requests use the dataset period; a reloaded period is used on the next match', async () => {
    const g = addProduct()
    const periods = []
    const fetchPageRows = async (page, period) => { periods.push(period); return { rows: [row('calico kitten', 1, 20)], incomplete: true } }
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE), fetchPageRows })
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE, '2025-06-22', '2026-10-21'), fetchPageRows })
    expect(periods).toEqual([{ dateStart: '2026-04-24', dateEnd: '2026-10-21' }, { dateStart: '2025-06-22', dateEnd: '2026-10-21' }])
    expect(g0().seedStatus.pageLevel).toMatchObject({ status: 'ok', incomplete: true, periodStart: '2025-06-22' })
    expect(g0().seeds.find(s => s.query === 'calico kitten').evidence[0]).toMatchObject({ scope: 'page', periodStart: '2025-06-22' })
  })

  it('fetchPageQueries refuses to run without a period', () => {
    expect(() => fetchPageQueries('tok', productPage, null)).toThrow(/reporting period is required/)
  })
})

describe('2 · no double counting across scopes', () => {
  it('page-level and site-wide rows for the same query stay separate and are never summed', async () => {
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE), fetchPageRows: async () => ({ rows: [row('calico kitten crassula', 1, 60)], incomplete: false }) })
    const seeds = g0().seeds.filter(s => s.base === 'calico kitten crassula')
    expect(seeds).toHaveLength(1)
    const ev = seeds[0].evidence
    expect(ev.find(e => e.scope === 'page')).toMatchObject({ clicks: 1, impressions: 60 })
    expect(ev.find(e => e.scope === 'site-wide')).toMatchObject({ clicks: 3, impressions: 400 })
    expect(primaryEvidence(seeds[0])).toMatchObject({ scope: 'page', impressions: 60 })

    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, seeds: x.seeds.map(s => ({ ...s, selected: s.base === 'calico kitten crassula' })) })))
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [] }), dataset: apiDataset(SITE) })
    const rows = projectRows(store.getProject())
    expect(rows).toHaveLength(3) // one keyword × 3 match types, not one per scope
    expect(rows.every(r => r.evidence.impressions === 60)).toBe(true)
  })

  it('spelling variants with the same normalized query keep the larger row and note the other', async () => {
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset([row('calico kitten crassula', 3, 400), row('Calico-Kitten Crassula!', 1, 90), ...SITE.slice(1)]) })
    // "calico-kitten crassula" normalizes differently (hyphen kept) — use exact-normalizing variant
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset([row('calico kitten crassula', 3, 400), row('Calico Kitten Crassula!', 1, 90)]) })
    const seeds = g0().seeds.filter(s => s.base === 'calico kitten crassula')
    expect(seeds).toHaveLength(1)
    expect(seeds[0].evidence).toHaveLength(1)
    expect(seeds[0].evidence[0]).toMatchObject({ impressions: 400, clicks: 3 }) // max, not 490
    expect(seeds[0].reasons.join(' ')).toMatch(/variant "Calico Kitten Crassula!" also in GSC \(90 impr\., site-wide\) — metrics not combined/)
  })
})

describe('3 · authorization/API failures are errors, not "no relevant queries"', () => {
  it('maps 401 and 403 to typed errors', async () => {
    await expect(queryAllRows('tok', {}, { fetchImpl: gscPages(0, 401).fetchImpl })).rejects.toMatchObject({ code: 'auth_expired' })
    await expect(queryAllRows('tok', {}, { fetchImpl: gscPages(0, 403).fetchImpl })).rejects.toMatchObject({ code: 'permission' })
    await expect(queryAllRows('tok', {}, { fetchImpl: async () => { throw new TypeError('offline') } })).rejects.toMatchObject({ code: 'network' })
  })

  it('a failed page-level request puts the group in an error state and blocks generation', async () => {
    const g = addProduct()
    const fail = async () => { throw new GscError('auth_expired', 'Google sign-in expired — reconnect Search Console and try again.', 401) }
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset([row('zz plant', 30, 3000)]), fetchPageRows: fail })
    const st = g0().seedStatus
    expect(st.state).toBe('error') // not 'done' with zero seeds
    expect(st.pageLevel).toMatchObject({ status: 'error', code: 'auth_expired' })
    expect(st.error).toMatch(/sign-in expired/)
    expect(evidenceProblem(g0(), apiDataset([row('zz plant', 30, 3000)]))).toMatch(/sign-in expired/)
    const api = mockApi()
    const [outcome] = await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: apiDataset([row('zz plant', 30, 3000)]) })
    expect(outcome.ok).toBe(false)
    expect(api.calls.keywords).toHaveLength(0)
  })

  it('a Search Console dataset without a live connection is labelled, not reported as empty', async () => {
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE), fetchPageRows: null })
    expect(g0().seedStatus.pageLevel).toMatchObject({ status: 'unavailable' })
    expect(g0().seedStatus.pageLevel.message).toMatch(/not connected/)
  })
})

describe('4 · seed references must be selected seeds', () => {
  it('rejects invented and unselected references', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    const unselected = g0().seeds.find(s => s.query === 'buy crassula')
    store.setProject(p => setSeedSelection(p, g.id, [unselected.id], false))
    const api = mockApi({ keywordsFor: () => [
      { keyword: 'calico kitten crassula plant', seedRefs: ['calico kitten crassula'] }, // valid
      { keyword: 'crassula plants online', seedRefs: ['buy crassula'] }, // unselected seed
      { keyword: 'calico kitten gift', seedRefs: ['a query nobody searched'] }, // invented
      { keyword: 'calico succulent sale', seedRefs: [] }, // none
    ] })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    expect(api.calls.keywords[0].seeds.map(s => s.query)).not.toContain('buy crassula')
    const ai = g0().keywords.filter(k => k.source === 'ai_expansion')
    expect(ai.map(k => [k.base, k.seedRefs])).toEqual([['calico kitten crassula plant', ['calico kitten crassula']]])
    expect(g0().status.lastRun.rejected).toBe(3)
  })
})

describe('5 · editing an observed query drops its metrics', () => {
  it('edited phrase becomes manual without evidence, in rows, CSV and the database mirror', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [] }), dataset: ds })
    const obs = g0().keywords.find(k => k.base === 'calico kitten crassula')
    store.setProject(p => updateGroup(p, g.id, x => editKeyword(x, obs.id, 'calico kitten crassula plants')))
    const edited = g0().keywords.find(k => k.id === obs.id)
    expect(edited).toMatchObject({ source: 'manual', evidence: [], editedFrom: 'calico kitten crassula' })
    const r = projectRows(store.getProject()).find(x => x.keywordId === obs.id)
    expect(r.evidence).toBeNull()
    const line = rowsToCsv([r]).split('\n')[1]
    expect(line).toContain('"Added manually","","calico kitten crassula"')
    expect(line.endsWith('"","","","","",""')).toBe(true)
    const mirror = projectKeywordRows(store.getProject(), 'p1').find(m => m.base_keyword === 'calico kitten crassula plants')
    expect(mirror).toMatchObject({ source: 'manual', edited_from: 'calico kitten crassula', gsc_clicks: null, gsc_impressions: null, gsc_scope: null, seed_queries: null })
  })
})

describe('6 · outdated evidence and late responses', () => {
  it('dataset/period change and target change make evidence unusable until re-matched', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    expect(evidenceProblem(g0(), ds)).toBeNull()
    expect(evidenceProblem(g0(), apiDataset(SITE, '2025-06-22'))).toMatch(/dataset or reporting period changed/)
    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, aliases: ['variegated crassula'] })))
    expect(evidenceProblem(g0(), ds)).toMatch(/target .* changed/)
    const api = mockApi()
    const [o] = await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    expect(o.ok).toBe(false)
    expect(api.calls.keywords).toHaveLength(0)
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    expect(evidenceProblem(g0(), ds)).toBeNull()
  })

  it('a late seed response cannot overwrite a newer one', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    const slow = deferred()
    const first = findSeeds({ groupId: g.id, ...ctx(), dataset: ds, fetchPageRows: () => slow.promise })
    // user changes aliases and re-matches while the first request is still waiting
    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, aliases: ['crassula variegata'] })))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, fetchPageRows: async () => ({ rows: [row('crassula variegata', 2, 30)], incomplete: false }) })
    slow.resolve({ rows: [row('old page query', 9, 99)], incomplete: false })
    expect(await first).toEqual({ discarded: true })
    expect(g0().seeds.map(s => s.query)).toContain('crassula variegata')
    expect(g0().seeds.map(s => s.query)).not.toContain('old page query')
    expect(g0().seedStatus.state).toBe('done')
  })

  it('a late AI response is discarded if the evidence changed meanwhile', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    const slow = deferred()
    const api = { generateKeywords: () => slow.promise }
    const run = runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, level: 'broad' }) // new evidence version
    slow.resolve({ keywords: [{ keyword: 'calico kitten crassula delivered', seedRefs: ['calico kitten crassula'] }] })
    const [o] = await run
    expect(o.value).toMatchObject({ discarded: true })
    expect(g0().keywords.some(k => k.base === 'calico kitten crassula delivered')).toBe(false)
    expect(g0().status.error).toMatch(/AI results were discarded/)
  })

  it('manual seeds get evidence from the new dataset, or are removed if the query is missing', async () => {
    const ds1 = apiDataset([...SITE, row('zz plant', 30, 3000)])
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds1 })
    store.setProject(p => addManualSeed(p, g.id, ds1.queries.find(q => q.query === 'zz plant'), ds1))
    const ds2 = apiDataset(SITE.filter(r => r.query !== 'zz plant'), '2025-06-22')
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds2 })
    expect(g0().seeds.some(s => s.query === 'zz plant')).toBe(false)
    expect(g0().seedStatus.droppedManual).toBe(1)
    expect(g0().seeds.every(s => s.evidence.every(e => e.periodStart === '2025-06-22'))).toBe(true)
  })

  it('a headline response for a keyword edited mid-request is not applied to the new wording', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [] }), dataset: ds })
    const kw = g0().keywords[0]
    const slow = deferred()
    const api = { generateHeadlines: () => slow.promise }
    const run = runHeadlineBatches({ batches: buildHeadlineBatches(store.getProject(), [kw.id]), ...ctx(), api, autoRetryInvalid: false })
    store.setProject(p => updateGroup(p, g.id, x => editKeyword(x, kw.id, 'new wording here')))
    slow.resolve({ results: { 'new wording here': { headlines: ['A', 'B', 'C'], valid: true, issues: [] }, [kw.base]: { headlines: ['X', 'Y', 'Z'], valid: true, issues: [] } } })
    await run
    expect(g0().keywords.find(k => k.id === kw.id)).toMatchObject({ base: 'new wording here', headlines: [], headlineStatus: 'none' })
  })
})

describe('7 · saved projects reopen with seeds, evidence, period and references', () => {
  it('round-trips through save and reopen', async () => {
    const db = mockSupabase()
    setClient(db)
    const ds = apiDataset(SITE)
    const g = addProduct({ aliases: ['calico crassula'] })
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, fetchPageRows: async () => ({ rows: [row('calico kitten', 1, 40)], incomplete: true }) })
    const excluded = g0().seeds.find(s => s.query === 'buy crassula')
    store.setProject(p => setSeedSelection(p, g.id, [excluded.id], false))
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [{ keyword: 'calico kitten plant', seedRefs: ['calico kitten'] }] }), dataset: ds })
    store.setProject(p => ({ ...p, gscRef: datasetRef(ds) }))
    await saveProject(store.getProject())

    const reopened = deserializeProject(db.tables.keyword_projects[0])
    const rg = reopened.adGroups[0]
    const og = g0()
    expect(rg.seeds.map(s => [s.query, s.selected])).toEqual(og.seeds.map(s => [s.query, s.selected]))
    expect(rg.seeds.find(s => s.query === 'buy crassula').selected).toBe(false)
    expect(rg.seeds.find(s => s.query === 'calico kitten').evidence[0]).toMatchObject({ scope: 'page', impressions: 40, periodStart: '2026-04-24', periodEnd: '2026-10-21' })
    expect(rg.seedStatus).toMatchObject({ state: 'done', pageLevel: { incomplete: true }, dataset: { dateStart: '2026-04-24' } })
    expect(rg.keywords.find(k => k.source === 'ai_expansion').seedRefs).toEqual(['calico kitten'])
    expect(primaryEvidence(rg.keywords.find(k => k.base === 'calico kitten'))).toMatchObject({ scope: 'page', impressions: 40 })
    expect(reopened.gscRef).toMatchObject({ source: 'gsc_api', dateStart: '2026-04-24', dateEnd: '2026-10-21' })
    expect(rg.aliases).toEqual(['calico crassula'])
    // usable with the same dataset; outdated with another period
    expect(evidenceProblem(rg, ds)).toBeNull()
    expect(evidenceProblem(rg, apiDataset(SITE, '2025-01-01'))).toMatch(/changed/)
    expect(serializeProject(reopened)).toEqual(serializeProject(store.getProject()))
  })

  it('category groups reopen too', async () => {
    const ds = apiDataset([row('succulents for sale', 5, 100)])
    store.setProject(p => ensureCategoryGroups(p, ['Succulents']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds })
    const rg = deserializeProject({ id: 'x', name: 'n', mode: 'category', data: serializeProject(store.getProject()) }).adGroups[0]
    expect(rg.seeds[0]).toMatchObject({ query: 'succulents for sale', selected: true })
    expect(evidenceProblem(rg, ds)).toBeNull()
  })
})

describe('additional release regressions', () => {
  it('detects replaced datasets with identical dates and row counts', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    expect(evidenceProblem(g0(), apiDataset(SITE.map(r => ({ ...r, impressions: r.impressions + 1 }))))).toMatch(/dataset or reporting period changed/)
  })

  it('refreshes existing observed keyword metrics after re-matching', async () => {
    const g = addProduct()
    const api = mockApi({ keywordsFor: () => [] })
    const ds = apiDataset(SITE)
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    const newer = apiDataset(SITE.map(r => ({ ...r, impressions: r.impressions + 100 })), '2025-01-01')
    await findSeeds({ groupId: g.id, ...ctx(), dataset: newer })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: newer })
    expect(g0().keywords.find(k => k.base === 'calico kitten crassula').evidence[0]).toMatchObject({ impressions: 500, periodStart: '2025-01-01' })
  })

  it('discards AI responses after a seed is deselected mid-request', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    const slow = deferred()
    const seed = g0().seeds.find(s => s.selected)
    const run = runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: { generateKeywords: () => slow.promise }, dataset: ds })
    store.setProject(p => setSeedSelection(p, g.id, [seed.id], false))
    slow.resolve({ keywords: [{ keyword: 'buy calico kitten plants', seedRefs: [seed.query] }] })
    await run
    expect(g0().keywords.some(k => k.base === 'buy calico kitten plants')).toBe(false)
  })

  it('discards headline responses after target aliases change', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [] }), dataset: ds })
    const kw = g0().keywords[0]
    const slow = deferred()
    const run = runHeadlineBatches({ batches: buildHeadlineBatches(store.getProject(), [kw.id]), ...ctx(), api: { generateHeadlines: () => slow.promise } })
    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, aliases: ['changed target'] })))
    slow.resolve({ results: { [kw.base]: { headlines: ['A', 'B', 'C'], valid: true } } })
    await run
    expect(g0().keywords[0].headlines).toEqual([])
  })
})

describe('follow-ups to the reviewed build', () => {
  it('content key is cached per dataset rows array (no re-hash on every render)', () => {
    const rows = processQueries(SITE)
    const ds = { queries: rows, source: 'gsc_api', dateStart: 'a', dateEnd: 'b' }
    const k1 = datasetRef(ds).contentKey
    rows.push(row('mutated in place', 1, 1)) // same array object: cache returns the stored key
    expect(datasetRef(ds).contentKey).toBe(k1)
    const fresh = processQueries([...SITE, row('mutated in place', 1, 1)]) // a new dataset is always a new array
    expect(datasetRef({ ...ds, queries: fresh }).contentKey).not.toBe(k1)
  })

  it('a headline batch dropped because the ad group changed is reported as failed, so it can be retried', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => [] }), dataset: ds })
    const slow = deferred()
    const batches = buildHeadlineBatches(store.getProject(), [g0().keywords[0].id])
    const run = runHeadlineBatches({ batches, ...ctx(), api: { generateHeadlines: () => slow.promise }, autoRetryInvalid: false })
    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, aliases: ['changed target'] })))
    slow.resolve({ results: { [g0().keywords[0].base]: { headlines: ['A', 'B', 'C'], valid: true, issues: [] } } })
    const { failed, succeeded } = await run
    expect(succeeded).toBe(0)
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toMatch(/changed while headlines were generating/)
    expect(g0().keywords[0].headlines).toEqual([])
  })

  it('evidence reset by a dataset replacement still explains that the dataset changed', async () => {
    const ds = apiDataset(SITE)
    const g = addProduct()
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    // what App does when the dataset is replaced
    store.setProject(p => updateGroup(p, g.id, x => ({ ...x, seedStatus: { ...x.seedStatus, state: 'none', requestId: 'reset' } })))
    const replaced = apiDataset(SITE.map(r => ({ ...r, clicks: r.clicks + 1 })))
    expect(evidenceProblem(g0(), replaced)).toMatch(/dataset or reporting period changed/)
  })
})

describe('long queries in GSC data', () => {
  // The full query from the screenshot (a long, paragraph-like query that ends in a question)
  const PROMPT = "i am a 25-34 or 35-44 year old female. my main motivations: they are often millennial parents who are always on the hunt for something perfect, that ticks all their boxes, and that takes time - but to them, shopping is a labor of love. they love to be inspired and use pinterest, tiktok and instagram for that purpose. they value items and experiences with the human touch and like to indulge their kids with little extras. their favorite part of shopping is finding hidden gems. and they are informed – seeking advice before making purchases. my main pain points: - i have no need to buy anything - i'm happy with the websites i use at the moment - i don't have a need for the items they sell - at the moment i have less money to spend on non-essentials - the products are expensive - unsure about the quality of products what gift baskets do people recommend for grandparents"

  it('long prompt-like queries stay visible but are flagged and unselected', async () => {
    const ds = apiDataset([row('gift baskets for grandparents', 1, 30), row(PROMPT, 0, 2, 1)])
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds })
    const prompt = g0().seeds.find(s => s.query === PROMPT)
    expect(prompt).toMatchObject({ selected: false })
    expect(prompt.flags).toContain('too long')
    expect(FLAG_LABELS['too long']).toBe('Long query: extract a shorter theme before using for ads')
    expect(g0().seeds.find(s => s.query === 'gift baskets for grandparents').selected).toBe(true)
  })

  it('suggests a short theme from the question at the end of the prompt', () => {
    expect(suggestTheme(PROMPT)).toBe('gift baskets for grandparents')
    expect(suggestTheme('Which plant gifts are best for a new mom?')).toBe('plant gifts for a new mom')
    expect(suggestTheme('what is a good succulent gift for a coworker')).toBe('succulent gift for a coworker')
    expect(suggestTheme('birthday gift ideas for mom who loves gardening and has everything')).toBe('birthday gift ideas for mom')
  })

  it('a selected long query alone cannot be used; generation asks for a theme and makes no AI call', async () => {
    const ds = apiDataset([row(PROMPT, 0, 2, 1)])
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds })
    store.setProject(p => setSeedSelection(p, g0().id, g0().seeds.map(s => s.id), true))
    expect(evidenceProblem(g0(), ds)).toMatch(/too long .* extract a short theme/)
    const api = mockApi()
    const [o] = await runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: ds })
    expect(o.ok).toBe(false)
    expect(api.calls.keywords).toHaveLength(0)
  })

  it('a derived theme is labelled, linked to its source, and never inherits the source metrics', async () => {
    const ds = apiDataset([row('gift baskets for grandparents', 1, 30), row(PROMPT, 0, 2, 1)])
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds })
    const long = g0().seeds.find(s => s.query === PROMPT)
    store.setProject(p => addDerivedSeed(p, g0().id, long.id, 'Plant gifts for grandparents'))
    const derived = g0().seeds.find(s => s.origin === 'derived')
    expect(derived).toMatchObject({ query: 'plant gifts for grandparents', evidence: [], selected: true, derivedFrom: PROMPT })
    expect(derived.reasons[0]).toMatch(/derived from a long GSC query \(2 impr\., 0 clicks\) — the theme has no metrics of its own/)
    expect(g0().seeds.find(s => s.id === long.id)).toMatchObject({ selected: false, evidence: [expect.objectContaining({ impressions: 2, position: 1 })] })

    const api = mockApi({ keywordsFor: () => [{ keyword: 'grandparent plant gift basket', seedRefs: ['plant gifts for grandparents'] }] })
    await runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: ds })
    const sent = api.calls.keywords[0].seeds
    expect(sent).toEqual(expect.arrayContaining([{ query: 'plant gifts for grandparents', scope: 'derived' }]))
    expect(sent.some(x => x.query === PROMPT)).toBe(false)
    const kw = g0().keywords.find(k => k.base === 'plant gifts for grandparents')
    expect(kw).toMatchObject({ source: 'gsc_derived', evidence: [], derivedFrom: PROMPT })
    expect(g0().keywords.find(k => k.source === 'ai_expansion').seedRefs).toEqual(['plant gifts for grandparents'])

    const r = projectRows(store.getProject()).find(x => x.keywordId === kw.id)
    expect(r.evidence).toBeNull()
    const line = rowsToCsv([r]).split('\n')[1]
    expect(line).toContain('"Derived from GSC query"')
    expect(line).toContain(`"${PROMPT}"`)
    expect(line.endsWith('"","","","","",""')).toBe(true) // no scope, metrics or period
    const mirror = projectKeywordRows(store.getProject(), 'p1').find(m => m.base_keyword === 'plant gifts for grandparents')
    expect(mirror).toMatchObject({ source: 'gsc_derived', seed_queries: [PROMPT], gsc_clicks: null, gsc_impressions: null, gsc_position: null, gsc_scope: null })
  })

  it('derived themes survive re-matching and saving, and are dropped if the source query leaves the dataset', async () => {
    const ds = apiDataset([row('gift baskets for grandparents', 1, 30), row(PROMPT, 0, 2, 1)])
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds })
    store.setProject(p => addDerivedSeed(p, g0().id, g0().seeds.find(s => s.query === PROMPT).id, 'plant gifts for grandparents'))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: ds, level: 'broad' })
    expect(g0().seeds.filter(s => s.origin === 'derived')).toHaveLength(1)
    const reopened = deserializeProject({ id: 'x', name: 'n', mode: 'category', data: serializeProject(store.getProject()) })
    expect(reopened.adGroups[0].seeds.find(s => s.origin === 'derived')).toMatchObject({ derivedFrom: PROMPT, evidence: [] })
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: apiDataset([row('gift baskets for grandparents', 1, 30)]) })
    expect(g0().seeds.some(s => s.origin === 'derived')).toBe(false)
  })
})


describe('mixed long and usable seed selection', () => {
  it('keeps expansions and reports added observed queries when long queries are also checked', async () => {
    const long = 'gift baskets for grandparents ' + 'with thoughtful gifts and plants '.repeat(6)
    const ds = apiDataset([row('gift baskets for grandparents', 1, 30), row(long, 0, 2)])
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    const id = g0().id
    await findSeeds({ groupId: id, ...ctx(), dataset: ds })
    store.setProject(p => setSeedSelection(p, id, g0().seeds.map(s => s.id), true))
    const api = mockApi({ keywordsFor: () => [{ keyword: 'plant gift baskets for grandparents', seedRefs: ['gift baskets for grandparents'] }] })
    await runKeywordGeneration({ groupIds: [id], ...ctx(), api, dataset: ds })
    expect(api.calls.keywords[0].seeds.every(s => s.query !== long)).toBe(true)
    expect(g0().keywords.some(k => k.source === 'ai_expansion')).toBe(true)
    expect(g0().status.lastRun).toMatchObject({ observedAdded: 1, observedSkipped: 1, aiAdded: 1 })
  })
})
