import { useState } from 'react'
import { downloadKeywordsCSV, downloadCategoryCSV } from '../lib/download'
import { saveAnalysis } from '../lib/supabase'

const ORDERED_CATS = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants']

const CATEGORY_COLORS = {
  Succulents: '#2a78d6',
  Houseplants: '#e87ba4',
  'Succulent Subscription': '#008300',
  'Gift Boxes': '#eda100',
  'Air Plants': '#1baf7a',
}

const MATCH_TYPE_LABELS = {
  broad: { label: 'Broad', color: '#888780' },
  phrase: { label: 'Phrase', color: '#2a78d6' },
  exact: { label: 'Exact', color: '#008300' },
}

export default function AdKeywordsPage({ keywords, rawData, uploadMeta }) {
  const [catFilter, setCatFilter] = useState('All')
  const [matchFilter, setMatchFilter] = useState('All')
  const [sourceFilter, setSourceFilter] = useState('All')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(null)

  if (!keywords || keywords.length === 0) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>No keywords generated yet. Go to Analysis and click "Generate Ad Keywords".</p>
        </div>
      </div>
    )
  }

  const filtered = keywords.filter(kw => {
    if (catFilter !== 'All' && kw.category !== catFilter) return false
    if (matchFilter !== 'All' && kw.matchType !== matchFilter.toLowerCase()) return false
    if (sourceFilter === 'From GSC' && kw.source !== 'from_gsc') return false
    if (sourceFilter === 'Suggested' && kw.source !== 'suggested') return false
    return true
  })

  const gapCats = ORDERED_CATS.filter(cat =>
    keywords.some(k => k.category === cat && k.isGapCategory)
  )

  // Summary: unique base keywords per category (broad only)
  const uniqueByCategory = {}
  for (const cat of ORDERED_CATS) {
    uniqueByCategory[cat] = keywords.filter(k => k.category === cat && k.matchType === 'broad').length
  }

  const handleSaveToSupabase = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await saveAnalysis({
        queries: rawData,
        adKeywords: keywords,
        dateStart: uploadMeta?.dateStart,
        dateEnd: uploadMeta?.dateEnd,
        source: uploadMeta?.source || 'unknown',
      })
      setSaved(true)
    } catch (err) {
      setSaveError(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">

      {/* Summary cards */}
      <div className="stats-row">
        {ORDERED_CATS.map(cat => (
          <div key={cat} className={`stat-card ${gapCats.includes(cat) ? 'stat-card-gap' : ''}`}>
            <div className="stat-label" style={{ color: CATEGORY_COLORS[cat] }}>{cat}</div>
            <div className="stat-value">{uniqueByCategory[cat]}</div>
            <div className="stat-sub">keywords{gapCats.includes(cat) ? ' · gap ⚠' : ''}</div>
          </div>
        ))}
      </div>

      {/* Gap category explanation */}
      {gapCats.length > 0 && (
        <div className="alert-gap">
          <strong>Gap categories ({gapCats.join(', ')}):</strong> These have low organic buying-intent data, so suggested keywords were added to fill them out. They're marked "Suggested" in the Source column.
        </div>
      )}

      {/* Actions */}
      <div className="section-header">
        <h2>Ad keywords — {keywords.filter(k => k.matchType === 'broad').length} unique keywords · {keywords.length} total with match types</h2>
        <div className="filter-row">
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}>
            <option>All</option>
            {ORDERED_CATS.map(c => <option key={c}>{c}</option>)}
          </select>
          <select value={matchFilter} onChange={e => setMatchFilter(e.target.value)}>
            <option>All</option>
            <option>Broad</option>
            <option>Phrase</option>
            <option>Exact</option>
          </select>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
            <option>All</option>
            <option>From GSC</option>
            <option>Suggested</option>
          </select>
          <button className="btn-secondary btn-sm" onClick={() => downloadKeywordsCSV(keywords)}>↓ Download all</button>
          {catFilter !== 'All' && (
            <button className="btn-secondary btn-sm" onClick={() => downloadCategoryCSV(keywords, catFilter)}>
              ↓ Download {catFilter}
            </button>
          )}
        </div>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Category</th>
              <th>Match type</th>
              <th>Source</th>
              <th>Headline 1</th>
              <th>Headline 2</th>
              <th>Headline 3</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 300).map((kw, i) => {
              const mt = MATCH_TYPE_LABELS[kw.matchType] || {}
              return (
                <tr key={i} className={kw.isGapCategory ? 'row-gap' : ''}>
                  <td className="keyword-cell">{kw.keyword}</td>
                  <td>
                    <span className="cat-badge"
                      style={{ background: (CATEGORY_COLORS[kw.category] || '#888') + '22', color: CATEGORY_COLORS[kw.category] || '#888' }}>
                      {kw.category}
                    </span>
                  </td>
                  <td>
                    <span className="match-badge" style={{ color: mt.color }}>
                      {mt.label}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${kw.source === 'suggested' ? 'badge-suggested' : 'badge-gsc'}`}>
                      {kw.source === 'suggested' ? 'Suggested' : 'From GSC'}
                    </span>
                  </td>
                  <td className="headline-cell">{kw.headlines?.[0] || '—'}</td>
                  <td className="headline-cell">{kw.headlines?.[1] || '—'}</td>
                  <td className="headline-cell">{kw.headlines?.[2] || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length > 300 && <p className="table-hint">Showing 300 of {filtered.length} rows. Download CSV for full list.</p>}
      </div>

      {/* Save to Supabase */}
      <div className="save-section">
        {saved
          ? <p className="status-success">✓ Saved to Supabase — available in the content engine</p>
          : (
            <>
              <button className="btn-primary" onClick={handleSaveToSupabase} disabled={saving}>
                {saving ? 'Saving…' : '↑ Save to Supabase'}
              </button>
              <p className="cta-hint">Saves this analysis and keyword list to your database so it's available in the content engine and in History.</p>
            </>
          )
        }
        {saveError && <div className="error-box">{saveError}</div>}
      </div>

    </div>
  )
}
