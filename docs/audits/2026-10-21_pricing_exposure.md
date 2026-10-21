# Pricing exposure audit

Prices come from the committed `pricing/payloads/*.put.json` literals, memory from `.actor/actor.json`, default hit caps from `.actor/input_schema.json`. All arithmetic is integer micro-USD; amounts are shown as USD with 6 decimals.

## global-regtech-compliance-feed

Memory 2048 MB (pinned) = 2 start event(s) per run.

| Event | Price (USD) | Basis | Billed by |
| --- | ---: | --- | --- |
| `apify-actor-start` | 0.005000 | platform | every run, once per GB of memory |
| `vessel-record` | 0.000500 | legacy-readme | ofac (delivered row, by delta class) |
| `debarment-record` | 0.003000 | legacy-readme | world_bank_debarred (delivered row, by delta class) |
| `statement-new` | 0.020000 | legacy-readme | uk_modern_slavery (delivered row, by delta class) |
| `statement-updated` | 0.010000 | legacy-readme | uk_modern_slavery (delivered row, by delta class) |
| `enforcement-release` | 0.050000 | legacy-readme | sec_enforcement (delivered row, by delta class) |
| `enforcement-update` | 0.020000 | legacy-readme | sec_enforcement (delivered row, by delta class) |
| `crawler-signal` | 0.015000 | provisional | ai_crawler_signals (delivered row, by delta class) |
| `crawler-signal-change` | 0.006000 | legacy-readme | ai_crawler_signals (delivered row, by delta class) |
| `recall-record` | 0.001000 | legacy-readme | fda_ema_recalls (delivered row, by delta class) |
| `watchlist-hit` | 0.150000 | operator-stated | any delivered row whose text matches a watchlist keyword (after the journal write) |

| Figure | USD | Derivation |
| --- | ---: | --- |
| Start cost of an empty run | 0.010000 | 0.005000 x 2 GB |
| Dearest source event | 0.050000 | `enforcement-release` (sec_enforcement) |
| Worst-case cost of one delivered row | 0.200000 | 0.050000 + watchlist-hit 0.150000 |
| Worst-case 1000-row run, every row a hit (no caps) | 200.010000 | 0.010000 + 1000 x 0.200000 |
| Worst-case 1000-row run under the default hit caps | 80.010000 | 0.010000 + 1000 x 0.050000 + 200 hits x 0.150000 (caps: 200 hits, 50.000000 spend) |
| Worst-case double bill from ONE hard kill (delivery journal) | 0.050000 | one row in flight: the dearest row event only (the hit is charged after the journal write, so a kill cannot repeat it) |
| Same kill with the old 25-row checkpoint window | 5.000000 | 25 x 0.200000 (row + hit) |
| Committed minimalMaxTotalChargeUsd | 0.160000 | pricing/payloads put.json |
| Budget for the start events plus one matched row | 0.210000 | 0.010000 + 0.200000 |

## latam-global-tender-intelligence

Memory 1024 MB (pinned) = 1 start event(s) per run.

| Event | Price (USD) | Basis | Billed by |
| --- | ---: | --- | --- |
| `apify-actor-start` | 0.005000 | platform | every run, once per GB of memory |
| `tender-detail` | 0.003000 | legacy-readme | ar_santafe, ar_tucuman, ar_entrerios, cl_diario_oficial, us_florida (delivered row, by delta class) |
| `tender-summary` | 0.001000 | legacy-readme | ar_santafe, us_florida (record-level override: row delivered from the listing without a detail fetch) |
| `notice-record` | 0.001000 | legacy-readme | world_bank_notices (delivered row, by delta class) |
| `notice-new` | 0.020000 | legacy-readme | eu_ted (delivered row, by delta class) |
| `notice-updated` | 0.010000 | legacy-readme | eu_ted (delivered row, by delta class) |
| `grant-new` | 0.020000 | legacy-readme | it_lombardia_grants (delivered row, by delta class) |
| `grant-updated` | 0.008000 | provisional | it_lombardia_grants (delivered row, by delta class) |
| `watchlist-hit` | 0.150000 | operator-stated | any delivered row whose text matches a watchlist keyword (after the journal write) |

| Figure | USD | Derivation |
| --- | ---: | --- |
| Start cost of an empty run | 0.005000 | 0.005000 x 1 GB |
| Dearest source event | 0.020000 | `notice-new` (eu_ted) |
| Worst-case cost of one delivered row | 0.170000 | 0.020000 + watchlist-hit 0.150000 |
| Worst-case 1000-row run, every row a hit (no caps) | 170.005000 | 0.005000 + 1000 x 0.170000 |
| Worst-case 1000-row run under the default hit caps | 50.005000 | 0.005000 + 1000 x 0.020000 + 200 hits x 0.150000 (caps: 200 hits, 50.000000 spend) |
| Worst-case double bill from ONE hard kill (delivery journal) | 0.020000 | one row in flight: the dearest row event only (the hit is charged after the journal write, so a kill cannot repeat it) |
| Same kill with the old 25-row checkpoint window | 4.250000 | 25 x 0.170000 (row + hit) |
| Committed minimalMaxTotalChargeUsd | 0.160000 | pricing/payloads put.json |
| Budget for the start events plus one matched row | 0.175000 | 0.005000 + 0.170000 |

## global-corporate-patent-intelligence

Memory 1024 MB (pinned) = 1 start event(s) per run.

| Event | Price (USD) | Basis | Billed by |
| --- | ---: | --- | --- |
| `apify-actor-start` | 0.005000 | platform | every run, once per GB of memory |
| `patent-proceeding` | 0.002000 | legacy-readme | uspto_ptab, epo_opposition (delivered row, by delta class) |
| `clinical-record` | 0.002000 | legacy-readme | clinicaltrials_orange_book (delivered row, by delta class) |
| `uae-entity-new` | 0.020000 | legacy-readme | ae_registers (delivered row, by delta class) |
| `uae-entity-updated` | 0.010000 | provisional | ae_registers (delivered row, by delta class) |
| `sg-entity-new` | 0.030000 | legacy-readme | sg_acra (delivered row, by delta class) |
| `sg-entity-updated` | 0.010000 | provisional | sg_acra (delivered row, by delta class) |
| `watchlist-hit` | 0.150000 | operator-stated | any delivered row whose text matches a watchlist keyword (after the journal write) |

| Figure | USD | Derivation |
| --- | ---: | --- |
| Start cost of an empty run | 0.005000 | 0.005000 x 1 GB |
| Dearest source event | 0.030000 | `sg-entity-new` (sg_acra) |
| Worst-case cost of one delivered row | 0.180000 | 0.030000 + watchlist-hit 0.150000 |
| Worst-case 1000-row run, every row a hit (no caps) | 180.005000 | 0.005000 + 1000 x 0.180000 |
| Worst-case 1000-row run under the default hit caps | 60.005000 | 0.005000 + 1000 x 0.030000 + 200 hits x 0.150000 (caps: 200 hits, 50.000000 spend) |
| Worst-case double bill from ONE hard kill (delivery journal) | 0.030000 | one row in flight: the dearest row event only (the hit is charged after the journal write, so a kill cannot repeat it) |
| Same kill with the old 25-row checkpoint window | 4.500000 | 25 x 0.180000 (row + hit) |
| Committed minimalMaxTotalChargeUsd | 0.160000 | pricing/payloads put.json |
| Budget for the start events plus one matched row | 0.185000 | 0.005000 + 0.180000 |

## Summary

| Engine | Empty run | One row (worst) | 1000 rows (no caps) | 1000 rows (default caps) | One kill (journal) | One kill (old 25-row window) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| global-regtech-compliance-feed | 0.010000 | 0.200000 | 200.010000 | 80.010000 | 0.050000 | 5.000000 |
| latam-global-tender-intelligence | 0.005000 | 0.170000 | 170.005000 | 50.005000 | 0.020000 | 4.250000 |
| global-corporate-patent-intelligence | 0.005000 | 0.180000 | 180.005000 | 60.005000 | 0.030000 | 4.500000 |

## Price basis

| Engine | legacy-readme | provisional | operator-stated |
| --- | ---: | ---: | ---: |
| global-regtech-compliance-feed | 8 | 1 | 1 |
| latam-global-tender-intelligence | 6 | 1 | 1 |
| global-corporate-patent-intelligence | 4 | 2 | 1 |
| **all engines** | 18 | 4 | 3 |

## Notes

- The one-kill figure is exact, not a bound: the router charges a watchlist-hit only after the row is journaled, so a kill can repeat only the row event in flight (the hit it would have triggered was never charged; the repeated run charges it once). The one-kill figure assumes the dearest source event.
- Start events: memory above 1024 MB is charged once per started GB, as documented by Apify; the Actor memory is pinned so the figure is exact.
- The platform per-run charge limit (maxTotalChargeUsd) set by the caller caps every run-level figure above.

