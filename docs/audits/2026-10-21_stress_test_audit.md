# Verification audit: stress-test sprint over the three Master Engines

| | |
|---|---|
| Date | 2026-10-21 |
| Subject | `master_engines/` on branch `claude/busy-fermi-yhcyfl` (draft PR #2): `global-regtech-compliance-feed`, `latam-global-tender-intelligence`, `global-corporate-patent-intelligence`, and `master_engines/distribution/` (Python SDK, LangChain tools, n8n templates) |
| Status of what was audited | Implemented and tested locally. **Not deployed. Nothing was run on the Apify platform, in n8n, or against any paid API.** |
| Companion documents | [`apify_portfolio_refactor_strategy_2026.md`](../apify_portfolio_refactor_strategy_2026.md) (design, findings register RA-1 to RA-46, known gaps), [`2026-10-21_pricing_exposure.md`](2026-10-21_pricing_exposure.md) and [`2026-10-21_unit_economics.md`](2026-10-21_unit_economics.md) (generated tables), [`master_engines/distribution/README.md`](../../master_engines/distribution/README.md) |

Everything below was measured or read in this repository on 2026-10-21. A figure that is a one-off measurement says so. Where a claim of the engagement brief could not be reproduced, it is listed as such in section 2 and in section 1.2 of the strategy document.

---

## 1. Result in one table

| Block | Asked | Result |
|---|---|---|
| 1 | Forensic audit of the market-traction figures; consolidation check | The 23-of-28 / 82.2 percent / -$2.25 figures are **not in the repository and could not be verified** (no Apify token); 23 / 28 is 82.1 percent, not 82.2. The consolidation (22 repositories absorbed into 3 Actors, source lines down 15 percent while five README-only stubs became real connectors) **is** measured. Section 2 |
| 2 | Adversarially validate the test suite | **2,323 TypeScript tests in 53 files and 1,810 Python tests (on each of 3.11, 3.12, 3.13) pass; the TypeScript suite also passes on Node 24.22.0, the runtime of the Actor image.** The suite was attacked with mutation testing (87 hand-made mutants over three rounds; 9 survived on the first attempt, each led to a stronger test, none survive now), a reference model written from the specification, exhaustive code point sweeps, a differential fuzz of 144,000 inputs per implementation, a platform parity harness (the real SDK and `apify-client` against a mock of the REST API), four independent reviews of the guard and two of the lease and state code. Sections 3.1, 3.2 |
| 2 | Billing atomicity under platform failures | Fault injection (2,700 seeded scenarios, 1 to 3 coincident faults each, plus directed scenarios and negative controls) and the real Apify SDK in child processes: **a hard kill repeats and re-bills at most the one row in flight** (exact dollar exposure per kill in the exposure table). Two overlapping runs of one namespace are now refused (run lease, best effort); an overtaken run no longer writes over the run that took its lease. A corrupt state record fails its source instead of restarting it. **The review that built the platform parity harness found that every run of every engine would have died on the platform** (the delta memory was listed with a method the platform's client does not have; local storage and every test double had it): fixed (RA-29). Section 3.3 |
| 2 | ReDoS bounds, `npm run audit:redos` | 219 regex occurrences, 199 distinct, **193 safe, 6 flagged and allowlisted** with a written bound and a named enforcing test each, 7 dynamic `RegExp()` calls none of which takes external input; exit code 0. The gate itself was hardened (RA-16). Section 3.4 |
| 2 | State checkpointing | Checkpoint every 25 rows and in `finally`, per-row delivery journal, fail-closed corrupt records, run lease. Section 3.5 |
| 2 | Keyword-guard hardening (`["", "   "]`, `["--"]`, nulls, zero-width) | Every input named in the brief yields **0 accepted keywords and 0 hits**; the guard went through four independent review rounds (findings RA-8 to RA-12, RA-17, RA-22 to RA-28 and RA-39 to RA-46 in the register, all fixed; the remaining limits are documented, not hidden). Section 3.6 |
| 3 | Pricing and Store Publishing Terms 9.4 | Verified; one premise of the brief (section number) was wrong. Per-source prices carry their evidence; three prices remain operator-stated or provisional (decisions 4 and 5 stay **open**). Section 4.1 |
| 3 | `actor.json`, `input_schema.json`, Dockerfile in sync, BYOK secrets as top-level `isSecret` | Generated from one source and checked by an independent test; secret fields are top level and never inside `sourceOptions`. Section 4.2 |
| 3 | Python and LangChain wrappers, n8n templates, three-phase timeline | Built and tested offline; **never run against the platform or inside n8n**. Timeline with gates in strategy section 13. Section 4.3 |

---

## 2. Block 1: traction and consolidation

Detail and evidence are in strategy section 12. Short form:

* **Unverifiable:** "23 of 28 Actors had zero traction and zero revenue in October 2026", "82.2 percent", "net operating margin of -$2.25 per month before factoring", and the "Zero-Query Trap". None appears in any of the 37 cloned repositories; Store and Console analytics need the account owner's token. The arithmetic does not match (23 / 28 = 82.14 percent). The Zero-Query Trap is a plausible hypothesis with a falsifiable 14-day test (strategy 12.3), not a finding.
* **Verified from the corpus:** 22 legacy repositories are absorbed into three engines; per-repository manifest files fall from 90 to 10; source lines of the repositories with an active connector fall from 18,093 to 15,302 while five README-only stubs (SEC, ACRA, AI crawler, ClinicalTrials, Lombardia) became real connectors; four of the seven provincial Argentine portals cannot run (held, with reasons).
* **Not a result:** consolidated Store SEO and reviews. Nothing is published, no Actor id is reserved, the listing texts are not written.

---

## 3. Block 2: adversarial validation

### 3.1 Test inventory (measured 2026-10-21 on the commit this report ships with)

| Suite | Count | Runtime |
|---|---:|---|
| TypeScript, `vitest run` | **2,323 tests in 53 files**, all passing; strict `tsc --noEmit` clean | Node 22.22.0 (also Node 24.22.0, the `apify/actor-node:24` image's runtime: same 2,323 / 53, all passing) |
| Python, `pytest` in `distribution/python` | **1,810 tests**, all passing, on each of Python 3.11.17, 3.12.3, 3.13.16 | `apify-client` 3.3.0, `pydantic` 2.14.1, `langchain-core` 1.6.12 |
| Differential fuzz (committed, `distribution/tools/differential_fuzz`) | 12 seeds (401 to 412), 144,000 inputs per implementation, **0 differences** between the TypeScript guard, the Python port on 3.11/3.12/3.13 and the n8n Code nodes on Node 22.22.0; 3 more seeds (421 to 423, 36,000 inputs) each on Node 20.20.0 and Node 21.7.3, also 0 | |

The engagement brief's "1,474+" is the count at an earlier commit (1,474 in 42 files); the suite has grown by 849 tests and 11 files since, mostly the stress suites listed below. Tests are fixture-driven and offline except the scenarios that run the real Apify SDK (`Actor`, `ChargingManager`, local dataset and key-value store) in child processes.

The suites written for this sprint (all in `master_engines/test/`):

| File | What it attacks |
|---|---|
| `stress.guards_fuzz.test.ts` | The keyword guard. A **reference model written from the specification** (not from the code), a 266-row hand-written hostile corpus with every expectation derived by hand, 31 regression tests named D1 to D31 (one per defect found), exhaustive sweeps of all 1,114,112 code points (alone, doubled, at both ends of a word, inside one), property tests (idempotence, order independence, fixed point, every hit a real substring), poisoned and valid watchlists end to end through `runEngine` |
| `stress.atomicity_chaos.test.ts` + `support/chaos_platform.ts` | Billing and state atomicity against a simulated platform with fault injection at every point a real one can fail (section 3.3) |
| `audit.pricing_independent.test.ts`, `audit.actor_config_independent.test.ts` | Pricing payloads and the generated Actor files, recomputed by code that does not import the generators |
| `audit.redos_gate.test.ts` (97 tests) | The ReDoS gate itself: it must fail when it should (section 3.4) |
| `audit.unit_economics.test.ts` | The unit-economics script |
| `core.lease.test.ts` (28), `core.lease_review.test.ts` (39), `apify_sdk.integration.test.ts` (20) | Run leases, in memory and with two real SDK processes; every finding of the two lease reviews has a test that names it (F-01 to F-10, LEASE-01 to LEASE-04, MOCK-03) |
| `platform_parity.integration.test.ts` (40), `mock_apify_platform.test.ts` (13), `support/mock_apify_platform.ts`, `support/platform_child.ts` | **Platform parity.** One real Actor process "at home" (the real `apify` SDK and the real `apify-client` resource clients) talking HTTP to an in-process mock of the Apify REST API (key-value store with paging and byte bodies, dataset, run status, charge endpoint, fault hooks), around the real router with stub connectors: reading and writing memory, journal and lease as the platform client does, truncated and empty records, run status under every status and error, charges through the real charge endpoint, a listing that lags behind a write |
| `distribution_sync.test.ts` | The generated data files, the Python port's inputs, the three n8n templates (executed in a Node `vm`), the README's claims |

### 3.2 Was the test suite itself any good? Mutation testing and independent reviews

A test suite that passes proves little until it has been shown to fail when the code is wrong.

* **Mutation testing (three rounds).** Hand-made faults in the rules and the code that were added in each round, applied to a scratch copy and run against the suite that is meant to catch them. Round 1 (the third guard round): 34 faults, 15 in `lib/_guards.ts`, 14 in the Python port, 5 in the n8n Code node (applied to all three templates at once); examples: the single-alphanumeric rule off; the visible-glyph check off or applied to the cleaned text; the NFKC expansion cap off or at 3x; a haystack run of marks rejected instead of cut, or cut to 15 marks; previews that serialise; a matcher that can throw or reads every needle; the `too_long` check moved before the letter rules. 32 were caught at once; two survived (the cut to 15 marks, the reordered `too_long` check in the Code node). Round 2 (the lease, adapters and guard fixes of the second review): 36 faults (11 in the TypeScript guard, 10 in the port, 2 in the Code node, 9 in `lib/lease.ts` and the router, 4 in the adapters and the charging counter); six survived (a needle that may contain the piece separator, in the TypeScript guard and in the port; the port's needle length cap; a needle cache that ignores edits; the uncounted hit cap; a Code-node glyph pattern). Round 3 (the fixes of the final lease and guard reviews): 17 faults (the lease read before a memory write, a lost lease at the final write, state read by name, a tick that writes after release, release not waiting for the tick, acquire not letting every take settle, the status call without a time box, the mark-run rule without U+FF9E and U+FF9F in the TypeScript guard, the port and the templates, a needle read again after the check, the port hashing the whole list or checking a needle as typed); one survived (release not waiting for the tick). **87 faults in all, 9 survived on the first attempt, each survivor led to a new or stronger test, and all 87 are caught now.** The scripts are in the session scratch area and are not committed; the fault lists are in the commit messages and in this paragraph. Earlier rounds recorded mutation results for the OFAC, World Bank and UK connectors (16 faults, all caught).
* **Reference model.** The guard's expected behaviour is re-implemented in the test file from the written rules (`stress.guards_fuzz.test.ts`), with an exhaustive comparison over every code point alone, doubled, at both ends of a word and inside one (committed, sweeps X1 to X3). One reviewer additionally ran 1.11 million single code points, 1.33 million pairs and 4.49 million triples over hostile alphabets against an independent model of his own (his scripts are not committed).
* **Independent reviews.** Four independent adversarial reviews of the keyword guard (the third found F1 to F9, the basis of RA-22 to RA-28; the fourth found one medium CPU bypass and several low findings, RA-44 to RA-46), one of the delivery journal (it confirmed that the bound holds for a single writer; its no-protection-against-a-second-writer limit is what the run lease addresses), two of the run lease, the fail-closed records and the platform behaviour (section 5), a fact-check of the documents against the code, and the atomicity fault-injection campaign.
* **What this does not prove.** Mutation testing and differential testing find a difference between implementations or an untested rule; they do not prove that the rules are the right ones. The folding and word-boundary limits in strategy section 9 are rule choices that were reviewed and documented, not defects that were fixed.

### 3.3 Billing and state atomicity under platform failures

What the SDK (`apify` 3.7.2) really does was read from its source and confirmed with the real SDK: `pushData(row, event)` pushes first, then charges; it is **ordered, not transactional**. An unpriced event is free but is reported as charged. At the budget limit the SDK deliberately pushes and bills one extra row. Strategy section 2.4 has the table.

**Fault injection** (`stress.atomicity_chaos.test.ts`): the real router (`runEngine`), the real `ApifyDeltaStore` and the real hit biller run against a simulated platform that can fail before a push, between a push and its charge, after the charge, after the journal write, after the watchlist-hit charge, on a checkpoint write, on a journal write, and by a hard kill that discards every later write. A scenario is one seed (1 to 120 upstream records, a delta mode, a watchlist that is none, valid, junk or poisoned, an optional budget that may already be partly spent out of band), then up to 40 attempts with faults, a fault-free settle phase and one more run that must be a no-op.

| Campaign | Scenarios | Faults per attempt |
|---|---:|---|
| Single fault | 1,800 | 1 |
| Multi-fault | 900 | 2 or 3 coincident, half of them placed right behind the first |
| Directed | 15 tests (plus 9 on the simulator itself) | each documented guarantee at its exact position |
| Negative controls | 5 tests, 60 seeds | the invariants must fail when the guarantee is removed (a store without a journal; a sink that double-charges; a journal that silently drops writes; a corrupted outcome; every individual check tampered with) |

Invariants checked after every scenario: I1 no loss; I2 billing never exceeds delivery, per attempt and per event; I3 bounded repeats (an attempt loses at most one row however many faults it suffers); I4 bounded unbilled rows and hits; I5 no ghost hits (a poisoned or empty watchlist flags nothing and charges nothing); I6 idempotent (one more fault-free run delivers nothing); I7 coherent memory and an empty journal at the end; I8 the budget is never exceeded by more than the one event the SDK overcharges on purpose.

**Real SDK in child processes** (`apify_sdk.integration.test.ts`): exact per-row billing, one `watchlist-hit` per proven match, a poisoned watchlist (no hit), a non-pay-per-event run, an unpriced event, the double-billing refusal, the budget limit, a hard kill (exit 137) at 8 positions (never more than one row repeated; 1 of 60 repeated and re-billed for a kill after a push, none after the journal write), a platform error, an unchanged re-run, namespace isolation, run status (`FAILED` when every source fails, `SUCCEEDED` when one source answers), and the lease scenarios (overlap refused, a killed holder does not block, different namespaces overlap freely).

**Platform parity** (`platform_parity.integration.test.ts`): local storage hid a class of defects, so one real Actor process runs "at home" (the real SDK and the real `apify-client` resource clients) against an in-process mock of the REST API. What it found and what is now pinned: the delta memory was listed with `store.keys()`, which the platform's client does not have, so every run of every engine would have died after taking its lease (RA-29, **critical**); a truncated JSON record made the client throw and retry for two to four minutes (records are now read as bytes and a truncated one fails its source at once); a run that cannot be found is not a dead run (RA-31); a row over the dataset item limit is skipped, not retried for ever (RA-33); the status of another run is time-boxed to 10 s. **What this is not:** a mock answers at once, has no latency or ordering model, delivers no platform events (`ABORTING`, `MIGRATING`) and uses short retry settings, so what the real platform answers is **not verified** (strategy section 9).

**Lease and state, second review** (all fixed unless stated; strategy RA-30, RA-34 to RA-38 and the register notes): a run blocked in its last push could still write its older memory over the run that took its lease (the lease is now read before every memory write); a listing that lags behind a write could make a source read as never seen (memory is now read by name for the selected sources); a heartbeat tick that was running when the run released could bring the lease back, and a failed acquire could leave a lease behind (both fixed). **Left as documented limits:** a renewal that stalls between its read and its write can overwrite the new holder's record; the lease knows runs, not containers, so a platform migration that overlaps two containers of one run is not protected; a JSON `null` body reads as absent; a state record at the 50,000-id ceiling is about 9.5 MB and may be refused by the platform.

**Exposure, exact:** one hard kill can re-bill the dearest row event of the engine and nothing else (a hit is charged after the journal write). That is $0.05 for regtech, $0.02 for tenders and $0.03 for patents; before the delivery journal it was up to 25 rows plus their hits ($5.00 regtech, $4.25 tenders, $4.50 patents). See [`2026-10-21_pricing_exposure.md`](2026-10-21_pricing_exposure.md).

**Residual, stated plainly** (strategy sections 2.4 and 9): a row in flight at the instant of a hard kill is delivered and billed twice, and a row whose charge call fails after its push is delivered unbilled and delivered again; the platform offers no transaction across the dataset, the charge API and the key-value store. The run lease closes the realistic overlaps of two runs of one namespace but is not a lock (no compare-and-set in the store). The per-row journal write costs one small key-value write per delivered row; **its latency on the platform has not been measured.**

### 3.4 ReDoS bounds (`npm run audit:redos`)

Static analysis (`recheck` 4.5.0 over the TypeScript AST) of every regex literal and constant `RegExp(...)`, on the commit of this report: 219 occurrences, 199 distinct (file, pattern) pairs, **193 safe, 6 flagged**, exit code 0. The six flagged patterns (OFAC, SEC enforcement, World Bank, Santa Fe) are allowlisted, each with a written bound on the input it can receive and the title of a test that enforces the bound; the gate fails when an entry has an empty bound or an `enforcedBy` that is not an `it()`, `test()` or `describe()` title read from the AST, and when an allowlisted pattern is proven safe (stale entry). Seven dynamic `RegExp()` calls are listed and were read by hand: none takes external input. The gate was itself attacked (RA-16: empty `enforcedBy`, a comment passed as the enforcing test, aliases of `RegExp`, strings passed to `.match()`), and `audit.redos_gate.test.ts` runs it against temporary trees to prove it fails when it should. A pattern that only recheck's time-budgeted fuzzer rates safe is reported as a note, not a failure, so the gate cannot flake. Runtime evidence: `review_redos.test.ts` times the replaced patterns on adversarial input.

### 3.5 State checkpointing

* Delta memory: one record per source and namespace (`state.<namespace>.<source>`), sized to the run, never smaller than `maxItemsPerSource`, capped at 50,000 ids.
* Checkpoint in full every 25 emitted rows and in a `finally`; a delivery journal (`journal.<namespace>.<source>`, a few hundred bytes) after every row that was pushed and billed, cleared after each checkpoint, folded into the memory before the next run classifies anything.
* A record that exists but cannot be read **fails its source** (the message names the key and the store and says to delete it); an absent record is empty. Before this round an unreadable record was treated as empty and re-delivered and re-billed up to 10,000 rows per run (RA-19).
* A record without a usable id or fingerprint, and a row that cannot be serialised, are skipped and reported (RA-20).
* A run lease per (namespace, source) (RA-18), described in strategy 2.2 and 9: taken before any state is read, checked before every push, read again before every memory write, the status of another run time-boxed.
* The memory of the selected sources is read by name (`state.<namespace>.<source>`), not discovered through a key listing.

### 3.6 Keyword-guard hardening

The inputs named in the brief and the neighbours that broke earlier versions, run through `sanitizeKeywordList` (output of the committed code, generated on 2026-10-21):

| Input | Accepted | Rejection reasons | Log line |
|---|---|---|---|
| `[""]` | none | empty_after_normalisation | watchlistNames: 0 accepted, 1 rejected (empty_after_normalisation=1). |
| `["   "]` | none | empty_after_normalisation | watchlistNames: 0 accepted, 1 rejected (empty_after_normalisation=1). |
| `["", "   "]` | none | empty_after_normalisation x2 | watchlistNames: 0 accepted, 2 rejected (empty_after_normalisation=2). |
| `["--"]` | none | no_letter_or_digit | watchlistNames: 0 accepted, 1 rejected (no_letter_or_digit=1). |
| `[null]`, `[null, undefined]` | none | not_a_string | 0 accepted, not_a_string per entry |
| `["​​"]` (zero-width only) | none | empty_after_normalisation | 0 accepted, 1 rejected (empty_after_normalisation=1). |
| `["a​"]` (a letter and a zero-width space) | none | too_short | 0 accepted, 1 rejected (too_short=1). |
| `""` (bare empty string) | none | empty_after_normalisation | 0 accepted, 1 rejected |
| `"a"` or `["a"]` | none | too_short | 0 accepted, 1 rejected (too_short=1). |
| `["c."]` | none | single_letter_or_digit | 0 accepted, 1 rejected (single_letter_or_digit=1). |
| `["⑳"]` (circled twenty) | none | too_short | 0 accepted, 1 rejected (too_short=1). |
| `["Pfizer", "  ", "--", null, "a"]` | `Pfizer` | empty_after_normalisation, no_letter_or_digit, not_a_string, too_short | 1 accepted, 4 rejected |
| `"Smith, J.\nBrown, A.; Acme Corp"` | `Smith`, `Brown`, `Acme Corp` | single_letter_or_digit x2 | 3 accepted, 2 rejected |
| `42`, `{}` | none | malformedContainer | unsupported value type; watchlist disabled (0 keywords). |
| `undefined` | none | none (not supplied) | 0 keyword(s) accepted. |

Rules, in order (strategy 5.3): a string; at most 4,096 UTF-16 units before any Unicode work; no lone surrogate; cleaned to a fixed point of NFKC, whitespace controls to a space, removal of the 4,239 code points that are C0/C1 controls, `Default_Ignorable_Code_Point` or `Bidi_Control`, whitespace collapsed (a keyword with more than 16 consecutive combining marks, which include the halfwidth sound marks U+FF9E and U+FF9F, or one that NFKC makes more than 4x plus 16 units longer, is empty); at least 2 code points after cleaning and 2 visible code points before NFKC; at least 2 letters or digits; at most 200 code points; de-duplicated; at most 500 accepted; at most 5,000 entries and 200,000 raw units inspected; a bare string cut at 200,000 units with its last piece dropped; a haystack searched up to 8,192 units, cut before the last whitespace, with a run of marks cut to 16.

**CPU, measured** (best of 5 to 9, idle machine, not committed; chosen shapes, not a proof of a bound). TypeScript guard on Node 22.22.0: 5,000 entries of 4,090 marks in descending combining class (86 s in the first version) 5 ms; 5,000 plain 4,096-unit entries 11 ms; 48 x 4,096 units of U+FDFA (the worst compatibility character) 16 ms; 48 entries of about 4,090 units that alternate U+0301 with U+FF9E 1 ms (290 ms before those two characters counted as marks); 5,000 references to an 8,000-deep array 0.5 ms; a haystack of 8,192 units against 500 needles 0.05 ms with a run of 40 marks and 4 ms when it is 8,188 ligatures. The Python port takes up to 290 ms on the U+FDFA lists (it measures the expansion after `unicodedata.normalize`), 3 to 4 ms on the U+FF9E lists, 0.3 to 0.8 ms and 39 to 41 ms on the two haystacks. Details in `distribution/README.md`.

**Environment finding worth a line.** The Dockerfiles use `apify/actor-node:24`, while the suite normally runs on Node 22.22.0. The removed set was recomputed on Node 20.20.0 (Unicode 16.0), 21.7.3 (15.1), 22.22.0 (16.0) and **24.22.0 (17.0)**: identical on all four (4,239 code points in the same 19 ranges as `engines.json`, 25 `White_Space` code points). The combining-mark set and `\p{L}` / `\p{N}` differ with the Unicode version (2,450 to 2,543 marks) and are not asserted equal. The TypeScript suite passes in full on Node 24.22.0.

---

## 4. Block 3

### 4.1 Pricing and Store Publishing Terms 9.4

The price-change rule is **section 9.4** of the Store Publishing Terms (updated 2026-09-15), not 2.2.4.2 as the brief said: a change that can raise a user's price takes effect after 14 days, at most one per month. The payload builder sets `startedAt = now + 14 days` and emits a separate notice file (no API field sets a notice period). The start event is $0.005 per GB, inside the requested band and 100 times Apify's default ($0.00005); at 2 GB the regtech engine charges $0.01 for an empty run. **Open decisions:** whether to keep that start price (4), and confirmation of the prices that are not quoted from a legacy README: `watchlist-hit` ($0.15, operator-stated and uncorroborated by any legacy document), `crawler-signal`, `grant-updated`, `uae-entity-updated`, `sg-entity-updated` (provisional) (5). 18 of the 25 priced events are quoted from a legacy README with file and line. Exposure per run and per kill: [`2026-10-21_pricing_exposure.md`](2026-10-21_pricing_exposure.md); break-even run times: [`2026-10-21_unit_economics.md`](2026-10-21_unit_economics.md) (the compute rate is a sensitivity input, 0.20 to 0.40 USD per GB-hour, **not a measured cost**).

### 4.2 Actor files

`actor.json`, `input_schema.json` and the Dockerfile of each engine are generated from the engine registries and `EngineInputSchema` (`scripts/generate_actor_files.ts`) and re-derived by an independent test (`audit.actor_config_independent.test.ts`). Facts checked on 2026-10-21: memory is pinned (`minMemoryMbytes == maxMemoryMbytes`: 2,048 MB regtech, 1,024 MB tenders and patents) so the per-GB start event matches the pricing; the bring-your-own-key credentials are **top-level `isSecret` fields** (regtech `fdaApiKey`; tenders `socrataAppToken`; patents `usptoOdpApiKey`, `epoOpsConsumerKey`, `epoOpsConsumerSecret`, `fdaApiKey`) and no `sourceOptions` property carries one, because Apify masks only top-level secret fields; a credential inside `sourceOptions` is refused by preflight, by the Python client and by the n8n Code node. The image is `apify/actor-node:24` with a two-stage build and `npm ci --omit=dev`; no image sets `NODE_EXTRA_CA_CERTS` (a test fails if one reappears).

### 4.3 Distribution channels

Python SDK `regulatory-engines`, LangChain tools and three n8n templates (strategy 13.1). What is verified: the Python port and the n8n Code nodes reproduce the TypeScript guard on a generated corpus (498 sanitiser, 325 normaliser, 287 matcher cases) and on the differential fuzz; the spending cap is required with no default; held and unknown sources and credentials in `sourceOptions` are refused client-side; no token is logged (tested at DEBUG with the real `apify-client`); the n8n templates are valid JSON of the right shape and their Code node is executed in a Node `vm`. **What is not verified:** nothing was run against the platform; the package is not on PyPI; the n8n templates were never imported into n8n (the parameter shapes of the Schedule Trigger, IF and Filter nodes are written from the documented shapes); `apify-client` versions other than 3.3.0 were not run.

### 4.4 Three-phase timeline

Strategy section 13.3: deploy and verify on the platform (days 0 to 14), publish the channels and measure (15 to 45), decide on the legacy fleet (46 to 90), each with a gate that can fail. No revenue, run-count or conversion figure is projected, because there is no measured baseline.

---

## 5. Independent verification

Fresh reviewers, who had not seen this report's conclusions, were given the code and asked to refute it, in rounds: each round's findings were fixed (or documented as a limit), and the changed code was reviewed again. Rounds: the keyword guard (four, in all three implementations), the run lease with the fail-closed records and the router's failure paths (two, the second after the platform parity harness existed), a fact-check of every checkable claim of the strategy document and the READMEs against the code (one, plus a final one on the last text, recorded at the end of section 7). Each finding, its severity as the reviewer rated it, and what was done is in section 7. The reviewers' own reproductions lived in the session scratch area and are **not committed**; what is committed is a test for every fixed finding and the register in strategy section 8.2.

A review is evidence about the code it read. None of these reviews ran anything on the Apify platform, and the reviewers' counts and timings are marked **agent-reported** where they have no committed artefact.

---

## 6. What was not done

* **No platform run.** No Actor was started on Apify, no pay-per-event charge was made against the platform's pricing or charge API (the local charging manager and test doubles were used), no authenticated USPTO or EPO response was ever seen, a valid openFDA key was never exercised, and `ae_registers` returned no live rows. The latency of the journal and lease writes on the platform is unknown, and the platform parity harness is a mock (no latency model, no platform events, short retry settings): what the platform answers to a limited token, whether a listing lags behind a write, and whether a state record of about 9.5 MB is accepted are **not verified**.
* **No n8n import**, no PyPI publication, no Apify Store listing.
* **Traction figures** of the brief: unverifiable without the account owner's token.
* **Prices:** three events are operator-stated or provisional; the generator refuses to emit with `--strict` until they are confirmed.
* **Known gaps** (strategy section 9): no `removed` delta class, no conditional GET, README-only legacy repositories are not behaviour-equivalent, delivery is at-least-once, DNS rebinding cannot be closed in-process, matching limits (no folding of apostrophe and dash variants, no word boundary, invisible characters join words), dependence on the runtime's Unicode tables.
* **Load sensitivity (fixed):** two real-process overlap tests failed once each while the full suite and other jobs shared one machine, because they decided that the first process was "in the middle of its run" by a fixed sleep. They now wait until that process has pushed rows, and passed with every core of the machine busy. Tests that still sleep (a lease that must go stale) only wait too long, never too short.
* **Not read by anyone but the author:** the legacy repositories' closed source (the SEC "ghost billing" mechanism is reconstructed from the documented behaviour).

---

## 7. Findings of the independent verification rounds

**Lease and state review, round 1** (the first platform-oriented review; the basis of RA-29 to RA-38). All ten of F-01 to F-10 are fixed; F-11 is a documented fail-safe limit and F-12 was the documentation.

| Finding | Rated | Disposition |
|---|---|---|
| F-01 delta memory was listed with `store.keys()`, which the platform's client does not have: every run died after taking its lease | critical | Fixed (RA-29); test doubles now behave like the platform client; parity harness |
| F-02 an overtaken run was not stopped and wrote over the run that took its lease (7 of 10 rows delivered and billed twice in the reproduction) | high | Fixed (RA-30), see LEASE-01 below for the second half |
| F-03 a run that cannot be found was read as dead | medium | Fixed (RA-31): unknown, the heartbeat decides |
| F-04 a truncated record threw from the client and was retried for minutes | medium | Fixed (RA-32): bytes are read, the source fails closed at once |
| F-05 a row over the dataset item limit made every push of it throw | medium | Fixed (RA-33): skipped and reported |
| F-06 the lease race window was the time between the first read and the write | medium | Fixed to the extent the store allows (RA-34): read twice, settle delay |
| F-07 a lease store error after a pushed row lost the row's hit | low | Fixed (RA-35) |
| F-08 hits skipped by a cap left no trace | low | Fixed (RA-38): `watchlist.hitsCapped` |
| F-09 lease clocks (a clock that stepped back, a heartbeat from the future) | low | Fixed (RA-36) |
| F-10 acquire and release were not exception safe | low | Fixed (RA-37) |
| F-11 two simultaneous multi-source starts can both back off | low | Documented: fails safe, nothing is delivered |
| F-12 documentation | docs | Fixed |

**Lease and state review, round 2** (on the code after round 1, with the parity harness in place).

| Finding | Rated | Disposition |
|---|---|---|
| LEASE-01 an overtaken run blocked in its last push (or its 25th) still wrote its older memory over the new holder's, so the next run re-delivered and re-billed every row the holder had delivered (7 of 7) | medium | **Fixed**: the lease is read before every memory write; a lost lease at the final write fails the run; tests for the last row and for the checkpoint |
| LEASE-02 the memory was found only through the key listing; a listing that omits the key silently re-bills the source | medium | **Fixed**: memory is read by name for the selected sources; tests with a listing that hides records and one that pages |
| LEASE-03 a heartbeat tick in flight could resurrect a released lease | low | **Fixed**: nothing writes after release starts, release waits for the tick; two tests |
| LEASE-04 a failed acquire left an orphan lease (the slower write landed after the clean-up) | low | **Fixed**: every take settles before the clean-up |
| LEASE-05 a renewal that stalls between read and write overwrites the new holder | low | Documented limit (no compare-and-set) |
| LEASE-06 a JSON `null` body reads as absent | low | Documented, pinned on purpose: the code never writes one |
| LEASE-07 the lease knows runs, not containers (a migration reboots with the same run id) | low | Documented limit; overlap of the containers not verified |
| MOCK-01, MOCK-02 the mock has no latency model and delivers no platform events | medium | Documented in strategy section 9 and above |
| MOCK-03 the status call and the lease reads have no time box | low | **Fixed for the status call** (10 s, then unknown); the other reads rely on the client's retries, documented |
| MOCK-04 no record size limit is modelled; a 50,000-id state is about 9.5 MB | low | Documented, **not verified** on the platform |
| DOC-01 statements the code or tests did not support (checked before every row; a failed memory write ends the run; before any request or charge; the RA-33 limits; hit-cap claim without test) | low | **Fixed** in the strategy document, the READMEs and the lease header |

**Keyword guard, round 4** (final; one reviewer, all three implementations). The reviewer reported no false hit, no new silent miss from the piece-wise cleaning and no false rejection of a legitimate name from the glyph rule (agent-reported: about 101,300 differential cases against each of three Python versions, 156,000 sanitiser and normaliser inputs against the Code node on three Node versions, 3.4 million NFKC strings: 0 differences; about 270 real-world names in many scripts: the glyph rule rejected only the deliberate cases such as a circled number plus a full stop).

| Finding | Rated | Disposition |
|---|---|---|
| F1 the 16-mark cap is bypassed by U+FF9E and U+FF9F (letters until NFKC makes them marks): 290 ms per 48 entries, 24 ms per haystack field | medium | **Fixed** (RA-44) in all three implementations; a sweep of every code point pins the four non-mark code points whose NFKC starts with a mark |
| F2 final sigma: a name ending in capital Σ misses when a letter follows it | low | Documented (strategy section 9, matching limits); not a divergence between implementations |
| F3 a keyword that contains one of the 19 heavy expanders cannot match in a haystack cleaned in pieces | low | Documented (same place) |
| F4 a needle is validated and then read again (an accessor or Proxy can swap it) | low | **Fixed** (RA-45); in-process objects only |
| F5 the port differs on hand-built lists: an unhashable element, split surrogate halves, every needle hashed | low | **Fixed** (RA-45) |
| F6 header criteria order, stale timings and statements in the guard header and the README | low | **Fixed** (RA-46) |

**Keyword guard, rounds 1 to 3** (RA-8 to RA-12, RA-17, RA-22 to RA-28, RA-39 to RA-43): all fixed except the limits listed in strategy section 9; the accepted residual of round 3 is that a base followed by 16 marks can drop a later accent.

**Documents against the code** (one reviewer, then a final one on the last text): the claims that were wrong were corrected in the document, not left standing, among them "28 Actors cannot be reproduced" (the repository README states 28), "never a false hit" (a substring can hit where the customer did not mean it, section 9), lease and isolation overstatements, several counts, the journal size, and "exact" exposure figures. FINAL_FACTCHECK

---

## 8. Reproduce

```bash
cd master_engines
npm ci
npx tsc --noEmit
npx vitest run                                   # 2,323 tests in 53 files
npm run audit:redos                              # needs: npm install --no-save recheck
npx tsx scripts/audit_pricing_exposure.ts        # regenerates 2026-10-21_pricing_exposure.md
npx tsx scripts/audit_unit_economics.ts          # regenerates 2026-10-21_unit_economics.md
npx tsx scripts/generate_distribution_data.ts --check

python3 -m venv /path/to/venv && /path/to/venv/bin/pip install -e "distribution/python[dev]"
/path/to/venv/bin/python -m pytest distribution/python        # 1,810 tests

# differential fuzz: first interpreter must be Python 3.11
distribution/tools/differential_fuzz/run.sh 301 6000 3000 3000 /path/py311/bin/python /path/py312/bin/python /path/py313/bin/python
```
