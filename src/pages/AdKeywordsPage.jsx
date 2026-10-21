import { useMemo, useRef, useState } from 'react'
import {
  CATEGORIES, CATEGORY_COLORS, MATCH_TYPES, SOURCES, HEADLINE_MAX, isAllowedStoreHost, parseStoreUrl,
} from '../shared/keywordRules'
import {
  ensureCategoryGroups, categoryGroupIds, createPageGroup, pageSnapshot, guessCategory, updateGroup,
  removeGroup, runKeywordGeneration, buildHeadlineBatches, runHeadlineBatches, projectRows, filterRows,
  removeKeywords, setMatchType, editKeyword, mergeKeywords, findSeeds, setSeedSelection, addManualSeed,
  selectedSeeds, datasetRef, scopeLabel, evidenceProblem, addDerivedSeed,
} from '../lib/workspace'
import { api } from '../lib/api'
import { saveProject } from '../lib/supabase'
import { downloadKeywordRows } from '../lib/download'
import PagePreview from '../components/PagePreview'
import SeedPanel, { datasetLabel } from '../components/SeedPanel'

const MODES = [
  { id: 'category', label: 'By category' },
  { id: 'collection', label: 'By collection page' },
  { id: 'product', label: 'By product page' },
]
const MATCH_LABELS = { broad: { label: 'Broad', color: '#888780' }, phrase: { label: 'Phrase', color: '#2a78d6' }, exact: { label: 'Exact', color: '#008300' } }
const SOURCE_BADGE = { gsc_observed: 'badge-gsc', gsc_derived: 'badge-gap', ai_expansion: 'badge-suggested', manual: 'badge-info' }
const MAX_ROWS = 300

// dataset = { queries, source, dateStart, dateEnd, uploadId } | null
// fetchPageRows(page) loads page-level GSC queries (only when Search Console is connected)
export default function AdKeywordsPage({
  project, store, dataset, fetchPageRows, onExtendPeriod, canExtendPeriod,
  saved, onSaved, onNewProject, onGoToConnect,
}) {
  const setP = store.setProject

  // URL preview state (not saved — only the confirmed ad group is)
  const [urlInput, setUrlInput] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [loadingPage, setLoadingPage] = useState(false)
  const [selectedProducts, setSelectedProducts] = useState(new Set())
  const [groupName, setGroupName] = useState('')
  const [groupCategory, setGroupCategory] = useState('Other')

  const [activeGroupId, setActiveGroupId] = useState(null)
  const [kwCount, setKwCount] = useState(12)
  const [working, setWorking] = useState(false)
  const [genError, setGenError] = useState(null)

  // Results table
  const [groupFilter, setGroupFilter] = useState('All')
  const [sourceFilter, setSourceFilter] = useState('All')
  const [matchFilter, setMatchFilter] = useState('All')
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [editing, setEditing] = useState(null)
  const [manualInputs, setManualInputs] = useState({})

  const [hl, setHl] = useState({ running: false, done: 0, total: 0, failed: [] })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const mode = project.mode
  const activeGroup = project.adGroups.find(g => g.id === activeGroupId) || null
  const previewSeq = useRef(0)

  // ── Evidence (seeds) ──
  const runFindSeeds = async (groupIds, level) => {
    if (!dataset) return
    setWorking(true)
    setGenError(null)
    setP(p => ({ ...p, gscRef: datasetRef(dataset) }))
    for (const id of groupIds) {
      try {
        await findSeeds({ groupId: id, getProject: store.getProject, setProject: setP, dataset, level, fetchPageRows })
      } catch (err) {
        setP(p => updateGroup(p, id, g => ({ ...g, seedStatus: { ...g.seedStatus, state: 'error', error: err.message } })))
      }
    }
    setWorking(false)
  }

  const handleFindCategoryEvidence = async () => {
    const cats = project.selectedCategories
    setP(p => ensureCategoryGroups(p, cats))
    const ids = categoryGroupIds(store.getProject(), cats)
    setActiveGroupId(ids[0])
    await runFindSeeds(ids)
  }

  const toggleCategory = (cat, on) => setP(p => ({
    ...p,
    selectedCategories: on ? CATEGORIES.filter(c => c === cat || p.selectedCategories.includes(c)) : p.selectedCategories.filter(c => c !== cat),
  }))

  // ── Generation (from selected seeds only) ──
  const generateForGroups = async (groupIds) => {
    const ready = groupIds.filter(id => { const g = store.getProject().adGroups.find(x => x.id === id); return g && !evidenceProblem(g, dataset) })
    if (!dataset || !ready.length) return
    setWorking(true)
    setGenError(null)
    try {
      const outcomes = await runKeywordGeneration({ groupIds: ready, getProject: store.getProject, setProject: setP, api, dataset, count: kwCount })
      const failed = outcomes.filter(o => !o.ok)
      if (failed.length) setGenError(`${failed.length} of ${ready.length} ad group(s) had a problem: ${failed[0].error?.message}`)
    } catch (err) {
      setGenError(err.message)
    }
    setWorking(false)
  }

  const handleLoadPage = async () => {
    setPreviewError(null)
    const parsed = parseStoreUrl(urlInput)
    if (!parsed.ok) { setPreviewError(parsed.error); return }
    setLoadingPage(true)
    setPreview(null)
    const seq = ++previewSeq.current
    try {
      const page = await api.fetchPage(parsed.url)
      if (seq !== previewSeq.current) return // a newer URL was requested — ignore this late response
      if (page.type !== mode) setP(p => ({ ...p, mode: page.type }))
      const existing = project.adGroups.find(g => g.pageUrl === page.url)
      setPreview(page)
      setSelectedProducts(new Set(existing?.selectedProductHandles ?? (page.products || []).map(p => p.handle)))
      setGroupName(existing?.name || page.title.split('|')[0].trim())
      setGroupCategory(existing?.category || guessCategory(page))
    } catch (err) {
      if (seq === previewSeq.current) setPreviewError(err.message)
    } finally {
      if (seq === previewSeq.current) setLoadingPage(false)
    }
  }

  const existingPreviewGroup = preview ? project.adGroups.find(g => g.pageUrl === preview.url) : null

  const handleConfirmPage = async () => {
    const handles = [...selectedProducts]
    let groupId
    if (existingPreviewGroup) {
      groupId = existingPreviewGroup.id
      setP(p => updateGroup(p, groupId, g => ({
        ...g, name: groupName.trim(), category: groupCategory,
        page: pageSnapshot(preview, handles), selectedProductHandles: handles,
      })))
    } else {
      const group = createPageGroup(preview, { name: groupName, category: groupCategory, selectedProductHandles: handles })
      groupId = group.id
      setP(p => ({ ...p, adGroups: [...p.adGroups, group] }))
    }
    setPreview(null)
    setUrlInput('')
    setActiveGroupId(groupId)
    await runFindSeeds([groupId])
  }

  // ── Rows & selection ──
  const rows = useMemo(() => projectRows(project), [project])
  const filtered = useMemo(() => filterRows(rows, { groupId: groupFilter, source: sourceFilter, matchType: matchFilter }), [rows, groupFilter, sourceFilter, matchFilter])
  const liveSelected = useMemo(() => new Set(rows.filter(r => selectedRows.has(r.rowId)).map(r => r.rowId)), [rows, selectedRows])
  const selectedKeywordIds = useMemo(() => [...new Set(rows.filter(r => liveSelected.has(r.rowId)).map(r => r.keywordId))], [rows, liveSelected])
  const allFilteredSelected = filtered.length > 0 && filtered.every(r => liveSelected.has(r.rowId))
  const flaggedIds = useMemo(() => [...new Set(rows.filter(r => r.headlineStatus === 'invalid').map(r => r.keywordId))], [rows])

  const toggleRow = (rowId, on) => {
    const next = new Set(liveSelected)
    on ? next.add(rowId) : next.delete(rowId)
    setSelectedRows(next)
  }
  const toggleAllFiltered = (on) => {
    const next = new Set(liveSelected)
    filtered.forEach(r => (on ? next.add(r.rowId) : next.delete(r.rowId)))
    setSelectedRows(next)
  }

  // ── Headlines (only for existing keywords — never adds keywords) ──
  const runHeadlines = async (batches) => {
    if (!batches.length) return
    setHl({ running: true, done: 0, total: batches.length, failed: [] })
    const { failed } = await runHeadlineBatches({
      batches, getProject: store.getProject, setProject: setP, api,
      onProgress: pr => setHl(h => ({ ...h, done: pr.done, total: pr.total })),
    })
    setHl(h => ({ ...h, running: false, failed }))
  }

  // ── Save ──
  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      if (dataset?.uploadId) setP(p => (p.gscRef && !p.gscRef.uploadId ? { ...p, gscRef: { ...p.gscRef, uploadId: dataset.uploadId } } : p))
      const id = await saveProject(store.getProject())
      setP(p => ({ ...p, id }))
      onSaved()
    } catch (err) {
      if (err.projectId) setP(p => ({ ...p, id: err.projectId }))
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const groupById = Object.fromEntries(project.adGroups.map(g => [g.id, g]))
  const busy = working || hl.running
  const readyGroups = project.adGroups.filter(g => !evidenceProblem(g, dataset))

  return (
    <div className="page">
      {/* Project bar */}
      <div className="project-bar">
        <input className="input project-name" value={project.name} onChange={e => setP(p => ({ ...p, name: e.target.value }))} aria-label="Project name" />
        <button className="btn-primary" onClick={handleSave} disabled={saving || busy || project.adGroups.length === 0}>
          {saving ? 'Saving…' : project.id ? '↑ Save changes' : '↑ Save project'}
        </button>
        {saved && <span className="status-success">✓ Saved</span>}
        {!saved && project.id && <span className="cta-hint" style={{ margin: 0 }}>Unsaved changes</span>}
        <button className="btn-ghost" onClick={() => { if (confirm('Start a new project? Unsaved changes will be lost.')) { onNewProject(); setActiveGroupId(null) } }}>New project</button>
      </div>
      {saveError && <div className="error-box" style={{ marginBottom: 16 }}>{saveError}</div>}

      {/* GSC dataset — the foundation */}
      <div className={`dataset-bar ${dataset ? '' : 'dataset-missing'}`}>
        {dataset ? (
          <>
            <strong>GSC dataset:</strong> {datasetLabel(dataset)} · {dataset.queries.length.toLocaleString()} queries
            {dataset.source === 'gsc_api' ? ' · page-level data available' : ' · query-only (no page-level data)'}
            {dataset.incomplete && <span className="hint-bad"> · incomplete: row limit reached</span>}
            <span className="muted" title="Search Console omits anonymized (rare) queries and the most recent 2–3 days"> · excludes anonymized queries</span>
            {project.gscRef && (project.gscRef.dateStart !== dataset.dateStart || project.gscRef.dateEnd !== dataset.dateEnd) && project.adGroups.some(g => g.seeds?.length) && (
              <span className="hint-gap" style={{ marginLeft: 8, padding: '2px 6px' }}>Saved evidence is from {project.gscRef.dateStart || 'a CSV'} → {project.gscRef.dateEnd || ''}</span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {canExtendPeriod && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => onExtendPeriod(365).catch(err => setGenError(err.message))}>Load 12 months</button>}
              {canExtendPeriod && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => onExtendPeriod(486).catch(err => setGenError(err.message))}>Load 16 months</button>}
              <button className="btn-secondary btn-sm" onClick={onGoToConnect}>Change dataset</button>
            </span>
          </>
        ) : (
          <>
            <strong>A GSC dataset is required to generate keywords.</strong> Keywords are built from real Search Console queries. You can preview collections and products now.
            <button className="btn-primary btn-sm-primary" style={{ marginLeft: 'auto' }} onClick={onGoToConnect}>Connect Search Console or import CSV</button>
          </>
        )}
      </div>

      {/* 1. Mode */}
      <div className="step-label">1 · Choose what to target</div>
      <div className="btn-group mode-tabs">
        {MODES.map(m => (
          <button key={m.id} className={mode === m.id ? 'active' : ''} onClick={() => { setP(p => ({ ...p, mode: m.id })); setPreview(null); setPreviewError(null) }}>
            {m.label}
          </button>
        ))}
      </div>

      {/* 2. Scope */}
      <div className="step-label">2 · {mode === 'category' ? 'Pick categories' : 'Load and confirm the page'}</div>
      <div className="panel">
        {mode === 'category' && (
          <>
            <div className="preview-toolbar">
              <span className="preview-label" style={{ margin: 0 }}>Categories</span>
              <button className="btn-secondary btn-sm" onClick={() => setP(p => ({ ...p, selectedCategories: [...CATEGORIES] }))}>Select all</button>
              <button className="btn-secondary btn-sm" onClick={() => setP(p => ({ ...p, selectedCategories: [] }))}>Clear all</button>
            </div>
            <div className="check-grid">
              {CATEGORIES.map(cat => (
                <label key={cat} className={`check-card ${project.selectedCategories.includes(cat) ? 'checked' : ''}`}>
                  <input type="checkbox" checked={project.selectedCategories.includes(cat)} onChange={e => toggleCategory(cat, e.target.checked)} />
                  <span className="cat-dot" style={{ background: CATEGORY_COLORS[cat] }} />
                  <span>{cat}</span>
                </label>
              ))}
            </div>
            <div className="generate-row">
              <button className="btn-primary" onClick={handleFindCategoryEvidence} disabled={busy || !dataset || project.selectedCategories.length === 0}>
                {working ? 'Finding GSC evidence…' : `Find GSC evidence for ${project.selectedCategories.length || 'no'} categor${project.selectedCategories.length === 1 ? 'y' : 'ies'}`}
              </button>
              <span className="cta-hint" style={{ margin: 0 }}>
                {dataset ? 'Only checked categories are searched. Queries can match more than one category.' : 'Load a GSC dataset first.'}
              </span>
            </div>
          </>
        )}

        {mode !== 'category' && (
          <>
            <div className="url-row">
              <input
                className="input"
                placeholder={mode === 'collection' ? 'https://succulentsbox.com/collections/…' : 'https://succulentsbox.com/products/…'}
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleLoadPage() }}
              />
              <button className="btn-primary" onClick={handleLoadPage} disabled={loadingPage || !urlInput.trim()}>
                {loadingPage ? 'Loading page…' : 'Load page'}
              </button>
            </div>
            {previewError && <div className="error-box">{previewError}</div>}
            {preview && (
              <PagePreview
                page={preview}
                selected={selectedProducts} setSelected={setSelectedProducts}
                groupName={groupName} setGroupName={setGroupName}
                groupCategory={groupCategory} setGroupCategory={setGroupCategory}
                existingGroup={existingPreviewGroup}
                onConfirm={handleConfirmPage}
                busy={busy}
                needsDataset={!dataset}
              />
            )}
          </>
        )}
        {genError && <div className="error-box">{genError}</div>}
      </div>

      {/* 3. Ad groups + evidence */}
      {project.adGroups.length > 0 && (
        <>
          <div className="step-label">3 · Review GSC evidence per ad group, then generate</div>
          <div className="group-grid">
            {project.adGroups.map(g => {
              const counts = { gsc_observed: 0, gsc_derived: 0, ai_expansion: 0, manual: 0 }
              g.keywords.forEach(k => { counts[k.source] = (counts[k.source] || 0) + 1 })
              const run = g.status?.lastRun
              const urlOk = isAllowedStoreHost(g.landingUrl)
              const sel = selectedSeeds(g).length
              return (
                <div key={g.id} className={`group-card ${activeGroupId === g.id ? 'group-active' : ''}`}>
                  <div className="group-card-head">
                    <span className="cat-dot" style={{ background: CATEGORY_COLORS[g.category] || '#888' }} />
                    <input className="input input-plain" value={g.name} onChange={e => setP(p => updateGroup(p, g.id, x => ({ ...x, name: e.target.value })))} aria-label="Ad group name" />
                    <span className="badge badge-info">{MODES.find(m => m.id === g.mode)?.label.replace('By ', '')}</span>
                  </div>
                  <label className="field">
                    <span>Landing page {g.mode !== 'category' && '(from the loaded page)'}</span>
                    <input className={`input ${urlOk ? '' : 'input-bad'}`} value={g.landingUrl} readOnly={g.mode !== 'category'}
                      onChange={e => setP(p => updateGroup(p, g.id, x => ({ ...x, landingUrl: e.target.value.trim() })))} />
                  </label>
                  {!urlOk && <div className="hint-bad">Landing page must be a succulentsbox.com URL.</div>}
                  <div className="group-stats">
                    GSC evidence: {g.seedStatus?.state === 'done' ? `${sel} of ${g.seeds.length} queries selected` : g.seedStatus?.state === 'loading' ? 'searching…' : 'not searched yet'}
                    {g.seedStatus?.pageLevel?.status === 'ok' && ` · ${g.seedStatus.pageLevel.count} page-level`}
                  </div>
                  <div className="group-stats">
                    {g.keywords.length} keywords · {counts.gsc_observed} observed{counts.gsc_derived ? ` · ${counts.gsc_derived} derived` : ''} · {counts.ai_expansion} AI expansions · {counts.manual} manual
                  </div>
                  {g.seedStatus?.state === 'done' && g.seeds.length === 0 && !evidenceProblem(g, dataset)?.includes('changed') && <div className="hint-gap">No relevant GSC evidence found yet.</div>}
                  {(g.seedStatus?.state === 'error' || evidenceProblem(g, dataset)?.includes('changed')) && <div className="hint-bad">{evidenceProblem(g, dataset)}</div>}
                  {g.status?.keywords === 'loading' && <div className="status-text">Generating keywords…</div>}
                  {g.status?.keywords === 'error' && <div className="hint-bad">{g.status.error}</div>}
                  {g.status?.keywords === 'done' && run && (
                    <div className="status-text">Last run: +{run.observedAdded} observed queries, +{run.aiAdded} AI expansions{run.rejected ? ` (${run.rejected} filtered out)` : ''}{run.observedSkipped ? ` · ${run.observedSkipped} selected quer${run.observedSkipped === 1 ? 'y' : 'ies'} too long to be a Google Ads keyword` : ''}</div>
                  )}
                  <div className="manual-row">
                    <input className="input" placeholder="Add a keyword manually" value={manualInputs[g.id] || ''}
                      onChange={e => setManualInputs(m => ({ ...m, [g.id]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && manualInputs[g.id]?.trim()) {
                          setP(p => updateGroup(p, g.id, x => mergeKeywords(x, [manualInputs[g.id]], 'manual').group))
                          setManualInputs(m => ({ ...m, [g.id]: '' }))
                        }
                      }} />
                  </div>
                  <div className="action-row">
                    <button className="btn-secondary btn-sm" onClick={() => setActiveGroupId(g.id)}>{activeGroupId === g.id ? 'Reviewing evidence ↓' : 'Review evidence'}</button>
                    <button className="btn-secondary btn-sm" disabled={busy || !!evidenceProblem(g, dataset)} title={evidenceProblem(g, dataset) || ''} onClick={() => generateForGroups([g.id])}>Generate</button>
                    <button className="btn-secondary btn-sm" onClick={() => setGroupFilter(g.id)}>Show rows</button>
                    <button className="btn-ghost btn-sm-ghost" disabled={busy} onClick={() => { if (confirm(`Remove ad group "${g.name}" and its keywords?`)) { setP(p => removeGroup(p, g.id)); if (groupFilter === g.id) setGroupFilter('All'); if (activeGroupId === g.id) setActiveGroupId(null) } }}>Remove</button>
                  </div>
                </div>
              )
            })}
          </div>

          {project.adGroups.length > 1 && (
            <div className="generate-row" style={{ margin: '4px 0 12px' }}>
              <button className="btn-secondary" disabled={busy || !dataset || readyGroups.length === 0} onClick={() => generateForGroups(readyGroups.map(g => g.id))}>
                Generate for all {readyGroups.length} ad group{readyGroups.length === 1 ? '' : 's'} with selected evidence
              </button>
            </div>
          )}

          {activeGroup && (
            <SeedPanel
              key={activeGroup.id}
              group={activeGroup}
              dataset={dataset}
              canLoadPageLevel={!!fetchPageRows && dataset?.source === 'gsc_api'}
              canExtendPeriod={canExtendPeriod}
              busy={busy}
              kwCount={kwCount}
              setKwCount={setKwCount}
              onFindSeeds={() => runFindSeeds([activeGroup.id])}
              onSetLevel={level => runFindSeeds([activeGroup.id], level)}
              onExtendPeriod={async days => {
                try {
                  const ds = await onExtendPeriod(days)
                  setP(p => ({ ...p, gscRef: datasetRef(ds) }))
                  // Re-match with the NEW dataset; its period is passed to the page-level request explicitly
                  await findSeeds({ groupId: activeGroup.id, getProject: store.getProject, setProject: setP, dataset: ds, fetchPageRows })
                } catch (err) {
                  setGenError(err.message)
                }
              }}
              onToggleSeeds={(ids, on) => setP(p => setSeedSelection(p, activeGroup.id, ids, on))}
              onAddManual={row => setP(p => addManualSeed(p, activeGroup.id, row, dataset))}
              onAddDerived={(seedId, text) => setP(p => addDerivedSeed(p, activeGroup.id, seedId, text))}
              onSetAliases={aliases => { setP(p => updateGroup(p, activeGroup.id, g => ({ ...g, aliases }))); runFindSeeds([activeGroup.id]) }}
              onGenerate={() => generateForGroups([activeGroup.id])}
            />
          )}
        </>
      )}

      {/* Results */}
      {rows.length > 0 && (
        <>
          <div className="step-label">4 · Review keywords, then 5 · generate headlines</div>
          <div className="section-header">
            <h2>{new Set(rows.map(r => r.keywordId)).size} keywords · {rows.length} rows with match types</h2>
            <div className="filter-row">
              <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} aria-label="Filter by ad group">
                <option value="All">All ad groups</option>
                {project.adGroups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.category})</option>)}
              </select>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} aria-label="Filter by source">
                <option value="All">All sources</option>
                {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={matchFilter} onChange={e => setMatchFilter(e.target.value)} aria-label="Filter by match type">
                <option value="All">All match types</option>
                {MATCH_TYPES.map(m => <option key={m} value={m}>{MATCH_LABELS[m].label}</option>)}
              </select>
            </div>
          </div>

          <div className="bulk-bar">
            <span>{liveSelected.size} rows selected ({selectedKeywordIds.length} keywords)</span>
            <button className="btn-primary btn-sm-primary" disabled={busy || selectedKeywordIds.length === 0} onClick={() => runHeadlines(buildHeadlineBatches(store.getProject(), selectedKeywordIds))}>
              ✦ Generate headlines for selected
            </button>
            {MATCH_TYPES.map(mt => (
              <span key={mt} className="match-toggle">
                {MATCH_LABELS[mt].label}
                <button className="btn-secondary btn-sm" disabled={!selectedKeywordIds.length} onClick={() => setP(p => setMatchType(p, selectedKeywordIds, mt, true))}>on</button>
                <button className="btn-secondary btn-sm" disabled={!selectedKeywordIds.length} onClick={() => setP(p => setMatchType(p, selectedKeywordIds, mt, false))}>off</button>
              </span>
            ))}
            <button className="btn-secondary btn-sm" disabled={busy || !selectedKeywordIds.length} onClick={() => { setP(p => removeKeywords(p, selectedKeywordIds)); setSelectedRows(new Set()) }}>Remove keywords</button>
            <button className="btn-ghost" disabled={!liveSelected.size} onClick={() => setSelectedRows(new Set())}>Clear selection</button>
          </div>

          {(hl.running || hl.total > 0) && (
            <div className="progress-box">
              <div className="progress"><div className="progress-fill" style={{ width: `${hl.total ? (hl.done / hl.total) * 100 : 0}%` }} /></div>
              <span>{hl.running ? `Headlines: ${hl.done}/${hl.total} batches` : `Headlines done: ${hl.total - hl.failed.length}/${hl.total} batches succeeded`}</span>
              {!hl.running && hl.failed.length > 0 && (
                <button className="btn-secondary btn-sm" onClick={() => runHeadlines(hl.failed)}>↺ Retry {hl.failed.length} failed batch{hl.failed.length > 1 ? 'es' : ''}</button>
              )}
              {!hl.running && flaggedIds.length > 0 && (
                <button className="btn-secondary btn-sm" onClick={() => runHeadlines(buildHeadlineBatches(store.getProject(), flaggedIds))}>↺ Retry {flaggedIds.length} flagged keyword{flaggedIds.length > 1 ? 's' : ''}</button>
              )}
              {!hl.running && hl.failed.length > 0 && <span className="hint-bad">{hl.failed[0].error}</span>}
            </div>
          )}

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allFilteredSelected} onChange={e => toggleAllFiltered(e.target.checked)} aria-label="Select all filtered rows" /></th>
                  <th>Keyword</th>
                  <th>Category</th>
                  <th>Ad group</th>
                  <th>Landing page</th>
                  <th>Match type</th>
                  <th>Source</th>
                  <th title="Observed queries show their own GSC metrics. AI expansions show the seed queries they come from — they have no metrics.">GSC evidence / seeds</th>
                  <th>Headline 1</th>
                  <th>Headline 2</th>
                  <th>Headline 3</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, MAX_ROWS).map(r => {
                  const mt = MATCH_LABELS[r.matchType]
                  const isEditing = editing?.keywordId === r.keywordId
                  const e = r.evidence
                  return (
                    <tr key={r.rowId} className={liveSelected.has(r.rowId) ? 'row-selected' : ''}>
                      <td><input type="checkbox" checked={liveSelected.has(r.rowId)} onChange={ev => toggleRow(r.rowId, ev.target.checked)} /></td>
                      <td className="keyword-cell" title="Click to edit">
                        {isEditing ? (
                          <input className="input input-inline" autoFocus value={editing.value}
                            onChange={ev => setEditing({ ...editing, value: ev.target.value })}
                            onBlur={() => { setP(p => updateGroup(p, r.groupId, g => editKeyword(g, r.keywordId, editing.value))); setEditing(null) }}
                            onKeyDown={ev => { if (ev.key === 'Enter') ev.currentTarget.blur(); if (ev.key === 'Escape') setEditing(null) }} />
                        ) : (
                          <span className="editable" onClick={() => setEditing({ keywordId: r.keywordId, groupId: r.groupId, value: r.base })}>{r.keyword}</span>
                        )}
                      </td>
                      <td><span className="cat-badge" style={{ background: (CATEGORY_COLORS[r.category] || '#888') + '22', color: CATEGORY_COLORS[r.category] || '#888' }}>{r.category}</span></td>
                      <td className="headline-cell">{groupById[r.groupId]?.name}</td>
                      <td className="headline-cell"><a href={r.landingUrl} target="_blank" rel="noreferrer">{r.landingUrl.replace('https://succulentsbox.com', '')}</a></td>
                      <td><span className="match-badge" style={{ color: mt.color }}>{mt.label}</span></td>
                      <td><span className={`badge ${SOURCE_BADGE[r.source] || 'badge-info'}`}>{SOURCES[r.source] || r.source}</span></td>
                      <td className="evidence-cell">
                        {e ? (
                          <span title={`${scopeLabel(e)} · ${e.periodStart ? `${e.periodStart} → ${e.periodEnd}` : 'period not stated'}`}>
                            <span className={`badge ${e.scope === 'page' ? 'badge-ok' : 'badge-gsc'}`}>{scopeLabel(e)}</span>{' '}
                            {e.clicks.toLocaleString()} clicks · {e.impressions.toLocaleString()} impr. · {e.ctr.toFixed(1)}% · pos {e.position.toFixed(1)}
                          </span>
                        ) : r.source === 'ai_expansion' && r.seedRefs.length ? (
                          <span className="muted" title={r.seedRefs.join(' | ')}>from: {r.seedRefs.join(', ')}</span>
                        ) : r.derivedFrom ? (
                          <span className="muted" title={r.derivedFrom}>derived from a long GSC query (no metrics): "{r.derivedFrom.slice(0, 60)}…"</span>
                        ) : r.editedFrom ? (
                          <span className="muted" title="Edited wording was not observed in GSC, so the original metrics are not shown">edited from: {r.editedFrom} (no metrics)</span>
                        ) : <span className="muted">—</span>}
                      </td>
                      {[0, 1, 2].map(i => {
                        const h = r.headlines[i]
                        const bad = r.headlineStatus === 'invalid' && (!h || h.length > HEADLINE_MAX)
                        return (
                          <td key={i} className={`headline-cell ${bad ? 'hl-bad' : ''}`} title={h ? `${h} (${h.length}/${HEADLINE_MAX})` : r.headlineIssues.join('; ')}>
                            {h || (r.headlineStatus === 'invalid' ? '⚠ missing' : '—')}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length > MAX_ROWS && <p className="table-hint">Showing {MAX_ROWS} of {filtered.length} rows. Download CSV for the full list.</p>}
            {filtered.length === 0 && <p className="table-hint">No rows match the current filters.</p>}
          </div>

          <div className="export-row">
            <span className="preview-label" style={{ margin: 0 }}>Export CSV</span>
            <button className="btn-secondary btn-sm" disabled={!liveSelected.size} onClick={() => downloadKeywordRows(rows.filter(r => liveSelected.has(r.rowId)), 'selected')}>↓ Selected rows ({liveSelected.size})</button>
            <button className="btn-secondary btn-sm" onClick={() => downloadKeywordRows(filtered, 'filtered')}>↓ Current filtered results ({filtered.length})</button>
            <button className="btn-secondary btn-sm" onClick={() => downloadKeywordRows(rows, 'all')}>↓ All results ({rows.length})</button>
            <select value="" onChange={e => { const g = groupById[e.target.value]; if (g) downloadKeywordRows(rows.filter(r => r.groupId === g.id), g.name) }} aria-label="Export a single ad group">
              <option value="">↓ Single ad group…</option>
              {project.adGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </>
      )}

      {project.adGroups.length === 0 && (
        <div className="empty-state"><p>Choose a target above. Each ad group starts from real Search Console queries.</p></div>
      )}
    </div>
  )
}
