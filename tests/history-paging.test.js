// Reopening a saved analysis must load every row, not just the API's first 1,000.
import { describe, it, expect, afterEach } from 'vitest'
import { setClient, loadUploadQueries, loadUploadKeywords } from '../src/lib/supabase.js'
import { mockSupabase } from './helpers.js'

function seed(db, n, table = 'search_queries') {
  for (let i = 0; i < n; i++) db.tables[table].push({ id: `r${String(i).padStart(6, '0')}`, upload_id: 'u1', query: `q${i}`, keyword: `k${i}` })
  db.tables[table].push({ id: 'other', upload_id: 'u2', query: 'not this upload', keyword: 'x' })
}

describe('History reload paging', () => {
  afterEach(() => setClient(null))

  it('loads all 25,000 queries of an upload (server returns at most 1,000 per request)', async () => {
    const db = mockSupabase()
    seed(db, 25000)
    setClient(db)
    const rows = await loadUploadQueries('u1')
    expect(rows).toHaveLength(25000)
    expect(new Set(rows.map(r => r.id)).size).toBe(25000) // no duplicates or gaps between pages
    expect(rows.every(r => r.upload_id === 'u1')).toBe(true)
  })

  it('still loads everything when the server cap is lower than the page size', async () => {
    const db = mockSupabase({ maxRows: 300 })
    seed(db, 2500)
    setClient(db)
    expect(await loadUploadQueries('u1')).toHaveLength(2500)
  })

  it('keywords are paged the same way; exact multiples and empty uploads work', async () => {
    const db = mockSupabase()
    seed(db, 2000, 'ad_keywords')
    setClient(db)
    expect(await loadUploadKeywords('u1')).toHaveLength(2000)
    expect(await loadUploadKeywords('none')).toEqual([])
  })

  it('loads pages concurrently after the first (count) request, in order, with no gaps', async () => {
    const db = mockSupabase()
    seed(db, 25000)
    setClient(db)
    let inFlight = 0
    let peak = 0
    const realFrom = db.from
    setClient({ from: t => {
      const b = realFrom(t)
      const then = b.then
      b.then = (res, rej) => { inFlight++; peak = Math.max(peak, inFlight); return new Promise(r => setTimeout(r, 1)).then(() => then.call(b, v => { inFlight--; return res(v) }, rej)) }
      return b
    } })
    const rows = await loadUploadQueries('u1')
    expect(rows.map(r => r.query)).toEqual(Array.from({ length: 25000 }, (_, i) => `q${i}`))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(6)
    expect(db.calls.filter(c => c.table === 'search_queries')).toHaveLength(25)
  })

  it('falls back to reading page after page if the count does not match what arrives', async () => {
    const db = mockSupabase()
    seed(db, 2500)
    const realFrom = db.from
    let first = true
    setClient({ from: t => {
      const b = realFrom(t)
      const then = b.then
      b.then = (res, rej) => then.call(b, v => {
        if (first && v.count != null) { first = false; return res({ ...v, count: 3000 }) } // stale count
        return res(v)
      }, rej)
      return b
    } })
    expect(await loadUploadQueries('u1')).toHaveLength(2500)
  })

  it('errors are not swallowed', async () => {
    setClient({ from: () => { const b = { select: () => b, eq: () => b, order: () => b, range: () => Promise.resolve({ data: null, error: new Error('permission denied') }) }; return b } })
    await expect(loadUploadQueries('u1')).rejects.toThrow('permission denied')
  })
})
