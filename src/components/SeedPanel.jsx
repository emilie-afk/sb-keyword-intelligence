import { useMemo, useState } from 'react'
import { FLAG_LABELS, primaryEvidence, searchDataset, suggestTheme } from '../lib/seedMatching'
import { normalizeKeyword } from '../shared/keywordRules'
import { scopeLabel, evidenceProblem, datasetKey, datasetRef, targetSignature } from '../lib/workspace'

const SHOW = 30
const fmtPct = n => `${Number(n || 0).toFixed(1)}%`
const fmtPos = n => Number(n || 0).toFixed(1)

export function datasetLabel(ds) {
  if (!ds) return 'No GSC dataset'
  const src = ds.source === 'gsc_api' ? 'Search Console' : ds.source === 'csv_upload' ? 'Imported CSV' : 'GSC'
  const period = ds.dateStart && ds.dateEnd ? `${ds.dateStart} → ${ds.dateEnd}` : 'period not stated in CSV'
  return `${src} · ${period}`
}

// Review the GSC evidence (seed queries) for one ad group before generating keywords
export default function SeedPanel({
  group, dataset, canLoadPageLevel, canExtendPeriod, busy,
  onFindSeeds, onSetLevel, onExtendPeriod, onToggleSeeds, onAddManual, onAddDerived, onSetAliases, onGenerate, kwCount, setKwCount,
}) {
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState('')
  const [aliasText, setAliasText] = useState((group.aliases || []).join(', '))
  const [themeDrafts, setThemeDrafts] = useState({}) // seedId → editable theme text
  const seeds = group.seeds || []
  const st = group.seedStatus || {}
  const selected = seeds.filter(s => s.selected)
  const visible = showAll ? seeds : seeds.slice(0, SHOW)
  const suggestions = useMemo(() => (search ? searchDataset(dataset?.queries, search, 12) : []), [dataset, search])
  const seedBases = new Set(seeds.map(s => s.base))
  const pageCount = seeds.filter(s => s.evidence.some(e => e.scope === 'page')).length
  const sparse = st.state === 'done' && selected.length < 5
  const loading = st.state === 'loading'
  const problem = evidenceProblem(group, dataset)
  // 'none' with seeds = evidence was reset because the dataset was replaced; old seeds are still shown, so label them
  const stale = (st.state === 'done' || st.state === 'error' || (st.state === 'none' && seeds.length > 0)) && dataset && (
    datasetKey(st.dataset) !== datasetKey(datasetRef(dataset)) || (st.target && st.target !== targetSignature(group)))

  return (
    <div className="panel seed-panel">
      <div className="seed-head">
        <div>
          <h2>GSC evidence — {group.name}</h2>
          <p className="section-hint">
            {datasetLabel(dataset)}{dataset ? ` · ${dataset.queries.length.toLocaleString()} queries` : ''}
            {dataset?.incomplete && ' · dataset incomplete (row limit reached)'}
          </p>
        </div>
        <div className="btn-group" title="Strict needs a name/term match; broad also accepts a single related term">
          <button className={st.level !== 'broad' ? 'active' : ''} disabled={busy || !dataset} onClick={() => onSetLevel('strict')}>Strict matching</button>
          <button className={st.level === 'broad' ? 'active' : ''} disabled={busy || !dataset} onClick={() => onSetLevel('broad')}>Broader site-wide matching</button>
        </div>
      </div>

      {group.mode !== 'category' && (
        <div className="alias-row">
          <label className="field" style={{ flex: 3 }}>
            <span>Also known as (aliases, comma-separated) — used to find more real queries</span>
            <input className="input" value={aliasText} placeholder="e.g. calico kitten crassula, variegated crassula" onChange={e => setAliasText(e.target.value)} />
          </label>
          <button className="btn-secondary btn-sm" disabled={busy || !dataset} onClick={() => onSetAliases(aliasText.split(',').map(a => a.trim()).filter(Boolean))}>Apply & re-match</button>
        </div>
      )}

      {stale && (
        <div className="error-box" style={{ marginTop: 0, marginBottom: 10 }}>
          <strong>This evidence is outdated.</strong> {problem} It can't be used for generation until it is refreshed.{' '}
          <button className="btn-secondary btn-sm" disabled={busy} onClick={onFindSeeds}>Re-run matching</button>
        </div>
      )}
      {!stale && st.state === 'error' && (
        <div className="error-box" style={{ marginTop: 0, marginBottom: 10 }}>
          <strong>GSC evidence could not be loaded completely.</strong> {st.error}{' '}
          <button className="btn-secondary btn-sm" disabled={busy} onClick={onFindSeeds}>Retry</button>
        </div>
      )}

      {/* Evidence status */}
      <div className="evidence-status">
        {group.mode !== 'category' && st.pageLevel && (
          <div className={st.pageLevel.status === 'ok' ? 'status-success' : 'status-text'}>
            Page-level: {st.pageLevel.status === 'ok'
              ? `${st.pageLevel.count} queries for this URL (${st.pageLevel.periodStart} → ${st.pageLevel.periodEnd})${st.pageLevel.incomplete ? ' — INCOMPLETE: row limit reached, not every page-level query was loaded' : ''}`
              : st.pageLevel.status === 'error' ? 'failed (see error above)' : st.pageLevel.message}
          </div>
        )}
        {group.mode !== 'category' && !canLoadPageLevel && !st.pageLevel && dataset && (
          <div className="status-text">Page-level data needs a Search Console connection (not available for CSV imports).</div>
        )}
        {st.state === 'done' && (
          <div className="status-text">
            {seeds.length} relevant queries ({pageCount} page-level, {seeds.length - pageCount} site-wide) · {selected.length} selected for generation
          </div>
        )}
        {loading && <div className="status-text">Finding relevant GSC queries…</div>}
        {st.droppedManual > 0 && <div className="hint-bad">{st.droppedManual} manually added quer{st.droppedManual === 1 ? 'y is' : 'ies are'} not in the current dataset and {st.droppedManual === 1 ? 'was' : 'were'} removed.</div>}
        {(st.datasetIncomplete || dataset?.incomplete) && <div className="hint-bad">The site-wide dataset hit the row limit — some low-volume queries may be missing.</div>}
      </div>

      {/* Sparse / empty evidence: offer ways to broaden, honestly */}
      {st.state === 'done' && !stale && seeds.length === 0 && (
        <div className="alert-gap">
          <strong>No relevant GSC evidence found</strong> for "{group.name}" in {datasetLabel(dataset)}
          {st.level === 'broad' ? ' — even with broader matching' : ''}. Keywords are only generated from real search queries, so nothing will be generated for this ad group yet.
          <div className="action-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            {st.level !== 'broad' && <button className="btn-secondary btn-sm" onClick={() => onSetLevel('broad')}>Try broader site-wide matching</button>}
            {canExtendPeriod && <button className="btn-secondary btn-sm" onClick={() => onExtendPeriod(486)}>Load a longer period (16 months)</button>}
            {!canExtendPeriod && dataset?.source === 'csv_upload' && <span className="cta-hint" style={{ margin: 0 }}>For a longer period, export more months from Search Console and re-import.</span>}
            <span className="cta-hint" style={{ margin: 0 }}>Or search the dataset below and add queries manually.</span>
          </div>
        </div>
      )}
      {sparse && !stale && seeds.length > 0 && (
        <div className="hint-gap" style={{ marginBottom: 10 }}>
          Limited evidence ({selected.length} selected). Sparse data is still used.
          {st.level !== 'broad' && <> <button className="link-btn" onClick={() => onSetLevel('broad')}>Broaden matching</button></>}
          {canExtendPeriod && <> · <button className="link-btn" onClick={() => onExtendPeriod(486)}>Load 16 months</button></>}
        </div>
      )}

      {/* Manual seed selection from the dataset */}
      {dataset && (
        <div className="manual-seed">
          <input className="input" placeholder="Search the GSC dataset to add a query manually…" value={search} onChange={e => setSearch(e.target.value)} />
          {suggestions.length > 0 && (
            <div className="suggest-list">
              {suggestions.map(r => (
                <button key={r.query} className="suggest-item" disabled={seedBases.has(normalizeKeyword(r.query))} onClick={() => { onAddManual(r); setSearch('') }}>
                  <span>{r.query}</span>
                  <span className="muted">{r.clicks} clicks · {r.impressions.toLocaleString()} impr.</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {seeds.length > 0 && (
        <>
          <div className="preview-toolbar" style={{ marginTop: 10 }}>
            <button className="btn-secondary btn-sm" onClick={() => onToggleSeeds(seeds.filter(s => !s.flags.length).map(s => s.id), true)}>Select all unflagged</button>
            <button className="btn-secondary btn-sm" onClick={() => onToggleSeeds(seeds.map(s => s.id), false)}>Clear all</button>
            <span className="cta-hint" style={{ margin: 0 }}>Flagged queries (care/informational, branded, unrelated plants, long queries) stay visible but start unselected.</span>
          </div>
          <div className="table-wrapper" style={{ marginBottom: 12 }}>
            <table className="data-table seed-table">
              <thead>
                <tr>
                  <th />
                  <th>GSC query</th>
                  <th>Scope</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impr.</th>
                  <th className="num">CTR</th>
                  <th className="num">Avg pos.</th>
                  <th>Period</th>
                  <th>Why it matched</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(s => {
                  const e = primaryEvidence(s) // null for derived themes: they have no metrics of their own
                  const other = e ? s.evidence.find(x => x !== e) : null
                  const longQuery = s.flags.includes('too long')
                  const draft = themeDrafts[s.id] ?? suggestTheme(s.query)
                  return (
                    <tr key={s.id} className={s.selected ? '' : 'row-muted'}>
                      <td><input type="checkbox" checked={s.selected} disabled={loading || stale} onChange={ev => onToggleSeeds([s.id], ev.target.checked)} aria-label={`Use ${s.query}`} /></td>
                      <td className="query-cell" title={s.query}>
                        <div className={longQuery ? 'long-query' : ''}>{s.query}</div>
                        {s.flags.map(f => <span key={f} className="badge badge-gap flag-badge">{FLAG_LABELS[f] || f}</span>)}
                        {s.origin === 'manual' && <span className="badge badge-info flag-badge">Manual</span>}
                        {s.origin === 'derived' && <span className="badge badge-suggested flag-badge" title={`From: ${s.derivedFrom}`}>Derived theme</span>}
                        {s.evidence.length > 1 && <span className="muted" style={{ marginLeft: 6 }} title="Page-level and site-wide metrics are shown separately and never added together">(2 scopes)</span>}
                        {longQuery && !stale && (
                          <div className="theme-extract">
                            <span className="muted">Extract a short theme (no metrics carried over):</span>
                            <input className="input input-inline" value={draft} onChange={ev => setThemeDrafts(d => ({ ...d, [s.id]: ev.target.value }))} aria-label="Theme to extract" />
                            <button className="btn-secondary btn-sm" disabled={busy || !draft.trim()} onClick={() => onAddDerived(s.id, draft)}>Add as derived theme</button>
                          </div>
                        )}
                      </td>
                      <td>
                        {e ? <span className={`badge ${e.scope === 'page' ? 'badge-ok' : 'badge-gsc'}`}>{scopeLabel(e)}</span> : <span className="badge badge-suggested">Derived</span>}
                        {other && <div className="muted" title={`${scopeLabel(other)}: ${other.clicks} clicks · ${other.impressions} impr.`}>+ {scopeLabel(other).toLowerCase()}</div>}
                      </td>
                      <td className="num">{e ? e.clicks.toLocaleString() : '—'}</td>
                      <td className="num">{e ? e.impressions.toLocaleString() : '—'}</td>
                      <td className="num">{e ? fmtPct(e.ctr) : '—'}</td>
                      <td className="num">{e ? fmtPos(e.position) : '—'}</td>
                      <td className="period-cell">{e ? (e.periodStart ? `${e.periodStart} → ${e.periodEnd}` : 'not stated') : '—'}</td>
                      <td className="reason-cell">{s.origin === 'derived' ? `${s.reasons.join(' · ')} · source: "${s.derivedFrom.slice(0, 80)}${s.derivedFrom.length > 80 ? '…' : ''}"` : s.reasons.join(' · ')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {seeds.length > SHOW && (
              <p className="table-hint">
                Showing {visible.length} of {seeds.length}. <button className="link-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : 'Show all'}</button>
              </p>
            )}
          </div>
        </>
      )}

      <div className="generate-row">
        <button className="btn-primary" disabled={busy || !!problem} onClick={onGenerate}>
          {group.status?.keywords === 'loading' ? 'Generating…' : `Generate keywords from ${selected.length} selected seed${selected.length === 1 ? '' : 's'}`}
        </button>
        <label className="inline-field">
          AI expansions
          <select value={kwCount} onChange={e => setKwCount(Number(e.target.value))}>
            {[6, 12, 20].map(n => <option key={n} value={n}>up to {n}</option>)}
          </select>
        </label>
        <span className="cta-hint" style={{ margin: 0 }}>
          {problem || 'Selected queries are added as observed keywords; AI expansions cite the queries they come from.'}
        </span>
      </div>
      {!st.state || st.state === 'none' ? (
        <div className="action-row" style={{ marginTop: 10 }}>
          <button className="btn-secondary btn-sm" disabled={busy || !dataset} onClick={onFindSeeds}>Find GSC evidence</button>
        </div>
      ) : null}
    </div>
  )
}
