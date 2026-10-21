# Master Engines

Three consolidated Apify Actors that replace a fleet of single-source Actors. One shared runtime, one delta-memory
format, one set of billing guards; each source is a small connector.

| Engine | Active sources | Held (registered, refused with a reason) |
|---|---|---|
| `global-regtech-compliance-feed` | `ofac`, `world_bank_debarred`, `uk_modern_slavery`, `sec_enforcement`, `ai_crawler_signals`, `fda_ema_recalls` | `paris_mou_thetis`, `tokyo_mou_apcis`, `imo_gisis` |
| `latam-global-tender-intelligence` | `ar_santafe`, `ar_tucuman`, `ar_entrerios`, `cl_diario_oficial`, `eu_ted`, `us_florida`, `world_bank_notices`, `it_lombardia_grants` | `ar_cordoba`, `ar_salta`, `ar_mendoza`, `ar_pba`, `au_grantconnect`, `adb_procurement`, `idb_procurement` |
| `global-corporate-patent-intelligence` | `uspto_ptab`, `epo_opposition`, `clinicaltrials_orange_book`, `sg_acra`, `ae_registers` | none |

19 active and 10 held connectors in total. The strategy, governance and remediation matrices live in
[`../docs/apify_portfolio_refactor_strategy_2026.md`](../docs/apify_portfolio_refactor_strategy_2026.md).
The Apify pay-per-event policy research (with citations) is in
[`docs-research/apify-ppe-policy-verification.md`](docs-research/apify-ppe-policy-verification.md).

## Layout

```
lib/
  types.ts               Connector / SourceRecord / HttpClient contracts, RunSummary
  _guards.ts             watchlist keyword sanitiser + matcher (the ghost-billing remediation)
  router_core.ts         preflight, per-source options, delta modes, emit + billing, state
  charging.ts            PPE guard rails (WatchlistHitBiller, price validation)
  charge_watchlist_hit.ts  drop-in guarded Actor.charge('watchlist-hit')
  state.ts               delta memory (seenIds + fingerprints per source) and the delivery journal
  lease.ts               run leases: one live run per (namespace, source)
  secrets.ts             credential collection and central scrubbing of logs, warnings and errors
  engine_main.ts         runEngineMain: Actor.init, input, run, summary, exit status
  http.ts                shared client: retries, Retry-After, body cap, redirect validation, getRaw
  safe_text.ts           linear-time text helpers that replace quadratic regexes on hostile text
  apify_adapters.ts      the only file that imports the apify SDK
  connector_helpers.ts   fingerprintOf, dateRangeToFrom, createHeldConnector
pricing/
  event_catalog.ts       single source of truth for per-source PPE events and prices (with evidence)
  apply_billing.ts       stamps connectors with their catalog events
  build_put_payloads.ts  validated PUT /v2/actors/{id} bodies + 14-day notice metadata
  payloads/              generated bodies, kept in sync by a test
<engine>/
  index.ts               explicit connector registry (never glob)
  main.ts                one line: runEngineMain(engine, userAgent)
  connectors/            one file per source (+ held registries)
  .actor/                generated: actor.json, input_schema.json, Dockerfile
scripts/                 generate_pricing_payloads, generate_actor_files, stage_actor, redos_audit (+ second opinion),
                         generate_distribution_data, audit_pricing_exposure, audit_unit_economics
distribution/            Python SDK + LangChain tools, n8n templates, a differential fuzz (see its README)
test/                    fixture-driven, no network; support/ holds real-SDK child processes, the fault-injection
                         platform, a platform-like key-value double and a mock of the Apify REST API
```

## Running an engine

Input (all engines):

```jsonc
{
  "sources": ["sec_enforcement", "fda_ema_recalls"],      // active ids only; a held id fails the whole run before any request
  "sourceOptions": { "fda_ema_recalls": { "subSources": ["fda"] } },
  "deltaMode": "onlyChanged",                              // all | onlyChanged | onlyNew
  "maxItemsPerSource": 500,
  "watchlistNames": ["Acme Corp"],                         // blank, invisible-only, one-letter ("a", "c."), punctuation-only,
                                                           // over-200-character and malformed entries are dropped and reported
  "maxWatchlistHitsPerRun": 200,
  "maxWatchlistSpendUsd": 50,
  "stateNamespace": "weekly-eu",                           // optional; default one per Task, "default" for ad-hoc runs
  "fdaApiKey": "..."                                       // BYOK credentials are top-level isSecret fields
}
```

`deltaMode`: `onlyNew` = first sighting only; `onlyChanged` = first sighting + changed (this is what the legacy actors
called `onlyNew: true`); `all` = everything, unchanged records included (tagged `delta_status: "unchanged"`).

Every dataset row carries `engine`, `source`, `record_id`, `delta_status`, `is_new`, `is_watchlist_match`,
`matched_watchlist_keyword`, `scraped_at` on top of the connector's own fields. A `RUN_SUMMARY` key-value record holds
per-source counts, `warnings` (non-fatal problems such as one sub-source being down) and watchlist accounting.

A failed preflight (unknown or held source, missing credential, invalid option, or a pricing that prices
`apify-default-dataset-item`) ends the run `FAILED` with the full list of problems, before any network request or
billable event. A run in which every selected source failed and nothing was delivered also ends `FAILED`, with one
line per source; if at least one source answered (even with zero records) the run is `SUCCEEDED` and the per-source
errors stay on `RUN_SUMMARY`.

**Delta memory** is one key-value record per source, `state.<namespace>.<source>`, in the store `<engine>-delta-state`.
Separate Tasks get separate memory (`stateNamespace`, default `task-<id>`), so they cannot consume each other's "new"
records. It is checkpointed every 25 emitted rows and in a `finally`, and a small delivery journal
(`journal.<namespace>.<source>`) is rewritten after every row that was pushed and billed: delivery is at-least-once, and
after a hard kill at most the one row in flight can be delivered (and billed) again. A memory or journal record that
exists but cannot be read fails its own source (it is never treated as empty); delete it to start the source from scratch.

**One live run per namespace and source.** A run takes a lease (`lease.<namespace>.<source>`) before it reads any state;
a second run of the same namespace is refused with `LeaseConflictError` before any request or charge, and a run whose
lease was taken over stops before its next push. This is best effort (the key-value store has no compare-and-set); give
a concurrent run its own `stateNamespace`. See the strategy document, sections 2.2 and 9.

**Billing.** Every source bills its own event (see `pricing/event_catalog.ts`). `RUN_SUMMARY.pricing.unpricedEvents`
lists any event this run could bill that has no positive price in the Actor's live pricing (those rows are free).

## Commands

```bash
npm install
npm run typecheck          # tsc --noEmit, strict
npm test                   # vitest; fixtures, plus real-SDK scenarios in child processes (no network)
npm install --no-save recheck && npm run audit:redos   # static ReDoS gate over every regex; exits non-zero on a new unbounded pattern
npx tsx scripts/generate_actor_files.ts
npx tsx scripts/generate_pricing_payloads.ts --now=<ISO instant> [--paying-users=false] [--strict]
npx tsx scripts/stage_actor.ts <engine-slug> [--out=<dir>]   # self-contained build context for `apify push`
```

`stage_actor` was verified end to end: stage, `npm ci`, `npm run build` with the reduced `tsconfig`, then a local run
of the built engine against the live SEC feed.

Live smoke runs from a sandbox behind an egress proxy need `NODE_USE_ENV_PROXY=1` for Node's global `fetch`.

## Adding a connector

1. Implement `Connector<Options>` in `<engine>/connectors/<name>.ts`: a strict zod options schema, `fetch(ctx, options, run)`
   returning `SourceRecord[]` (`recordId` stable across runs, `fingerprint` changes iff a consumer-visible field changed,
   `watchText` = the names a watchlist should match). Network only through `ctx.http`; clock only through `ctx.now()`.
2. Read every keyword/name-list option through `sanitizeKeywordList()`; an empty result means "no filter", never "match all".
3. Register it explicitly in `<engine>/index.ts` and add its events to `pricing/event_catalog.ts`
   (`applyCatalogBilling` and `validatePricing` fail loudly if an active connector has no priced event).
4. Add a fixture-driven test. Regenerate the actor files and payloads and commit them (tests fail if they drift).
5. A source that needs a CAPTCHA solve, a spoofed browser fingerprint, a login or a WAF bypass is registered with
   `createHeldConnector()` and a precise reason, not worked around.
