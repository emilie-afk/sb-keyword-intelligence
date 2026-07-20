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

  // Build a structured prompt for Claude
  // We send all keywords in one batch to minimize API calls
  const keywordList = keywords
    .map(k => `- ${k.keyword} (category: ${k.category})`)
    .join('\n')

  const prompt = `You are writing Google Ads headlines for Succulents Box, a subscription and plant shop that sells succulents, houseplants, air plants, succulent subscription boxes, and gift boxes.

Brand voice: warm, friendly, plant-obsessed. Not salesy. Focus on joy of plants, easy care, beautiful plants delivered.

For each keyword below, write exactly 3 Google Ads headlines.
Rules:
- Each headline must be 30 characters or fewer (Google Ads limit)
- Headlines should be distinct from each other (different angles: value prop, urgency, benefit)
- Sentence case only
- No exclamation marks
- Make them compelling but natural

Keywords:
${keywordList}

Respond with ONLY valid JSON in this exact format, no other text:
{
  "results": [
    {
      "keyword": "exact keyword from input",
      "headlines": ["Headline one", "Headline two", "Headline three"]
    }
  ]
}`

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast + cheap for structured output
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    const text = data.content[0]?.text || ''

    // Parse the JSON response from Claude
    let parsed
    try {
      // Handle cases where Claude wraps JSON in markdown code blocks
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      throw new Error('Claude returned invalid JSON. Try again.')
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    }
  }
}
