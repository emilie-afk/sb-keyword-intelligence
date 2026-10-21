import { useEffect, useState } from 'react'
import {
  loadHistory, loadUploadQueries, loadUploadKeywords, loadProjects, loadProject, normalizeKeywordRow,
} from '../lib/supabase'
import { downloadKeywordRows, downloadQueriesCSV } from '../lib/download'
import { deserializeProject } from '../lib/workspace'
import { processQueries } from '../lib/categorize'

const MODE_LABELS = { category: 'By category', collection: 'Collection page', product: 'Product page' }

export default function HistoryPage({ onOpenAnalysis, onOpenProject }) {
  const [uploads, setUploads] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [projectsError, setProjectsError] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    Promise.allSettled([loadHistory(), loadProjects()]).then(([u, p]) => {
      if (u.status === 'fulfilled') setUploads(u.value)
      else setError(u.reason?.message)
      if (p.status === 'fulfilled') setProjects(p.value)
      // Before the migration is applied the table doesn't exist — keep analyses usable
      else setProjectsError(p.reason?.message)
      setLoading(false)
    })
  }, [])

  const run = async (id, fn) => {
    setBusy(id)
    try { await fn() } catch (err) { alert(`Failed: ${err.message}`) } finally { setBusy(null) }
  }

  const handleOpenProject = (id) => run(id, async () => {
    const row = await loadProject(id)
    onOpenProject(deserializeProject(row))
  })

  const handleOpenAnalysis = (u) => run(u.id, async () => {
    const qs = await loadUploadQueries(u.id)
    const processed = processQueries(qs.map(q => ({
      query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position,
    })))
    onOpenAnalysis(processed, { source: u.source, dateStart: u.date_start, dateEnd: u.date_end }, u.id)
  })

  const handleDownloadKeywords = (uploadId) => run(uploadId, async () => {
    const kws = await loadUploadKeywords(uploadId)
    downloadKeywordRows(kws.map(normalizeKeywordRow), 'analysis')
  })

  const handleDownloadQueries = (uploadId) => run(uploadId, async () => {
    const qs = await loadUploadQueries(uploadId)
    downloadQueriesCSV(qs.map(q => ({
      query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position,
      category: q.category, buyingIntent: q.buying_intent, isBranded: q.is_branded,
    })))
  })

  if (loading) return <div className="loading">Loading history…</div>

  return (
    <div className="page">
      {/* Keyword projects */}
      <div className="section-header">
        <div>
          <h2>Keyword projects</h2>
          <p className="section-hint">Saved Ad Keywords workspaces. Reopen one to keep editing or generating.</p>
        </div>
      </div>
      {projectsError && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          Keyword projects aren't available yet ({projectsError}). The database migration in supabase/migrations may not be applied.
        </div>
      )}
      {!projectsError && projects.length === 0 && (
        <div className="empty-state"><p>No saved keyword projects yet.</p></div>
      )}
      {projects.length > 0 && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Updated</th><th>Project</th><th>Mode</th><th>Scope</th>
                <th className="num">Ad groups</th><th className="num">Keywords</th><th>GSC period</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id}>
                  <td>{new Date(p.updated_at || p.created_at).toLocaleDateString()}</td>
                  <td>
                    {p.name}
                    {p.save_status !== 'complete' && (
                      <span className="badge badge-gap" style={{ marginLeft: 8 }} title="The last save did not finish. Reopen and save again.">
                        Incomplete save
                      </span>
                    )}
                  </td>
                  <td>{MODE_LABELS[p.mode] || p.mode}</td>
                  <td className="period-cell" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[...(p.selected_categories || []), ...(p.page_urls || []).map(u => u.replace('https://succulentsbox.com', ''))].join(', ') || '—'}
                  </td>
                  <td className="num">{p.ad_group_count}</td>
                  <td className="num">{p.keyword_count}</td>
                  <td className="period-cell">{p.gsc_date_start && p.gsc_date_end ? `${p.gsc_date_start} → ${p.gsc_date_end}` : p.gsc_source ? 'GSC (no dates)' : '—'}</td>
                  <td>
                    <button className="btn-secondary btn-sm" onClick={() => handleOpenProject(p.id)} disabled={busy === p.id}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* GSC analyses (existing history) */}
      <div className="section-header" style={{ marginTop: 32 }}>
        <div>
          <h2>Analysis history</h2>
          <p className="section-hint">Past GSC analyses saved to Supabase. Open one, or download its keywords or queries.</p>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {uploads.length === 0 && !error && (
        <div className="empty-state">
          <p>No saved analyses yet. Load GSC data and click "Save analysis to Supabase" on the Analysis tab.</p>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Source</th><th>Period</th>
                <th className="num">Queries</th><th className="num">Clicks</th><th className="num">Impressions</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map(u => (
                <tr key={u.id}>
                  <td>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <span className={`badge ${u.source === 'gsc_api' ? 'badge-gsc' : 'badge-suggested'}`}>
                      {u.source === 'gsc_api' ? 'GSC API' : 'CSV upload'}
                    </span>
                  </td>
                  <td className="period-cell">{u.date_start && u.date_end ? `${u.date_start} → ${u.date_end}` : '—'}</td>
                  <td className="num">{u.rows_count?.toLocaleString()}</td>
                  <td className="num">{u.total_clicks?.toLocaleString()}</td>
                  <td className="num">{u.total_impressions?.toLocaleString()}</td>
                  <td>
                    <div className="action-row">
                      <button className="btn-secondary btn-sm" onClick={() => handleOpenAnalysis(u)} disabled={busy === u.id}>Open</button>
                      <button className="btn-secondary btn-sm" onClick={() => handleDownloadKeywords(u.id)} disabled={busy === u.id}>↓ Keywords</button>
                      <button className="btn-secondary btn-sm" onClick={() => handleDownloadQueries(u.id)} disabled={busy === u.id}>↓ Queries</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
