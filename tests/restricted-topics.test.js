// Google Ads restricted category "Birth Control, Fertility, and Testing": never advertise on fertility/IVF terms
import { describe, it, expect } from 'vitest'
import { TEST_PROMPTS } from './helpers.js'
import { assessKeyword, validateKeywords } from '../src/shared/relevance.js'
import { restrictedTopic, checkKeywordEligibility, validateHeadlines } from '../src/shared/keywordRules.js'
import { newProject, ensureCategoryGroups, updateGroup, mergeKeywords, editKeyword, cleanProject } from '../src/lib/workspace.js'
import { generateKeywords } from '../netlify/lib/adKeywords.js'

const RESTRICTED = ['ivf gift box', 'IVF transfer day gift', 'fertility plant gift', 'fertility succulent', 'gifts for infertility',
  'infertile friend gift', 'in vitro gift ideas', 'embryo transfer gift', 'egg retrieval care package', 'succulent gift box ivf']
const FINE = ['succulent gift box', 'fertilizer for succulents gift', 'ivy plant gift', 'festive plant gift']

describe('fertility / IVF keywords are skipped everywhere', () => {
  it('detects restricted terms only as whole words', () => {
    for (const q of RESTRICTED) expect(restrictedTopic(q), q).toBeTruthy()
    for (const q of FINE) expect(restrictedTopic(q), q).toBeNull()
  })
  it('relevance gate excludes them in every mode, even when otherwise relevant', () => {
    for (const q of RESTRICTED) {
      for (const t of [{ mode: 'category', category: 'Gift Boxes' }, { mode: 'collection', category: 'Gift Boxes', text: 'IVF Gift Box ivf' }]) {
        expect(assessKeyword(q, t), q).toMatchObject({ verdict: 'excluded', reason: 'restricted' })
      }
    }
    expect(assessKeyword('succulent gift box', { mode: 'category', category: 'Gift Boxes' }).verdict).toBe('relevant')
    expect(checkKeywordEligibility('ivf gift box', 'category').ok).toBe(false)
  })
  it('server validation rejects them', () => {
    const r = validateKeywords(['ivf gift box', 'succulent gift box'], { mode: 'category', category: 'Gift Boxes', context: {} })
    expect(r.accepted).toEqual(['succulent gift box'])
    expect(r.rejected[0]).toMatchObject({ keyword: 'ivf gift box', reason: 'restricted' })
  })
  it('AI expansions with restricted terms are dropped, and restricted seeds never reach the prompt', async () => {
    let prompt = ''
    const model = async p => { prompt = p; return { expansions: [{ keyword: 'ivf succulent gift box', seeds: [1] }, { keyword: 'succulent gift set', seeds: [1] }] } }
    const adGroup = { mode: 'category', name: 'Gift Boxes', category: 'Gift Boxes', landingUrl: 'x', context: {} }
    const res = await generateKeywords({ adGroup, seeds: [{ query: 'succulent gift box' }, { query: 'ivf gift box' }] }, model, TEST_PROMPTS)
    expect(prompt).not.toContain('ivf gift box')
    expect(prompt).toMatch(/Respond with ONLY valid JSON/) // response format is fixed in code
    expect(res.keywords.map(k => k.keyword)).toEqual(['succulent gift set'])
  })
  it('cannot be added or edited in manually; Clean removes them even if typed in', () => {
    let p = ensureCategoryGroups(newProject(), ['Gift Boxes'])
    const id = p.adGroups[0].id
    const r = mergeKeywords(p.adGroups[0], ['ivf gift box', 'my gift idea'], 'manual')
    expect(r.restricted).toBe(1)
    expect(r.group.keywords.map(k => k.base)).toEqual(['my gift idea'])
    const edited = editKeyword(r.group, r.group.keywords[0].id, 'fertility gift idea')
    expect(edited.keywords[0].base).toBe('my gift idea')
    // legacy project saved before this rule
    p = updateGroup(p, id, g => ({ ...g, keywords: [...r.group.keywords, { ...r.group.keywords[0], id: 'old', base: 'ivf transfer gift', source: 'manual' }] }))
    const cleaned = cleanProject(p)
    expect(cleaned.project.adGroups[0].keywords.map(k => k.base)).toEqual(['my gift idea'])
    expect(cleaned.groups[0].excluded.restricted.count).toBe(1)
  })
  it('headlines mentioning them are flagged', () => {
    expect(validateHeadlines(['Gifts for your IVF journey', 'Fresh succulents', 'Ships fast']).valid).toBe(false)
    expect(validateHeadlines(['Fresh succulent gifts', 'Ships ready to gift', 'Shop live plants']).valid).toBe(true)
  })
})
