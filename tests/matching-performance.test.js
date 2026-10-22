import { createStore, newProject, ensureCategoryGroups, findSeeds, updateGroup } from '../src/lib/workspace.js'
import { describe, it, expect } from 'vitest'
import { findSiteWideSeeds, findSiteWideSeedsAsync } from '../src/lib/seedMatching.js'
const target = { mode: 'category', category: 'Gift Boxes' }
const dataset = { source: 'gsc_api', dateStart: '2026-04-25', dateEnd: '2026-10-22' }
const rows = Array.from({ length: 1000 }, (_, i) => ({ query: `${i % 2 ? 'succulent gift box' : 'potting mix'} ${i}`, clicks: i % 3, impressions: i + 1, ctr: 0, position: 8 }))
const options = { relTarget: target }
const comparable = seeds => seeds.map(({ id, ...s }) => s)
describe('responsive evidence matching', () => {
  it('keeps the same results and ranking while yielding between batches', async () => {
    let yields = 0
    const progress = []
    const actual = await findSiteWideSeedsAsync(rows, target, dataset, {
      ...options, yieldToUI: async () => { yields++ }, onProgress: p => progress.push(p.done),
    })
    expect(comparable(actual)).toEqual(comparable(findSiteWideSeeds(rows, target, dataset, options)))
    expect(yields).toBeGreaterThan(1)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(rows.length)
  })
  it('throttles progress updates (each one re-renders the page)', async () => {
    const progress = []
    await findSiteWideSeedsAsync(rows, target, dataset, { ...options, yieldToUI: async () => {}, onProgress: p => progress.push(p.done), progressEveryMs: 60_000 })
    expect(progress).toEqual([0, rows.length])
  })
  it('stops work when its target or dataset is invalidated', async () => {
    let current = true
    const actual = await findSiteWideSeedsAsync(rows, target, dataset, {
      ...options, isCurrent: () => current,
      yieldToUI: async () => { current = false },
    })
    expect(actual).toBeNull()
  })
})


describe('interrupted matching state', () => {
  it('returns to idle when the target changes while matching yields', async () => {
    const store = createStore(ensureCategoryGroups(newProject(), ['Gift Boxes']))
    const id = store.getProject().adGroups[0].id
    const pending = findSeeds({ groupId: id, ...store, dataset: { ...dataset, queries: rows } })
    store.setProject(p => updateGroup(p, id, g => ({ ...g, aliases: ['changed target'] })))
    expect(await pending).toEqual({ discarded: true })
    expect(store.getProject().adGroups[0].seedStatus).toMatchObject({ state: 'none', progress: null, requestId: null })
  })
  it('does not clear a newer request when an older one is discarded', async () => {
    const store = createStore(ensureCategoryGroups(newProject(), ['Gift Boxes']))
    const id = store.getProject().adGroups[0].id
    const pending = findSeeds({ groupId: id, ...store, dataset: { ...dataset, queries: rows } })
    store.setProject(p => updateGroup(p, id, g => ({ ...g, seedStatus: { ...g.seedStatus, requestId: 'new-request', state: 'loading' } })))
    expect(await pending).toEqual({ discarded: true })
    expect(store.getProject().adGroups[0].seedStatus).toMatchObject({ state: 'loading', requestId: 'new-request' })
  })
})
