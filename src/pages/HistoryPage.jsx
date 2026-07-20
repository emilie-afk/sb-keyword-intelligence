import { useEffect, useState } from 'react'
import { loadHistory, loadUploadQueries, loadUploadKeywords } from '../lib/supabase'
import { downloadKeywordsCSV, downloadQueriesCSV } from '../lib/download'

export default function HistoryPage({ onLoad }) {
  const [uploads, setUploads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanding, setExpanding] = useState(null)

  useEffect(() => {
    loadHistory()
      .then(setUploads)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const handleDownloadKeywords = async (uploadId, label) => {
    setExpanding(uploadId)
    try {
      const kws = await loadUploadKeywords(uploadId)
      const normalized = kws.map(k => ({
        keyword: k.keyword,
        matchType: k.match_type,
        category: k.category,
        source: k.source,
        isGapCategory: k.is_gap_category,
        headlines: [k.headline_1, k.headline_2, k.headline_3].filter(Boolean),
      }))
      downloadKeywordsCSV(normalized)
    } catch (err) {
      alert(`Download failed: ${err.message}`)
    } finally {
      setExpanding(null)
    }
  }

  const handleDownloadQueries = async (uploadId) => {
    setExpanding(uploadId)
    try {
      const qs = await loadUploadQueries(uploadId)
      const normalized = qs.map(q => ({
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
        category: q.category,
        buyingIntent: q.buying_intent,
        isBranded: q.is_branded,
      }))
      downloadQueriesCSV(normalized)
    } catch (err) {
      alert(`Download failed: ${err.message}`)
    } finally {
      setExpanding(null)
    }
  }

  if (loading) return <div className="loading">Loading history…</div>

  return (
    <div className="page">
      <div className="section-header">
        <h2>Analysis history</h2>
        <p className="section-hint">Past GSC analyses saved to Supabase. Download keywords or queries from any run.</p>
      </div>

      {error && <div className="error-box">{error}</div>}

      {uploads.length === 0 && !error && (
        <div className="empty-state">
          <p>No saved analyses yet. Run an analysis and click "Save to Supabase" to see it here.</p>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Source</th>
                <th>Period</th>
                <th className="num">Queries</th>
                <th className="num">Clicks</th>
                <th className="num">Impressions</th>
                <th>Actions</th>
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
                  <td className="period-cell">
                    {u.date_start && u.date_end
                      ? `${u.date_start} → ${u.date_end}`
                      : '—'}
                  </td>
                  <td className="num">{u.rows_count?.toLocaleString()}</td>
                  <td className="num">{u.total_clicks?.toLocaleString()}</td>
                  <td className="num">{u.total_impressions?.toLocaleString()}</td>
                  <td>
                    <div className="action-row">
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => handleDownloadKeywords(u.id)}
                        disabled={expanding === u.id}
                      >
                        ↓ Keywords
                      </button>
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => handleDownloadQueries(u.id)}
                        disabled={expanding === u.id}
                      >
                        ↓ Queries
                      </button>
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
