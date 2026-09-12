# awesome-regulatory-monitors

> A curated directory of open, programmatically-accessible regulatory, sanctions, procurement, and compliance data sources — plus a working reference implementation covering 17 of them as ready-to-run Apify Actors.

[![Actors](https://img.shields.io/badge/actors-17-blue)](#actor-directory)
[![Architecture](https://img.shields.io/badge/architecture-delta--tracked-green)](#architecture)
[![License](https://img.shields.io/badge/license-Apache--2.0-lightgrey)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

This list exists because most "regulatory data" round-ups either link to sources without saying which ones are actually machine-readable, or quietly skip the sources that turned out to be gated. This one does neither: every source below was live-checked (robots.txt, response codes, auth requirements) before being listed as "open," and every source that was checked and rejected is listed too, with the real reason — a Cloudflare challenge, a paid-only bulk tier, a robots.txt disallow — so nobody else has to re-do that research from scratch.

## Table of contents

- [Architecture](#architecture)
- [Actor directory](#actor-directory)
- [Sources checked and excluded (and why)](#sources-checked-and-excluded-and-why)
- [Quickstart](#quickstart)
- [The delta-tracking pattern](#the-delta-tracking-pattern)
- [Contributing](#contributing)
- [License](#license)

## Architecture

Every actor in the directory below follows the same shape — a source-specific fetch/parse layer feeding a shared delta-classification core, so a recurring run only surfaces (and bills for) what actually changed:

```
                    ┌─────────────────────────────────────────────┐
                    │            Regulator / Registry Source        │
                    │   (OFAC, FDA, EMA, USPTO, World Bank, a       │
                    │    government tender portal, a gazette...)   │
                    └───────────────────────┬───────────────────────┘
                                             │ fetch (plain HTTP,
                                             │ no CAPTCHA/WAF bypass)
                                             ▼
                    ┌─────────────────────────────────────────────┐
                    │              Actor: fetch + parse              │
                    │   raw source shape → typed native record       │
                    └───────────────────────┬───────────────────────┘
                                             │
                    ┌────────────────────────┴────────────────────────┐
                    │                                                   │
                    ▼                                                   ▼
     ┌───────────────────────────────┐              ┌───────────────────────────────┐
     │   Named Key-Value Store         │◄────────────►│   Delta Classifier              │
     │   (persists ACROSS runs -       │   fingerprint │   first-seen? status changed?   │
     │   Actor.openKeyValueStore(name),│   compare     │   content changed? unchanged?   │
     │   NOT the run-scoped default)   │              │   (+ CLOSED/DELISTED, only when  │
     └───────────────────────────────┘              │    the fetch was a complete       │
                                                       │    census - never guessed)        │
                                                       └───────────────────┬───────────────┘
                                                                           │
                                                                           ▼
                                                       ┌───────────────────────────────┐
                                                       │   Unified Master Schema (UMS)   │
                                                       │   output — one shared 18-field  │
                                                       │   envelope + native fields       │
                                                       └───────────────────┬───────────────┘
                                                                           │
                                             ┌─────────────────────────────┼─────────────────────────────┐
                                             ▼                             ▼                             ▼
                                   ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
                                   │   Apify Dataset      │       │   Native Webhook     │       │   MCP / API pull     │
                                   │   (JSON/CSV/Excel)   │       │   (Slack/Zapier/     │       │   (LLM agent tools)  │
                                   │                       │       │    Make/CRM)          │       │                       │
                                   └───────────────────┘       └───────────────────┘       └───────────────────┘
```

**The one rule that makes the "closed/delisted" detection trustworthy:** absence-based closure detection only runs when the fetch was provably a complete census of the register (see [The delta-tracking pattern](#the-delta-tracking-pattern)) — never inferred from a paginated or filtered partial walk. Getting this wrong produces false-positive "closed" alerts; getting it right is most of what makes this pattern non-trivial.

## Actor directory

### Government procurement & tenders

| Source | Jurisdiction | Actor | Delta events | Pricing |
|---|---|---|---|---|
| GrantConnect | Australia (federal) | [australia-grantconnect-monitor](https://apify.com/stefano_seggio/australia-grantconnect-monitor) | NEW_LISTING / UPDATED / CLOSED | $0.003 / $0.001 |
| HSE enforcement register | United Kingdom | [uk-hse-enforcement-monitor](https://apify.com/stefano_seggio/uk-hse-enforcement-monitor) | SANCTION / UPDATED / SNAPSHOT_NO_DIFF | $0.003 / $0.001 |
| MyFloridaMarketPlace | Florida, USA | [florida-tenders-monitor](https://apify.com/stefano_seggio/florida-tenders-monitor) | NEW_LISTING / UPDATED / CLOSED | $0.003 / $0.001 |
| Compras Santa Fe | Santa Fe Province, Argentina | [santafe-compras-monitor](https://apify.com/stefano_seggio/santafe-compras-monitor) | NEW_LISTING / STATUS_CHANGE / CLOSED | $0.003 / $0.001 |
| Compras Tucumán | Tucumán Province, Argentina | [tucuman-compras-monitor](https://apify.com/stefano_seggio/tucuman-compras-monitor) | NEW_LISTING / STATUS_CHANGE / UPDATED | $0.003 (single tier) |
| Compras Salta | Salta Province, Argentina | [salta-compras-monitor](https://apify.com/stefano_seggio/salta-compras-monitor) | NEW_LISTING / UPDATED / CLOSED | $0.003 / $0.001 |
| COMPR.AR Mendoza | Mendoza Province, Argentina | [mendoza-compras-monitor](https://apify.com/stefano_seggio/mendoza-compras-monitor) | NEW_LISTING / STATUS_CHANGE / UPDATED | $0.003 / $0.001 |
| Compras Entre Ríos | Entre Ríos Province, Argentina | [entrerios-compras-monitor](https://apify.com/stefano_seggio/entrerios-compras-monitor) | NEW_LISTING / STATUS_CHANGE | $0.003 (single tier) |
| Compras Córdoba | Córdoba Province, Argentina | [cordoba-compras-monitor](https://apify.com/stefano_seggio/cordoba-compras-monitor) | NEW_LISTING / STATUS_CHANGE / CLOSED | $0.003 / $0.001 |
| PBA tenders | Buenos Aires Province, Argentina | [pba-tenders-monitor](https://apify.com/stefano_seggio/pba-tenders-monitor) | NEW_LISTING / STATUS_CHANGE / CLOSED | $0.003 / $0.001 |
| World Bank Procurement Notices + Other Sanctions | Global (World Bank) | [actor-20-mdb-procurement-monitor](https://apify.com/stefano_seggio/actor-20-mdb-procurement-monitor) | NEW_LISTING / STATUS_CHANGE / UPDATED (+ SANCTION on the debarment sub-source) | $0.001 / $0.003 |

### Sanctions, enforcement & legal/regulatory registers

| Source | Jurisdiction | Actor | Delta events | Pricing |
|---|---|---|---|---|
| OFAC SDN List (vessels) + UN Consolidated List | United States (global reach) | [actor-19-maritime-sanctions-monitor](https://apify.com/stefano_seggio/actor-19-maritime-sanctions-monitor) | SANCTION / STATUS_CHANGE / UPDATED / DELISTED | $0.0005 (single tier) |
| Diario Oficial (official gazette) | Chile | [diario-oficial-cl-monitor](https://apify.com/stefano_seggio/diario-oficial-cl-monitor) | NEW_LISTING / UPDATED | $0.003 (single tier) |
| USPTO PTAB + EPO OPS | United States / Europe | [actor-21-patent-ip-enforcement-monitor](https://apify.com/stefano_seggio/actor-21-patent-ip-enforcement-monitor) | SANCTION / UPDATED / TERMINATED | $0.002 (single tier) |

### Health, safety & consumer protection

| Source | Jurisdiction | Actor | Delta events | Pricing |
|---|---|---|---|---|
| FDA openFDA + EMA DHPC | United States / European Union | [actor-22-drug-safety-recalls-monitor](https://apify.com/stefano_seggio/actor-22-drug-safety-recalls-monitor) | SANCTION / NEW_LISTING / STATUS_CHANGE / UPDATED | $0.001 (single tier) |

### General-purpose (not registry-monitoring, included for completeness)

| Source | Actor | Notes | Pricing |
|---|---|---|---|
| Any website's own metadata | [primer-actor (CleanMeta Crawler)](https://apify.com/stefano_seggio/primer-actor) | Page-metadata extraction with per-URL content-change detection | $0.0005 (single tier) |
| OpenStreetMap Overpass / customer seed lists | [actor-18-b2b-lead-magnet](https://apify.com/stefano_seggio/actor-18-b2b-lead-magnet) | Compliant B2B lead discovery — deliberately never Google Maps | $0.002 / $0.015 |

## Sources checked and excluded (and why)

Listed here so nobody else has to re-verify these — each was live-checked, not assumed:

| Source | Status | Real reason |
|---|---|---|
| Asian Development Bank (ADB) procurement | Excluded | `adb.org` returns a Cloudflare bot-detection challenge on every path tested, including its own `robots.txt` |
| Inter-American Development Bank (IDB) open data API | Excluded | The real CKAN API works when called directly, but `data.iadb.org/robots.txt` explicitly disallows every programmatic download path |
| WIPO PATENTSCOPE bulk/API access | Excluded | Every structured data product is a paid subscription (CHF-priced); only the human search UI is free |
| USPTO PatentsView API | Excluded (as of the date checked) | Confirmed mid-migration/down, no committed relaunch date, and covers grants, not enforcement actions |
| Paris MoU / Tokyo MoU vessel inspection databases | Excluded | Both proxy through a real login wall (Paris MoU → EMSA THETIS Keycloak OAuth) or a literal CAPTCHA field (Tokyo MoU/APCIS) |
| IMO GISIS | Excluded | `robots.txt` disallows the relevant path; the public module is session/registration-gated for real search |

## Quickstart

### Python

```python
# pip install apify-client
from apify_client import ApifyClient
import os

client = ApifyClient(os.environ["APIFY_TOKEN"])

# Any actor in the directory above works with this same pattern -
# swap the actor slug and its real input fields (see that actor's own
# README or .actor/input_schema.json for the exact field names).
run = client.actor("stefano_seggio/actor-19-maritime-sanctions-monitor").call(
    run_input={"maxItems": 250, "onlyNew": True}
)

for record in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(record["event_type"], record.get("vesselName") or record.get("record_id"))
```

### Node.js

```javascript
// npm install apify-client
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/actor-19-maritime-sanctions-monitor').call({
    maxItems: 250,
    onlyNew: true,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
for (const record of items) {
    console.log(record.event_type, record.vesselName ?? record.record_id);
}
```

See `scripts/` in this repo for a loader that runs every actor in the directory above in one pass, useful as a starting point for building your own cross-source monitor.

## The delta-tracking pattern

Every actor above uses the same core mechanism for cross-run change detection, worth understanding once rather than re-derived per source:

1. **Cross-run state needs a NAMED key-value store**, not the default one. `Actor.getValue()`/`Actor.setValue()` (and `Actor.openKeyValueStore()` called with no name) resolve to the store scoped to the *current run* — it does not survive to the next scheduled execution. `Actor.openKeyValueStore('some-fixed-name')` does. This is an easy, silent mistake — the code runs fine, tests pass, and only a real second scheduled run reveals nothing persisted.
2. **A record's fingerprint, not just its ID, determines its event type.** A flat "have I seen this ID before" check only supports new-vs-not-new. Splitting a fingerprint into a status component and a content component (hash them separately) lets you distinguish a genuine status transition (e.g. a trial concluding, a tender closing) from an unrelated content edit.
3. **Absence-based "closed/delisted" detection requires a provably complete fetch.** If your source is paginated or filtered, a record's absence from one run's results can mean "genuinely gone" or "just not reached this time" — indistinguishable without an explicit completeness check. Every actor above that supports a CLOSED/DELISTED event gates it on this.

## Contributing

PRs adding a genuinely open, live-verified, machine-readable regulatory/compliance/procurement data source are welcome. Before submitting:

- Confirm the source is actually open — check `robots.txt`, confirm no CAPTCHA/WAF challenge on a bare unauthenticated request, and note the exact verification date and method (curl output, browser check) in your PR description.
- If the source turns out to be gated, still worth a PR — add it to the "checked and excluded" table with the real reason, so the next person doesn't re-check it.
- No affiliate links, no thin wrapper entries whose only content is a redirect to a paid product.

## Maintainer

Built and maintained by **Stefano Seggio** as part of **Delta Registry** — pay-per-event regulatory & compliance data infrastructure. For the full catalog (24 Actors across procurement, enforcement, IP, and compliance monitoring), see the [Apify Store profile](https://apify.com/stefano_seggio) or the [GitHub profile](https://github.com/stefanoseggio). For enterprise licensing or a custom monitor built against a new source, connect on [LinkedIn](https://www.linkedin.com/in/stefanoseggio-deltaregistry).

## License

Apache-2.0 — see `LICENSE`.
