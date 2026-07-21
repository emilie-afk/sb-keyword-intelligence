import { useEffect, useRef, useState } from 'react'
import { Chart } from 'chart.js/auto'
import { buildCategoryStats } from '../lib/categorize'
import { downloadQueriesCSV } from '../lib/download'

const CATEGORY_COLORS = {
  Succulents: '#2a78d6',
  Houseplants: '#e87ba4',
  'Succulent Subscription': '#008300',
  'Gift Boxes': '#eda100',
  'Air Plants': '#1baf7a',
  Branded: '#888780',
  Other: '#b4b2a9',
}

const ORDERED_CATS = ['Succulents', 'Houseplants', 'Succulent Subscription', 'Gift Boxes', 'Air Plants', 'Branded']

export default function AnalysisPage({ data }) {
  const [stats, setStats] = useState(null)
  const [filter, setFilter] = useState('all')
  const [catFilter, setCatFilter] = useState('All')
  const buyingChartRef = useRef()
  const infoChartRef = useRef()
  const buyingChartInstance = useRef()
  const infoChartInstance = useRef()

  useEffect(() => {
    const s = buildCategoryStats(data)
    setStats(s)
  }, [data])

  // Render charts once stats are ready
  useEffect(() => {
    if (!stats) return

    const labels = ORDERED_CATS
    const colors = labels.map(c => CATEGORY_COLORS[c] + 'cc')

    // Destroy old chart instances before creating new ones
    if (buyingChartInstance.current) buyingChartInstance.current.destroy()
    if (infoChartInstance.current) infoChartInstance.current.destroy()

    const chartOpts = (title) => ({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.parsed.x.toLocaleString()} clicks` } },
      },
      scales: {
        x: {
          grid: { color: '#e1e0d9' },
          ticks: { color: '#898781', font: { size: 11 }, callback: v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v },
        },
        y: { grid: { display: false }, ticks: { color: '#0b0b0b', font: { size: 12 } } },
      },
    })

    buyingChartInstance.current = new Chart(buyingChartRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: labels.map(c => stats[c]?.buyingClicks || 0),
          backgroundColor: colors,
          borderRadius: 4,
          barThickness: 20,
        }],
      },
      options: chartOpts('Buying intent clicks'),
    })

    infoChartInstance.current = new Chart(infoChartRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: labels.map(c => stats[c]?.infoClicks || 0),
          backgroundColor: colors,
          borderRadius: 4,
          barThickness: 20,
        }],
      },
      options: chartOpts('Informational clicks'),
    })

    return () => {
      buyingChartInstance.current?.destroy()
      infoChartInstance.current?.destroy()
    }
  }, [stats])

  if (!stats) return <div className="loading">Processing queries…</div>

  // Filter displayed queries
  const filteredQueries = data.filter(q => {
    if (catFilter !== 'All' && q.category !== catFilter) return false
    if (filter === 'buying') return q.buyingIntent
    if (filter === 'informational') return !q.buyingIntent
    return true
  }).sort((a, b) => b.clicks - a.clicks).slice(0, 200)

  const totalClicks = data.reduce((s, q) => s + q.clicks, 0)
  const totalImpressions = data.reduce((s, q) => s + q.impressions, 0)
  const buyingClicks = data.filter(q => q.buyingIntent).reduce((s, q) => s + q.clicks, 0)
  const gapCats = ORDERED_CATS.filter(c => stats[c]?.isGap)

  return (
    <div className="page">

      {/* Generate keywords CTA — top */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <button className="btn-primary btn-lg" onClick={handleGenerateKeywords} disabled={generating}>
          {generating ? 'Generating keywords + AI headlines…' : '→ Generate Ad Keywords'}
        </button>
        {error && <div className="error-box" style={{ margin: 0 }}>{error}</div>}
      </div>

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Total queries</div>
          <div className="stat-value">{data.length.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total clicks</div>
          <div className="stat-value">{totalClicks.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total impressions</div>
          <div className="stat-value">{(totalImpressions / 1000000).toFixed(1)}M</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Buying intent clicks</div>
          <div className="stat-value">{buyingClicks.toLocaleString()}</div>
        </div>
      </div>

      {/* Gap category alert */}
      {gapCats.length > 0 && (
        <div className="alert-gap">
          <strong>Gap categories detected:</strong> {gapCats.join(', ')} — low buying-intent presence. Suggested keywords will be added for these in the Ad Keywords tab.
        </div>
      )}

      {/* Charts */}
      <div className="charts-grid">
        <div className="chart-box">
          <div className="chart-title">Buying intent — clicks by category</div>
          <div style={{ position: 'relative', height: 220 }}>
            <canvas ref={buyingChartRef} role="img" aria-label="Buying intent clicks by category" />
          </div>
        </div>
        <div className="chart-box">
          <div className="chart-title">Informational — clicks by category <span className="chart-hint">(what content is working)</span></div>
          <div style={{ position: 'relative', height: 220 }}>
            <canvas ref={infoChartRef} role="img" aria-label="Informational clicks by category" />
          </div>
        </div>
      </div>

      {/* Category breakdown table */}
      <div className="section-header">
        <h2>Category breakdown</h2>
      </div>
      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Total queries</th>
              <th className="num">Total clicks</th>
              <th className="num">Buying queries</th>
              <th className="num">Buying clicks</th>
              <th className="num">Info clicks</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {ORDERED_CATS.map(cat => {
              const s = stats[cat]
              return (
                <tr key={cat}>
                  <td>
                    <span className="cat-dot" style={{ background: CATEGORY_COLORS[cat] }} />
                    {cat}
                  </td>
                  <td className="num">{s.totalQueries.toLocaleString()}</td>
                  <td className="num">{s.totalClicks.toLocaleString()}</td>
                  <td className="num">{s.buyingQueries}</td>
                  <td className="num">{s.buyingClicks.toLocaleString()}</td>
                  <td className="num">{s.infoClicks.toLocaleString()}</td>
                  <td>
                    {s.isGap
                      ? <span className="badge badge-gap">Gap</span>
                      : <span className="badge badge-ok">OK</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Query explorer */}
      <div className="section-header">
        <h2>Query explorer</h2>
        <div className="filter-row">
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}>
            <option>All</option>
            {ORDERED_CATS.map(c => <option key={c}>{c}</option>)}
          </select>
          <div className="btn-group">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
            <button className={filter === 'buying' ? 'active' : ''} onClick={() => setFilter('buying')}>Buying intent</button>
            <button className={filter === 'informational' ? 'active' : ''} onClick={() => setFilter('informational')}>Informational</button>
          </div>
          <button className="btn-secondary btn-sm" onClick={() => downloadQueriesCSV(data)}>↓ Export queries</button>
        </div>
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Category</th>
              <th className="num">Clicks</th>
              <th className="num">Impressions</th>
              <th className="num">CTR</th>
              <th className="num">Position</th>
              <th>Intent</th>
            </tr>
          </thead>
          <tbody>
            {filteredQueries.map((q, i) => (
              <tr key={i}>
                <td className="query-cell">{q.query}</td>
                <td>
                  <span className="cat-badge" style={{ background: CATEGORY_COLORS[q.category] + '22', color: CATEGORY_COLORS[q.category] }}>
                    {q.category}
                  </span>
                </td>
                <td className="num">{q.clicks.toLocaleString()}</td>
                <td className="num">{q.impressions.toLocaleString()}</td>
                <td className="num">{q.ctr.toFixed(1)}%</td>
                <td className="num">
                  <span className={`pos-badge ${q.position <= 3 ? 'pos-good' : q.position <= 7 ? 'pos-mid' : 'pos-low'}`}>
                    {q.position.toFixed(1)}
                  </span>
                </td>
                <td>
                  {q.buyingIntent
                    ? <span className="badge badge-buying">Buying</span>
                    : <span className="badge badge-info">Info</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredQueries.length === 200 && <p className="table-hint">Showing top 200 rows. Export CSV for full data.</p>}
      </div>


    </div>
  )
}
