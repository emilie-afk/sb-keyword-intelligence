// Shared keyword rules — used by the UI, the client logic and the Netlify functions,
// so category definitions and eligibility rules stay consistent everywhere.
// Keep this file free of browser-only or Node-only APIs.

export const CATEGORIES = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

export const CATEGORY_COLORS = {
  Succulents: '#2a78d6',
  Houseplants: '#e87ba4',
  'Succulent Subscription': '#008300',
  'Gift Boxes': '#eda100',
  'Air Plants': '#1baf7a',
  Branded: '#888780',
  Other: '#b4b2a9',
  Collection: '#6b4fbb',
  Product: '#b5487a',
}

// What each category means for Succulents Box — the only facts the AI may use in category mode
export const CATEGORY_DESCRIPTIONS = {
  Succulents: 'Live succulents and cacti shipped online',
  Houseplants: 'Live indoor houseplants shipped online',
  'Succulent Subscription': 'Monthly succulent subscription boxes',
  'Gift Boxes': 'Plant gift boxes for occasions (birthday, thank you, sympathy, Mother\'s Day, etc.)',
  'Air Plants': 'Live air plants (tillandsias) and air plant terrarium kits',
}

// Default landing pages for category ad groups (editable per ad group in the UI)
export const CATEGORY_LANDING_PAGES = {
  Succulents: 'https://succulentsbox.com/collections/succulents',
  Houseplants: 'https://succulentsbox.com/collections/houseplants',
  'Succulent Subscription': 'https://succulentsbox.com/collections/succulent-subscription-box',
  'Gift Boxes': 'https://succulentsbox.com/collections/plant-gift-boxes',
  'Air Plants': 'https://succulentsbox.com/collections/air-plants-tillandsias',
}

export const BRAND_CONTEXT = `Succulents Box (succulentsbox.com) sells:
- Individual succulents, cacti, and houseplants shipped online
- Air plants and air plant terrarium kits
- Succulent gift boxes (occasion-based: birthday, thinking of you, thank you, sympathy, Mother's Day)
- Monthly succulent subscription boxes`

// Sources — observed GSC queries and AI expansions must always stay distinguishable
export const SOURCES = {
  gsc_observed: 'Observed GSC query',
  gsc_derived: 'Derived from GSC query',
  ai_expansion: 'AI expansion',
  manual: 'Added manually',
}
// Older saved data used 'from_gsc' / 'suggested' / 'ai_suggested'
export function normalizeSource(source) {
  if (source === 'from_gsc') return 'gsc_observed'
  if (source === 'suggested' || source === 'ai_suggested') return 'ai_expansion'
  return SOURCES[source] ? source : 'ai_expansion'
}

export const MATCH_TYPES = ['broad', 'phrase', 'exact']

// Individual plant names — excluded in CATEGORY mode (low AOV); allowed in product/collection
// mode only when the plant actually appears in the selected page context.
export const INDIVIDUAL_PLANT_TERMS = [
  'pothos', 'philodendron', 'monstera', 'fern', 'spider plant', 'snake plant',
  'peace lily', 'fiddle', 'zz plant', 'rubber plant', 'money tree', 'orchid',
  'bromeliad', 'calathea', 'dracaena', 'hoya', 'pink princess', 'golden crocodile',
  'curly spider', 'callisia', 'purple heart', 'frizzle sizzle', 'adenium',
  'calandiva', 'bird of paradise', 'alocasia', 'anthurium', 'begonia', 'coleus',
  'croton', 'peperomia', 'pilea', 'tradescantia', 'turtle vine', 'pink lady',
  'ruby necklace', 'ric rac', 'pigs ear', 'dancing bones', 'string of pearls',
  'string of hearts', 'string of dolphins', 'string of bananas', 'string of',
  'cebu blue', 'ivy plant', 'ivy plants',
  'echeveria', 'sedum', 'sempervivum', 'lithops', 'crassula', 'euphorbia',
  'gasteria', 'portulacaria', 'elephant bush', 'zebra plant', 'bear paw',
  'black rose succulent', 'split rock', 'dinosaur back', 'baby toes', 'cotyledon',
  'dolphin plant', 'aeonium', 'senecio', 'tephrocactus', 'albuca',
  'graptosedum', 'graptoveria', 'pachyphytum', 'graptopetalum', 'mammillaria',
  'opuntia', 'cereus', 'calico kitten', 'haworthia', 'aloe vera', 'agave',
  'tillandsia xerographica', 'xerographica', 'ionantha',
]

// Queries implying products we don't sell
export const NONEXISTENT_PRODUCT_TERMS = [
  'cactus subscription', 'cactus box', 'cactus monthly', 'cactus club',
  'air plant subscription',
]

// Care/informational signals — not good ad targets
export const INFORMATIONAL_SIGNALS = [
  'how to', 'how do', 'how do i', 'why is', 'why are', 'why does',
  'what is', 'what are', 'what does',
  'care for', 'care guide', 'care tips', 'care and', 'caring for',
  'propagat', 'repot', 'repotting',
  'dying', 'dying?', 'dead', 'yellow', 'brown', 'mushy', 'drooping', 'wilting',
  'overwater', 'underwater', 'sunburn', 'etiolated', 'leggy',
  'spots on', 'spots ',
  'dormant', 'dormancy',
  'toxic', 'safe for', 'pet safe', 'cat safe', 'dog safe',
  'identify', 'identification', 'types of', 'varieties of',
  'difference between', ' vs ', 'versus',
  'when to', 'how often', 'soil for', 'water ', 'watering',
  'fertilize', 'fertilizer', 'light for', 'sunlight',
]

export function isInformational(query) {
  const q = String(query).toLowerCase()
  return INFORMATIONAL_SIGNALS.some(signal => q.includes(signal))
}

// Normalized base keyword: lowercase, no match-type punctuation, single spaces
export function normalizeKeyword(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .replace(/["\[\]+]/g, ' ')
    .replace(/[^\p{L}\p{N}'&\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Display text for a base keyword in a given match type (Google Ads notation)
export function formatMatchType(base, matchType) {
  if (matchType === 'phrase') return `"${base}"`
  if (matchType === 'exact') return `[${base}]`
  return base
}

function plantTermsIn(text) {
  const t = String(text || '').toLowerCase()
  return INDIVIDUAL_PLANT_TERMS.filter(term => t.includes(term))
}

// Google Ads keyword limits: 80 characters and 10 words
export const ADS_KEYWORD_MAX_CHARS = 80
export const ADS_KEYWORD_MAX_WORDS = 10
export function exceedsAdsKeywordLimits(keyword) {
  const k = normalizeKeyword(keyword)
  return k.length > ADS_KEYWORD_MAX_CHARS || k.split(' ').length > ADS_KEYWORD_MAX_WORDS
}

// Returns { ok: boolean, reason?: string }.
// mode: 'category' | 'collection' | 'product'
// contextText: page title/description/selected product names (collection/product modes)
export function checkKeywordEligibility(keyword, mode, contextText = '') {
  const k = normalizeKeyword(keyword)
  if (!k) return { ok: false, reason: 'empty' }
  if (exceedsAdsKeywordLimits(k)) return { ok: false, reason: 'too long for Google Ads (max 80 characters / 10 words)' }
  if (NONEXISTENT_PRODUCT_TERMS.some(t => k.includes(t))) return { ok: false, reason: 'product we do not sell' }
  if (isInformational(k)) return { ok: false, reason: 'informational query' }

  const plants = plantTermsIn(k)
  if (plants.length === 0) return { ok: true }
  if (mode === 'category') return { ok: false, reason: 'individual plant name (category mode)' }

  // Collection/product modes: plant names are allowed only if they belong to the selected page
  const allowed = new Set(plantTermsIn(contextText))
  const unrelated = plants.filter(p => !allowed.has(p))
  // 'string of' is a prefix of other terms — only reject when no longer allowed term covers it
  const realUnrelated = unrelated.filter(p => !(p === 'string of' && plants.some(o => o !== p && o.startsWith('string of') && allowed.has(o))))
  if (realUnrelated.length > 0) return { ok: false, reason: `unrelated plant (${realUnrelated[0]})` }
  return { ok: true }
}

export const HEADLINE_MAX = 30

// Exactly three non-empty headlines, each ≤ 30 characters
export function validateHeadlines(headlines) {
  const issues = []
  if (!Array.isArray(headlines)) return { valid: false, issues: ['missing headlines'] }
  if (headlines.length !== 3) issues.push(`expected 3 headlines, got ${headlines.length}`)
  headlines.forEach((h, i) => {
    const s = typeof h === 'string' ? h.trim() : ''
    if (!s) issues.push(`headline ${i + 1} is empty`)
    else if (s.length > HEADLINE_MAX) issues.push(`headline ${i + 1} is ${s.length} chars (max ${HEADLINE_MAX})`)
  })
  return { valid: issues.length === 0, issues }
}

// ── Succulents Box URLs ──
export const ALLOWED_HOSTS = ['succulentsbox.com', 'www.succulentsbox.com']
export const CANONICAL_ORIGIN = 'https://succulentsbox.com'

// Parse and normalize a Succulents Box collection/product URL.
// Returns { ok, type, handle, collectionHandle?, url } or { ok: false, error }
export function parseStoreUrl(input) {
  let raw = String(input || '').trim()
  if (!raw) return { ok: false, error: 'Paste a Succulents Box collection or product URL.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let u
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, error: 'That does not look like a valid URL.' }
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: 'Only http(s) links are supported.' }
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) {
    return { ok: false, error: 'Unsupported URL.' }
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!ALLOWED_HOSTS.includes(host)) return { ok: false, error: 'Only succulentsbox.com links are allowed.' }

  const parts = u.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p).toLowerCase())
  const handleOk = h => /^[a-z0-9][a-z0-9-]*$/.test(h || '')

  // /products/<handle> or /collections/<c>/products/<handle>
  const pIdx = parts.indexOf('products')
  if (pIdx !== -1 && parts.length === pIdx + 2 && handleOk(parts[pIdx + 1]) && (pIdx === 0 || (pIdx === 2 && parts[0] === 'collections'))) {
    const handle = parts[pIdx + 1]
    return { ok: true, type: 'product', handle, url: `${CANONICAL_ORIGIN}/products/${handle}` }
  }
  // /collections/<handle>
  if (parts[0] === 'collections' && parts.length === 2 && handleOk(parts[1])) {
    return { ok: true, type: 'collection', handle: parts[1], url: `${CANONICAL_ORIGIN}/collections/${parts[1]}` }
  }
  return { ok: false, error: 'Use a collection (/collections/…) or product (/products/…) URL.' }
}

export function isAllowedStoreHost(url) {
  try {
    const u = new URL(url)
    return ['http:', 'https:'].includes(u.protocol) && ALLOWED_HOSTS.includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}
