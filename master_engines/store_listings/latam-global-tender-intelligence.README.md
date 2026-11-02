# LatAm & Global Tender Intelligence

One Actor, eight open public-procurement sources. Pick the sources for each run and receive only the tenders, notices and grant calls that are **new or changed since your last run**, as clean JSON in the dataset.

Typical users: bid teams and consultants tracking public tenders, grant scouts, procurement analysts and sales teams that sell to governments.

## What is covered

| Source id | What it reads | Scope to know before you rely on it |
|---|---|---|
| `ar_santafe` | Province of Santa Fe (Argentina), "Gestiones de Compra": open, in-progress and concluded purchasing processes, plus the public detail page (categories, documents, deadlines, contact) | Data licence CC BY-SA 2.5 AR; the attribution is carried in each row's `data_source` field. Keep it if you redistribute the data. |
| `ar_tucuman` | Province of Tucumán (Argentina) public tenders across the upcoming-opening, in-award and awarded registers, with line items, amounts and the tender-document PDF link | Open server-rendered portal. |
| `ar_entrerios` | Province of Entre Ríos (Argentina), Unidad Central de Contrataciones: procedure, object, destination, body and status | The portal publishes **no id and no date per record**. Ids are a hash of the row text, so a silent correction of that text upstream can appear as a new record. There is no date filter. |
| `cl_diario_oficial` | Chile Diario Oficial, electronic edition: laws, decrees, resolutions and notices of **today's** edition, "normas generales" section, with issuing ministry or agency, description and the official PDF link | Only that section is read; the other six sections are held because the site's robots.txt disallows them. |
| `eu_ted` | EU TED contract and award notices (all member states) through the official anonymous TED Search API, filtered by a TED expert-search query (`expertQuery`) | TED documents that its paging gives no consistency guarantee between pages: a notice can be missed or repeated within one run. Repeats are removed; a miss is picked up by the next run. Up to 10,000 notices per run. |
| `us_florida` | State of Florida MyFloridaMarketPlace Vendor Information Portal: state-agency solicitations (ITB, RFP, ITN, RFI and others) | The portal's terms license registered vendors to download content for non-commercial use and do not address automated access. This Actor never registers or logs in and links to attachments instead of downloading them. Whether your downstream use is acceptable is your decision. |
| `world_bank_notices` | World Bank procurement notices (invitations for bids, expressions of interest, general procurement notices, award announcements) from the World Bank's procurement-notices API | ADB and IDB notices are not included. |
| `it_lombardia_grants` | Regione Lombardia regional grants and tenders register ("Anagrafica dei bandi regionali") with a derived UPCOMING / OPEN / CLOSED status | CC BY 4.0, attribution Regione Lombardia, carried in each row's `license` field. The policy-area taxonomy of the earlier Actor is not reproduced. An optional Socrata app token is accepted. |

**Not available (held):** `ar_cordoba` and `ar_pba` (their portals block non-residential, non-Argentine traffic at the network level, and this Actor does not route around network blocks), `ar_salta` and `ar_mendoza` (held by the Actor publisher's decision), `au_grantconnect` (the host answers HTTP 403 to honestly identified requests and offers no API, CSV or RSS feed for awards), `adb_procurement` (bot-challenge on every path) and `idb_procurement` (robots.txt disallows the programmatic paths). Selecting one stops the run before any request is made and before anything is billed, and the error says why.

## How to use it

1. Open the **Input** tab and choose one or more `sources`. Start with one. The form is prefilled with a small snapshot (`deltaMode: "all"`, 10 records per source) so that the first run shows data at once; for a scheduled Task set `deltaMode` to `onlyChanged` and raise `maxItemsPerSource`.
2. Run it. The first run of a source treats every record it reads as new (see "Control your spend" below).
3. Put the same input in a **Task** and attach an Apify **Schedule**. Each Task keeps its own delta memory, so later runs deliver only what changed.
4. Read the results from the dataset, the Apify API, or an Apify webhook/integration.

Example input:

```json
{
  "sources": ["ar_santafe", "us_florida"],
  "sourceOptions": {
    "us_florida": { "includeContactDetails": true }
  },
  "deltaMode": "onlyChanged",
  "maxItemsPerSource": 200,
  "watchlistNames": ["road maintenance"]
}
```

Each source validates its own slice of `sourceOptions` and rejects unknown keys, so a typo fails the run in preflight instead of being ignored.

## Delta modes

| `deltaMode` | Delivers |
|---|---|
| `onlyChanged` (default) | Records seen for the first time, and records whose content changed (for example a status change or an added document) |
| `onlyNew` | Records seen for the first time |
| `all` | Every record, unchanged ones included (tagged `delta_status: "unchanged"`) |

Delta memory is kept per `stateNamespace` (default: one per Task) in a key-value store named `latam-global-tender-intelligence-delta-state` in your account. Give two Tasks that run at the same time different namespaces: a second concurrent run of the same namespace and source is refused. To restart a source from scratch, delete its `state.<namespace>.<source>` and `journal.<namespace>.<source>` records.

## Output

Every dataset row carries `engine`, `source`, `record_id`, `delta_status`, `is_new`, `is_watchlist_match`, `matched_watchlist_keyword` and `scraped_at`, plus the fields of the source. A `RUN_SUMMARY` record in the key-value store lists per-source counts, warnings and watchlist accounting.

A run ends `FAILED` when preflight finds a problem (an unknown or held source, a missing credential, an invalid option) before any request, or when every selected source failed and nothing was delivered. If at least one source answered, the run succeeds and the per-source errors stay on `RUN_SUMMARY`: check it in automated pipelines.

## Watchlist

`watchlistNames` is a list of keywords matched case-insensitively as substrings against each record's text (buyer, object, issuing authority and similar). Entries shorter than three characters (letters or digits, not counting punctuation), blank or punctuation-only entries are ignored; with no valid keyword nothing matches. A matching record is flagged `is_watchlist_match` and billed a **Watchlist hit** event on top of its row event. Two hard ceilings apply per run: `maxWatchlistHitsPerRun` (default 200) and `maxWatchlistSpendUsd` (default 50). Use broad keywords with care.

## Pricing

This Actor uses pay-per-event pricing. The **Pricing** tab shows the current price of every event; prices are deliberately not repeated on this page so that it cannot go out of date.

* **Actor start**: charged per GB of memory the run is configured with. This Actor uses 1 GB, so each run starts one start event.
* **One row event per delivered record**, named by source: Tender record (`ar_santafe`, `ar_tucuman`, `ar_entrerios`, `cl_diario_oficial`, `us_florida`); Tender summary record (a `ar_santafe` or `us_florida` row delivered from the listing alone, without a detail page); Procurement notice (`world_bank_notices`); New EU TED notice and Updated EU TED notice (`eu_ted`); New Lombardia grant call and Updated Lombardia grant call (`it_lombardia_grants`).
* **Watchlist hit**: see above.

With `deltaMode: "all"` every delivered record is billed, unchanged ones at the source's "Updated" event (or its only row event). Records that are not delivered are not billed a row event.

### Control your spend

* The first run of a source delivers up to `maxItemsPerSource` records (default 500, range 1 to 10,000) and bills each one. The Entre Ríos portal alone lists thousands of rows; for a trial set a low value such as 20.
* Use Apify's maximum-cost-per-run setting as an additional ceiling.
* Keep `deltaMode` at `onlyChanged` for scheduled runs.

## Reliability notes

Delivery is at-least-once: a progress checkpoint is written every 25 rows and a small journal after every row that was delivered and billed, so after a hard kill at most the one record in flight can be delivered and billed again. A memory record that exists but cannot be read fails its own source instead of being treated as empty.

## Credentials

Only `socrataAppToken` (optional, for `it_lombardia_grants`) is accepted. It is stored encrypted by Apify and never logged.

## Data sources and licences

Records are published by the named public bodies. Santa Fe data is under CC BY-SA 2.5 AR and Lombardia data under CC BY 4.0 (attribution Regione Lombardia); the EU TED API, the World Bank API and the other portals are used under their publishers' own terms, which you should check for your use case. The Florida portal's terms are summarised in the table above.

## Disclaimer

This Actor reads public portals and reports what they publish. Portals change, lag and sometimes correct or withdraw notices; confirm deadlines and requirements on the official notice before you bid.

## Support

Questions and bug reports: the **Issues** tab of this Actor (https://apify.com/stefano_seggio/latam-global-tender-intelligence/issues/open).
