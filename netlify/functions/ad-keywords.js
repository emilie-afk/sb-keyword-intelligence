// POST — generate keywords or headlines for ONE ad group (one Claude call per request).
// See netlify/lib/adKeywords.js for the request/response shapes.
// ANTHROPIC_API_KEY lives server-side only.
import { anthropicCaller, handleRequest, RequestError } from '../lib/adKeywords.js'

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch (err) {
    return json(400, { error: `Bad request: ${err.message}` })
  }

  // 'validate' needs no model; generation does
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey && body?.action !== 'validate') return json(500, { error: 'ANTHROPIC_API_KEY is not set' })
  try {
    return json(200, await handleRequest(body, anthropicCaller(apiKey)))
  } catch (err) {
    return json(err instanceof RequestError ? err.status : 500, { error: err.message })
  }
}
