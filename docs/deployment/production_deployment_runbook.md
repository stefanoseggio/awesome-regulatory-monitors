# Production deployment runbook: the three Master Engines

| | |
|---|---|
| Date | 2026-10-21 |
| Code verified | `master_engines/` at commit `5660bc48370dcaf4336c968112d04c2483fb7ee3` on branch `claude/busy-fermi-yhcyfl` (draft PR [#2](https://github.com/stefanoseggio/awesome-regulatory-monitors/pull/2)); the commit that adds this runbook changes only the payload generator's `--out` option, the runbook and its test |
| Status | **Staged, built and verified locally. Not deployed.** No Actor has ever run on the Apify platform and the session that prepared this had no Apify token. Section 8 says exactly which command was executed against what. |
| Companion documents | [`apify_portfolio_refactor_strategy_2026.md`](../apify_portfolio_refactor_strategy_2026.md) (design, register RA-1 to RA-46, decisions in section 10), [`audits/2026-10-21_stress_test_audit.md`](../audits/2026-10-21_stress_test_audit.md), [`audits/2026-10-21_pricing_exposure.md`](../audits/2026-10-21_pricing_exposure.md) |

The fenced blocks marked `deploy:<name>` are not prose: `master_engines/test/deployment_runbook.test.ts` extracts them and runs the pricing steps (`env`, `identify`, `payloads`, `payload-guard`, `preflight`, `put`, `verify`, `smoke`) against a local HTTP server that plays the Apify API, so this document cannot drift from the generator it calls. Blocks marked `deploy-manual:<name>` need the platform, Docker or the Apify CLI and are not executed by that test.

---

## 0. Corrections to the brief, and the gates no command can pass for you

1. **There is no "start floor".** Apify's documented default for `apify-actor-start` is $0.00005 per GB and the platform documents neither a minimum nor a maximum. The engines price it at **$0.005 per GB**, 100 times the default (strategy 6.1). That is a price decision, not a floor imposed by Apify, and it is still **open decision 4**: at 2 GB the regtech engine charges $0.01 for a run that delivers nothing, and it charges it also when the run lease refuses the run.
2. **The endpoint is `PUT /v2/actors/{actorId}`.** Apify's OpenAPI specification (`v2-2026-10-21T115842Z`, fetched 2026-10-21) lists `get`, `put` and `delete` there and has no `/v2/acts/` path. `actorId` may be the Actor id or `<username>~<actor-name>`; this runbook uses the second form, so no id has to be copied out of the push output.
3. **The 14-day rule is section 9.4** of the Apify Store Publishing Terms, not 2.2.4.2 ("Specific Prohibitions"). A change that can raise a user's price takes effect 14 days after it is submitted, at most one such change per month per Actor, and **a pending change cannot be cancelled or edited**. The API has no notice field: `startedAt` is the effective date (`pricing/build_put_payloads.ts` header). If an Actor has no paying users there is no waiting period.

**Gates that need an owner's decision on record before section 6** (strategy section 10; the pricing step is the only step that cannot be undone):

| # | Gate | State in the repository |
|---|---|---|
| G1 | The start event at $0.005 per GB | **Open.** |
| G2 | `watchlist-hit` at $0.15 per proven match, in all three engines | **Operator-stated.** No legacy document defines it. |
| G3 | The provisional prices: `crawler-signal` $0.015 (regtech), `grant-updated` $0.008 (tenders), `uae-entity-updated` $0.01 and `sg-entity-updated` $0.01 (patents). `generate_pricing_payloads.ts --strict` refuses to emit while one stands | **Provisional.** The commands below do not pass `--strict`: sending them is your confirmation of these four numbers. |
| G4 | robots.txt policy (DIFC, six Diario Oficial sections and the ClinicalTrials.gov API are requested although disallowed) | **Open.** |
| G5 | Whether and when the legacy Actors are retired | **Open.** |

---

## 1. What is deployed

| Actor (`name` in `.actor/actor.json`) | Memory (pinned) | Sources (held ones are not in the input enum) | BYOK fields, top level, `isSecret: true` | Events (USD) |
|---|---:|---|---|---|
| `global-regtech-compliance-feed` | 2,048 MB | `ofac`, `world_bank_debarred`, `uk_modern_slavery`, `sec_enforcement`, `ai_crawler_signals`, `fda_ema_recalls` | `fdaApiKey` | start 0.005 per GB; `vessel-record` 0.0005 (primary); `debarment-record` 0.003; `statement-new` 0.02; `statement-updated` 0.01; `enforcement-release` 0.05; `enforcement-update` 0.02; `crawler-signal` 0.015 (provisional); `crawler-signal-change` 0.006; `recall-record` 0.001; `watchlist-hit` 0.15 (operator-stated) |
| `latam-global-tender-intelligence` | 1,024 MB | `ar_santafe`, `ar_tucuman`, `ar_entrerios`, `cl_diario_oficial`, `eu_ted`, `us_florida`, `world_bank_notices`, `it_lombardia_grants` | `socrataAppToken` | start 0.005 per GB; `tender-detail` 0.003 (primary); `tender-summary` 0.001; `notice-record` 0.001; `notice-new` 0.02; `notice-updated` 0.01; `grant-new` 0.02; `grant-updated` 0.008 (provisional); `watchlist-hit` 0.15 (operator-stated) |
| `global-corporate-patent-intelligence` | 1,024 MB | `uspto_ptab`, `epo_opposition`, `clinicaltrials_orange_book`, `sg_acra`, `ae_registers` | `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`, `fdaApiKey` | start 0.005 per GB; `patent-proceeding` 0.002 (primary); `clinical-record` 0.002; `uae-entity-new` 0.02; `uae-entity-updated` 0.01 (provisional); `sg-entity-new` 0.03; `sg-entity-updated` 0.01 (provisional); `watchlist-hit` 0.15 (operator-stated) |

Start event per run: $0.01 for regtech (2 GB), $0.005 for tenders and patents (1 GB). `minimalMaxTotalChargeUsd` is 0.16 for all three. Ten sources are **held** and refuse to run with their documented reason; `ar_cordoba` is one of them (section 7). Credentials for BYOK sources are top-level input fields because Apify masks only top-level secret fields; a credential inside `sourceOptions` is refused by preflight.

---

## 2. Prerequisites

* Node.js 20 or newer (the image runs Node 24), npm, `curl` 7.76 or newer (`--fail-with-body`), `jq` 1.6 or newer, `bash` 3.2 or newer.
* Apify CLI 1.10.0 or newer (`npm install -g apify-cli`); Docker only for the optional local image build.
* An Apify API token of the account that will own the Actors, in `APIFY_TOKEN`. The token never appears on a command line below: it is read from the environment and handed to `curl` through a pipe.
* A clean checkout of this branch at the commit above: `git rev-parse HEAD` must print it (or a later commit of the same branch whose diff you have reviewed), and `git status --porcelain` must print nothing.

---

## 3. Shared definitions

```bash deploy:env
set -euo pipefail
export APIFY_CLI_DISABLE_TELEMETRY=1
: "${APIFY_TOKEN:?set APIFY_TOKEN to the API token of the account that will own the Actors}"
API="${APIFY_API_BASE:-https://api.apify.com}"
ENGINES="global-regtech-compliance-feed latam-global-tender-intelligence global-corporate-patent-intelligence"
cd master_engines
# The token is handed to curl through a pipe (curl reads -H @file), so it never shows up in a process listing.
apify_curl() { curl --fail-with-body --silent --show-error --max-time 120 -H @<(printf 'Authorization: Bearer %s' "$APIFY_TOKEN") "$@"; }
```

Run every block below in the same shell, in order, from the repository root. `APIFY_API_BASE` exists only so that the rehearsal can point the same commands at a local server; leave it unset for the platform.

---

## 4. Stage and verify the three packages (no token needed)

```bash deploy-manual:stage
npm ci
npx tsc --noEmit
npx vitest run                                  # 2,347 tests in 54 files, all passing
npm run audit:redos                             # exit 0: 193 safe, 6 allowlisted
for slug in $ENGINES; do npx tsx scripts/stage_actor.ts "$slug"; done
for slug in $ENGINES; do (cd "stage/$slug" && apify validate-schema); done
```

`stage_actor.ts` writes `stage/<slug>/` (git-ignored): `lib/`, `pricing/` without `payloads/`, the engine, `package.json`, the committed `package-lock.json`, `.actor/`, a root `Dockerfile` copied from `.actor/Dockerfile`, a `tsconfig.json` narrowed to the three directories and a `.dockerignore`. Nothing outside those directories is shipped, no test, no payload, no fixture.

Optional, needs a Docker daemon (a build takes about 15 seconds after the first):

```bash deploy-manual:docker
for slug in $ENGINES; do docker build -t "master-engines-$slug:stage" "stage/$slug"; done
```

---

## 5. Push the three Actors (private until you publish them)

```bash deploy-manual:push
apify login --token "$APIFY_TOKEN"
apify info
for slug in $ENGINES; do (cd "stage/$slug" && apify push --wait-for-finish 900); done
```

`apify push` creates the Actor named in `.actor/actor.json` if it does not exist (private), uploads the source, and waits up to 900 seconds for the build; the exit code reflects the build outcome only. A new Actor is not public and has no Store listing: publishing is a separate step this runbook does not cover (the listing texts are not written; strategy 12.2). Check each build before continuing:

```bash deploy-manual:builds
for slug in $ENGINES; do
  apify_curl "$API/v2/actors/$(apify_curl "$API/v2/users/me" | jq -er '.data.username')~${slug}" | jq -r '.data | "\(.name) isPublic=\(.isPublic) versions=\([.versions[].versionNumber] | join(","))"'
done
```

---

## 6. Price the Actors (the irreversible step)

Read section 0 first. Variant A is the default and the one section 9.4 requires for any Actor that has, or may already have, paying users: `startedAt` is 14 days after the request. Variant B is for an Actor you know has never had a paying user (a brand-new one): the pricing is effective at once and can still be edited. `GET /v2/actors/{id}` shows `stats.totalUsers`, which the preflight prints. Set `PAYING_USERS=false` to select B.

```bash deploy:identify
USERNAME="$(apify_curl "$API/v2/users/me" | jq -er '.data.username')"
echo "owner: $USERNAME"
```

```bash deploy:payloads
# The reference files in pricing/payloads/ carry the date they were generated on: never send them. Generate the body at the moment of sending.
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
OUT="stage/payloads/$(date -u +%Y%m%dT%H%M%SZ)"
npx tsx scripts/generate_pricing_payloads.ts --now="$NOW" --paying-users="${PAYING_USERS:-true}" --out="$OUT"
echo "payloads written to $OUT"
```

```bash deploy:payload-guard
case "${PAYING_USERS:-true}" in
  true) WAIT=1209600 ;;   # 14 days, in seconds
  false) WAIT=0 ;;
  *) echo "PAYING_USERS must be true or false"; exit 1 ;;
esac
for slug in $ENGINES; do
  jq -e --argjson now "$(date -u +%s)" --argjson wait "$WAIT" '
    def ts: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    (.pricingInfos | length) == 1 and (.pricingInfos[0] |
      .pricingModel == "PAY_PER_EVENT"
      and ((.startedAt | ts) - (.createdAt | ts)) == $wait
      and (.createdAt | ts) > $now - 900 and (.createdAt | ts) <= $now + 60
      and .pricingPerEvent.actorChargeEvents["apify-actor-start"].eventPriceUsd == 0.005
      and .pricingPerEvent.actorChargeEvents["apify-actor-start"].isOneTimeEvent == true
      and (.pricingPerEvent.actorChargeEvents | has("apify-default-dataset-item") | not)
      and ([.pricingPerEvent.actorChargeEvents[] | select(.isPrimaryEvent == true)] | length) == 1
      and .pricingPerEvent.actorChargeEvents["watchlist-hit"].eventPriceUsd == 0.15)' \
    "$OUT/$slug.put.json" > /dev/null \
    || { echo "$slug: the payload fails the deployment checks (stale, wrong notice period, wrong start price or events)"; exit 1; }
  diff <(jq -S '.pricingInfos[0].pricingPerEvent' "pricing/payloads/$slug.put.json") \
       <(jq -S '.pricingInfos[0].pricingPerEvent' "$OUT/$slug.put.json") > /dev/null \
    || { echo "$slug: events or prices differ from the reviewed reference in pricing/payloads/"; exit 1; }
  jq -e --slurpfile put "$OUT/$slug.put.json" '.effectiveAt == $put[0].pricingInfos[0].startedAt and .noticeDays == 14' \
    "$OUT/$slug.notice.json" > /dev/null \
    || { echo "$slug: the notice file does not match the payload"; exit 1; }
done
echo "payloads in $OUT pass the deployment checks"
```

The guard refuses a body that is older than 15 minutes, that does not carry exactly the notice period of the chosen variant, whose start event is not $0.005 per GB and one-time, that prices `apify-default-dataset-item` (priced, `pushData(item, eventName)` would bill two events per row), that does not have exactly one primary event, whose `watchlist-hit` is not $0.15, or whose events and prices differ from the reviewed reference files.

```bash deploy:preflight
for slug in $ENGINES; do
  actor="$(apify_curl "$API/v2/actors/${USERNAME}~${slug}")"
  jq -e '(.data.pricingInfos // []) | length == 0' <<< "$actor" > /dev/null \
    || { echo "$slug already has pricing records. Merge them into the payload by hand (docs-research/apify-ppe-policy-verification.md section 9, usage notes) before sending."; exit 1; }
  echo "$slug: isPublic=$(jq -r '.data.isPublic' <<< "$actor") totalUsers=$(jq -r '.data.stats.totalUsers // 0' <<< "$actor")"
done
```

The preflight stops if an Actor already has pricing history: whether a lone record is accepted over an existing history is **not verified** (`docs-research/apify-ppe-policy-verification.md`, unverified items 2 to 4), so that case is a manual merge, not a command.

```bash deploy:put
[ "${CONFIRM_PRICING:-}" = "send-pricing-to-production" ] || { echo "Set CONFIRM_PRICING=send-pricing-to-production once G1 to G3 have an owner's decision on record. A pending price change cannot be cancelled or edited."; exit 1; }
for slug in $ENGINES; do
  apify_curl -X PUT "$API/v2/actors/${USERNAME}~${slug}" \
    -H "Content-Type: application/json" \
    --data-binary @"$OUT/$slug.put.json" > "$OUT/$slug.put.response.json"
  echo "$slug: pricing sent"
done
```

The three requests are:

```text
PUT https://api.apify.com/v2/actors/<username>~global-regtech-compliance-feed
PUT https://api.apify.com/v2/actors/<username>~latam-global-tender-intelligence
PUT https://api.apify.com/v2/actors/<username>~global-corporate-patent-intelligence
Authorization: Bearer <APIFY_TOKEN>
Content-Type: application/json
body: stage/payloads/<timestamp>/<slug>.put.json   (one pricingInfos record, PAY_PER_EVENT, the events of section 1)
```

```bash deploy:verify
for slug in $ENGINES; do
  apify_curl "$API/v2/actors/${USERNAME}~${slug}" > "$OUT/$slug.after.json"
  jq -e --slurpfile put "$OUT/$slug.put.json" '
    (.data.pricingInfos | last) as $got | $put[0].pricingInfos[0] as $want
    | $got.pricingModel == $want.pricingModel
    and ($got.pricingPerEvent.actorChargeEvents | map_values(.eventPriceUsd))
        == ($want.pricingPerEvent.actorChargeEvents | map_values(.eventPriceUsd))
    and ($got.startedAt | .[0:19]) == ($want.startedAt | .[0:19])' \
    "$OUT/$slug.after.json" > /dev/null \
    || { echo "$slug: the pricing read back from the platform differs from what was sent"; exit 1; }
  echo "$slug: pricing read back matches (effective $(jq -r '.data.pricingInfos | last | .startedAt' "$OUT/$slug.after.json"))"
done
```

**The notice window (Variant A).** For 14 days after the request the new pricing is not yet effective: a run in that window has no pay-per-event pricing, so the router treats it as a non-pay-per-event run (rows are delivered, nothing is billed, `watchlist-hit` is never charged). Smoke-test in the window; the first priced run is after `startedAt`.

---

## 7. Smoke test on the platform

```bash deploy:smoke
smoke_input() {
  case "$1" in
    global-regtech-compliance-feed) echo '{"sources":["ofac"],"maxItemsPerSource":5}' ;;
    latam-global-tender-intelligence) echo '{"sources":["world_bank_notices"],"maxItemsPerSource":5}' ;;
    global-corporate-patent-intelligence) echo '{"sources":["sg_acra"],"maxItemsPerSource":5}' ;;
    *) echo "no smoke input for $1" >&2; return 1 ;;
  esac
}
for slug in $ENGINES; do
  run="$(apify_curl -X POST "$API/v2/actors/${USERNAME}~${slug}/runs?maxTotalChargeUsd=0.5&waitForFinish=60" \
    -H "Content-Type: application/json" --data-binary "$(smoke_input "$slug")")"
  run_id="$(jq -er '.data.id' <<< "$run")"
  status="$(jq -er '.data.status' <<< "$run")"
  for _ in $(seq 1 60); do
    case "$status" in SUCCEEDED) break ;; FAILED|ABORTED|TIMED-OUT) echo "$slug: run $run_id ended $status"; exit 1 ;; esac
    sleep "${POLL_SECONDS:-5}"
    status="$(apify_curl "$API/v2/actor-runs/$run_id" | jq -er '.data.status')"
  done
  [ "$status" = SUCCEEDED ] || { echo "$slug: run $run_id still $status after 5 minutes"; exit 1; }
  dataset="$(apify_curl "$API/v2/actor-runs/$run_id" | jq -er '.data.defaultDatasetId')"
  echo "$slug: run $run_id $status, $(apify_curl "$API/v2/datasets/$dataset/items?format=json&limit=1000" | jq length) items"
done
```

A run that selects a held source must fail at preflight with its reason, with no request to the portal and no charge. For `ar_cordoba` that is the documented network block (the portal refuses non-residential, non-Argentine traffic at TCP level, per the legacy `AGENTS.md` lines 86 to 88; the only workaround ever claimed is a paid residential Argentine proxy, never verified and not supported by the shared HTTP client). `ar_cordoba` is not in the input schema's source list, and the router refuses it before any fetch:

```bash deploy-manual:held-check
apify_curl -X POST "$API/v2/actors/${USERNAME}~latam-global-tender-intelligence/runs?waitForFinish=60&maxTotalChargeUsd=0.5" \
  -H "Content-Type: application/json" --data-binary '{"sources":["ar_cordoba"]}' | jq -r '.data.status'
# expected: FAILED, with the held reason in the run's status message
```

If something is wrong before the pricing PUT, delete the unpriced Actor and start again; after a Variant A pricing PUT nothing can be cancelled:

```bash deploy-manual:abort
apify_curl -X DELETE "$API/v2/actors/${USERNAME}~${slug}"   # one Actor; there is no undo
```

---

## 8. Evidence for this commit

Everything below was run in the session that prepared this runbook, on 2026-10-21, on a Linux sandbox behind an egress proxy. Counts are what the tools printed.

### 8.1 Repository

| Check | Result |
|---|---|
| `git rev-parse HEAD` before this runbook | `5660bc48370dcaf4336c968112d04c2483fb7ee3`, equal to `origin/claude/busy-fermi-yhcyfl` and to the head of draft PR #2 |
| Base | `origin/main` is `0ae5e0accf143797af3039f79631db4db85405ed`, an ancestor of HEAD; the branch is 26 commits ahead and 0 behind |
| Working tree | clean (`git status --porcelain` empty); `stage/` is git-ignored |

### 8.2 Integrity gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (strict) | exit 0 |
| `npx vitest run`, Node 22.22.0 | 2,323 tests in 53 files before this runbook's test was added, all passing; 2,347 in 54 files with it |
| `npx vitest run`, Node 24.22.0 (the runtime of the image) | the same counts, all passing |
| `npm run audit:redos` | exit 0: 219 regex occurrences, 199 distinct, 193 safe, 6 allowlisted with a bound and an enforcing test, 7 dynamic `RegExp()` calls none of which takes external input |
| `npx tsx scripts/generate_distribution_data.ts --check` | `engines.json` and `guard_parity.json` up to date |
| `pytest` in `distribution/python`, Python 3.11.17, 3.12.3, 3.13.16 | 1,810 passed on each |
| Lease and delta memory against duplicate billing | the lease, journal and state tests (`core.lease*.test.ts`, `core.router.test.ts`, `stress.atomicity_chaos.test.ts`, `apify_sdk.integration.test.ts`, `platform_parity.integration.test.ts`) are in the counts above; see also 8.4 for two real containers |
| `ar_cordoba` held | `heldArgentina` tests pass; see 8.4 for the container run |

### 8.3 Staging and packaging

* `npx tsx scripts/stage_actor.ts <slug>` for the three engines wrote `stage/<slug>/` (632 KB regtech, 796 KB tenders, 660 KB patents): `lib/`, `pricing/` without `payloads/`, the engine, `package.json`, `package-lock.json`, `.actor/`, a root `Dockerfile`, `tsconfig.json`, `.dockerignore`.
* `apify validate-schema` (apify-cli 1.10.0) in each staged directory: `Success: Input schema is valid.` three times.
* `npx tsx scripts/generate_actor_files.ts` rewrote the three `.actor/` directories with no difference from the committed files (`git diff` empty): zero drift. In each staged tree `.actor/actor.json`, `.actor/input_schema.json` and `.actor/Dockerfile` are byte-identical to the source, and the root `Dockerfile` is byte-identical to `.actor/Dockerfile`.
* Credentials are top-level `isSecret: true` fields: regtech `fdaApiKey`; tenders `socrataAppToken`; patents `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`, `fdaApiKey`. No `sourceOptions` property carries one (tested by `audit.actor_config_independent.test.ts` and, for the table in section 1, by `deployment_runbook.test.ts`).
* Memory is pinned (`minMemoryMbytes == maxMemoryMbytes`): 2,048 MB regtech, 1,024 MB tenders and patents.

### 8.4 Containers

A Docker daemon was started in the sandbox and the three staged contexts were built with `docker build`, their Dockerfiles unchanged (two stages, `npm ci --include=dev` then `npm run build`, then `npm ci --omit=dev`). One adaptation: the sandbox's egress proxy re-signs TLS, so the base tag `apify/actor-node:24` was rebuilt locally with the proxy's CA added; the Dockerfiles themselves and everything above the base are unchanged. The images report Node v24.22.1, `apify` 3.7.2, `apify-client` 2.25.0, `crawlee` 3.18.2.

| Run (local storage, live public sources) | Result |
|---|---|
| regtech, `{"sources":["ofac"],"maxItemsPerSource":5}` | exit 0; 1,568 vessel entries of 19,471 SDN entries (list published 10/21/2026); 5 rows emitted |
| tenders, `{"sources":["world_bank_notices"],"maxItemsPerSource":5}` | exit 0; 5 notices emitted |
| patents, `{"sources":["sg_acra"],"maxItemsPerSource":5}` | exit 0; 5 records emitted |
| regtech again on the same storage | exit 0; 0 rows emitted (delta memory persisted across containers) |
| tenders, `{"sources":["ar_cordoba"]}` with `--network=none` | exit 1, no dataset: `Source "ar_cordoba" is HELD and cannot run: webecommerce.cba.gov.ar blocks non-residential, non-Argentine traffic ...`, naming the legacy `AGENTS.md` lines 86 to 88 and the paid residential Argentine proxy that was never verified |
| two regtech containers on one shared storage and one namespace, `ofac` with 300 rows, the second started as soon as the first held its lease | the second exited 1 with `Another run is already delivering into the same delta memory: source "ofac" is held by run run-a ...` and delivered nothing; the first delivered exactly 300 rows once; the lease record was gone afterwards and the state record was present |

These runs used local storage: no pay-per-event pricing was in force, so they say nothing about charges (that is what the fault-injection, real-SDK and parity tests cover).

### 8.5 The pricing bodies against Apify's published schema

Apify's OpenAPI specification `v2-2026-10-21T115842Z` was fetched on 2026-10-21 and the request schema of `PUT /v2/actors/{actorId}` (`UpdateActorRequest`, with `ActorRunPricingInfo` resolved) was applied with a JSON Schema validator (Draft 2020-12) to the bodies the generator writes, for both variants (`--paying-users=true` and `false`) and all three engines: **6 of 6 valid, 0 errors, no field the schema does not list**; a body with `startedAt: 12345` and a string price was rejected by the same validator. This checks the shape. It does not check what the server accepts: the unverified items in `docs-research/apify-ppe-policy-verification.md` section 10 (a lone record over existing history, an earlier `startedAt`, adding `apify-actor-start` to an existing PPE Actor, the meaning of `isOneTimeEvent: true` on the start event) can only be answered by an account, which is why the preflight stops on an Actor that has pricing history and why Variant A, whose `startedAt` is 14 days out, is the default.

### 8.6 Rehearsal of the pricing steps

`master_engines/test/deployment_runbook.test.ts` (24 tests) executes the `deploy:` blocks of this document with bash against a local HTTP server. It proves, for variant A and B: the order of requests (owner, then every Actor read, then the three PUTs, then the read-backs), the path `/v2/actors/<owner>~<slug>`, the bearer token and the JSON content type, a body equal byte for byte to the generated file and to the builder's output for the instant the file carries, `startedAt - createdAt` of exactly 14 days (or 0), the start event at $0.005 and one-time, no `apify-default-dataset-item`; and that the guards refuse a body older than 15 minutes, the wrong notice period (both ways and an unknown value), a changed start price, event price, one-time flag, primary-event count or `watchlist-hit` price, a priced dataset-item event, a notice file that disagrees, an Actor that already has pricing records, an Actor that was not pushed, a missing or wrong confirmation, a platform error on the second Actor (the third is never sent), a wrong token (nothing else attempted) and a missing token. It also checks that every event, price, memory size, credential and source named in section 1 equals the committed artefacts. Eighteen faults were introduced one at a time into the commands of this document (a missing `--fail-with-body`, the `/v2/acts/` alias, a 7-day notice, no preflight, no confirmation, no staleness window, the token on a command line, payloads written over the reference directory, and so on); three survived the first version of the test and led to tests that isolate each explicit check, and all eighteen are caught now.

### 8.7 What none of this proves

* No Actor has run on the platform and nothing was sent to `api.apify.com`; no token was available.
* The Docker builds used a locally re-signed base image; the platform's build environment was not exercised.
* The three smoke inputs (`ofac`, `world_bank_notices`, `sg_acra`) depend on public upstreams that can be down.
* Section 0's gates are decisions, not facts: until G1 to G3 have an owner, nothing in section 6 should be run.


---

## 9. Deployment checklist

**Before anything else**

- [ ] `git rev-parse HEAD` is the commit above (or a reviewed descendant) and `git status --porcelain` is empty.
- [ ] G1 to G5 (section 0) each have an owner's decision on record.
- [ ] `APIFY_TOKEN` belongs to the account that is meant to own the three Actors.

**Build (section 4)**

- [ ] `npm ci`, `npx tsc --noEmit`, `npx vitest run`, `npm run audit:redos` all exit 0.
- [ ] The three `stage/<slug>/` directories exist and `apify validate-schema` succeeds in each.
- [ ] (Optional) `docker build` succeeds for each.

**Push (section 5)**

- [ ] `apify info` prints the intended account.
- [ ] `apify push` exits 0 for each Actor; each build is listed with `isPublic=false`.

**Pricing (section 6)**

- [ ] `PAYING_USERS` is set deliberately (`true` unless the Actor is known never to have had a paying user).
- [ ] `deploy:payloads` ran minutes ago, not hours; `deploy:payload-guard` printed `payloads in ... pass the deployment checks`.
- [ ] `deploy:preflight` printed `isPublic=false` and the expected `totalUsers` for all three, with no pricing history.
- [ ] `CONFIRM_PRICING` was set by a person, in this shell, after G1 to G3.
- [ ] `deploy:verify` printed `pricing read back matches` three times.

**After the push (section 7)**

- [ ] The three smoke runs ended `SUCCEEDED` with items (an upstream outage is a reason to retry, not to proceed blind).
- [ ] The held-source run ended `FAILED` with the held reason.
- [ ] Nothing was published: no Store listing exists until the listing texts are written and the Actors are made public.
