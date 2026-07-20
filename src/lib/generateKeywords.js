// Ad keyword generation logic
// Takes processed GSC queries and produces a keyword list for Google Ads

// Pre-built suggested keywords for gap categories
// These are added when a category has low organic buying-intent data
const GAP_KEYWORDS = {
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
    'christmas cactus gift',
    'plant gift for her',
    'succulent gift ideas',
    'send succulents as a gift',
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

// Build the full keyword list from processed queries + gap suggestions
// Returns an array of keyword objects ready for headline generation
export function buildAdKeywords(processedQueries, categoryStats) {
  const keywords = []

  const cats = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

  for (const cat of cats) {
    const stats = categoryStats[cat]
    const isGap = stats?.isGap || false

    // 1. Add buying-intent queries from GSC (top 15 per category)
    const gscBuying = (stats?.topBuyingQueries || []).slice(0, 15)
    for (const q of gscBuying) {
      const cleanKeyword = q.query.replace(/["\[\]]/g, '').trim()
      keywords.push(...makeMatchTypes(cleanKeyword, cat, 'from_gsc', isGap))
    }

    // 2. For gap categories, always add suggested keywords
    if (isGap && GAP_KEYWORDS[cat]) {
      for (const kw of GAP_KEYWORDS[cat]) {
        keywords.push(...makeMatchTypes(kw, cat, 'suggested', true))
      }
    }
  }

  return keywords
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
