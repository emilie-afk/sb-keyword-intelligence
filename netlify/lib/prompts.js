// Private prompt configuration — loaded server-side from the protected table app_prompt_versions
// (service-role key, Netlify environment only). Nothing confidential lives in this repository:
// the brand context, generation templates, category focus and mode rules are runtime data.
// If no active configuration is available, generation fails clearly — there is no fallback text.
import { HttpError, supabaseConfig } from './auth.js'

export const PROMPT_NAME = 'ad_generation'
const CACHE_MS = 60_000 // prompts are not authorization data; a short per-instance cache is fine

// Shape of a prompt configuration (see config/prompts.example.json for a synthetic example)
export const REQUIRED_PLACEHOLDERS = {
  keywordTemplate: ['facts', 'seeds', 'count'],
  headlineTemplate: ['facts', 'keywords'],
}
const MAX_CONFIG_BYTES = 100_000

export function validatePromptConfig(config) {
  const problems = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['configuration must be a JSON object']
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_CONFIG_BYTES) problems.push(`configuration is larger than ${MAX_CONFIG_BYTES} bytes`)
  for (const [key, placeholders] of Object.entries(REQUIRED_PLACEHOLDERS)) {
    if (typeof config[key] !== 'string' || !config[key].trim()) { problems.push(`${key} is required`); continue }
    for (const p of placeholders) if (!config[key].includes(`{{${p}}}`)) problems.push(`${key} must contain {{${p}}}`)
    if (/Respond (with )?ONLY/i.test(config[key])) problems.push(`${key} must not include the response-format line (the server appends it)`)
  }
  for (const key of ['categoryFocus', 'modeRules']) {
    if (config[key] != null && (typeof config[key] !== 'object' || Array.isArray(config[key]) ||
        Object.values(config[key]).some(v => typeof v !== 'string'))) problems.push(`${key} must map names to text`)
  }
  if (config.brandContext != null && typeof config.brandContext !== 'string') problems.push('brandContext must be text')
  return problems
}

// {{name}} placeholders, single pass: values inserted from page data are never re-scanned
export function renderTemplate(template, vars) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])))
}

let cache = null
export const clearPromptCache = () => { cache = null }

export async function loadPromptConfig({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const cfg = supabaseConfig(env)
  const unavailable = new HttpError(503, 'prompts_unavailable', 'Keyword generation is not configured yet: the prompt configuration is missing. Ask the owner to import it.')
  if (!cfg.url || !cfg.serviceKey) throw unavailable
  if (cache && cache.url === cfg.url && now - cache.at < CACHE_MS) return cache.value
  let res
  try {
    res = await fetchImpl(`${cfg.url}/rest/v1/app_prompt_versions?name=eq.${PROMPT_NAME}&is_active=is.true&select=version,config`, {
      headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, Accept: 'application/json' },
    })
  } catch {
    throw unavailable
  }
  if (!res.ok) throw unavailable
  const rows = await res.json().catch(() => [])
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || validatePromptConfig(row.config).length) throw unavailable
  cache = { at: now, url: cfg.url, value: { version: row.version, ...row.config } }
  return cache.value
}
