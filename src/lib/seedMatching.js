// GSC seed matching — finds real Search Console queries relevant to a target
// (category, collection page or product page) and explains why each one matched.
//
// No minimum clicks/impressions: zero-click queries with impressions qualify.
// Relevance comes from the target's own terms (names, aliases, product type, selected products,
// description), not from the five category labels, so queries can match across categories.

import {
  INDIVIDUAL_PLANT_TERMS, NONEXISTENT_PRODUCT_TERMS, isInformational, normalizeKeyword, CATEGORY_DESCRIPTIONS,
} from '../shared/keywordRules.js'
import { CATEGORY_KEYWORDS, BRAND_TERMS } from './categorize.js'

// Words that never make a query relevant on their own
const STOPWORDS = new Set(`a an the for of to in on at by with and or & my your you yours our her him his she he me i it its
this that these those is are be from as up out off near best cheap buy sale sales shop shopping online order store price
prices free shipping ship delivery delivered deliver new live real fresh set pack size small large mini big inch inches in.
cm oz lb x one two three four five six 1 2 3 4 5 6 7 8 9 10 12 pcs piece pieces each per get top good great cute rare unique
how what why when where which who`.split(/\s+/))

// Words that describe the product family — weak evidence (need two, or one in broad mode)
const CONTEXT_WORDS = new Set(`succulent plant houseplant cactu cacti gift box pot planter indoor outdoor arrangement kit terrarium
air tillandsia potted garden greenery green leaf leaves bundle collection assortment variety subscription monthly club care
package basket present hanging trailing tropical tree flower flowering bloom`.split(/\s+/))

// Simple stemmer so "succulents"/"succulent", "boxes"/"box" match
export function stem(word) {
  const w = word.toLowerCase()
  if (w === 'cacti' || w === 'cactus' || w === 'cactuses') return 'cactu'
  if (w.length > 4 && /(xes|ches|shes|sses)$/.test(w)) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1)
  return w
}

export function tokens(text) {
  return normalizeKeyword(text).split(' ').filter(Boolean).map(stem)
}
const stemPhrase = text => tokens(text).join(' ')
const meaningful = toks => toks.filter(t => t.length > 1 && !STOPWORDS.has(t))

// Strip SEO suffixes like "Title | Live Plants & Gifts"
const cleanTitle = t => String(t || '').split('|')[0].split(' - ')[0].trim()

// ── Target profiles ──

function addPhrase(profile, text, label) {
  const all = tokens(text)
  let p = meaningful(all).join(' ')
  // Never let a phrase collapse into one generic word ("succulent delivery" must not become "succulent")
  if (!p || (!p.includes(' ') && CONTEXT_WORDS.has(p))) p = all.length > 1 ? all.join(' ') : ''
  if (p && !profile.phrases.some(x => x.text === p)) profile.phrases.push({ text: p, label })
}
function addTerms(profile, text, label, { coreAllowed = true } = {}) {
  for (const t of meaningful(tokens(text))) {
    if (CONTEXT_WORDS.has(t) || !coreAllowed) { if (!profile.context.has(t)) profile.context.set(t, label) }
    else if (!profile.core.has(t)) profile.core.set(t, label)
  }
}

// target = { mode, category, page, selectedProductHandles, aliases }
export function buildProfile(target, level = 'strict') {
  const profile = { phrases: [], core: new Map(), context: new Map() }
  const aliases = (target.aliases || []).filter(Boolean)

  if (target.mode === 'category') {
    const cat = target.category
    for (const kw of CATEGORY_KEYWORDS[cat] || []) {
      // Multi-word category terms are phrases; single words are core terms for the category
      if (kw.includes(' ')) addPhrase(profile, kw, `${cat} term`)
      else addTerms(profile, kw, `${cat} term`)
    }
    addTerms(profile, cat, 'category name')
    // Description words are generic — only used with broader matching
    if (level === 'broad') addTerms(profile, CATEGORY_DESCRIPTIONS[cat] || '', 'category description', { coreAllowed: false })
    // In category mode, generic family words ("succulent", "gift") ARE the core signal
    for (const kw of CATEGORY_KEYWORDS[cat] || []) {
      if (!kw.includes(' ')) { const t = stem(kw); if (profile.context.has(t)) { profile.core.set(t, `${cat} term`); profile.context.delete(t) } }
    }
  }

  if (target.mode === 'product' && target.page) {
    const p = target.page
    const title = cleanTitle(p.title)
    addPhrase(profile, title, 'product name')
    addPhrase(profile, (p.handle || '').replace(/-/g, ' '), 'product URL')
    for (const plant of INDIVIDUAL_PLANT_TERMS) if (normalizeKeyword(p.title).includes(plant)) addPhrase(profile, plant, 'plant in product name')
    addTerms(profile, title, 'product name')
    addTerms(profile, p.productType, 'product type', { coreAllowed: false })
    for (const tag of (p.tags || []).slice(0, 15)) if (!/^[a-z]+-[\d.]+$/i.test(tag)) addTerms(profile, tag, 'product tag', { coreAllowed: false })
    for (const o of p.options || []) for (const v of o.values || []) addTerms(profile, v, `option ${o.name}`, { coreAllowed: false })
  }

  if (target.mode === 'collection' && target.page) {
    const p = target.page
    const title = cleanTitle(p.title)
    addPhrase(profile, title, 'collection name')
    addPhrase(profile, (p.handle || '').replace(/-/g, ' '), 'collection URL')
    addTerms(profile, title, 'collection name')
    addTerms(profile, (p.handle || '').replace(/-/g, ' '), 'collection URL')
    const sel = new Set(target.selectedProductHandles || [])
    for (const prod of (p.products || []).filter(x => !sel.size || sel.has(x.handle))) {
      const name = cleanTitle(prod.title)
      addPhrase(profile, name, `selected product "${name}"`)
      addTerms(profile, name, `selected product "${name}"`)
      addTerms(profile, prod.productType, 'product type', { coreAllowed: false })
    }
    // Description adds weak context only — it is too broad to be strong evidence
    addTerms(profile, p.description, 'collection description', { coreAllowed: false })
  }

  for (const a of aliases) { addPhrase(profile, a, `alias "${a}"`); addTerms(profile, a, `alias "${a}"`) }
  return profile
}

// level: 'strict' (default) or 'broad'
export function matchQuery(query, profile, level = 'strict') {
  const qTokens = meaningful(tokens(query))
  const qStr = ` ${tokens(query).join(' ')} `
  const reasons = []
  let score = 0

  // Longest matching phrases first; skip phrases contained in an already-matched one
  const phraseHits = profile.phrases
    .filter(p => p.text.includes(' ') || p.text.length > 3)
    .filter(p => qStr.includes(` ${p.text} `))
    .sort((a, b) => b.text.length - a.text.length)
  const usedPhrases = []
  for (const p of phraseHits) {
    if (usedPhrases.some(u => u.includes(p.text))) continue
    usedPhrases.push(p.text)
    reasons.push(`contains "${p.text}" (${p.label})`)
    score += 50
  }
  const phraseTokens = new Set(usedPhrases.join(' ').split(' '))

  const coreHits = qTokens.filter(t => profile.core.has(t) && !phraseTokens.has(t))
  for (const t of [...new Set(coreHits)]) { reasons.push(`matches "${t}" (${profile.core.get(t)})`); score += 20 }

  const ctxHits = [...new Set(qTokens.filter(t => profile.context.has(t) && !phraseTokens.has(t) && !coreHits.includes(t)))]
  const ctxNeeded = level === 'broad' ? 1 : 2
  const relevant = usedPhrases.length > 0 || coreHits.length > 0 || ctxHits.length >= ctxNeeded
  if (ctxHits.length) {
    reasons.push(`related term${ctxHits.length > 1 ? 's' : ''} ${ctxHits.map(t => `"${t}"`).join(', ')} (${profile.context.get(ctxHits[0])})`)
    score += 5 * ctxHits.length
  }
  return { relevant, score, reasons }
}

// Flags decide the default selection; flagged queries stay visible for review
export function seedFlags(query, mode, contextText = '') {
  const q = normalizeKeyword(query)
  const flags = []
  // "x care" is a care query, but "plant care pack/kit" is a product
  const careQuery = /\bcare\b(?!\s*(pack|packs|kit|kits|package|set|bundle|box|gift))/.test(q)
  if (isInformational(q) || careQuery) flags.push('informational')
  if (BRAND_TERMS.some(t => q.includes(t))) flags.push('branded')
  if (NONEXISTENT_PRODUCT_TERMS.some(t => q.includes(t))) flags.push('not sold')
  const plants = INDIVIDUAL_PLANT_TERMS.filter(t => q.includes(t))
  if (plants.length) {
    if (mode === 'category') flags.push('individual plant')
    else {
      const ctx = normalizeKeyword(contextText)
      if (plants.some(pl => !ctx.includes(pl) && !(pl === 'string of' && plants.some(o => o !== pl && ctx.includes(o))))) flags.push('other plant')
    }
  }
  return flags
}

export const FLAG_LABELS = {
  informational: 'Care / informational',
  branded: 'Branded',
  'not sold': 'Product we don\'t sell',
  'individual plant': 'Individual plant name',
  'other plant': 'Plant not in this target',
}

let seq = 0
const sid = () => `seed_${Date.now().toString(36)}${(seq++).toString(36)}`

export function evidenceFrom(row, scope, dataset) {
  return {
    scope, // 'page' | 'site-wide'
    source: dataset?.source || null, // 'gsc_api' | 'csv_upload'
    periodStart: dataset?.dateStart || null,
    periodEnd: dataset?.dateEnd || null,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    ctr: Number(row.ctr) || 0,
    position: Number(row.position) || 0,
  }
}

export function makeSeed({ query, evidence, reasons, score = 0, origin = 'matched', mode, contextText }) {
  const flags = seedFlags(query, mode, contextText)
  return {
    id: sid(),
    query,
    base: normalizeKeyword(query),
    evidence,
    reasons,
    flags,
    score,
    origin, // 'matched' | 'manual'
    selected: flags.length === 0,
  }
}

// Primary evidence: page-level if present, otherwise site-wide
export const primaryEvidence = seed => seed.evidence.find(e => e.scope === 'page') || seed.evidence[0] || null

// Text the server uses to judge plant names etc. for a target
export function targetContextText(target) {
  const p = target.page || {}
  const sel = new Set(target.selectedProductHandles || [])
  return [
    p.title, p.productType, p.description, ...(p.tags || []), ...(target.aliases || []),
    ...((p.products || []).filter(x => !sel.size || sel.has(x.handle)).map(x => x.title)),
  ].join(' ')
}

// Match the site-wide dataset to a target. No click/impression minimum.
export function findSiteWideSeeds(queries, target, dataset, { level = 'strict', limit = 150 } = {}) {
  const profile = buildProfile(target, level)
  const ctx = targetContextText(target)
  const csv = dataset?.source === 'csv_upload'
  const scope = csv
    ? 'matched by query text in the imported CSV — not data for this specific page'
    : 'matched by query text in site-wide GSC data — not page-specific'
  const out = []
  for (const row of queries || []) {
    if (!normalizeKeyword(row.query)) continue
    const m = matchQuery(row.query, profile, level)
    if (!m.relevant) continue
    out.push(makeSeed({ query: row.query, evidence: [evidenceFrom(row, 'site-wide', dataset)], reasons: [...m.reasons, scope], score: m.score, mode: target.mode, contextText: ctx }))
  }
  return mergeSeedLists(out).slice(0, limit)
}

// Page-level rows (from a GSC page filter) — searched queries that showed this exact URL
export function pageSeeds(rows, target, dataset) {
  const ctx = targetContextText(target)
  return (rows || []).map(row => makeSeed({
    query: row.query,
    evidence: [evidenceFrom(row, 'page', dataset)],
    reasons: [`Search Console shows this query led to impressions of ${target.page?.url || 'this page'}`],
    score: 1000,
    mode: target.mode,
    contextText: ctx,
  }))
}

// Combine page-level and site-wide seeds into one seed per normalized query.
// Metrics are NEVER summed: each scope keeps its own evidence row. If two spellings normalize to
// the same query within one scope, the row with more impressions is kept and the other is noted.
export function mergeSeedLists(...lists) {
  const byBase = new Map()
  for (const list of lists) {
    for (const s of list) {
      const prev = byBase.get(s.base)
      if (!prev) { byBase.set(s.base, { ...s, evidence: s.evidence.map(e => ({ ...e })), reasons: [...s.reasons] }); continue }
      for (const e of s.evidence) {
        const i = prev.evidence.findIndex(x => x.scope === e.scope)
        if (i === -1) { prev.evidence.push({ ...e }); continue }
        const keep = prev.evidence[i]
        if (s.query === prev.query) continue // same query from another list: identical evidence
        const [winner, loser, loserQuery] = e.impressions > keep.impressions ? [e, keep, prev.query] : [keep, e, s.query]
        prev.evidence[i] = { ...winner }
        if (winner === e) prev.query = s.query
        const note = `variant "${loserQuery}" also in GSC (${loser.impressions} impr., ${loser.scope}) — metrics not combined`
        if (!prev.reasons.includes(note)) prev.reasons.push(note)
      }
      for (const r of s.reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r)
      prev.score = Math.max(prev.score, s.score)
    }
  }
  return [...byBase.values()].sort((a, b) => b.score - a.score || primaryEvidence(b).impressions - primaryEvidence(a).impressions)
}

// Search the dataset for manual seed selection
export function searchDataset(queries, text, limit = 20) {
  const q = normalizeKeyword(text)
  if (q.length < 2) return []
  return (queries || []).filter(r => normalizeKeyword(r.query).includes(q))
    .sort((a, b) => b.impressions - a.impressions).slice(0, limit)
}
