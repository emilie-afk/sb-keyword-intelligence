# Ad Keywords workspace — review notes

Release build (verified locally — not yet pushed, deployed, or migrated).

## Before deploying
1. **Apply the migrations in order** (Supabase → SQL Editor), both not yet applied to production:
   1. `supabase/migrations/20261021_keyword_projects.sql` — keyword_projects table + project columns on ad_keywords
   2. `supabase/migrations/20261022_gsc_evidence.sql` — GSC evidence columns on ad_keywords
   Both are idempotent and tested on Postgres 16 (`tests/migrations.test.js`): fresh database, upgrade after 20261021,
   upgrade from the combined 20261021 file that briefly shipped in the GSC-first build, re-runs in any order.
   Running 20261022 first fails with a clear message and changes nothing.
   Until they are applied, History shows analyses normally and a notice that projects are unavailable.
2. **Env vars** — unchanged: `ANTHROPIC_API_KEY` (server), `VITE_GOOGLE_CLIENT_ID`, `VITE_ALLOWED_EMAILS`,
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. No Shopify credentials needed.
3. **Netlify**: production is still on `5ed7452` (Jul 21). Later deploys failed because of
   `[functions] timeout = 26` in netlify.toml (invalid — set function timeouts in the Netlify UI) and, on `3295ba0`,
   the leftover `netlify/functions/get-keywords.js` (comment-only file treated as CommonJS). Both are removed in this build.
4. Run `npm test` and `npm run build`.

## How keyword generation works (GSC-first)
1. A GSC dataset is required to generate (Search Console connection or imported CSV). Pages can be previewed without it.
2. For each ad group the app finds real queries ("seeds"):
   - collection/product + Search Console: page-level queries for that URL (all URL variants), then site-wide matches
   - every mode: site-wide queries matched by the target's names, aliases, product type, tags, selected products and
     (weakly) descriptions — not by the five category labels, so a query can match several categories
   - no click/impression minimum; zero-click queries with impressions are kept
   - query-only CSV: matched by text, labelled "not data for this specific page"
3. The evidence table shows clicks, impressions, CTR, avg position, period, scope and why each query matched.
   Care/informational, branded and unrelated-plant queries stay visible but start unselected.
   Users can re-match with broader matching, aliases, a longer period (12/16 months, Search Console only) or add queries manually.
4. Generate: selected seeds become "Observed GSC query" keywords with their own metrics; the AI adds "AI expansion"
   keywords that must cite the seed(s) they come from and never carry metrics. No seeds → no generation (honest empty state).
5. Headlines, ad groups, landing pages, exports and project history work as before. Seeds and their evidence are saved with the project.

## Functions
- `netlify/functions/fetch-page.js` — loads a succulentsbox.com collection/product via Shopify's public
  storefront JSON (`/collections/<h>.json`, `/collections/<h>/products.json?page=N`, `/products/<h>.js`).
  Host allowlist on every request and redirect hop, 8 s per request, 18 s total, 429 handling, up to 2,000 products.
- `netlify/functions/ad-keywords.js` — `action: 'keywords'` (one ad group) or `action: 'headlines'` (≤ 10 keywords).
  One Claude call per request; headlines are validated server-side (3 × non-empty × ≤ 30 chars).
- Removed: `generate-headlines.js` (replaced) and `get-keywords.js` (empty).
- Shared rules: `src/shared/keywordRules.js` (categories, landing pages, exclusions, URL parsing, validation).

## Evidence integrity rules (pre-release review)
- Page-level queries use the dataset's reporting period (passed explicitly), paginate with startRow, and are
  labelled INCOMPLETE if the 100,000-row cap is reached. The site-wide dataset is paginated the same way.
- One seed per normalized query; page-level and site-wide evidence are separate rows and never summed.
  Spelling variants keep the larger row and note the other.
- Expired sign-in (401), missing permission (403), quota (429) and network failures show as errors and block
  generation — never as "no relevant queries".
- AI expansions must cite seeds that were selected and sent; invented/unselected references are rejected (server and client).
- Editing an observed query makes it a manual keyword with no metrics, recording `editedFrom`.
- Evidence is versioned: changing the URL, selected products, aliases, dataset or period makes it outdated
  (generation blocked until re-matched); late seed, AI and headline responses are discarded.

## Known limitations
- Page-level evidence needs a live Search Console connection (Google tokens expire after ~1 hour — reconnect if asked).
- Relevance matching is rule-based (terms, phrases, aliases); review the evidence table before generating.
- Category mode has no page-level data (categories have no single URL); its evidence is always site-wide.
- Default category landing pages are set in `CATEGORY_LANDING_PAGES` — confirm they're the pages you want (editable per ad group).
- Headlines can be regenerated but not hand-edited in the table yet.
- No searchable catalog picker (URL input only, as scoped).
