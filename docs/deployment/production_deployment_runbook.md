# Production deployment runbook: the three Master Engines

| | |
|---|---|
| Date | 2026-10-21 (written); re-verified 2026-10-30; decisions G1 to G5 taken and audit findings remediated 2026-11-02 |
| Code verified | `master_engines/` at commit `75becb3ff6b32cc99c3ce8ef021baf364e5c59c3` of draft PR [#2](https://github.com/stefanoseggio/awesome-regulatory-monitors/pull/2) (branch `claude/busy-fermi-yhcyfl`) **plus the remediation of 2026-11-02**, a patch that exists only as a local commit and as `remediation_2026-11-02.patch` next to this file. It has not been pushed to PR #2 and nobody has reviewed it yet: the patched tree is identified by `frozen_artifacts_remediated_2026-11-02.sha256` and the patch's own SHA-256 (section 11), not by a commit on GitHub. The 2026-10-21 text of this runbook named `5660bc48370dcaf4336c968112d04c2483fb7ee3` |
| Status | **Staged, built and verified locally. Not deployed.** No Actor has ever run on the Apify platform and the session that prepared this had no Apify token. Section 8 says exactly which command was executed against what. |
| Companion documents | [`apify_portfolio_refactor_strategy_2026.md`](../apify_portfolio_refactor_strategy_2026.md) (design, register RA-1 to RA-46, decisions in section 10), [`audits/2026-10-21_stress_test_audit.md`](../audits/2026-10-21_stress_test_audit.md), [`audits/2026-10-21_pricing_exposure.md`](../audits/2026-10-21_pricing_exposure.md) |

> **Revision of 2026-11-02, read this first.** The owner's mandate of that day delegated the five decisions G1 to G5 and the repair of the open audit findings. This revision records the decisions (section 0), carries the repairs (section 12) and replaces the pricing blocks that failed on Windows. What changed in the executable blocks, all rehearsed by `deployment_runbook.test.ts`: `deploy:env` hands the token to `curl` as a configuration read from standard input (`-K -`) and refuses a token that contains a character outside `A-Z a-z 0-9 _ . -`; `deploy:payloads` passes `--strict`, so the generator refuses to emit a price that is neither documented nor ratified, a start price other than $0.005 and a `watchlist-hit` other than $0.15; `deploy:payload-guard` no longer puts a backslash in a `jq` program. What did **not** change: nothing in this document has been run against `api.apify.com`, no Actor has run on the platform, the Store listing texts do not exist, and the patch is unreviewed and unpushed. **The decisions make the pricing step permissible; they do not make it advisable before a person has read section 12 and run the checklist of section 9.** The report is [`../audits/final_deployment_verification_audit_2026.md`](../audits/final_deployment_verification_audit_2026.md); the 2026-10-30 evidence (sections 8.8, 10, 11) is kept below because it describes the unpatched head.

The fenced blocks marked `deploy:<name>` are not prose: `master_engines/test/deployment_runbook.test.ts` extracts them and runs the pricing steps (`env`, `identify`, `payloads`, `payload-guard`, `preflight`, `put`, `verify`, `smoke`) against a local HTTP server that plays the Apify API, so this document cannot drift from the generator it calls. Blocks marked `deploy-manual:<name>` need the platform, Docker or the Apify CLI and are not executed by that test.

---

## 0. Corrections to the brief, and the gates no command can pass for you

1. **There is no "start floor".** Apify's documented default for `apify-actor-start` is $0.00005 per GB and the platform documents neither a minimum nor a maximum. The engines price it at **$0.005 per GB**, 100 times the default (strategy 6.1). That is a price decision, not a floor imposed by Apify. It was taken as **G1 on 2026-11-02** (below): at 2 GB the regtech engine charges $0.01 for a run that delivers nothing, and it charges it also when the run lease refuses the run.
2. **The endpoint is `PUT /v2/actors/{actorId}`.** Apify's OpenAPI specification (`v2-2026-10-21T115842Z`, fetched 2026-10-21) lists `get`, `put` and `delete` there and has no `/v2/acts/` path. `actorId` may be the Actor id or `<username>~<actor-name>`; this runbook uses the second form, so no id has to be copied out of the push output.
3. **The 14-day rule is section 9.4** of the Apify Store Publishing Terms, not 2.2.4.2 ("Specific Prohibitions"). A change that can raise a user's price takes effect 14 days after it is submitted, at most one such change per month per Actor, and **a pending change cannot be cancelled or edited**. The API has no notice field: `startedAt` is the effective date (`pricing/build_put_payloads.ts` header). If an Actor has no paying users there is no waiting period.

**The five gates, decided on 2026-11-02.** The owner's mandate of that day delegated G1 to G5; the decisions below were taken under it by the assistant that holds this session, they are recorded in code (`pricing/event_catalog.ts`, `lib/robots_policy.ts`) and enforced by tests, and the owner can reverse any of them. A decision is not an action: none of them has been sent to Apify, and the pricing step is still the only step that cannot be undone.

| # | Gate | Decision of 2026-11-02 | Where it is enforced |
|---|---|---|---|
| G1 | The start event at $0.005 per GB | **Locked at $0.005 per started GB** in all three engines (regtech 2 GB = $0.01 a run, tenders and patents 1 GB = $0.005). *Infrastructure:* the marketplace keeps 20 percent, so one start event nets $0.004, which pays for 72 seconds of one GB at $0.20 per GB-hour and 36 seconds at $0.40, the least a run costs that boots a container and fetches one page. *Market:* in the public Store sample of 2026-10-17 (692 listings with a start event, popularity-biased) $0.005 is at the 65th percentile (405 listings below, 97 equal, 190 above); 287 of 692 (41.5 percent) charge $0.005 or more and 288 keep the platform default of $0.00005; the median 30-day users are 20 at $0.005 or more and 18 at the default (descriptive, no causal claim; `docs/evidence/start_fee_market_stats_2026-11-02.json`). *Reopen:* after 30 days of runs, compare the median billed run time with 36 to 72 seconds per GB; lowering is immediate, raising needs 14 days of notice. | `START_PRICE_RATIFICATION`; `--strict` refuses any other start price; `deploy:payload-guard` checks it again |
| G2 | `watchlist-hit` at $0.15 per proven match, in all three engines | **Locked at $0.15.** The same event cost $0.15 on the legacy sec-enforcement and clinicaltrials-orange-book Actors, $0.12 on ai-crawler, $0.10 on the Lombardia and ACRA ones (public API, 2026-10-17); $0.15 is the highest and one rule for three engines, so the tender engine's only watchlist source (Lombardia) rises from $0.10 to $0.15. A hit is charged once, after the row event and the journal write, only for a keyword with at least 2 alphanumerics, and the default caps (200 hits and $50 a run) bound the exposure. | `HIT_RATIFICATION`; `--strict`; `deploy:payload-guard` |
| G3 | The four provisional prices: `crawler-signal` $0.015, `grant-updated` $0.008, `uae-entity-updated` $0.01, `sg-entity-updated` $0.01 | **Ratified as they stand.** Rule R-LOW for the three "updated" events: the router cannot tell a status change from another update, so the lower legacy rate is charged and no caller pays more for an update than the legacy Actor charged. Rule R-FLIP for `crawler-signal`: the first snapshot of a domain is the payload a permission flip delivers and is priced as one; it is the one ratified price that bills something the legacy Actor gave free (its baseline row). `basis` still says "provisional": a ratification records a decision, it does not turn a guess into a documented price, and the notice file lists the two separately. | `ratification` on each event; `--strict` accepts a documented or a ratified event only |
| G4 | robots.txt policy for DIFC, the Diario Oficial and ClinicalTrials.gov | **One rule:** an active connector requests only URLs that the host's robots.txt does not disallow for `User-agent: *`; what would break it is held and refused at preflight, with the policy as the reason. *DIFC:* held (`difc.com` disallows `/api/`); the UAE engine serves ADGM only, whose robots.txt allows everything. *Diario Oficial:* only `normas_generales` (`/edicionelectronica/index.php`, the one path robots.txt allows) is active; the six other sections are held. *ClinicalTrials.gov:* its robots.txt disallows `/api/` and the v2 API is the one documented, public, versioned interface of that site, so it is the **single recorded exception**, limited to `/api/v2/studies` and `/api/v2/version`, on the conditions that the `Crawl-delay` the file declares is honoured (the code waits at least that long), that the one shared user agent is used, and that a 403 ends the leg at once and a 429 only after the shared client's bounded retries (it honours `Retry-After`). The exception is an interpretation, not a permission the host gave, and **the operator's terms of use could not be read** (clinicaltrials.gov serves them from a single-page application): it rests on the endpoint being public, keyless, documented and versioned. If those terms forbid automated use, remove the entry from `ROBOTS_EXCEPTIONS` and hold the ClinicalTrials leg the way DIFC is held (the Orange Book leg, openFDA, is unaffected). | `lib/robots_policy.ts`; `robots.policy.test.ts` evaluates robots.txt files captured on 2026-11-02 with the engines' own matcher |
| G5 | Whether and when the legacy Actors are retired | **Not retired, and not by a timer.** The 23 legacy Actors the engines replace stay live (the owner's decision of 2026-10-16 is that none is sunset). An automated sunset was refused: it would be an outward, partly irreversible act (a deprecated Actor leaves Store search) performed with nobody looking, counted from a replacement that has never run on the platform, and for 6 of the 23 there is no active replacement at all (`ar_cordoba`, `ar_salta`, `ar_mendoza`, `ar_pba`, `au_grantconnect` are held; the sovereign debt auction monitor is in no engine). What replaces it is a **review schedule with entry criteria and a calendar counted from the first priced platform run**, in [`legacy_actor_review_schedule.md`](legacy_actor_review_schedule.md); every retirement stays a command only the owner types. | the schedule document; no code retires anything |

---

## 1. What is deployed

| Actor (`name` in `.actor/actor.json`) | Memory (pinned) | Sources (held ones are not in the input enum) | BYOK fields, top level, `isSecret: true` | Events (USD) |
|---|---:|---|---|---|
| `global-regtech-compliance-feed` | 2,048 MB | `ofac`, `world_bank_debarred`, `uk_modern_slavery`, `sec_enforcement`, `ai_crawler_signals`, `fda_ema_recalls` | `fdaApiKey` | start 0.005 per GB; `vessel-record` 0.0005 (primary); `debarment-record` 0.003; `statement-new` 0.02; `statement-updated` 0.01; `enforcement-release` 0.05; `enforcement-update` 0.02; `crawler-signal` 0.015 (provisional, ratified G3); `crawler-signal-change` 0.006; `recall-record` 0.001; `watchlist-hit` 0.15 (operator-stated, locked G2) |
| `latam-global-tender-intelligence` | 1,024 MB | `ar_santafe`, `ar_tucuman`, `ar_entrerios`, `cl_diario_oficial`, `eu_ted`, `us_florida`, `world_bank_notices`, `it_lombardia_grants` | `socrataAppToken` | start 0.005 per GB; `tender-detail` 0.004 (primary, operator-stated, F-24); `tender-summary` 0.0015 (operator-stated, F-24); `notice-record` 0.001; `notice-new` 0.02; `notice-updated` 0.01; `grant-new` 0.02; `grant-updated` 0.008 (provisional, ratified G3); `watchlist-hit` 0.15 (operator-stated, locked G2) |
| `global-corporate-patent-intelligence` | 1,024 MB | `uspto_ptab`, `epo_opposition`, `clinicaltrials_orange_book`, `sg_acra`, `ae_registers` | `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`, `fdaApiKey` | start 0.005 per GB; `patent-proceeding` 0.002 (primary); `clinical-record` 0.002; `uae-entity-new` 0.02; `uae-entity-updated` 0.01 (provisional, ratified G3); `sg-entity-new` 0.03; `sg-entity-updated` 0.01 (provisional, ratified G3); `watchlist-hit` 0.15 (operator-stated, locked G2) |

Start event per run: $0.01 for regtech (2 GB), $0.005 for tenders and patents (1 GB). `minimalMaxTotalChargeUsd` is 0.16 for all three. Ten sources are **held** and refuse to run with their documented reason; `ar_cordoba` is one of them (section 7). Two more restrictions follow from G4: of the Diario Oficial only the section `normas_generales` can be selected, and of the UAE registers only ADGM (a request for `difc` or for one of the six other sections fails at preflight with the policy as its reason). Credentials for BYOK sources are top-level input fields because Apify masks only top-level secret fields; a credential inside `sourceOptions` is refused by preflight.

---

## 2. Prerequisites

* Node.js 20 or newer (the image runs Node 24), npm, `curl` 7.76 or newer (`--fail-with-body`), `jq` 1.6 or newer, `bash` 3.2 or newer.
* Apify CLI 1.10.0 or newer (`npm install -g apify-cli`); Docker only for the optional local image build.
* An Apify API token of the account that will own the Actors, in `APIFY_TOKEN`. The token never appears on a command line below: it is read from the environment and handed to `curl` through a pipe.
* A clean checkout of this branch at the commit above: `git rev-parse HEAD` must print it (or a later commit of the same branch whose diff you have reviewed), and `git status --porcelain` must print nothing.


### 2.1 Where to run this, and what else must be installed (revised 2026-11-02)

* **Linux, macOS, WSL2 or Windows with Git Bash.** Since the revision of 2026-11-02 the `deploy:*` blocks no longer use bash process substitution or a backslash inside a `jq` program, the two constructs that failed under Git Bash on 2026-10-30: the token reaches `curl` as a configuration read from standard input, and the notice-period guard uses `sub("[.][0-9]+Z$"; "Z")`. On Windows the whole rehearsal (`deployment_runbook.test.ts`) was run with the Git Bash that ships with Git for Windows, a native `curl` and `jq.exe` first on the `PATH` (section 8.9). Linux and macOS were not available on 2026-11-02 and are not claimed.
* **A checkout with LF line endings.** The repository now has a `.gitattributes` that fixes the line endings of the generated `.actor/` files, the JSON, the shell blocks and the robots.txt fixtures, so `core.autocrlf` can no longer change the bytes that `apify push` uploads. Confirm with `git ls-files --eol master_engines/global-regtech-compliance-feed/.actor/Dockerfile` (it must print `w/lf`). If it prints `w/crlf`, the file was checked out before the attributes took effect: delete the working copy of that file and check it out again.
* **`recheck`**, the analyser of the ReDoS gate, is an optional `--no-save` tool: `npm run audit:redos` exits **2** (not 0) on a tree where only `npm ci` was run. Install it with `npm install --no-save recheck` before the gate (the `stage` block of section 4 says so).
* `jq` 1.6 or newer and `curl` 7.76 or newer on the `PATH` of the shell that runs sections 3 to 7; Node 22 or 24.
* **Windows only:** the symlink tests of `audit.pricing_independent.test.ts` now create directory junctions, which need no administrator right and no Developer Mode.


---

## 3. Shared definitions

```bash deploy:env
set -euo pipefail
export APIFY_CLI_DISABLE_TELEMETRY=1
: "${APIFY_TOKEN:?set APIFY_TOKEN to the API token of the account that will own the Actors}"
case "$APIFY_TOKEN" in *[!A-Za-z0-9_.-]*) echo "APIFY_TOKEN has a character outside A-Z a-z 0-9 _ . -: it cannot be handed to curl as a configuration value"; exit 1 ;; esac
API="${APIFY_API_BASE:-https://api.apify.com}"
ENGINES="global-regtech-compliance-feed latam-global-tender-intelligence global-corporate-patent-intelligence"
cd master_engines
# The token is handed to curl as a configuration read from standard input (-K -): it never shows up in a process listing, and the same line works with the curl of Linux, macOS and Windows.
apify_curl() { printf 'header = "Authorization: Bearer %s"\n' "$APIFY_TOKEN" | curl --fail-with-body --silent --show-error --max-time 120 -K - "$@"; }
```

Run every block below in the same shell, in order, from the repository root. `APIFY_API_BASE` exists only so that the rehearsal can point the same commands at a local server; leave it unset for the platform.

---

## 4. Stage and verify the three packages (no token needed)

```bash deploy-manual:stage
npm ci
npx tsc --noEmit
npx vitest run                                  # all passing; the count is in section 8.9
npm install --no-save recheck                   # the analyser of the ReDoS gate is optional; without it the gate exits 2
npm run audit:redos                             # exit 0; the safe/allowlisted split follows recheck's fuzzer time budget, see 8.9
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
npx tsx scripts/generate_pricing_payloads.ts --now="$NOW" --paying-users="${PAYING_USERS:-true}" --strict --out="$OUT"
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
    def ts: sub("[.][0-9]+Z$"; "Z") | fromdateiso8601;
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

The generator itself refuses (`--strict`) any event that is neither documented in a legacy README nor ratified, a start price other than $0.005 and a `watchlist-hit` other than $0.15. The guard refuses a body that is older than 15 minutes, that does not carry exactly the notice period of the chosen variant, whose start event is not $0.005 per GB and one-time, that prices `apify-default-dataset-item` (priced, `pushData(item, eventName)` would bill two events per row), that does not have exactly one primary event, whose `watchlist-hit` is not $0.15, or whose events and prices differ from the reviewed reference files.

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
[ "${CONFIRM_PRICING:-}" = "send-pricing-to-production" ] || { echo "Set CONFIRM_PRICING=send-pricing-to-production once you have read sections 0 and 12 (G1 to G5 were decided on 2026-11-02 and are yours to reverse). A pending price change cannot be cancelled or edited."; exit 1; }
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

Sections 8.1 to 8.7 were written on 2026-10-21 for commit `5660bc4` and describe that commit, on a Linux sandbox behind an egress proxy; section 8.8 is the unpatched head `75becb3` on Windows (2026-10-30); **section 8.9 is the remediated tree of 2026-11-02, which is the one this document now describes.** Counts are what the tools printed.

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
* Section 0's gates are decisions, not facts. They were taken on 2026-11-02 by a delegate of the owner; the owner has not read them yet, and nothing in section 6 should be run before that person has.



### 8.8 Re-verification on 2026-10-30 (added; every figure below was printed by a tool on that day)

Machine: Windows 10 Home 10.0.19045, Git for Windows bash, Node 24.19.0 and Node 22.23.4 (official zip, SHA-256 `cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20` checked against nodejs.org), npm 11.17.0, `jq` 1.7.1 (SHA-256 checked against the release's `sha256sum.txt`), a shallow clone of the PR head (`git fetch --depth 1 origin pull/2/head`, 268 tracked files, `git status --porcelain` empty), dependencies by `npm ci --ignore-scripts` (248 packages, every lockfile entry from `registry.npmjs.org` with an integrity hash; only `esbuild` and `fsevents` have install scripts). **Not available:** CPython, Docker, a WSL distribution, the Apify CLI, an Apify token.

| Check | Result on 2026-10-30 |
|---|---|
| Head of PR #2 | `75becb3ff6b32cc99c3ce8ef021baf364e5c59c3`, draft, open, mergeable, 28 commits, 260 files (GitHub API, read-only); git tree of `master_engines/` `0eda465a6ff6a65eed2631feb75f470f3253b468` |
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, NodeNext) | exit 0, 6 s |
| `vitest run`, Node 24.19.0, LF checkout, `recheck` and `jq` installed | **2,347 tests in 54 files**: 2,259 passed, 64 failed, 24 skipped. All 88 are in three files and have environmental causes: `audit.pricing_independent` 19 (`EPERM` creating symlinks), `audit.redos_gate` 45 (Windows path separators, section 4 note), `deployment_runbook` 24 skipped (my first invocation put `jq` on the `PATH` in a form Git Bash mangled) |
| `vitest run`, Node 22.23.4, same tree | 2,347 tests: 2,270 passed, 77 failed: the same 19 and 45 plus 13 of the 24 runbook-rehearsal tests (Windows, section 10). Test by test, the other 2,323 tests have the same status on both Node versions |
| `npm run audit:redos` as shipped, on Windows | exit 2 without `recheck`; exit 1 with it: 5 patterns "NOT ALLOWLISTED" and 6 allowlist entries "STALE", which are the same six patterns reported with `\` instead of `/` in the file name. With the separators normalised in a scratch copy of the script: exit 0, 219 regex occurrences, 199 distinct, 194 safe, 5 flagged and allowlisted with a bound, plus the OFAC IMO entry kept because the fuzzer of `recheck` rated it safe on this run (the 2026-10-21 text says 193 safe and 6 allowlisted: the 199 total is the same, the split depends on the fuzzer's time budget) |
| Pricing bodies against Apify's current OpenAPI document | `info.version` **`v2-2026-10-29T100357Z`** (OpenAPI 3.1.2; the 2026-10-21 pass used `v2-2026-10-21T115842Z`): the six bodies the generator writes now (3 engines x `--paying-users=true/false`) validate against `UpdateActorRequest` (Draft 2020-12, `ajv` 8.20.0) and six negative controls are rejected (SHA-256 of the document `95d46c7976c0f97460cb5b479692fc08dda8bc82078f65ced5be950b5d2dfe4e`, 1,134,080 bytes) |
| `stage_actor.ts` for the three engines, audited by an independent script | 36 / 42 / 34 files staged (509 / 658 / 542 KB); `.actor/actor.json`, `input_schema.json`, `Dockerfile` byte-identical to the sources; root `Dockerfile` equals `.actor/Dockerfile`; memory pinned 2,048 / 1,024 / 1,024 MB; base image `apify/actor-node:24`; no `ENV`/`ARG`; credentials top-level `isSecret: true` with a text editor (`fdaApiKey`; `socrataAppToken`; `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`, `fdaApiKey`); none nested; no tests or `node_modules` shipped |
| Differential fuzz, TypeScript guard against the three n8n Code nodes, own generator | 12 seeds on Node 24.19.0 (36 comparisons) and 3 seeds on Node 22.23.4 (9 comparisons), 6,000 sanitiser and 3,000 normaliser inputs per seed and template: **0 mismatches** (the 3,000 matcher inputs per seed run through the TypeScript guard only, which is the only one with a matcher). The Python port could not be run |
| Mutation spot checks (one hand-made fault each) | lease never conflicts: 10 tests fail; checkpoint every 1000 rows instead of 25: 6 fail; `fdaApiKey` not `isSecret`: 3 fail; start price $0.0005: 11 new failures; U+FF9E/U+FF9F dropped from the mark cap: 1 fails (D29); **robots.txt matcher reverted to a regular expression: 0 fail** (117 tests), although a hostile file then needs more than 250 s instead of 3 ms (audit finding F-01) |
| robots.txt hostile file (260 rules of 2,048 characters, 18 tracked bots) | PR code: parse 0.4 ms, evaluate against `/` 3.0 ms, a rule of 20,001 wildcards is refused in 0.1 ms |
| Freeze manifest | 36 files, `sha256sum -c frozen_artifacts_75becb3.sha256` prints 36 `OK` (section 11) |

What this pass did **not** do: run `pytest` (no CPython; the 1,810 tests on 3.11, 3.12 and 3.13 of section 8.2 are the 2026-10-21 figures), run Docker builds, run `apify validate-schema` or `apify push` (no CLI), call `api.apify.com`, or rehearse the pricing steps end to end on Windows (section 10).

### 8.9 Verification of the remediated tree on 2026-11-02 (every figure below was printed by a tool on that day)

Machine: Windows 10 Home 10.0.19045, Git for Windows bash, Node 24.19.0 and Node 22.23.4, Vitest 3.2.7, `jq` 1.7.1, `recheck` and `ajv` 8.20.0 installed with `npm install --no-save`. The tree is PR #2 head `75becb3` plus the remediation commit. **Not available:** CPython, Docker, the Apify CLI, an Apify token, Linux, macOS.

| Check | Result on 2026-11-02 |
|---|---|
| `npx tsc --noEmit` | exit 0; also exit 0 for the `tsconfig.json` of each of the three staged packages (the file set that the image compiles) |
| `npx vitest run`, Node 24.19.0 and Node 22.23.4 | **2,383 tests in 56 files: 2,381 passed, 0 failed, 2 skipped**, the same on both. The 2,347 tests of 54 files of the unpatched head became 2,383 in 56: 22 tests of `regtech-b.aiCrawlerRobotsBounds`, 7 of `robots.policy`, and added or changed tests in `pricing.catalog`, `patents-a.aeRegisters`, `tenders-a.clDiarioOficial`, `audit.redos_gate`, `deployment_runbook` (27 now) |
| The 2 skipped | the two tests of `audit.redos_gate` that need `recheck`'s fuzzer to rate the OFAC IMO pattern *vulnerable*; they skip with a stated reason when the fuzzer rates it safe inside its time budget, which it does on this machine (finding F-04) |
| A pristine checkout with Git for Windows' default `core.autocrlf=true` | head `75becb3`: 248 of 268 files written with CR bytes (`git ls-files --eol`: `i/lf w/crlf`); the remediation commit: 6 of 277 files contain a CR byte, all of them fixtures that are byte-exact on purpose (`-text`), every generated file `w/lf`; the whole suite in that checkout: 2,383 tests, 2,381 passed, 0 failed, 2 skipped |
| `npm run audit:redos` | exit 0: 219 regex occurrences, 199 distinct, 7 dynamic `RegExp()` calls; 194 safe, 5 flagged and allowlisted with a bound, plus the IMO entry kept because the fuzzer rated it safe on this run |
| Drift | `generate_actor_files.ts` and `generate_distribution_data.ts --check`: no difference after the final edit |
| `stage_actor.ts` ×3 and the independent audit script | 37 / 43 / 35 files (523 / 674 / 558 KB), one more than on 2026-10-30 (`lib/robots_policy.ts`); 45 checks ok, 0 failing: generated `.actor/` files byte-identical to their sources, memory pinned at 2,048 / 1,024 / 1,024 MB, base image `apify/actor-node:24`, no `ENV`/`ARG`, credentials top-level `isSecret: true`, none nested |
| Pricing bodies, `--strict`, both variants | generated at 2026-11-02T21:55:19Z (`--paying-users=true` and `false`): 11 / 9 / 8 events; **6 of 6 valid against Apify's current OpenAPI document `v2-2026-11-01T214220Z`** (OpenAPI 3.1.2, SHA-256 `cf3a2547a26031d05ce6d5166300acc5a2c5e48e5c47ae93fd74cbfa8c4b96f5`, 1,134,216 bytes; the 2026-10-30 document was `v2-2026-10-29T100357Z`), 6 of 6 negative controls rejected. These bodies are stale 15 minutes after they were generated (`deploy:payload-guard`) and are evidence, not something to send |
| Rehearsal of the pricing steps on Windows Git Bash | `deployment_runbook.test.ts`, 27 tests, all pass on both Node versions: the blocks `env`, `identify`, `payloads` (with `--strict`), `payload-guard`, `preflight`, `put`, `verify` and `smoke` run against a local stand-in for the API |
| Finding F-01 reverted on purpose | the matcher put back to a regular expression built from the rule: the file-level test fails with **21,263 ms against the 50 ms bound** (18 bots × 20 rules of 2,047 wildcards); of the single-rule cases only the first fails, narrowly (58.7 ms), so on a fast machine they pass with the old form and are not the detector (the test header says so). The file was restored (`git status` clean) |
| robots.txt of the four hosts | captured 2026-11-02 into `test/fixtures/robots/`; `robots.policy.test.ts` (7 tests) evaluates every endpoint of the active connectors against them with the engines' own matcher |

What this pass did **not** do: run `pytest` (the two description strings of `distribution/python/.../engines.json` changed, so the 1,810 Python tests of section 8.2 are no longer a measurement of this tree), build an image, run `apify validate-schema` on the regenerated `input_schema.json` and `actor.json` of the patents engine, run `apify push`, call `api.apify.com`, or run anything on Linux or macOS.

---

## 9. Deployment checklist

**Before anything else**

- [ ] `git rev-parse HEAD` is the commit above (or a reviewed descendant) and `git status --porcelain` is empty.
- [ ] G1 to G5 (section 0) were read by the owner and each is accepted or changed: the decisions of 2026-11-02 were taken by a delegate and have no signature of the owner.
- [ ] `APIFY_TOKEN` belongs to the account that is meant to own the three Actors.

**Added 2026-10-30, before anything else**

- [ ] The host is Linux, macOS, WSL2 or Git Bash on Windows (section 2.1); on Windows, `jq.exe` and a native `curl` are first on the `PATH` of that shell.
- [ ] `git ls-files --eol master_engines/global-regtech-compliance-feed/.actor/Dockerfile` prints `w/lf` (no CRLF checkout).
- [ ] `git rev-parse HEAD` prints `75becb3ff6b32cc99c3ce8ef021baf364e5c59c3` (or a descendant whose diff you reviewed and for which you regenerated the freeze manifest) and `sha256sum -c docs/deployment/frozen_artifacts_75becb3.sha256` prints 36 lines ending in `OK` (section 11).
- [ ] `npm install --no-save recheck` ran before `npm run audit:redos`, and the gate printed no `NOT ALLOWLISTED` and no `STALE` line.
- [ ] `npx vitest run` printed 2,347 tests in 54 files with none failing. Anything lower is an environment you should fix before you trust the other lines (symlinks, path separators, bash and `jq` are what failed on Windows).


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
- [ ] `CONFIRM_PRICING` was set by a person, in this shell, after reading sections 0 and 12.
- [ ] `deploy:verify` printed `pricing read back matches` three times.

**After the push (section 7)**

- [ ] The three smoke runs ended `SUCCEEDED` with items (an upstream outage is a reason to retry, not to proceed blind).
- [ ] The held-source run ended `FAILED` with the held reason.
- [ ] Nothing was published: no Store listing exists until the listing texts are written and the Actors are made public.

---

## 10. Windows hosts (Git Bash, PowerShell): what failed on 2026-10-30 and what is verified

**Status of 2026-11-02: rows 1 to 5 are repaired in the patch (section 12) and the whole suite, the rehearsal of the pricing steps included, passes on this Windows host (section 8.9).** Linux and macOS were not available and are not claimed. The table is kept as the record of what failed on 2026-10-30 (Windows 10 Home 10.0.19045, Git for Windows bash, `curl` from `/mingw64/bin`, `jq` 1.7.1 `jq-windows-amd64.exe`, Node 24.19.0), because it explains why the blocks are written the way they now are:

| # | What happens | Cause | Verified remedy |
|---|---|---|---|
| 1 | `deploy:env`: every `apify_curl` call fails with `curl: Failed to open /proc/1899/fd/63` and `option -H: error encountered when reading a file` | `-H @<(printf ...)` is bash process substitution; Git Bash exposes it as `/proc/<pid>/fd/N`, which the native Windows `curl` cannot open | `printf 'header = "Authorization: Bearer %s"\n' "$APIFY_TOKEN" \| curl -K - ...` hands the header to `curl` as a configuration read from standard input. Tried against a local echo server with a fake token: the server received `Authorization: Bearer apify_api_FAKE123`, and the `curl` command line holds no token. It cannot be combined with `--data-binary @-` (stdin is taken), which the blocks do not use |
| 2 | `deploy:payload-guard` stops with `jq: error: Invalid escape at line 1, column 4 (while parsing '"\."')` | the program `def ts: sub("\\.[0-9]+Z$"; "Z")` loses one backslash on its way from Git Bash to the native `jq.exe` | `jq` itself accepts the program: started directly from Node it printed the normalised timestamp, and read from a file with `-f` it also worked. The guard is the safety check of section 6, so no rewritten copy is offered here: run section 6 on Linux, macOS or WSL2 |
| 3 | 8 to 16 of the 24 tests of `deployment_runbook.test.ts` fail, depending on the run | the same two causes; in addition the test spawns `npx` without a shell, which Windows cannot resolve | with a `curl` wrapper that reads the header file itself and with the three `spawnSync('npx', ...)` calls pointed at `node_modules/tsx/dist/cli.mjs` (scratch copy, not committed), 16 of 24 passed and 8 failed, all 8 in blocks that run the jq guard |
| 4 | `actor_files` and `distribution_sync` fail on a fresh Windows clone | CRLF checkout (section 2.1) | `core.autocrlf=false` |
| 5 | 19 tests of `audit.pricing_independent` fail with `EPERM: operation not permitted, symlink` | creating symbolic links needs administrator rights or Windows Developer Mode | run the suite elevated, in Developer Mode, or on Linux |

Sections 4 and 5 (staging and `apify push`) were not exercised on Windows: the staging script ran and its output was audited (section 8.8), but no Apify CLI was installed and `apify push` was not run.

---

## 11. Freeze manifest (added 2026-10-30)

`frozen_artifacts_75becb3.sha256` (next to this file) lists the SHA-256 of the 36 files whose bytes decide what is deployed and at what price: the nine generated `.actor/` files (`actor.json`, `input_schema.json`, `Dockerfile` of each engine), `package.json`, `package-lock.json`, the six reference pricing bodies, the event catalogue and the body builder, `stage_actor.ts`, `generate_pricing_payloads.ts`, the ReDoS gate and its allowlist, and the thirteen files of `lib/`. The git tree id of `master_engines/` at the same commit is `0eda465a6ff6a65eed2631feb75f470f3253b468`, which commits to every other file under it.

```bash
# from the repository root, LF checkout, before section 4
git rev-parse HEAD                    # 75becb3ff6b32cc99c3ce8ef021baf364e5c59c3
git rev-parse HEAD:master_engines     # 0eda465a6ff6a65eed2631feb75f470f3253b468
sha256sum -c docs/deployment/frozen_artifacts_75becb3.sha256     # 36 lines, each ending in ": OK"
```

The manifest is valid for that commit only. Any later commit needs a new manifest and a new review; a manifest that is regenerated to make a failing check pass proves nothing.

### 11.2 Freeze manifest of the remediated tree (added 2026-11-02)

`frozen_artifacts_remediated_2026-11-02.sha256` (next to this file) lists the SHA-256 of 52 files: the 36 of section 11 (whose content changed where the remediation touched them), plus `.gitattributes`, `lib/robots_policy.ts`, the two connector files that apply the policy, `aiCrawlerSignals.ts` (the matcher of finding F-01), `scripts/actor_files.ts`, `scripts/redos_second_opinion.mjs`, the Python `engines.json`, the four robots.txt fixtures, the two new test files, this runbook and the schedule of gate G5. `sha256sum -c docs/deployment/frozen_artifacts_remediated_2026-11-02.sha256` from the repository root must print 52 lines ending in `OK`.

The patch itself, `remediation_2026-11-02.patch` (a `git format-patch` of one commit on top of `75becb3`), has its SHA-256 in the sidecar `remediation_2026-11-02.patch.sha256`; it cannot be written here, because the patch contains this file. Apply it to a checkout of `75becb3` with `git apply --index remediation_2026-11-02.patch` or `git am --keep-cr remediation_2026-11-02.patch` (both were measured to give the same tree). **Plain `git am` is wrong here**: it strips the carriage returns of the byte-exact fixtures and yields a different tree. The tree id cannot be written in this file, which is part of the tree; compare with the manifest instead: `sha256sum -c` must print  lines ending in `OK`. A manifest that is regenerated to make a failing check pass proves nothing.

---

## 12. Remediation of 2026-11-02, and the production execution sequence

### 12.1 What was changed, and where the proof is

| Finding | Change | Proof |
|---|---|---|
| F-01 the ReDoS regression test did not fail when the fix was reverted | `test/regtech-b.aiCrawlerRobotsBounds.test.ts`: hostile rules (2,047 consecutive wildcards and five other shapes) against `/` and against 2,000-character paths, a hostile file for all tracked bots, a 512 KiB file; best of several runs under 50 ms | fails with the regular-expression form put back (section 8.9) |
| F-02 `recheck` is optional and the gate exits 2 without it | the `stage` block says `npm install --no-save recheck`; making `recheck` a pinned devDependency was **not done**, because it changes `package.json` and the lockfile | section 4 |
| F-03 the gate and its tests assume `/` in paths | `toPosix()` in `redos_audit.mjs` and `redos_second_opinion.mjs` | gate exit 0 on Windows; `audit.redos_gate` 95 passed, 2 skipped |
| F-04 the split safe/allowlisted is not machine-independent | the test asserts that every flagged pattern is allowlisted and that allowlisted plus kept entries equal the entries of the file | same |
| F-05 no `.gitattributes` | `.gitattributes`: LF for text, `-text` for the byte-exact fixtures | pristine `core.autocrlf=true` checkout passes the whole suite (section 8.9) |
| F-06 the blocks fail on Windows Git Bash | `curl -K -` with the header on standard input and a token guard; no backslash inside a `jq` program; `tsx` started through `node` | `deployment_runbook.test.ts`, 27 tests |
| F-07 symbolic links need a privilege | directory junctions on `win32` | `audit.pricing_independent`, 79 tests |
| G1 to G3 | ratifications in `pricing/event_catalog.ts`, each bound to the price it was decided for; `--strict` refuses an undecided or moved price, another start price and another hit price; the notice file carries them | `pricing.catalog.test.ts`, 43 tests |
| G4 | `lib/robots_policy.ts`, the DIFC and Diario Oficial refusals at preflight, four captured robots.txt files | `robots.policy.test.ts`, 7 tests, and the connector tests |
| G5 | `legacy_actor_review_schedule.md`; no code retires anything | `deployment_runbook.test.ts` checks that it exists and lists 23 Actors |

Found by reading the patch again before this section was written (the audit report, section 10.4, has the detail): a ratification could outlive the price it was decided for (now bound); the patents Actor's Store description still advertised "ADGM/DIFC" (now "ADGM"); a condition of the ClinicalTrials.gov exception said that a 429 ends the leg, while the shared client retries it (corrected to what the code does); a sentence of the F-01 test header overstated how far the single-rule cases fail when the fix is reverted (corrected).

### 12.2 The production execution sequence

This is the order in which a person runs the blocks of this document. It does not run them for you: the pricing step cannot be undone and the owner has not yet read this revision.

1. **Read** sections 0 and 12 and the audit report. Accept or change G1 to G5. If a price changes, change the catalogue constant and its ratification in `pricing/event_catalog.ts`, regenerate the reference payloads (`generate_pricing_payloads.ts --now=2026-10-21T00:00:00.000Z --strict`) and the distribution data, and run the suite: the tests that pin the old numbers will say what else moves.
2. **Get the tree.** A checkout of `75becb3ff6b32cc99c3ce8ef021baf364e5c59c3` with the patch applied (`git am --keep-cr remediation_2026-11-02.patch`, never plain `git am`), after a review that is yours. `sha256sum -c docs/deployment/frozen_artifacts_remediated_2026-11-02.sha256` prints 52 lines ending in `OK`. The patch is not in PR #2; getting it there is your push.
3. **Local build and gates** (`deploy-manual:stage`, section 4): `npm ci`, `npm install --no-save recheck`, `npx tsc --noEmit`, `npx vitest run`, `npm run audit:redos`, `stage_actor.ts` for the three engines, `apify validate-schema` in each staged directory. Run `pytest` in `distribution/python` on 3.11, 3.12 and 3.13 (not run on this tree).
4. **Login and push** (`deploy-manual:push`, section 5): `apify login --token "$APIFY_TOKEN"`, `apify info`, `apify push --wait-for-finish 900` in each `stage/<slug>`. The Actors are created private. Check the builds (`deploy-manual:builds`).
5. **Canary first.** After the shared definitions (`deploy:env`) set `ENGINES="global-regtech-compliance-feed"` to price one Actor, run steps 6 and 7 for it, and only then widen `ENGINES` to the other two. The reason is in the audit report: whether the platform accepts a first pricing record is unverified.
6. **Price** (section 6, same shell, minutes apart): `deploy:identify`, `deploy:payloads` (`--strict`, `--now` at this moment), `deploy:payload-guard`, `deploy:preflight`, then `CONFIRM_PRICING=send-pricing-to-production` typed by you and `deploy:put`, which sends `PUT /v2/actors/<username>~<slug>` with the generated body, then `deploy:verify`. Variant A (`PAYING_USERS` unset or `true`) puts `startedAt` 14 days out (Terms 9.4); variant B (`PAYING_USERS=false`) is only for an Actor that has never had a paying user.
7. **Smoke** (section 7): `deploy:smoke`, then `deploy-manual:held-check`. A run inside the 14-day window carries no pay-per-event pricing; the first priced run is after `startedAt`.
8. **Publish** is not covered: the Store listing texts do not exist. **Retire nothing**: gate G5 is a schedule that starts at the first priced run.

### 12.3 What stands between this and "ready for live"

* The patch is **unreviewed and unpushed**; PR #2 is untouched. Whoever reviews it should read `lib/robots_policy.ts`, `pricing/event_catalog.ts` and `pricing/build_put_payloads.ts` first.
* **G1 to G5 were decided by a delegate and not read by the owner.** G4's ClinicalTrials.gov exception rests on an interpretation, and the operator's terms of use could not be read.
* G5 departs from the brief (an automated sunset): it keeps the legacy Actors live, as the owner decided on 2026-10-16.
* Nothing has run on the platform; the Python suite, the Docker builds, `apify validate-schema` and `apify push` were not run on this tree; Linux and macOS were not available.
* No Store listing text exists, and the keyword floor (finding F-11) is still an owner decision.
