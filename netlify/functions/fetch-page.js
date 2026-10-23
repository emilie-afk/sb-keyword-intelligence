// POST { url } -> { page } | { error, code }
// Loads a Succulents Box collection or product page server-side for the Ad Keywords preview.
// Requires an approved member's verified session before anything is fetched.
import { fetchPageInfo, PageError } from '../lib/shopifyPage.js'
import { protectedHandler, HttpError } from '../lib/auth.js'

export const handler = protectedHandler({ maxBodyBytes: 4 * 1024, action: 'fetch_page' }, async (body, { pageFetch }) => {
  if (typeof body.url !== 'string' || body.url.length > 2048) throw new HttpError(400, 'bad_request', 'Paste a Succulents Box collection or product URL.')
  try {
    return { page: await fetchPageInfo(body.url, pageFetch ? { fetchImpl: pageFetch } : undefined) }
  } catch (err) {
    if (err instanceof PageError) throw new HttpError(err.status, err.code, err.message)
    throw new HttpError(500, 'internal', 'Could not load the page.')
  }
})
