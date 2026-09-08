# Public APIs Directory Submission — Fleet Actors

> Researched and drafted 2026-09-08. Every rule below was pulled live from `public-apis/public-apis` itself — `CONTRIBUTING.md`, the actual CI linter source (`scripts/validate/format.py`), the three GitHub Actions workflows that run on every PR, and `.github/PULL_REQUEST_TEMPLATE.md` — not recalled from training-data memory of what this list "usually" looks like. Where the documented rule and the enforced linter disagree (they do, once — see Part 1), I flag it explicitly rather than picking one silently. Part 5 is the honest part: this task's whole point was to check whether Apify Actor APIs are actually in scope for this list, and the answer is genuinely uncertain, not a clean yes.

---

## Part 1 — Verified current contribution format (as of 2026-09-08)

### Table columns

`CONTRIBUTING.md`'s "Formatting" section states the *current* entry format as **six** columns:

```
| API | Description | Auth | HTTPS | CORS | Call this API |
```

with the sixth column defined as an optional link to a public Postman collection ("Does this API have a public Postman Collection?").

But the actual CI linter that runs on every PR — `scripts/validate/format.py`, invoked by `.github/workflows/test_of_push_and_pull.yml` — hard-codes `num_segments = 5` and only ever reads/validates five columns (`index_title`, `index_desc`, `index_auth`, `index_https`, `index_cors`). It has no concept of a sixth column at all. Every real row I pulled from the live `README.md` (Government, Open Data, and elsewhere) is five columns, with no "Call this API" column present anywhere in the sections I checked. **The documented format and the enforced format disagree; I followed the enforced one (5 columns), since that's what actually gates a merge.**

```
| API | Description | Auth | HTTPS | CORS |
|:---|:---|:---|:---|:---|
| [NASA](https://api.nasa.gov) | NASA data, including imagery | No | Yes | Yes |
```

### Auth / HTTPS / CORS — allowed values (from the linter itself, not the prose doc)

| Column | Allowed values | Source |
|---|---|---|
| `Auth` | `` `OAuth` ``, `` `apiKey` ``, `` `X-Mashape-Key` ``, `` `User-Agent` ``, or literal `No` — value must be wrapped in backticks unless it is exactly `No` | `auth_keys` list + `check_auth()` in `scripts/validate/format.py` |
| `HTTPS` | `Yes` or `No` **only** | `https_keys = ['Yes', 'No']` in `scripts/validate/format.py` — note `CONTRIBUTING.md` doesn't spell out allowed values for this column at all; the linter is the only real source of truth here, and it does **not** accept `Unknown` |
| `CORS` | `Yes`, `No`, or `Unknown` | `cors_keys` list, same file |

### Description rules (linter-enforced, `check_description()`)

- First character must be capitalized.
- Must **not** end in punctuation (checked against Python's `string.punctuation`).
- Max 100 characters (`max_description_length = 100`).

### Title rules (linter-enforced, `check_title()`)

- Must be literal Markdown link syntax: `[Title](https://...)`.
- Title text must **not** end in "API" (case-insensitive) — CONTRIBUTING.md gives the same rule in prose: "Please make sure the API name does not end with `API`."
- No TLD in the name (CONTRIBUTING.md prose rule, not linter-enforced): `Gmail`, not `Gmail.com`.

### Ordering and category rules

- `check_alphabetical_order()` sorts each category's extracted titles with plain `sorted()` on the uppercased title text and fails the build if the existing order doesn't match — this is what I placed each draft row against.
- New categories need a minimum of 3 entries (`min_entries_per_category = 3`) and must also appear in the README's Index section, or the build fails.
- "If an API seems to fall into multiple categories, please place the listing within the section most in line with the services offered" (CONTRIBUTING.md prose).

### PR mechanics (from `CONTRIBUTING.md` + `.github/PULL_REQUEST_TEMPLATE.md`, fetched verbatim)

- **"Add one link per Pull Request."** — this is explicit and, per Part 4 below, actively enforced by contributors/maintainers in practice, not just theory.
- PR title format: `` Add Api-name API `` — CONTRIBUTING.md's own example is literally `Add Blockchain API` (the word "API" is appended in the *PR title*, even though the *entry name itself* must never end in "API" — two different rules, easy to conflate).
- Commit message convention, CONTRIBUTING.md's own example: ❌ `Update Readme.md` / ✔ `Add Blockchain API to Cryptocurrency`.
- Squash all commits into one before opening the PR.
- Target the `master` branch.
- The PR template (`.github/PULL_REQUEST_TEMPLATE.md`, 889 bytes, fetched verbatim) is a checkbox list:

```
- [ ] My submission is formatted according to the guidelines in the contributing guide
- [ ] My addition is ordered alphabetically
- [ ] My submission has a useful description
- [ ] The description does not have more than 100 characters
- [ ] The description does not end with punctuation
- [ ] Each table column is padded with one space on either side
- [ ] I have searched the repository for any relevant issues or pull requests
- [ ] Any category I am creating has the minimum requirement of 3 items
- [ ] All changes have been squashed into a single commit
```

### The anti-marketing clause (this is the one that matters most for Part 5)

Quoted verbatim from the top of `CONTRIBUTING.md`:

> "...some pull requests have been specifically opened to market company APIs that offer paid solutions. This API list is not a marketing tool... Pull requests that are identified as marketing attempts will not be accepted."
>
> "Please make sure the API you want to add has full, free access or at least a free tier and does not depend on the purchase of a device/service before submitting. An example that would be rejected is an API that is used to control a smart outlet - the API is free, but you must purchase the smart device."

### CI that actually runs on a PR (three real workflow files, fetched verbatim)

1. `test_of_push_and_pull.yml` — runs `scripts/validate/format.py` (the linter above) on every push/PR to `master`, then `scripts/github_pull_request.sh` which pulls the PR's own diff and link-checks only the **added** lines.
2. `test_of_validate_package.yml` — runs the repo's Python unit tests (`scripts/tests/`).
3. `validate_links.yml` — a scheduled (not per-PR) full-file link check, cron'd daily.

So a real PR is gated by: table-format linter (5 columns, exact rules above) + link validation on the added line(s). There is no "is this a real, always-on REST endpoint vs. a job/run-based API" check anywhere in the code — that distinction, if it matters at all, is a human maintainer judgment call, not something CI enforces either way.

---

## Part 2 — Category verification

The real category is **`### Government`** (confirmed present verbatim in the live README, along with `Open Data`, `Finance`, `Business`, `Data Validation`, and 40-some others — full list fetched and cross-checked against the Index).

I placed all three entries in `Government` rather than `Open Data`, on the "place it where the services offered are most in line" rule, and on a direct existing precedent already living in the `Government` section:

```
| [Vett](https://wimberly.solutions/api/free-sanctions-check/) | Screen names & companies against OFAC, PEP, watchlists & recalls | No | Yes | Yes |
```

`Vett` is the closest real analog to two of these three actors (OFAC-adjacent sanctions/recalls screening) and it sits in `Government`, not `Open Data` — `Open Data` is where broader multi-domain datasets like `OpenSanctions` and `Socrata` live, whereas single-purpose regulatory/compliance-source monitors sit in `Government` alongside `Interpol Red Notices`, `FEC`, `Federal Register`, and `USAspending.gov`. All three of this fleet's candidate actors are direct wrappers around one or two named government/international-body primary sources (US Treasury OFAC, UN Security Council, World Bank, FDA, EMA) rather than general open-data aggregation, which is the same shape as the existing `Government` entries.

---

## Part 3 — Draft entries

**Per the "one link per Pull Request" rule (Part 1) and the closed precedent in Part 4, these are three separate PRs, not one PR with three rows.** Each block below is a complete, independent submission.

### PR 1 — actor-19, Global Maritime & Vessel Sanctions Monitor

**Table row** (insert in `Government`, alphabetically between `Gazette Data, UK` and `Gun Policy`):

```
| [Global Maritime & Vessel Sanctions Monitor](https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor) | OFAC and UN sanctioned-vessel lists cross-referenced by IMO number, run as an Apify Actor | `apiKey` | Yes | Yes |
```

(89-char description, capitalized start, no trailing punctuation — checked against the linter's own rules.)

- **PR title:** `Add Global Maritime & Vessel Sanctions Monitor API`
- **Commit message:** `Add Global Maritime & Vessel Sanctions Monitor API to Government`
- **Branch:** `add-vessel-sanctions-monitor`
- **PR body draft:**

  > Adds the Global Maritime & Vessel Sanctions Monitor to the Government section.
  >
  > - **What it is:** an Apify Actor that pulls the US Treasury OFAC Specially Designated Nationals (SDN) list, filters to `sdnType=Vessel` records (1,540 of 19,329 total entries, live-verified), and cross-references against the UN Security Council Consolidated Sanctions List by IMO number.
  > - **How it's called:** this is an Apify Actor, not a conventional always-on REST endpoint. It's invoked via the Apify API — either the async run/poll pattern (`POST /v2/acts/{id}/runs` → poll → `GET .../dataset/items`) or the single-call convenience endpoint `POST /v2/acts/{id}/run-sync-get-dataset-items`, both documented on the Store page linked above.
  > - **Auth:** an Apify account + API token is required (`apiKey`, sent as a query param or bearer header) — there is no unauthenticated tier.
  > - **Pricing:** billed pay-per-event by Apify (this actor charges per output record). I'm not claiming an actor-specific free tier here — I don't have one to point to beyond Apify's own generic platform account credit, whose current terms I haven't verified as part of this submission, so I'm leaving that claim out rather than asserting something I can't back up.
  > - **CORS:** confirmed live — `api.apify.com` returns `Access-Control-Allow-Origin: *` on both `OPTIONS` and direct requests to the actor endpoint (checked 2026-09-08).
  >
  > Checklist: formatted per CONTRIBUTING.md, alphabetical within Government, description is 89/100 chars with no trailing punctuation, table columns single-space-padded, single commit, one link only.

### PR 2 — actor-20, Multilateral Development Bank Procurement Monitor

**Table row** (insert in `Government`, alphabetically between `LocalGov.jp` and `National Park Service, US`):

```
| [Multilateral Development Bank Procurement Monitor](https://apify.com/stefano_seggio/actor-20-mdb-procurement-monitor) | World Bank procurement notices and debarred-firm records, run as an Apify Actor | `apiKey` | Yes | Yes |
```

(79-char description.)

- **PR title:** `Add Multilateral Development Bank Procurement Monitor API`
- **Commit message:** `Add Multilateral Development Bank Procurement Monitor API to Government`
- **Branch:** `add-mdb-procurement-monitor`
- **PR body draft:**

  > Adds the Multilateral Development Bank Procurement Monitor to the Government section.
  >
  > - **What it is:** an Apify Actor over the World Bank's public Procurement Notices API and its "Other Sanctions" debarred-firms sub-table. ADB and IDB were investigated for the same fleet and honestly excluded (Cloudflare-gated and Power-BI-only/robots.txt-blocked respectively — documented in the actor's own README) rather than force-scraped, so this entry covers World Bank only, not "all MDBs."
  > - **How it's called / Auth / Pricing / CORS:** identical shape to PR 1 above — Apify Actor run (async run/poll or `run-sync-get-dataset-items`), `apiKey`-gated, pay-per-event billed, no actor-specific free tier claimed, CORS confirmed live (`Access-Control-Allow-Origin: *`).
  >
  > Checklist: same as PR 1, alphabetical placement between LocalGov.jp and National Park Service, US.

### PR 3 — actor-22, Regulatory Medical Recalls & Drug Safety Monitor

**Table row** (insert in `Government`, alphabetically between `Radar CNPJ` and `Represent by Open North`):

```
| [Regulatory Medical Recalls & Drug Safety Monitor](https://apify.com/stefano_seggio/actor-22-drug-safety-recalls-monitor) | FDA and EMA drug recall and safety-alert data merged into one feed, run as an Apify Actor | `apiKey` | Yes | Yes |
```

(89-char description.)

- **PR title:** `Add Regulatory Medical Recalls & Drug Safety Monitor API`
- **Commit message:** `Add Regulatory Medical Recalls & Drug Safety Monitor API to Government`
- **Branch:** `add-drug-safety-recalls-monitor`
- **PR body draft:**

  > Adds the Regulatory Medical Recalls & Drug Safety Monitor to the Government section.
  >
  > - **What it is:** an Apify Actor combining the FDA's openFDA drug-enforcement (recall) API and the EMA's DHPC safety-alert feed into one normalized stream, tagged by jurisdiction/agency, with a regulatory-data disclaimer on every record.
  > - **How it's called / Auth / Pricing / CORS:** same shape as PR 1 and PR 2 — Apify Actor run, `apiKey`-gated, pay-per-event, no free-tier claim, CORS confirmed live.
  >
  > Checklist: same as PR 1, alphabetical placement between Radar CNPJ and Represent by Open North.

All three rows were checked against every rule in Part 1: 5 columns, single-space padding, backtick-wrapped `apiKey`, `HTTPS`/`CORS` from the linter's actual allowed sets, titles that don't end in "API," descriptions ≤100 characters starting with a capital and ending without punctuation, and alphabetical placement verified by literally sorting the surrounding titles the same way `check_alphabetical_order()` does (uppercase string comparison).

---

## Part 4 — Real-world precedent, found live (not hypothetical)

I searched the repo's own issues/PRs for "apify" and found this is not a hypothetical question — someone is already doing exactly this, right now:

- **PR #5699**, `Add Email Validator API and Domain WHOIS Lookup` — closed. Body: *"Two new hosted API entries from Apify actors... apiKey auth, HTTPS, free tier available."* Closed with the comment: *"Superseded by individual PRs #5816-#5820 (one API per PR per contribution guidelines)"* — direct, live confirmation that the one-link-per-PR rule is actively enforced, not just written down.
- **PR #5817**, `Add Domain WHOIS Lookup` — currently **open**, zero comments, unresolved. I pulled its actual diff:

  ```diff
  + | [Domain WHOIS Lookup](https://apify.com/george.the.developer/domain-whois-lookup) | Look up WHOIS data for any domain including registrar and expiry | `apiKey` | Yes | Yes |
  ```

  This is a live Apify Store actor entry, in the exact same shape as my three drafts above (apiKey/Yes/Yes, linking straight to an `apify.com/<user>/<actor-slug>` Store page), sitting in the `Development` category.
- **PRs #5816, #5818, #5819, #5820** — the other four split-out entries from the same submitter (`Email Validator`, `URL Metadata Extractor`, `AI Content Detector`, `DeFi Chain Metrics`), all also Apify-Store-hosted, all also **open, unmerged, zero maintainer comments**, as of 2026-09-08.

**What this does and doesn't prove:** it proves the automated gates (the format linter, the link checker) don't block an Apify-Actor-shaped entry — these PRs are open and presumably passed CI, or they'd show a failed check. It does **not** prove a human maintainer will accept the pattern — none of the five has been reviewed, merged, or rejected yet. This is genuinely open evidence, not a green light.

---

## Part 5 — Honest assessment: is this actually in scope?

This is the part the task asked me not to fudge, so directly:

**The technical shape is not disqualifying by itself.** Nothing in `CONTRIBUTING.md` or the linter requires a synchronous, always-on GET endpoint. The precedent in Part 4 shows run-based Apify Actors already sitting in the PR queue in the same 5-column, `apiKey`/Yes/Yes shape I drafted above, and CI doesn't distinguish "actor run" from "REST endpoint" — it only parses table syntax.

**The real risk is the anti-marketing / paid-solution clause, and it's a genuine one, not a formality.** Quoting Part 1 again: *"Pull requests that are identified as marketing attempts will not be accepted,"* and the API must have *"full, free access or at least a free tier and does not depend on the purchase of a device/service."* Here's what I know to be true about these three actors, sourced from this repo's own files (not assumed):

- All three are billed under Apify's PAY_PER_EVENT model — this fleet's own README pricing sections and the `apify-fleet-architecture` memory both confirm a per-record rate card (roughly $0.0005–$0.003/record for this group). There is no actor-specific free quota documented anywhere in this repo.
- The account (`stefano_seggio`) is itself on Apify's own account-level Free plan, but that's an account fact, not an entry-specific free tier a public-apis reader could rely on — and I did not independently verify Apify's current platform-wide trial-credit terms (that was out of scope for verifying *public-apis'* rules, which is what this task asked for), so I'm not asserting a number.
- These are the account holder's own monetized products, and this task itself originates from a `_gtm/execution_launchpad/autonomous_distribution` directory — i.e., a distribution/marketing workstream. A maintainer reading three PRs, each linking to `apify.com/stefano_seggio/...` with `apiKey` auth and no verifiable free tier, submitted by the product's own builder, is reading something that pattern-matches closely to the exact "smart outlet" example `CONTRIBUTING.md` names as a rejected precedent (the API itself is nominally free to call, but you can't get real use out of it without paying for the platform underneath it).

**My honest call:** I'm not going to tell you this will get merged. The linter will pass; the link checker will pass; the format is right. Whether a human maintainer treats an `apiKey`-gated, pay-per-event Apify Actor — built and submitted by its own author — as a "free API" or as the marketing pattern the guidelines explicitly warn against is a judgment call that, per Part 4, hasn't actually been made yet on any of the five pending real-world cases in the same shape. I drafted all three PRs above in full, ready to open, because that's what was asked and because nothing here technically disqualifies them outright — but if you want a materially better shot at acceptance, the honest fix is a genuine no-token, rate-limited free tier on at least a small daily quota (not just "an account exists on a free plan"), stated as a real, checkable fact in the PR body — not the "free tier available" phrasing the other submitter used without it being obviously true either.

---

## Part 6 — Submission mechanics (if you decide to proceed)

1. Fork `public-apis/public-apis`, branch from `master` per PR (`add-vessel-sanctions-monitor`, `add-mdb-procurement-monitor`, `add-drug-safety-recalls-monitor` — three separate branches, three separate PRs, per Part 1's "one link per PR" rule).
2. Insert each row at the exact alphabetical position given in Part 3.
3. One space on either side of every `|` cell — copy the rows above verbatim, don't reformat them through an editor that might collapse the padding.
4. Squash to a single commit per PR before opening it.
5. Target `master`.
6. Expect the automated link-check + format-lint to run and pass (Part 1); expect no automated signal either way on the marketing-clause judgment call (Part 5) — that's a human review, and per Part 4 it's currently untested against this exact submission shape.

---

*Sources fetched or searched live for this draft, 2026-09-08:*
- https://raw.githubusercontent.com/public-apis/public-apis/master/CONTRIBUTING.md
- https://raw.githubusercontent.com/public-apis/public-apis/master/README.md
- https://raw.githubusercontent.com/public-apis/public-apis/master/.github/PULL_REQUEST_TEMPLATE.md
- https://raw.githubusercontent.com/public-apis/public-apis/master/.github/workflows/test_of_push_and_pull.yml
- https://raw.githubusercontent.com/public-apis/public-apis/master/.github/workflows/test_of_validate_package.yml
- https://raw.githubusercontent.com/public-apis/public-apis/master/.github/workflows/validate_links.yml
- https://raw.githubusercontent.com/public-apis/public-apis/master/scripts/validate/format.py
- https://raw.githubusercontent.com/public-apis/public-apis/master/scripts/github_pull_request.sh
- https://api.github.com/repos/public-apis/public-apis/contents/ (repo tree, to locate `scripts/`)
- https://github.com/public-apis/public-apis/pull/5699 (closed, multi-entry Apify PR — precedent for "one link per PR" enforcement)
- https://github.com/public-apis/public-apis/pull/5816, /5817, /5818, /5819, /5820 (open, unresolved Apify-Actor entries — direct precedent for the submission shape)
- https://patch-diff.githubusercontent.com/raw/public-apis/public-apis/pull/5817.diff (real diff, confirming exact row format used for a live Apify-Actor entry)
- https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor, .../actor-20-mdb-procurement-monitor, .../actor-22-drug-safety-recalls-monitor (all HTTP 200, confirmed live 2026-09-08)
- Live CORS check against `api.apify.com` (`OPTIONS`/`GET` with an `Origin` header — confirmed `Access-Control-Allow-Origin: *`, 2026-09-08)
- Internal: `src/actors/actor-19/README.md`, `src/actors/actor-20/README.md`, `src/actors/actor-22/README.md`, `src/actors/{19,20,22}/.actor/actor.json`, and the `apify-fleet-architecture` / `apify-cli-and-api-access` project memories (PPE pricing model, account plan, actor titles/descriptions)
