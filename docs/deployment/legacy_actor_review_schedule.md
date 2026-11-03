# Legacy Actor review schedule (decision G5, 2026-11-02)

| | |
|---|---|
| Decision | **No automated sunset.** The 23 legacy Actors that the three Master Engines are meant to replace stay live. A review schedule with entry criteria replaces the timer that the brief asked for. |
| Taken | 2026-11-02, by a delegate of the owner under the owner's mandate of that day (authority to settle G1 to G5). The owner can reverse it. |
| Executed | **Nothing.** No legacy Actor was changed, deprecated, unpublished, re-priced or had a notice set. This file is the only artefact of the decision. |
| Companion | [`production_deployment_runbook.md`](production_deployment_runbook.md), section 0 (gate G5) |

## 1. Why not a timer

1. **The owner already decided the opposite.** On 2026-10-16 the sunset of the legacy fleet was cancelled and the Actors were kept live (`_audit/EXECUTION_AND_RESULTS_LOG.md` of the owner's suite). A later instruction to automate a sunset does not say that the earlier decision was reversed; a retirement that nobody can stop is the one version of the decision that is not reversible by looking at it again.
2. **A timer counts from nothing.** The engines have never run on the Apify platform. A date counted from today, or from the push, would arrive before there is a single priced run to compare the legacy Actor with.
3. **Six of the 23 have no active replacement** (table 2). Retiring them would remove the only working implementation of what they do.
4. **Retirement is partly irreversible.** A deprecated Actor is no longer searchable in the Store (the platform documents this; the flag itself can be switched back, but the listing's standing while it was hidden cannot be recovered). Whoever takes that step should be looking at the Actor the day they take it.

## 2. The 23 legacy Actors and what stands in for each in the engines of PR #2

"Active" means a connector that runs; "held" means the engine refuses to run it and says why. The state is the one of the remediated tree of 2026-11-02 (G4 applied). Runs and users are the 30-day figures printed by the owner's lifecycle tool on 2026-10-20 (`docs/evidence/lifecycle.txt`); whether the owner's own test runs are counted among the users is not documented.

| # | Legacy Actor (slug) | Engine | Source in the engine | State | Runs / users, 30 d | Review path |
|---|---|---|---|---|---|---|
| 1 | `ofac-un-vessel-sanctions-monitor` | regtech | `ofac` | active | 26 / 1 | R1 to R3 |
| 2 | `ai-crawler-content-signal-permission-monitor` | regtech | `ai_crawler_signals` | active | 26 / 1 | R1 to R3 |
| 3 | `uk-modern-slavery-statement-registry-monitor` | regtech | `uk_modern_slavery` | active | 27 / 1 | R1 to R3 |
| 4 | `sec-enforcement-litigation-delta-feed` | regtech | `sec_enforcement` | active | 26 / 1 | R1 to R3 |
| 5 | `world-bank-procurement-debarment-monitor` | regtech | `world_bank_debarred` | active | 27 / 1 | R1 to R3 |
| 6 | `fda-ema-drug-recall-monitor` | regtech | `fda_ema_recalls` | active | 27 / 1 | R1 to R3 |
| 7 | `santafe-compras-monitor` | tenders | `ar_santafe` | active | 53 / 2 | R1 to R3 |
| 8 | `tucuman-compras-monitor` | tenders | `ar_tucuman` | active | 53 / 2 | R1 to R3 |
| 9 | `entrerios-compras-monitor` | tenders | `ar_entrerios` | active | 33 / 1 | R1 to R3 |
| 10 | `diario-oficial-cl-monitor` | tenders | `cl_diario_oficial` | **partial**: one of seven sections (`normas_generales`, G4) | 29 / 2 | R1 to R3 only if no caller used another section (C1) |
| 11 | `eu-ted-procurement-delta-monitor` | tenders | `eu_ted` | active | 27 / 1 | R1 to R3 |
| 12 | `florida-tenders-monitor` | tenders | `us_florida` | active | 33 / 1 | R1 to R3 |
| 13 | `regione-lombardia-grants-registry-monitor` | tenders | `it_lombardia_grants` | active | 26 / 1 | R1 to R3 |
| 14 | `ptab-epo-patent-dispute-monitor` | patents | `uspto_ptab`, `epo_opposition` | active (BYOK keys) | 27 / 1 | R1 to R3 |
| 15 | `clinicaltrials-orange-book-delta` | patents | `clinicaltrials_orange_book` | active under the ClinicalTrials.gov exception (G4) | 27 / 1 | R1 to R3, and only while the exception stands |
| 16 | `singapore-acra-registry-monitor` | patents | `sg_acra` | active | 26 / 1 (5 of 26 runs failed) | R1 to R3 |
| 17 | `uae-corporate-registry-monitor` | patents | `ae_registers` | **partial**: ADGM only, DIFC held (G4) | 40 / 4 | R1 to R3 only if no caller used DIFC (C1) |
| 18 | `cordoba-compras-monitor` | tenders | `ar_cordoba` | **held** (the portal blocks non-residential traffic) | 52 / 2 | never while held |
| 19 | `salta-compras-monitor` | tenders | `ar_salta` | **held** | 53 / 2 | never while held |
| 20 | `mendoza-compras-monitor` | tenders | `ar_mendoza` | **held** | 53 / 2 | never while held |
| 21 | `pba-tenders-monitor` | tenders | `ar_pba` | **held** | 38 / 1 | never while held |
| 22 | `australia-grantconnect-monitor` | tenders | `au_grantconnect` | **held** | 27 / 1 | never while held |
| 23 | `emerging-market-sovereign-debt-auction-monitor` | none | none: no engine has a connector for it | **no replacement** | 27 / 1 | never |

17 are active (two of them partly), 5 are held and 1 has no counterpart. The held Argentine portals and the Australian one were held by the operator, not by this decision; the policy of 2026-11-02 changes the Diario Oficial and the UAE register only.

Five other Actors of the fleet are outside the engines and outside this schedule: `aozora-bunko-public-domain-text-feed`, `kipris-patent-trademark-status-monitor`, `osm-b2b-lead-verifier`, `page-metadata-extractor` and `uk-hse-enforcement-monitor` (already deprecated by the platform as UNDER_MAINTENANCE).

## 3. The calendar

Every date is counted from **T0**, defined per engine as the day of its first run that the platform bills, that is the first run after the `startedAt` of its pricing record. With Variant A of the runbook (14 days of notice, section 9.4 of the Store Publishing Terms) T0 is at least 14 days after the pricing request; nothing earlier counts, because a run inside the notice window carries no pay-per-event pricing.

| Review | When | What it does | What it may decide |
|---|---|---|---|
| R0 | the day of the pricing request | nothing about the legacy Actors | nothing |
| R1 | T0 + 30 days | reads the lifecycle table and the run history of the engine; checks C2 and C3 for every row of table 2 marked R1 to R3 | which rows pass; nothing is changed |
| R2 | T0 + 60 days | repeats R1; for rows that passed twice the owner may, by command, add a pointer to the engine to the legacy Actor's README or notice | a notice, by the owner's command only |
| R3 | T0 + 90 days | repeats R1 and R2; checks C4 and C5 | for rows that passed all three reviews, whether the owner types the deprecation command |

The earliest day any legacy Actor can be deprecated under this schedule is therefore **T0 + 90 days, which is at least 104 days after the pricing request**. If the engines are never priced, or never run, no date arrives.

## 4. Entry criteria (all must hold, per legacy Actor, at the review)

* **C1, an active replacement.** The row's source is active in the deployed engine. For a partial row (10, 17) the missing part was not used by any caller of the legacy Actor in the last 90 days.
* **C2, a track record.** The replacement ran at least 10 scheduled platform runs that ended `SUCCEEDED` in the last 30 days, with at most 5 percent of its runs failed or timed out.
* **C3, parity.** For one input run through both the legacy Actor and the engine, the row counts agree within 5 percent and no field of the legacy output is missing from the engine's (the field mapping of `docs/evidence/coverage_*.txt` records 0 dropped fields per source; this checks that the deployed build still honours it).
* **C4, no one is left behind.** The legacy Actor has no user other than the owner in the last 30 days, or every such user was told at least 30 days earlier through the legacy README or notice.
* **C5, no open complaint** on the legacy Actor's Store page or Console about the replacement.
* **C6, the owner's command.** Retirement is a command the owner types for one Actor. No script, schedule or agent runs it.

The thresholds (10 runs, 5 percent, 30 days) are decisions of 2026-11-02, not facts about the platform; change them here if they are wrong.

## 5. How a retirement is done, once a row has passed

Not before R3 and not for more than one Actor per day. The suite's `block1/lifecycle_status.js deprecate <slug>` prints what it would do and changes nothing unless it is given its confirmation flags; read the dry run first. Deprecation is reversible (`isDeprecated=false`), a notice can be removed, and neither deletes data. **Deleting a legacy Actor is outside this schedule** and is not proposed.

## 6. What this schedule does not do

It does not publish the engines, does not price them, does not touch any legacy Actor's price, README, notice or visibility, and does not claim that the engines already replace anything: they have never run on the platform. The first review that can say whether they do is R1.
