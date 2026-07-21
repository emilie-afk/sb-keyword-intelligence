// Netlify serverless function
// Step 1: Generate additional buying-intent keywords for all categories
// Step 2: Write headlines for all keywords (GSC + generated)
// ANTHROPIC_API_KEY lives server-side, never exposed to the browser

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

const BRAND_CONTEXT = `Succulents Box (succulentsbox.com) sells:
- Individual succulents, cacti, and houseplants shipped online
- Air plants and air plant terrarium kits
- Succulent gift boxes (occasion-based: birthday, thinking of you, thank you, sympathy, Mother's Day)
- Monthly succulent subscription boxes`

async function callClaude(apiKey, prompt, maxTokens = 2048) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
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
  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
  }
  const data = await response.json()
  const text = data.content[0]?.text || ''
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  return JSON.parse(cleaned)
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set' }) }
  }

  let gscKeywords
  try {
    const body = JSON.parse(event.body)
    gscKeywords = body.gscKeywords || []
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: `Bad request: ${err.message}` }) }
  }

  const CATEGORIES = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

  try {
    // Step 1: Generate 8 additional buying-intent keywords per category
    // These supplement what GSC already found
    const keywordGenPrompt = `${BRAND_CONTEXT}

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

    const genResult = await callClaude(apiKey, keywordGenPrompt, 2000)
    const suggestedKeywords = (genResult.suggested || []).map(k => ({
      keyword: k.keyword,
      category: k.category,
      matchType: 'broad',
      source: 'suggested',
      isGapCategory: false,
    }))

    // Step 2: Generate headlines for all keywords (GSC broad + suggested)
    const allBroad = [...gscKeywords, ...suggestedKeywords]
    const BATCH_SIZE = 15
    const batches = []
    for (let i = 0; i < allBroad.length; i += BATCH_SIZE) {
      batches.push(allBroad.slice(i, i + BATCH_SIZE))
    }

    const headlinePromptFor = (batch) => {
      const list = batch.map(k => `- ${k.keyword} (${k.category})`).join('\n')
      return `You write Google Ads headlines for Succulents Box — warm, friendly tone, not salesy.
For each keyword write exactly 3 headlines.
Rules: max 30 characters each, sentence case, no exclamation marks, distinct angles.

Keywords:
${list}

Respond ONLY with valid JSON: {"results":[{"keyword":"...","headlines":["H1","H2","H3"]}]}`
    }

    const batchResults = await Promise.all(batches.map(b => callClaude(apiKey, headlinePromptFor(b), 2048)))
    const headlineMap = {}
    for (const r of batchResults) {
      for (const item of (r.results || [])) {
        headlineMap[item.keyword] = item.headlines
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestedKeywords, headlineMap }),
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    }
  }
}
