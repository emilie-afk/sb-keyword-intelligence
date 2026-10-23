// POST — validate keywords, or generate keywords / headlines for ONE ad group (one Claude call per request).
// Every action requires a verified Supabase session of an approved member (netlify/lib/auth.js),
// checked before any prompt load or Claude call. ANTHROPIC_API_KEY and the service-role key stay server-side.
import { anthropicCaller, handleRequest, ACTIONS } from '../lib/adKeywords.js'
import { protectedHandler, HttpError } from '../lib/auth.js'
import { loadPromptConfig } from '../lib/prompts.js'

export const handler = protectedHandler(
  { maxBodyBytes: 512 * 1024, action: body => (Object.hasOwn(ACTIONS, body?.action) ? ACTIONS[body.action] : null) },
  (body, { env, fetchImpl, modelFetch }) => handleRequest(body, {
    getModel: () => {
      if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'model_not_configured', 'Keyword generation is not configured on the server.')
      return anthropicCaller(env.ANTHROPIC_API_KEY, modelFetch || fetch)
    },
    getPrompts: () => loadPromptConfig({ env, fetchImpl }),
  }),
)
