import { readFileSync } from 'node:fs'
import { validateKeywords } from '../src/shared/relevance.js'

// Synthetic prompt configuration (the real one is private runtime data)
export const TEST_PROMPTS = JSON.parse(readFileSync(new URL('../config/prompts.example.json', import.meta.url), 'utf8'))
// Test helpers — mocked external responses only (no live AI or network calls)

export function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

export function redirectResponse(location, status = 301) {
  return { status, ok: false, headers: { get: k => (k.toLowerCase() === 'location' ? location : null) }, json: async () => ({}) }
}

// Mock api for workspace orchestration tests; records every call
export function mockApi({ keywordsFor, headlinesFor, validateFor } = {}) {
  const calls = { keywords: [], headlines: [], validate: [] }
  return {
    calls,
    // Same shared rules as the server's 'validate' action
    validateKeywords: async (payload) => {
      calls.validate.push(payload)
      if (validateFor) { const r = validateFor(payload); if (r instanceof Error) throw r; return r }
      return validateKeywords(payload.keywords, payload.adGroup)
    },
    generateKeywords: async (payload) => {
      calls.keywords.push(payload)
      if (!payload.seeds?.length) throw new Error('At least one GSC seed query is required')
      const kws = keywordsFor ? keywordsFor(payload, calls.keywords.length) : [`${payload.adGroup.name.toLowerCase()} for sale`]
      if (kws instanceof Error) throw kws
      // Like the server: each expansion cites a seed (the first one unless given)
      return {
        keywords: kws.map(k => (typeof k === 'string'
          ? { keyword: k, category: payload.adGroup.category, seedRefs: [payload.seeds[0].query] }
          : { category: payload.adGroup.category, ...k })),
        rejected: [],
      }
    },
    generateHeadlines: async (payload) => {
      calls.headlines.push(payload)
      if (headlinesFor) {
        const r = headlinesFor(payload, calls.headlines.length)
        if (r instanceof Error) throw r
        return r
      }
      const results = {}
      for (const k of payload.keywords) results[k] = { headlines: ['Fresh plants', 'Shop online', 'Gift ready'], valid: true, issues: [] }
      return { results }
    },
  }
}

// In-memory Supabase-like client supporting the query shapes used in src/lib/supabase.js
export function mockSupabase({ failInsertOn = null, failAfterInserts = Infinity, maxRows = 1000 } = {}) {
  const tables = { gsc_uploads: [], search_queries: [], ad_keywords: [], keyword_projects: [] }
  let id = 0
  let inserts = 0
  const from = (table) => {
    const state = { op: 'select', filters: [], payload: null, single: false, range: null, order: null }
    const exec = async () => {
      const rows = tables[table]
      const match = r => state.filters.every(([k, v]) => r[k] === v)
      if (state.op === 'insert') {
        inserts++
        if (failInsertOn === table && inserts > failAfterInserts) return { data: null, error: new Error(`insert into ${table} failed`) }
        const list = (Array.isArray(state.payload) ? state.payload : [state.payload]).map(r => ({ id: `id${++id}`, ...r }))
        rows.push(...list)
        return { data: state.single ? list[0] : list, error: null }
      }
      if (state.op === 'update') {
        const hit = rows.filter(match)
        hit.forEach(r => Object.assign(r, state.payload))
        return { data: state.single ? hit[0] : hit, error: null }
      }
      if (state.op === 'delete') {
        tables[table] = rows.filter(r => !match(r))
        if (table === 'gsc_uploads') { // cascade
          const ids = new Set(rows.filter(match).map(r => r.id))
          tables.search_queries = tables.search_queries.filter(q => !ids.has(q.upload_id))
        }
        return { data: null, error: null }
      }
      let found = rows.filter(match)
      if (state.order) found = [...found].sort((a, b) => String(a[state.order]).localeCompare(String(b[state.order]), 'en', { numeric: true }))
      // Like PostgREST: a range selects rows, and no response is longer than the server's max rows
      if (state.range) found = found.slice(state.range[0], state.range[1] + 1)
      found = found.slice(0, maxRows)
      return { data: state.single ? found[0] : found, error: null }
    }
    const builder = {
      insert: p => { state.op = 'insert'; state.payload = p; return builder },
      update: p => { state.op = 'update'; state.payload = p; return builder },
      delete: () => { state.op = 'delete'; return builder },
      select: () => builder,
      eq: (k, v) => { state.filters.push([k, v]); return builder },
      order: col => { state.order = col; return builder },
      range: (a, b) => { state.range = [a, b]; return builder },
      limit: () => builder,
      single: () => { state.single = true; return builder },
      then: (res, rej) => exec().then(res, rej),
    }
    return builder
  }
  return { tables, from }
}
