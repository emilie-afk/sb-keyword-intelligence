import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { fetchGSCData, daysAgo, today } from '../lib/gscApi'
import { processQueries } from '../lib/categorize'

// Date range presets
const DATE_PRESETS = [
  { label: 'Last 28 days', days: 28 },
  { label: 'Last 3 months', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last 12 months', days: 365 },
]

export default function ConnectPage({ onConnect, onData, gscToken }) {
  const [dateRange, setDateRange] = useState(180)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [authStep, setAuthStep] = useState('idle') // idle | authorizing | authorized
  const fileInputRef = useRef()

  // Trigger Google OAuth popup to get a Search Console access token
  const handleGoogleConnect = () => {
    if (!window.google?.accounts?.oauth2) {
      setError('Google Sign-In is still loading. Please wait a moment and try again.')
      return
    }

    setAuthStep('authorizing')
    setError(null)

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      callback: (response) => {
        if (response.error) {
          setError(`Google authorization failed: ${response.error}`)
          setAuthStep('idle')
          return
        }
        setAuthStep('authorized')
        onConnect(response.access_token)
      },
    })

    client.requestAccessToken()
  }

  // Fetch data from GSC after authorization
  const handleFetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const endDate = today()
      const startDate = daysAgo(dateRange)
      const raw = await fetchGSCData(gscToken, startDate, endDate)
      if (raw.length === 0) {
        setError('No data returned. Make sure the Google account has access to the succulentsbox.com property in Search Console.')
        setLoading(false)
        return
      }
      const processed = processQueries(raw)
      onData(processed, { source: 'gsc_api', dateStart: startDate, dateEnd: endDate })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Parse an uploaded GSC CSV file
  const handleCSVUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setLoading(true)
    setError(null)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const raw = results.data.map(row => ({
            query: row['Top queries'] || row['Query'] || row['query'] || '',
            clicks: parseInt(row['Clicks'] || row['clicks'] || 0),
            impressions: parseInt(row['Impressions'] || row['impressions'] || 0),
            ctr: parseFloat((row['CTR'] || row['ctr'] || '0').replace('%', '')),
            position: parseFloat(row['Position'] || row['position'] || 0),
          })).filter(r => r.query)

          if (raw.length === 0) throw new Error('No valid rows found. Make sure this is a Search Console CSV export.')

          const processed = processQueries(raw)
          onData(processed, { source: 'csv_upload', dateStart: null, dateEnd: null })
        } catch (err) {
          setError(err.message)
          setLoading(false)
        }
      },
      error: (err) => {
        setError(`CSV parse error: ${err.message}`)
        setLoading(false)
      },
    })
  }

  return (
    <div className="page-center">
      <div className="connect-card">
        <div className="connect-logo">🌵</div>
        <h1>SB Keyword Intelligence</h1>
        <p className="connect-subtitle">Search performance analysis + ad keyword generation for Succulents Box</p>

        {/* GSC API Option */}
        <div className="connect-section">
          <h2>Connect Google Search Console</h2>
          <p>Pulls live data directly from your Search Console property.</p>

          {authStep === 'idle' && (
            <button className="btn-primary btn-google" onClick={handleGoogleConnect}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          )}

          {authStep === 'authorizing' && (
            <p className="status-text">Waiting for Google authorization…</p>
          )}

          {authStep === 'authorized' && (
            <div className="authorized-section">
              <p className="status-success">✓ Connected to succulentsbox.com</p>
              <div className="date-range-row">
                <label>Date range:</label>
                <select value={dateRange} onChange={e => setDateRange(Number(e.target.value))}>
                  {DATE_PRESETS.map(p => (
                    <option key={p.days} value={p.days}>{p.label}</option>
                  ))}
                </select>
              </div>
              <button className="btn-primary" onClick={handleFetchData} disabled={loading}>
                {loading ? 'Fetching data…' : 'Fetch Search Data'}
              </button>
            </div>
          )}
        </div>

        <div className="divider">or</div>

        {/* CSV Upload Option */}
        <div className="connect-section">
          <h2>Upload Search Console CSV</h2>
          <p>Export from Search Console → Performance → Export → CSV, then upload here.</p>
          <button className="btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            {loading ? 'Processing…' : 'Choose CSV file'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleCSVUpload}
            style={{ display: 'none' }}
          />
        </div>

        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  )
}
