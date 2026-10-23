// Owner-only prompt management (raw prompts are never returned to ordinary members).
//   POST { op: 'list' }                         -> { versions: [{ version, note, created_at, is_active }] }
//   POST { op: 'get', version }                 -> { version, config }
//   POST { op: 'create', config, note, activate } -> { version }   (versions are immutable)
//   POST { op: 'activate', version }            -> { ok }           (roll back to any earlier version)
// Reads/writes app_prompt_versions with the service-role key (server only).
import { protectedHandler, HttpError } from '../lib/auth.js'
import { PROMPT_NAME, validatePromptConfig, clearPromptCache } from '../lib/prompts.js'

async function rest(ctx, path, init = {}) {
  if (!ctx.cfg.serviceKey) throw new HttpError(503, 'not_configured', 'Prompt storage is not configured on the server.')
  let res
  try {
    res = await ctx.fetchImpl(`${ctx.cfg.url}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: ctx.cfg.serviceKey, Authorization: `Bearer ${ctx.cfg.serviceKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
  } catch {
    throw new HttpError(503, 'storage_unavailable', 'Prompt storage is unavailable. Please try again.')
  }
  if (!res.ok) throw new HttpError(502, 'storage_error', 'Prompt storage rejected the request.')
  return res.json().catch(() => null)
}

export const handler = protectedHandler({ maxBodyBytes: 128 * 1024, action: 'admin', requireOwner: true }, async (body, ctx) => {
  if (body.op === 'list') {
    const versions = await rest(ctx, `app_prompt_versions?name=eq.${PROMPT_NAME}&select=version,note,created_at,is_active&order=version.desc`)
    return { versions: versions || [] }
  }
  if (body.op === 'get') {
    const v = Number(body.version)
    if (!Number.isInteger(v) || v < 1) throw new HttpError(400, 'bad_request', 'Unknown version.')
    const [row] = (await rest(ctx, `app_prompt_versions?name=eq.${PROMPT_NAME}&version=eq.${v}&select=version,config,note,is_active`)) || []
    if (!row) throw new HttpError(404, 'not_found', 'Unknown version.')
    return row
  }
  if (body.op === 'create') {
    const problems = validatePromptConfig(body.config)
    if (problems.length) throw new HttpError(400, 'invalid_prompt', `Prompt configuration is invalid: ${problems.join('; ')}.`)
    const version = await rest(ctx, 'rpc/app_create_prompt_version', {
      method: 'POST',
      body: JSON.stringify({ p_name: PROMPT_NAME, p_config: body.config, p_note: String(body.note || '').slice(0, 300) || null, p_created_by: ctx.userId, p_activate: !!body.activate }),
    })
    clearPromptCache()
    return { version }
  }
  if (body.op === 'activate') {
    const v = Number(body.version)
    if (!Number.isInteger(v) || v < 1) throw new HttpError(400, 'bad_request', 'Unknown version.')
    await rest(ctx, 'rpc/app_activate_prompt_version', { method: 'POST', body: JSON.stringify({ p_name: PROMPT_NAME, p_version: v }) })
    clearPromptCache()
    return { ok: true }
  }
  throw new HttpError(400, 'bad_request', 'Unknown operation.')
})
