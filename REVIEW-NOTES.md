# Ad Keywords workspace — review notes

Migrations 20261021/20261022 applied to production on 2026-10-21. Access control (20261023) is NOT applied — see SECURITY-ROLLOUT.md.

## Before deploying
1. **Apply the migrations in order** (Supabase → SQL Editor), both not yet applied to production:
   1. `supabase/migrations/20261021_keyword_projects.sql` — keyword_projects table + project columns on ad_keywords
   2. `supabase/migrations/20261022_gsc_evidence.sql` — GSC evidence columns on ad_keywords
   Both are idempotent and tested on Postgres 16 (`tests/migrations.test.js`): fresh database, upgrade after 20261021,
   upgrade from the combined 20261021 file that briefly shipped in the GSC-first build, re-runs in any order.
   Running 20261022 first fails with a clear message and changes nothing.
   Until they are applied, History shows analyses normally and a notice that projects are unavailable.
2. **Env vars** — see SECURITY-ROLLOUT.md (Supabase Auth replaces `VITE_ALLOWED_EMAILS`; server-side `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`).
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

## Target relevance and ad intent (src/shared/relevance.js)
One shared gate, used for seed selection, observed queries, derived themes and AI expansions — in the browser
AND on the server (`ad-keywords` actions `validate` and `keywords`). Generic overlap ("plant", "box", "well")
never makes a query relevant.
- Ad intent first: care/advice/growing-conditions questions, soil/growing media/supplies (unless the target is a
  supplies collection), products we don't sell and over-long queries are excluded; review/coupon research is held back.
- Gift Boxes: needs a gift word or recipient (or an occasion + plant/gift container), backed by plant gifts;
  non-plant gifts (wine, chocolate, …) and plain plant shopping are excluded.
- Succulents / Houseplants / Air Plants / Succulent Subscription: need their own anchors; queries anchored in
  another category (or gift/subscription intent) are kept out.
- Product: must share a distinctive word with the product (family words like "succulent" don't count).
  Collection: its own names/selected products. A collection whose title has qualifiers beyond its category
  ("Pet Safe Houseplants") must match them; only category-level collections ("Plant Gift Boxes") fall back to
  the category theme. Gift-themed targets also need gift/plant context.
- Buying questions ("where to buy succulent gift boxes") are buying intent; care/growing questions stay excluded.
  Plant-safety words ("pet safe") are a product attribute when buying or when the target has it.
- Any gifting intent (gift word, recipient, or occasion + plant) belongs to Gift Boxes only — "buy succulent gifts"
  is held out of Succulents.
- Generation re-checks target, evidence and seed selection after validation AND after the AI response;
  a stale response adds nothing.
- Only relevant seeds are selected; the rest are summarised ("Left out automatically") and optional to view.
- "Clean existing results" removes off-target keywords (all match types) and deselects off-target seeds;
  manually typed keywords are kept and counted.
- Root cause of the reported contamination: the Gift Boxes term "get well" was reduced to the single word
  "well" by the old matcher, so every "…do/grow well…" query matched.

## Known limitations
- Page-level evidence needs a live Search Console connection (Google tokens expire after ~1 hour — reconnect if asked).
- Relevance is rule-based (vocabularies in src/shared/relevance.js); unusual product names may need an alias to be recognised.
- Category mode has no page-level data (categories have no single URL); its evidence is always site-wide.
- Default category landing pages are set in `CATEGORY_LANDING_PAGES` — confirm they're the pages you want (editable per ad group).
- Headlines can be regenerated but not hand-edited in the table yet.
- No searchable catalog picker (URL input only, as scoped).
