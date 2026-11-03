/**
 * euTed.ts - EU TED (Tenders Electronic Daily) procurement-notice connector.
 *
 * Absorbs `eu-ted-procurement-delta-monitor` (src/tedClient.ts, the `fields` / normalisation half of
 * src/deltaEngine.ts and the field list of src/routes.ts). NOT ported, because the router owns them:
 * the delta engine's classify()/shouldDeliver(), state.ts, the BACKFILL/INCREMENTAL/VALIDATE_QUERY
 * operation modes, the webhook notifier, Actor.pushData and every charge.
 *
 * WHAT THIS CONNECTOR DOES
 * ------------------------
 * One anonymous `POST https://api.ted.europa.eu/v3/notices/search` per page (TED's own "expert search"
 * query in `expertQuery`), `paginationMode: PAGE_NUMBER`, until `maxItemsPerSource` notices are collected
 * or the result set is exhausted. There is nothing to bring your own key for.
 *
 * KNOWN LIMITATION (inherited from the legacy INCREMENTAL mode, deliberately kept)
 * --------------------------------------------------------------------------------
 * TED documents that PAGE_NUMBER mode is stateless and gives NO consistency guarantee between pages: if an
 * Official Journal S release lands mid-walk a notice can be missed or returned twice. A duplicate is
 * collapsed here (by notice-identifier) and by the router; a miss is picked up by the next scheduled run
 * because every run re-walks the query from page 1. TED caps PAGE_NUMBER mode at 15,000 retrievable
 * notices per query, which is above the engine's 10,000 `maxItemsPerSource` ceiling.
 *
 * COMPLIANCE
 * ----------
 * The legacy actor's AGENTS.md section 0 records that TED exposes an official, public, no-auth REST API
 * and that building an anti-bot layer against it would be wrong. This port follows that: plain
 * `ctx.http` (honest User-Agent, bounded retries from lib/http.ts), no session pooling, no TLS
 * impersonation.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Legacy (2026-09-16..19): endpoint, anonymity and field shapes read from TED's live OpenAPI spec
 * (https://api.ted.europa.eu/api-v3.yaml) and live-tested; the i18n `notice-title` shape quirk
 * ({lang: string}, not {lang: string[]}) and the repeated-CPV / multi-lot-value behaviour were found by
 * live calls, not assumed.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy, no credentials,
 * default User-Agent of curl):
 *   POST https://api.ted.europa.eu/v3/notices/search
 *     body {"query":"publication-date >= today(-3) AND classification-cpv = 72*","fields":[...21 ids...],
 *           "page":1,"limit":60,"scope":"ALL","paginationMode":"PAGE_NUMBER","onlyLatestVersions":false}
 *     -> HTTP 200, envelope keys exactly [notices, totalNoticeCount, iterationNextToken, timedOut]
 *        (totalNoticeCount 689 (number), timedOut false, iterationNextToken null in PAGE_NUMBER mode).
 *   Field shapes seen live and handled by firstString()/stringArray():
 *     notice-identifier          plain string, a UUID ("52d740c8-2435-4714-acc3-6bca47d46400"); note the
 *                                legacy unit tests used a "24-599727-2026" style id - both are strings.
 *     publication-number         plain string ("718666-2026")
 *     publication-date           plain string with offset ("2026-10-19+02:00"), kept verbatim like the legacy
 *     buyer-name, organisation-name-buyer   i18n map with lower-case ISO 639-2 keys and string[] values
 *                                ({"pol": ["Miejskie ..."]}); there was no "eng" key for non-English buyers
 *     notice-title               i18n map with string values ({"hun": "...", "lav": "..."}) - the flat shape
 *     classification-cpv         string[] with REPEATED codes (one per lot)
 *     estimated-value-lot        string[] one per lot; estimated-value-cur-lot may be SHORTER than the value
 *                                list (["77952","97440"] with ["EUR"]), so only the first pair is meaningful
 *     result-value-notice        plain string ("3012300"); result-value-lot was absent on those notices
 *     winner-identifier / winner-country / winner-size   string[]
 *     procedure-type, notice-type   plain strings ("open", "cn-standard", "can-standard", ...)
 *     legal-basis                string[] (["32014L0024"])
 *     links                      {xml, pdf, pdfs, html, htmlDirect} each keyed by upper-case language code;
 *                                htmlDirect.ENG is present (https://ted.europa.eu/en/notice/<pub-no>/html)
 *   Identity: two pages of 250 notices (500 rows, scope ALL, onlyLatestVersions=false) for the default
 *   rolling query had 500 distinct notice-identifier values and no repeated publication-number, which is
 *   the evidence for using notice-identifier as the stable record id.
 *   publication / deadline values also arrive as a Z-suffixed date ("2026-11-09Z"); like the "+02:00" form they are kept
 *   verbatim, as the legacy did.
 *   End to end: this connector, driven through lib/http.ts createHttpClient (Node fetch, honest User-Agent) against the
 *   live API with the default query and `limit: 20`, returned 25 distinct notices over 2 pages (TED reporting 2,524
 *   matching).
 *   `notice-type` and `legal-basis` are accepted by the legacy input schema but its normaliser never read
 *   them; they are surfaced here (`notice_type`, `legal_basis`, null unless selected in `fields`) because
 *   they are the field that tells a contract notice from an award notice.
 * ============================================================================
 *
 * OVERLAP NOTE: `emerging-market-sovereign-debt-auction-monitor` (Brazil Tesouro bond auctions) does not
 * overlap this source.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const TED_SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';
export const TED_WEBSITE_BASE = 'https://ted.europa.eu';

/** TED's own cap on retrievable notices per query in PAGE_NUMBER mode (live API docs, quoted in the legacy AGENTS.md). */
export const TED_PAGINATION_LIMIT = 15_000;
/** Runaway guard: a tiny `limit` with a huge `maxItemsPerSource` must not become thousands of POSTs. */
export const TED_MAX_PAGES_PER_RUN = 400;
const REQUEST_TIMEOUT_MS = 60_000;

/** Legacy default: a self-refreshing rolling 14-day window of IT/computer-services (CPV 72*) notices. `today(-N)` is evaluated by TED. */
export const DEFAULT_EXPERT_QUERY = 'publication-date >= today(-14) AND classification-cpv = 72*';

/** The legacy input schema's selectable field ids (TED eForms field ids). */
export const TED_FIELD_IDS = [
    'notice-identifier',
    'publication-number',
    'publication-date',
    'notice-title',
    'notice-type',
    'buyer-name',
    'organisation-name-buyer',
    'organisation-country-buyer',
    'classification-cpv',
    'deadline-receipt-tender-date-lot',
    'procedure-type',
    'legal-basis',
    'estimated-value-lot',
    'estimated-value-cur-lot',
    'result-value-lot',
    'result-value-notice',
    'result-value-cur-notice',
    'winner-identifier',
    'winner-country',
    'winner-size',
    'links',
] as const;
export type TedFieldId = (typeof TED_FIELD_IDS)[number];

/** Legacy default selection (does not include notice-type / legal-basis). */
export const DEFAULT_FIELDS: readonly TedFieldId[] = [
    'notice-identifier',
    'publication-number',
    'publication-date',
    'notice-title',
    'buyer-name',
    'organisation-name-buyer',
    'organisation-country-buyer',
    'classification-cpv',
    'deadline-receipt-tender-date-lot',
    'procedure-type',
    'estimated-value-lot',
    'estimated-value-cur-lot',
    'result-value-lot',
    'result-value-notice',
    'result-value-cur-notice',
    'winner-identifier',
    'winner-country',
    'winner-size',
    'links',
];

export type SearchScope = 'LATEST' | 'ACTIVE' | 'ALL';

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

/** One notice as returned by the search endpoint: a flat map keyed by the requested field id. Values are untrusted until read through the accessors below. */
export type RawNotice = Record<string, unknown>;

export interface TedSearchRequest {
    query: string;
    fields: string[];
    page: number;
    limit: number;
    scope: SearchScope;
    paginationMode: 'PAGE_NUMBER';
    onlyLatestVersions: boolean;
}

export interface TedSearchResponse {
    notices: RawNotice[];
    totalNoticeCount: number;
    /** Real field confirmed in the live spec: true if TED's own search timed out server-side. */
    timedOut?: boolean | undefined;
}

const tedSearchResponseSchema = z.object({
    notices: z.array(z.record(z.unknown())),
    totalNoticeCount: z.number(),
    timedOut: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Field accessors (port of legacy firstString / stringArray / firstNumber)
// ---------------------------------------------------------------------------

/**
 * Extracts a single display string from a TED field value regardless of which real shape it arrives in:
 * a plain string, a string[] (first element), or an i18n map that is EITHER `{lang: string}` (confirmed
 * live for `notice-title`) OR `{lang: string[]}` (confirmed live for `buyer-name`). English is preferred,
 * otherwise the first language present.
 *
 * Legacy incident, kept as a regression guard: an earlier version indexed the i18n value with `[0]`
 * assuming an array, which against `{lang: "Full title"}` silently returned the first CHARACTER ("F").
 */
export function firstString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value.length > 0 ? value : null;
    if (Array.isArray(value)) {
        const first: unknown = value[0];
        return typeof first === 'string' && first.length > 0 ? first : null;
    }
    if (typeof value === 'object') {
        const map = value as Record<string, unknown>;
        const preferred = map.eng ?? Object.values(map)[0];
        // A nested object (neither a string nor an array) is not a shape TED documents; refuse rather than recurse into it.
        if (preferred === undefined || preferred === null || (typeof preferred === 'object' && !Array.isArray(preferred))) return null;
        return firstString(preferred);
    }
    return null;
}

export function stringArray(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>)
            .flat()
            .filter((item): item is string => typeof item === 'string');
    }
    return [];
}

function firstNumber(value: unknown): number | null {
    const text = firstString(value);
    if (text === null || text.trim() === '') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Extracts a real per-notice deep link from TED's own `links` field - never a guessed URL pattern. */
export function extractSourceUrl(links: unknown): string {
    if (links && typeof links === 'object') {
        const map = links as Record<string, unknown>;
        const byLang = (map.htmlDirect ?? map.html) as Record<string, unknown> | undefined;
        if (byLang && typeof byLang === 'object') {
            const preferred = byLang.ENG ?? byLang.eng ?? Object.values(byLang)[0];
            if (typeof preferred === 'string' && preferred.length > 0) return preferred;
        }
    }
    return TED_WEBSITE_BASE;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** The normalised, analyst-friendly shape extracted from a RawNotice. */
export interface NormalizedNotice {
    noticeIdentifier: string;
    publicationNumber: string | null;
    publicationDate: string | null;
    noticeTitle: string | null;
    noticeType: string | null;
    legalBasis: string[];
    buyerName: string | null;
    buyerCountry: string | null;
    cpvCodes: string[];
    submissionDeadline: string | null;
    procedureType: string | null;
    estimatedValue: number | null;
    estimatedValueCurrency: string | null;
    awardedValue: number | null;
    awardedValueCurrency: string | null;
    winnerIdentifier: string | null;
    winnerCountry: string | null;
    winnerSize: string | null;
    sourceUrl: string;
    /**
     * Full raw per-lot arrays for the fields TED reports per lot. The scalar fields above show only the
     * first lot, but a change to any OTHER lot's value must still change the fingerprint (legacy
     * `rawLotValues`). Internal to change detection; not part of the payload.
     */
    rawLotValues: { estimatedValues: string[]; estimatedValueCurrencies: string[]; submissionDeadlines: string[] };
}

export function normalizeNotice(raw: RawNotice): NormalizedNotice {
    const noticeIdentifier = firstString(raw['notice-identifier']);
    if (!noticeIdentifier) {
        throw new Error('TED notice response is missing notice-identifier - cannot track this record.');
    }
    return {
        noticeIdentifier,
        publicationNumber: firstString(raw['publication-number']),
        publicationDate: firstString(raw['publication-date']),
        noticeTitle: firstString(raw['notice-title']),
        noticeType: firstString(raw['notice-type']),
        legalBasis: stringArray(raw['legal-basis']),
        buyerName: firstString(raw['buyer-name']) ?? firstString(raw['organisation-name-buyer']),
        buyerCountry: firstString(raw['organisation-country-buyer']),
        // A multi-lot notice repeats the same CPV code once per lot (confirmed live); de-duplicate and sort so
        // lot-count noise cannot change the fingerprint.
        cpvCodes: Array.from(new Set(stringArray(raw['classification-cpv']))).sort(),
        submissionDeadline: firstString(raw['deadline-receipt-tender-date-lot']),
        procedureType: firstString(raw['procedure-type']),
        estimatedValue: firstNumber(raw['estimated-value-lot']),
        estimatedValueCurrency: firstString(raw['estimated-value-cur-lot']),
        rawLotValues: {
            estimatedValues: stringArray(raw['estimated-value-lot']),
            estimatedValueCurrencies: stringArray(raw['estimated-value-cur-lot']),
            submissionDeadlines: stringArray(raw['deadline-receipt-tender-date-lot']),
        },
        // result-value-lot is only populated for some notices; some award notices report only the
        // notice-level aggregate (result-value-notice). The more specific per-lot figure wins when present.
        awardedValue: firstNumber(raw['result-value-lot']) ?? firstNumber(raw['result-value-notice']),
        awardedValueCurrency: firstString(raw['result-value-cur-notice']),
        winnerIdentifier: firstString(raw['winner-identifier']),
        winnerCountry: firstString(raw['winner-country']),
        winnerSize: firstString(raw['winner-size']),
        sourceUrl: extractSourceUrl(raw.links),
    };
}

/**
 * Recursive key-sort canonicalisation (legacy AGENTS.md 1.2): object keys are sorted at every depth, array
 * element order is left alone. Locale-independent comparison so the hash is identical on every host.
 */
export function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, val]) => [key, canonicalize(val)] as const);
        return Object.fromEntries(entries);
    }
    return value;
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/** The buyer-escalation-relevant subset (legacy `statusRelevantFields`): procedure, deadline, award value and winner. */
export function computeStatusFingerprint(notice: NormalizedNotice): string {
    return sha256(
        JSON.stringify(
            canonicalize({
                procedureType: notice.procedureType,
                submissionDeadline: notice.submissionDeadline,
                awardedValue: notice.awardedValue,
                awardedValueCurrency: notice.awardedValueCurrency,
                winnerIdentifier: notice.winnerIdentifier,
            }),
        ),
    );
}

/**
 * Everything except the state key (`noticeIdentifier`) and `sourceUrl`. The legacy excluded sourceUrl because
 * TED's `links` payload can vary trivially (which language variant is listed first) without any change to the
 * notice's content, which would be a falsely billed delta.
 */
export function computeContentFingerprint(notice: NormalizedNotice): string {
    const { noticeIdentifier: _id, sourceUrl: _url, ...rest } = notice;
    return sha256(JSON.stringify(canonicalize(rest)));
}

/**
 * Dataset row in the legacy OutputRecord vocabulary. Dropped because they are delta-engine outputs the
 * router now owns: `event_id`, `event_type`, `changed_fields`, `record_id`, `is_new`, `scraped_at`.
 */
export function toPayload(notice: NormalizedNotice): Record<string, unknown> {
    return {
        '@type': 'schema:GovernmentPermit',
        notice_identifier: notice.noticeIdentifier,
        publication_number: notice.publicationNumber,
        publication_date: notice.publicationDate,
        notice_title: notice.noticeTitle,
        notice_type: notice.noticeType,
        legal_basis: notice.legalBasis,
        buyer_name: notice.buyerName,
        buyer_country: notice.buyerCountry,
        cpv_codes: notice.cpvCodes,
        submission_deadline: notice.submissionDeadline,
        procedure_type: notice.procedureType,
        estimated_value: notice.estimatedValue,
        estimated_value_currency: notice.estimatedValueCurrency,
        awarded_value: notice.awardedValue,
        awarded_value_currency: notice.awardedValueCurrency,
        winner_identifier: notice.winnerIdentifier,
        winner_country: notice.winnerCountry,
        winner_size: notice.winnerSize,
        status_fingerprint: computeStatusFingerprint(notice),
        content_fingerprint: computeContentFingerprint(notice),
        source_url: notice.sourceUrl,
    };
}

/** Buyer / contracting authority plus title, space-joined, for the engine watchlist. */
export function watchTextOf(notice: NormalizedNotice): string {
    return [notice.buyerName, notice.noticeTitle].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' ');
}

export function toSourceRecord(raw: RawNotice): SourceRecord {
    const notice = normalizeNotice(raw);
    return {
        recordId: notice.noticeIdentifier,
        // The content fingerprint changes iff a field of the payload (other than the link) changed.
        fingerprint: fingerprintOf([computeContentFingerprint(notice)]),
        payload: toPayload(notice),
        watchText: watchTextOf(notice),
    };
}

// ---------------------------------------------------------------------------
// Request building and error classification
// ---------------------------------------------------------------------------

/**
 * The `fields` array sent to TED. TED rejects an empty array with a 400 and normalisation hard-requires
 * `notice-identifier`, so an empty selection falls back to the defaults and the identifier is always added
 * (legacy `resolveFields`, found by adversarial review and confirmed live).
 */
export function resolveFields(selected: readonly string[] | undefined): string[] {
    const base = selected && selected.length > 0 ? selected : DEFAULT_FIELDS;
    return Array.from(new Set([...base, 'notice-identifier']));
}

export function buildSearchRequest(
    options: Pick<EuTedOptions, 'expertQuery' | 'scope' | 'onlyLatestVersions'>,
    fields: string[],
    page: number,
    limit: number,
): TedSearchRequest {
    return {
        query: options.expertQuery,
        fields,
        page,
        limit,
        scope: options.scope,
        paginationMode: 'PAGE_NUMBER',
        onlyLatestVersions: options.onlyLatestVersions,
    };
}

/**
 * TED's real 400 body, confirmed by the legacy live tests, is `{ message, error: [{ objectName, field, message }] }`:
 * a summary plus a field-level detail array. Both are surfaced so a caller sees which constraint failed.
 */
export function extractErrorMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const record = body as Record<string, unknown>;
    const summary = typeof record.message === 'string' ? record.message : null;
    if (Array.isArray(record.error)) {
        const details = record.error
            .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .map((entry) => `${typeof entry.field === 'string' ? `${entry.field}: ` : ''}${typeof entry.message === 'string' ? entry.message : JSON.stringify(entry)}`)
            .join('; ');
        if (details) return summary ? `${summary} (${details})` : details;
    }
    if (summary) return summary;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.error === 'string') return record.error;
    return null;
}

/** Maps a failed request onto the legacy outage-vs-defect classes so an operator can tell "bad query" from "TED is down". */
export function describeTedFailure(error: unknown): string {
    if (error instanceof HttpStatusError) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(error.bodyPreview);
        } catch {
            parsed = undefined;
        }
        const detail = extractErrorMessage(parsed) ?? error.bodyPreview;
        if (error.status === 429) return `RATE_LIMITED: TED Search API returned 429 after retries.`;
        if (error.status === 400) {
            return `QUERY_ERROR: TED rejected the request (HTTP 400) - most likely an invalid expertQuery.${detail ? ` ${detail}` : ''}`;
        }
        if (error.status >= 500) return `UPSTREAM_OUTAGE: TED Search API returned HTTP ${error.status} after retries.`;
        return `QUERY_ERROR: TED Search API returned an unexpected HTTP ${error.status}.${detail ? ` ${detail}` : ''}`;
    }
    return `UPSTREAM_OUTAGE: network-level failure reaching api.ted.europa.eu: ${error instanceof Error ? error.message : String(error)}`;
}

async function searchPage(ctx: ConnectorContext, request: TedSearchRequest): Promise<TedSearchResponse> {
    let body: unknown;
    try {
        body = await ctx.http.getJson<unknown>(TED_SEARCH_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(request),
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
    } catch (error) {
        throw new SourceFetchError(`TED search page ${request.page} failed - ${describeTedFailure(error)}`, 'eu_ted');
    }
    const parsed = tedSearchResponseSchema.safeParse(body);
    if (!parsed.success) {
        throw new SourceFetchError(
            `TED search page ${request.page} returned an unexpected body (expected {notices[], totalNoticeCount}): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
            'eu_ted',
        );
    }
    return parsed.data;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const euTedOptionsSchema = z
    .object({
        /** TED's own "expert search" query string (same syntax as ted.europa.eu Expert Search). `today(-N)` is evaluated server-side. */
        expertQuery: z.string().trim().min(1).max(5000).default(DEFAULT_EXPERT_QUERY),
        /** TED eForms field ids to retrieve. Empty / absent = legacy defaults; `notice-identifier` is always added. */
        fields: z.array(z.enum(TED_FIELD_IDS)).optional(),
        /** LATEST = current OJ S release, ACTIVE = still-open notices, ALL = every matching notice. */
        scope: z.enum(['LATEST', 'ACTIVE', 'ALL']).default('ALL'),
        /** true collapses corrigenda to the latest version; false returns every published version as its own entry. */
        onlyLatestVersions: z.boolean().default(false),
        /** Notices per API page (TED hard cap 250; page size x field count must stay under 10,000). */
        limit: z.number().int().min(1).max(250).default(50),
    })
    .strict();
export type EuTedOptions = z.infer<typeof euTedOptionsSchema>;

export const euTedConnector: Connector<EuTedOptions> = {
    id: 'eu_ted',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'eu-ted-procurement-delta-monitor',
    description:
        'EU TED procurement notices (contract notices and award notices, all EU member states) via the official anonymous TED Search API, filtered by a TED expert-search query. No credentials.',
    status: 'active',
    optionsSchema: euTedOptionsSchema,

    async fetch(ctx: ConnectorContext, options: EuTedOptions, run: RunParams): Promise<SourceRecord[]> {
        const fields = resolveFields(options.fields);
        // Ask TED for no more than we can keep, but keep the page size constant across pages (page numbers depend on it).
        const pageSize = Math.min(options.limit, run.maxItemsPerSource);
        const records: SourceRecord[] = [];
        const seen = new Set<string>();
        let skipped = 0;
        let pagesFetched = 0;
        let totalMatching = 0;

        for (let page = 1; records.length < run.maxItemsPerSource; page += 1) {
            if ((page - 1) * pageSize >= TED_PAGINATION_LIMIT) {
                ctx.log.info(`[eu_ted] reached TED's pagination-mode cap of ${TED_PAGINATION_LIMIT} retrievable notices for this query; narrow expertQuery to see the rest.`);
                break;
            }
            if (pagesFetched >= TED_MAX_PAGES_PER_RUN) {
                ctx.log.warning(`[eu_ted] stopped after ${TED_MAX_PAGES_PER_RUN} pages; raise \`limit\` (max 250) to cover more notices per run.`);
                break;
            }

            const response = await searchPage(ctx, buildSearchRequest(options, fields, page, pageSize));
            pagesFetched += 1;
            totalMatching = response.totalNoticeCount;
            if (response.notices.length === 0) break;
            if (response.timedOut) {
                ctx.log.warning(
                    "[eu_ted] TED's search backend reported a server-side timeout for this page (timedOut=true): the notices returned are valid but a short page is not a reliable end-of-results signal.",
                );
            }

            for (const raw of response.notices) {
                let record: SourceRecord;
                try {
                    record = toSourceRecord(raw);
                } catch (error) {
                    skipped += 1;
                    ctx.log.warning(`[eu_ted] skipped one notice that could not be normalised: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                if (seen.has(record.recordId)) continue;
                seen.add(record.recordId);
                records.push(record);
                if (records.length >= run.maxItemsPerSource) break;
            }

            // `page * pageSize >= totalNoticeCount` is TED's own count and is reliable even when timedOut; a short page
            // only means "end" when TED did not report a timeout (legacy runIncremental reasoning).
            const exhausted = page * pageSize >= response.totalNoticeCount || (!response.timedOut && response.notices.length < pageSize);
            if (exhausted) break;
        }

        ctx.log.info(
            `[eu_ted] ${records.length} notice(s) returned from ${pagesFetched} page(s) (TED reports ${totalMatching} matching)${skipped > 0 ? `; ${skipped} skipped as un-normalisable` : ''}.`,
        );
        return records;
    },
};
