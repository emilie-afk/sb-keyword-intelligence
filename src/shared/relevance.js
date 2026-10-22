// Target relevance + advertising intent — the single gate for every GSC seed and every keyword
// (observed, derived, AI expansion). Shared by the UI, client logic and the Netlify function.
//
// assessKeyword(text, target) → { verdict: 'relevant' | 'uncertain' | 'excluded', reason, detail }
//   relevant  → auto-selected / allowed into results
//   uncertain → kept out by default (no clear evidence it fits this target)
//   excluded  → clearly wrong for ads or for this target
//
// target = { mode: 'category'|'collection'|'product', category, text }
//   text: the target's own product facts (title, handle, product type, tags, selected product
//   titles, aliases) — NOT long descriptions, which mention everything.
//
// Generic overlap ("plant", "box", "well", "best", …) never makes a query relevant.

import { normalizeKeyword, exceedsAdsKeywordLimits, NONEXISTENT_PRODUCT_TERMS, isInformational } from './keywordRules.js'

// ── text helpers ──
function stem(w) {
  if (w === 'cacti' || w === 'cactuses') return 'cactus'
  if (w.length > 4 && /(xes|ches|shes|sses)$/.test(w)) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}
const norm = t => normalizeKeyword(String(t || '').replace(/['’]s\b/g, 's').replace(/['’]/g, ''))
const toks = t => norm(t).split(' ').filter(Boolean).map(stem)
const padded = t => ` ${toks(t).join(' ')} `
// Vocabulary phrases repeat across every query. Normalize them once rather than per row.
const phraseCache = new Map()
const has = (pq, phrase) => {
  let key = phraseCache.get(phrase)
  if (!key) {
    key = ` ${toks(phrase).join(' ')} `
    if (phraseCache.size >= 2048) phraseCache.clear()
    phraseCache.set(phrase, key)
  }
  return pq.includes(key)
}
const hasAny = (pq, list) => list.find(p => has(pq, p)) || null

// ── vocabularies ──
// Never evidence of relevance on their own
export const GENERIC_TERMS = new Set(toks(`plant plants box boxes well best good great top live real fresh small mini large big cute unique cheap
affordable online shop store buy sale order delivery delivered shipping free near me new indoor outdoor easy beautiful
pretty rare set kit pot pots potted home house green greenery nature natural idea ideas option options type types kind
kinds different popular perfect gift`))

// Gifting
const GIFT_TERMS = ['gift', 'gifts', 'gifting', 'present', 'presents', 'care package', 'gift basket', 'hamper', 'stocking stuffer', 'secret santa', 'favor', 'favors']
const OCCASIONS = ['birthday', 'sympathy', 'condolence', 'bereavement', 'memorial', 'funeral', 'in memory', 'get well', 'thank you',
  'thinking of you', 'housewarming', 'new home', 'mothers day', 'mother day', 'fathers day', 'father day', 'valentine', 'valentines',
  'christmas', 'holiday', 'anniversary', 'graduation', 'wedding', 'bridal', 'baby shower', 'new baby', 'retirement',
  'congratulation', 'appreciation', 'just because', 'im sorry', 'encouragement', 'self care', 'corporate', 'client', 'employee']
const RECIPIENT = /\bfor (a |my |the |your )?(mom|mother|mum|dad|father|her|him|grandma|grandmother|grandpa|grandfather|grandparent|wife|husband|girlfriend|boyfriend|friend|best friend|teacher|coworker|co worker|boss|employee|client|nurse|new mom|sister|brother|daughter|son|aunt|uncle|women|men|kid|teen)s?\b/
const GIFT_CONTAINERS = ['box', 'basket', 'care package', 'crate', 'hamper', 'bundle', 'set', 'kit', 'sampler', 'package']
// Gifts Succulents Box doesn't sell (only a conflict when no plant term is present)
const NON_PLANT_GIFTS = ['wine', 'chocolate', 'fruit', 'cookie', 'snack', 'candy', 'food', 'coffee', 'spa', 'beer', 'whiskey', 'cheese',
  'edible', 'flower bouquet', 'bouquet', 'rose', 'balloon', 'sock', 'gift card', 'money', 'cash', 'jewelry', 'perfume']

// Plants
const PLANT_WORDS = ['plant', 'succulent', 'cactus', 'houseplant', 'house plant', 'air plant', 'tillandsia', 'terrarium', 'greenery', 'bonsai', 'orchid', 'fern']
const SUCCULENT_ANCHORS = ['succulent', 'cactus', 'echeveria', 'sedum', 'sempervivum', 'hens and chick', 'haworthia', 'aloe', 'agave', 'crassula', 'jade',
  'lithops', 'living stone', 'kalanchoe', 'aeonium', 'euphorbia', 'gasteria', 'mammillaria', 'opuntia', 'prickly pear', 'string of pearl',
  'string of banana', 'string of dolphin', 'string of heart', 'burro tail', 'burros tail', 'panda plant', 'zebra plant', 'christmas cactus',
  'senecio', 'graptopetalum', 'graptoveria', 'pachyphytum', 'cotyledon', 'portulacaria', 'elephant bush', 'calico kitten', 'mangave', 'ghost plant']
const HOUSEPLANT_ANCHORS = ['houseplant', 'house plant', 'indoor plant', 'tropical plant', 'indoor tree', 'office plant', 'desk plant', 'pothos',
  'monstera', 'philodendron', 'snake plant', 'sansevieria', 'zz plant', 'fern', 'calathea', 'hoya', 'peperomia', 'pilea', 'dracaena',
  'ficus', 'fiddle leaf', 'rubber plant', 'money tree', 'peace lily', 'spider plant', 'alocasia', 'anthurium', 'begonia', 'croton',
  'tradescantia', 'syngonium', 'dieffenbachia', 'ivy', 'palm', 'bird of paradise', 'orchid', 'prayer plant', 'chinese evergreen',
  'aglaonema', 'string of turtle', 'polka dot plant', 'hypoestes', 'bonsai']
const AIR_PLANT_ANCHORS = ['air plant', 'airplant', 'tillandsia', 'xerographica', 'ionantha', 'spanish moss']
const SUBSCRIPTION_ANCHORS = ['subscription', 'monthly', 'of the month', 'club', 'membership', 'every month', 'recurring']

// Supplies, growing media, equipment — not live-plant or gift ads (unless the target IS supplies)
const SUPPLY_TERMS = ['soil', 'potting mix', 'cactus mix', 'succulent mix soil', 'well draining', 'well drained', 'drainage', 'leca', 'perlite',
  'pumice', 'vermiculite', 'peat', 'coco coir', 'bark mix', 'fertilizer', 'fertiliser', 'plant food', 'grow light', 'grow lamp',
  'pebble', 'gravel', 'top dressing', 'topdressing', 'moss pole', 'humidifier', 'pesticide', 'neem', 'hydroponic', 'self watering']

// Advice / growing-conditions / research phrasing — no advertising intent
// Buying signals: a question that asks where/how to BUY is a buying query, not advice
const BUYING = /\b(buy|buying|purchase|purchasing|order|ordering|shop|shopping|for sale|sell|sells|seller|sellers|deliver|delivery|delivered|send|sending|online|near me|price|prices|cheap|where to get|best place)\b/
const QUESTION_START = /^(what|which|why|how|when|where|who|can|could|does|do|is|are|should|will|would)\b/
// Always advice, even with a buying word
const ADVICE_STRONG = [
  /\b(do|does|grow|grows|growing|thrive|thrives|survive|survives|live) well\b/,
  /\bthat (do|does|grow|thrive|need|needs|like|likes|can)\b/,
  /\b(light|water|watering|sun|humidity|temperature) (requirement|need|needs|schedule)\b/,
  /\b(tip|tips|guide|tutorial|meaning|symbolism|benefit|benefits|fact|facts|problem|problems|disease|pest|pests|bug|bugs|dying|wilting|mushy|leggy|root rot|propagat\w*|repot\w*|prune|pruning|overwater\w*|underwater\w*)\b/,
  /\bcare\b(?!\s*(pack|package|kit|set|bundle|box|gift))/,
  /\bvs\b|\bversus\b|\bdifference between\b/,
]
// Advice unless the query is clearly about buying
const ADVICE_SOFT = [
  /\b(yellow|brown|dead|turning|drooping|why)\b/,
  /\b(low|bright|indirect|direct|full|partial) (light|sun|shade)\b.*\b(plant|houseplant|succulent)s?\b.*\b(that|for|in)\b/,
]
// Plant attributes: advice as a question, but a product attribute when the target has it or the query is buying
const ATTRIBUTE = /\b(toxic|non toxic|poisonous|pet safe|pet friendly|safe for (cat|dog|pet|kid)s?|cat safe|dog safe)\b/
const PET_TARGET = /\b(pet|cat|dog|non toxic|toxic)\b/
const RESEARCH_PATTERNS = [/\breviews?\b/, /\breddit\b/, /\bcomplaint/, /\bscam\b/, /\blegit\b/, /\bcoupon\b/, /\bdiscount code\b/, /\bpromo code\b/]

// ── category rules ──
const CATEGORY_RULES = {
  'Gift Boxes': { anchors: [], gifting: true },
  Succulents: { anchors: SUCCULENT_ANCHORS },
  Houseplants: { anchors: HOUSEPLANT_ANCHORS },
  'Air Plants': { anchors: AIR_PLANT_ANCHORS },
  'Succulent Subscription': { anchors: SUBSCRIPTION_ANCHORS, needsPlant: true },
}
const OTHER_CATEGORY_ANCHORS = {
  Succulents: SUCCULENT_ANCHORS,
  Houseplants: HOUSEPLANT_ANCHORS,
  'Air Plants': AIR_PLANT_ANCHORS,
  'Succulent Subscription': SUBSCRIPTION_ANCHORS,
}

export const REASONS = {
  relevant: 'Relevant',
  too_long: 'Too long for Google Ads',
  advice: 'Care, advice or growing-conditions question',
  research: 'Research query (reviews, codes)',
  supplies: 'Soil, growing media or supplies',
  non_plant_gift: 'Gift type we don’t sell',
  not_sold: 'Product we don’t sell',
  no_gift_intent: 'No gifting intent',
  gift_unsupported: 'Gift query not tied to plant gifts',
  other_category: 'Belongs to another category',
  other_plant: 'Plant not in this target',
  not_specific: 'Not specific to this product/collection',
  no_anchor: 'No clear link to this target',
}

const result = (verdict, reason, detail = '') => ({ verdict, reason, detail })

export function giftingSignal(text) {
  const pq = padded(text)
  const n = ` ${norm(text)} `
  return hasAny(pq, GIFT_TERMS) || hasAny(pq, OCCASIONS) || (RECIPIENT.test(n) ? 'recipient' : null)
}

// Ad intent: advice, research and supplies are not advertising targets
export function adIntentProblem(text, target = {}) {
  const k = norm(text)
  if (!k) return result('excluded', 'no_anchor', 'empty')
  if (exceedsAdsKeywordLimits(k)) return result('excluded', 'too_long')
  if (NONEXISTENT_PRODUCT_TERMS.some(t => k.includes(t))) return result('excluded', 'not_sold')
  const targetText = norm(target.text || '')
  const supply = hasAny(padded(k), SUPPLY_TERMS)
  if (supply && !hasAny(padded(targetText), SUPPLY_TERMS)) return result('excluded', 'supplies', supply)
  if (ADVICE_STRONG.some(re => re.test(k))) return result('excluded', 'advice')
  const buying = BUYING.test(k)
  // Attribute queries ("pet safe houseplants") fit a target with that attribute, or when buying
  const attribute = ATTRIBUTE.test(k)
  const attributeOk = attribute && (buying || PET_TARGET.test(targetText))
  if (!buying && !attributeOk) {
    if (attribute) return result('excluded', 'advice', 'plant safety question')
    // Legacy informational list includes generic words like "safe for"; skip it when the attribute is the target's
    if (QUESTION_START.test(k) || ADVICE_SOFT.some(re => re.test(k)) || isInformational(k)) return result('excluded', 'advice')
  }
  if (RESEARCH_PATTERNS.some(re => re.test(k))) return result('uncertain', 'research')
  return null
}

// Gifting intent: a gift word or recipient, or an occasion together with a plant or gift container
// (an occasion alone — "birthday cake" — is not gifting intent)
export function giftIntent(text) {
  const k = norm(text)
  const pq = padded(k)
  const giftWord = hasAny(pq, GIFT_TERMS) || (RECIPIENT.test(` ${k} `) ? 'recipient' : null)
  if (giftWord) return giftWord
  const occasion = hasAny(pq, OCCASIONS)
  const plant = hasAny(pq, PLANT_WORDS) || hasAny(pq, SUCCULENT_ANCHORS) || hasAny(pq, HOUSEPLANT_ANCHORS) || hasAny(pq, AIR_PLANT_ANCHORS)
  if (occasion && (plant || hasAny(pq, GIFT_CONTAINERS))) return occasion
  return null
}

function assessCategory(k, category) {
  const pq = padded(k)
  const rule = CATEGORY_RULES[category]
  if (!rule) return result('uncertain', 'no_anchor')
  const plant = hasAny(pq, PLANT_WORDS) || hasAny(pq, SUCCULENT_ANCHORS) || hasAny(pq, HOUSEPLANT_ANCHORS) || hasAny(pq, AIR_PLANT_ANCHORS)

  if (rule.gifting) {
    const intent = giftIntent(k)
    const occasion = hasAny(pq, OCCASIONS)
    const container = hasAny(pq, GIFT_CONTAINERS)
    const nonPlant = hasAny(pq, NON_PLANT_GIFTS)
    if (nonPlant && !plant) return result('excluded', 'non_plant_gift', nonPlant)
    if (!intent) return result('excluded', 'no_gift_intent', occasion || '')
    // Supported by what the gift boxes actually are: plant gifts, gift containers or an occasion
    if (!(plant || container || occasion)) return result('uncertain', 'gift_unsupported', intent)
    return result('relevant', 'relevant', [intent, occasion !== intent ? occasion : null, plant || container].filter(Boolean).join(', '))
  }

  const own = hasAny(pq, rule.anchors)
  if (!own) {
    for (const [cat, anchors] of Object.entries(OTHER_CATEGORY_ANCHORS)) {
      if (cat !== category && hasAny(pq, anchors)) return result('excluded', 'other_category', cat)
    }
    if (giftIntent(k)) return result('uncertain', 'other_category', 'Gift Boxes')
    return result('uncertain', 'no_anchor')
  }
  if (rule.needsPlant && !plant) return result('uncertain', 'no_anchor', `${own} without a plant term`)
  // Any gifting intent belongs to Gift Boxes ("buy succulent gifts", "birthday succulent") —
  // except gift subscriptions, which are a subscription product
  if (category !== 'Succulent Subscription' && giftIntent(k)) return result('uncertain', 'other_category', 'Gift Boxes')
  // Subscription intent belongs to Succulent Subscription
  if (category !== 'Succulent Subscription' && hasAny(pq, SUBSCRIPTION_ANCHORS)) return result('uncertain', 'other_category', 'Succulent Subscription')
  return result('relevant', 'relevant', own)
}

// Named plants (not family words like "succulent" or "houseplant")
const FAMILY_WORDS = new Set(['succulent', 'cactus', 'houseplant', 'house plant', 'indoor plant', 'tropical plant', 'indoor tree', 'office plant', 'desk plant', 'air plant', 'airplant', 'tillandsia'])
const SPECIFIC_PLANTS = [...new Set([...SUCCULENT_ANCHORS, ...HOUSEPLANT_ANCHORS, ...AIR_PLANT_ANCHORS])].filter(p => !FAMILY_WORDS.has(p))

// Distinctive anchors of a collection/product: words from its own names that are not generic
// Family words ("succulent", "houseplant", …) describe a whole category, not a product or assortment
const FAMILY_TOKENS = new Set(toks('succulent cactus houseplant plant air tillandsia airplant tropical tree flower'))
export function targetAnchors(target) {
  const words = new Set()
  for (const t of toks(target.text || '')) if (t.length > 2 && !GENERIC_TERMS.has(t) && !STOP.has(t) && !FAMILY_TOKENS.has(t)) words.add(t)
  return words
}
const STOP = new Set(toks(`a an the for of to in on at by with and or my your our her his their you me it this that these those from as is are be
he she they them we us him her via per x one two three four five six seven eight nine ten inch inches cm oz lb pack piece pcs assorted
assortment collection variety`))

function assessPage(k, target) {
  const pq = padded(k)
  const tpq = padded(target.text || '')
  // Specific plants named in the query must be in the target
  const plantsInQuery = SPECIFIC_PLANTS.filter(p => has(pq, p))
  const foreign = plantsInQuery.find(p => !has(tpq, p) && !plantsInQuery.some(o => o !== p && o.includes(p) && has(tpq, o)))
  if (foreign) return result('excluded', 'other_plant', foreign)
  const nonPlant = hasAny(pq, NON_PLANT_GIFTS)
  if (nonPlant && !hasAny(tpq, [nonPlant])) return result('excluded', 'non_plant_gift', nonPlant)

  const anchors = targetAnchors(target)
  const shared = [...new Set(toks(k).filter(t => anchors.has(t)))]
  const theme = target.category && CATEGORY_RULES[target.category] ? assessCategory(k, target.category) : null
  // Gift-themed targets: a shared name alone ("birthday cake") isn't enough — it needs gift or plant context
  const giftTarget = target.category === 'Gift Boxes' || !!giftingSignal(target.text || '')
  // (an occasion word alone — "birthday cake", "encouragement quotes" — is not gift context)
  const plantContext = hasAny(pq, PLANT_WORDS) || hasAny(pq, GIFT_CONTAINERS) || hasAny(pq, GIFT_TERMS) || RECIPIENT.test(` ${k} `)
  const anchored = shared.length > 0 && (!giftTarget || plantContext)

  if (target.mode === 'product') {
    if (anchored) return result('relevant', 'relevant', shared.join(', '))
    return result('uncertain', 'not_specific')
  }
  // collection: its own names/products, or — only for a category-level collection — the category theme
  if (anchored) return result('relevant', 'relevant', shared.join(', '))
  // A collection with defining qualifiers ("Pet Safe Houseplants") must match them; the whole category is not enough
  const qualifiers = collectionQualifiers(target)
  if (qualifiers.size) {
    if (theme?.verdict === 'excluded' && ['other_category', 'no_gift_intent', 'non_plant_gift'].includes(theme.reason)) return theme
    return result('uncertain', 'not_specific', [...qualifiers].join(' '))
  }
  if (theme?.verdict === 'relevant') return result('relevant', 'relevant', `${target.category}: ${theme.detail}`)
  if (theme?.verdict === 'excluded' && ['other_category', 'no_gift_intent', 'non_plant_gift'].includes(theme.reason)) return theme
  return result('uncertain', 'not_specific')
}

// Words that define a collection beyond its category ("pet safe" in "Pet Safe Houseplants");
// empty for category-level collections ("Plant Gift Boxes", "Succulents")
const COLLECTION_FILLER = new Set(toks(`curated collection collections shop all our best new popular favorite favorites favourite sale deals
featured bestseller bestsellers seller sellers selection select arrival arrivals shop`))
export function collectionQualifiers(target) {
  const out = new Set()
  for (const t of toks(target.title || '')) {
    if (t.length > 2 && !GENERIC_TERMS.has(t) && !STOP.has(t) && !FAMILY_TOKENS.has(t) && !COLLECTION_FILLER.has(t)) out.add(t)
  }
  return out
}

// Main entry point
export function assessKeyword(text, target = {}) {
  const k = norm(text)
  const intent = adIntentProblem(k, target)
  if (intent) return intent
  if (target.mode === 'category') return assessCategory(k, target.category)
  return assessPage(k, target)
}

export const isRelevant = (text, target) => assessKeyword(text, target).verdict === 'relevant'

// Short summary of exclusions: { reason → { count, examples } }
export function summarizeExclusions(items) {
  const out = {}
  for (const { text, reason } of items) {
    if (!reason || reason === 'relevant') continue
    out[reason] = out[reason] || { count: 0, examples: [] }
    out[reason].count++
    if (out[reason].examples.length < 3) out[reason].examples.push(text)
  }
  return out
}

export function exclusionSummaryText(summary) {
  return Object.entries(summary)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([r, v]) => `${v.count} ${REASONS[r] ? REASONS[r].toLowerCase() : r}`)
    .join(' · ')
}

// ── Targets from the ad-group payload (same shape on client and server) ──
// payload = { mode, category, context: { title, handle, productType, tags, aliases, products: [{ title, productType }] } }
const SYSTEM_TAG = /^[a-z]+-[\d.]+$/i
export function relevanceTarget(payload = {}) {
  const c = payload.context || {}
  const parts = [
    String(c.title || '').split('|')[0],
    String(c.handle || '').replace(/-/g, ' '),
    c.productType,
    ...(c.tags || []).filter(t => !SYSTEM_TAG.test(t)),
    ...(c.aliases || []),
    ...(c.products || []).flatMap(p => [String(p.title || '').split('|')[0], p.productType]),
  ]
  const title = [String(c.title || '').split('|')[0], String(c.handle || '').replace(/-/g, ' ')].filter(Boolean).join(' ')
  return { mode: payload.mode, category: payload.category, title, text: parts.filter(Boolean).join(' ') }
}

// Validate keywords for a target: { accepted: [base], rejected: [{ keyword, reason, detail }] }
export function validateKeywords(keywords, payload) {
  const target = relevanceTarget(payload)
  const accepted = []
  const rejected = []
  for (const kw of keywords || []) {
    const base = normalizeKeyword(kw)
    if (!base) continue
    const r = assessKeyword(base, target)
    if (r.verdict === 'relevant') accepted.push(base)
    else rejected.push({ keyword: base, reason: r.reason, detail: r.detail })
  }
  return { accepted, rejected }
}
