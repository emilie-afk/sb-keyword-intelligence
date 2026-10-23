// Verified session + membership gate for every protected Netlify Function.
//
// The browser sends its Supabase Auth access token (Authorization: Bearer <jwt>). We never decode
// or trust it here: it is passed to Supabase, whose API verifies the signature and expiry, and the
// database function app_authorize() checks — on every request, without caching — that the user is
// an approved member (or the owner), has a confirmed email, and is within the durable daily limit.
// Nothing the client sends (email, role, user id) is used for authorization.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const AUTH_TIMEOUT_MS = 5000
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function supabaseConfig(env = process.env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '',
  }
}

export function bearerToken(headers = {}) {
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || ''
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw).trim())
  if (!m || m[1].length > 8192 || !JWT_SHAPE.test(m[1])) return null
  return m[1]
}

// Call a Supabase RPC as the signed-in user (token) or as the server (service key)
export async function rpc(cfg, fn, args, { token, service = false, fetchImpl = fetch, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  const key = service ? cfg.serviceKey : cfg.anonKey
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { apikey: key, Authorization: `Bearer ${service ? cfg.serviceKey : token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    })
  } catch {
    throw new HttpError(503, 'auth_unavailable', 'The sign-in service is unavailable. Please try again.')
  } finally {
    clearTimeout(timer)
  }
}

const DENIED = {
  unauthenticated: [401, 'Sign in to continue.'],
  not_member: [403, 'Your account is not approved for this app. Ask the owner for access.'],
  not_owner: [403, 'Only the owner can do this.'],
  rate_limited: [429, 'Daily limit reached for this action. Try again tomorrow or ask the owner to raise it.'],
  unknown_action: [500, 'This action is not configured.'],
}

// Returns { userId, role, token } or throws HttpError. One database round trip per request.
export async function authorize(headers, { action, requireOwner = false }, { env = process.env, fetchImpl = fetch } = {}) {
  const cfg = supabaseConfig(env)
  if (!cfg.url || !cfg.anonKey) throw new HttpError(503, 'not_configured', 'Sign-in is not configured on the server.')
  const token = bearerToken(headers)
  if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.')

  const res = await rpc(cfg, 'app_authorize', { p_action: action, p_require_owner: requireOwner }, { token, fetchImpl })
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, 'session_invalid', 'Your session has expired or is invalid. Sign in again.')
  }
  if (!res.ok) throw new HttpError(503, 'auth_unavailable', 'The sign-in service is unavailable. Please try again.')
  const result = await res.json().catch(() => null)
  if (!result || typeof result !== 'object') throw new HttpError(503, 'auth_unavailable', 'The sign-in service is unavailable. Please try again.')
  if (result.allowed !== true) {
    const [status, message] = DENIED[result.code] || [403, 'Access denied.']
    throw new HttpError(status, result.code || 'denied', message)
  }
  return { userId: result.user_id, role: result.role, token, cfg }
}

// ── Function wrapper: method, body size, JSON, auth — before any handler work ──
export const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
})

export function protectedHandler({ methods = ['POST'], maxBodyBytes = 64 * 1024, action, requireOwner = false }, handle) {
  return async (event, _context, deps = {}) => {
    if (!methods.includes(event.httpMethod)) return jsonResponse(405, { error: 'Method not allowed' })
    const raw = event.body || ''
    const size = event.isBase64Encoded ? Math.ceil(raw.length * 3 / 4) : Buffer.byteLength(raw)
    if (size > maxBodyBytes) return jsonResponse(413, { error: 'Request too large.', code: 'too_large' })
    let body = {}
    if (event.httpMethod !== 'GET') {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString() : raw || '{}')
      } catch {
        return jsonResponse(400, { error: 'Bad request.', code: 'bad_request' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { error: 'Bad request.', code: 'bad_request' })
    }
    let auth
    try {
      const act = typeof action === 'function' ? action(body, event) : action
      if (!act) return jsonResponse(400, { error: 'Unknown action.', code: 'bad_request' })
      auth = await authorize(event.headers || {}, { action: act, requireOwner }, deps)
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message, code: err.code })
      return jsonResponse(503, { error: 'The sign-in service is unavailable. Please try again.', code: 'auth_unavailable' })
    }
    try {
      return jsonResponse(200, await handle(body, { ...auth, event, env: deps.env || process.env, fetchImpl: deps.fetchImpl || fetch, ...deps }))
    } catch (err) {
      if (err instanceof HttpError || (err?.status && err?.expose)) {
        return jsonResponse(err.status, { error: err.message, code: err.code })
      }
      console.error(`[${typeof action === 'string' ? action : 'request'}] failed:`, err?.name || 'Error')
      return jsonResponse(500, { error: 'Something went wrong. Please try again.', code: 'internal' })
    }
  }
}
