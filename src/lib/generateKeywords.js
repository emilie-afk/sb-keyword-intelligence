// Ad keyword generation logic
// Keywords come entirely from Google Search Console data — no hardcoded lists

// Individual plant names that should NOT become ad keywords (low AOV)
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

// Queries implying products we don't sell
const NONEXISTENT_PRODUCT_TERMS = [
  'cactus subscription',
  'cactus box',
  'cactus monthly',
  'cactus club',
]

function isIndividualPlant(query) {
  const q = query.toLowerCase()
  return INDIVIDUAL_PLANT_TERMS.some(term => q.includes(term))
}

function isNonexistentProduct(query) {
  const q = query.toLowerCase()
  return NONEXISTENT_PRODUCT_TERMS.some(term => q.includes(term))
}

// Generate broad / phrase / exact match type variants for a single keyword
function makeMatchTypes(keyword, category, isGapCategory) {
  return [
    { keyword, matchType: 'broad', category, isGapCategory },
    { keyword: `"${keyword}"`, matchType: 'phrase', category, isGapCategory },
    { keyword: `[${keyword}]`, matchType: 'exact', category, isGapCategory },
  ]
}

// Build the ad keyword list purely from GSC buying-intent queries
export function buildAdKeywords(processedQueries, categoryStats) {
  const keywords = []
  const cats = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

  for (const cat of cats) {
    const stats = categoryStats[cat]
    const isGap = stats?.isGap || false

    // Top buying-intent GSC queries, excluding:
    // - care/informational queries
    // - individual plant name searches (low AOV)
    // - queries implying products we don't sell
    const gscBuying = (stats?.topBuyingQueries || [])
      .filter(q => !q.isInformational && !isIndividualPlant(q.query) && !isNonexistentProduct(q.query))
      .slice(0, 15)

    for (const q of gscBuying) {
      const cleanKeyword = q.query.replace(/["\[\]]/g, '').trim()
      keywords.push(...makeMatchTypes(cleanKeyword, cat, isGap))
    }
  }

  return keywords
}

// Generate additional keywords for all categories + headlines via Claude
// Returns the full merged keyword list (GSC + AI-generated) with headlines attached
export async function generateKeywordsAndHeadlines(gscKeywords) {
  const gscBroad = gscKeywords.filter(k => k.matchType === 'broad')

  const response = await fetch('/.netlify/functions/generate-headlines', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gscKeywords: gscBroad }),
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.error || 'Failed to generate keywords')
  }

  const { suggestedKeywords, headlineMap } = await response.json()

  // Expand suggested keywords to all 3 match types
  const suggestedAll = []
  for (const kw of (suggestedKeywords || [])) {
    suggestedAll.push(kw)
    suggestedAll.push({ ...kw, keyword: `"${kw.keyword}"`, matchType: 'phrase' })
    suggestedAll.push({ ...kw, keyword: `[${kw.keyword}]`, matchType: 'exact' })
  }

  // Merge and attach headlines
  return [...gscKeywords, ...suggestedAll].map(kw => {
    const clean = kw.keyword.replace(/["\[\]]/g, '').trim()
    return { ...kw, headlines: headlineMap[clean] || [] }
  })
}
