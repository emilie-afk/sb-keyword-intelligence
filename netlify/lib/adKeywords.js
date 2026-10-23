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
//
// The SB-specific prompt text (brand context, templates, category focus, mode rules) is private
// runtime configuration loaded by netlify/lib/prompts.js. This file only builds the generic parts
// (facts, numbered seeds, response format) and enforces the deterministic rules on every result.

import {
  CATEGORIES, CATEGORY_DESCRIPTIONS, HEADLINE_MAX,
  checkKeywordEligibility, normalizeKeyword, validateHeadlines,
} from '../../src/shared/keywordRules.js'
import { assessKeyword, relevanceTarget, validateKeywords } from '../../src/shared/relevance.js'
import { HttpError } from './auth.js'
import { renderTemplate } from './prompts.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const MODEL_TIMEOUT_MS = 22000
export const MAX_HEADLINE_BATCH = 10

export class RequestError extends HttpError {
  constructor(message, status = 400, code = 'bad_request') {
    super(status, code, message)
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
      if (err.name === 'AbortError') throw new RequestError('Claude took too long to respond — please retry', 504, 'model_timeout')
      throw new RequestError('Could not reach Claude — please retry', 502, 'model_unavailable')
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      // Never relay the provider's response body (it can contain account or request details)
      throw new RequestError(`Claude request failed (HTTP ${response.status}) — please retry`, 502, 'model_error')
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
    throw new RequestError('Claude returned an unreadable response — please retry', 502, 'model_error')
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

const seedLine = (s, i) => `${i + 1}. ${s.query}${s.scope === 'page' ? '  [searched for this page]' : s.scope === 'derived' ? '  [theme derived from a longer real query]' : ''}`
const avoidBlock = avoid => (avoid.length
  ? `Keywords already in this ad group (do not repeat or trivially reword them):\n${avoid.slice(0, 80).map(s => `- ${s}`).join('\n')}\n`
  : '')

// Response formats are fixed in code so a template edit can never break parsing
export const KEYWORD_RESPONSE_FORMAT = 'Respond with ONLY valid JSON: {"expansions":[{"keyword":"...","seeds":[1,2]}]}'
export const HEADLINE_RESPONSE_FORMAT = 'Respond ONLY with valid JSON: {"results":[{"keyword":"...","headlines":["H1","H2","H3"]}]}'

function requirePrompts(prompts) {
  if (!prompts?.keywordTemplate || !prompts?.headlineTemplate) {
    throw new HttpError(503, 'prompts_unavailable', 'Keyword generation is not configured yet: the prompt configuration is missing. Ask the owner to import it.')
  }
  return prompts
}

export function keywordPrompt(adGroup, seeds, avoid, count, prompts) {
  const p = requirePrompts(prompts)
  return `${renderTemplate(p.keywordTemplate, {
    brand_context: p.brandContext,
    ad_group_name: clip(adGroup.name, 80),
    mode: adGroup.mode,
    facts: buildFacts(adGroup),
    seeds: seeds.map(seedLine).join('\n'),
    avoid_block: avoidBlock(avoid),
    category_focus: p.categoryFocus?.[adGroup.category] || '',
    count,
    mode_rules: p.modeRules?.[adGroup.mode] || '',
  })}\n\n${KEYWORD_RESPONSE_FORMAT}`
}

export function headlinePrompt(adGroup, keywords, prompts) {
  const p = requirePrompts(prompts)
  return `${renderTemplate(p.headlineTemplate, {
    brand_context: p.brandContext,
    ad_group_name: clip(adGroup.name, 80),
    mode: adGroup.mode,
    facts: buildFacts(adGroup),
    headline_max: HEADLINE_MAX,
    keywords: keywords.map(k => `- ${k}`).join('\n'),
  })}\n\n${HEADLINE_RESPONSE_FORMAT}`
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

export async function generateKeywords({ adGroup, seeds = [], avoid = [], count = 12 }, callModel, prompts) {
  validateAdGroup(adGroup)
  const seedList = (Array.isArray(seeds) ? seeds : [])
    .map(s => (typeof s === 'string' ? { query: s, scope: 'site-wide' } : s))
    .map(s => ({ query: clip(s.query, 120), scope: ['page', 'derived'].includes(s.scope) ? s.scope : 'site-wide', base: normalizeKeyword(s.query) }))
    .filter(s => s.base)
    .slice(0, 40)
  if (seedList.length === 0) {
    throw new RequestError('At least one GSC seed query is required — keywords are generated from real Search Console queries.')
  }
  // Seeds must themselves be relevant to the target; irrelevant ones are dropped server-side
  const relTarget = relevanceTarget(adGroup)
  const relevantSeeds = seedList.filter(x => assessKeyword(x.query, relTarget).verdict === 'relevant')
  if (relevantSeeds.length === 0) {
    throw new RequestError('None of the GSC seed queries is clearly relevant to this target.')
  }
  seedList.splice(0, seedList.length, ...relevantSeeds)
  const n = Math.max(3, Math.min(25, Number(count) || 12))
  const avoidBases = (Array.isArray(avoid) ? avoid : []).slice(0, 2000).map(normalizeKeyword).filter(Boolean)
  const result = await callModel(keywordPrompt(adGroup, seedList, avoidBases, n, prompts), 1500)

  const raw = (Array.isArray(result?.expansions) ? result.expansions : []).slice(0, 60) // output limit
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
    // Relevance to THIS target and advertising intent — a valid seed reference alone is not enough
    const fit = assessKeyword(base, relTarget)
    if (fit.verdict !== 'relevant') { rejected.push({ keyword: base, reason: fit.reason, detail: fit.detail }); continue }
    let check = checkKeywordEligibility(base, adGroup.mode, ctxText)
    // Category mode: a plant name is fine when the cited real query contains it
    if (!check.ok && adGroup.mode === 'category' && check.reason?.startsWith('individual plant')) {
      check = checkKeywordEligibility(base, 'collection', refs.join(' '))
    }
    if (!check.ok) { rejected.push({ keyword: base, reason: check.reason }); continue }
    seen.add(base)
    keywords.push({ keyword: base, category: adGroup.category || adGroup.mode, seedRefs: refs })
  }
  // Rejected model output is reported briefly (enough to review, not a channel for long text)
  return { keywords, rejected: rejected.slice(0, 30).map(r => ({ ...r, keyword: r.keyword.split(' ').slice(0, 10).join(' ').slice(0, 80) })) }
}

export async function generateHeadlines({ adGroup, keywords = [] }, callModel, prompts) {
  validateAdGroup(adGroup)
  if (!Array.isArray(keywords) || keywords.length > 50) throw new RequestError(`Send at most ${MAX_HEADLINE_BATCH} keywords per request`)
  const bases = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))]
  if (bases.length === 0) return { results: {} }
  if (bases.length > MAX_HEADLINE_BATCH) throw new RequestError(`Send at most ${MAX_HEADLINE_BATCH} keywords per request`)

  const result = await callModel(headlinePrompt(adGroup, bases, prompts), 1500)
  const byBase = {}
  for (const item of (result?.results || [])) {
    const base = normalizeKeyword(item?.keyword)
    if (bases.includes(base) && !byBase[base]) byBase[base] = item.headlines
  }
  // Only the requested keywords are returned — the model can never add keywords here
  const results = {}
  for (const base of bases) {
    // Model text returned to the browser is bounded (limits how much of a prompt a crafted input could echo back)
    const headlines = Array.isArray(byBase[base]) ? byBase[base].slice(0, 3).map(h => (typeof h === 'string' ? h.trim().slice(0, HEADLINE_MAX * 2) : '')) : []
    const check = byBase[base] ? validateHeadlines(headlines) : { valid: false, issues: ['no headlines returned'] }
    results[base] = { headlines, valid: check.valid, issues: check.issues }
  }
  return { results }
}

// Validate candidate keywords (observed queries, derived themes) for a target — no model call
export function validateTargetKeywords({ adGroup, keywords = [] }) {
  if (!adGroup || !['category', 'collection', 'product'].includes(adGroup.mode)) throw new RequestError('adGroup.mode must be category, collection or product')
  if (!Array.isArray(keywords) || keywords.length > 200) throw new RequestError('Send 1–200 keywords to validate')
  return validateKeywords(keywords, adGroup)
}

// Which usage bucket a request counts against (also used to authorize it)
export const ACTIONS = { validate: 'validate', keywords: 'keywords', headlines: 'headlines' }

// getModel / getPrompts are only called for actions that need them (validate needs neither)
export async function handleRequest(body, { getModel, getPrompts } = {}) {
  if (body?.action === 'validate') return validateTargetKeywords(body)
  if (body?.action === 'keywords') return generateKeywords(body, await getModel(), await getPrompts())
  if (body?.action === 'headlines') return generateHeadlines(body, await getModel(), await getPrompts())
  throw new RequestError("Unknown action — expected 'validate', 'keywords' or 'headlines'")
}
