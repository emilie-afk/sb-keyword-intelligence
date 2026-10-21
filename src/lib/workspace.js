// Ad Keywords workspace — pure state logic (no React), so it can be unit-tested.
//
// GSC is the foundation: every ad group first collects real Search Console queries ("seeds")
// with their evidence, the user reviews them, and only then are keywords generated:
//   - selected seeds become "Observed GSC query" keywords, carrying their own metrics
//   - the AI adds "AI expansion" keywords, each referencing the seed(s) it came from, with NO metrics
//
// project = { id, name, mode, selectedCategories, adGroups: [AdGroup], gscRef }
// AdGroup = { id, name, mode, category, landingUrl, pageUrl, page, selectedProductHandles, aliases,
//             seeds: [Seed], seedStatus, keywords: [Keyword], status }
// Seed    = see seedMatching.js (query, base, evidence[], reasons[], flags[], selected, origin)
// Keyword = { id, base, source, match, headlines, headlineStatus, headlineIssues, evidence[], seedRefs[] }

import {
  exceedsAdsKeywordLimits, CATEGORIES, CATEGORY_LANDING_PAGES, MATCH_TYPES, formatMatchType, normalizeKeyword, normalizeSource, SOURCES,
} from '../shared/keywordRules.js'
import { categorizeQuery } from './categorize.js'
import { mapLimit } from './api.js'
import {
  findSiteWideSeeds, pageSeeds, mergeSeedLists, makeSeed, evidenceFrom, primaryEvidence, targetContextText, makeDerivedSeed,
  withRelevance,
} from './seedMatching.js'
import { relevanceTarget, assessKeyword, summarizeExclusions } from '../shared/relevance.js'

let counter = 0
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function newProject(overrides = {}) {
  return {
    id: null,
    name: 'Untitled keyword project',
    mode: 'category',
    selectedCategories: [],
    adGroups: [],
    gscRef: null,
    ...overrides,
  }
}

// Compact content identity; metrics and query changes invalidate evidence even at equal row counts.
// Cached per rows array: hashing 100k rows takes ~65 ms and this is called many times per render.
const contentKeyCache = new WeakMap()
function contentKey(rows) {
  if (contentKeyCache.has(rows)) return contentKeyCache.get(rows)
  const key = computeContentKey(rows)
  contentKeyCache.set(rows, key)
  return key
}
function computeContentKey(rows) {
  const text = JSON.stringify(rows.map(q => [q.query, q.clicks, q.impressions, q.ctr, q.position]))
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ text.charCodeAt(i)
  }
  return `${a >>> 0}:${b >>> 0}:${text.length}`
}

// Reference to the GSC dataset a project's evidence came from
export function datasetRef(dataset) {
  if (!dataset) return null
  return {
    uploadId: dataset.uploadId || null,
    source: dataset.source || null,
    dateStart: dataset.dateStart || null,
    dateEnd: dataset.dateEnd || null,
    rowsCount: dataset.queries?.length || 0,
    contentKey: contentKey(dataset.queries || []),
    incomplete: !!dataset.incomplete,
  }
}

const defaultMatch = () => ({ broad: true, phrase: true, exact: true })

export function newKeyword(base, source, extra = {}) {
  return {
    id: uid('kw'),
    base,
    source,
    match: defaultMatch(),
    headlines: [],
    headlineStatus: 'none', // none | valid | invalid
    headlineIssues: [],
    evidence: [], // GSC evidence — only ever set for observed queries
    seedRefs: [], // for AI expansions: the observed seed queries that support them
    editedFrom: null, // for edited observed queries: the original observed query (metrics not kept)
    derivedFrom: null, // for derived themes: the long GSC query the theme was extracted from (metrics not kept)
    ...extra,
  }
}

const emptySeedStatus = () => ({ state: 'none', level: 'strict', pageLevel: null, siteWideCount: 0, error: null })

function baseGroup(fields) {
  return {
    id: uid('ag'),
    pageUrl: null,
    page: null,
    selectedProductHandles: [],
    aliases: [],
    seeds: [],
    seedStatus: emptySeedStatus(),
    keywords: [],
    status: { keywords: 'idle', error: null },
    ...fields,
  }
}

export function createCategoryGroup(category) {
  return baseGroup({ name: category, mode: 'category', category, landingUrl: CATEGORY_LANDING_PAGES[category] || '' })
}

// Best-effort category for a collection/product page (editable in the UI)
export function guessCategory(page) {
  const cat = categorizeQuery(`${page.title || ''} ${page.productType || ''}`)
  return CATEGORIES.includes(cat) ? cat : 'Other'
}

// Minimal page snapshot stored with the project (keeps saved projects small)
export function pageSnapshot(page, selectedHandles = null) {
  if (!page) return null
  const base = {
    type: page.type, url: page.url, handle: page.handle, title: page.title,
    description: page.description, image: page.image, fetchedAt: page.fetchedAt,
  }
  if (page.type === 'collection') {
    const sel = selectedHandles ? new Set(selectedHandles) : null
    return {
      ...base,
      productsCount: page.productsCount,
      truncated: !!page.truncated,
      products: (page.products || []).filter(p => !sel || sel.has(p.handle)),
    }
  }
  return {
    ...base,
    details: page.details, productType: page.productType, tags: page.tags || [], priceMin: page.priceMin,
    priceMax: page.priceMax, available: page.available, options: page.options, variants: page.variants,
  }
}

export function createPageGroup(page, { name, category, selectedProductHandles, aliases } = {}) {
  const handles = page.type === 'collection'
    ? (selectedProductHandles ?? (page.products || []).map(p => p.handle))
    : []
  return baseGroup({
    name: (name || page.title || '').split('|')[0].trim() || page.handle,
    mode: page.type,
    category: category || guessCategory(page),
    landingUrl: page.url,
    pageUrl: page.url,
    page: pageSnapshot(page, handles),
    selectedProductHandles: handles,
    aliases: aliases || [],
  })
}

// Ensure one ad group per selected category; existing groups (and their seeds/keywords) are kept
export function ensureCategoryGroups(project, categories) {
  const existing = new Set(project.adGroups.filter(g => g.mode === 'category').map(g => g.category))
  const added = categories.filter(c => !existing.has(c)).map(createCategoryGroup)
  return added.length ? { ...project, adGroups: [...project.adGroups, ...added] } : project
}

export function categoryGroupIds(project, categories) {
  return project.adGroups.filter(g => g.mode === 'category' && categories.includes(g.category)).map(g => g.id)
}

export function updateGroup(project, groupId, fn) {
  return { ...project, adGroups: project.adGroups.map(g => (g.id === groupId ? fn(g) : g)) }
}

export function removeGroup(project, groupId) {
  return { ...project, adGroups: project.adGroups.filter(g => g.id !== groupId) }
}

// Synchronous store: setProject applies the updater immediately, so getProject() is always current.
export function createStore(initial, onChange) {
  let state = initial
  return {
    getProject: () => state,
    setProject: (fn) => {
      state = typeof fn === 'function' ? fn(state) : fn
      onChange?.(state)
      return state
    },
  }
}

const targetOf = g => ({ mode: g.mode, category: g.category, page: g.page, selectedProductHandles: g.selectedProductHandles, aliases: g.aliases })

// What the evidence was matched against. If any of this changes, the evidence is outdated.
export function targetSignature(g) {
  return JSON.stringify([
    g.mode, g.category, g.pageUrl || null,
    [...(g.selectedProductHandles || [])].sort(),
    [...(g.aliases || [])].map(a => a.toLowerCase().trim()).sort(),
  ])
}
export const datasetKey = ref => (ref ? [ref.source, ref.dateStart, ref.dateEnd, ref.rowsCount, ref.contentKey].join('|') : '')

// Why the group's evidence can't be used for generation right now (null = usable)
export function evidenceProblem(group, dataset) {
  const st = group.seedStatus || {}
  if (!dataset?.queries) return 'Load a GSC dataset to generate keywords.'
  if (st.state === 'loading') return 'GSC evidence is still loading.'
  if (st.state === 'error') return st.error || 'GSC evidence could not be loaded completely.'
  if (st.dataset && datasetKey(st.dataset) !== datasetKey(datasetRef(dataset))) return 'The GSC dataset or reporting period changed — re-run matching to refresh the evidence.'
  if (st.state !== 'done') return 'Find GSC evidence first.'
  if (datasetKey(st.dataset) !== datasetKey(datasetRef(dataset))) return 'The GSC dataset or reporting period changed — re-run matching to refresh the evidence.'
  if (st.target && st.target !== targetSignature(group)) return 'The target (URL, products or aliases) changed — re-run matching to refresh the evidence.'
  if (selectedSeeds(group).length === 0) return 'No selected GSC seed queries — find or select relevant queries first.'
  if (usableSeeds(group).length === 0) {
    return selectedSeeds(group).some(x => exceedsAdsKeywordLimits(x.base))
      ? 'The selected queries are too long to use as keywords — extract a short theme from them first.'
      : 'None of the selected queries is clearly relevant to this target — select relevant queries or adjust the target.'
  }
  return null
}

// ── Seeds (GSC evidence) ──

// Find seeds for one ad group:
//   1. page-level queries for the collection/product URL, for the dataset's reporting period
//      (Search Console datasets only)
//   2. relevant site-wide queries from the loaded dataset (always)
// The user's select/exclude choices are kept; manual seeds get fresh evidence from the current dataset.
// Each run gets a request id: if the target or dataset changes, or another run starts, a late
// response is discarded instead of overwriting newer evidence.
export async function findSeeds({ groupId, getProject, setProject, dataset, level, fetchPageRows = null }) {
  if (!dataset?.queries) throw new Error('Load a GSC dataset (Search Console or CSV) first.')
  const group = getProject().adGroups.find(g => g.id === groupId)
  if (!group) return null
  const requestId = uid('ev')
  const signature = targetSignature(group)
  const useLevel = level || group.seedStatus?.level || 'strict'
  setProject(p => updateGroup(p, groupId, g => ({ ...g, seedStatus: { ...g.seedStatus, state: 'loading', dataset: datasetRef(dataset), level: useLevel, error: null, requestId } })))

  const target = targetOf(group)
  let pageLevel = null
  let pageList = []
  if (group.mode !== 'category') {
    if (dataset.source !== 'gsc_api') {
      pageLevel = { status: 'unavailable', message: 'Query-only CSV — page-level data is not available. Matches below are by query text, not searches for this exact page.' }
    } else if (!fetchPageRows) {
      pageLevel = { status: 'unavailable', message: 'Search Console is not connected in this session — reconnect to load page-level queries for this URL.' }
    } else {
      try {
        const res = await fetchPageRows(group.page, { dateStart: dataset.dateStart, dateEnd: dataset.dateEnd })
        const rows = Array.isArray(res) ? res : res.rows
        pageList = pageSeeds(rows, target, dataset)
        pageLevel = {
          status: rows.length ? 'ok' : 'none',
          count: pageList.length,
          incomplete: !!res.incomplete,
          periodStart: dataset.dateStart,
          periodEnd: dataset.dateEnd,
          message: rows.length ? null : 'No page-level queries for this URL in this period.',
        }
      } catch (err) {
        pageLevel = { status: 'error', code: err.code || 'api', message: `Page-level data could not be loaded: ${err.message}` }
      }
    }
  }

  const relTarget = groupRelevanceTarget(group)
  const siteList = findSiteWideSeeds(dataset.queries, target, dataset, { level: useLevel, relTarget })
  const current = getProject().adGroups.find(g => g.id === groupId)
  // Late response? Discard it.
  if (!current || current.seedStatus?.requestId !== requestId || targetSignature(current) !== signature) {
    return { discarded: true }
  }

  // Manual seeds: re-read their evidence from THIS dataset; drop them if the query isn't in it
  const byBase = new Map()
  for (const r of dataset.queries) {
    const b = normalizeKeyword(r.query)
    const prev = byBase.get(b)
    if (!prev || r.impressions > prev.impressions) byBase.set(b, r)
  }
  const ctxText = targetContextText(target)
  const manualOld = (current.seeds || []).filter(s => s.origin === 'manual')
  const manual = manualOld.filter(s => byBase.has(s.base)).map(s => ({
    ...makeSeed({ query: byBase.get(s.base).query, evidence: [evidenceFrom(byBase.get(s.base), 'site-wide', dataset)], reasons: ['added manually from the GSC dataset'], origin: 'manual', mode: group.mode, contextText: ctxText }),
    id: s.id, selected: s.selected,
  }))
  const droppedManual = manualOld.length - manual.length
  // Derived themes stay only while the long query they came from is still in this dataset
  const derived = (current.seeds || []).filter(s => s.origin === 'derived' && byBase.has(normalizeKeyword(s.derivedFrom)))

  const previous = new Map((current.seeds || []).map(s => [s.base, s]))
  const merged = [...mergeSeedLists(pageList, siteList, manual).filter(s => !derived.some(d => d.base === s.base)), ...derived].map(s => {
    const prev = previous.get(s.base)
    if (s.origin === 'derived') return withRelevance(s, relTarget)
    const seed = prev ? { ...s, id: prev.id, origin: prev.origin === 'manual' ? 'manual' : s.origin } : s
    return withRelevance(seed, relTarget, { previous: prev && prev.relevance ? prev : null })
  })
  // Relevant first; uncertain/excluded stay listed (collapsed in the UI) for transparency
  const rank = s => (s.relevance?.verdict === 'relevant' ? 0 : s.relevance?.verdict === 'uncertain' ? 1 : 2)
  merged.sort((a, b) => rank(a) - rank(b))
  const excluded = summarizeExclusions(merged.filter(s => s.relevance?.verdict !== 'relevant').map(s => ({ text: s.query, reason: s.relevance?.reason })))

  const failed = pageLevel?.status === 'error'
  setProject(p => updateGroup(p, groupId, g => ({
    ...g,
    seeds: merged,
    seedStatus: {
      state: failed ? 'error' : 'done',
      error: failed ? `${pageLevel.message} Site-wide matches are shown, but the evidence is incomplete — fix the problem and retry.` : null,
      level: useLevel, pageLevel, siteWideCount: siteList.length, droppedManual, excluded,
      dataset: datasetRef(dataset), datasetIncomplete: !!dataset.incomplete, target: signature, requestId,
    },
  })))
  return merged
}

export function setSeedSelection(project, groupId, seedIds, selected) {
  const ids = new Set(seedIds)
  return updateGroup(project, groupId, g => ({ ...g, seeds: g.seeds.map(s => (ids.has(s.id) ? { ...s, selected } : s)) }))
}

// Add a dataset query as a manual seed (site-wide evidence; the user decided it is relevant)
export function addManualSeed(project, groupId, row, dataset) {
  return updateGroup(project, groupId, g => {
    const base = normalizeKeyword(row.query)
    if (g.seeds.some(s => s.base === base)) {
      return { ...g, seeds: g.seeds.map(s => (s.base === base ? { ...s, selected: true } : s)) }
    }
    const seed = makeSeed({
      query: row.query,
      evidence: [evidenceFrom(row, 'site-wide', dataset)],
      reasons: ['added manually from the GSC dataset'],
      origin: 'manual',
      mode: g.mode,
      contextText: targetContextText(targetOf(g)),
    })
    return { ...g, seeds: [withRelevance({ ...seed, selected: true }, groupRelevanceTarget(g)), ...g.seeds] }
  })
}

export const selectedSeeds = g => (g.seeds || []).filter(s => s.selected)
// Seeds that can actually be used: queries over the Google Ads keyword limit can't (extract a theme instead)
export const usableSeeds = g => selectedSeeds(g).filter(s => !exceedsAdsKeywordLimits(s.base) && seedIsRelevant(g, s))
// A seed is usable only if it is clearly relevant to the group's target (re-checked, not trusted from storage)
export function seedIsRelevant(group, seed) {
  return assessKeyword(seed.query, groupRelevanceTarget(group)).verdict === 'relevant'
}

// Add a short theme extracted from a long query. The theme is labelled derived and carries no metrics;
// the original long query keeps its own evidence and is left unselected.
export function addDerivedSeed(project, groupId, sourceSeedId, themeText) {
  return updateGroup(project, groupId, g => {
    const source = g.seeds.find(s => s.id === sourceSeedId)
    const base = normalizeKeyword(themeText)
    if (!source || !base || exceedsAdsKeywordLimits(base)) return g
    if (g.seeds.some(s => s.base === base)) return { ...g, seeds: g.seeds.map(s => (s.base === base ? { ...s, selected: true } : s)) }
    const seed = withRelevance(makeDerivedSeed(source, base, g.mode, targetContextText(targetOf(g))), groupRelevanceTarget(g))
    return { ...g, seeds: [seed, ...g.seeds.map(s => (s.id === sourceSeedId ? { ...s, selected: false } : s))] }
  })
}

// ── Keywords ──

// Merge keywords into a group, deduplicating by normalized base. Existing keywords win, except
// that an observed GSC query replaces an AI expansion with the same text (it is real data).
export function mergeKeywords(group, items, source) {
  const byBase = new Map(group.keywords.map(k => [k.base, k]))
  let keywords = group.keywords
  let added = 0
  for (const item of items) {
    const base = normalizeKeyword(typeof item === 'string' ? item : item.base ?? item.keyword)
    if (!base) continue
    const existing = byBase.get(base)
    if (existing) {
      if (source === 'gsc_observed' && ['ai_expansion', 'gsc_observed', 'gsc_derived'].includes(existing.source)) {
        const upgraded = { ...existing, source, evidence: item.evidence || [], seedRefs: [], derivedFrom: null }
        keywords = keywords.map(k => (k.id === existing.id ? upgraded : k))
        byBase.set(base, upgraded)
      }
      continue
    }
    const kw = newKeyword(base, source, {
      evidence: source === 'gsc_observed' ? (item.evidence || []) : [], // AI expansions never carry metrics
      seedRefs: source === 'ai_expansion' ? (item.seedRefs || []) : [],
      derivedFrom: source === 'gsc_derived' ? (item.derivedFrom || null) : null, // derived themes never carry metrics
    })
    keywords = [...keywords, kw]
    byBase.set(base, kw)
    added++
  }
  return { group: keywords === group.keywords ? group : { ...group, keywords }, added }
}

export function editKeyword(group, keywordId, newText) {
  const base = normalizeKeyword(newText)
  if (!base) return group
  if (group.keywords.some(k => k.id !== keywordId && k.base === base)) return group // would duplicate
  return {
    ...group,
    keywords: group.keywords.map(k => (k.id === keywordId && k.base !== base
      // An edited phrase was not observed: it loses the metrics and becomes a manual keyword that
      // records which observed query it was edited from. Edited AI expansions keep their seed refs.
      ? {
        ...k, base,
        source: k.source === 'gsc_observed' ? 'manual' : k.source,
        evidence: [],
        editedFrom: k.source === 'gsc_observed' ? k.base : k.editedFrom || null,
        headlines: [], headlineStatus: 'none', headlineIssues: [],
      }
      : k)),
  }
}

export function removeKeywords(project, keywordIds) {
  const ids = new Set(keywordIds)
  return { ...project, adGroups: project.adGroups.map(g => ({ ...g, keywords: g.keywords.filter(k => !ids.has(k.id)) })) }
}

export function setMatchType(project, keywordIds, matchType, on) {
  const ids = new Set(keywordIds)
  return {
    ...project,
    adGroups: project.adGroups.map(g => ({
      ...g,
      keywords: g.keywords.map(k => {
        if (!ids.has(k.id)) return k
        const match = { ...k.match, [matchType]: on }
        return MATCH_TYPES.some(m => match[m]) ? { ...k, match } : k // keep at least one
      }),
    })),
  }
}

// Payload sent to the server for one ad group
export function groupPayload(group) {
  const page = group.page || {}
  return {
    mode: group.mode,
    name: group.name,
    category: group.category,
    landingUrl: group.landingUrl,
    context: group.mode === 'category' ? {} : {
      title: page.title, handle: page.handle, description: page.description, details: page.details, productType: page.productType,
      tags: page.tags, priceMin: page.priceMin, priceMax: page.priceMax, variants: page.variants, aliases: group.aliases,
      products: group.mode === 'collection'
        ? (page.products || []).filter(p => group.selectedProductHandles.includes(p.handle))
        : undefined,
    },
  }
}

export const groupRelevanceTarget = group => relevanceTarget(groupPayload(group))

// Seeds sent to the AI: the real queries plus their scope (metrics stay on the client)
export const seedPayload = seeds => seeds.slice(0, 40).map(s => ({ query: s.query, scope: s.origin === 'derived' ? 'derived' : primaryEvidence(s)?.scope || 'site-wide' }))

// Generate keywords for the given ad groups only. Other groups are never touched.
// Requires a GSC dataset and current, error-free evidence with at least one selected seed —
// there is no AI-only fallback. AI expansions must cite seeds that were selected AND sent;
// anything else is rejected. If the evidence changes while the AI is working, its answer is discarded.
export async function runKeywordGeneration({ groupIds, getProject, setProject, api, dataset, count = 12, concurrency = 3 }) {
  if (!dataset?.queries) throw new Error('Keyword generation needs a GSC dataset. Connect Search Console or import a GSC CSV.')
  const mark = (id, status) => setProject(p => updateGroup(p, id, g => ({ ...g, status: { ...g.status, ...status } })))

  return mapLimit(groupIds, concurrency, async (groupId) => {
    const start = getProject().adGroups.find(g => g.id === groupId)
    if (!start) return { groupId, added: 0 }
    const problem = evidenceProblem(start, dataset)
    if (problem) {
      mark(groupId, { keywords: 'error', error: problem })
      throw new Error(problem)
    }
    const evidenceVersion = start.seedStatus.requestId
    const signature = targetSignature(start)
    const seeds = usableSeeds(start)
    const tooLong = selectedSeeds(start).length - seeds.length
    const selection = JSON.stringify(seeds.map(s => s.id).sort())
    const isStale = () => {
      const now = getProject().adGroups.find(g => g.id === groupId)
      return !now || now.seedStatus?.requestId !== evidenceVersion || targetSignature(now) !== signature ||
        JSON.stringify(usableSeeds(now).map(s => s.id).sort()) !== selection
    }
    mark(groupId, { keywords: 'loading', error: null })

    // 1. Selected seeds become observed keywords, with their own evidence — but only after the server
    //    confirms each one is relevant to this target and has advertising intent (shared rules).
    // Queries over the length limit are excluded from both keywords and AI seed payloads.
    // Derived themes become "Derived from GSC query" keywords with no metrics.
    const payload = groupPayload(start)
    let validation
    try {
      validation = await api.validateKeywords({ adGroup: payload, keywords: seeds.map(x => x.base) })
    } catch (err) {
      mark(groupId, { keywords: 'error', error: `Could not validate keywords: ${err.message}. Nothing was added.` })
      throw err
    }
    // The target, its evidence or the seed selection may have changed while validation was pending —
    // never insert observed keywords validated against an older state
    if (isStale()) {
      if (getProject().adGroups.some(g => g.id === groupId)) mark(groupId, { keywords: 'error', error: 'The target or its evidence changed while validating — nothing was added. Generate again.' })
      return { groupId, added: 0, discarded: true }
    }
    const accepted = new Set(validation.accepted || [])
    const excludedItems = (validation.rejected || []).map(r => ({ text: r.keyword, reason: r.reason }))
    let observedAdded = 0
    const observedSkipped = tooLong
    setProject(p => updateGroup(p, groupId, g => {
      const ok = x => accepted.has(x.base)
      const r1 = mergeKeywords(g, seeds.filter(x => x.origin !== 'derived' && ok(x)).map(x => ({ base: x.base, evidence: x.evidence })), 'gsc_observed')
      const r = mergeKeywords(r1.group, seeds.filter(x => x.origin === 'derived' && ok(x)).map(x => ({ base: x.base, derivedFrom: x.derivedFrom })), 'gsc_derived')
      observedAdded = r.added + r1.added
      return r.group
    }))

    // 2. AI expansions grounded in the selected seeds that are sent
    const sent = seedPayload(seeds.filter(x => accepted.has(x.base)))
    if (sent.length === 0) {
      const excluded = summarizeExclusions(excludedItems)
      mark(groupId, { keywords: 'done', error: null, lastRun: { observedAdded, observedSkipped, aiAdded: 0, rejected: 0, excluded } })
      return { groupId, added: observedAdded }
    }
    const sentBases = new Set(sent.map(x => normalizeKeyword(x.query)))
    const group = getProject().adGroups.find(g => g.id === groupId)
    try {
      const res = await api.generateKeywords({ adGroup: groupPayload(group), seeds: sent, avoid: group.keywords.map(k => k.base), count })

      if (isStale()) {
        if (getProject().adGroups.some(g => g.id === groupId)) mark(groupId, { keywords: 'error', error: 'The target or its evidence changed while generating — AI results were discarded. Generate again.' })
        return { groupId, added: observedAdded, discarded: true }
      }

      let rejected = (res.rejected || []).length
      for (const r of res.rejected || []) if (r.reason && r.reason !== 'duplicate') excludedItems.push({ text: r.keyword, reason: r.reason })
      const relTarget = relevanceTarget(payload)
      const items = []
      for (const k of res.keywords || []) {
        const refs = [...new Set((k.seedRefs || []).map(normalizeKeyword))].filter(r => sentBases.has(r))
        if (refs.length === 0) { rejected++; continue } // invented or unselected reference
        // A valid seed reference alone doesn't make an expansion relevant — re-check it here too
        const check = assessKeyword(k.keyword, relTarget)
        if (check.verdict !== 'relevant') { rejected++; excludedItems.push({ text: normalizeKeyword(k.keyword), reason: check.reason }); continue }
        items.push({ base: k.keyword, seedRefs: refs })
      }
      let aiAdded = 0
      const excluded = summarizeExclusions(excludedItems)
      setProject(p => updateGroup(p, groupId, g => {
        const r = mergeKeywords(g, items, 'ai_expansion')
        aiAdded = r.added
        return { ...r.group, status: { keywords: 'done', error: null, lastRun: { observedAdded, observedSkipped, aiAdded, rejected, excluded } } }
      }))
      return { groupId, added: observedAdded + aiAdded }
    } catch (err) {
      mark(groupId, { keywords: 'error', error: `AI expansion failed: ${err.message}. Observed GSC queries were kept.`, lastRun: { observedAdded, aiAdded: 0 } })
      throw err
    }
  })
}

// Remove keywords that aren't relevant to their ad group's target (all match types go with the keyword)
// and deselect seeds that aren't relevant. Keywords typed in by hand are kept and counted.
// Returns { project, groups: [{ groupId, name, removed, keptManual, excluded }], totalRemoved }
export function cleanProject(project) {
  const groups = []
  let totalRemoved = 0
  const adGroups = project.adGroups.map(g => {
    const relTarget = groupRelevanceTarget(g)
    const removedItems = []
    let keptManual = 0
    const keywords = g.keywords.filter(k => {
      const r = assessKeyword(k.base, relTarget)
      if (r.verdict === 'relevant') return true
      if (k.source === 'manual') { keptManual++; return true }
      removedItems.push({ text: k.base, reason: r.reason })
      return false
    })
    const seeds = (g.seeds || []).map(x => withRelevance(x, relTarget, { previous: x }))
    totalRemoved += removedItems.length
    groups.push({ groupId: g.id, name: g.name, removed: removedItems.length, keptManual, excluded: summarizeExclusions(removedItems) })
    return removedItems.length || seeds.some((x, i) => x.selected !== g.seeds[i].selected) ? { ...g, keywords, seeds } : g
  })
  return { project: { ...project, adGroups }, groups, totalRemoved }
}

export const HEADLINE_BATCH_SIZE = 10

// Split keyword ids into per-group batches of ≤ 10
export function buildHeadlineBatches(project, keywordIds) {
  const ids = new Set(keywordIds)
  const batches = []
  for (const g of project.adGroups) {
    const kws = g.keywords.filter(k => ids.has(k.id))
    for (let i = 0; i < kws.length; i += HEADLINE_BATCH_SIZE) {
      batches.push({ id: uid('batch'), groupId: g.id, keywordIds: kws.slice(i, i + HEADLINE_BATCH_SIZE).map(k => k.id) })
    }
  }
  return batches
}

// Apply server results to the keywords of ONE batch. Never adds keywords.
// sentBases (id → base at request time): a keyword edited while the request ran is left untouched.
export function applyHeadlineResults(project, batch, results, sentBases = null) {
  const ids = new Set(batch.keywordIds)
  return updateGroup(project, batch.groupId, g => ({
    ...g,
    keywords: g.keywords.map(k => {
      if (!ids.has(k.id)) return k
      if (sentBases && sentBases[k.id] !== k.base) return k
      const r = results?.[k.base]
      if (!r) return { ...k, headlineStatus: 'invalid', headlineIssues: ['no headlines returned'] }
      if (!r.valid && k.headlineStatus === 'valid') return k // keep a previously valid set
      return { ...k, headlines: r.headlines || [], headlineStatus: r.valid ? 'valid' : 'invalid', headlineIssues: r.issues || [] }
    }),
  }))
}

// Run headline batches with bounded concurrency. Successful batches are applied immediately;
// failed batches are returned for retry. Keywords with invalid output get one automatic retry.
export async function runHeadlineBatches({ batches, getProject, setProject, api, concurrency = 4, onProgress, autoRetryInvalid = true }) {
  let done = 0
  const total = batches.length
  onProgress?.({ done, total, failed: 0 })
  const runOne = async (batch) => {
    const group = getProject().adGroups.find(g => g.id === batch.groupId)
    const kws = group ? group.keywords.filter(k => batch.keywordIds.includes(k.id)) : []
    if (!group || kws.length === 0) return batch
    const signature = targetSignature(group)
    const evidenceVersion = group.seedStatus?.requestId
    const sentBases = Object.fromEntries(kws.map(k => [k.id, k.base]))
    const res = await api.generateHeadlines({ adGroup: groupPayload(group), keywords: kws.map(k => k.base) })
    const current = getProject().adGroups.find(g => g.id === batch.groupId)
    // Target or evidence changed while waiting: discard, and report the batch as failed so it can be retried
    if (!current || targetSignature(current) !== signature || current.seedStatus?.requestId !== evidenceVersion) {
      throw new Error('The ad group changed while headlines were generating — results were discarded. Retry this batch.')
    }
    setProject(p => applyHeadlineResults(p, batch, res.results, sentBases))
    return batch
  }

  const outcomes = await mapLimit(batches, concurrency, async (batch) => {
    try {
      return await runOne(batch)
    } finally {
      done++
      onProgress?.({ done, total, failed: 0 })
    }
  })
  const failed = []
  batches.forEach((b, i) => { if (!outcomes[i].ok) failed.push({ ...b, error: outcomes[i].error?.message }) })

  if (autoRetryInvalid) {
    const succeededIds = new Set(batches.filter((_, i) => outcomes[i].ok).flatMap(b => b.keywordIds))
    const invalidIds = getProject().adGroups.flatMap(g => g.keywords).filter(k => succeededIds.has(k.id) && k.headlineStatus === 'invalid').map(k => k.id)
    if (invalidIds.length) await mapLimit(buildHeadlineBatches(getProject(), invalidIds), concurrency, runOne)
  }
  onProgress?.({ done: total, total, failed: failed.length })
  return { failed, succeeded: total - failed.length }
}

// ── Rows, filters and exports ──

export function projectRows(project) {
  const rows = []
  for (const g of project.adGroups) {
    for (const k of g.keywords) {
      for (const mt of MATCH_TYPES) {
        if (!k.match?.[mt]) continue
        rows.push({
          rowId: `${k.id}:${mt}`, keywordId: k.id, groupId: g.id,
          keyword: formatMatchType(k.base, mt), base: k.base, matchType: mt,
          category: g.category, adGroup: g.name, landingUrl: g.landingUrl,
          source: k.source, headlines: k.headlines || [], headlineStatus: k.headlineStatus,
          headlineIssues: k.headlineIssues || [],
          evidence: k.source === 'gsc_observed' ? primaryEvidence(k) : null,
          seedRefs: k.seedRefs || [],
          editedFrom: k.editedFrom || null,
          derivedFrom: k.derivedFrom || null,
        })
      }
    }
  }
  return rows
}

export function filterRows(rows, { groupId = 'All', source = 'All', matchType = 'All' } = {}) {
  return rows.filter(r =>
    (groupId === 'All' || r.groupId === groupId) &&
    (source === 'All' || r.source === source) &&
    (matchType === 'All' || r.matchType === matchType))
}

export const scopeLabel = e => (!e ? '' : e.scope === 'page' ? 'Page-level' : e.source === 'csv_upload' ? 'Site-wide (CSV)' : 'Site-wide')
const period = e => (e?.periodStart && e?.periodEnd ? `${e.periodStart} to ${e.periodEnd}` : e ? 'not stated (CSV)' : '')

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`

// Metrics only ever appear for observed GSC queries
export const EXPORT_COLUMNS = [
  ['Ad group', r => r.adGroup],
  ['Category', r => r.category],
  ['Landing page', r => r.landingUrl],
  ['Keyword', r => r.keyword],
  ['Base keyword', r => r.base],
  ['Match type', r => r.matchType],
  ['Source', r => SOURCES[r.source] || r.source],
  ['Supporting GSC seed queries', r => (r.source === 'ai_expansion' ? r.seedRefs.join(' | ') : '')],
  ['Edited from GSC query', r => r.editedFrom || ''],
  ['Derived from GSC query', r => r.derivedFrom || ''],
  ['Headline 1', r => r.headlines[0]],
  ['Headline 2', r => r.headlines[1]],
  ['Headline 3', r => r.headlines[2]],
  ['Headline check', r => (r.headlineStatus === 'valid' ? 'OK' : r.headlineStatus === 'invalid' ? `Needs review: ${r.headlineIssues.join('; ')}` : '')],
  ['GSC evidence scope', r => scopeLabel(r.evidence)],
  ['GSC clicks', r => (r.evidence ? r.evidence.clicks : '')],
  ['GSC impressions', r => (r.evidence ? r.evidence.impressions : '')],
  ['GSC CTR (%)', r => (r.evidence ? r.evidence.ctr.toFixed(2) : '')],
  ['GSC avg position', r => (r.evidence ? r.evidence.position.toFixed(1) : '')],
  ['GSC reporting period', r => period(r.evidence)],
]

export function rowsToCsv(rows) {
  const header = EXPORT_COLUMNS.map(([label]) => csvCell(label)).join(',')
  const lines = rows.map(r => EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(','))
  return [header, ...lines].join('\n')
}

// ── Persistence helpers ──

// Strip transient UI state before saving. Seeds (with evidence and selection) are saved.
export function serializeProject(project) {
  return {
    version: 2,
    name: project.name,
    mode: project.mode,
    selectedCategories: project.selectedCategories,
    gscRef: project.gscRef,
    adGroups: project.adGroups.map(g => ({
      id: g.id, name: g.name, mode: g.mode, category: g.category, landingUrl: g.landingUrl,
      pageUrl: g.pageUrl, page: g.page, selectedProductHandles: g.selectedProductHandles, aliases: g.aliases || [],
      seedLevel: g.seedStatus?.level || 'strict',
      seedDataset: g.seedStatus?.dataset || null,
      seedTarget: g.seedStatus?.target || null,
      seedState: g.seedStatus?.state === 'error' ? 'error' : g.seedStatus?.state === 'done' ? 'done' : 'none',
      seedError: g.seedStatus?.state === 'error' ? g.seedStatus.error : null,
      pageLevel: g.seedStatus?.pageLevel || null,
      seeds: (g.seeds || []).map(s => ({
        id: s.id, query: s.query, base: s.base, evidence: s.evidence, reasons: s.reasons, flags: s.flags,
        score: s.score, origin: s.origin, selected: s.selected, derivedFrom: s.derivedFrom || null, relevance: s.relevance || null,
      })),
      keywords: g.keywords.map(k => ({
        id: k.id, base: k.base, source: k.source, match: k.match, headlines: k.headlines,
        headlineStatus: k.headlineStatus, headlineIssues: k.headlineIssues, evidence: k.evidence, seedRefs: k.seedRefs,
        editedFrom: k.editedFrom || null,
        derivedFrom: k.derivedFrom || null,
      })),
    })),
  }
}

// Also reads version-1 projects (keywords with `gsc` metrics and old source names)
export function deserializeProject(row) {
  const data = row.data || {}
  return newProject({
    id: row.id,
    name: row.name || data.name || 'Untitled keyword project',
    mode: row.mode || data.mode || 'category',
    selectedCategories: data.selectedCategories || row.selected_categories || [],
    gscRef: data.gscRef || null,
    adGroups: (data.adGroups || []).map(g => ({
      ...baseGroup({}),
      ...g,
      selectedProductHandles: g.selectedProductHandles || [],
      aliases: g.aliases || [],
      // Seeds saved before relevance checks existed get a verdict now (and lose selection if off-target)
      seeds: (g.seeds || []).map(x => (x.relevance ? x : withRelevance({ ...x, flags: x.flags || [] }, groupRelevanceTarget({ ...g, selectedProductHandles: g.selectedProductHandles || [], aliases: g.aliases || [] }), { previous: x }))),
      seedStatus: {
        ...emptySeedStatus(),
        state: g.seedState || (g.seeds?.length ? 'done' : 'none'),
        error: g.seedError || null,
        level: g.seedLevel || 'strict',
        target: g.seedTarget || null,
        // Saved evidence gets a fresh version id so it can be used after reopening
        requestId: (g.seedState || g.seeds?.length) ? uid('ev') : null,
        pageLevel: g.pageLevel || null,
        siteWideCount: (g.seeds || []).filter(s => s.evidence?.some(e => e.scope === 'site-wide')).length,
        dataset: g.seedDataset || null,
      },
      status: { keywords: 'idle', error: null },
      keywords: (g.keywords || []).map(k => {
        const source = normalizeSource(k.source)
        const legacyEvidence = k.gsc ? [{ scope: 'site-wide', source: data.gscRef?.source || null, periodStart: data.gscRef?.dateStart || null, periodEnd: data.gscRef?.dateEnd || null, clicks: k.gsc.clicks, impressions: k.gsc.impressions, ctr: k.gsc.ctr, position: k.gsc.position }] : []
        return {
          ...newKeyword(k.base, source),
          ...k,
          source,
          evidence: source === 'gsc_observed' ? (k.evidence || legacyEvidence) : [],
          seedRefs: k.seedRefs || [],
        }
      }),
    })),
  })
}

// Stable fingerprint used to reset the "Saved" state when anything changes
export function projectFingerprint(project) {
  return JSON.stringify(serializeProject(project))
}
