import { describe, it, expect } from 'vitest'
import { parseStoreUrl, checkKeywordEligibility, validateHeadlines, normalizeKeyword, normalizeSource } from '../src/shared/keywordRules.js'
import { fetchPageInfo } from '../netlify/lib/shopifyPage.js'
import { generateKeywords, generateHeadlines, handleRequest, buildFacts } from '../netlify/lib/adKeywords.js'
import { handler as fetchPageHandler } from '../netlify/functions/fetch-page.js'
import { callFunction } from '../src/lib/api.js'
import { jsonResponse, redirectResponse } from './helpers.js'

describe('URL parsing and normalization', () => {
  it('normalizes collection and product URLs', () => {
    expect(parseStoreUrl('www.succulentsbox.com/collections/Plant-Gift-Boxes?sort=x#top')).toMatchObject({ ok: true, type: 'collection', url: 'https://succulentsbox.com/collections/plant-gift-boxes' })
    expect(parseStoreUrl('https://succulentsbox.com/collections/gift/products/encouragement-gift-box')).toMatchObject({ ok: true, type: 'product', url: 'https://succulentsbox.com/products/encouragement-gift-box' })
  })
  it('rejects invalid, external and non-catalog URLs', () => {
    expect(parseStoreUrl('').ok).toBe(false)
    expect(parseStoreUrl('not a url at all').ok).toBe(false)
    expect(parseStoreUrl('https://evil.com/collections/x').error).toMatch(/succulentsbox/)
    expect(parseStoreUrl('https://succulentsbox.com.evil.com/collections/x').ok).toBe(false)
    expect(parseStoreUrl('https://user:pw@succulentsbox.com/collections/x').ok).toBe(false)
    expect(parseStoreUrl('javascript:alert(1)').ok).toBe(false)
    expect(parseStoreUrl('https://succulentsbox.com/pages/about').ok).toBe(false)
  })
})

describe('mode-dependent keyword rules', () => {
  it('category mode excludes individual plant names', () => {
    expect(checkKeywordEligibility('buy succulents online', 'category').ok).toBe(true)
    expect(checkKeywordEligibility('calico kitten for sale', 'category').ok).toBe(false)
  })
  it('product mode allows the selected product plant name but not unrelated plants', () => {
    const ctx = 'Calico Kitten Crassula succulent 2 inch pot'
    expect(checkKeywordEligibility('calico kitten for sale', 'product', ctx).ok).toBe(true)
    expect(checkKeywordEligibility('pothos for sale', 'product', ctx).ok).toBe(false)
  })
  it('rejects informational queries and products we do not sell in every mode', () => {
    for (const mode of ['category', 'collection', 'product']) {
      expect(checkKeywordEligibility('how to care for succulents', mode, 'succulents').ok).toBe(false)
      expect(checkKeywordEligibility('cactus subscription box', mode, 'cactus').ok).toBe(false)
    }
  })
  it('validates headlines: exactly three, non-empty, ≤ 30 chars', () => {
    expect(validateHeadlines(['a', 'b', 'c']).valid).toBe(true)
    expect(validateHeadlines(['a', 'b']).valid).toBe(false)
    expect(validateHeadlines(['a', '', 'c']).valid).toBe(false)
    expect(validateHeadlines(['a', 'b', 'x'.repeat(31)]).issues[0]).toMatch(/31 chars/)
  })
  it('normalizes keywords and legacy sources', () => {
    expect(normalizeKeyword('  "Succulent  Gift Box" ')).toBe('succulent gift box')
    expect(normalizeKeyword('[buy succulents]')).toBe('buy succulents')
    expect(normalizeSource('suggested')).toBe('ai_expansion')
    expect(normalizeSource('ai_suggested')).toBe('ai_expansion')
    expect(normalizeSource('from_gsc')).toBe('gsc_observed')
  })
})

// Fake storefront for fetchPageInfo
function storefront(routes) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push(url)
    const u = new URL(url)
    const key = u.pathname + u.search
    const r = routes[key] ?? routes[u.pathname]
    if (typeof r === 'function') return r(opts)
    return r || jsonResponse({}, 404)
  }
  return { fetchImpl, calls }
}
const listProduct = (i) => ({ handle: `p${i}`, title: `Plant ${i}`, product_type: 'Succulent', images: [{ src: '//cdn.shopify.com/x.png' }], variants: [{ price: '10.00', available: true }] })

describe('fetchPageInfo (server-side page loader)', () => {
  it('loads a collection with pagination', async () => {
    const { fetchImpl, calls } = storefront({
      '/collections/big.json': jsonResponse({ collection: { title: 'Big', description: '<p>Lots &amp; lots</p>', products_count: 260 } }),
      '/collections/big/products.json?limit=250&page=1': jsonResponse({ products: Array.from({ length: 250 }, (_, i) => listProduct(i)) }),
      '/collections/big/products.json?limit=250&page=2': jsonResponse({ products: Array.from({ length: 10 }, (_, i) => listProduct(250 + i)) }),
    })
    const page = await fetchPageInfo('https://succulentsbox.com/collections/big', { fetchImpl, pageDelayMs: 0 })
    expect(page.type).toBe('collection')
    expect(page.description).toBe('Lots & lots')
    expect(page.products).toHaveLength(260)
    expect(page.products[0]).toMatchObject({ url: 'https://succulentsbox.com/products/p0', priceMin: 10 })
    expect(calls.filter(c => c.includes('products.json'))).toHaveLength(2)
  })
  it('handles empty collections without error', async () => {
    const { fetchImpl } = storefront({
      '/collections/empty.json': jsonResponse({ collection: { title: 'Empty', products_count: 0 } }),
      '/collections/empty/products.json': jsonResponse({ products: [] }),
    })
    const page = await fetchPageInfo('succulentsbox.com/collections/empty', { fetchImpl })
    expect(page.products).toEqual([])
  })
  it('treats a missing collection as not found (Shopify returns 200 [] for products.json)', async () => {
    const { fetchImpl } = storefront({ '/collections/nope/products.json': jsonResponse({ products: [] }) })
    await expect(fetchPageInfo('https://succulentsbox.com/collections/nope', { fetchImpl })).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
  it('loads a product with variants, prices and listed contents', async () => {
    const { fetchImpl } = storefront({
      '/products/box.js': jsonResponse({
        title: 'Birthday Box', handle: 'box', type: 'Gift Box', price_min: 2879, price_max: 3999, available: true,
        description: '<p>Includes:</p><ul><li>1 succulent</li><li>Candle</li></ul>', featured_image: '//cdn.shopify.com/a.png',
        options: [{ name: 'Size', values: ['S', 'L'] }],
        variants: [{ title: 'S', price: 2879, available: true }, { title: 'L', price: 3999, available: false }],
      }),
    })
    const page = await fetchPageInfo('https://succulentsbox.com/products/box', { fetchImpl })
    expect(page).toMatchObject({ type: 'product', priceMin: 28.79, priceMax: 39.99, details: ['1 succulent', 'Candle'] })
    expect(page.variants[1]).toEqual({ title: 'L', price: 39.99, available: false })
  })
  it('follows same-site redirects but blocks external redirects', async () => {
    const ok = storefront({
      '/products/old.js': redirectResponse('/products/new.js'),
      '/products/new.js': jsonResponse({ title: 'New', handle: 'new', variants: [] }),
    })
    const page = await fetchPageInfo('https://succulentsbox.com/products/old', { fetchImpl: ok.fetchImpl })
    expect(page.url).toBe('https://succulentsbox.com/products/new')

    const bad = storefront({ '/products/x.js': redirectResponse('https://evil.example/steal') })
    await expect(fetchPageInfo('https://succulentsbox.com/products/x', { fetchImpl: bad.fetchImpl })).rejects.toMatchObject({ code: 'external_redirect' })
    expect(bad.calls.some(c => c.includes('evil'))).toBe(false)
  })
  it('handles fetch failures, non-JSON responses and timeouts', async () => {
    const down = async () => { throw new TypeError('network down') }
    await expect(fetchPageInfo('https://succulentsbox.com/products/a', { fetchImpl: down })).rejects.toMatchObject({ code: 'fetch_failed' })

    const html = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad') } })
    await expect(fetchPageInfo('https://succulentsbox.com/products/a', { fetchImpl: html })).rejects.toMatchObject({ code: 'fetch_failed' })

    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await expect(fetchPageInfo('https://succulentsbox.com/products/a', { fetchImpl: hang, budgetMs: 50 })).rejects.toMatchObject({ code: 'timeout' })
  })
  it('function returns JSON errors (never HTML) for invalid URLs', async () => {
    const res = await fetchPageHandler({ httpMethod: 'POST', body: JSON.stringify({ url: 'https://evil.com/products/x' }) })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'invalid_url' })
  })
})

const categoryGroup = { mode: 'category', name: 'Succulents', category: 'Succulents', landingUrl: 'https://succulentsbox.com/collections/succulents', context: {} }
const productGroup = {
  mode: 'product', name: 'Calico Kitten', category: 'Succulents', landingUrl: 'https://succulentsbox.com/products/calico-kitten',
  context: { title: 'Calico Kitten Crassula', description: 'Variegated crassula in a 2" pot', variants: [{ title: '2 inch', price: 6.5 }] },
}

describe('ad-keywords server logic (model mocked)', () => {
  const seeds = [{ query: 'succulents for sale', scope: 'site-wide' }, { query: 'succulent gift box', scope: 'site-wide' }]

  it('requires GSC seeds — no AI-only generation', async () => {
    let called = false
    const model = async () => { called = true; return { expansions: [] } }
    await expect(generateKeywords({ adGroup: categoryGroup, seeds: [] }, model)).rejects.toThrow(/GSC seed query is required/)
    expect(called).toBe(false)
  })

  it('expansions must cite valid seeds; plant names, duplicates, off-target and informational queries are filtered', async () => {
    const model = async () => ({ expansions: [
      { keyword: 'buy succulents online', seeds: [1] },
      { keyword: 'succulent gift boxes delivered', seeds: ['succulent gift box'] }, // cites an off-target seed (dropped server-side)
      { keyword: 'succulent gift set online', seeds: [1] }, // gift intent → belongs to Gift Boxes
      { keyword: 'calico kitten for sale', seeds: [1] },
      { keyword: 'succulents for sale', seeds: [1] },
      { keyword: 'how to water succulents', seeds: [1] },
      { keyword: 'cheap succulents', seeds: [9] },
      { keyword: 'live succulent plants', seeds: [] },
    ] })
    const res = await generateKeywords({ adGroup: categoryGroup, seeds }, model)
    expect(res.keywords).toEqual([
      { keyword: 'buy succulents online', category: 'Succulents', seedRefs: ['succulents for sale'] },
    ])
    expect(res.rejected.map(r => r.reason)).toEqual(expect.arrayContaining(['duplicate', 'advice', 'no valid seed reference', 'other_category']))
  })

  it('category mode allows a plant name only when the cited real query contains it', async () => {
    const model = async () => ({ expansions: [{ keyword: 'buy echeveria online', seeds: [1] }, { keyword: 'pothos for sale', seeds: [1] }] })
    const res = await generateKeywords({ adGroup: categoryGroup, seeds: [{ query: 'echeveria for sale' }] }, model)
    expect(res.keywords.map(k => k.keyword)).toEqual(['buy echeveria online'])
  })

  it('allows the product name in product mode', async () => {
    const model = async () => ({ expansions: [{ keyword: 'buy calico kitten crassula', seeds: [1] }, { keyword: 'pothos plant', seeds: [1] }] })
    const res = await generateKeywords({ adGroup: productGroup, seeds: [{ query: 'calico kitten succulent', scope: 'page' }] }, model)
    expect(res.keywords.map(k => k.keyword)).toEqual(['buy calico kitten crassula'])
  })

  it('prompt contains the real queries (with page scope) and only the selected collection products', async () => {
    let prompt = ''
    const model = async (p) => { prompt = p; return { expansions: [] } }
    await generateKeywords({
      adGroup: { mode: 'collection', name: 'Gifts', category: 'Gift Boxes', landingUrl: 'x', context: { title: 'Gifts', products: [{ title: 'Birthday Box' }] } },
      seeds: [{ query: 'birthday plant gift', scope: 'page' }],
    }, model)
    expect(prompt).toContain('1. birthday plant gift  [searched for this page]')
    await generateKeywords({ adGroup: { mode: 'collection', name: 'Gifts', category: 'Gift Boxes', landingUrl: 'x', context: { title: 'Gifts', products: [{ title: 'Birthday Box' }] } }, seeds: [{ query: 'plant gifts for grandparents', scope: 'derived' }] }, model)
    expect(prompt).toContain('1. plant gifts for grandparents  [theme derived from a longer real query]')
    expect(prompt).toContain('Birthday Box')
    expect(prompt).not.toContain('Sympathy Box')
    expect(prompt).not.toMatch(/impressions|clicks/i)
  })

  it('headlines never add keywords and invalid output is flagged', async () => {
    const model = async () => ({ results: [
      { keyword: 'succulent gift box', headlines: ['Gifts that grow', 'Ships in a gift box', 'Send a living gift'] },
      { keyword: 'buy succulents online', headlines: ['This headline is far too long for ads', 'b', 'c'] },
      { keyword: 'extra keyword the model invented', headlines: ['a', 'b', 'c'] },
    ] })
    const { results } = await generateHeadlines({ adGroup: categoryGroup, keywords: ['succulent gift box', 'buy succulents online', 'succulent plants'] }, model)
    expect(Object.keys(results).sort()).toEqual(['buy succulents online', 'succulent gift box', 'succulent plants'])
    expect(results['succulent gift box'].valid).toBe(true)
    expect(results['buy succulents online'].valid).toBe(false)
    expect(results['succulent plants']).toMatchObject({ valid: false, issues: ['no headlines returned'] })
  })

  it('facts for collections separate collection-wide and product-level facts', () => {
    const facts = buildFacts({ mode: 'collection', landingUrl: 'x', context: { title: 'Gifts', description: 'Curated gifts', products: [{ title: 'Box A', priceMin: 20, priceMax: 20 }] } })
    expect(facts).toMatch(/collection-wide facts/)
    expect(facts).toMatch(/apply ONLY to that product/)
  })

  it('rejects unknown actions and oversized headline batches', async () => {
    await expect(handleRequest({ action: 'nope' }, async () => ({}))).rejects.toThrow(/Unknown action/)
    await expect(generateHeadlines({ adGroup: categoryGroup, keywords: Array.from({ length: 11 }, (_, i) => `kw ${i}`) }, async () => ({}))).rejects.toThrow(/at most 10/)
  })
})

describe('client callFunction', () => {
  it('turns an HTML 504 page into a readable error', async () => {
    const fetchImpl = async () => ({ status: 504, ok: false, text: async () => '<HTML><HEAD>Gateway Timeout' })
    await expect(callFunction('ad-keywords', {}, fetchImpl)).rejects.toThrow('The server timed out (504). Please try again.')
  })
})
