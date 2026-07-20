// Google Search Console API helper
// The site URL is hardcoded to succulentsbox.com — change here if needed
const SITE_URL = 'sc-domain:succulentsbox.com'

// Fetch search analytics data from GSC
// accessToken: the OAuth token from Google sign-in
// dateStart / dateEnd: 'YYYY-MM-DD' strings
export async function fetchGSCData(accessToken, dateStart, dateEnd) {
  const encodedSite = encodeURIComponent(SITE_URL)
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate: dateStart,
      endDate: dateEnd,
      dimensions: ['query'],
      rowLimit: 25000,
      dataState: 'final',
    }),
  })

  if (!response.ok) {
    const err = await response.json()
    // Common error: token expired or wrong site URL
    throw new Error(err.error?.message || `GSC API error: ${response.status}`)
  }

  const data = await response.json()

  // Normalize the response into a flat array of objects
  return (data.rows || []).map(row => ({
    query: row.keys[0],
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr * 100, // GSC returns 0.0123, we want 1.23
    position: row.position,
  }))
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
