import { useEffect, useMemo, useRef, useState } from 'react'
import SignInPage from './pages/SignInPage'
import ConnectPage from './pages/ConnectPage'
import AnalysisPage from './pages/AnalysisPage'
import AdKeywordsPage from './pages/AdKeywordsPage'
import HistoryPage from './pages/HistoryPage'
import { createStore, newProject, projectFingerprint, datasetRef, datasetKey, uid } from './lib/workspace'
import { fetchGSCDataset, fetchPageQueries, daysAgo, today } from './lib/gscApi'
import { processQueries } from './lib/categorize'

export default function App() {
  const [user, setUser] = useState(null)       // { email, name } once signed in
  const [authError, setAuthError] = useState(null)
  const [page, setPage] = useState('connect')
  const [gscToken, setGscToken] = useState(null)
  const [rawData, setRawData] = useState(null)       // optional GSC queries (site-wide)
  const [uploadMeta, setUploadMeta] = useState(null)
  const [savedUploadId, setSavedUploadId] = useState(null) // set once the GSC analysis is saved
  const [returnTo, setReturnTo] = useState(null)

  // The GSC dataset that keyword generation is built on (required for generation)
  const dataset = useMemo(() => (rawData ? {
    queries: rawData,
    source: uploadMeta?.source || null,
    dateStart: uploadMeta?.dateStart || null,
    dateEnd: uploadMeta?.dateEnd || null,
    incomplete: !!uploadMeta?.incomplete,
    uploadId: savedUploadId,
  } : null), [rawData, uploadMeta, savedUploadId])

  // Page-level queries for one URL. The period is always passed in explicitly (the dataset's own
  // period at the time of the request), so a reload of the dataset can never mix periods.
  const fetchPageRows = gscToken
    ? (page, period) => fetchPageQueries(gscToken, page, period)
    : null

  // Reload the site-wide dataset with a longer period; returns the new dataset or throws
  const extendPeriod = async (days) => {
    if (!gscToken) throw new Error('Connect Search Console to load a longer period.')
    const start = daysAgo(days)
    const end = today()
    const { rows, incomplete } = await fetchGSCDataset(gscToken, start, end)
    const processed = processQueries(rows)
    const meta = { source: 'gsc_api', dateStart: start, dateEnd: end, incomplete }
    setRawData(processed)
    setUploadMeta(meta)
    setSavedUploadId(null)
    return { queries: processed, ...meta, uploadId: null }
  }

  // Keyword project — independent of GSC. A synchronous store keeps async generation consistent.
  const [project, setProjectState] = useState(() => newProject())
  const storeRef = useRef(null)
  if (!storeRef.current) storeRef.current = createStore(project, setProjectState)
  const store = storeRef.current

  // Cancel evidence and generation tied to a replaced dataset, including requests in flight.
  useEffect(() => {
    const key = datasetKey(datasetRef(dataset))
    store.setProject(p => ({ ...p, adGroups: p.adGroups.map(g =>
      g.seedStatus?.dataset && datasetKey(g.seedStatus.dataset) !== key
        ? { ...g, seedStatus: { ...g.seedStatus, state: 'none', requestId: uid('ev') } }
        : g) }))
  }, [dataset, store])

  // "Saved" resets automatically whenever results or settings change
  const [savedFingerprint, setSavedFingerprint] = useState(null)
  const fingerprint = useMemo(() => projectFingerprint(project), [project])
  const projectSaved = savedFingerprint !== null && savedFingerprint === fingerprint

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
    setSavedUploadId(null)
    store.setProject(newProject())
    setSavedFingerprint(null)
    setPage('connect')
  }

  const handleData = (processed, meta, uploadId = null) => {
    setRawData(processed)
    setUploadMeta(meta)
    setSavedUploadId(uploadId)
    setPage(returnTo || 'analysis')
    setReturnTo(null)
  }

  const handleOpenProject = (proj) => {
    store.setProject(proj)
    setSavedFingerprint(projectFingerprint(proj))
    setPage('keywords')
  }

  const handleNewProject = () => {
    store.setProject(newProject())
    setSavedFingerprint(null)
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

  const keywordCount = project.adGroups.reduce((s, g) => s + g.keywords.length, 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <button className="logo-btn" onClick={() => setPage('connect')}>
            🌵 <span>SB Keyword Intelligence</span>
          </button>

          <nav className="nav">
            {rawData && (
              <button className={page === 'analysis' ? 'nav-btn active' : 'nav-btn'} onClick={() => setPage('analysis')}>
                Analysis
              </button>
            )}
            <button className={page === 'keywords' ? 'nav-btn active' : 'nav-btn'} onClick={() => setPage('keywords')}>
              Ad Keywords
              {keywordCount > 0 && <span className="nav-count">{keywordCount}</span>}
            </button>
            <button className={page === 'history' ? 'nav-btn active' : 'nav-btn'} onClick={() => setPage('history')}>
              History
            </button>
          </nav>

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
            onSkip={() => setPage('keywords')}
            hasData={!!rawData}
          />
        )}

        {page === 'analysis' && rawData && (
          <AnalysisPage
            data={rawData}
            uploadMeta={uploadMeta}
            savedUploadId={savedUploadId}
            onSaved={setSavedUploadId}
            onGoToKeywords={() => setPage('keywords')}
          />
        )}

        {page === 'keywords' && (
          <AdKeywordsPage
            project={project}
            store={store}
            dataset={dataset}
            fetchPageRows={fetchPageRows}
            onExtendPeriod={extendPeriod}
            canExtendPeriod={!!gscToken}
            saved={projectSaved}
            onSaved={() => setSavedFingerprint(projectFingerprint(store.getProject()))}
            onNewProject={handleNewProject}
            onGoToConnect={() => { setReturnTo('keywords'); setPage('connect') }}
          />
        )}

        {page === 'history' && (
          <HistoryPage
            onOpenAnalysis={handleData}
            onOpenProject={handleOpenProject}
          />
        )}
      </main>
    </div>
  )
}
