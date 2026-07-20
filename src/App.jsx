import { useState } from 'react'
import ConnectPage from './pages/ConnectPage'
import AnalysisPage from './pages/AnalysisPage'
import AdKeywordsPage from './pages/AdKeywordsPage'
import HistoryPage from './pages/HistoryPage'

export default function App() {
  const [page, setPage] = useState('connect')
  const [gscToken, setGscToken] = useState(null)
  const [rawData, setRawData] = useState(null)
  const [uploadMeta, setUploadMeta] = useState(null)
  const [adKeywords, setAdKeywords] = useState(null)

  const handleData = (processed, meta) => {
    setRawData(processed)
    setUploadMeta(meta)
    setAdKeywords(null) // reset keywords on new data load
    setPage('analysis')
  }

  const handleReset = () => {
    setGscToken(null)
    setRawData(null)
    setUploadMeta(null)
    setAdKeywords(null)
    setPage('connect')
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

          {rawData && (
            <button className="btn-ghost" onClick={handleReset}>
              ← New analysis
            </button>
          )}
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
          <AnalysisPage
            data={rawData}
            onGenerateKeywords={(kws) => {
              setAdKeywords(kws)
              setPage('keywords')
            }}
          />
        )}

        {page === 'keywords' && (
          <AdKeywordsPage
            keywords={adKeywords}
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
