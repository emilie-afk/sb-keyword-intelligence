// Keyword categorization logic — mirrors the analysis done on the GSC CSV
// Edit these lists to adjust how queries are bucketed

// Brand terms are checked FIRST before any other category
const BRAND_TERMS = [
  'succulents box', 'succulent box', 'succulentsbox', 'succulentbox', 'the succulent box',
]

const CATEGORY_KEYWORDS = {
  Branded: BRAND_TERMS,

  'Succulent Subscription': [
    'subscription', 'monthly box', 'monthly succulent', 'plant subscription',
    'plant box', 'succulent delivery', 'plant delivery', 'succulent club',
    'plant of the month', 'plant club', 'succulent crate', 'cactus subscription',
  ],

  'Gift Boxes': [
    'gift', 'gifts', 'present', 'birthday', 'christmas', 'holiday',
    'mother', 'father', 'wedding', 'anniversary', 'baby shower',
    'gift set', 'gift box', 'gift basket', 'care package', 'get well',
  ],

  'Air Plants': [
    'air plant', 'air plants', 'tillandsia', 'airplant', 'tillandsias',
  ],

  Houseplants: [
    'philodendron', 'pothos', 'monstera', 'fern', 'spider plant', 'snake plant',
    'peace lily', 'fiddle', 'zz plant', 'rubber plant', 'money tree', 'orchid',
    'bromeliad', 'calathea', 'dracaena', 'hoya', 'houseplant', 'house plant',
    'indoor plant', 'indoor plants', 'tropical plant', 'pink princess',
    'golden crocodile', 'curly spider', 'callisia', 'purple heart',
    'frizzle sizzle', 'adenium', 'calandiva', 'bird of paradise', 'alocasia',
    'anthurium', 'begonia', 'coleus', 'croton', 'peperomia', 'pilea',
    'tradescantia', 'turtle vine', 'pink lady', 'ruby necklace', 'ric rac',
    'pigs ear', 'dancing bones', 'string of', 'kalanch', 'cebu blue',
    'ivy plant', 'ivy plants',
  ],

  Succulents: [
    'succulent', 'succulents', 'cactus', 'cacti', 'aloe', 'agave', 'haworthia',
    'echeveria', 'sedum', 'sempervivum', 'lithops', 'crassula', 'euphorbia',
    'gasteria', 'jade plant', 'portulacaria', 'elephant bush', 'zebra plant',
    'bear paw', 'black rose succulent', 'split rock', 'dinosaur back', 'baby toes',
    'cotyledon', 'dolphin plant', 'aeonium', 'senecio', 'tephrocactus', 'albuca',
    'callisia repens', 'graptosedum', 'graptoveria', 'pachyphytum', 'graptopetalum',
    'mammillaria', 'opuntia', 'cereus', 'calico kitten',
  ],
}

const BUYING_INTENT_KEYWORDS = [
  'buy', 'for sale', 'sale', 'shop', 'order', 'purchase', 'price', 'cheap',
  'affordable', 'where to buy', 'online', 'store', 'delivery', 'ship', 'shipping',
  'subscription', 'monthly box', 'plant box', 'box', 'set', 'kit', 'bundle',
  'collection', 'pot', 'pots', 'planter', 'arrangement', 'basket', 'terrarium',
  'near me', 'discount', 'deal', 'best place', 'where can i', 'how much', 'gift',
]

// Queries containing these signals are care/informational — not good ad targets
const INFORMATIONAL_SIGNALS = [
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

// A category is considered a "gap" if it has few buying-intent queries
// relative to its total search volume
const GAP_THRESHOLDS = {
  buying_queries: 5,  // fewer than this = gap
  total_clicks: 500,  // AND fewer than this total clicks
}

export function categorizeQuery(query) {
  const q = query.toLowerCase()
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (q.includes(kw.toLowerCase())) return cat
    }
  }
  return 'Other'
}

export function hasBuyingIntent(query) {
  const q = query.toLowerCase()
  return BUYING_INTENT_KEYWORDS.some(kw => {
    // Use word boundaries so 'pot' doesn't match 'spots' or 'repot'
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`).test(q)
  })
}

// Returns true for care guides, how-tos, troubleshooting — not good ad targets
export function isInformational(query) {
  const q = query.toLowerCase()
  return INFORMATIONAL_SIGNALS.some(signal => q.includes(signal))
}

// Process raw GSC rows into enriched, categorized query objects
export function processQueries(rawRows) {
  return rawRows.map(row => ({
    ...row,
    category: categorizeQuery(row.query),
    buyingIntent: hasBuyingIntent(row.query),
    isInformational: isInformational(row.query),
    isBranded: BRAND_TERMS.some(t => row.query.toLowerCase().includes(t)),
  }))
}

// Build category-level summary stats from processed queries
export function buildCategoryStats(processedQueries) {
  const stats = {}
  const cats = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants', 'Branded', 'Other']

  for (const cat of cats) {
    const rows = processedQueries.filter(q => q.category === cat)
    const buyingRows = rows.filter(q => q.buyingIntent)
    const infoRows = rows.filter(q => !q.buyingIntent)

    stats[cat] = {
      totalQueries: rows.length,
      totalClicks: rows.reduce((s, q) => s + q.clicks, 0),
      totalImpressions: rows.reduce((s, q) => s + q.impressions, 0),
      buyingQueries: buyingRows.length,
      buyingClicks: buyingRows.reduce((s, q) => s + q.clicks, 0),
      buyingImpressions: buyingRows.reduce((s, q) => s + q.impressions, 0),
      infoQueries: infoRows.length,
      infoClicks: infoRows.reduce((s, q) => s + q.clicks, 0),
      topBuyingQueries: [...buyingRows].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
      topInfoQueries: [...infoRows].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
      isGap: buyingRows.length < GAP_THRESHOLDS.buying_queries &&
             rows.reduce((s, q) => s + q.clicks, 0) < GAP_THRESHOLDS.total_clicks,
    }
  }

  return stats
}
