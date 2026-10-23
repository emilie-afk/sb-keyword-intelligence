// Owner-only member management.
//   POST { op: 'list' }                                   -> { members: [...] }
//   POST { op: 'set', email, status: 'approved'|'revoked'|'pending' }
//   POST { op: 'remove', email }                          (only for people who never signed in; use revoke to block)
//   POST { op: 'clear_pending' }                          -> { removed }
// Authorized twice: here (owner session) and in the database functions (app_admin_*), which run
// with the caller's own session — no service-role key is used for member management.
import { protectedHandler, rpc, HttpError } from '../lib/auth.js'

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

async function call(ctx, fn, args) {
  const res = await rpc(ctx.cfg, fn, args, { token: ctx.token, fetchImpl: ctx.fetchImpl })
  if (res.status === 401) throw new HttpError(401, 'session_invalid', 'Your session has expired. Sign in again.')
  if (res.status === 403) throw new HttpError(403, 'not_owner', 'Only the owner can manage members.')
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // Database messages from app_admin_* are written for users (e.g. "The owner cannot be changed")
    const safe = typeof err.message === 'string' && /^(The owner cannot be (changed|removed)|Enter a valid email address|Unknown status)$/.test(err.message)
    throw new HttpError(400, 'member_update_failed', safe ? err.message : 'The member could not be updated.')
  }
  return res.json().catch(() => null)
}

export const handler = protectedHandler({ maxBodyBytes: 4 * 1024, action: 'admin', requireOwner: true }, async (body, ctx) => {
  if (body.op === 'list') return { members: (await call(ctx, 'app_admin_list_members', {})) || [] }
  if (body.op === 'clear_pending') return { removed: (await call(ctx, 'app_admin_clear_pending', {})) || 0 }
  const email = String(body.email || '').trim().toLowerCase()
  if (!EMAIL.test(email)) throw new HttpError(400, 'bad_request', 'Enter a valid email address.')
  if (body.op === 'set') {
    if (!['approved', 'revoked', 'pending'].includes(body.status)) throw new HttpError(400, 'bad_request', 'Unknown status.')
    await call(ctx, 'app_admin_set_member', { p_email: email, p_status: body.status })
    return { ok: true }
  }
  if (body.op === 'remove') {
    await call(ctx, 'app_admin_remove_member', { p_email: email })
    return { ok: true }
  }
  throw new HttpError(400, 'bad_request', 'Unknown operation.')
})
