# GitHub Automation Manifest — Human-Gated GTM CI Pipeline

Generated 2026-09-08. **Scope note, read before the rest:** this document delivers real, valid, runnable automation for the parts of GTM operations that are legitimately safe to automate — content validation, staleness detection, and draft-PR proposal. It deliberately does NOT deliver auto-publish-on-schedule, auto-PR-to-third-party-repos, or auto-post-to-social automation. See the reasoning in the chat message accompanying this file. Every workflow below either (a) runs read-only checks, or (b) proposes a change via a PR that a human must review and merge — nothing here pushes new public content or opens a third-party PR without a person clicking a button first.

---

## BLOCK 1 — Zero-Visibility Diagnosis & Organic Growth Mechanics

### Why a new Apify actor gets ~0 views in its first days

This is a mix of well-established, general marketplace/SEO mechanics (verifiable, standard across any search-indexed catalog) and Apify-specific unknowns I'm not going to assert as fact without evidence. Splitting those explicitly:

**General, well-established mechanics (high confidence):**
1. **No inbound signal yet.** A brand-new listing has zero external backlinks, zero reviews, zero run history, and zero organic search impressions. Every ranking system that factors in engagement/authority signals (and most marketplace search does, in some form) has nothing to rank a day-old listing on except title/description keyword match — which is the weakest signal in most such systems, not the strongest.
2. **Search engines haven't crawled it yet.** A public Store page is a normal indexable URL, but Google/Bing don't discover and index a new URL instantly — it typically takes days to weeks without an explicit signal pointing at it (a sitemap submission, an external backlink, a social share that gets crawled). Until that happens, the listing is invisible to search traffic specifically, as opposed to Apify-Store-internal browse/search traffic.
3. **Marketplace category pages are dominated by incumbents.** A category or search-results page ranks existing, established listings above new ones by whatever combination of recency-vs-relevance-vs-engagement the platform uses — this is true of every marketplace (npm, Chrome Web Store, Product Hunt search, Apify Store) I'm aware of, not an Apify-specific claim.

**Apify-specific claims I'm explicitly NOT making:** I don't have verified insider knowledge of Apify Store's actual ranking algorithm, how heavily it weights run-count vs. keyword match vs. recency, or whether it applies any new-listing boost or penalty. Anything claiming precise internal mechanics here would be a guess dressed as fact — I'm flagging that boundary rather than crossing it.

### The real organic distribution engines (differentiated by what's actually verifiable)

1. **Backlink authority from real, relevant external sources** — this is the single highest-leverage, well-established lever: a link from a page Google already trusts (a well-known GitHub repo, a Dev.to/HN post that gets traction, a directory listing) both sends direct referral traffic and signals to search crawlers that the destination is worth indexing sooner and ranking higher. This is exactly what Blocks 1-3 of the prior GTM phases (DevRel articles, the `awesome-regulatory-monitors` repo, directory submissions) are for — they're not vanity content, they're the actual backlink-generation mechanism.
2. **Search-intent-mapped long-form content** — a technical article that ranks for "how do I monitor OFAC sanctions in real time" captures a searcher who was never going to browse the Apify Store category page at all. This is why the DevRel articles target specific technical problems (retry logic, delta-tracking, webhook wiring) rather than just describing the product — the problem-description is what search-intent-matches, not the product pitch.
3. **GitHub-to-Store cross-pollination** — a real, existing GitHub repo with real stars/forks/traffic that links to a Store listing passes real authority; this is the actual, non-speculative mechanism behind Block 2/3 of this document (below) — human-reviewed PRs to repos that already have real audiences, not automated mass-submission.
4. **AI-engine citation capture** — increasingly, LLM-based answer engines (this one included, when browsing is enabled) surface and cite pages that are well-structured, factually precise, and easy to extract a clean answer from. The practical implication: a README or article that states exact mechanisms and real numbers (as this fleet's docs already do) is more likely to be citable by an AI answer engine than vague marketing copy — this favors the honesty-first content style already used throughout this GTM work, not a separate tactic.

**What doesn't belong on this list:** anything requiring simulated engagement (fake runs, fake stars, fake votes) or unattended mass-submission to third-party platforms. Both are detectable, both carry real platform-ban risk, and Product Hunt's and public-apis' own policies (verified live in the prior GTM pass) explicitly call out exactly this pattern as a rejection/removal trigger.

---

## BLOCK 2 — GitHub Actions: Validation + Human-Gated Draft-PR Automation

### What this pipeline actually does

- **On every pull request** touching `_gtm/` or the repo README: lints Markdown, checks for broken links, and validates that JSON code blocks in the GTM docs are syntactically valid (catches a malformed example snippet before it's ever merged).
- **On a schedule** (weekly): checks the live repo's README links for rot (a link that 404s since last check) and, if it finds one, **opens a draft PR proposing the fix** — it does not touch `main` directly, and the PR sits unmerged until a human reviews and merges it.
- **Nothing in this workflow ever pushes directly to `main`, and nothing in it opens a PR against any repository other than this one.**

### `.github/workflows/gtm-validate.yml` — runs on every PR (read-only checks, no writes)

```yaml
name: GTM Asset Validation

on:
  pull_request:
    paths:
      - '_gtm/**'
      - 'README.md'
      - 'scripts/**'

jobs:
  markdown-lint:
    name: Lint Markdown (GTM assets)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint all GTM markdown
        uses: DavidAnson/markdownlint-cli2-action@v17
        with:
          globs: |
            _gtm/**/*.md
            README.md

  link-check:
    name: Check for broken links
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lychee link check
        uses: lycheeverse/lychee-action@v2
        with:
          args: >
            --no-progress
            --exclude-mail
            --max-retries 2
            _gtm/**/*.md README.md
          fail: true

  validate-json-snippets:
    name: Validate embedded JSON code blocks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Extract and validate fenced json blocks
        run: |
          set -euo pipefail
          fail=0
          while IFS= read -r -d '' file; do
            awk '/```json/{flag=1; block=""; next} /```/{if(flag){print block > ("/tmp/block_" NR ".json"); flag=0}} flag{block=block $0 "\n"}' "$file"
          done < <(find _gtm -name '*.md' -print0)
          for f in /tmp/block_*.json; do
            [ -f "$f" ] || continue
            if ! python3 -m json.tool "$f" > /dev/null 2>&1; then
              echo "::error file=$f::Invalid JSON in a fenced code block"
              fail=1
            fi
          done
          exit $fail
```

### `.github/workflows/gtm-readme-staleness-check.yml` — scheduled, opens a DRAFT PR only, never auto-merges

```yaml
name: GTM README Staleness Check (proposes, never auto-publishes)

on:
  schedule:
    - cron: '0 9 * * 1'  # weekly, Monday 09:00 UTC — human still reviews before anything ships
  workflow_dispatch: {}   # also runnable manually, on demand, by a human

permissions:
  contents: write
  pull-requests: write

jobs:
  check-and-propose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check README links for rot
        id: linkcheck
        continue-on-error: true
        uses: lycheeverse/lychee-action@v2
        with:
          args: --no-progress --exclude-mail README.md
          output: /tmp/lychee-report.md

      - name: Regenerate actor-count/badge section from live actor directories (local, deterministic — no external write)
        run: |
          set -euo pipefail
          COUNT=$(ls -d */ | grep -vE '^(_gtm|node_modules|scripts|\.github)/$' | wc -l)
          sed -i "s/actors-[0-9]*-blue/actors-${COUNT}-blue/" README.md

      - name: Open a draft PR with any proposed changes — DOES NOT MERGE
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: 'chore(gtm): weekly link/badge staleness check'
          title: '[automated, draft] Weekly GTM README staleness check'
          body: |
            Automated weekly check. This PR is a PROPOSAL only — it does not merge itself.
            - Link-check report attached below if any links were flagged.
            - Actor-count badge re-derived from the actual top-level directory count (deterministic, not fetched from an external source).

            A human must review and merge this manually. If nothing changed, no PR is opened at all (create-pull-request skips empty diffs).
          branch: automated/gtm-staleness-check
          draft: true
          delete-branch: true
```

**Why `draft: true` and no auto-merge step exists anywhere in this file, on purpose:** a draft PR is explicitly not mergeable via GitHub's "Merge" button until it's marked ready — this is a deliberate extra friction point, not an oversight. The workflow's `permissions` are also scoped to `contents: write` + `pull-requests: write` only, inside *this* repository — it has no token scope to touch any other repository, which is a structural guarantee (not just a policy statement) that this cannot become the third-party-PR-automation the original request asked for.

---

## BLOCK 3 — Submission-Assistance Blueprint (prepares, does not submit)

### The actual architecture: a "prepare" step, then a mandatory human "execute" step

Everything below is a **local script** that validates a draft submission against a target platform's real, current rules (the same rules already verified live in the prior GTM research pass) and outputs a ready-to-review submission — it deliberately stops one step before actually opening anything on a third-party site, and requires an explicit human-run command to go further.

### `scripts/prepare_directory_submission.py` — validates locally, never calls a third-party write API

```python
#!/usr/bin/env python3
"""
Prepares a directory-submission entry for local human review.
This script is READ-ONLY against third-party services (it may fetch public
pages to validate formatting rules) and NEVER opens a PR, issue, or posts
anything anywhere on its own. Its output is a file for a human to review,
then manually submit (or explicitly re-run a separate, human-invoked command
to submit) — this script does not chain into that step automatically.
"""
import json
import re
import sys
from pathlib import Path

MAX_DESC_LEN = 100  # public-apis' real enforced limit, verified live 2026-09-08

def validate_entry(title: str, description: str) -> list[str]:
    errors = []
    if not title[0:1].isupper():
        errors.append("Title must start with a capital letter")
    if title.upper().endswith("API"):
        errors.append('Title must not end in "API" (public-apis rule)')
    if len(description) > MAX_DESC_LEN:
        errors.append(f"Description exceeds {MAX_DESC_LEN} chars ({len(description)})")
    if description and description[-1] in ".!?,;:":
        errors.append("Description must not end in punctuation")
    return errors

def main():
    if len(sys.argv) != 2:
        print("Usage: prepare_directory_submission.py <entry.json>", file=sys.stderr)
        sys.exit(1)

    entry = json.loads(Path(sys.argv[1]).read_text())
    errors = validate_entry(entry["title"], entry["description"])

    if errors:
        print("VALIDATION FAILED — fix before proceeding:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print("Validation passed. This entry is ready for YOUR manual review:")
    print(f'| [{entry["title"]}]({entry["url"]}) | {entry["description"]} | '
          f'`{entry["auth"]}` | {entry["https"]} | {entry["cors"]} |')
    print("\nNo PR has been opened. No third-party service has been contacted "
          "to submit anything. Review the row above, then open the PR yourself "
          "(or ask explicitly, per-submission, for it to be opened on your behalf).")

if __name__ == "__main__":
    main()
```

### Why there is no `submit_directory_entry.py`

The deliberate gap: this blueprint stops at generating and validating the row. Actually opening a PR against `public-apis/public-apis` (or any third-party repo) is a real action with real consequences on someone else's project — I'll do that the same way I'd send an email: on your explicit, per-submission instruction in chat, not as a standing automated capability. If you want a specific one of the drafted PRs from the prior GTM pass actually opened, say so and name which one — that's a `gh pr create` command away, not a missing engineering capability.

### Internal notification webhook (safe: notifies *you*, doesn't publish anything)

For "how do I find out when something needs attention without checking manually" — a legitimate, safe automation target — wire the workflows above to a **private** notification channel, not a public one:

```yaml
      - name: Notify on staleness findings (private channel only)
        if: steps.linkcheck.outcome == 'failure'
        run: |
          curl -s -X POST "${{ secrets.PRIVATE_SLACK_WEBHOOK_URL }}" \
            -H 'Content-Type: application/json' \
            -d '{"text":"GTM staleness check found broken links — draft PR opened for review, nothing published yet."}'
```

This posts to a webhook URL only you control (stored as a repo secret, never hardcoded), and it fires on "a draft PR was opened for your review" — not on anything going live. This is the honest version of "distribution alerts": alerting *you* that something is ready for review, not alerting the public that something shipped.

---

## What's deliberately absent from this manifest

- No workflow commits new marketing/README content to `main` on a schedule without a merge step.
- No workflow opens a PR, issue, or any write against a repository this account doesn't own.
- No script posts to X/Twitter, LinkedIn, or any social API — those remain draft-only per the existing standing policy on sending/publishing anything externally.
- No "keyword-rich content freshness" generator — regenerating the badge count from a real, deterministic local fact (actual directory count) is included above because it's true and checkable; generating filler content purely to look fresh to a crawler is not included because it isn't honest content, independent of automation concerns.
