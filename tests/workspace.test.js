import { describe, it, expect, beforeEach } from 'vitest'
import {
  createStore, newProject, ensureCategoryGroups, categoryGroupIds, createPageGroup, runKeywordGeneration,
  buildHeadlineBatches, runHeadlineBatches, projectRows, filterRows, rowsToCsv, serializeProject,
  deserializeProject, findSeeds, setSeedSelection, addManualSeed, editKeyword, groupPayload, selectedSeeds,
} from '../src/lib/workspace.js'
import { processQueries } from '../src/lib/categorize.js'
import { primaryEvidence } from '../src/lib/seedMatching.js'
import { pageUrlRegex, fetchPageQueries } from '../src/lib/gscApi.js'
import { saveProject, saveAnalysis, setClient, normalizeKeywordRow } from '../src/lib/supabase.js'
import { mockApi, mockSupabase, jsonResponse } from './helpers.js'

const row = (query, clicks, impressions, position = 8) => ({ query, clicks, impressions, ctr: impressions ? (clicks / impressions) * 100 : 0, position })

// Site-wide dataset from the Search Console API
const apiDataset = (rows) => ({ queries: processQueries(rows), source: 'gsc_api', dateStart: '2026-04-24', dateEnd: '2026-10-21', uploadId: null })
// Query-only CSV import (no period, no page-level data)
const csvDataset = (rows) => ({ queries: processQueries(rows), source: 'csv_upload', dateStart: null, dateEnd: null, uploadId: null })

const SITE_ROWS = [
  row('succulents for sale', 500, 9000),
  row('buy succulents online', 300, 5000),
  row('succulent gift box', 120, 3000),
  row('birthday plant gift', 20, 900),
  row('air plants for sale', 100, 2000),
  row('calico kitten crassula', 0, 85), // zero clicks, real impressions
  row('crassula care', 40, 2000),
  row('why is my succulent dying', 80, 5000),
  row('zz plant', 30, 3000),
]

const collectionPage = {
  type: 'collection', url: 'https://succulentsbox.com/collections/plant-gift-boxes', handle: 'plant-gift-boxes',
  title: 'Curated Plant Gift Boxes | Live Plants', description: 'Celebrate special moments', productsCount: 2,
  products: [
    { handle: 'birthday-box', title: 'Birthday Succulent Gift Box', priceMin: 30, priceMax: 30, available: true },
    { handle: 'sympathy-box', title: 'Sympathy Plant Gift', priceMin: 40, priceMax: 40, available: true },
  ],
}
const productPage = {
  type: 'product', url: 'https://succulentsbox.com/products/calico-kitten-crassula', handle: 'calico-kitten-crassula',
  title: 'Calico Kitten Crassula', description: 'Variegated crassula', productType: 'Succulent', tags: [],
  priceMin: 6.5, priceMax: 6.5, variants: [{ title: '2 inch', price: 6.5, available: true }], details: [],
}

let store
beforeEach(() => { store = createStore(newProject()) })
const ctx = () => ({ getProject: store.getProject, setProject: store.setProject })
const group = id => store.getProject().adGroups.find(g => g.id === id)

async function categoryFlow(cats, dataset, api = mockApi()) {
  store.setProject(p => ensureCategoryGroups({ ...p, selectedCategories: cats }, cats))
  const ids = categoryGroupIds(store.getProject(), cats)
  for (const id of ids) await findSeeds({ groupId: id, ...ctx(), dataset })
  const outcomes = await runKeywordGeneration({ groupIds: ids, ...ctx(), api, dataset })
  return { ids, outcomes, api }
}

describe('GSC dataset is required', () => {
  it('generation without a dataset is refused', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Succulents']))
    const id = store.getProject().adGroups[0].id
    await expect(runKeywordGeneration({ groupIds: [id], ...ctx(), api: mockApi(), dataset: null })).rejects.toThrow(/needs a GSC dataset/)
    await expect(findSeeds({ groupId: id, ...ctx(), dataset: null })).rejects.toThrow(/Load a GSC dataset/)
  })
})

describe('category mode from GSC seeds', () => {
  it('finds relevant queries across categories and generates only the selected category', async () => {
    const { ids, api } = await categoryFlow(['Gift Boxes'], apiDataset(SITE_ROWS))
    const g = group(ids[0])
    expect(store.getProject().adGroups).toHaveLength(1)
    expect(g.seeds.map(s => s.query)).toEqual(expect.arrayContaining(['succulent gift box', 'birthday plant gift']))
    expect(g.seeds.find(s => s.query === 'succulent gift box').reasons[0]).toMatch(/gift box/)
    expect(api.calls.keywords).toHaveLength(1)
    expect(api.calls.keywords[0].seeds.map(s => s.query)).toEqual(expect.arrayContaining(['succulent gift box']))
    // observed queries become keywords with their own metrics
    const observed = g.keywords.find(k => k.base === 'succulent gift box')
    expect(observed.source).toBe('gsc_observed')
    expect(primaryEvidence(observed)).toMatchObject({ scope: 'site-wide', clicks: 120, impressions: 3000, periodStart: '2026-04-24' })
  })

  it('multiple categories stay separate and one regeneration preserves the others', async () => {
    const ds = apiDataset(SITE_ROWS)
    const { ids } = await categoryFlow(['Succulents', 'Air Plants'], ds, mockApi({ keywordsFor: p => [`${p.adGroup.category.toLowerCase()} delivered`] }))
    const air = JSON.stringify(group(ids[1]))
    await runKeywordGeneration({ groupIds: [ids[0]], ...ctx(), api: mockApi({ keywordsFor: () => ['succulent plants online'] }), dataset: ds })
    expect(JSON.stringify(group(ids[1]))).toBe(air)
    expect(group(ids[1]).keywords.map(k => k.base)).toEqual(['air plants for sale', 'air plants delivered'])
  })

  it('informational and individual-plant queries stay visible but are unselected by default', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Succulents']))
    const id = store.getProject().adGroups[0].id
    await findSeeds({ groupId: id, ...ctx(), dataset: apiDataset(SITE_ROWS) })
    const by = q => group(id).seeds.find(s => s.query === q)
    expect(by('why is my succulent dying')).toMatchObject({ selected: false, flags: ['informational'] })
    expect(by('calico kitten crassula')).toMatchObject({ selected: false, flags: ['individual plant'] })
    expect(by('succulents for sale').selected).toBe(true)
  })

  it('repeated generation does not duplicate keywords', async () => {
    const ds = apiDataset(SITE_ROWS)
    const api = mockApi({ keywordsFor: () => ['succulents delivered', 'succulents for sale'] })
    const { ids } = await categoryFlow(['Succulents'], ds, api)
    await runKeywordGeneration({ groupIds: ids, ...ctx(), api, dataset: ds })
    const bases = group(ids[0]).keywords.map(k => k.base)
    expect(new Set(bases).size).toBe(bases.length)
    expect(api.calls.keywords[1].avoid).toEqual(expect.arrayContaining(['succulents delivered', 'succulents for sale']))
  })
})

describe('collection and product modes', () => {
  it('page-level queries are retrieved for the URL and kept distinct from site-wide matches', async () => {
    const g = createPageGroup(collectionPage, { selectedProductHandles: ['birthday-box'] })
    store.setProject(p => ({ ...p, adGroups: [g] }))
    const fetchPageRows = async (page) => { expect(page.url).toBe(collectionPage.url); return [row('plant gift boxes', 4, 210), row('succulent gift box', 9, 400)] }
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE_ROWS), fetchPageRows })
    const seeds = group(g.id).seeds
    const both = seeds.find(s => s.query === 'succulent gift box')
    expect(both.evidence.map(e => e.scope).sort()).toEqual(['page', 'site-wide'])
    expect(primaryEvidence(both)).toMatchObject({ scope: 'page', clicks: 9, impressions: 400 })
    expect(seeds.find(s => s.query === 'plant gift boxes').evidence).toHaveLength(1)
    expect(group(g.id).seedStatus.pageLevel).toMatchObject({ status: 'ok', count: 2 })
  })

  it('collection product selection changes the matched evidence and the generation context', async () => {
    const ds = apiDataset([...SITE_ROWS, row('sympathy plant gift', 12, 700)])
    const g = createPageGroup(collectionPage, { selectedProductHandles: ['birthday-box'] })
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    const sym = group(g.id).seeds.find(s => s.query === 'sympathy plant gift')
    expect(sym.reasons.join(' ')).not.toMatch(/Sympathy Plant Gift/) // only weak collection-level match
    const api = mockApi()
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    expect(api.calls.keywords[0].adGroup.context.products.map(p => p.handle)).toEqual(['birthday-box'])
    expect(api.calls.keywords[0].adGroup.landingUrl).toBe(collectionPage.url)
  })

  it('product mode: page-level data missing, relevant site-wide data used and labelled', async () => {
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: apiDataset(SITE_ROWS), fetchPageRows: async () => [] })
    const st = group(g.id).seedStatus
    expect(st.pageLevel).toMatchObject({ status: 'none' })
    const seed = group(g.id).seeds.find(s => s.query === 'calico kitten crassula')
    expect(seed.evidence[0].scope).toBe('site-wide')
    expect(seed.reasons.join(' ')).toMatch(/not page-specific/)
    expect(seed.selected).toBe(true) // product name allowed in product mode
  })

  it('a target with only one relevant query — a zero-click query with impressions — still works', async () => {
    const ds = apiDataset([row('calico kitten crassula', 0, 85), row('zz plant', 30, 3000)])
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    expect(group(g.id).seeds.map(s => s.query)).toEqual(['calico kitten crassula'])
    const api = mockApi({ keywordsFor: () => ['buy calico kitten crassula'] })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    const kws = group(g.id).keywords
    expect(kws.map(k => [k.base, k.source])).toEqual([['calico kitten crassula', 'gsc_observed'], ['buy calico kitten crassula', 'ai_expansion']])
    expect(primaryEvidence(kws[0])).toMatchObject({ clicks: 0, impressions: 85 })
  })

  it('query-only CSV: matched by text, never claimed as page searches', async () => {
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: csvDataset(SITE_ROWS) }) // no fetchPageRows
    const st = group(g.id).seedStatus
    expect(st.pageLevel.status).toBe('unavailable')
    expect(st.pageLevel.message).toMatch(/not searches for this exact page/)
    for (const s of group(g.id).seeds) {
      expect(s.evidence.every(e => e.scope === 'site-wide' && e.source === 'csv_upload')).toBe(true)
      expect(s.reasons.join(' ')).toMatch(/imported CSV — not data for this specific page/)
    }
  })

  it('AI expansions keep seed references and never inherit seed metrics', async () => {
    const ds = apiDataset(SITE_ROWS)
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), dataset: ds, api: mockApi({ keywordsFor: () => [{ keyword: 'calico kitten succulent for sale', seedRefs: ['calico kitten crassula'] }] }) })
    const exp = group(g.id).keywords.find(k => k.source === 'ai_expansion')
    expect(exp.seedRefs).toEqual(['calico kitten crassula'])
    expect(exp.evidence).toEqual([])
    const rows = projectRows(store.getProject()).filter(r => r.keywordId === exp.id)
    expect(rows.every(r => r.evidence === null)).toBe(true)
    const csv = rowsToCsv(rows.slice(0, 1)).split('\n')[1]
    expect(csv).toContain('"AI expansion","calico kitten crassula"')
    expect(csv.endsWith('"","","","","",""')).toBe(true) // no scope, metrics or period
  })

  it('no relevant seeds → honest empty state, no AI call, broader matching can still be offered', async () => {
    const ds = apiDataset([row('zz plant', 30, 3000), row('pothos care', 5, 500)])
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    expect(group(g.id).seeds).toEqual([])
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, level: 'broad' })
    expect(group(g.id).seeds).toEqual([])
    expect(group(g.id).seedStatus).toMatchObject({ state: 'done', level: 'broad', siteWideCount: 0 })
    const api = mockApi()
    const [outcome] = await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api, dataset: ds })
    expect(outcome.ok).toBe(false)
    expect(api.calls.keywords).toHaveLength(0)
    expect(group(g.id).keywords).toEqual([])
    expect(group(g.id).status.error).toMatch(/No selected GSC seed queries/)
  })

  it('manual seeds from the dataset can be added; selection is preserved when re-matching', async () => {
    const ds = apiDataset(SITE_ROWS)
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, adGroups: [g] }))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds })
    store.setProject(p => addManualSeed(p, g.id, ds.queries.find(q => q.query === 'buy succulents online'), ds))
    const target = group(g.id).seeds.find(s => s.query === 'calico kitten crassula')
    store.setProject(p => setSeedSelection(p, g.id, [target.id], false))
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, level: 'broad' })
    const seeds = group(g.id).seeds
    expect(seeds.find(s => s.query === 'buy succulents online')).toMatchObject({ origin: 'manual', selected: true })
    expect(seeds.find(s => s.query === 'calico kitten crassula').selected).toBe(false)
    expect(selectedSeeds(group(g.id)).map(s => s.query)).toContain('buy succulents online')
  })
})

describe('page-level GSC request', () => {
  it('filters by a regex covering all URL variants of the page', async () => {
    const re = new RegExp(pageUrlRegex(productPage))
    expect(re.test('https://succulentsbox.com/products/calico-kitten-crassula')).toBe(true)
    expect(re.test('https://www.succulentsbox.com/collections/succulents/products/calico-kitten-crassula?variant=1')).toBe(true)
    expect(re.test('https://succulentsbox.com/products/calico-kitten-crassula-large')).toBe(false)
    let body
    const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return jsonResponse({ rows: [{ keys: ['calico kitten'], clicks: 0, impressions: 12, ctr: 0, position: 14 }] }) }
    const { rows, incomplete } = await fetchPageQueries('tok', productPage, { dateStart: '2026-01-01', dateEnd: '2026-10-21' }, { fetchImpl })
    expect(body.dimensionFilterGroups[0].filters[0]).toMatchObject({ dimension: 'page', operator: 'includingRegex' })
    expect(body).toMatchObject({ startDate: '2026-01-01', endDate: '2026-10-21' })
    expect(rows).toEqual([{ query: 'calico kitten', clicks: 0, impressions: 12, ctr: 0, position: 14 }])
    expect(incomplete).toBe(false)
  })
})

describe('headlines', () => {
  const setup = async () => {
    const api = mockApi({ keywordsFor: () => Array.from({ length: 11 }, (_, i) => `succulent keyword ${i}`) })
    const { ids } = await categoryFlow(['Succulents'], apiDataset(SITE_ROWS), api)
    return group(ids[0]).keywords.map(k => k.id)
  }

  it('headline generation does not add keywords', async () => {
    const ids = await setup()
    const before = store.getProject().adGroups[0].keywords.length
    const api = mockApi({ headlinesFor: p => ({ results: Object.fromEntries([...p.keywords, 'brand new keyword'].map(k => [k, { headlines: ['A', 'B', 'C'], valid: true, issues: [] }])) }) })
    await runHeadlineBatches({ batches: buildHeadlineBatches(store.getProject(), ids.slice(0, 3)), ...ctx(), api })
    const kws = store.getProject().adGroups[0].keywords
    expect(kws).toHaveLength(before)
    expect(kws.filter(k => k.headlineStatus === 'valid')).toHaveLength(3)
  })

  it('partial batch failure keeps completed work; retry repeats only failed batches', async () => {
    const ids = await setup()
    const batches = buildHeadlineBatches(store.getProject(), ids)
    const api = mockApi({ headlinesFor: (p, n) => (n === 2 ? new Error('timeout') : { results: Object.fromEntries(p.keywords.map(k => [k, { headlines: ['A', 'B', 'C'], valid: true, issues: [] }])) }) })
    const { failed } = await runHeadlineBatches({ batches, ...ctx(), api, concurrency: 1 })
    expect(failed).toHaveLength(1)
    const okCount = store.getProject().adGroups[0].keywords.filter(k => k.headlineStatus === 'valid').length
    expect(okCount).toBe(ids.length - failed[0].keywordIds.length)
    const retryApi = mockApi()
    await runHeadlineBatches({ batches: failed, ...ctx(), api: retryApi })
    expect(retryApi.calls.headlines).toHaveLength(1)
    expect(store.getProject().adGroups[0].keywords.every(k => k.headlineStatus === 'valid')).toBe(true)
  })

  it('invalid output is retried once, then flagged', async () => {
    const ids = await setup()
    const bad = { headlines: ['Way too long headline for google ads', 'b', 'c'], valid: false, issues: ['headline 1 is 36 chars (max 30)'] }
    const api = mockApi({ headlinesFor: p => ({ results: Object.fromEntries(p.keywords.map(k => [k, bad])) }) })
    await runHeadlineBatches({ batches: buildHeadlineBatches(store.getProject(), ids.slice(0, 2)), ...ctx(), api })
    expect(api.calls.headlines).toHaveLength(2)
    expect(store.getProject().adGroups[0].keywords.filter(k => k.headlineStatus === 'invalid')).toHaveLength(2)
  })
})

describe('rows, filters, exports', () => {
  it('exports have ad groups, landing URLs, source labels and observed-only metrics', async () => {
    const ds = apiDataset(SITE_ROWS)
    const { ids } = await categoryFlow(['Gift Boxes'], ds, mockApi({ keywordsFor: () => ['succulent gift boxes delivered'] }))
    const rows = projectRows(store.getProject())
    const observed = rows.find(r => r.base === 'succulent gift box' && r.matchType === 'exact')
    const line = rowsToCsv([observed]).split('\n')
    expect(line[0]).toContain('"Ad group","Category","Landing page","Keyword"')
    expect(line[0]).toContain('"GSC evidence scope","GSC clicks","GSC impressions","GSC CTR (%)","GSC avg position","GSC reporting period"')
    expect(line[1]).toContain('"Gift Boxes","Gift Boxes","https://succulentsbox.com/collections/plant-gift-boxes","[succulent gift box]"')
    expect(line[1]).toContain('"Observed GSC query",""')
    expect(line[1]).toContain('"Site-wide","120","3000","4.00","8.0","2026-04-24 to 2026-10-21"')
    expect(filterRows(rows, { source: 'ai_expansion' }).every(r => r.source === 'ai_expansion' && r.evidence === null)).toBe(true)
    expect(filterRows(rows, { groupId: ids[0], matchType: 'phrase' }).every(r => r.keyword.startsWith('"'))).toBe(true)
  })

  it('editing an observed query drops its metrics but keeps it traceable', async () => {
    const { ids } = await categoryFlow(['Gift Boxes'], apiDataset(SITE_ROWS))
    const g = group(ids[0])
    const k = g.keywords.find(x => x.source === 'gsc_observed')
    const edited = editKeyword(g, k.id, 'plant gift box delivered').keywords.find(x => x.id === k.id)
    expect(edited).toMatchObject({ source: 'manual', evidence: [], editedFrom: k.base, seedRefs: [] })
  })
})

describe('persistence', () => {
  it('projects save seeds with evidence and reopen identically', async () => {
    const db = mockSupabase()
    setClient(db)
    const g = createPageGroup(productPage)
    store.setProject(p => ({ ...p, name: 'Calico ads', adGroups: [g] }))
    const ds = apiDataset(SITE_ROWS)
    await findSeeds({ groupId: g.id, ...ctx(), dataset: ds, fetchPageRows: async () => [row('calico kitten', 1, 40)] })
    await runKeywordGeneration({ groupIds: [g.id], ...ctx(), api: mockApi({ keywordsFor: () => ['buy calico kitten crassula'] }), dataset: ds })
    const id = await saveProject(store.getProject())
    const saved = db.tables.keyword_projects[0]
    expect(saved.save_status).toBe('complete')
    expect(saved.data.adGroups[0].seeds.find(s => s.query === 'calico kitten').evidence[0]).toMatchObject({ scope: 'page', impressions: 40 })
    const mirror = db.tables.ad_keywords
    expect(mirror.find(r => r.base_keyword === 'calico kitten' && r.match_type === 'broad')).toMatchObject({ source: 'gsc_observed', gsc_scope: 'page', gsc_impressions: 40, seed_queries: null })
    expect(mirror.find(r => r.base_keyword === 'buy calico kitten crassula' && r.match_type === 'broad')).toMatchObject({ source: 'ai_expansion', gsc_scope: null, gsc_clicks: null })

    const reopened = deserializeProject(saved)
    expect(serializeProject(reopened)).toEqual(serializeProject(store.getProject()))
    expect(reopened.adGroups[0].seedStatus.pageLevel).toMatchObject({ status: 'ok' })
    await saveProject({ ...reopened, id })
    expect(db.tables.ad_keywords.length).toBe(mirror.length)
  })

  it('a partial project save is marked failed; a partial analysis save is rolled back', async () => {
    let db = mockSupabase({ failInsertOn: 'ad_keywords', failAfterInserts: 1 })
    setClient(db)
    await categoryFlow(['Gift Boxes'], apiDataset(SITE_ROWS))
    await expect(saveProject(store.getProject())).rejects.toThrow(/did not finish saving/)
    expect(db.tables.keyword_projects[0].save_status).toBe('failed')

    db = mockSupabase({ failInsertOn: 'search_queries', failAfterInserts: 1 })
    setClient(db)
    await expect(saveAnalysis({ queries: processQueries(SITE_ROWS), source: 'csv_upload' })).rejects.toThrow()
    expect(db.tables.gsc_uploads).toHaveLength(0)
  })

  it('existing history (old rows and version-1 projects) stays readable', () => {
    const legacy = { keyword: '"succulent gift box"', match_type: 'phrase', category: 'Gift Boxes', source: 'suggested', headline_1: 'A', headline_2: 'B', headline_3: null }
    expect(normalizeKeywordRow(legacy)).toMatchObject({ base: 'succulent gift box', source: 'ai_expansion', headlines: ['A', 'B'], evidence: null })
    const v1 = deserializeProject({ id: 'x', name: 'Old', mode: 'category', data: { gscRef: { source: 'csv_upload' }, adGroups: [{ id: 'g', name: 'Succulents', mode: 'category', category: 'Succulents', landingUrl: 'https://succulentsbox.com/collections/succulents', keywords: [
      { base: 'succulents for sale', source: 'from_gsc', gsc: { clicks: 5, impressions: 50, ctr: 10, position: 3 } },
      { base: 'succulents online', source: 'ai_suggested' },
    ] }] } })
    const [obs, ai] = v1.adGroups[0].keywords
    expect(obs).toMatchObject({ source: 'gsc_observed' })
    expect(primaryEvidence(obs)).toMatchObject({ clicks: 5, scope: 'site-wide' })
    expect(ai).toMatchObject({ source: 'ai_expansion', evidence: [] })
    expect(v1.adGroups[0].seeds).toEqual([])
  })

  it('category payload carries no page context', () => {
    store.setProject(p => ensureCategoryGroups(p, ['Succulents']))
    expect(groupPayload(store.getProject().adGroups[0]).context).toEqual({})
  })
})
