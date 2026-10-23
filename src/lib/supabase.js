import { createClient } from '@supabase/supabase-js'
import { formatMatchType, MATCH_TYPES, normalizeSource } from '../shared/keywordRules.js'
import { serializeProject } from './workspace.js'
import { primaryEvidence } from './seedMatching.js'

// The URL and publishable (anon) key are public by design. They grant nothing on their own:
// every table requires a signed-in, approved member (RLS in supabase/migrations/20261023_access_control.sql).
// Never put a service-role / secret key in a VITE_ variable — those are shipped to the browser.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = !!(supabaseUrl && supabaseAnonKey)

let client = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  })
  : null
export const getClient = () => {
  if (!client) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).')
  return client
}
// Tests inject a mock client
export const setClient = c => { client = c }

// ── Authentication (Supabase Auth, Google provider) ──
export async function signInWithGoogle() {
  const { error } = await getClient().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/` },
  })
  if (error) throw new Error('Google sign-in could not start. Please try again.')
}

export async function signOut() {
  try { await getClient().auth.signOut() } catch { /* the local session is cleared either way */ }
}

export async function currentSession() {
  const { data } = await getClient().auth.getSession() // refreshes an expired access token when possible
  return data?.session || null
}

export const onAuthChange = cb => getClient().auth.onAuthStateChange((event, session) => cb(event, session)).data.subscription

// Server-decided access for the signed-in user: { status: approved|pending|revoked|unverified|..., role }
export async function myAccess() {
  const { data, error } = await getClient().rpc('app_my_access')
  if (error) throw new Error('Could not check your access. Please try again.')
  return data || { status: 'anonymous' }
}

const BATCH = 500

// Save a GSC analysis (upload + queries). If any step fails, the upload row is deleted again
// (cascade removes its queries) so a failed save never shows up as a complete analysis.
export async function saveAnalysis({ queries, dateStart, dateEnd, source }) {
  const db = getClient()
  const { data: upload, error: uploadError } = await db
    .from('gsc_uploads')
    .insert({
      source,
      date_start: dateStart,
      date_end: dateEnd,
      rows_count: queries.length,
      total_clicks: queries.reduce((sum, q) => sum + q.clicks, 0),
      total_impressions: queries.reduce((sum, q) => sum + q.impressions, 0),
    })
    .select()
    .single()
  if (uploadError) throw uploadError

  try {
    for (let i = 0; i < queries.length; i += BATCH) {
      const batch = queries.slice(i, i + BATCH).map(q => ({
        upload_id: upload.id,
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
        category: q.category,
        buying_intent: q.buyingIntent,
        is_branded: q.isBranded,
      }))
      const { error } = await db.from('search_queries').insert(batch)
      if (error) throw error
    }
  } catch (err) {
    await db.from('gsc_uploads').delete().eq('id', upload.id) // roll back the partial save
    throw err
  }
  return upload.id
}

// Flatten a project into ad_keywords rows (one per keyword × match type)
export function projectKeywordRows(project, projectId) {
  const rows = []
  for (const g of project.adGroups) {
    for (const k of g.keywords) {
      const ev = k.source === 'gsc_observed' ? primaryEvidence(k) : null
      for (const mt of MATCH_TYPES) {
        if (!k.match?.[mt]) continue
        rows.push({
          project_id: projectId,
          upload_id: project.gscRef?.uploadId || null,
          keyword: formatMatchType(k.base, mt),
          base_keyword: k.base,
          match_type: mt,
          category: g.category,
          ad_group: g.name,
          landing_url: g.landingUrl,
          headline_1: k.headlines?.[0] || null,
          headline_2: k.headlines?.[1] || null,
          headline_3: k.headlines?.[2] || null,
          source: k.source,
          is_gap_category: false,
          // Evidence: metrics only for observed GSC queries; AI expansions list their seed queries
          // AI expansions: their seed queries. Derived themes: the long GSC query they came from.
          seed_queries: k.source === 'ai_expansion' ? (k.seedRefs || []) : k.source === 'gsc_derived' && k.derivedFrom ? [k.derivedFrom] : null,
          edited_from: k.editedFrom || null,
          gsc_scope: ev?.scope || null,
          gsc_clicks: ev ? ev.clicks : null,
          gsc_impressions: ev ? ev.impressions : null,
          gsc_ctr: ev ? ev.ctr : null,
          gsc_position: ev ? ev.position : null,
          gsc_period_start: ev?.periodStart || null,
          gsc_period_end: ev?.periodEnd || null,
        })
      }
    }
  }
  return rows
}

// Save (create or update) a keyword project.
// Step 1 writes the whole project in one statement (status 'saving').
// Step 2 replaces its ad_keywords mirror. Step 3 marks it 'complete'.
// If step 2/3 fails the row is marked 'failed' and History shows it as an incomplete save.
export async function saveProject(project) {
  const db = getClient()
  const data = serializeProject(project)
  const meta = {
    name: project.name?.trim() || 'Untitled keyword project',
    mode: project.mode,
    selected_categories: project.selectedCategories || [],
    page_urls: project.adGroups.filter(g => g.pageUrl).map(g => g.pageUrl),
    gsc_upload_id: project.gscRef?.uploadId || null,
    gsc_source: project.gscRef?.source || null,
    gsc_date_start: project.gscRef?.dateStart || null,
    gsc_date_end: project.gscRef?.dateEnd || null,
    ad_group_count: project.adGroups.length,
    keyword_count: project.adGroups.reduce((s, g) => s + g.keywords.length, 0),
    save_status: 'saving',
    updated_at: new Date().toISOString(),
    data,
  }

  const write = project.id
    ? db.from('keyword_projects').update(meta).eq('id', project.id).select('id').single()
    : db.from('keyword_projects').insert(meta).select('id').single()
  const { data: row, error } = await write
  if (error) throw error
  const id = row.id

  try {
    const { error: delError } = await db.from('ad_keywords').delete().eq('project_id', id)
    if (delError) throw delError
    const rows = projectKeywordRows(project, id)
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error: insError } = await db.from('ad_keywords').insert(rows.slice(i, i + BATCH))
      if (insError) throw insError
    }
    const { error: doneError } = await db.from('keyword_projects').update({ save_status: 'complete' }).eq('id', id)
    if (doneError) throw doneError
  } catch (err) {
    await db.from('keyword_projects').update({ save_status: 'failed' }).eq('id', id)
    const wrapped = new Error(`Project data saved, but the keyword list did not finish saving (${err.message}). Please save again.`)
    wrapped.projectId = id
    throw wrapped
  }
  return id
}

export async function loadProjects() {
  const { data, error } = await getClient()
    .from('keyword_projects')
    .select('id, name, mode, created_at, updated_at, save_status, ad_group_count, keyword_count, selected_categories, page_urls, gsc_date_start, gsc_date_end, gsc_source')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return data
}

export async function loadProject(id) {
  const { data, error } = await getClient().from('keyword_projects').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

// Load past analyses from Supabase
export async function loadHistory() {
  const { data, error } = await getClient()
    .from('gsc_uploads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return data
}

// Load queries for a past upload
export async function loadUploadQueries(uploadId) {
  const { data, error } = await getClient()
    .from('search_queries')
    .select('*')
    .eq('upload_id', uploadId)
  if (error) throw error
  return data
}

// Load ad keywords for a past upload (legacy rows and project rows linked to that upload)
export async function loadUploadKeywords(uploadId) {
  const { data, error } = await getClient()
    .from('ad_keywords')
    .select('*')
    .eq('upload_id', uploadId)
  if (error) throw error
  return data
}

// Normalize legacy/new ad_keywords rows for CSV export
export function normalizeKeywordRow(k) {
  return {
    keyword: k.keyword,
    base: k.base_keyword || k.keyword?.replace(/["\[\]]/g, ''),
    matchType: k.match_type,
    category: k.category,
    adGroup: k.ad_group || k.category,
    landingUrl: k.landing_url || '',
    source: normalizeSource(k.source),
    headlines: [k.headline_1, k.headline_2, k.headline_3].filter(Boolean),
    headlineStatus: '',
    headlineIssues: [],
    seedRefs: normalizeSource(k.source) === 'ai_expansion' ? (k.seed_queries || []) : [],
    derivedFrom: normalizeSource(k.source) === 'gsc_derived' ? (k.seed_queries?.[0] || null) : null,
    editedFrom: k.edited_from || null,
    evidence: k.gsc_scope ? {
      scope: k.gsc_scope, clicks: k.gsc_clicks, impressions: k.gsc_impressions, ctr: k.gsc_ctr ?? 0,
      position: k.gsc_position ?? 0, periodStart: k.gsc_period_start, periodEnd: k.gsc_period_end,
    } : null,
  }
}
