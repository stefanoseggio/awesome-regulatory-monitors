# Global RegTech Compliance Feed

One Actor, six public regulatory sources. Pick the sources for each run and receive only the records that are **new or changed since your last run**, as clean JSON in the dataset.

Typical users: compliance and sanctions-screening teams that want a scheduled delta of public lists, shipping and trade-finance analysts, supplier-risk and ESG teams, and anyone who wants to know when a regulator publishes something new.

## What is covered

| Source id | What it reads | Scope to know before you rely on it |
|---|---|---|
| `ofac` | US Treasury OFAC Specially Designated Nationals (SDN) list | **Vessel entries only.** Individuals, entities and aircraft are not returned. Records can be cross-referenced by IMO number against the UN Security Council Consolidated List. |
| `world_bank_debarred` | World Bank "Other Sanctions" table (letters of reprimand, conditional non-debarment and similar) | **This is not the World Bank debarment register.** The main list of debarred firms is not read. "No match here" never means "not debarred". |
| `uk_modern_slavery` | UK Modern Slavery Statement Registry, the registry's official per-year bulk CSV | One record per organisation per statement. Published under the Open Government Licence v3.0. |
| `sec_enforcement` | SEC litigation releases and administrative proceedings, from the SEC's own RSS feeds | Each feed exposes only its newest ~25 items. This is a recency monitor, not a history: schedule runs often enough that fewer than 25 releases appear between two runs. |
| `ai_crawler_signals` | For each domain you list: robots.txt permissions for 18 AI-crawler user agents, Cloudflare Content-Signal values, and presence plus SHA-256 of `/llms.txt` and `/llms-full.txt` | Requests only `/robots.txt`, `/llms.txt` and `/llms-full.txt` of the domains you supply (at most 200 per run). You can replace the default bot list. |
| `fda_ema_recalls` | FDA drug enforcement (recall) records from openFDA, and EMA direct healthcare-professional communications | Choose `fda`, `ema` or both. An optional openFDA API key raises openFDA's request limits. |

**Not available (held):** `paris_mou_thetis` (login wall), `tokyo_mou_apcis` (CAPTCHA), `imo_gisis` (robots.txt disallows the needed paths and no open bulk feed was found). A held source cannot be selected: the input form does not list it, and the platform rejects an API call that names one as invalid input before a run starts, so nothing is charged. Should one ever reach the Actor, the run stops before any request to a source is made and before any record is billed; the platform still charges the start event of a run that has started. This Actor does not log in to portals, solve CAPTCHAs or disguise its requests.

## How to use it

1. Open the **Input** tab and choose one or more `sources`. Start with one. The form is prefilled with a small snapshot (`deltaMode: "all"`, 10 records per source) so that the first run shows data at once; for a scheduled Task set `deltaMode` to `onlyChanged` and raise `maxItemsPerSource`.
2. Run it. The first run of a source treats every record it reads as new (see "Control your spend" below).
3. Put the same input in a **Task** and attach an Apify **Schedule**. Each Task keeps its own delta memory, so later runs deliver only what changed.
4. Read the results from the dataset, the Apify API, or an Apify webhook/integration.

Example input:

```json
{
  "sources": ["sec_enforcement", "fda_ema_recalls", "ai_crawler_signals"],
  "sourceOptions": {
    "fda_ema_recalls": { "subSources": ["fda"] },
    "ai_crawler_signals": { "domains": ["example.com", "example.org"] }
  },
  "deltaMode": "onlyChanged",
  "maxItemsPerSource": 500,
  "watchlistNames": ["Acme Corp"]
}
```

Each source validates its own slice of `sourceOptions` and rejects unknown keys, so a typo fails the run in preflight instead of being ignored.

## Delta modes

| `deltaMode` | Delivers |
|---|---|
| `onlyChanged` (default) | Records seen for the first time, and records whose content changed |
| `onlyNew` | Records seen for the first time |
| `all` | Every record, unchanged ones included (tagged `delta_status: "unchanged"`) |

Delta memory is kept per `stateNamespace` (default: one per Task) in a key-value store named `global-regtech-compliance-feed-delta-state` in your account. Give two Tasks that run at the same time different namespaces: a second concurrent run of the same namespace and source is refused. A run that is killed (timeout, abort, out of memory) cannot release its lease, so a restart on the same namespace is refused until 15 minutes after that run's last heartbeat (the refused run still pays the start event); a new namespace would start from an empty memory and deliver, and bill, everything again. To restart a source from scratch, delete its `state.<namespace>.<source>` and `journal.<namespace>.<source>` records.

## Output

Every dataset row carries `engine`, `source`, `record_id`, `delta_status`, `is_new`, `is_watchlist_match`, `matched_watchlist_keyword` and `scraped_at`, plus the fields of the source. A `RUN_SUMMARY` record in the key-value store lists per-source counts, warnings (for example one sub-source being down) and watchlist accounting.

A run ends `FAILED` when preflight finds a problem (an unknown or held source, a missing credential, an invalid option) before any request, or when every selected source failed and nothing was delivered. If at least one source answered, the run succeeds and the per-source errors stay on `RUN_SUMMARY`: check it in automated pipelines.

## Watchlist

`watchlistNames` is a list of keywords matched case-insensitively as substrings against each record's names. Entries shorter than three characters (letters or digits, not counting punctuation), blank or punctuation-only entries are ignored; with no valid keyword nothing matches. A matching record is flagged `is_watchlist_match` and billed a **Watchlist hit** event on top of its row event. Two hard ceilings apply per run: `maxWatchlistHitsPerRun` (default 200) and `maxWatchlistSpendUsd` (default 50). Use broad keywords with care.

## Pricing

This Actor uses pay-per-event pricing. The **Pricing** tab shows the current price of every event; prices are deliberately not repeated on this page so that it cannot go out of date.

* **Actor start**: charged per GB of memory the run is configured with. This Actor uses 2 GB, so each run starts two start events.
* **One row event per delivered record**, named by source: Sanctioned vessel record (`ofac`); World Bank sanction record (`world_bank_debarred`, the "Other Sanctions" table only); New modern slavery statement and Updated modern slavery statement (`uk_modern_slavery`); New SEC enforcement release and Updated SEC enforcement release (`sec_enforcement`); AI crawler permission snapshot (a domain delivered for the first time) and AI crawler signal change (`ai_crawler_signals`); Drug safety record (`fda_ema_recalls`).
* **Watchlist hit**: see above.

With `deltaMode: "all"` every delivered record is billed, unchanged ones at the source's "Updated" event (or its only row event). Records that are not delivered are not billed a row event.

### Control your spend

* The first run of a source delivers up to `maxItemsPerSource` records (default 500, range 1 to 10,000) and bills each one. For a trial, set a low value such as 20.
* Use Apify's maximum-cost-per-run setting as an additional ceiling. When the limit is reached the run stops cleanly and `RUN_SUMMARY` says so (`stoppedOnChargeLimit`). The platform refuses a limit below the start event plus the most expensive single event of the Actor and names the minimum in its error.
* Keep `deltaMode` at `onlyChanged` for scheduled runs.

## Reliability notes

Delivery is at-least-once: a progress checkpoint is written every 25 rows and a small journal after every row that was delivered and billed, so after a hard kill at most the one record in flight can be delivered and billed again. A memory record that exists but cannot be read fails its own source instead of being treated as empty.

## Credentials

Only `fdaApiKey` (optional openFDA key) is accepted. It is stored encrypted by Apify and never logged.

## Data sources and licences

Records are published by the US Treasury (OFAC), the World Bank, the UK Government (Modern Slavery Statement Registry, Open Government Licence v3.0), the US SEC, the US FDA (openFDA) and the European Medicines Agency; the AI-crawler source reads files that the domain owners you name publish themselves. Reuse terms are those of each publisher: check them for your use case.

## Disclaimer

This Actor reads public sources and reports what they publish, when they publish it. It is not a screening or legal service and gives no compliance advice. Sources can change, lag or be incomplete; confirm anything you act on with the publisher.

## Support

Questions and bug reports: the **Issues** tab of this Actor (https://apify.com/stefano_seggio/global-regtech-compliance-feed/issues/open).
