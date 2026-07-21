// Netlify serverless function — calls Claude to generate ad headlines
// The ANTHROPIC_API_KEY lives here on the server, never exposed to the browser

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

export const handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables' }) }
  }

  let keywords
  try {
    const body = JSON.parse(event.body)
    keywords = body.keywords
    if (!Array.isArray(keywords) || keywords.length === 0) throw new Error('No keywords provided')
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: `Bad request: ${err.message}` }) }
  }

  const SYSTEM_PROMPT = `You are writing Google Ads headlines for Succulents Box, a plant shop that sells succulents, houseplants, air plants, subscription boxes, and gift boxes.
Brand voice: warm, friendly, plant-obsessed. Not salesy.
For each keyword, write exactly 3 headlines. Rules:
- 30 characters or fewer each (Google Ads limit)
- Distinct angles per keyword (value prop, benefit, action)
- Sentence case, no exclamation marks
Respond with ONLY valid JSON: {"results":[{"keyword":"...","headlines":["H1","H2","H3"]}]}`

  // Split into batches of 15 to avoid timeout
  const BATCH_SIZE = 15
  const batches = []
  for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
    batches.push(keywords.slice(i, i + BATCH_SIZE))
  }

  async function callClaude(batch) {
    const keywordList = batch.map(k => `- ${k.keyword} (${k.category})`).join('\n')
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nKeywords:\n${keywordList}` }],
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

  try {
    const batchResults = await Promise.all(batches.map(callClaude))
    const allResults = batchResults.flatMap(r => r.results || [])

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: allResults }),
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    }
  }
}
