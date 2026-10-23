// Membership-check races: a late app_my_access() answer must never restore an outdated signed-in screen.
import { describe, it, expect } from 'vitest'
import { createAccessChecker } from '../src/lib/authFlow.js'

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const session = (id, email) => ({ user: { id, email, user_metadata: { full_name: id } } })

function setup() {
  let state = { state: 'loading' }
  const pending = []
  const queued = [] // deferred callbacks waiting to start (setTimeout in the app)
  let denied = 0
  let cleared = 0
  const checker = createAccessChecker({
    getAccess: () => { const d = deferred(); pending.push(d); return d.promise },
    apply: update => { state = update(state) },
    onDenied: () => { denied++ },
    onSignedOut: () => { cleared++ },
    defer: fn => queued.push(fn),
  })
  const flush = () => { while (queued.length) queued.shift()() }
  return { checker, pending, queued, flush, get state() { return state }, get denied() { return denied }, get cleared() { return cleared } }
}

describe('access check races', () => {
  it('approved answer arriving after sign-out is ignored', async () => {
    const t = setup()
    const run = t.checker.check(session('a', 'a@example.test'))
    t.checker.invalidate() // user clicked Sign out
    t.pending[0].resolve({ status: 'approved', role: 'owner' })
    await run
    expect(t.state.state).not.toBe('ready')
  })
  it('answer for the previous account is ignored after switching accounts', async () => {
    const t = setup()
    const first = t.checker.check(session('owner', 'owner@example.test'))
    const second = t.checker.check(session('member', 'member@example.test'))
    t.pending[1].resolve({ status: 'pending' })
    await second
    t.pending[0].resolve({ status: 'approved', role: 'owner' }) // late answer for the old account
    await first
    expect(t.state).toMatchObject({ state: 'pending', email: 'member@example.test' })
  })
  it('a late error does not overwrite a newer result', async () => {
    const t = setup()
    const first = t.checker.check(session('a', 'a@example.test'))
    const second = t.checker.check(session('a', 'a@example.test'))
    t.pending[1].resolve({ status: 'approved', role: 'member' })
    await second
    t.pending[0].reject(new Error('network'))
    await first
    expect(t.state).toMatchObject({ state: 'ready', role: 'member' })
  })
  it('current answers still apply; a denial clears the workspace', async () => {
    const t = setup()
    const ok = t.checker.check(session('a', 'a@example.test'))
    t.pending[0].resolve({ status: 'approved', role: 'member' })
    await ok
    expect(t.state).toMatchObject({ state: 'ready', userId: 'a' })
    const again = t.checker.check(session('a', 'a@example.test'))
    expect(t.state.state).toBe('ready') // no flicker while re-checking the same user
    t.pending[1].resolve({ status: 'revoked' })
    await again
    expect(t.state.state).toBe('revoked')
    expect(t.denied).toBe(1)
  })
  it('no session → signed out', async () => {
    const t = setup()
    await t.checker.check(null)
    expect(t.state.state).toBe('signed_out')
  })

  // ── callbacks still waiting to start ──
  it('sign-out before a queued SIGNED_IN check starts: the check never runs', async () => {
    const t = setup()
    const queuedCheck = t.checker.handleAuthEvent('SIGNED_IN', session('a', 'a@example.test'))
    expect(t.queued).toHaveLength(1) // deferred, not started
    await t.checker.handleAuthEvent('SIGNED_OUT', null)
    t.flush()
    await queuedCheck
    expect(t.pending).toHaveLength(0) // no membership request was even made
    expect(t.state.state).toBe('signed_out')
    expect(t.cleared).toBe(1)
  })
  it('sign-out (button) before a queued INITIAL_SESSION check starts: the old account is not restored', async () => {
    const t = setup()
    const queuedCheck = t.checker.handleAuthEvent('INITIAL_SESSION', session('a', 'a@example.test'))
    t.checker.invalidate() // handleSignOut
    t.flush()
    await queuedCheck
    expect(t.pending).toHaveLength(0)
    expect(t.state.state).not.toBe('ready')
  })
  it('account switch while an older check is still queued: only the newest account counts', async () => {
    const t = setup()
    const a = t.checker.handleAuthEvent('SIGNED_IN', session('a', 'a@example.test'))
    const b = t.checker.handleAuthEvent('SIGNED_IN', session('b', 'b@example.test'))
    t.flush()
    expect(t.pending).toHaveLength(1)
    t.pending[0].resolve({ status: 'approved', role: 'member' })
    await Promise.all([a, b])
    expect(t.state).toMatchObject({ state: 'ready', userId: 'b' })
  })
  it('sign-out while checkCurrent() is waiting for the session: nothing is restored', async () => {
    const t = setup()
    const s = deferred()
    const run = t.checker.checkCurrent(() => s.promise)
    await t.checker.handleAuthEvent('SIGNED_OUT', null)
    s.resolve(session('a', 'a@example.test')) // the session read finished before sign-out cleared it
    await run
    expect(t.pending).toHaveLength(0)
    expect(t.state.state).toBe('signed_out')
  })
  it('token refreshes do not trigger checks', async () => {
    const t = setup()
    await t.checker.handleAuthEvent('TOKEN_REFRESHED', session('a', 'a@example.test'))
    expect(t.queued).toHaveLength(0)
  })
})
