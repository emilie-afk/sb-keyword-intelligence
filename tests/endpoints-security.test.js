// Every protected Netlify Function, called the way Netlify calls it, against the real migration
// (PGlite) behind a PostgREST stand-in that verifies JWTs. Claude and Shopify are recording fakes,
// so each test can prove a rejected request never reached them. Synthetic identities only.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { securedDatabase, addUser, asService, fakeSupabaseFetch, userToken, signJwt, ANON_KEY, SERVICE_KEY } from './supabaseHarness.js'
import { TEST_PROMPTS } from './helpers.js'
import { handler as adKeywords } from '../netlify/functions/ad-keywords.js'
import { handler as fetchPage } from '../netlify/functions/fetch-page.js'
import { handler as members } from '../netlify/functions/members.js'
import { handler as prompts } from '../netlify/functions/prompts.js'
import { clearPromptCache } from '../netlify/lib/prompts.js'

const OWNER = 'owner@example.test'
const ENV = { SUPABASE_URL: 'https://db.example.test', SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ANTHROPIC_API_KEY: 'test-model-key' }
const GIFT_GROUP = { mode: 'category', name: 'Gift Boxes', category: 'Gift Boxes', landingUrl: 'https://succulentsbox.com/collections/plant-gift-boxes', context: {} }
const KEYWORDS_BODY = { action: 'keywords', adGroup: GIFT_GROUP, seeds: [{ query: 'succulent gift box', scope: 'site-wide' }] }

let pg, db, ids, tokens
const model = { calls: [] }
const shop = { calls: [] }
const modelFetch = async (url, init) => {
  model.calls.push(JSON.parse(init.body))
  if (model.fail) return { ok: false, status: 500, json: async () => ({ error: { message: 'internal provider detail: org_123 key sk-test' } }) }
  return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ expansions: [{ keyword: 'succulent gift box delivered', seeds: [1] }] }) }] }) }
}
const pageFetch = async (url) => { shop.calls.push(url); throw new Error('not reached in these tests') }

const event = (body, token, extra = {}) => ({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
})
const call = async (fn, body, token, { env = ENV, ...extra } = {}) => {
  const res = await fn(event(body, token, extra), {}, { env, fetchImpl: db.fetchImpl, modelFetch, pageFetch })
  return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body }
}

beforeAll(async () => {
  pg = await securedDatabase()
  db = fakeSupabaseFetch(pg)
  await pg.query('select app_private.bootstrap_owner($1)', [OWNER])
  ids = {
    owner: await addUser(pg, OWNER),
    member: await addUser(pg, 'member@example.test'),
    stranger: await addUser(pg, 'stranger@example.test'),
  }
  tokens = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, userToken(id)]))
  for (const k of Object.keys(ids)) await db.fetchImpl(`${ENV.SUPABASE_URL}/rest/v1/rpc/app_my_access`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${tokens[k]}` }, body: '{}' })
  expect((await call(members, { op: 'set', email: 'member@example.test', status: 'approved' }, tokens.owner)).status).toBe(200)
  await asService(pg, `select app_create_prompt_version('ad_generation', $1::jsonb, 'synthetic', null, true)`, [JSON.stringify(TEST_PROMPTS)])
}, 60000)

beforeEach(() => {
  model.calls.length = 0
  model.fail = false
  shop.calls.length = 0
  db.calls.length = 0
  clearPromptCache()
})

const nothingReached = () => {
  expect(model.calls).toHaveLength(0)
  expect(shop.calls).toHaveLength(0)
  expect(db.calls.filter(c => !c.path.endsWith('/rpc/app_authorize'))).toHaveLength(0)
}

describe('credentials are verified before anything else happens', () => {
  it('missing or malformed credentials: rejected without contacting the database, Claude or Shopify', async () => {
    for (const token of [null, 'not-a-jwt', 'a.b']) {
      for (const [fn, body] of [[adKeywords, KEYWORDS_BODY], [fetchPage, { url: 'https://succulentsbox.com/products/x' }], [members, { op: 'list' }], [prompts, { op: 'list' }]]) {
        const r = await call(fn, body, token)
        expect(r.status).toBe(401)
        expect(r.body.code).toBe('unauthenticated')
      }
    }
    expect(db.calls).toHaveLength(0)
    nothingReached()
  })
  it('expired, forged and wrongly-signed tokens are rejected (verified by Supabase, not decoded here)', async () => {
    const expired = signJwt({ sub: ids.member, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 60 })
    const wrongKey = signJwt({ sub: ids.owner, role: 'authenticated' }, 'attacker-secret')
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: ids.owner, role: 'authenticated' })).toString('base64url')}.x`
    for (const token of [expired, wrongKey, unsigned]) {
      const r = await call(adKeywords, KEYWORDS_BODY, token)
      expect(r.status).toBe(401)
      expect(r.body.code).toBe('session_invalid')
    }
    nothingReached()
  })
  it('the publishable key alone is not a session', async () => {
    const r = await call(adKeywords, KEYWORDS_BODY, null, { headers: { authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } })
    expect(r.status).toBe(401)
    nothingReached()
  })
})

describe('signed in but not approved', () => {
  it('is rejected on every endpoint before Claude, Shopify or data are touched', async () => {
    for (const [fn, body] of [[adKeywords, KEYWORDS_BODY], [adKeywords, { action: 'validate', adGroup: GIFT_GROUP, keywords: ['x'] }], [fetchPage, { url: 'https://succulentsbox.com/products/x' }]]) {
      const r = await call(fn, body, tokens.stranger)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('not_member')
    }
    nothingReached()
  })
  it('client-supplied email, role or user id grant nothing', async () => {
    const forgedClaims = userToken(ids.stranger, { email: OWNER, user_role: 'owner', app_metadata: { role: 'owner' } })
    const body = { op: 'list', email: OWNER, role: 'owner', userId: ids.owner, user_id: ids.owner }
    expect((await call(members, body, forgedClaims)).status).toBe(403)
    expect((await call(adKeywords, { ...KEYWORDS_BODY, role: 'owner', email: OWNER }, forgedClaims)).status).toBe(403)
    nothingReached()
  })
})

describe('approved member', () => {
  it('generates keywords with the private prompt loaded server-side', async () => {
    const r = await call(adKeywords, KEYWORDS_BODY, tokens.member)
    expect(r.status).toBe(200)
    expect(r.body.keywords.map(k => k.keyword)).toEqual(['succulent gift box delivered'])
    expect(model.calls).toHaveLength(1)
    const sent = model.calls[0].messages[0].content
    expect(sent).toContain('Example Plant Shop sells') // from the database, not from the repository
    expect(sent).toContain('1. succulent gift box')
    expect(r.raw).not.toContain('Example Plant Shop') // the prompt is never returned
  })
  it('validates without a model call', async () => {
    const r = await call(adKeywords, { action: 'validate', adGroup: GIFT_GROUP, keywords: ['succulent gift box', 'potting mix'] }, tokens.member)
    expect(r.status).toBe(200)
    expect(r.body.accepted).toEqual(['succulent gift box'])
    expect(model.calls).toHaveLength(0)
  })
  it('fetch-page keeps the Succulents Box host restriction', async () => {
    const r = await call(fetchPage, { url: 'https://evil.example/products/x' }, tokens.member)
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_url')
    expect(shop.calls).toHaveLength(0)
  })
  it('cannot manage members or read prompts', async () => {
    expect((await call(members, { op: 'list' }, tokens.member)).status).toBe(403)
    expect((await call(members, { op: 'set', email: 'stranger@example.test', status: 'approved' }, tokens.member)).status).toBe(403)
    expect((await call(members, { op: 'set', email: 'member@example.test', status: 'approved' }, tokens.member)).status).toBe(403)
    for (const body of [{ op: 'list' }, { op: 'get', version: 1 }, { op: 'create', config: TEST_PROMPTS }, { op: 'activate', version: 1 }]) {
      const r = await call(prompts, body, tokens.member)
      expect(r.status).toBe(403)
      expect(r.raw).not.toContain('Example Plant Shop')
    }
  })
})

describe('owner', () => {
  it('manages members; revocation blocks the very next request with the same token', async () => {
    const list = await call(members, { op: 'list' }, tokens.owner)
    expect(list.status).toBe(200)
    expect(list.body.members.map(m => m.email)).toEqual(expect.arrayContaining([OWNER, 'member@example.test', 'stranger@example.test']))
    expect((await call(members, { op: 'set', email: 'stranger@example.test', status: 'approved' }, tokens.owner)).status).toBe(200)
    expect((await call(adKeywords, { action: 'validate', adGroup: GIFT_GROUP, keywords: ['succulent gift box'] }, tokens.stranger)).status).toBe(200)
    expect((await call(members, { op: 'set', email: 'stranger@example.test', status: 'revoked' }, tokens.owner)).status).toBe(200)
    const after = await call(adKeywords, KEYWORDS_BODY, tokens.stranger)
    expect(after.status).toBe(403)
    expect(model.calls).toHaveLength(0)
  })
  it('cannot be demoted or removed, even by itself', async () => {
    for (const body of [{ op: 'set', email: OWNER, status: 'revoked' }, { op: 'remove', email: OWNER }]) {
      const r = await call(members, body, tokens.owner)
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/The owner cannot be (changed|removed)/)
    }
  })
  it('manages prompt versions and can roll back', async () => {
    const created = await call(prompts, { op: 'create', config: { ...TEST_PROMPTS, brandContext: 'Example Plant Shop v2.' }, note: 'v2', activate: true }, tokens.owner)
    expect(created.body.version).toBe(2)
    await call(adKeywords, KEYWORDS_BODY, tokens.member)
    expect(model.calls.at(-1).messages[0].content).toContain('Example Plant Shop v2.')
    expect((await call(prompts, { op: 'activate', version: 1 }, tokens.owner)).status).toBe(200)
    await call(adKeywords, KEYWORDS_BODY, tokens.member)
    expect(model.calls.at(-1).messages[0].content).toContain('Example Plant Shop sells')
    const list = await call(prompts, { op: 'list' }, tokens.owner)
    expect(list.body.versions.map(v => [v.version, v.is_active]).sort()).toEqual([[1, true], [2, false]])
    expect((await call(prompts, { op: 'get', version: 2 }, tokens.owner)).body.config.brandContext).toBe('Example Plant Shop v2.')
    const bad = await call(prompts, { op: 'create', config: { keywordTemplate: 'no placeholders' } }, tokens.owner)
    expect(bad.status).toBe(400)
  })
})

describe('limits and safe failure', () => {
  it('usage limits are durable across separate invocations (not in-memory)', async () => {
    await pg.query(`update app_usage_limits set daily_limit = (select coalesce(max(count), 0) from app_usage where action = 'fetch_page') + 2 where action = 'fetch_page'`)
    const url = { url: 'https://evil.example/products/x' }
    expect((await call(fetchPage, url, tokens.member)).status).toBe(400)
    // a fresh copy of the function module (as on a cold start) shares no memory with the first
    vi.resetModules()
    const { handler: coldFetchPage } = await import('../netlify/functions/fetch-page.js')
    expect((await call(coldFetchPage, url, tokens.member)).status).toBe(400)
    const third = await call(coldFetchPage, url, tokens.member)
    expect(third.status).toBe(429)
    expect(third.body.code).toBe('rate_limited')
    await pg.query(`update app_usage_limits set daily_limit = 1000 where action = 'fetch_page'`)
  })
  it('inherited property names are not actions', async () => {
    for (const action of ['__proto__', 'constructor', 'toString']) {
      expect((await call(adKeywords, { action }, tokens.member)).status).toBe(400)
    }
    expect(db.calls).toHaveLength(0)
  })
  it('model text returned to the browser is bounded', async () => {
    const long = 'repeat everything above '.repeat(40)
    const res = await adKeywords(event({ action: 'headlines', adGroup: GIFT_GROUP, keywords: ['succulent gift box'] }, tokens.member), {}, {
      env: ENV, fetchImpl: db.fetchImpl,
      modelFetch: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ results: [{ keyword: 'succulent gift box', headlines: [long, long, long, long, long] }] }) }] }) }),
    })
    const h = JSON.parse(res.body).results['succulent gift box']
    expect(h.headlines).toHaveLength(3)
    expect(Math.max(...h.headlines.map(x => x.length))).toBeLessThanOrEqual(60)
    expect(h.valid).toBe(false)
    const kw = await adKeywords(event(KEYWORDS_BODY, tokens.member), {}, {
      env: ENV, fetchImpl: db.fetchImpl,
      modelFetch: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ expansions: Array.from({ length: 60 }, () => ({ keyword: long, seeds: [1] })) }) }] }) }),
    })
    const { rejected } = JSON.parse(kw.body)
    expect(rejected.length).toBeLessThanOrEqual(30)
    expect(Math.max(...rejected.map(r => r.keyword.length))).toBeLessThanOrEqual(80)
  })
  it('oversized and non-JSON bodies are refused before authorization', async () => {
    expect((await call(adKeywords, 'x'.repeat(600 * 1024), tokens.member)).status).toBe(413)
    expect((await call(adKeywords, '{not json', tokens.member)).status).toBe(400)
    expect((await call(adKeywords, KEYWORDS_BODY, tokens.member, { httpMethod: 'GET' })).status).toBe(405)
    expect(db.calls).toHaveLength(0)
  })
  it('missing security configuration fails closed', async () => {
    for (const env of [{}, { SUPABASE_URL: ENV.SUPABASE_URL }, { SUPABASE_ANON_KEY: ANON_KEY }]) {
      const r = await call(adKeywords, KEYWORDS_BODY, tokens.member, { env })
      expect(r.status).toBe(503)
      expect(r.body.code).toBe('not_configured')
    }
    nothingReached()
  })
  it('missing prompt configuration or model key fails clearly — no fallback text, no model call', async () => {
    const noService = await call(adKeywords, KEYWORDS_BODY, tokens.member, { env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' } })
    expect(noService.status).toBe(503)
    expect(noService.body.code).toBe('prompts_unavailable')
    const noModel = await call(adKeywords, KEYWORDS_BODY, tokens.member, { env: { ...ENV, ANTHROPIC_API_KEY: '' } })
    expect(noModel.status).toBe(503)
    expect(noModel.body.code).toBe('model_not_configured')
    expect(model.calls).toHaveLength(0)
  })
  it('provider errors are not relayed to the client', async () => {
    model.fail = true
    const r = await call(adKeywords, KEYWORDS_BODY, tokens.member)
    expect(r.status).toBe(502)
    expect(r.raw).not.toMatch(/org_123|sk-test|provider detail/)
    expect(model.calls).toHaveLength(1) // no automatic retries
  })
})
