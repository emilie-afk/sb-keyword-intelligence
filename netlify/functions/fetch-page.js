// POST { url } -> { page } | { error, code }
// Loads a Succulents Box collection or product page server-side for the Ad Keywords preview.
import { fetchPageInfo, PageError } from '../lib/shopifyPage.js'

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  let url
  try {
    url = JSON.parse(event.body || '{}').url
  } catch {
    return json(400, { error: 'Bad request', code: 'bad_request' })
  }
  try {
    const page = await fetchPageInfo(url)
    return json(200, { page })
  } catch (err) {
    if (err instanceof PageError) return json(err.status, { error: err.message, code: err.code })
    return json(500, { error: 'Could not load the page.', code: 'internal' })
  }
}
