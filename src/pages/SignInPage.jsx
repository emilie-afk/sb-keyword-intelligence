import { useState } from 'react'
import { signInWithGoogle, signOut } from '../lib/supabase'

// Sign-in is handled by Supabase Auth (Google provider). The browser never decides who has access:
// the database checks the verified account against the member list on every request.
const MESSAGES = {
  pending: ['Waiting for approval', 'Your access request was sent. The owner needs to approve it before you can use the app.'],
  revoked: ['Access removed', 'Your access to this app was removed. Ask the owner if you think this is a mistake.'],
  unverified: ['Email not verified', 'This account has no verified email address, so it cannot be approved.'],
  conflict: ['Account mismatch', 'This email is already linked to a different sign-in. Ask the owner for help.'],
  email_changed: ['Account changed', 'The email on this account changed since it was approved. Ask the owner to approve it again.'],
  closed: ['Requests closed', 'Too many access requests are waiting. Ask the owner directly.'],
  not_configured: ['Not configured', 'Sign-in is not configured for this site (Supabase settings are missing).'],
}

export default function SignInPage({ state = 'signed_out', email, error }) {
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState(null)
  const message = MESSAGES[state]

  const start = async () => {
    setBusy(true)
    setStartError(null)
    try {
      await signInWithGoogle() // redirects to Google, then back here
    } catch (err) {
      setStartError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="page-center">
      <div className="connect-card">
        <div className="connect-logo">🌵</div>
        <h1>SB Keyword Intelligence</h1>
        <p className="connect-subtitle">Search performance · Ad keyword generation</p>

        {state === 'checking' && <p style={{ marginTop: 24 }}>Checking your access…</p>}

        {message && (
          <div className={state === 'pending' ? 'status-box' : 'error-box'} style={{ marginTop: 24, textAlign: 'left' }}>
            <strong>{message[0]}</strong>
            <div>{message[1]}</div>
            {email && <div style={{ marginTop: 6, color: '#5f5e5a' }}>Signed in as {email}</div>}
          </div>
        )}

        {state === 'signed_out' && (
          <div style={{ margin: '28px 0 8px', display: 'flex', justifyContent: 'center' }}>
            <button className="btn-primary" onClick={start} disabled={busy}>{busy ? 'Opening Google…' : 'Sign in with Google'}</button>
          </div>
        )}
        {message && state !== 'not_configured' && (
          <button className="btn-ghost" style={{ marginTop: 16 }} onClick={() => signOut()}>Sign out</button>
        )}

        <p style={{ fontSize: 12, color: '#898781', marginTop: 12 }}>
          Only approved team members can use this app.
        </p>

        {(error || startError) && <div className="error-box" style={{ marginTop: 16 }}>{error || startError}</div>}
      </div>
    </div>
  )
}
