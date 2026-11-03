# Global Corporate & Patent Intelligence

One Actor, four public sources for patent disputes, clinical-trial and drug-patent data, and the Singapore company register. Pick the sources for each run and receive only the records that are **new or changed since your last run**, as clean JSON in the dataset.

Typical users: IP and litigation teams watching patent disputes, pharma competitive-intelligence analysts, KYC and onboarding teams that need register changes, and market researchers.

## What is covered

| Source id | What it reads | Scope to know before you rely on it |
|---|---|---|
| `uspto_ptab` | USPTO Patent Trial and Appeal Board trial proceedings (IPR, PGR, CBM, DER) through the USPTO Open Data Portal, newest petition first | **Bring your own key:** needs your USPTO Open Data Portal API key (`usptoOdpApiKey`). |
| `epo_opposition` | EPO Open Patent Services legal-status lookup, reporting opposition-family legal events | **Watchlist-driven.** You supply the EP publication numbers to look up (`epWatchlist` in `sourceOptions`); the Actor does not search for all oppositions. An empty or invalid list fails preflight. **Bring your own keys:** `epoOpsConsumerKey` and `epoOpsConsumerSecret`. |
| `clinicaltrials_orange_book` | ClinicalTrials.gov v2 studies (newest update first) and FDA Orange Book products with patent and exclusivity data (openFDA) | Choose `clinicaltrials`, `orange_book` or both through `subSources`. Optional filters include sponsors, keywords and condition. An optional openFDA API key raises openFDA's limits. |
| `sg_acra` | Singapore ACRA register of corporate entities from data.gov.sg (monthly extract in 27 first-letter shards), newest registrations first | The default shard is `A` only; list the shards you need in `shardSelection`. Optional `ssicCodeFilter` and `entityStatusFilter`. Released under the Singapore Open Data Licence. |

**Not available (held):** `ae_registers` (ADGM's register service has answered every search with a server error, `System.NullPointerException` in `RASearchUtil.getSearchResponseForPR`, since at least 2026-09-17, from Apify's cloud and from elsewhere, and no row has ever been obtained; the DIFC register is disallowed by the site's robots.txt and Dubai mainland licences need an approval). Selecting one stops the run before any request to a source is made and before any record is billed, and the error says why; the platform still charges the start event of a run that has started.

## How to use it

1. Open the **Input** tab and choose one or more `sources`. Start with one. The form is prefilled with a small snapshot (`deltaMode: "all"`, 10 records per source) so that the first run shows data at once; for a scheduled Task set `deltaMode` to `onlyChanged` and raise `maxItemsPerSource`.
2. Add the credentials the source needs (see "Credentials").
3. Run it. The first run of a source treats every record it reads as new (see "Control your spend" below).
4. Put the same input in a **Task** and attach an Apify **Schedule**. Each Task keeps its own delta memory, so later runs deliver only what changed.
5. Read the results from the dataset, the Apify API, or an Apify webhook/integration.

Example input:

```json
{
  "sources": ["clinicaltrials_orange_book"],
  "sourceOptions": {
    "clinicaltrials_orange_book": { "sponsors": ["Pfizer"] }
  },
  "deltaMode": "onlyChanged",
  "maxItemsPerSource": 200,
  "watchlistNames": ["Pfizer"]
}
```

Each source validates its own slice of `sourceOptions` and rejects unknown keys, so a typo fails the run in preflight instead of being ignored.

## Delta modes

| `deltaMode` | Delivers |
|---|---|
| `onlyChanged` (default) | Records seen for the first time, and records whose content or status changed |
| `onlyNew` | Records seen for the first time |
| `all` | Every record, unchanged ones included (tagged `delta_status: "unchanged"`) |

Delta memory is kept per `stateNamespace` (default: one per Task) in a key-value store named `global-corporate-patent-intelligence-delta-state` in your account. Give two Tasks that run at the same time different namespaces: a second concurrent run of the same namespace and source is refused. To restart a source from scratch, delete its `state.<namespace>.<source>` and `journal.<namespace>.<source>` records.

## Output

Every dataset row carries `engine`, `source`, `record_id`, `delta_status`, `is_new`, `is_watchlist_match`, `matched_watchlist_keyword` and `scraped_at`, plus the fields of the source. A `RUN_SUMMARY` record in the key-value store lists per-source counts, warnings and watchlist accounting.

A run ends `FAILED` when preflight finds a problem (an unknown or held source, a missing credential, an invalid option) before any request, or when every selected source failed and nothing was delivered. If at least one source answered, the run succeeds and the per-source errors stay on `RUN_SUMMARY`: check it in automated pipelines.

## Watchlist

`watchlistNames` is a list of keywords matched case-insensitively as substrings against each record's names (parties, sponsors, entity names and similar). Entries shorter than three characters (letters or digits, not counting punctuation), blank or punctuation-only entries are ignored; with no valid keyword nothing matches. A matching record is flagged `is_watchlist_match` and billed a **Watchlist hit** event on top of its row event. Two hard ceilings apply per run: `maxWatchlistHitsPerRun` (default 200) and `maxWatchlistSpendUsd` (default 50). Use broad keywords with care.

## Pricing

This Actor uses pay-per-event pricing. The **Pricing** tab shows the current price of every event; prices are deliberately not repeated on this page so that it cannot go out of date.

* **Actor start**: charged per GB of memory the run is configured with. This Actor uses 1 GB, so each run starts one start event.
* **One row event per delivered record**, named by source: Patent enforcement proceeding (`uspto_ptab` and `epo_opposition`); Clinical trial / Orange Book record (`clinicaltrials_orange_book`); New Singapore ACRA entity and Updated Singapore ACRA entity (`sg_acra`).
* **Watchlist hit**: see above.

With `deltaMode: "all"` every delivered record is billed, unchanged ones at the source's "Updated" event (or its only row event). Records that are not delivered are not billed a row event. Your own API keys are used against the publishers' services; any fees or limits on those keys are between you and the publisher.

### Control your spend

* The first run of a source delivers up to `maxItemsPerSource` records (default 500, range 1 to 10,000) and bills each one. Registers can be large; for a trial set a low value such as 20.
* Use Apify's maximum-cost-per-run setting as an additional ceiling.
* Keep `deltaMode` at `onlyChanged` for scheduled runs.

## Reliability notes

Delivery is at-least-once: a progress checkpoint is written every 25 rows and a small journal after every row that was delivered and billed, so after a hard kill at most the one record in flight can be delivered and billed again. A memory record that exists but cannot be read fails its own source instead of being treated as empty.

## Credentials

| Field | Used by |
|---|---|
| `usptoOdpApiKey` | `uspto_ptab` |
| `epoOpsConsumerKey`, `epoOpsConsumerSecret` | `epo_opposition` |
| `fdaApiKey` (optional) | `clinicaltrials_orange_book` |

All are stored encrypted by Apify and never logged. A source whose required credential is missing fails preflight before any request to a source and before any record is billed (the start event of the run is still charged).

## Data sources and licences

Records are published by the USPTO, the European Patent Office, ClinicalTrials.gov (US National Library of Medicine), the US FDA (openFDA) and the Singapore Government's data.gov.sg (Singapore Open Data Licence). Reuse terms are those of each publisher: check them for your use case.

## Disclaimer

This Actor reads public sources and reports what they publish. It is not legal, medical or investment advice. Patent legal-status and register data can lag or be corrected upstream: confirm deadlines and statuses on the official register before you rely on them.

## Support

Questions and bug reports: the **Issues** tab of this Actor (https://apify.com/stefano_seggio/global-corporate-patent-intelligence/issues/open).
