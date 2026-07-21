import { useEffect, useRef } from 'react'

export default function SignInPage({ onSignIn, error, setError }) {
  const btnRef = useRef()

  useEffect(() => {
    if (!window.google?.accounts?.id) {
      // GIS script not loaded yet — retry after a short delay
      const timer = setTimeout(() => {
        initSignIn()
      }, 1000)
      return () => clearTimeout(timer)
    }
    initSignIn()
  }, [])

  function initSignIn() {
    if (!window.google?.accounts?.id) return

    window.google.accounts.id.initialize({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      callback: handleCredential,
      auto_select: false,
    })

    window.google.accounts.id.renderButton(btnRef.current, {
      theme: 'outline',
      size: 'large',
      text: 'sign_in_with',
      shape: 'rectangular',
      width: 280,
    })
  }

  function handleCredential(response) {
    setError(null)
    try {
      // Decode the JWT payload (not for security — just to read the email)
      const payload = JSON.parse(atob(response.credential.split('.')[1]))
      const email = payload.email?.toLowerCase()

      const allowed = (import.meta.env.VITE_ALLOWED_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)

      if (allowed.length === 0) {
        // No allowlist set — block everyone as a safety measure
        setError('VITE_ALLOWED_EMAILS is not configured. Add allowed emails to your Netlify environment variables.')
        return
      }

      if (!allowed.includes(email)) {
        setError(`Access denied. ${payload.email} is not on the allowed list.`)
        window.google.accounts.id.disableAutoSelect()
        return
      }

      onSignIn({ email: payload.email, name: payload.given_name || payload.name })
    } catch {
      setError('Sign-in failed. Please try again.')
    }
  }

  return (
    <div className="page-center">
      <div className="connect-card">
        <div className="connect-logo">🌵</div>
        <h1>SB Keyword Intelligence</h1>
        <p className="connect-subtitle">Search performance · Ad keyword generation</p>

        <div style={{ margin: '28px 0 8px', display: 'flex', justifyContent: 'center' }}>
          <div ref={btnRef} />
        </div>

        <p style={{ fontSize: 12, color: '#898781', marginTop: 12 }}>
          Only authorized accounts can sign in.
        </p>

        {error && <div className="error-box" style={{ marginTop: 16 }}>{error}</div>}
      </div>
    </div>
  )
}
