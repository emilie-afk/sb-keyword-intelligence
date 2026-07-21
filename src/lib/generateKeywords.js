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
    'air plant subscription box',
    'where to buy air plants',
    'air plants delivered',
    'air plant set',
    'tillandsia shop',
    'low maintenance air plants',
  ],
  'Gift Boxes': [
    'succulent gift box',
    'succulent gifts',
    'plant gift box',
    'succulent gift set',
    "mother's day succulent gift",
    'birthday succulent gift',
    'succulent gift basket',
    'succulent gift delivery',
    'plant gift for her',
    'succulent gift ideas',
    'send succulents as a gift',
    'plant gift for mom',
    'unique plant gifts',
    'get well soon plant gift',
  ],
  'Succulent Subscription': [
    'succulent subscription box',
    'monthly succulent delivery',
    'succulent of the month club',
    'plant subscription box',
    'best succulent subscription',
    'monthly cactus box',
    'succulent subscription service',
    'succulent delivery monthly',
    'plant of the month club',
    'cactus subscription box',
  ],
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

    // 1. GSC queries that have buying intent AND are not informational (care guides, how-tos)
    //    Capped at 10 per category — skips individual plant name-only queries automatically
    //    since those rarely have buying signals
    const gscBuying = (stats?.topBuyingQueries || [])
      .filter(q => !q.isInformational)
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
