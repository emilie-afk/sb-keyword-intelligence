// Server-side loader for Succulents Box collection/product pages.
// Uses Shopify's public storefront JSON endpoints — no custom app or API token needed.
//   /collections/<h>.json            -> collection title/description (404 if missing)
//   /collections/<h>/products.json   -> products, 250 per page (?page=N)
//   /products/<h>.js                 -> product with variants, prices (cents), availability
// Every request (and every redirect hop) is restricted to approved Succulents Box hosts.

import { parseStoreUrl, isAllowedStoreHost, CANONICAL_ORIGIN } from '../../src/shared/keywordRules.js'

export class PageError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const REQUEST_TIMEOUT_MS = 8000
const TOTAL_BUDGET_MS = 18000 // stay well inside Netlify's synchronous function limit
const MAX_REDIRECTS = 3
const PAGE_SIZE = 250
const MAX_PAGES = 8
const MAX_DESCRIPTION = 2000

// Fetch JSON from an allowed host, following only same-site redirects
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJson(url, { fetchImpl, deadline }) {
  let current = url
  let rateLimitRetried = false
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedStoreHost(current)) {
      throw new PageError('external_redirect', 'The link redirects outside Succulents Box.', 400)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new PageError('timeout', 'Loading the page took too long. Please try again.', 504)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining))
    let res
    try {
      res = await fetchImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json' }, // note: a custom User-Agent gets 429'd by the store's Cloudflare rules
      })
    } catch (err) {
      if (err.name === 'AbortError') throw new PageError('timeout', 'Loading the page took too long. Please try again.', 504)
      throw new PageError('fetch_failed', 'Could not reach succulentsbox.com.', 502)
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new PageError('fetch_failed', 'The page redirected without a destination.', 502)
      current = new URL(location, current).toString()
      continue
    }
    if (res.status === 429) {
      // Shopify storefront rate limit — wait briefly once, then give a clear message
      const waitMs = Math.min(3000, (parseFloat(res.headers.get('retry-after')) || 1.5) * 1000)
      if (!rateLimitRetried && deadline - Date.now() > waitMs + 3000) {
        rateLimitRetried = true
        await sleep(waitMs)
        hop--
        continue
      }
      throw new PageError('rate_limited', 'succulentsbox.com is limiting requests right now. Wait a few seconds and try again.', 503)
    }
    if (res.status === 404) return { status: 404, data: null, finalUrl: current }
    if (!res.ok) throw new PageError('fetch_failed', `succulentsbox.com returned HTTP ${res.status}.`, 502)

    try {
      return { status: res.status, data: await res.json(), finalUrl: current }
    } catch {
      throw new PageError('fetch_failed', 'succulentsbox.com returned an unexpected (non-JSON) response.', 502)
    }
  }
  throw new PageError('fetch_failed', 'Too many redirects.', 502)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' }
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
    const key = e.toLowerCase()
    if (ENTITIES[key] !== undefined) return ENTITIES[key]
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10))
    return m
  })
}

export function htmlToText(html) {
  if (!html) return ''
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h\d|div)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, MAX_DESCRIPTION)
}

// <li> items usually hold "what's inside" / contents lists
export function extractListItems(html) {
  const items = []
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let m
  while ((m = re.exec(String(html || ''))) && items.length < 20) {
    const t = htmlToText(m[1]).replace(/\n/g, ' ').trim()
    if (t) items.push(t.slice(0, 200))
  }
  return items
}

function absImage(src, width) {
  if (!src) return null
  let s = src.startsWith('//') ? `https:${src}` : src
  if (width && s.includes('cdn.shopify.com')) s += `${s.includes('?') ? '&' : '?'}width=${width}`
  return s
}

const money = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)

function summarizeListProduct(p) {
  const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(Number.isFinite)
  return {
    handle: p.handle,
    title: p.title,
    url: `${CANONICAL_ORIGIN}/products/${p.handle}`,
    image: absImage(p.images?.[0]?.src, 120),
    productType: p.product_type || '',
    tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map(t => t.trim()).filter(Boolean).slice(0, 20),
    priceMin: prices.length ? money(Math.min(...prices)) : null,
    priceMax: prices.length ? money(Math.max(...prices)) : null,
    available: (p.variants || []).some(v => v.available !== false),
  }
}

async function loadCollection(parsed, ctx) {
  const meta = await fetchJson(`${CANONICAL_ORIGIN}/collections/${parsed.handle}.json`, ctx)
  if (meta.status === 404 || !meta.data?.collection) {
    throw new PageError('not_found', 'That collection does not exist or is not published.', 404)
  }
  const c = meta.data.collection

  const products = []
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (ctx.deadline - Date.now() < 2500) { truncated = true; break }
    if (page > 1) await sleep(ctx.pageDelayMs ?? 200) // be gentle with the storefront
    const res = await fetchJson(
      `${CANONICAL_ORIGIN}/collections/${parsed.handle}/products.json?limit=${PAGE_SIZE}&page=${page}`,
      ctx,
    )
    const batch = res.data?.products || []
    products.push(...batch.map(summarizeListProduct))
    if (batch.length < PAGE_SIZE) break
    if (page === MAX_PAGES) truncated = true
  }

  return {
    type: 'collection',
    url: parsed.url,
    handle: parsed.handle,
    title: c.title || parsed.handle,
    description: htmlToText(c.description || c.body_html || ''),
    image: absImage(c.image?.src, 400),
    productsCount: Number(c.products_count) || products.length,
    products,
    truncated,
    fetchedAt: new Date().toISOString(),
  }
}

async function loadProduct(parsed, ctx) {
  const res = await fetchJson(`${CANONICAL_ORIGIN}/products/${parsed.handle}.js`, ctx)
  if (res.status === 404 || !res.data?.title) {
    throw new PageError('not_found', 'That product does not exist or is not published.', 404)
  }
  const p = res.data
  // If Shopify redirected to a renamed product, use the final handle as the landing page
  const finalHandle = (new URL(res.finalUrl).pathname.match(/\/products\/([^/.]+)/) || [])[1] || p.handle || parsed.handle
  const cents = v => (Number.isFinite(v) ? money(v / 100) : null)
  return {
    type: 'product',
    url: `${CANONICAL_ORIGIN}/products/${finalHandle}`,
    handle: finalHandle,
    title: p.title,
    description: htmlToText(p.description),
    details: extractListItems(p.description),
    image: absImage(p.featured_image || p.images?.[0], 400),
    productType: p.type || '',
    tags: (Array.isArray(p.tags) ? p.tags : []).slice(0, 30),
    priceMin: cents(p.price_min),
    priceMax: cents(p.price_max),
    available: p.available !== false,
    options: (p.options || []).filter(o => o.name !== 'Title').map(o => ({ name: o.name, values: o.values })),
    variants: (p.variants || []).slice(0, 50).map(v => ({
      title: v.title === 'Default Title' ? 'Default' : v.title,
      price: cents(v.price),
      available: v.available !== false,
    })),
    fetchedAt: new Date().toISOString(),
  }
}

export async function fetchPageInfo(inputUrl, { fetchImpl = fetch, budgetMs = TOTAL_BUDGET_MS, pageDelayMs } = {}) {
  const parsed = parseStoreUrl(inputUrl)
  if (!parsed.ok) throw new PageError('invalid_url', parsed.error, 400)
  const ctx = { fetchImpl, deadline: Date.now() + budgetMs, pageDelayMs }
  return parsed.type === 'collection' ? loadCollection(parsed, ctx) : loadProduct(parsed, ctx)
}
