// Membership check after sign-in, safe against late and queued work.
//
// Every auth event, check, sign-out or account change takes a new "ticket". Work that belongs to an
// older ticket is dropped wherever it is: a check still waiting for its deferred callback, a pending
// getSession() call, or an app_my_access() answer on its way. So nothing can bring back a signed-in
// screen for a user who has since signed out or switched accounts.
export function createAccessChecker({ getAccess, apply, onDenied = () => {}, onSignedOut = () => {}, defer = fn => setTimeout(fn, 0) }) {
  let generation = 0
  const claim = () => ++generation
  const current = ticket => ticket === generation

  async function run(session, ticket) {
    if (!current(ticket)) return
    if (!session) { apply(() => ({ state: 'signed_out' })); return }
    const u = session.user
    // Keep an already-approved screen for the same user while re-checking (no flicker)
    apply(a => (a.state === 'ready' && a.userId === u.id ? a : { state: 'checking', email: u.email }))
    let access
    try {
      access = await getAccess()
    } catch (err) {
      if (current(ticket)) apply(() => ({ state: 'signed_out', error: err.message }))
      return
    }
    if (!current(ticket)) return // signed out, switched account or re-checked meanwhile
    if (access?.status === 'approved') {
      apply(() => ({ state: 'ready', role: access.role, userId: u.id, email: u.email, name: u.user_metadata?.full_name || u.user_metadata?.name || u.email }))
    } else {
      onDenied()
      apply(() => ({ state: access?.status || 'signed_out', email: u.email }))
    }
  }

  const checker = {
    // Call on sign-out (before clearing state) and whenever the session goes away
    invalidate() { claim() },
    check(session) { return run(session, claim()) },
    // Deferred check: the ticket is taken NOW, when the event arrives, so a sign-out that happens
    // before the callback runs makes the callback a no-op
    schedule(session) {
      const ticket = claim()
      return new Promise(resolve => defer(() => { run(session, ticket).then(resolve, resolve) }))
    },
    // Re-check with whatever session is current; a sign-out during getSession() wins
    async checkCurrent(getSession) {
      const ticket = claim()
      let session = null
      try { session = await getSession() } catch { session = null }
      return run(session, ticket)
    },
    // Supabase onAuthStateChange events
    handleAuthEvent(event, session) {
      if (event === 'SIGNED_OUT') {
        claim()
        onSignedOut()
        apply(() => ({ state: 'signed_out' }))
        return Promise.resolve()
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'USER_UPDATED') return checker.schedule(session)
      return Promise.resolve() // TOKEN_REFRESHED etc.: membership is unchanged
    },
  }
  return checker
}
