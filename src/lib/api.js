// Client calls to the Netlify functions. Always returns parsed JSON or throws a readable Error,
// even when the server answers with an HTML error page (timeout, password wall, etc.).

export async function callFunction(name, payload, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(`/.netlify/functions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('Network error — check your connection and try again.')
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    if (response.status === 504) throw new Error('The server timed out (504). Please try again.')
    throw new Error(`Unexpected server response (HTTP ${response.status}).`)
  }
  if (!response.ok) {
    const err = new Error(data.error || `Server error (HTTP ${response.status}).`)
    err.code = data.code
    err.status = response.status
    throw err
  }
  return data
}

export const api = {
  fetchPage: url => callFunction('fetch-page', { url }).then(d => d.page),
  validateKeywords: payload => callFunction('ad-keywords', { action: 'validate', ...payload }),
  generateKeywords: payload => callFunction('ad-keywords', { action: 'keywords', ...payload }),
  generateHeadlines: payload => callFunction('ad-keywords', { action: 'headlines', ...payload }),
}

// Run async tasks with bounded concurrency; never rejects — returns per-item outcomes
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { ok: true, value: await worker(items[i], i) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
