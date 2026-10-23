// Target relevance + advertising intent across category, collection and product targets.
import { describe, it, expect, beforeEach } from 'vitest'
import { TEST_PROMPTS } from './helpers.js'
import { assessKeyword, validateKeywords, relevanceTarget } from '../src/shared/relevance.js'
import {
  createStore, newProject, ensureCategoryGroups, createPageGroup, findSeeds, runKeywordGeneration, projectRows,
  cleanProject, updateGroup, mergeKeywords, deserializeProject, serializeProject, selectedSeeds,
} from '../src/lib/workspace.js'
import { processQueries } from '../src/lib/categorize.js'
import { generateKeywords, handleRequest } from '../netlify/lib/adKeywords.js'
import { mockApi } from './helpers.js'

const cat = category => ({ mode: 'category', category })
const verdict = (q, t) => assessKeyword(q, t).verdict
const row = (query, clicks = 0, impressions = 10) => ({ query, clicks, impressions, ctr: 0, position: 9 })
const dataset = rows => ({ queries: processQueries(rows), source: 'gsc_api', dateStart: '2026-04-24', dateEnd: '2026-10-21' })

// From the screenshot: these were sitting in the Gift Boxes results
const SCREENSHOT_UNRELATED = [
  'well draining potting mix for succulents',
  'houseplants that do well in low light',
  'what plants grow well in leca',
  'plants that do well in office without windows',
]
const GIFT_QUERIES_THAT_STAY = [
  'customized succulent gift box online', 'succulent gift box', 'birthday plant gift', 'sympathy plant gift',
  'plant gifts for mom', 'gift baskets for grandparents', 'housewarming gift plant', 'corporate plant gifts',
  'thank you gift box', 'plant care package', 'sympathy plants',
]

describe('Gift Boxes — gifting relevance supported by plant gifts', () => {
  it('excludes the screenshot examples (soil, growing media, care and lighting questions)', () => {
    for (const q of SCREENSHOT_UNRELATED) expect(verdict(q, cat('Gift Boxes')), q).toBe('excluded')
    expect(assessKeyword('well draining potting mix for succulents', cat('Gift Boxes')).reason).toBe('supplies')
    expect(assessKeyword('what plants grow well in leca', cat('Gift Boxes')).reason).toBe('supplies')
    expect(assessKeyword('houseplants that do well in low light', cat('Gift Boxes')).reason).toBe('advice')
  })
  it('keeps real plant-gift queries', () => {
    for (const q of GIFT_QUERIES_THAT_STAY) expect(verdict(q, cat('Gift Boxes')), q).toBe('relevant')
  })
  it('excludes general plant shopping without gifting intent, non-plant gifts and occasion-only queries', () => {
    expect(assessKeyword('houseplants for sale', cat('Gift Boxes')).reason).toBe('no_gift_intent')
    expect(assessKeyword('succulents for sale', cat('Gift Boxes')).reason).toBe('no_gift_intent')
    expect(assessKeyword('birthday cake', cat('Gift Boxes')).reason).toBe('no_gift_intent')
    expect(assessKeyword('wine gift basket', cat('Gift Boxes')).reason).toBe('non_plant_gift')
    expect(assessKeyword('grow light for succulents', cat('Gift Boxes')).reason).toBe('supplies')
  })
  it('generic overlap ("plant", "box", "well") is never enough', () => {
    for (const q of ['storage box', 'plant box', 'well water plants', 'plants', 'best plants']) expect(verdict(q, cat('Gift Boxes')), q).not.toBe('relevant')
  })
  it('review-type research queries are held back, not auto-selected', () => {
    expect(assessKeyword('succulent sampler gift box reviews', cat('Gift Boxes'))).toMatchObject({ verdict: 'uncertain', reason: 'research' })
  })
})

describe('equivalent rules for the other categories (no cross-category contamination)', () => {
  it('Succulents', () => {
    for (const q of ['succulents for sale', 'buy succulents online', 'cactus', 'rare succulents']) expect(verdict(q, cat('Succulents')), q).toBe('relevant')
    expect(assessKeyword('air plants for sale', cat('Succulents'))).toMatchObject({ verdict: 'excluded', reason: 'other_category', detail: 'Air Plants' })
    expect(assessKeyword('pothos plant', cat('Succulents'))).toMatchObject({ verdict: 'excluded', reason: 'other_category', detail: 'Houseplants' })
    expect(assessKeyword('succulent gift box', cat('Succulents'))).toMatchObject({ verdict: 'uncertain', reason: 'other_category', detail: 'Gift Boxes' })
    expect(assessKeyword('succulent subscription box', cat('Succulents')).detail).toBe('Succulent Subscription')
    expect(assessKeyword('succulent soil', cat('Succulents')).reason).toBe('supplies')
    expect(assessKeyword('why is my succulent dying', cat('Succulents')).reason).toBe('advice')
  })
  it('Houseplants', () => {
    for (const q of ['houseplants for sale', 'low light houseplants', 'pothos for sale', 'indoor plants online']) expect(verdict(q, cat('Houseplants')), q).toBe('relevant')
    expect(assessKeyword('houseplants that do well in low light', cat('Houseplants')).reason).toBe('advice')
    expect(assessKeyword('succulents for sale', cat('Houseplants')).detail).toBe('Succulents')
    expect(verdict('plants for office', cat('Houseplants'))).not.toBe('relevant')
  })
  it('Air Plants', () => {
    for (const q of ['air plants for sale', 'tillandsia xerographica', 'air plant terrarium']) expect(verdict(q, cat('Air Plants')), q).toBe('relevant')
    expect(assessKeyword('succulents', cat('Air Plants')).reason).toBe('other_category')
    expect(assessKeyword('air plant care', cat('Air Plants')).reason).toBe('advice')
  })
  it('Succulent Subscription', () => {
    for (const q of ['succulent subscription box', 'monthly plant subscription', 'plant of the month club']) expect(verdict(q, cat('Succulent Subscription')), q).toBe('relevant')
    expect(verdict('subscription box', cat('Succulent Subscription'))).toBe('uncertain')
    expect(assessKeyword('cactus subscription', cat('Succulent Subscription')).reason).toBe('not_sold')
    expect(assessKeyword('succulents for sale', cat('Succulent Subscription')).reason).toBe('other_category')
  })
})

describe('collection and product keywords must describe the selected assortment or product', () => {
  const product = { mode: 'product', category: 'Succulents', text: 'Calico Kitten Crassula calico kitten crassula Succulent' }
  const giftProduct = { mode: 'product', category: 'Gift Boxes', text: 'Encouragement Gift Box for Her encouragement gift box' }
  const giftCollection = { mode: 'collection', category: 'Gift Boxes', text: 'Curated Plant Gift Boxes plant gift boxes Birthday Succulent Gift Box Sympathy Plant Gift' }
  it('product: its own name passes; category-level or other plants do not', () => {
    for (const q of ['calico kitten crassula', 'buy calico kitten plant', 'crassula for sale']) expect(verdict(q, product), q).toBe('relevant')
    expect(assessKeyword('succulents for sale', product).reason).toBe('not_specific')
    expect(assessKeyword('pothos', product).reason).toBe('other_plant')
    expect(assessKeyword('calico kitten care', product).reason).toBe('advice')
  })
  it('gift product: a shared name needs gift or plant context', () => {
    expect(verdict('encouragement gift box', giftProduct)).toBe('relevant')
    expect(verdict('encouragement quotes', giftProduct)).toBe('uncertain')
    expect(verdict('succulent gift box', giftProduct)).toBe('uncertain') // not this product
  })
  it('gift collection: screenshot queries excluded, gift queries kept', () => {
    for (const q of SCREENSHOT_UNRELATED) expect(verdict(q, giftCollection), q).toBe('excluded')
    for (const q of ['customized succulent gift box online', 'birthday plant gift', 'plant gifts for mom']) expect(verdict(q, giftCollection), q).toBe('relevant')
    expect(verdict('succulents for sale', giftCollection)).toBe('excluded')
    expect(verdict('birthday cake', giftCollection)).not.toBe('relevant')
  })
  it('supplies are fine when the target IS a supplies collection', () => {
    const soil = { mode: 'collection', category: 'Other', text: 'Succulent Potting Soil Mix succulent potting soil mix Gritty Mix Soil' }
    expect(verdict('succulent potting soil mix', soil)).toBe('relevant')
  })
})

// ── Pipeline: seeds, generation, server, clean ──
let store
beforeEach(() => { store = createStore(newProject()) })
const ctx = () => ({ getProject: store.getProject, setProject: store.setProject })
const g0 = () => store.getProject().adGroups[0]

const GIFT_DATASET = dataset([
  ...SCREENSHOT_UNRELATED.map(q => row(q, 3, 400)),
  row('customized succulent gift box online', 2, 90), row('succulent gift box', 120, 3000), row('birthday plant gift', 0, 40),
  row('succulent sampler gift box reviews', 1, 30), row('houseplants for sale', 50, 900), row('plant box', 4, 80),
])

describe('pipeline', () => {
  it('auto-selects only relevant seeds and summarises the rest', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET })
    const selected = selectedSeeds(g0()).map(s => s.query).sort()
    expect(selected).toEqual(['birthday plant gift', 'customized succulent gift box online', 'succulent gift box'])
    for (const q of SCREENSHOT_UNRELATED) {
      const s = g0().seeds.find(x => x.query === q)
      if (s) expect(s.selected, q).toBe(false)
    }
    const ex = g0().seedStatus.excluded
    expect(ex.supplies?.count).toBeGreaterThanOrEqual(1)
    expect(ex.advice?.count).toBeGreaterThanOrEqual(1)
  })

  it('generation validates observed queries server-side and rejects off-target AI expansions even with a valid seed reference', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET })
    const api = mockApi({ keywordsFor: () => [
      { keyword: 'succulent gift box delivered', seedRefs: ['succulent gift box'] },
      { keyword: 'well draining potting mix', seedRefs: ['succulent gift box'] }, // valid ref, irrelevant
      { keyword: 'houseplants for sale online', seedRefs: ['succulent gift box'] }, // valid ref, no gift intent
    ] })
    await runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: GIFT_DATASET })
    expect(api.calls.validate).toHaveLength(1)
    const bases = g0().keywords.map(k => k.base).sort()
    expect(bases).toEqual(['birthday plant gift', 'customized succulent gift box online', 'succulent gift box', 'succulent gift box delivered'])
    expect(Object.keys(g0().status.lastRun.excluded).sort()).toEqual(['no_gift_intent', 'supplies'])
  })

  it('a rejected server validation keeps the observed query out (server is authoritative)', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET })
    const api = mockApi({
      validateFor: p => ({ accepted: p.keywords.filter(k => k !== 'birthday plant gift'), rejected: [{ keyword: 'birthday plant gift', reason: 'no_anchor' }] }),
      keywordsFor: () => [],
    })
    await runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: GIFT_DATASET })
    expect(g0().keywords.map(k => k.base)).not.toContain('birthday plant gift')
  })

  it('if validation fails, nothing is added', async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET })
    const api = mockApi({ validateFor: () => new Error('offline') })
    const [o] = await runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: GIFT_DATASET })
    expect(o.ok).toBe(false)
    expect(g0().keywords).toEqual([])
    expect(api.calls.keywords).toHaveLength(0)
  })

  it('server: validate action and generation enforce the same rules', async () => {
    const adGroup = { mode: 'category', name: 'Gift Boxes', category: 'Gift Boxes', landingUrl: 'x', context: {} }
    const v = await handleRequest({ action: 'validate', adGroup, keywords: [...SCREENSHOT_UNRELATED, 'succulent gift box'] }, { getModel: () => { throw new Error('no model for validate') }, getPrompts: () => { throw new Error('no prompts for validate') } })
    expect(v.accepted).toEqual(['succulent gift box'])
    expect(v.rejected).toHaveLength(4)

    let prompt = ''
    const model = async p => { prompt = p; return { expansions: [{ keyword: 'leca for plants', seeds: [1] }, { keyword: 'succulent gift set', seeds: [1] }] } }
    const res = await generateKeywords({ adGroup, seeds: [{ query: 'succulent gift box' }, { query: 'well draining potting mix for succulents' }] }, model, TEST_PROMPTS)
    expect(prompt).not.toContain('potting mix') // irrelevant seed dropped before the model sees it
    expect(prompt).toContain('gifting intent')
    expect(res.keywords.map(k => k.keyword)).toEqual(['succulent gift set'])
    await expect(generateKeywords({ adGroup, seeds: [{ query: 'what plants grow well in leca' }] }, model, TEST_PROMPTS)).rejects.toThrow(/None of the GSC seed queries is clearly relevant/)
  })

  it('collection/product targets: validation uses the selected products', () => {
    const payload = { mode: 'collection', category: 'Gift Boxes', context: { title: 'Plant Gift Boxes', handle: 'plant-gift-boxes', products: [{ title: 'Birthday Succulent Gift Box' }] } }
    expect(relevanceTarget(payload).text).toContain('Birthday Succulent Gift Box')
    expect(validateKeywords(['birthday succulent gift', 'potting mix', 'succulents for sale'], payload).accepted).toEqual(['birthday succulent gift'])
  })

  it('"Clean existing results" removes unrelated keywords with all match types, keeps manual ones, and summarises', () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes', 'Succulents']))
    const [gift, succ] = store.getProject().adGroups
    store.setProject(p => updateGroup(p, gift.id, g => mergeKeywords(g, ['succulent gift box', ...SCREENSHOT_UNRELATED], 'gsc_observed').group))
    store.setProject(p => updateGroup(p, gift.id, g => mergeKeywords(g, ['my own gift idea typo'], 'manual').group))
    store.setProject(p => updateGroup(p, succ.id, g => mergeKeywords(g, ['succulents for sale', 'air plants for sale', 'pothos plant'], 'ai_expansion').group))
    const before = projectRows(store.getProject()).length
    const r = cleanProject(store.getProject())
    store.setProject(r.project)
    expect(r.totalRemoved).toBe(6)
    expect(projectRows(store.getProject()).length).toBe(before - 6 * 3) // every match type removed
    const giftAfter = store.getProject().adGroups[0].keywords.map(k => k.base)
    expect(giftAfter).toEqual(['succulent gift box', 'my own gift idea typo'])
    expect(store.getProject().adGroups[1].keywords.map(k => k.base)).toEqual(['succulents for sale'])
    const giftSummary = r.groups.find(x => x.name === 'Gift Boxes')
    expect(giftSummary).toMatchObject({ removed: 4, keptManual: 1 })
    expect(Object.keys(giftSummary.excluded).sort()).toEqual(['advice', 'supplies'])
    expect(r.groups.find(x => x.name === 'Succulents').excluded.other_category.count).toBe(2)
  })

  it('older saved projects: off-target seeds selected before this fix are deselected on reopen', () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    const data = serializeProject(store.getProject())
    data.adGroups[0].seeds = [
      { id: 'a', query: 'what plants grow well in leca', base: 'what plants grow well in leca', evidence: [], reasons: [], flags: [], origin: 'matched', selected: true },
      { id: 'b', query: 'succulent gift box', base: 'succulent gift box', evidence: [], reasons: [], flags: [], origin: 'matched', selected: true },
    ]
    const reopened = deserializeProject({ id: 'x', name: 'old', mode: 'category', data })
    expect(reopened.adGroups[0].seeds.map(s => [s.query, s.selected])).toEqual([['what plants grow well in leca', false], ['succulent gift box', true]])
  })
})

// ── Second review: four gaps ──
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

describe('gap 1 · buying questions are buying intent, not advice', () => {
  it('where/how to buy questions pass; care questions are still advice', () => {
    expect(verdict('where to buy succulent gift boxes', cat('Gift Boxes'))).toBe('relevant')
    expect(verdict('where can i send a plant gift', cat('Gift Boxes'))).toBe('relevant')
    expect(verdict('where can i buy succulents', cat('Succulents'))).toBe('relevant')
    expect(verdict('where to buy air plants online', cat('Air Plants'))).toBe('relevant')
    expect(assessKeyword('how do i care for succulents', cat('Succulents')).reason).toBe('advice')
    expect(assessKeyword('where to buy succulents that grow well indoors', cat('Succulents')).reason).toBe('advice')
    expect(assessKeyword('why are my succulents turning yellow', cat('Succulents')).reason).toBe('advice')
    expect(assessKeyword('what succulents are pet safe', cat('Succulents')).reason).toBe('advice')
    for (const q of SCREENSHOT_UNRELATED) expect(verdict(q, cat('Gift Boxes')), q).toBe('excluded')
  })
})

describe('gap 2 · a qualified collection must match its qualifiers, not the whole category', () => {
  const petSafe = relevanceTarget({ mode: 'collection', category: 'Houseplants', context: {
    title: 'Pet Safe Houseplants', handle: 'pet-safe-houseplants',
    products: [{ title: 'Calathea Medallion', productType: 'Houseplant' }, { title: 'Peperomia Hope', productType: 'Houseplant' }],
  } })
  it('category-level queries are not relevant to Pet Safe Houseplants', () => {
    for (const q of ['buy houseplants online', 'houseplants for sale', 'indoor plants delivered']) {
      expect(assessKeyword(q, petSafe), q).toMatchObject({ verdict: 'uncertain', reason: 'not_specific' })
    }
  })
  it('pet-safe queries and the selected products are relevant', () => {
    for (const q of ['pet safe houseplants', 'buy pet safe plants online', 'calathea medallion for sale', 'buy peperomia']) {
      expect(verdict(q, petSafe), q).toBe('relevant')
    }
  })
  it('category-level collections still use their category theme', () => {
    const giftBoxes = relevanceTarget({ mode: 'collection', category: 'Gift Boxes', context: { title: 'Plant Gift Boxes', handle: 'plant-gift-boxes', products: [] } })
    expect(verdict('succulent gift box', giftBoxes)).toBe('relevant')
    const succ = relevanceTarget({ mode: 'collection', category: 'Succulents', context: { title: 'Succulents | Succulents Box', handle: 'succulents', products: [] } })
    expect(verdict('succulents for sale', succ)).toBe('relevant')
  })
})

describe('gap 3 · gifting intent never leaks into another category', () => {
  it('gift queries belong to Gift Boxes, without needing a gift container', () => {
    for (const [q, category] of [
      ['buy succulent gifts', 'Succulents'], ['birthday succulent', 'Succulents'], ['succulent gift for mom', 'Succulents'],
      ['houseplant gift', 'Houseplants'], ['housewarming houseplant', 'Houseplants'],
      ['air plant gifts', 'Air Plants'], ['air plant gift for her', 'Air Plants'],
    ]) expect(assessKeyword(q, cat(category)), `${q} @ ${category}`).toMatchObject({ verdict: 'uncertain', reason: 'other_category', detail: 'Gift Boxes' })
    expect(verdict('buy succulent gifts', cat('Gift Boxes'))).toBe('relevant')
    expect(verdict('birthday succulent', cat('Gift Boxes'))).toBe('relevant')
    expect(verdict('buy succulents', cat('Succulents'))).toBe('relevant')
  })
})

describe('gap 4 · a validation response is discarded if the target or selection changed meanwhile', () => {
  const setup = async () => {
    store.setProject(p => ensureCategoryGroups(p, ['Gift Boxes']))
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET })
    const slow = deferred()
    const api = mockApi({ validateFor: () => slow.promise, keywordsFor: () => [] })
    const run = runKeywordGeneration({ groupIds: [g0().id], ...ctx(), api, dataset: GIFT_DATASET })
    return { slow, api, run, answer: { accepted: selectedSeeds(g0()).map(s => s.base), rejected: [] } }
  }
  const expectNothingAdded = async ({ slow, api, run, answer }) => {
    slow.resolve(answer)
    const [o] = await run
    expect(o.value).toMatchObject({ discarded: true })
    expect(g0().keywords).toEqual([])
    expect(api.calls.keywords).toHaveLength(0)
    expect(g0().status.error).toMatch(/changed while validating/)
  }
  it('seed selection changed', async () => {
    const s = await setup()
    store.setProject(p => updateGroup(p, g0().id, g => ({ ...g, seeds: g.seeds.map(x => x.query === 'birthday plant gift' ? { ...x, selected: false } : x) })))
    await expectNothingAdded(s)
  })
  it('target changed (aliases)', async () => {
    const s = await setup()
    store.setProject(p => updateGroup(p, g0().id, g => ({ ...g, aliases: ['plant gift'] })))
    await expectNothingAdded(s)
  })
  it('evidence re-matched', async () => {
    const s = await setup()
    await findSeeds({ groupId: g0().id, ...ctx(), dataset: GIFT_DATASET, level: 'broad' })
    await expectNothingAdded(s)
  })
  it('unchanged: observed keywords are added as before', async () => {
    const { slow, run, answer } = await setup()
    slow.resolve(answer)
    await run
    expect(g0().keywords.map(k => k.base).sort()).toEqual(['birthday plant gift', 'customized succulent gift box online', 'succulent gift box'])
  })
})
