# Directory submission package — AlternativeTo.net + one GitHub awesome-list

Prepared 2026-09-08. Both channels were verified live (not from memory) before drafting — see
Sources at the bottom. Read the **Honesty notes** section before submitting anything; it flags
one channel-fit problem that changed which awesome-list got picked, and one structural mismatch
on AlternativeTo that the draft below works around rather than papers over.

---

## Part A — AlternativeTo.net

### A.1 How the submission actually works (verified 2026-09-08)

- Sign-up requires **email verification** before you can submit a new app at all ("this is to
  discourage spammers and bots"). Voting/commenting don't need it; submitting a new app does.
- Flow: click the user icon (top right) → **"Suggest new application"** → fill in
  Platforms, License, Descriptions, Tags, etc. → **Submit the application**.
- New submissions land in a **backlog and typically wait several months** for organic review.
  There's an optional **one-time $5 fee** to jump the queue (reviewed in 1–2 business days) —
  AlternativeTo is explicit that "paying moves you up the queue — it does not buy approval. The
  approval criteria are exactly the same for every app." **Do not pay this without asking the
  user first** — it's a real money transaction and outside what this package authorizes.
- Track status later via profile → **"My submissions."**
- Listing itself is free; only queue-priority costs money.

### A.2 What a listing page actually contains (checked against 3 live comparable listings:
`sanctions.io`, `kyc-hub`, and others returned by AlternativeTo's own search for sanctions/AML
software)

A published listing shows: name, one-line tagline, longer description, **Cost/License** (e.g.
"Proprietary and Commercial product," "Freemium," pricing like "from $500/month"), **Origin**
(country, shown as a flag — skipped below, see honesty note), **Platforms** (e.g. "Online"), and
free-text **Tags** as lowercase-hyphenated chips (`kyc-hub`'s real tags: `anti-money-laundering-aml`,
`kyc`, `know-your-customer-kyc`). There's no rigid fixed-category dropdown visible from outside —
tags do that work.

### A.3 Draft listing

**Which product to list:** AlternativeTo's data model is one page per single application with one
homepage URL — it isn't built for "a developer profile with 17 separate Actor pages." Rather than
force all 17 into one page (which would misrepresent what a visitor lands on), this draft lists
the **single actor with the cleanest 1:1 competitive set on AlternativeTo**: the OFAC/UN sanctions
monitor. The other 16 actors are named in the description as siblings, with the full index linked.
See Honesty notes for why this is the right call, not a workaround.

```
Name:        Maritime & OFAC Sanctions Monitor
Tagline:     Delta-tracked OFAC SDN + UN sanctions list monitoring, via API and webhook

Homepage:    https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor

Description:
A pay-per-event Apify Actor that polls the US Treasury OFAC SDN vessel list and the UN Security
Council Consolidated List on a schedule and emits only what changed since the last run —
SANCTION (newly listed), STATUS_CHANGE, UPDATED, or DELISTED — instead of a full re-dump every
time. Built for teams who currently re-download and hand-diff these public lists (or check
them manually against SAM.gov / OFAC's own search UI) and want a scheduled, webhook-driven
version of that check instead. Output lands in an Apify Dataset (JSON/CSV/Excel) and can push
to Slack, Zapier, Make, or a CRM via native webhook, or be pulled by an LLM agent over MCP.
Bring-your-own Apify account; charged only on successful delta events ($0.0005/event).

One of 17 actors by the same independent developer (Stefano Seggio) covering procurement/tender
monitoring, drug-safety recalls, and patent/IP enforcement registers on the same delta-tracked
pattern — full index and source-verification notes at
https://github.com/stefanoseggio/awesome-regulatory-monitors and
https://apify.com/stefano_seggio.

License/Cost:  Proprietary, Freemium (Apify platform free tier + usage-based pay-per-event)
Platforms:     Online / API
Origin:        Not stated — do not guess the developer's country; leave blank or let AlternativeTo
               infer it, rather than fabricate a flag.

Suggested "Alternative to" tags (verified as real existing AlternativeTo listings):
  - sanctions.io        https://alternativeto.net/software/sanctions-io
  - Sanction Scanner     https://alternativeto.net/software/sanction-scanner
  - KYC Hub              https://alternativeto.net/software/kyc-hub
  - LexFlag              https://alternativeto.net/software/lexflag

  Honest caveat to state in the submission notes (AlternativeTo lets you add a short note on
  suggested alternatives): this actor is a narrower, single-purpose data feed — it does not do
  PEP screening, case management, or match-scoring workflow the way sanctions.io/Sanction
  Scanner/KYC Hub do. It's a fair "alternative to" for the specific sub-task of *sanctions-list
  change monitoring*, not a full AML platform replacement. List it as a complement/lighter-weight
  alternative, not a head-to-head competitor claim.

Suggested free-text tags:
  sanctions-screening, ofac, aml, kyc, regulatory-monitoring, compliance-automation,
  web-scraping, api, webhook, mcp, data-as-a-service
```

---

## Part B — Awesome-list PR

### B.1 List selection — verified, with one rejected candidate (see Honesty notes)

Two candidates were checked live, not assumed from the task's own examples:

| Candidate | Stars | Last activity (as of 2026-09-08) | Verdict |
|---|---|---|---|
| `lorien/awesome-web-scraping` | 8.1k | commits same day (Sep 8, 2026) | **Rejected — see below** |
| `awesomedata/awesome-public-datasets` | 78.9k | active (82 open issues, 76 open PRs) | Considered, not chosen — it indexes *datasets*, not tools; our product is a tool, so an entry would be a category mismatch even though the repo is thriving |
| `theopenlane/awesome-compliance` | 85 | PRs merged Aug 10–28, 2026 (~2 weeks before this check) | **Selected** |

`lorien/awesome-web-scraping`'s own `CONTRIBUTING.md` (fetched live) states two exclusion rules
that this product trips directly:
- *"Content related to AI agent automation or the Model Context Protocol"* is explicitly excluded
  — and MCP-for-AI-agents is one of this product's stated features.
- *"Web services, websites, or remote APIs (only standalone software qualifies)"* — Apify Actors
  are cloud-hosted and invoked by API/schedule; they are not standalone software you install and
  run. This is a second, independent disqualifier.

The repo even added a commit the same day this was checked — *"Add CI check for AI projects in
PRs"* — meaning an AI/MCP-flagged submission would likely fail CI automatically. Forcing this
submission would very likely be rejected on sight; it is not a good-faith fit for this list.

`theopenlane/awesome-compliance` was checked instead: it has an existing **"Regulatory Data
Sources"** section under Tools & Platforms, described in its own README as *"Programmatic access
to regulatory filings, corporate disclosures, and government registries for KYC/AML due
diligence, ESG compliance, disclosure monitoring, and beneficial-owner verification"* — a close
match. It already lists commercial, pay-per-use, **Apify-Actor-based** scrapers from a different
developer (`minute_contest`'s Poland KRS, Poland CRBR, Spain BORME, and France Societe.com
scrapers) in its Europe subsection, which is a direct, real precedent that this project accepts
this exact category of product.

### B.2 Real contribution rules (fetched from `.github/CONTRIBUTING.md`, live, 2026-09-08)

> Search previous suggestions before making a new one, as yours may be a duplicate.
> Each contribution requires an individual pull request following this format:
> `[Item Name](link) - Author`
> New categories or improvements to the existing categorization [are welcome].
> Check your spelling and grammar (or help fix the existing!). Use a meaningful title for both
> the pull request and the commit message.

Duplicate check performed: the current "Regulatory Data Sources" section (fetched in full) lists
only a "United States" subsection (one entry: FilingFirehose, an SEC EDGAR API) and a "Europe"
subsection (four entries, all non-Apify or `minute_contest`'s Apify actors). No existing entry for
`stefano_seggio`, `apify.com/stefano_seggio`, or any actor from this suite. Not a duplicate.

The README's own entry format (confirmed verbatim from the United States subsection):
```
- [Name](url) - Description sentence(s). Notable technical/pricing detail. Use case sentence.
```

### B.3 Draft PR

**Target file:** `README.md`
**Target section:** `Tools & Platforms → Regulatory Data Sources → United States`
(append after the existing FilingFirehose entry — CONTRIBUTING.md doesn't require alphabetical
order, and the existing section isn't alphabetized either)

**PR title:** `[Maritime & OFAC Sanctions Monitor](https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor) - Stefano Seggio`

**Commit message:** `Add Maritime & OFAC Sanctions Monitor to Regulatory Data Sources / United States`

**Diff (new line under the `#### United States` subsection):**

```diff
 #### United States

 - [FilingFirehose](https://filingfirehose.com) - Risk-scored REST API over SEC EDGAR filings
   (8-K, 10-K, 10-Q, S-3)...
+
+- [Maritime & OFAC Sanctions Monitor](https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor) -
+  Delta-tracked API/webhook feed over the US Treasury OFAC SDN vessel list and the UN Security
+  Council Consolidated List. Emits SANCTION / STATUS_CHANGE / UPDATED / DELISTED events instead
+  of full re-dumps, so a scheduled run only bills ($0.0005/event) and notifies on what actually
+  changed. Useful as a continuous sanctions-screening trigger feeding AML/KYC pipelines via
+  Slack/Zapier/CRM webhook. Part of a 17-actor regulatory-monitoring suite documented at
+  [awesome-regulatory-monitors](https://github.com/stefanoseggio/awesome-regulatory-monitors)
+  (Apache-2.0), which also live-verified and documented several sources that turned out to be
+  gated (Cloudflare, robots.txt, login walls) rather than silently skipping them.
```

**PR body (suggested):**
> Adds one entry to Regulatory Data Sources / United States: a delta-tracked monitor over the
> OFAC SDN vessel list + UN Consolidated List, in the same spirit as the existing FilingFirehose
> and `minute_contest` entries in this section (pay-per-use, programmatic alternative to manual
> list-checking). Disclosure: I'm the author of this actor.

### B.4 Note on submitting more than one entry

CONTRIBUTING.md phrases the format as one item per PR ("`[Item Name](link) - Author`," singular).
Submitting all 17 actors — or even several — in one PR, or as a burst of same-day PRs from a
first-time contributor, reads as self-promotional spam to volunteer maintainers and is a common
reason awesome-list PRs get closed without review, independent of content quality. **Recommendation:
submit only the one entry above now.** If it's merged, a second, separately-timed PR for
`actor-22-drug-safety-recalls-monitor` (FDA/EMA drug-safety monitor — a plausible second fit,
though "Regulatory Data Sources" is currently framed around KYC/AML/corporate-registry use cases,
not consumer drug safety, so it's a weaker fit than the sanctions monitor) could follow, but that
is a separate decision for later, not part of this package.

---

## Honesty notes

1. **AlternativeTo is a structural mismatch for "17 actors under one developer profile."** The
   site's data model is one page per single app with one homepage. This package resolves that by
   listing the single actor with the cleanest AlternativeTo competitor set (sanctions monitoring)
   rather than inventing a "suite" product that doesn't have its own real homepage. If the user
   wants other actors listed too, each needs its own separate AlternativeTo submission — do not
   read this as "add all 17" without asking first.
2. **`lorien/awesome-web-scraping` was evaluated and rejected as a poor fit**, not silently
   swapped out — it explicitly excludes both AI-agent/MCP-related content and remote-API/hosted
   products, both of which describe this product. Submitting there would likely fail automatically
   (there's now a same-day CI check for exactly this) and would waste the maintainers' time.
3. **`awesomedata/awesome-public-datasets` was also considered and not chosen** — it curates
   datasets, not tools that fetch them; listing an Actor there would be a category mismatch even
   though the repo is large and active.
4. **The "alternative to" framing is honest, not maximal.** The sanctions monitor is a narrower
   single-purpose delta feed, not a full AML case-management platform — the draft says so
   explicitly rather than implying feature parity with sanctions.io/Sanction Scanner/KYC Hub.
5. **No submission was actually executed.** Both are drafts for the user (or a later authorized
   step) to submit — AlternativeTo requires an email-verified account and PR submission requires
   write access / a fork under a GitHub identity, neither of which this task performed.
6. Developer "Origin" (country) for the AlternativeTo listing was deliberately left unspecified
   rather than guessed from the name — no verified source in this task confirmed it.

---

## Sources used (fetched live, 2026-09-08)

- https://apify.com/stefano_seggio — developer profile, actor count, bio
- https://github.com/stefanoseggio/awesome-regulatory-monitors — repo overview
- `C:\Users\Stef\apify-portfolio\_gtm\execution_launchpad\github-repo-package\README.md` — local
  source of truth for exact actor names, categories, pricing, delta-event types
- https://buttondown.com/where-to-post/archive/submitting-on-alternativetonet/ — AlternativeTo submission process summary
- https://alternativeto.net/faq — official FAQ, submission/review process, priority fee
- https://alternativeto.net/software/sanctions-io — comparable listing structure
- https://alternativeto.net/software/kyc-hub/about/ — comparable listing structure, real tag format
- https://github.com/lorien/awesome-web-scraping — candidate list, stats
- https://raw.githubusercontent.com/lorien/awesome-web-scraping/master/CONTRIBUTING.md — real exclusion rules (rejected this list)
- https://github.com/lorien/awesome-web-scraping/commits/master — activity/recency, same-day AI-exclusion commit
- https://github.com/awesomedata/awesome-public-datasets — candidate list, considered and not chosen
- https://github.com/theopenlane/awesome-compliance — selected list, structure, activity
- https://raw.githubusercontent.com/theopenlane/awesome-compliance/main/README.md — real "Regulatory Data Sources" section content, existing entries, format
- https://github.com/theopenlane/awesome-compliance/commits/main — activity/recency
- https://github.com/theopenlane/awesome-compliance/community — confirmed CONTRIBUTING.md location
- https://raw.githubusercontent.com/theopenlane/awesome-compliance/main/.github/CONTRIBUTING.md — real contribution rules
