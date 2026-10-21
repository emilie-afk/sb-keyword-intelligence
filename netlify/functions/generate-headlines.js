// Netlify serverless function
// Step 1: Generate additional buying-intent keywords for all categories
// Step 2: Write headlines for all keywords (GSC + generated)
// ANTHROPIC_API_KEY lives server-side, never exposed to the browser

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

// Individual plant names that should never appear as ad keywords (low AOV)
const INDIVIDUAL_PLANT_TERMS = [
  'pothos', 'philodendron', 'monstera', 'fern', 'spider plant', 'snake plant',
  'peace lily', 'fiddle', 'zz plant', 'rubber plant', 'money tree', 'orchid',
  'bromeliad', 'calathea', 'dracaena', 'hoya', 'pink princess', 'alocasia',
  'anthurium', 'begonia', 'coleus', 'croton', 'peperomia', 'pilea',
  'tradescantia', 'string of pearls', 'string of hearts', 'string of',
  'ivy plant', 'ivy plants', 'cebu blue',
  'echeveria', 'sedum', 'sempervivum', 'lithops', 'crassula', 'euphorbia',
  'gasteria', 'portulacaria', 'elephant bush', 'zebra plant', 'bear paw',
  'split rock', 'baby toes', 'cotyledon', 'dolphin plant', 'aeonium',
  'senecio', 'mammillaria', 'opuntia', 'cereus', 'calico kitten', 'haworthia',
  'aloe vera', 'agave', 'tillandsia', // category-level is fine, specific plant is not
]

function isIndividualPlant(keyword) {
  const k = keyword.toLowerCase()
  return INDIVIDUAL_PLANT_TERMS.some(term => k.includes(term))
}

const BRAND_CONTEXT = `Succulents Box (succulentsbox.com) sells:
- Individual succulents, cacti, and houseplants shipped online
- Air plants and air plant terrarium kits
- Succulent gift boxes (occasion-based: birthday, thinking of you, thank you, sympathy, Mother's Day)
- Monthly succulent subscription boxes`

async function callClaude(apiKey, prompt, maxTokens = 1500) {
  // Abort before Netlify's gateway limit so we always return JSON, never an HTML 504 page
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 22000)
  let response
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Claude took too long to respond — please try again')
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
  }
  const data = await response.json()
  const text = data.content[0]?.text || ''
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned)
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const CATEGORIES = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

// Each request does ONE Claude call so it finishes well inside Netlify's function time limit.
//   { mode: 'suggest',   gscKeywords: [...] } -> { suggestedKeywords }
//   { mode: 'headlines', keywords:    [...] } -> { headlineMap }   (send ~10 keywords per call)
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY is not set' })

  let body
  try {
    body = JSON.parse(event.body)
  } catch (err) {
    return json(400, { error: `Bad request: ${err.message}` })
  }

  try {
    if (body.mode === 'suggest') {
      const gscKeywords = body.gscKeywords || []
      const prompt = `${BRAND_CONTEXT}

We already have these buying-intent keywords from Google Search Console:
${gscKeywords.map(k => `- ${k.keyword} (${k.category})`).join('\n') || '(none yet)'}

For each of the 5 product categories below, generate 8 additional high-intent Google Ads keywords that are NOT already in the list above.
Categories: ${CATEGORIES.join(', ')}

Rules:
- Category-level terms only (not individual plant names like "pothos" or "calico kitten")
- Realistic queries people type when ready to buy
- Mix of: product + "buy/for sale/online/delivered", gift occasions, subscription intent
- Only suggest products we actually sell (no cactus subscription box, no air plant subscription)

Respond with ONLY valid JSON:
{"suggested":[{"keyword":"...","category":"..."}]}`

      const result = await callClaude(apiKey, prompt, 1500)
      const suggestedKeywords = (result.suggested || [])
        .filter(k => k.keyword && !isIndividualPlant(k.keyword))
        .map(k => ({
          keyword: k.keyword,
          category: k.category,
          matchType: 'broad',
          source: 'suggested',
          isGapCategory: false,
        }))
      return json(200, { suggestedKeywords })
    }

    if (body.mode === 'headlines') {
      const batch = (body.keywords || []).slice(0, 15)
      if (batch.length === 0) return json(200, { headlineMap: {} })
      const list = batch.map(k => `- ${k.keyword} (${k.category})`).join('\n')
      const prompt = `You write Google Ads headlines for Succulents Box — warm, friendly tone, not salesy.
For each keyword write exactly 3 headlines.
Rules: max 30 characters each, sentence case, no exclamation marks, distinct angles.

Keywords:
${list}

Respond ONLY with valid JSON: {"results":[{"keyword":"...","headlines":["H1","H2","H3"]}]}`

      const result = await callClaude(apiKey, prompt, 1500)
      const headlineMap = {}
      for (const item of (result.results || [])) headlineMap[item.keyword] = item.headlines
      return json(200, { headlineMap })
    }

    return json(400, { error: "Unknown mode — expected 'suggest' or 'headlines'" })
  } catch (err) {
    return json(500, { error: err.message })
  }
}
