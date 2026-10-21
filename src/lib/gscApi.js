// Google Search Console API helper
// The site URL is hardcoded to succulentsbox.com — change here if needed
const SITE_URL = 'sc-domain:succulentsbox.com'
const ENDPOINT = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`

const PAGE_SIZE = 25000 // GSC API maximum per request
export const MAX_ROWS = 100000 // stop paginating here and label the result incomplete

// Typed errors so the UI can show "sign-in expired" / "no permission" instead of "no queries found"
export class GscError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code // 'auth_expired' | 'permission' | 'rate_limited' | 'api' | 'network'
    this.status = status
  }
}

async function toGscError(response) {
  const body = await response.json().catch(() => ({}))
  const detail = body.error?.message || `HTTP ${response.status}`
  if (response.status === 401) return new GscError('auth_expired', 'Google sign-in expired — reconnect Search Console and try again.', 401)
  if (response.status === 403) return new GscError('permission', `This Google account can't read the succulentsbox.com Search Console property (${detail}).`, 403)
  if (response.status === 429) return new GscError('rate_limited', 'Search Console API quota reached — wait a minute and try again.', 429)
  return new GscError('api', `Search Console API error: ${detail}`, response.status)
}

// Run a searchAnalytics query with pagination (startRow) until all rows are read or MAX_ROWS is hit.
// Returns { rows, incomplete } — incomplete = true if the row cap stopped pagination.
export async function queryAllRows(accessToken, body, { fetchImpl = fetch, maxRows = MAX_ROWS, pageSize = PAGE_SIZE } = {}) {
  const rows = []
  for (let startRow = 0; ; startRow += pageSize) {
    let response
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, rowLimit: pageSize, startRow }),
      })
    } catch (err) {
      throw new GscError('network', `Could not reach Search Console: ${err.message}`)
    }
    if (!response.ok) throw await toGscError(response)
    const data = await response.json()
    const batch = (data.rows || []).map(row => ({
      query: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr * 100, // GSC returns 0.0123, we want 1.23
      position: row.position,
    }))
    rows.push(...batch)
    if (batch.length < pageSize) return { rows, incomplete: false }
    if (rows.length >= maxRows) return { rows, incomplete: true }
  }
}

// Site-wide query data for a period. Returns { rows, incomplete }.
export function fetchGSCDataset(accessToken, dateStart, dateEnd, opts) {
  return queryAllRows(accessToken, { startDate: dateStart, endDate: dateEnd, dimensions: ['query'], dataState: 'final' }, opts)
}

// Backwards-compatible: rows only
export async function fetchGSCData(accessToken, dateStart, dateEnd) {
  return (await fetchGSCDataset(accessToken, dateStart, dateEnd)).rows
}

// Get date string N days ago in YYYY-MM-DD format
export function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

// Today's date as YYYY-MM-DD
export function today() {
  return new Date().toISOString().split('T')[0]
}

// Regex (RE2) matching every URL variant of a collection or product page in GSC:
// www/non-www, trailing slash, query strings, and /collections/<c>/products/<h> for products.
export function pageUrlRegex(page) {
  const h = String(page.handle || '').replace(/[^a-z0-9-]/gi, '')
  const host = '^https?://(www\\.)?succulentsbox\\.com'
  if (page.type === 'product') return `${host}/(collections/[^/?#]+/)?products/${h}/?([?#].*)?$`
  return `${host}/collections/${h}/?([?#].*)?$`
}

// Queries that produced impressions for one specific page, for the given reporting period.
// Returns { rows, incomplete }.
export function fetchPageQueries(accessToken, page, period, opts) {
  if (!period?.dateStart || !period?.dateEnd) throw new GscError('api', 'A reporting period is required for page-level data.')
  return queryAllRows(accessToken, {
    startDate: period.dateStart,
    endDate: period.dateEnd,
    dimensions: ['query'],
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: pageUrlRegex(page) }] }],
    dataState: 'final',
  }, opts)
}
