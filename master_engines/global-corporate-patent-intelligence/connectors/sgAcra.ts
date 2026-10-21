/**
 * sg_acra - Singapore ACRA corporate registry (data.gov.sg "ACRA Information on Corporate Entities").
 *
 * Absorbs the legacy actor `singapore-acra-registry-monitor`. That repository is a README-ONLY wrapper (the
 * production TypeScript - acraSource.ts, fingerprint.ts, deltaEngine.ts, deliveryFilter.ts - is closed and there is
 * no `src/`), so this port is built from the README's documented behaviour plus the live checks below, never from
 * code. What the README documents and what is kept:
 *   - source: data.gov.sg Collection 2 (27 letter shards A-Z + Others, monthly refresh, Singapore Open Data
 *     Licence), "paginated REST reads (limit=1,000, live-verified ceiling)", `source_url`
 *     https://data.gov.sg/collections/2/view;
 *   - input vocabulary: `shardSelection` (default ["A"]), `ssicCodeFilter` (prefixes), `entityStatusFilter`;
 *   - output vocabulary: @type, uen, entity_name, entity_type_description, entity_status_description,
 *     registration_incorporation_date, uen_issue_date, registered_address, primary/secondary ssic code +
 *     description, no_of_officers (a string), former_entity_names[], audit_firm_names[], status_fingerprint,
 *     content_fingerprint, shard, source_url; the literal source value "na" normalised to null.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION (2026-10-21, curl through the sandbox egress proxy)
 * ============================================================================
 * WHICH data.gov.sg API IS LIVE
 *   - LIVE, USED: `GET https://data.gov.sg/api/action/datastore_search?resource_id=<d_...>` (CKAN-style action
 *     API) -> 200 application/json {success:true, result:{resource_id, fields[], records[], _links, total, limit}}.
 *   - LIVE, METADATA ONLY: the v2 API `GET https://api-production.data.gov.sg/v2/public/api/collections/2/metadata`
 *     -> 200 {"data":{"collectionMetadata":{name:"ACRA Information on Corporate Entities", frequency:"monthly",
 *     lastUpdatedAt:"2026-10-14T17:21:16+08:00", childDatasets:[27 ids]}}} and
 *     `.../v2/public/api/datasets/<id>/metadata` -> 200 with `name` "ACRA Information on Corporate Entities ('W')".
 *     v2 has NO row-listing route (`/datasets/<id>/rows` is 404 on api-production and api-open); its bulk path,
 *     `api-open.data.gov.sg/v1/public/api/datasets/<id>/poll-download`, returns a signed S3 CSV URL (a file
 *     download of up to ~76 MB, not consumable through ctx.http). The v2 metadata was used once, to build the
 *     shard -> dataset table below; it is not called at run time.
 *   - NOT USED: `https://data.gov.sg/api/action/package_show` answered the sandbox with a Cloudflare 403
 *     "Attention Required" page. Nothing here tries to get around that; if the datastore route ever answers like
 *     that the run fails with the HTTP status in the SourceFetchError (no CAPTCHA solving, no WAF bypass).
 * DATASTORE BEHAVIOUR
 *   - `limit=1000` -> 200 (1.5 MB); `limit=1001` also 200; `limit=5000` / `10000` -> HTTP 413 "Size of row data
 *     too large" - so 1000 is the page size (the README's "live-verified ceiling"). Deep `offset` works
 *     (57000 of 58,040 in shard W). `result.total` is the row count of the (filtered) query.
 *   - `sort=registration_incorporation_date desc, uen asc` works; shard W's newest registration date was
 *     2026-09-30 (its dataset was last updated 2026-10-14), so a capped run sees the newest incorporations
 *     first. The `uen` tie-breaker keeps offset paging deterministic (many rows share a date).
 *   - `q={"entity_name":"WEE BROTHERS"}` (per-column JSON) is a case-insensitive TOKEN match (6 entities, including
 *     "WEE LIM BROTHERS ENTERPRISE"); with `q` every record also carries pseudo-columns `rank entity_name` and
 *     `_full_count`, which are ignored here.
 *   - `filters={"entity_status_description":["Struck Off","Live"]}` is an exact, CASE-SENSITIVE match with OR
 *     across the list ("Struck Off" 13,964 rows in W; "struck off" 0 rows).
 *   - QUIRK: `filters` is SILENTLY IGNORED whenever `q` is present. `q={"entity_name":"WEE BROTHERS"}` together
 *     with `filters={"entity_status_description":"Struck Off"}` (string, one-element list and two-element list
 *     alike) still returned all six entities - Terminated, Live Company, Cancelled, Ceased Registration - and a
 *     plain-string `q` behaved the same. The connector therefore never sends both: with entityNames the status
 *     filter is applied client-side (same exact, case-sensitive comparison), without them it is sent as `filters`.
 *   - QUIRK: an apostrophe in the `q` value (`O'Brien`) returns HTTP 200 with the body
 *     {"headers":{"Access-Control-Allow-Origin":"*","Content-Type":"application/json"}} and NO `success` key.
 *     parseDatastorePage() therefore treats ANY body without `success: true` as an upstream failure (never as
 *     "zero records"), and entity-name keywords have apostrophes turned into spaces before they are sent.
 *   - An unknown dataset id is HTTP 404 text/plain; an empty query is 200 with `total: 0`.
 * DATA
 *   - Every column is text; null is the literal "na"; dates are ISO `YYYY-MM-DD`; UENs look like 190700013E,
 *     202645117H, 53532978D, T08LL1387A. `address_type` was "LOCAL" on every row seen; queries for other values
 *     (FOREIGN, OTHERS, Foreign) returned zero rows, so the vocabulary beyond LOCAL is UNVERIFIED.
 *   - Status vocabulary seen live: "Live Company", "Live", "Struck Off", "Ceased Registration", "Cancelled",
 *     "Terminated".
 *
 * ADDRESS. The README's only address sample is `"53, MARKET STREET, Singapore 0104"` (UEN 190700013E, whose raw
 * row is block "53", street_name "MARKET STREET", postal_code "0104", every other address column "na"); that
 * case is reproduced exactly. For rows with level / unit / building the README gives no sample; this port
 * extends it as `block, street, #level-unit, building, Singapore postal` (our synthesis, documented here).
 *
 * NOT PORTED, stated plainly
 *   - `watchlistUens` + `acraBusinessProfileApiKey` (BYOK real-time refresh through ACRA's paid Business Profile
 *     API): the README names the product but gives no endpoint, no request shape and no response shape, and a
 *     key is required to test it, so it cannot be verified and is not guessed. `byok_enriched` is absent too.
 *   - `event_id`, `event_type` (NEW_LISTING / STATUS_CHANGE / UPDATED / BASELINE_SNAPSHOT / SNAPSHOT_NO_DIFF),
 *     `previous_status`, `changed_fields`: functions of the previous run, which the router owns (`delta_status`,
 *     `is_new`). `status_fingerprint` / `content_fingerprint` are kept so a consumer can still tell a status flip
 *     from another edit by comparing consecutive rows; they are 20-hex fingerprintOf() values, NOT the legacy
 *     40-hex SHA-1 (the legacy formula is closed).
 *   - `onlyNew`, `eventTypes`, `maxItems`, `deltaStateName`, `resetState`, `webhookUrl`: router / delivery concerns.
 *   - `source_dataset_last_updated`: would need the v2 metadata call per run and would change for every row each
 *     month, so it could not be fingerprinted sensibly.
 *   - The legacy "silent baseline" (a shard's first walk emits nothing paid) is a router-level delta concern; use
 *     `deltaMode: onlyNew` after a first `all` run.
 *
 * COVERAGE CAVEAT. The dataset is partitioned by the first letter of the entity name and has no change feed;
 * a shard holds up to ~240k rows (shard S: a 76 MB CSV at shard W's measured 323 bytes per row; W itself has
 * 58,040 rows). A run is capped by maxItemsPerSource and reads newest registrations first, so
 * it catches NEW entities in the selected shards. To watch specific existing entities for a status or detail
 * change, name them in `entityNames` (server-side token match) and/or `entityStatusFilter`, and select the shard(s)
 * their names start with. `entityNames` matches tokens inside the selected shards only.
 *
 * KEYWORD GUARD. `entityNames`, `entityStatusFilter` and `ssicCodeFilter` are read through sanitizeKeywordList()
 * inside fetch(). A blank / one-character entry is dropped; an empty result means "no such filter" - never
 * `startsWith('')` (matches every SSIC code) and never `filters: {status: ['']}` (matches nothing).
 */
import { z } from 'zod';

import { describeSanitization, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const SG_ACRA_SOURCE_ID = 'sg_acra';

export const DATA_GOV_SG_DATASTORE_URL = 'https://data.gov.sg/api/action/datastore_search';
export const ACRA_COLLECTION_VIEW_URL = 'https://data.gov.sg/collections/2/view';

/** Verified live: 1000 rows per request is accepted; 5000 is HTTP 413. */
export const ACRA_PAGE_LIMIT = 1000;
export const ACRA_DEFAULT_MAX_PAGES = 10;
export const ACRA_MAX_PAGES = 200;
/** Cap on (shard x entityName) query series per run. */
export const ACRA_MAX_QUERIES = 60;

export const ACRA_SHARDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Others'] as const;
export type AcraShard = (typeof ACRA_SHARDS)[number];

/**
 * Shard -> data.gov.sg dataset id, read from `GET /v2/public/api/datasets/<id>/metadata` (each `name` is
 * "ACRA Information on Corporate Entities ('<shard>')") for the 27 `childDatasets` of collection 2 on 2026-10-21.
 */
export const ACRA_SHARD_DATASETS: Readonly<Record<AcraShard, string>> = {
    A: 'd_8575e84912df3c28995b8e6e0e05205a',
    B: 'd_3a3807c023c61ddfba947dc069eb53f2',
    C: 'd_c0650f23e94c42e7a20921f4c5b75c24',
    D: 'd_acbc938ec77af18f94cecc4a7c9ec720',
    E: 'd_124a9bd407c7a25f8335b93b86e50fdd',
    F: 'd_4526d47d6714d3b052eed4a30b8b1ed6',
    G: 'd_b58303c68e9cf0d2ae93b73ffdbfbfa1',
    H: 'd_fa2ed456cf2b8597bb7e064b08fc3c7c',
    I: 'd_85518d970b8178975850457f60f1e738',
    J: 'd_478f45a9c541cbe679ca55d1cd2b970b',
    K: 'd_5573b0db0575db32190a2ad27919a7aa',
    L: 'd_a2141adf93ec2a3c2ec2837b78d6d46e',
    M: 'd_9af9317c646a1c881bb5591c91817cc6',
    N: 'd_67e99e6eabc4aad9b5d48663b579746a',
    O: 'd_5c4ef48b025fdfbc80056401f06e3df9',
    P: 'd_181005ca270b45408b4cdfc954980ca2',
    Q: 'd_4130f1d9d365d9f1633536e959f62bb7',
    R: 'd_2b8c54b2a490d2fa36b925289e5d9572',
    S: 'd_df7d2d661c0c11a7c367c9ee4bf896c1',
    T: 'd_72f37e5c5d192951ddc5513c2b134482',
    U: 'd_0cc5f52a1f298b916f317800251057f3',
    V: 'd_e97e8e7fc55b85a38babf66b0fa46b73',
    W: 'd_af2042c77ffaf0db5d75561ce9ef5688',
    X: 'd_1cd970d8351b42be4a308d628a6dd9d3',
    Y: 'd_31af23fdb79119ed185c256f03cb5773',
    Z: 'd_4e3db8955fdcda6f9944097bef3d2724',
    Others: 'd_300ddc8da4e8f7bdc1bfc62d0d99e2e7',
};

const SORT_NEWEST_FIRST = 'registration_incorporation_date desc, uen asc';
const LOG_PREFIX = `[${SG_ACRA_SOURCE_ID}]`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const nullToUndefined = (value: unknown): unknown => (value === null ? undefined : value);

/** `w` -> `W`, `others` -> `Others`; anything else is left for the enum to reject with a precise message. */
export function normaliseShard(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === 'others') return 'Others';
    return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
}

export const sgAcraOptionsSchema = z
    .object({
        /** Legacy `shardSelection`: which first-letter shards to read (default shard A, as in the legacy README). */
        shardSelection: z
            .array(z.preprocess(normaliseShard, z.enum(ACRA_SHARDS)))
            .min(1, 'Select at least one shard (A-Z or Others).')
            .default(['A'])
            .transform((values) => [...new Set(values)]),
        /** Entity-name keywords (list or one separated string): server-side token match inside the selected shards. */
        entityNames: z.unknown().optional(),
        /** Legacy `entityStatusFilter`: exact, case-sensitive ACRA status strings, matched server-side. */
        entityStatusFilter: z.unknown().optional(),
        /** Legacy `ssicCodeFilter`: SSIC code prefixes (2-5 digits) matched against the primary OR secondary code, client-side. */
        ssicCodeFilter: z.unknown().optional(),
        /** Hard cap on 1000-row pages scanned per (shard, name) query; only binds when ssicCodeFilter discards rows. */
        maxPages: z.preprocess(nullToUndefined, z.number().int().min(1).max(ACRA_MAX_PAGES).default(ACRA_DEFAULT_MAX_PAGES)),
    })
    .strict();
export type SgAcraOptions = z.output<typeof sgAcraOptionsSchema>;
// No credential is required: the BYOK ACRA Business Profile tier of the legacy actor is not ported (see header).

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Source null: the literal "na" (any case), blank, or a non-text value. */
export function naToNull(value: unknown): string | null {
    const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
    if (text === null) return null;
    const trimmed = text.replace(/\s+/gu, ' ').trim();
    return trimmed === '' || trimmed.toLowerCase() === 'na' ? null : trimmed;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function nextShare(remaining: number, partsLeft: number): number {
    return Math.min(remaining, Math.max(1, Math.floor(remaining / Math.max(1, partsLeft))));
}

function numbered(row: Record<string, unknown>, prefix: string, count: number): string[] {
    const values: string[] = [];
    for (let index = 1; index <= count; index += 1) {
        const value = naToNull(row[`${prefix}${index}`]);
        if (value !== null && !values.includes(value)) values.push(value);
    }
    return values;
}

/** README sample `53, MARKET STREET, Singapore 0104`; level / unit / building extend it (see header). */
export function buildRegisteredAddress(row: Record<string, unknown>): string | null {
    const level = naToNull(row.level_no);
    const unit = naToNull(row.unit_no);
    const unitPart = level !== null && unit !== null ? `#${level}-${unit}` : level !== null ? `#${level}` : unit !== null ? `#${unit}` : null;
    const postal = naToNull(row.postal_code);
    const addressType = naToNull(row.address_type);
    const isLocal = addressType === null || addressType.toUpperCase() === 'LOCAL';
    const parts = [
        naToNull(row.block),
        naToNull(row.street_name),
        unitPart,
        naToNull(row.building_name),
        naToNull(row.other_address_line1),
        naToNull(row.other_address_line2),
        postal === null ? null : isLocal ? `Singapore ${postal}` : postal,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
}

export interface DatastorePage {
    rows: Array<Record<string, unknown>>;
    /** `result.total` of the (filtered) query, when numeric. */
    total: number | null;
}

/**
 * Parses one `datastore_search` body. A body without `success: true` is an UPSTREAM FAILURE, not an empty page:
 * the gateway quirk documented in the header answers HTTP 200 with `{"headers":{...}}` and would otherwise look
 * like "zero records".
 */
export function parseDatastorePage(body: unknown): DatastorePage {
    if (!isRecord(body) || body.success !== true) {
        const detail = isRecord(body) && isRecord(body.error) ? ` (${JSON.stringify(body.error).slice(0, 200)})` : '';
        const preview = isRecord(body) ? JSON.stringify(body).slice(0, 120) : String(body).slice(0, 120);
        throw new Error(`unexpected data.gov.sg datastore response: no "success: true"${detail}; body starts ${preview}`);
    }
    const result = body.result;
    if (!isRecord(result) || !Array.isArray(result.records)) {
        throw new Error('unexpected data.gov.sg datastore response: no "result.records" array');
    }
    const rows = result.records.filter(isRecord);
    const total = typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : null;
    return { rows, total };
}

/** Row -> record, or null when the row has no UEN (it cannot be identified, so it cannot be tracked). */
export function normalizeAcraRow(row: Record<string, unknown>, shard: AcraShard): SourceRecord | null {
    const uen = naToNull(row.uen)?.toUpperCase() ?? null;
    if (uen === null) return null;

    const entityName = naToNull(row.entity_name);
    const entityType = naToNull(row.entity_type_description);
    const status = naToNull(row.entity_status_description);
    const registrationDate = naToNull(row.registration_incorporation_date);
    const uenIssueDate = naToNull(row.uen_issue_date);
    const address = buildRegisteredAddress(row);
    const primarySsicCode = naToNull(row.primary_ssic_code);
    const primarySsicDescription = naToNull(row.primary_ssic_description);
    const secondarySsicCode = naToNull(row.secondary_ssic_code);
    const secondarySsicDescription = naToNull(row.secondary_ssic_description);
    const officers = naToNull(row.no_of_officers);
    const formerNames = numbered(row, 'former_entity_name', 15);
    const auditFirms = numbered(row, 'name_of_audit_firm', 5);

    const statusFingerprint = fingerprintOf([uen, status]);
    const contentFingerprint = fingerprintOf([
        entityName,
        entityType,
        registrationDate,
        uenIssueDate,
        address,
        primarySsicCode,
        primarySsicDescription,
        secondarySsicCode,
        secondarySsicDescription,
        officers,
        formerNames,
        auditFirms,
    ]);

    return {
        recordId: uen,
        // Status and content are separate legacy concerns; the record fingerprint changes iff either does.
        fingerprint: fingerprintOf([statusFingerprint, contentFingerprint]),
        watchText: [...new Set([entityName, ...formerNames].filter((n): n is string => n !== null))].join(' | '),
        payload: {
            '@type': 'schema:Organization',
            uen,
            entity_name: entityName,
            entity_type_description: entityType,
            entity_status_description: status,
            registration_incorporation_date: registrationDate,
            uen_issue_date: uenIssueDate,
            registered_address: address,
            primary_ssic_code: primarySsicCode,
            primary_ssic_description: primarySsicDescription,
            secondary_ssic_code: secondarySsicCode,
            secondary_ssic_description: secondarySsicDescription,
            no_of_officers: officers,
            former_entity_names: formerNames,
            audit_firm_names: auditFirms,
            status_fingerprint: statusFingerprint,
            content_fingerprint: contentFingerprint,
            shard,
            source_url: ACRA_COLLECTION_VIEW_URL,
        },
    };
}

/** True when the primary OR secondary SSIC code starts with one of `prefixes`; an empty list never reaches here. */
export function matchesSsicPrefix(row: Record<string, unknown>, prefixes: readonly string[]): boolean {
    const codes = [naToNull(row.primary_ssic_code), naToNull(row.secondary_ssic_code)].filter((c): c is string => c !== null);
    return codes.some((code) => prefixes.some((prefix) => prefix.length > 0 && code.startsWith(prefix)));
}

export interface AcraUrlParams {
    datasetId: string;
    limit: number;
    offset: number;
    /** Already guard-sanitised entity-name keyword. */
    entityName?: string | undefined;
    /** Already guard-sanitised exact status strings. Never sent together with `entityName` (see header: `filters` is ignored beside `q`). */
    statuses?: readonly string[] | undefined;
}

/** Apostrophes (and typographic ones) break the gateway (see header); as token separators they lose nothing. */
export function cleanEntityNameForQuery(name: string): string {
    return name.replace(/['‘’ʼ`]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function buildAcraUrl(params: AcraUrlParams): string {
    const query: Array<readonly [string, string]> = [
        ['resource_id', params.datasetId],
        ['limit', String(params.limit)],
    ];
    if (params.offset > 0) query.push(['offset', String(params.offset)]);
    query.push(['sort', SORT_NEWEST_FIRST]);
    if (params.entityName) {
        query.push(['q', JSON.stringify({ entity_name: params.entityName })]);
    } else if (params.statuses && params.statuses.length > 0) {
        query.push(['filters', JSON.stringify({ entity_status_description: params.statuses })]);
    }
    return `${DATA_GOV_SG_DATASTORE_URL}?${query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

// ---------------------------------------------------------------------------
// Keyword guard wiring
// ---------------------------------------------------------------------------

function resolveList(ctx: ConnectorContext, field: string, input: unknown): string[] {
    const list = sanitizeKeywordList(input);
    if (list.keywords.length > 0) {
        ctx.log.info(`${LOG_PREFIX} ${describeSanitization(list, field)}`);
    } else if (input !== undefined && input !== null) {
        ctx.log.warning(`${LOG_PREFIX} ${describeSanitization(list, field)} No valid keyword remained, so NO ${field} filtering is applied.`);
    }
    return list.keywords;
}

/** SSIC prefixes: guard first (blank / one-character entries gone), then digits only, 2-5 long. */
export function resolveSsicPrefixes(ctx: ConnectorContext, input: unknown): string[] {
    const keywords = resolveList(ctx, 'ssicCodeFilter', input);
    const prefixes = keywords.filter((keyword) => /^\d{2,5}$/u.test(keyword));
    if (prefixes.length < keywords.length) {
        ctx.log.warning(`${LOG_PREFIX} ssicCodeFilter: ${keywords.length - prefixes.length} entr(y/ies) are not 2-5 digit SSIC prefixes and were dropped.`);
    }
    if (keywords.length > 0 && prefixes.length === 0) {
        ctx.log.warning(`${LOG_PREFIX} ssicCodeFilter: no valid SSIC prefix remained, so NO SSIC filtering is applied.`);
    }
    return prefixes;
}

export function resolveEntityNames(ctx: ConnectorContext, input: unknown): string[] {
    const keywords = resolveList(ctx, 'entityNames', input);
    // Re-run the guard after the apostrophe clean-up so a name that was only apostrophes cannot become a blank query.
    const cleaned = sanitizeKeywordList(keywords.map(cleanEntityNameForQuery));
    if (cleaned.keywords.length < keywords.length) {
        ctx.log.warning(`${LOG_PREFIX} entityNames: ${keywords.length - cleaned.keywords.length} keyword(s) were empty or duplicated after apostrophe removal and were dropped.`);
    }
    return cleaned.keywords;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface AcraFetchParams {
    shard: AcraShard;
    maxItems: number;
    maxPages: number;
    entityName?: string | undefined;
    statuses?: readonly string[] | undefined;
    ssicPrefixes?: readonly string[] | undefined;
    /** Test hook; production uses {@link ACRA_PAGE_LIMIT}. */
    pageLimit?: number;
}

/** Newest-registration-first walk of ONE shard (optionally narrowed server-side), capped at `maxItems` matching rows. */
export async function fetchAcraRows(ctx: ConnectorContext, params: AcraFetchParams): Promise<Array<Record<string, unknown>>> {
    const datasetId = ACRA_SHARD_DATASETS[params.shard];
    const pageLimit = params.pageLimit ?? ACRA_PAGE_LIMIT;
    const prefixes = params.ssicPrefixes ?? [];
    const statuses = params.statuses ?? [];
    // `filters` is ignored beside `q` (header), so with an entity name the status filter must run client-side.
    const clientStatuses = params.entityName ? statuses : [];
    const filtersClientSide = prefixes.length > 0 || clientStatuses.length > 0;
    const matched: Array<Record<string, unknown>> = [];
    let offset = 0;
    let pages = 0;

    while (matched.length < params.maxItems && pages < params.maxPages) {
        // With a client-side filter most rows may be discarded, so read full pages; otherwise ask for exactly what is left.
        const limit = filtersClientSide ? pageLimit : Math.min(pageLimit, params.maxItems - matched.length);
        const body = await ctx.http.getJson<unknown>(
            buildAcraUrl({ datasetId, limit, offset, entityName: params.entityName, statuses: params.statuses }),
            { maxBytes: 20 * 1024 * 1024 },
        );
        const page = parseDatastorePage(body);
        pages += 1;
        for (const row of page.rows) {
            if (matched.length >= params.maxItems) break;
            if (clientStatuses.length > 0 && !clientStatuses.includes(naToNull(row.entity_status_description) ?? '')) continue;
            if (prefixes.length > 0 && !matchesSsicPrefix(row, prefixes)) continue;
            matched.push(row);
        }
        offset += page.rows.length;
        if (page.rows.length === 0 || page.rows.length < limit || (page.total !== null && offset >= page.total)) break;
    }
    return matched;
}

interface QuerySeries {
    shard: AcraShard;
    entityName: string | undefined;
}

export const sgAcraConnector: Connector<SgAcraOptions> = {
    id: SG_ACRA_SOURCE_ID,
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'singapore-acra-registry-monitor',
    description:
        'Singapore ACRA register of corporate entities from data.gov.sg (monthly extract, 27 first-letter shards), newest registrations first, in the legacy singapore-acra-registry-monitor vocabulary. ' +
        'Select shards with shardSelection; narrow with entityNames, entityStatusFilter, ssicCodeFilter.',
    status: 'active',
    // One shard alone holds tens to hundreds of thousands of rows; a run emits at most 10,000 of them.
    maxSeenIds: 20_000,
    optionsSchema: sgAcraOptionsSchema,

    async fetch(ctx: ConnectorContext, options: SgAcraOptions, run: RunParams): Promise<SourceRecord[]> {
        const shards = ACRA_SHARDS.filter((s) => options.shardSelection.includes(s));
        const names = resolveEntityNames(ctx, options.entityNames);
        const statuses = resolveList(ctx, 'entityStatusFilter', options.entityStatusFilter);
        const ssicPrefixes = resolveSsicPrefixes(ctx, options.ssicCodeFilter);

        const series: QuerySeries[] = shards.flatMap((shard) =>
            (names.length > 0 ? names : [undefined]).map((entityName): QuerySeries => ({ shard, entityName })),
        );
        if (series.length > ACRA_MAX_QUERIES) {
            throw new SourceFetchError(
                `${series.length} (shard x entityName) queries requested; the limit is ${ACRA_MAX_QUERIES}. Select fewer shards or entityNames.`,
                SG_ACRA_SOURCE_ID,
            );
        }
        if (names.length > 0) {
            ctx.log.info(`${LOG_PREFIX} entityNames are matched inside shard(s) ${shards.join(', ')} only.`);
        }

        const records = new Map<string, SourceRecord>();
        const failures: string[] = [];
        let attempted = 0;
        let skippedNoUen = 0;

        for (const [index, entry] of series.entries()) {
            const remaining = run.maxItemsPerSource - records.size;
            const label = `${entry.shard}${entry.entityName ? ` "${entry.entityName}"` : ''}`;
            if (remaining < 1) {
                ctx.log.info(`${LOG_PREFIX} ${label}: no share left of maxItemsPerSource=${run.maxItemsPerSource}; skipped.`);
                continue;
            }
            const maxItems = nextShare(remaining, series.length - index);
            attempted += 1;
            try {
                const rows = await fetchAcraRows(ctx, {
                    shard: entry.shard,
                    maxItems,
                    maxPages: options.maxPages,
                    entityName: entry.entityName,
                    statuses,
                    ssicPrefixes,
                });
                let added = 0;
                for (const row of rows) {
                    const record = normalizeAcraRow(row, entry.shard);
                    if (record === null) {
                        skippedNoUen += 1;
                        continue;
                    }
                    if (!records.has(record.recordId)) {
                        records.set(record.recordId, record);
                        added += 1;
                    }
                }
                ctx.log.info(`${LOG_PREFIX} ${label}: ${added} record(s).`);
            } catch (error) {
                failures.push(`${label}: ${messageOf(error)}`);
                ctx.log.warning(`${LOG_PREFIX} ${label} failed - ${messageOf(error)}`);
            }
        }
        if (skippedNoUen > 0) ctx.log.warning(`${LOG_PREFIX} ${skippedNoUen} row(s) skipped: no UEN.`);

        if (attempted > 0 && failures.length === attempted) {
            throw new SourceFetchError(`All selected shard queries failed: ${failures.join(' | ')}`, SG_ACRA_SOURCE_ID);
        }
        return [...records.values()].slice(0, run.maxItemsPerSource);
    },
};
