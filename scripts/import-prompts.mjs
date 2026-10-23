#!/usr/bin/env node
// Private procedure: import a prompt configuration into Supabase as a NEW version (versions are immutable).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-prompts.mjs <path/to/prompts.private.json> [--activate] [--note "text"]
//
// Run it on a trusted machine. The JSON file and the service-role key must never be committed
// (private/ and *.private.json are git-ignored). Nothing is printed except the new version number.
import { readFileSync } from 'node:fs'
import { validatePromptConfig, PROMPT_NAME } from '../netlify/lib/prompts.js'

const [file, ...rest] = process.argv.slice(2)
const activate = rest.includes('--activate')
const noteAt = rest.indexOf('--note')
const note = noteAt >= 0 ? rest[noteAt + 1] : `imported ${new Date().toISOString()}`
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
if (!file || !url || !key) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-prompts.mjs <file.json> [--activate] [--note "text"]')
  process.exit(1)
}
const config = JSON.parse(readFileSync(file, 'utf8'))
delete config._comment
const problems = validatePromptConfig(config)
if (problems.length) {
  console.error(`Not imported — ${problems.join('; ')}`)
  process.exit(1)
}
const res = await fetch(`${url}/rest/v1/rpc/app_create_prompt_version`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_name: PROMPT_NAME, p_config: config, p_note: note, p_created_by: null, p_activate: activate }),
})
if (!res.ok) {
  console.error(`Not imported — Supabase answered HTTP ${res.status}. Was 20261023_access_control.sql applied?`)
  process.exit(1)
}
console.log(`Imported prompt version ${await res.json()}${activate ? ' (active)' : ' (inactive — activate it from the Prompts page or re-run with --activate)'}`)
