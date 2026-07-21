// Ad keyword generation logic
// Takes processed GSC queries and produces a keyword list for Google Ads

// Curated keywords for every category — these always appear regardless of GSC data.
// Focus: category-level shopping terms, gift occasions, product type — NOT individual plant names.
const CURATED_KEYWORDS = {
  Succulents: [
    'buy succulents online',
    'succulents for sale',
    'succulents delivered',
    'rare succulents for sale',
    'unique succulents online',
    'small succulents bulk',
    'cactus for sale online',
    'buy cactus online',
    'succulent plants online',
    'aloe vera plant for sale',
  ],
  Houseplants: [
    'buy houseplants online',
    'indoor plants for sale',
    'houseplants delivered',
    'rare houseplants for sale',
    'unique indoor plants',
    'tropical houseplants online',
    'buy indoor plants online',
    'rare plants for sale',
    'exotic houseplants online',
    'houseplant shop online',
  ],
  'Air Plants': [
    'buy air plants online',
    'air plants for sale',
    'tillandsia for sale',
    'air plant gift',
    'where to buy air plants',
    'air plants delivered',
    'air plant terrarium kit',
    'tillandsia shop',
    'low maintenance air plants',
  ],
  'Gift Boxes': [
    'succulent gift box',
    'birthday succulent gift box',
    'thinking of you gift with plant',
    'thank you gift box with succulent',
    "mother's day succulent gift",
    'succulent gift for her',
    'plant sympathy gift',
    'pet memorial gift with plant',
    'succulent arrangement gift',
    'air plant terrarium gift',
    'unique plant gift',
    'send succulents as a gift',
    'succulent gift set',
    'plant gift delivered',
  ],
  'Succulent Subscription': [
    'succulent subscription box',
    'monthly succulent delivery',
    'succulent of the month club',
    'plant subscription box',
    'best succulent subscription',
    'succulent subscription service',
    'succulent delivery monthly',
    'plant of the month club',
  ],
}

// Specific plant names that should NOT become ad keywords on their own.
// We bid on category-level terms ("succulents for sale"), not individual cultivars
// ("string of pearls for sale", "pothos for sale") — low AOV, wrong intent level.
const INDIVIDUAL_PLANT_TERMS = [
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
  'opuntia', 'cereus', 'calico kitten', 'haworthia',
]

function isIndividualPlant(query) {
  const q = query.toLowerCase()
  return INDIVIDUAL_PLANT_TERMS.some(term => q.includes(term))
}

// GSC queries implying products we don't sell — exclude from ad keywords
const NONEXISTENT_PRODUCT_TERMS = [
  'cactus subscription',
  'cactus box',
  'cactus monthly',
  'cactus club',
]

function isNonexistentProduct(query) {
  const q = query.toLowerCase()
  return NONEXISTENT_PRODUCT_TERMS.some(term => q.includes(term))
}

// Generate all match type variants for a single keyword
function makeMatchTypes(keyword, category, source, isGapCategory) {
  return [
    { keyword, matchType: 'broad', category, source, isGapCategory },
    { keyword: `"${keyword}"`, matchType: 'phrase', category, source, isGapCategory },
    { keyword: `[${keyword}]`, matchType: 'exact', category, source, isGapCategory },
  ]
}

// Build the full keyword list from processed queries + curated suggestions
// Returns an array of keyword objects ready for headline generation
export function buildAdKeywords(processedQueries, categoryStats) {
  const keywords = []

  const cats = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

  for (const cat of cats) {
    const stats = categoryStats[cat]
    const isGap = stats?.isGap || false

    // 1. GSC queries that have buying intent, are not informational, and are not
    //    individual plant names (low AOV — bid on category terms instead)
    const gscBuying = (stats?.topBuyingQueries || [])
      .filter(q => !q.isInformational && !isIndividualPlant(q.query) && !isNonexistentProduct(q.query))
      .slice(0, 10)
    for (const q of gscBuying) {
      const cleanKeyword = q.query.replace(/["\[\]]/g, '').trim()
      keywords.push(...makeMatchTypes(cleanKeyword, cat, 'from_gsc', isGap))
    }

    // 2. Always add curated category-level keywords (gift occasions, shopping terms, product type)
    //    These are the high-value ad targets regardless of what GSC shows
    if (CURATED_KEYWORDS[cat]) {
      for (const kw of CURATED_KEYWORDS[cat]) {
        keywords.push(...makeMatchTypes(kw, cat, 'suggested', isGap))
      }
    }
  }

  // Deduplicate by base keyword (in case a GSC query matches a curated one)
  const seen = new Set()
  return keywords.filter(kw => {
    const clean = kw.keyword.replace(/["\[\]]/g, '').trim().toLowerCase()
    const key = `${kw.category}|${clean}|${kw.matchType}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Call the Netlify function to generate Claude headlines for a batch of keywords
// Returns the same keywords array with headlines added
export async function generateHeadlines(keywords) {
  // Group keywords by category + base keyword to avoid sending duplicates to Claude
  // We only need headlines for the 'broad' variant; phrase/exact share the same headlines
  const uniqueKeywords = keywords.filter(k => k.matchType === 'broad')

  const response = await fetch('/.netlify/functions/generate-headlines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: uniqueKeywords }),
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.error || 'Failed to generate headlines')
  }

  const { results } = await response.json()

  // Map headlines back to all match type variants
  const headlineMap = {}
  for (const r of results) {
    headlineMap[r.keyword] = r.headlines
  }

  return keywords.map(kw => {
    const cleanKeyword = kw.keyword.replace(/["\[\]]/g, '').trim()
    return {
      ...kw,
      headlines: headlineMap[cleanKeyword] || [],
    }
  })
}
