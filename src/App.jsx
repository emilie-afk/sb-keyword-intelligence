import { useState } from 'react'
import SignInPage from './pages/SignInPage'
import ConnectPage from './pages/ConnectPage'
import AnalysisPage from './pages/AnalysisPage'
import AdKeywordsPage from './pages/AdKeywordsPage'
import HistoryPage from './pages/HistoryPage'
import { buildCategoryStats } from './lib/categorize'
import { buildAdKeywords } from './lib/generateKeywords'


export default function App() {
  const [user, setUser] = useState(null)       // { email, name } once signed in
  const [authError, setAuthError] = useState(null)
  const [page, setPage] = useState('connect')
  const [gscToken, setGscToken] = useState(null)
  const [rawData, setRawData] = useState(null)
  const [uploadMeta, setUploadMeta] = useState(null)
  const [adKeywords, setAdKeywords] = useState(null)

  const handleSignIn = (userInfo) => {
    setUser(userInfo)
    setAuthError(null)
  }

  const handleSignOut = () => {
    window.google?.accounts?.id?.disableAutoSelect()
    setUser(null)
    setGscToken(null)
    setRawData(null)
    setUploadMeta(null)
    setAdKeywords(null)
    setPage('connect')
  }

  const handleData = (processed, meta) => {
    const stats = buildCategoryStats(processed)
    const keywords = buildAdKeywords(processed, stats)
    setRawData(processed)
    setUploadMeta(meta)
    setAdKeywords(keywords) // keywords ready immediately, no Claude call needed
    setPage('analysis')
  }

  const handleReset = () => {
    setGscToken(null)
    setRawData(null)
    setUploadMeta(null)
    setAdKeywords(null)
    setPage('connect')
  }

  // Show sign-in screen until authenticated
  if (!user) {
    return (
      <SignInPage
        onSignIn={handleSignIn}
        error={authError}
        setError={setAuthError}
      />
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <button className="logo-btn" onClick={handleReset}>
            🌵 <span>SB Keyword Intelligence</span>
          </button>

          {rawData && (
            <nav className="nav">
              <button
                className={page === 'analysis' ? 'nav-btn active' : 'nav-btn'}
                onClick={() => setPage('analysis')}
              >
                Analysis
              </button>
              <button
                className={page === 'keywords' ? 'nav-btn active' : 'nav-btn'}
                onClick={() => setPage('keywords')}
              >
                Ad Keywords
                {adKeywords && <span className="nav-count">{adKeywords.filter(k => k.matchType === 'broad').length}</span>}
              </button>
              <button
                className={page === 'history' ? 'nav-btn active' : 'nav-btn'}
                onClick={() => setPage('history')}
              >
                History
              </button>
            </nav>
          )}

          {!rawData && (
            <button className="nav-btn" onClick={() => setPage('history')}>
              History
            </button>
          )}

          <div className="user-row">
            <span className="user-name">{user.name}</span>
            <button className="btn-ghost" onClick={handleSignOut}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="main">
        {page === 'connect' && (
          <ConnectPage
            gscToken={gscToken}
            onConnect={setGscToken}
            onData={handleData}
          />
        )}

        {page === 'analysis' && rawData && (
          <AnalysisPage data={rawData} />
        )}

        {page === 'keywords' && (
          <AdKeywordsPage
            keywords={adKeywords}
            setKeywords={setAdKeywords}
            rawData={rawData}
            uploadMeta={uploadMeta}
          />
        )}

        {page === 'history' && (
          <HistoryPage
            onLoad={(data) => {
              setRawData(data)
              setPage('analysis')
            }}
          />
        )}
      </main>
    </div>
  )
}
