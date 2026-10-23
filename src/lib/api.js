// Client calls to the Netlify functions. Always returns parsed JSON or throws a readable Error,
// even when the server answers with an HTML error page (timeout, password wall, etc.).

// Every function requires the signed-in user's Supabase access token (verified server-side).
let tokenGetter = async () => null
export const setAuthTokenGetter = fn => { tokenGetter = fn }
// Called when the server says the session is invalid (401) or access was removed (403 not_member)
let onAuthProblem = () => {}
export const setAuthProblemHandler = fn => { onAuthProblem = fn }

export async function callFunction(name, payload, fetchImpl = fetch) {
  let response
  const token = await tokenGetter()
  if (!token) {
    onAuthProblem('signed_out')
    throw new Error('Your session has ended. Please sign in again.')
  }
  try {
    response = await fetchImpl(`/.netlify/functions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    if (response.status === 401) onAuthProblem('session_invalid')
    if (response.status === 403 && data.code === 'not_member') onAuthProblem('not_member')
    const err = new Error(data.error || `Server error (HTTP ${response.status}).`)
    err.code = data.code
    err.status = response.status
    throw err
  }
  return data
}

// An identical model request already in flight is shared instead of sent twice (double clicks, re-renders)
const inflight = new Map()
function once(name, payload) {
  const key = `${name}:${JSON.stringify(payload)}`
  if (!inflight.has(key)) inflight.set(key, callFunction(name, payload).finally(() => inflight.delete(key)))
  return inflight.get(key)
}

export const api = {
  fetchPage: url => callFunction('fetch-page', { url }).then(d => d.page),
  validateKeywords: payload => callFunction('ad-keywords', { action: 'validate', ...payload }),
  generateKeywords: payload => once('ad-keywords', { action: 'keywords', ...payload }),
  generateHeadlines: payload => once('ad-keywords', { action: 'headlines', ...payload }),
  // owner only (enforced by the server and the database)
  members: payload => callFunction('members', payload),
  prompts: payload => callFunction('prompts', payload),
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
