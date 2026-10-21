// Ad keyword + headline generation (server side).
// Each request makes ONE model call so it finishes well inside Netlify's function time limit.
//
//   { action: 'keywords',  adGroup, seeds: [{ query, scope }], avoid: [base], count }
//       -> { keywords: [{ keyword, category, seedRefs: [seed base] }], rejected: [{ keyword, reason }] }
//       Seeds are real GSC queries and are REQUIRED — there is no AI-only generation.
//   { action: 'headlines', adGroup, keywords: [base] }   (≤ 10 keywords)
//       -> { results: { [base]: { headlines: [h1,h2,h3], valid, issues } } }
//
// adGroup = { mode: 'category'|'collection'|'product', name, category, landingUrl, context }

import {
  BRAND_CONTEXT, CATEGORIES, CATEGORY_DESCRIPTIONS, HEADLINE_MAX,
  checkKeywordEligibility, normalizeKeyword, validateHeadlines,
} from '../../src/shared/keywordRules.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const MODEL_TIMEOUT_MS = 22000
export const MAX_HEADLINE_BATCH = 10

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

// Default model caller — returns parsed JSON from the model's text reply
export function anthropicCaller(apiKey, fetchImpl = fetch) {
  return async function callModel(prompt, maxTokens = 1500) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      })
    } catch (err) {
      if (err.name === 'AbortError') throw new RequestError('Claude took too long to respond — please retry', 504)
      throw new RequestError(`Could not reach Claude: ${err.message}`, 502)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new RequestError(err.error?.message || `Anthropic API error: ${response.status}`, 502)
    }
    const data = await response.json()
    return parseModelJson(data.content?.[0]?.text || '')
  }
}

export function parseModelJson(text) {
  const cleaned = String(text).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fall through */ }
    }
    throw new RequestError('Claude returned an unreadable response — please retry', 502)
  }
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const fmtPrice = (min, max) => (min == null ? '' : min === max || max == null ? `$${min}` : `$${min}–$${max}`)

// Plain-text facts the model may rely on. Nothing outside this block may be claimed.
export function buildFacts(adGroup) {
  const ctx = adGroup.context || {}
  if (adGroup.mode === 'category') {
    return `Category: ${adGroup.category}\nWhat it is: ${CATEGORY_DESCRIPTIONS[adGroup.category] || adGroup.category}\nLanding page: ${adGroup.landingUrl || ''}`
  }
  if (adGroup.mode === 'collection') {
    const products = (ctx.products || []).slice(0, 40)
      .map(p => `  - ${clip(p.title, 90)}${p.productType ? ` [${clip(p.productType, 30)}]` : ''}${fmtPrice(p.priceMin, p.priceMax) ? ` ${fmtPrice(p.priceMin, p.priceMax)}` : ''}`)
      .join('\n')
    return `Collection: ${clip(ctx.title, 150)}
Collection description (collection-wide facts): ${clip(ctx.description, 900) || '(none)'}
Selected products (details apply ONLY to that product, not the whole collection):
${products || '  (no products selected)'}
Landing page: ${adGroup.landingUrl || ''}`
  }
  // product
  const variants = (ctx.variants || []).slice(0, 15)
    .map(v => `  - ${clip(v.title, 60)}${v.price != null ? ` $${v.price}` : ''}${v.available === false ? ' (sold out)' : ''}`).join('\n')
  const details = (ctx.details || []).slice(0, 12).map(d => `  - ${clip(d, 150)}`).join('\n')
  return `Product: ${clip(ctx.title, 150)}
Type: ${clip(ctx.productType, 60) || '(not stated)'}
Also known as: ${(ctx.aliases || []).map(a => clip(a, 40)).join(', ') || '(none given)'}
Price: ${fmtPrice(ctx.priceMin, ctx.priceMax) || '(not stated)'}
Variants:
${variants || '  (single variant)'}
Listed details / contents:
${details || '  (none listed)'}
Description: ${clip(ctx.description, 1200) || '(none)'}
Landing page: ${adGroup.landingUrl || ''}`
}

// Text used to decide which plant names are "related" in collection/product modes
export function contextText(adGroup) {
  const ctx = adGroup.context || {}
  if (adGroup.mode === 'product') return [ctx.title, ctx.productType, ctx.description, ...(ctx.details || []), ...(ctx.tags || []), ...(ctx.aliases || []), ...(ctx.variants || []).map(v => v.title)].join(' ')
  if (adGroup.mode === 'collection') return [ctx.title, ctx.description, ...(ctx.aliases || []), ...(ctx.products || []).map(p => `${p.title} ${p.productType || ''}`)].join(' ')
  return ''
}

const MODE_RULES = {
  category: `- Category-level terms only. Do NOT use individual plant species/variety names unless the cited real query contains that plant.
- Stay inside this category; do not drift into other categories or products.`,
  collection: `- Keywords must be relevant to this collection and the selected products listed in FACTS.
- Plant or product names are allowed ONLY if they appear in FACTS.
- Do not target products that are not in FACTS.`,
  product: `- Keywords must target this specific product. Its product/plant name and close variations are allowed and encouraged.
- Include buying-intent variations (buy, for sale, online, delivered, gift) where natural.
- Do not target other products or plants that are not mentioned in FACTS.`,
}

function keywordPrompt(adGroup, seeds, avoid, count) {
  return `${BRAND_CONTEXT}

You are building ONE Google Ads ad group: "${clip(adGroup.name, 80)}" (${adGroup.mode} mode).

FACTS (the only information you may rely on for relevance and claims):
${buildFacts(adGroup)}

REAL SEARCH QUERIES from Google Search Console for this target (numbered). These are the starting point:
${seeds.map((s, i) => `${i + 1}. ${s.query}${s.scope === 'page' ? '  [searched for this page]' : ''}`).join('\n')}

${avoid.length ? `Keywords already in this ad group (do not repeat or trivially reword them):\n${avoid.slice(0, 80).map(s => `- ${s}`).join('\n')}\n` : ''}
Write up to ${count} keyword EXPANSIONS derived from the real queries above:
- refine wording, add buying-intent variations (buy, for sale, online, delivered, gift), or add closely related terms
- every expansion must cite the number(s) of the real query or queries it is derived from
- never repeat a real query as-is (those are already in the ad group)
Rules:
${MODE_RULES[adGroup.mode]}
- Stay relevant to the FACTS; do not introduce products or features that are not in FACTS.
- No care/how-to/informational queries.
- Only products Succulents Box actually sells (no cactus subscription box, no air plant subscription).
- Lowercase, no match-type punctuation, 2–7 words each.
- Do not include search volume, CPC or any metrics.

Respond with ONLY valid JSON: {"expansions":[{"keyword":"...","seeds":[1,2]}]}`
}

function headlinePrompt(adGroup, keywords) {
  return `You write Google Ads headlines for Succulents Box — warm, friendly tone, not salesy.
Ad group: "${clip(adGroup.name, 80)}" (${adGroup.mode} mode)

FACTS (the only information you may rely on):
${buildFacts(adGroup)}

For each keyword write exactly 3 headlines.
Rules:
- Max ${HEADLINE_MAX} characters each (count carefully), sentence case, no exclamation marks, distinct angles.
- Only state contents, quantities, variants, personalization, prices, shipping or discounts if they appear in FACTS.
- In collection mode, never apply one product's feature to the whole collection.
- Do not mention competitors or make unverifiable superlatives.

Keywords:
${keywords.map(k => `- ${k}`).join('\n')}

Respond ONLY with valid JSON: {"results":[{"keyword":"...","headlines":["H1","H2","H3"]}]}`
}

function validateAdGroup(adGroup) {
  if (!adGroup || !['category', 'collection', 'product'].includes(adGroup.mode)) {
    throw new RequestError('adGroup.mode must be category, collection or product')
  }
  if (adGroup.mode === 'category' && !CATEGORIES.includes(adGroup.category)) {
    throw new RequestError(`Unknown category: ${adGroup.category}`)
  }
  if (adGroup.mode !== 'category' && !adGroup.context?.title) {
    throw new RequestError('Load the page before generating keywords for it')
  }
}

export async function generateKeywords({ adGroup, seeds = [], avoid = [], count = 12 }, callModel) {
  validateAdGroup(adGroup)
  const seedList = (Array.isArray(seeds) ? seeds : [])
    .map(s => (typeof s === 'string' ? { query: s, scope: 'site-wide' } : s))
    .map(s => ({ query: clip(s.query, 120), scope: s.scope === 'page' ? 'page' : 'site-wide', base: normalizeKeyword(s.query) }))
    .filter(s => s.base)
    .slice(0, 40)
  if (seedList.length === 0) {
    throw new RequestError('At least one GSC seed query is required — keywords are generated from real Search Console queries.')
  }
  const n = Math.max(3, Math.min(25, Number(count) || 12))
  const avoidBases = avoid.map(normalizeKeyword).filter(Boolean)
  const result = await callModel(keywordPrompt(adGroup, seedList, avoidBases, n), 1500)

  const raw = Array.isArray(result?.expansions) ? result.expansions : []
  const seen = new Set([...seedList.map(s => s.base), ...avoidBases])
  const ctxText = contextText(adGroup)
  const keywords = []
  const rejected = []
  for (const item of raw) {
    const base = normalizeKeyword(typeof item === 'string' ? item : item?.keyword)
    if (!base) continue
    // Seed references: 1-based indexes (or seed text) that must point at provided seeds
    const refs = [...new Set((Array.isArray(item?.seeds) ? item.seeds : [])
      .map(r => (Number.isInteger(r) || /^\d+$/.test(String(r)) ? seedList[Number(r) - 1]?.base : normalizeKeyword(r)))
      .filter(b => b && seedList.some(s => s.base === b)))]
    if (refs.length === 0) { rejected.push({ keyword: base, reason: 'no valid seed reference' }); continue }
    if (seen.has(base)) { rejected.push({ keyword: base, reason: 'duplicate' }); continue }
    let check = checkKeywordEligibility(base, adGroup.mode, ctxText)
    // Category mode: a plant name is fine when the cited real query contains it
    if (!check.ok && adGroup.mode === 'category' && check.reason?.startsWith('individual plant')) {
      check = checkKeywordEligibility(base, 'collection', refs.join(' '))
    }
    if (!check.ok) { rejected.push({ keyword: base, reason: check.reason }); continue }
    seen.add(base)
    keywords.push({ keyword: base, category: adGroup.category || adGroup.mode, seedRefs: refs })
  }
  return { keywords, rejected }
}

export async function generateHeadlines({ adGroup, keywords = [] }, callModel) {
  validateAdGroup(adGroup)
  const bases = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))]
  if (bases.length === 0) return { results: {} }
  if (bases.length > MAX_HEADLINE_BATCH) throw new RequestError(`Send at most ${MAX_HEADLINE_BATCH} keywords per request`)

  const result = await callModel(headlinePrompt(adGroup, bases), 1500)
  const byBase = {}
  for (const item of (result?.results || [])) {
    const base = normalizeKeyword(item?.keyword)
    if (bases.includes(base) && !byBase[base]) byBase[base] = item.headlines
  }
  // Only the requested keywords are returned — the model can never add keywords here
  const results = {}
  for (const base of bases) {
    const headlines = Array.isArray(byBase[base]) ? byBase[base].map(h => (typeof h === 'string' ? h.trim() : '')) : []
    const check = byBase[base] ? validateHeadlines(headlines) : { valid: false, issues: ['no headlines returned'] }
    results[base] = { headlines, valid: check.valid, issues: check.issues }
  }
  return { results }
}

export async function handleRequest(body, callModel) {
  if (body?.action === 'keywords') return generateKeywords(body, callModel)
  if (body?.action === 'headlines') return generateHeadlines(body, callModel)
  throw new RequestError("Unknown action — expected 'keywords' or 'headlines'")
}
