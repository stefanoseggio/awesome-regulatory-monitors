/**
 * itLombardiaGrants.ts - Regione Lombardia "Anagrafica dei bandi regionali" (regional grants and tenders register).
 *
 * Absorbs `regione-lombardia-grants-registry-monitor`. THAT REPO HAS NO SOURCE CODE: it is a documentation wrapper
 * (README, LICENSE, examples/ that only call the private Apify actor), and its README says the implementation
 * "is proprietary and runs privately on Apify". So there is nothing to port. This connector is implemented from the
 * README's documented behaviour AND a live check of every endpoint, column and parameter it uses (below). Anything
 * the README names that could not be verified or reconstructed is NOT implemented, and is listed here.
 *
 * IMPLEMENTED (README feature -> here)
 *   - source: Socrata SODA dataset `bukx-h2uy` on dati.lombardia.it, `$limit` / `$offset` pagination
 *   - `keyword`   -> Socrata's `$q` full-text parameter (one query per sanitised keyword, results unioned)
 *   - `directorateFilter` -> substring match on the free-text `direzione_generale`
 *   - `statusFilter` / `computed_status` -> the README's own derived lifecycle status UPCOMING / OPEN / CLOSED
 *   - `socrataAppToken` -> Socrata's `X-App-Token` header (optional; BYOK; never affects billing)
 *   - output vocabulary: codice_bando, titolo_bando, direzione_generale, ente, tipo_strumento,
 *     apertura_adesione_iso, chiusura_adesione_iso, presentato (number), computed_status, source_url, license
 *
 * NOT IMPLEMENTED, and why
 *   - `policy_area` / `policyAreaFilter`: the README describes a 14-category taxonomy "built from the observed
 *     distribution of the 46 distinct `direzione_generale` values" but does not publish the mapping, and the
 *     taxonomy is proprietary code in the private actor. Inventing a mapping would put made-up classifications in
 *     a compliance-adjacent dataset. `direzione_generale` is emitted verbatim instead, and a copied-over
 *     `policyAreaFilter` is rejected in preflight (the options schema is strict) rather than silently ignored.
 *   - the delta engine (`NEW_LISTING` / `STATUS_CHANGE` / `UPDATED`, `event_id`, `event_type`, `changed_fields`,
 *     `status_fingerprint`, `content_fingerprint`, `eventTypes`, `onlyNew`, `deltaStateName`, `resetState`,
 *     `maxItems`) is the router's job. A computed-status flip still re-emits the record because `computed_status`
 *     is part of the fingerprint.
 *   - `requestTimeoutSecs` / `maxRetries`: lib/http.ts owns timeouts and bounded retries.
 *
 * DERIVED STATUS: README "Derives UPCOMING / OPEN / CLOSED from apertura_adesione / chiusura_adesione against the
 * run's own clock". The README does not define the edge cases, so these are THIS connector's reading of them:
 *   - run clock before the opening date                     -> UPCOMING
 *   - opening date reached and closing date not yet passed  -> OPEN
 *   - closing date passed                                   -> CLOSED
 *   - both columns are Socrata `calendar_date` (date-only; every live value has a 00:00:00 time), so a date-only
 *     closing date counts for the WHOLE day: a bando closing "2026-10-21" is OPEN until 2026-10-22T00:00Z. The
 *     legacy actor may draw that boundary differently; the difference is at most one day on the closing day.
 *   - no closing date published (121 of 1,934 live rows) and the bando has opened -> `null`. Calling it OPEN would
 *     be a guess (some are standing programmes, some are stale); a row with a null status is still returned but
 *     never matches a `statusFilter`.
 *   - naive timestamps ("2026-03-21T00:00:00.000") are read as UTC, which is how the README renders them
 *     (`...Z`); the error is at most the Rome offset on a date-only value.
 *
 * COMPLIANCE
 * ----------
 * Open data under CC BY 4.0 (attribution: Regione Lombardia), carried in every row's `license` field. robots.txt
 * declares `Crawl-delay: 1` and does not disallow `/resource/`; this connector therefore waits 1 s between its own
 * consecutive requests. No credentials are required.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION (this port session, 2026-10-21, curl through the sandbox egress proxy, honest UA)
 * ============================================================================
 *   GET https://www.dati.lombardia.it/resource/bukx-h2uy.json?$limit=3
 *     -> HTTP 200 application/json;charset=utf-8, a JSON array whose rows carry exactly the README's columns
 *        {codice_bando, titolo_bando, direzione_generale, ente, apertura_adesione, chiusura_adesione,
 *         tipo_strumento, presentato}, all values JSON strings (presentato "0"), timestamps naive
 *        "2016-03-21T00:00:00.000".
 *   GET .../bukx-h2uy.json?$select=count(*)            -> [{"count":"1934"}] (the README says ~1,912).
 *   GET .../bukx-h2uy.json?$limit=5000&$order=codice_bando -> 1,934 rows: codice_bando present and UNIQUE on every
 *        row (0 duplicates, 0 nulls); direzione_generale and ente missing on 3 rows; chiusura_adesione missing on
 *        121 rows; apertura_adesione never missing; every time-of-day 00:00:00.000; presentato always digits;
 *        tipo_strumento in {Bando 1246, Manifestazione di Interesse 255, Concorsi Pubblici e Avvisi sul Personale
 *        221, Avviso Dote 126, Altri Bandi/Finanziamenti 86}; apertura never after chiusura.
 *   GET .../bukx-h2uy.json?$limit=2&$q=agricoltura      -> HTTP 200, two matching rows: `$q` works as the README says.
 *   GET .../bukx-h2uy.json?$limit=3&$order=codice_bando -> HTTP 200, ordered by code (used so offset paging is stable).
 *   GET .../bukx-h2uy.json?$limit=1 with header `X-App-Token: invalid-token-for-test` -> HTTP 403
 *        {"code":"permission_denied","message":"Invalid app_token specified"}: the header name is honoured, and a
 *        wrong token BREAKS the request (a valid one only raises the rate ceiling).
 *   GET https://www.dati.lombardia.it/api/views/bukx-h2uy.json (metadata) -> name "Anagrafica dei bandi regionali",
 *        attribution "Regione Lombardia", licenseId CC_40_BY ("Creative Commons Attribution 4.0 International"),
 *        rowsUpdatedAt 2026-10-01T07:10:33Z, "Frequenza: Mensile"; column types: apertura_adesione and
 *        chiusura_adesione are `calendar_date`, presentato is `number`, the rest `text`.
 *   GET .../resource/8g3e-h8jh.json -> HTTP 404 {"code":"dataset.missing"}: the dataset id in the README's SAMPLE
 *        OUTPUT `source_url` does not exist (the README prose and every live check say bukx-h2uy), so the per-record
 *        `source_url` here uses bukx-h2uy.
 *   GET https://www.dati.lombardia.it/robots.txt -> `User-agent: * / Crawl-delay: 1`; Disallow rules cover /browse,
 *        /page, /catalog, /facet (query-string variants), /OData.svc/, /api/odata/, /login, /tiles/, /api/collocate*;
 *        `/resource/` and `/api/views/` are not disallowed.
 * ============================================================================
 *
 * OVERLAP NOTE: `emerging-market-sovereign-debt-auction-monitor` does not overlap this source.
 */
import { z } from 'zod';

import { describeSanitization, findKeywordMatch, type SanitizedKeywordList, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type HttpRequestInit, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const LOMBARDIA_DATASET_ID = 'bukx-h2uy';
export const LOMBARDIA_RESOURCE_URL = `https://www.dati.lombardia.it/resource/${LOMBARDIA_DATASET_ID}.json`;
/** Rows per request. The whole register is ~1.9k rows, i.e. two requests. */
export const PAGE_LIMIT = 1000;
/** robots.txt `Crawl-delay: 1` (verified 2026-10-21). */
export const LOMBARDIA_CRAWL_DELAY_MS = 1000;
/** One full register walk per `$q` keyword, so only the first few are honoured. */
export const MAX_KEYWORD_QUERIES = 5;
/** Runaway guard: 60 pages x 1000 rows is ~30x the live register. */
export const PAGE_CAP = 60;
const REQUEST_TIMEOUT_MS = 60_000;

export const LICENSE_NOTICE = 'Creative Commons Attribution 4.0 International (CC BY 4.0) - attribution: Regione Lombardia (dati.lombardia.it, dataset bukx-h2uy)';

export const LOMBARDIA_STATUSES = ['UPCOMING', 'OPEN', 'CLOSED'] as const;
export type LombardiaStatus = (typeof LOMBARDIA_STATUSES)[number];

// ---------------------------------------------------------------------------
// Raw shape
// ---------------------------------------------------------------------------

const rowSchema = z.object({
    codice_bando: z.string().trim().min(1),
    titolo_bando: z.string().nullish(),
    direzione_generale: z.string().nullish(),
    ente: z.string().nullish(),
    apertura_adesione: z.string().nullish(),
    chiusura_adesione: z.string().nullish(),
    tipo_strumento: z.string().nullish(),
    // A Socrata `number` column is serialised as a JSON string ("0"); a number is accepted too.
    presentato: z.union([z.string(), z.number()]).nullish(),
});
export type LombardiaRow = z.infer<typeof rowSchema>;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** Socrata `calendar_date` values are naive ("2026-03-21T00:00:00.000"); they are read as UTC, as the README renders them. */
export function socrataTimestampToIso(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    const date = new Date(NAIVE_TIMESTAMP.test(trimmed) ? `${trimmed}Z` : trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const DAY_MS = 86_400_000;

/**
 * The README's derived lifecycle status. See the header for the edge-case rules this implements. Pure; `now` is the
 * run clock (`ctx.now()`), never `Date.now()`.
 */
export function computeLombardiaStatus(aperturaIso: string | null, chiusuraIso: string | null, now: Date): LombardiaStatus | null {
    const nowMs = now.getTime();
    const opens = aperturaIso === null ? null : Date.parse(aperturaIso);
    if (opens !== null && Number.isFinite(opens) && nowMs < opens) return 'UPCOMING';
    if (chiusuraIso === null) {
        return null;
    }
    const closes = Date.parse(chiusuraIso);
    if (!Number.isFinite(closes)) return null;
    // A date-only closing date (midnight) is open for that whole calendar day.
    const closeInstant = new Date(closes);
    const dateOnly = closeInstant.getUTCHours() === 0 && closeInstant.getUTCMinutes() === 0 && closeInstant.getUTCSeconds() === 0;
    return nowMs < (dateOnly ? closes + DAY_MS : closes) ? 'OPEN' : 'CLOSED';
}

function toPresentato(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function blankToNull(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** Dataset row in the README's output vocabulary (minus the router-owned and delta-derived keys named in the header). */
export function normalizeRow(row: LombardiaRow, now: Date): Record<string, unknown> {
    const aperturaIso = socrataTimestampToIso(row.apertura_adesione);
    const chiusuraIso = socrataTimestampToIso(row.chiusura_adesione);
    return {
        source_url: `${LOMBARDIA_RESOURCE_URL}?codice_bando=${encodeURIComponent(row.codice_bando)}`,
        codice_bando: row.codice_bando,
        titolo_bando: blankToNull(row.titolo_bando),
        direzione_generale: blankToNull(row.direzione_generale),
        ente: blankToNull(row.ente),
        tipo_strumento: blankToNull(row.tipo_strumento),
        apertura_adesione_iso: aperturaIso,
        chiusura_adesione_iso: chiusuraIso,
        presentato: toPresentato(row.presentato),
        computed_status: computeLombardiaStatus(aperturaIso, chiusuraIso, now),
        license: LICENSE_NOTICE,
    };
}

/** Publishing body / directorate plus bando title, for the engine watchlist. */
export function watchTextOf(row: LombardiaRow): string {
    return [row.ente, row.direzione_generale, row.titolo_bando].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' ');
}

/**
 * recordId = `codice_bando` (the legacy record_id; unique on all 1,934 live rows). The fingerprint is the whole
 * emitted row, so any edit AND a `computed_status` transition (UPCOMING -> OPEN -> CLOSED) re-emit the record,
 * which is the README's STATUS_CHANGE behaviour. `source_url` and `license` are constants of the id / dataset.
 */
export function toSourceRecord(row: LombardiaRow, now: Date): SourceRecord {
    const payload = normalizeRow(row, now);
    return {
        recordId: row.codice_bando,
        fingerprint: fingerprintOf([
            payload.titolo_bando,
            payload.direzione_generale,
            payload.ente,
            payload.tipo_strumento,
            payload.apertura_adesione_iso,
            payload.chiusura_adesione_iso,
            payload.presentato,
            payload.computed_status,
        ]),
        payload,
        watchText: watchTextOf(row),
    };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const keywordInputSchema = z.union([z.array(z.string()), z.string()]).optional();

export const itLombardiaGrantsOptionsSchema = z
    .object({
        /** Socrata `$q` full-text search (title, directorate, publisher, instrument type); one query per keyword, unioned. Read through sanitizeKeywordList. */
        keyword: keywordInputSchema,
        /** Substring(s) of the free-text `direzione_generale`, applied client-side. Read through sanitizeKeywordList. */
        directorateFilter: keywordInputSchema,
        /** Keep only bandi in these derived statuses. A bando with no derivable status never matches. */
        statusFilter: z.array(z.enum(LOMBARDIA_STATUSES)).optional(),
        /** Optional free Socrata app token (BYOK). Sent as `X-App-Token`; an INVALID token makes every request fail with HTTP 403. */
        socrataAppToken: z.string().trim().optional(),
    })
    .strict();
export type ItLombardiaGrantsOptions = z.infer<typeof itLombardiaGrantsOptionsSchema>;

function resolveKeywordFilter(ctx: ConnectorContext, fieldName: string, input: unknown): SanitizedKeywordList {
    const list = sanitizeKeywordList(input);
    if (list.keywords.length > 0) {
        ctx.log.info(`[it_lombardia_grants] ${describeSanitization(list, fieldName)}`);
    } else if (list.rejected.length > 0 || list.malformedContainer) {
        ctx.log.warning(`[it_lombardia_grants] ${describeSanitization(list, fieldName)} No valid keyword remained, so NO ${fieldName} filtering is applied.`);
    }
    return list;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** One page of the SODA query. `$order=codice_bando` makes `$offset` paging stable (the dataset has no natural order). */
export function buildPageUrl(offset: number, q: string | null): string {
    const base = `${LOMBARDIA_RESOURCE_URL}?$limit=${PAGE_LIMIT}&$offset=${offset}&$order=codice_bando`;
    return q === null ? base : `${base}&$q=${encodeURIComponent(q)}`;
}

function describeFailure(error: unknown, url: string): string {
    if (error instanceof HttpStatusError) {
        if (error.status === 403) {
            return `Socrata answered HTTP 403 for ${url}: ${error.bodyPreview || 'no body'} (an invalid socrataAppToken is rejected outright; remove it or supply a valid one)`;
        }
        if (error.status === 429) return `Socrata rate-limited the request (HTTP 429) after retries for ${url}; a free socrataAppToken raises the ceiling`;
        return `Socrata answered HTTP ${error.status} for ${url}${error.bodyPreview ? `: ${error.bodyPreview}` : ''}`;
    }
    return `network-level failure reaching dati.lombardia.it [${url}]: ${error instanceof Error ? error.message : String(error)}`;
}

export interface LombardiaDeps {
    /** Injected so tests do not really wait out the robots.txt crawl-delay. */
    sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The whole connector body, with the clock-waiting injected. `connector.fetch` calls it with the real timer. */
export async function fetchLombardiaGrants(
    ctx: ConnectorContext,
    options: ItLombardiaGrantsOptions,
    run: RunParams,
    deps: LombardiaDeps = { sleep: realSleep },
): Promise<SourceRecord[]> {
    const now = ctx.now();
    const keywords = resolveKeywordFilter(ctx, 'keyword', options.keyword);
    const directorates = resolveKeywordFilter(ctx, 'directorateFilter', options.directorateFilter);

    let queries: Array<string | null> = [null];
    if (keywords.keywords.length > 0) {
        queries = keywords.keywords.slice(0, MAX_KEYWORD_QUERIES);
        if (keywords.keywords.length > MAX_KEYWORD_QUERIES) {
            ctx.log.warning(`[it_lombardia_grants] keyword has ${keywords.keywords.length} entries; only the first ${MAX_KEYWORD_QUERIES} are queried (one register walk each).`);
        }
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.socrataAppToken) headers['x-app-token'] = options.socrataAppToken;
    const init: HttpRequestInit = { headers, timeoutMs: REQUEST_TIMEOUT_MS };

    const byCode = new Map<string, LombardiaRow>();
    let requests = 0;
    let skipped = 0;
    for (const q of queries) {
        for (let page = 0; page < PAGE_CAP; page += 1) {
            const url = buildPageUrl(page * PAGE_LIMIT, q);
            if (requests > 0) await deps.sleep(LOMBARDIA_CRAWL_DELAY_MS);
            requests += 1;

            let body: unknown;
            try {
                body = await ctx.http.getJson<unknown>(url, init);
            } catch (error) {
                throw new SourceFetchError(describeFailure(error, url), 'it_lombardia_grants');
            }
            if (!Array.isArray(body)) {
                throw new SourceFetchError(`Socrata answered ${url} with ${typeof body} instead of a JSON array - the dataset contract changed.`, 'it_lombardia_grants');
            }

            let valid = 0;
            for (const candidate of body) {
                const parsed = rowSchema.safeParse(candidate);
                if (!parsed.success) {
                    skipped += 1;
                    continue;
                }
                valid += 1;
                if (!byCode.has(parsed.data.codice_bando)) byCode.set(parsed.data.codice_bando, parsed.data);
            }
            if (body.length > 0 && valid === 0) {
                throw new SourceFetchError(`Socrata page ${page + 1} returned ${body.length} rows and none had a codice_bando - the dataset schema changed.`, 'it_lombardia_grants');
            }
            if (body.length < PAGE_LIMIT) break;
        }
    }
    if (skipped > 0) ctx.log.warning(`[it_lombardia_grants] skipped ${skipped} row(s) without a usable codice_bando.`);

    // Client-side filters. An empty sanitised directorate list means "no filtering requested".
    const wanted = options.statusFilter && options.statusFilter.length > 0 ? new Set<string>(options.statusFilter) : null;
    const rows = [...byCode.values()].filter((row) => {
        if (directorates.needles.length > 0 && findKeywordMatch(row.direzione_generale, directorates) === null) return false;
        if (wanted !== null) {
            const status = computeLombardiaStatus(socrataTimestampToIso(row.apertura_adesione), socrataTimestampToIso(row.chiusura_adesione), now);
            if (status === null || !wanted.has(status)) return false;
        }
        return true;
    });

    // Newest opening first (then code, descending) so a maxItemsPerSource cut keeps the most recent bandi.
    rows.sort((a, b) => {
        const ka = `${socrataTimestampToIso(a.apertura_adesione) ?? '0000'}|${a.codice_bando}`;
        const kb = `${socrataTimestampToIso(b.apertura_adesione) ?? '0000'}|${b.codice_bando}`;
        return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    const selected = rows.slice(0, run.maxItemsPerSource);
    if (rows.length > selected.length) {
        ctx.log.warning(`[it_lombardia_grants] ${rows.length} bandi matched but maxItemsPerSource=${run.maxItemsPerSource}; the ${rows.length - selected.length} oldest-opened were not returned.`);
    }
    ctx.log.info(`[it_lombardia_grants] ${selected.length} bando(s) returned (${byCode.size} unique rows over ${requests} request(s)).`);
    return selected.map((row) => toSourceRecord(row, now));
}

export const itLombardiaGrantsConnector: Connector<ItLombardiaGrantsOptions> = {
    id: 'it_lombardia_grants',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'regione-lombardia-grants-registry-monitor',
    description:
        'Regione Lombardia regional grants and tenders register ("Anagrafica dei bandi regionali", Socrata dataset bukx-h2uy on dati.lombardia.it, CC BY 4.0), with a derived UPCOMING / OPEN / CLOSED status. Implemented from the legacy README plus live endpoint verification (the legacy repo has no source). The README\'s 14-category policy-area taxonomy is not reproduced. Optional BYOK Socrata app token.',
    status: 'active',
    optionsSchema: itLombardiaGrantsOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ItLombardiaGrantsOptions, run: RunParams): Promise<SourceRecord[]> {
        return fetchLombardiaGrants(ctx, options, run);
    },
};
