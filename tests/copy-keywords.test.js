import { describe, it, expect } from 'vitest'
import { newProject, ensureCategoryGroups, updateGroup, mergeKeywords, setMatchType, projectRows, rowsToKeywordText, rowsToTsv } from '../src/lib/workspace.js'

const project = () => {
  let p = ensureCategoryGroups(newProject(), ['Gift Boxes'])
  const id = p.adGroups[0].id
  p = updateGroup(p, id, g => mergeKeywords(g, ['succulent gift box', 'gift box for mother'], 'gsc_observed').group)
  return p
}

describe('copy keywords', () => {
  it('one keyword per line with match-type syntax, in table order, no duplicates', () => {
    const rows = projectRows(project())
    const text = rowsToKeywordText([...rows, rows[0]])
    const lines = text.split('\n')
    expect(lines).toEqual([...new Set(rows.map(r => r.keyword))])
    expect(lines).toContain('"succulent gift box"')
    expect(lines).toContain('[succulent gift box]')
  })
  it('broad match is plain text', () => {
    let p = project()
    p = setMatchType(p, p.adGroups[0].keywords.map(k => k.id), 'broad', true)
    expect(rowsToKeywordText(projectRows(p)).split('\n')).toContain('succulent gift box')
  })
  it('table: header + one tab-separated row per row, no stray tabs or newlines in cells', () => {
    const rows = projectRows(project())
    rows[0] = { ...rows[0], adGroup: 'Gift\tBoxes\nline' }
    const lines = rowsToTsv(rows).split('\n')
    expect(lines).toHaveLength(rows.length + 1)
    const cols = lines[0].split('\t').length
    expect(lines[0]).toMatch(/^Ad group\tCategory\tLanding page\tKeyword/)
    for (const l of lines) expect(l.split('\t')).toHaveLength(cols)
    expect(lines[1].split('\t')[0]).toBe('Gift Boxes line')
  })
})
