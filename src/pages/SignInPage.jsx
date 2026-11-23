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
        <img className="connect-brand-logo" src="data:image/png;base64,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" alt="Succulents Box" width={120} height={14} />
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
