# Security rollout — SB Keyword Intelligence

Status: **implemented and tested locally only. Keep the branch off `main` until the prerequisites in
steps 1–2 are ready.** Production is **not** secured until every step
below is applied and the checks in step 6 pass. Nothing here has been deployed or migrated.

## What changes

| Area | Before | After |
| --- | --- | --- |
| Sign-in | Google ID token decoded in the browser, checked against `VITE_ALLOWED_EMAILS` (shipped in the bundle) | Supabase Auth (Google). Access decided in the database from a protected member list |
| Database | `using (true)` policies: the public publishable key could read, change and delete everything | Approved members only (all four commands); anon has no grants; members table and prompts closed to the API |
| Functions | `ad-keywords`, `fetch-page` open to anyone who could reach them | Verified session + membership + durable daily limit checked before any work; owner-only `members`, `prompts` |
| Prompts | SB brand context, templates, category focus and mode rules in the public repo (and brand context in the browser bundle) | Private, versioned rows in `app_prompt_versions`, read only by the server with the service-role key |
| Team | — | Owner (bootstrapped privately) approves / revokes members on the Team page; nobody can demote or remove the owner through the app |

Unchanged: keyword rules, GSC evidence, relevance and exclusions (incl. fertility/IVF), long-query themes,
stale-response guards, Search Console OAuth (separate token, `webmasters.readonly`), CSV upload,
save/load, copy and export. All existing rows stay and remain shared by the team.

## Environment variables (Netlify → Site configuration → Environment variables)

| Name | Scope | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Builds | `https://<project-ref>.supabase.co` (public) |
| `VITE_SUPABASE_ANON_KEY` | Builds | `<publishable/anon key>` (public by design) |
| `VITE_GOOGLE_CLIENT_ID` | Builds | `<client-id>.apps.googleusercontent.com` (Search Console connection) |
| `SUPABASE_URL` | Functions | same as `VITE_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | Functions | same as `VITE_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Functions | `<service-role or secret key>` — **never** a `VITE_` variable |
| `ANTHROPIC_API_KEY` | Functions | unchanged |
| ~~`VITE_ALLOWED_EMAILS`~~ | — | delete after rollout (no longer read) |

Total function env size stays far below the 4 KB Lambda limit; prompts are not stored in env vars.
Functions fail closed (503) if `SUPABASE_URL`/`SUPABASE_ANON_KEY` are missing, and generation fails with
"prompt configuration is missing" if the service key or an active prompt version is missing.

## Google / Supabase configuration

1. **Google Cloud → APIs & Services → Credentials** (OAuth 2.0 Web client used for sign-in; can be the
   existing client): add the authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`.
   Keep `https://sb-keyword-intelligence.netlify.app` as an authorized JavaScript origin (Search Console token).
2. **Supabase → Authentication → Sign In / Providers → Google**: enable, paste the client ID and secret.
   Scopes: defaults (openid, email, profile) only.
3. **Supabase → Authentication → URL Configuration**: Site URL `https://sb-keyword-intelligence.netlify.app`;
   Redirect URLs: the same URL (`https://sb-keyword-intelligence.netlify.app/**`).
4. **Supabase → Authentication → Providers**: disable Email (password), Phone and Anonymous sign-ins.
   Membership also requires a Google identity in the database, so an account created another way with the
   same address can't claim a membership — but there is no reason to leave the other providers on.
   Keep "Allow new users to sign up" on — a first Google sign-in only creates a *pending* request.
5. **Supabase → Data API**: exposed schemas stay `public` (+ `graphql_public`); do **not** expose `app_private`.

## Rollout order (short maintenance window, ~20 minutes)

1. **Back up and record** (read-only)
   - Supabase → Database → Backups: confirm a recent backup, or export the four tables
     (`gsc_uploads`, `search_queries`, `ad_keywords`, `keyword_projects`) as CSV from the Table editor.
   - Run `supabase/checks/rollout-inventory.sql` and save the output (current policies, grants, views,
     functions, other tables, row counts).
   - **Other apps:** section 4 of that file lists every table in the project. `ad_keywords` was described
     as feeding a "content engine". Check Supabase → Logs → API for requests to these tables that do not come
     from this app, over the last 7 days. Any such integration must move to a server-side key
     (service role / secret key, server only) **before** step 4 — do not keep public access for it.
2. **Configure** Google, Supabase Auth and the Netlify env vars above (no effect on the live app yet).
3. **Start the window.** Tell the team. Netlify password protection can stay on; it is not relied on.
4. **Apply the migration and bootstrap — before deploying.** SQL editor:
   - Paste and run `supabase/migrations/20261023_access_control.sql`. From this moment the old app can no
     longer read data (fail-closed). Note any "View … reads protected tables" notices: those views (including
     views built on other views) were closed to the API and need a review before anything is re-granted.
   - Owner membership (private procedure; type the address here, do not save it as a snippet):
     `select app_private.bootstrap_owner('<OWNER_EMAIL>');`
     This creates the owner row only. It is **not** linked to an account yet — that happens at the owner's
     first sign-in in step 6, which needs the new code. The old app cannot sign in through Supabase Auth.
   - Prompts, from a trusted machine with the private file (never committed to GitHub):
     `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-prompts.mjs <path>/sb-prompts.private.json --activate --note "initial import"`
5. **Deploy** the `security-hardening` branch (merge to `main` → Netlify build). Keep the window open and
   ask the team not to sign in yet.
6. **Owner's first sign-in, then verify**
   - The owner opens the site and signs in with Google using the bootstrapped address. This links the owner
     row to that Google account. Do this before anyone else signs in.
   - Owner checks: Team page shows the owner and prompt version 1 *Active* → History shows the existing
     analyses and projects → generate keywords for one ad group → save → reopen → copy/export.
   - Re-run `rollout-inventory.sql`: no `Public access …` policy; anon has no privileges; every dependent view
     (any depth — the inventory has no depth limit, like the migration) shows `anon_can_select = false`;
     row counts unchanged.
   - Anonymous: `curl "https://<ref>.supabase.co/rest/v1/keyword_projects?select=id" -H "apikey: <anon key>"`
     → permission denied (401/403), not rows.
   - `curl -X POST https://sb-keyword-intelligence.netlify.app/.netlify/functions/ad-keywords -d '{}'`
     → 401 (behind the Netlify password wall, include the wall's cookie or test from the browser console).
   - A Google account that is not approved → "Waiting for approval", no data.
7. **Approve the team** on the Team page (pending requests, or "Approve email" before they sign in);
   each member signs in and checks History. Then delete `VITE_ALLOWED_EMAILS`, end the window.

Daily limits per user (table `app_usage_limits`, editable in SQL): validate 5000, keywords 500,
headlines 500, fetch_page 1000, admin 1000.

## Rollback (data-preserving; never restores public access)

- The migration changes no rows, so data never needs restoring.
- **Sign-in broken** (Google/Supabase settings): fix the provider/redirect settings; the database stays closed
  meanwhile. Use Netlify password protection or a maintenance deploy to keep people out — do **not** add
  `using (true)` policies back.
- **App bug after deploy:** republish the previous Netlify deploy only as a maintenance page — it cannot read
  data under the new policies (fail-closed). Fix forward on the branch.
- **Owner locked out** (e.g. email changed): re-run `select app_private.bootstrap_owner('<OWNER_EMAIL>');`.
- **Bad prompt version:** Team → Prompts → *Activate* the previous version (versions are immutable).
- **A member must be blocked now:** Team → Revoke (or Decline a waiting request). Takes effect on the
  member's next request. "Remove" is only offered for people who never signed in — a removed account
  could simply request access again. A flood of requests: Team → "Discard all waiting requests".

## Historical exposure and cleanup plan (needs approval — nothing rewritten)

What has been public, and still is in Git history / old deploys:

| Exposure | Where | Since |
| --- | --- | --- |
| SB prompt text (brand context, keyword/headline templates, category focus, mode rules) | Git history: `netlify/functions/generate-headlines.js`, `src/lib/generateKeywords.js`, `netlify/lib/adKeywords.js`, `src/shared/keywordRules.js` | 2026-07-20 |
| Brand context in the browser bundle | every Netlify deploy until this change (deploy permalinks stay reachable, behind the site password) | 2026-07-20 |
| `VITE_ALLOWED_EMAILS` **values** | inlined by Vite into every deployed JS bundle built with it (not in Git) | 2026-07-21 |
| Owner email | Git commit author metadata (17 commits) | 2026-07-20 |
| Public read/write database access | anyone with the publishable key (which is in the bundle) | since `schema.sql` was applied |

Plan, in order:
1. **Assume the old prompts are known.** Decide whether to revise them; new versions go in via the Team page.
2. **Assume the database may have been read or modified** while public. After rollout, review recent
   rows/`updated_at` for anything unexpected; Supabase API logs (retention depends on plan) show past access.
3. **Old deploys:** delete superseded Netlify deploys (Netlify API `DELETE /api/v1/deploys/{id}`) so old bundles
   with the allowlist and brand text stop being served. Needs approval.
4. **Git history** (optional, needs approval): `git filter-repo` to drop the prompt text from the four files,
   force-push, ask GitHub Support to purge cached views and PR refs, and have every clone re-clone.
   Forks and existing clones keep the old history regardless (fork count not checked from here).
5. **Commit email:** enable GitHub "Keep my email addresses private" and "Block command line pushes that
   expose my email", and commit with the GitHub noreply address from now on.

## Not verified here (needs production access)

- The policies, grants and views actually present in production (only the committed SQL and the
  migrations applied on 2026-10-21 are known). Run `rollout-inventory.sql`.
- Whether another app reads these tables with the publishable key.
- Real Google OAuth round trip and Supabase Auth settings; real PostgREST/JWT verification (tested with a
  faithful stand-in that verifies HS256 signatures and expiry).
- Netlify function timeout setting in the UI and cold-start latency with the added auth call (~1 DB round trip).
- GitHub fork count.

## Remaining risks

- A signed-out session's access token stays valid until it expires (default 1 hour) for direct database
  reads; membership revocation, however, is enforced on every database query and function call.
- The publishable key and project URL remain public by design; protection rests on RLS — keep
  `rollout-inventory.sql` clean after any future schema change (new tables are granted to anon by default
  in Supabase; add policies or revoke).
- Category descriptions used for matching (`CATEGORY_DESCRIPTIONS`) stay in public code; they describe the
  public store, not prompt instructions.
- Prompt confidentiality is "not in the repo, not readable by members", not absolute: an approved member
  who crafts inputs could still coax fragments of a prompt into the model's output. Returned model text is
  bounded (3 headlines ≤ 60 characters per keyword; rejected keywords ≤ 80 characters, 30 per call) and
  usage is rate-limited, which makes copying slow, but treat the prompts as confidential-to-the-team.
- Owner-account compromise = full access. Use a strong Google account with 2-step verification.
