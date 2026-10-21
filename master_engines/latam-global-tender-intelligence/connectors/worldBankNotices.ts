/**
 * worldBankNotices.ts - World Bank procurement notices connector.
 *
 * Absorbs the `worldBankProcurementNotices` sub-source of `actor-20-mdb-procurement-monitor`
 * (src/sources/worldBankProcurementNotices.ts, the procurement-notice half of src/umsNormalizer.ts,
 * src/schemas.ts, src/dateUtils.ts and the content half of src/fingerprint.ts). The legacy actor's other
 * sub-source (the debarred-firms "Other Sanctions" table) is a sanctions feed and lives in the regtech engine
 * as `world_bank_debarred`.
 *
 * DEFERRED, NOT PORTED (legacy src/sources/deferredSources.ts + AGENTS.md, live-researched 2026-09-07):
 *   - ADB (Asian Development Bank): Cloudflare bot-detection on every path including robots.txt and the RSS
 *     feed; getting past it is exactly the WAF bypass the compliance doctrine forbids.
 *   - IDB (Inter-American Development Bank): the notices page is an embedded Power BI report, and the CKAN
 *     open-data API at data.iadb.org is robots.txt-disallowed on every programmatic path (/api/, /datastore/dump/,
 *     /file/download/, /dataset/download/).
 * Neither is exposed by this connector and neither is registered as an active source.
 *
 * NOT ported, because the router owns them: src/delta.ts (NEW_LISTING / STATUS_CHANGE / UPDATED /
 * SNAPSHOT_NO_DIFF classifier), src/state.ts, `onlyNew`, src/main.ts, Actor.pushData and every charge. The
 * legacy `event_type` is therefore not emitted: it was the delta classification for this sub-source.
 *
 * COMPLIANCE
 * ----------
 * The legacy src/http.ts used `impit` (Chrome TLS fingerprint). That is NOT ported: this connector uses `ctx.http`
 * (Node fetch, honest User-Agent), and the endpoint answers it (see the verification block).
 *
 * PRIVACY: the feed carries a named procurement contact (name, e-mail, phone, address) on every notice, and the
 * free-text `notice_text` frequently embeds individuals' names and e-mail addresses (seen live: an invitation
 * letter addressed to named individual consultants with their personal webmail addresses). The legacy UMS row
 * surfaced neither, so neither is emitted here. Change detection on the notice text is kept without exposing it:
 * `notice_text_fingerprint` is a hash of the plain text, so an edited notice is still re-emitted.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Legacy (2026-09-07 / 2026-09-19): unauthenticated JSON, envelope {rows, os, page, total, procnotices[]}, the
 * 24-field raw notice, `noticedate` rendered "DD-MMM-YYYY", the feed sorted newest-first and growing while paged by
 * numeric offset (so a notice can reappear on a later page - de-duplicated here by id), no documented server-side
 * filter beyond rows/os (so country / notice type / date filtering is client-side).
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy, honest User-Agent
 * "awesome-regulatory-monitors/0.1 (+https://github.com/stefanoseggio)", no impersonation):
 *   GET https://search.worldbank.org/api/v2/procnotices?format=json&rows=3&os=0
 *     -> HTTP 200 application/json; envelope keys exactly [os, page, procnotices, rows, total] with
 *        rows = JSON number (3) and os / page / total = JSON STRINGS ("0", "1", "423546"), i.e. the mixed types
 *        the legacy schema documents; first notice id OP00469489, notice_status "Published",
 *        noticedate "19-Oct-2026", submission_deadline_date "2026-10-20T00:00:00Z".
 *   GET ...?format=json&rows=200&os=0 / 2000 / 20000 -> HTTP 200, 200 rows each, noticedate descending within the
 *        page (19-Oct-2026 .. 17-Oct-2026; 05-Oct .. 02-Oct; 12-May-2026 .. 11-May-2026) - newest-first confirmed,
 *        which is what makes the date-window early stop below safe. notice_type values seen: Contract Award,
 *        General Procurement Notice, Invitation for Bids, Request for Expression of Interest; notice_status
 *        was "Published" on every row seen.
 *   OFFSET CEILING (NEW, not in the legacy notes): os=50000 and os=100000 -> HTTP 200; os=150000 and os=200000 ->
 *        HTTP 400 {"error":"400 - {\"error\":{\"code\":\"InvalidRequestParameter\",\"message\":\"Value must be
 *        between 0 and 100000.\\r\\nParameter name: $skip\"...}}"} (an Azure Cognitive Search $skip limit). The
 *        walk therefore never requests os > 100000.
 *   GET ...?format=json&id=OP00469489 -> HTTP 200, total "1": the `id` filter works, so the legacy `source_url`
 *        is a real per-notice link. A guessed `noticedate=` parameter -> HTTP 400 (no server-side date filter).
 *   `contact_web_url` is frequently null; `bid_reference_no` is the human reference number. A live Contract Award
 *        omitted `contact_organization` and `submission_deadline_date` entirely (absent keys), which the schema and the
 *        'World Bank' fallback handle.
 *   End to end: this connector, driven through lib/http.ts createHttpClient (Node fetch, honest User-Agent) against the
 *        live API with `dateRange: '7d'` and `pageSize: 50`, returned 60 distinct notices over 2 pages.
 * ============================================================================
 *
 * OVERLAP NOTE: `emerging-market-sovereign-debt-auction-monitor` does not overlap this source.
 */
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { describeSanitization, normaliseKeyword, type SanitizedKeywordList, sanitizeKeywordList } from '../../lib/_guards.js';
import { DATE_RANGES, type DateRange, fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

// Confirmed live, unauthenticated, 2026-09-07 (legacy) and 2026-10-21 (this port).
export const WORLD_BANK_PROCNOTICES_URL = 'https://search.worldbank.org/api/v2/procnotices';
export const WORLD_BANK_JURISDICTION = 'WB';
const PROCNOTICE_ID_PREFIX = 'wb-procnotice-';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
/** Safety valve against a runaway loop if `total` is ever malformed: 200 pages x 200 rows = 40,000 fetched notices. */
export const HARD_PAGE_FETCH_CAP = 200;
/** The upstream rejects `os` above this with HTTP 400 (live-verified 2026-10-21). */
export const MAX_OFFSET = 100_000;

// ---------------------------------------------------------------------------
// Raw shapes (legacy src/schemas.ts)
// ---------------------------------------------------------------------------

export const WorldBankProcNoticeRawSchema = z.object({
    id: z.string(),
    notice_type: z.string().nullable().optional(),
    noticedate: z.string().nullable().optional(),
    notice_lang_name: z.string().nullable().optional(),
    notice_status: z.string().nullable().optional(),
    submission_deadline_date: z.string().nullable().optional(),
    submission_deadline_time: z.string().nullable().optional(),
    project_ctry_name: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    project_name: z.string().nullable().optional(),
    bid_reference_no: z.string().nullable().optional(),
    bid_description: z.string().nullable().optional(),
    procurement_group: z.string().nullable().optional(),
    procurement_method_code: z.string().nullable().optional(),
    procurement_method_name: z.string().nullable().optional(),
    contact_address: z.string().nullable().optional(),
    contact_ctry_name: z.string().nullable().optional(),
    contact_email: z.string().nullable().optional(),
    contact_name: z.string().nullable().optional(),
    contact_organization: z.string().nullable().optional(),
    contact_phone_no: z.string().nullable().optional(),
    contact_web_url: z.string().nullable().optional(),
    submission_date: z.string().nullable().optional(),
    notice_text: z.string().nullable().optional(),
});
export type WorldBankProcNoticeRaw = z.infer<typeof WorldBankProcNoticeRawSchema>;

// `rows` is a JSON number in the live response; `os` / `page` / `total` are JSON strings. The API mixes types
// across these envelope fields, so both are accepted rather than assumed.
const numericLike = z.union([z.number(), z.string()]);

export const WorldBankProcNoticesEnvelopeSchema = z.object({
    rows: numericLike,
    os: numericLike,
    page: numericLike,
    total: numericLike,
    procnotices: z.array(WorldBankProcNoticeRawSchema),
});
export type WorldBankProcNoticesEnvelope = z.infer<typeof WorldBankProcNoticesEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Dates (legacy src/dateUtils.ts)
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<DateRange, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '365d': 365 * 24 * 60 * 60 * 1000,
};

/**
 * Requires `diffMs >= 0`, not just `diffMs <= window`: a one-sided check lets any future-dated value match every
 * window (a negative diff is always <= a positive bound). `noticedate` is a publish date and retrospective in
 * practice, so this is defensive (the same bug class fired live on sibling Argentine sources).
 */
export function isWithinDateRange(date: Date | null, range: DateRange | undefined, now: Date): boolean {
    if (!range) return true;
    if (!date) return false;
    const diffMs = now.getTime() - date.getTime();
    return diffMs >= 0 && diffMs <= WINDOW_MS[range];
}

/** True when `date` is strictly older than the window. A null date is never "too old" (it is simply unusable). */
export function isOlderThanDateRange(date: Date | null, range: DateRange | undefined, now: Date): boolean {
    if (!range || !date) return false;
    return now.getTime() - date.getTime() > WINDOW_MS[range];
}

const MONTH_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** `noticedate` is "DD-MMM-YYYY" (e.g. "19-Oct-2026"; live-verified). `submission_deadline_date` is already full ISO-8601. */
export function parseWorldBankNoticeDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
    if (!match) return null;
    const [, dd, mmm, yyyy] = match;
    if (dd === undefined || mmm === undefined || yyyy === undefined) return null;
    const month = MONTH_ABBR[mmm.toLowerCase()];
    if (month === undefined) return null;
    return new Date(Date.UTC(Number(yyyy), month, Number(dd)));
}

export function toIsoOrNull(date: Date | null): string | null {
    return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Normalisation (legacy normalizeWorldBankProcurementNotice, UMS vocabulary)
// ---------------------------------------------------------------------------

/** Plain-text rendering of the notice's HTML body (whitespace collapsed); null when there is none. Never emitted, only hashed. */
export function noticeTextToPlain(html: string | null | undefined): string | null {
    if (!html) return null;
    const $ = cheerio.load(html, null, false);
    $('script, style').remove();
    // Block boundaries become spaces, so `<p>a</p><p>b</p>` and `<p>a</p>\n<p>b</p>` hash identically: a harmless re-wrap
    // upstream must not look like an edited notice.
    $('br').replaceWith(' ');
    $('p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, table').each((_, el) => {
        $(el).append(' ');
    });
    const text = $.root().text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
}

/**
 * The legacy 18-field Unified Master Schema row for a procurement notice, minus the keys the router owns
 * (`record_id`, `is_new`, `scraped_at`) and minus the delta-derived `event_type`. Additive keys (non-personal raw
 * columns the UMS dropped) follow the UMS block. The row carries no winner or monetary value because this endpoint
 * has no such field (a "Contract Award" notice here is the announcement, not the contract data).
 */
export function normalizeWorldBankProcurementNotice(raw: WorldBankProcNoticeRaw): Record<string, unknown> {
    const noticeText = noticeTextToPlain(raw.notice_text);
    return {
        source_url: `${WORLD_BANK_PROCNOTICES_URL}?format=json&id=${encodeURIComponent(raw.id)}`,
        // This endpoint carries no winner/bidder name and no monetary value: null is an honest "not applicable", not a parsing gap.
        recipient_or_defendant_name: null,
        entity_identifier_native: raw.bid_reference_no ?? raw.project_id ?? null,
        value_native: null,
        value_currency: null,
        value_usd_normalized: null,
        effective_date_iso: raw.submission_deadline_date ?? null,
        publish_date_iso: toIsoOrNull(parseWorldBankNoticeDate(raw.noticedate)),
        category_or_type: raw.notice_type ?? null,
        status_or_estado: raw.notice_status ?? null,
        awarding_or_regulating_agency: raw.contact_organization ?? 'World Bank',
        jurisdiction: WORLD_BANK_JURISDICTION,
        source_document_url: raw.contact_web_url ?? null,
        reference_number: raw.bid_reference_no ?? null,
        // ---- additive, non-personal ----
        notice_id: raw.id,
        project_id: raw.project_id ?? null,
        project_name: raw.project_name ?? null,
        project_country: raw.project_ctry_name ?? null,
        bid_description: raw.bid_description ?? null,
        procurement_group: raw.procurement_group ?? null,
        procurement_method_code: raw.procurement_method_code ?? null,
        procurement_method_name: raw.procurement_method_name ?? null,
        notice_language: raw.notice_lang_name ?? null,
        submission_deadline_time: raw.submission_deadline_time ?? null,
        submission_date: raw.submission_date ?? null,
        notice_text_fingerprint: noticeText === null ? null : fingerprintOf([noticeText]),
    };
}

/** Buyer (the notice's contact organisation) plus project and bid title, for the engine watchlist. */
export function watchTextOf(raw: WorldBankProcNoticeRaw): string {
    return [raw.contact_organization, raw.project_name, raw.bid_description]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join(' ');
}

/**
 * recordId = `wb-procnotice-<id>` (the legacy record_id). The fingerprint covers every consumer-visible column of
 * the row. The legacy content hash also covered the contact name / e-mail / phone / address columns; those are not
 * emitted here (see PRIVACY above), so they no longer drive re-emission. `notice_status` is first so a status
 * transition is the most visible change.
 */
export function toSourceRecord(raw: WorldBankProcNoticeRaw): SourceRecord {
    const payload = normalizeWorldBankProcurementNotice(raw);
    return {
        recordId: `${PROCNOTICE_ID_PREFIX}${raw.id}`,
        fingerprint: fingerprintOf([
            raw.notice_status,
            raw.notice_type,
            raw.noticedate,
            raw.submission_deadline_date,
            raw.submission_deadline_time,
            raw.submission_date,
            raw.project_ctry_name,
            raw.project_id,
            raw.project_name,
            raw.bid_reference_no,
            raw.bid_description,
            raw.procurement_group,
            raw.procurement_method_code,
            raw.procurement_method_name,
            raw.notice_lang_name,
            raw.contact_organization,
            raw.contact_web_url,
            payload.notice_text_fingerprint,
        ]),
        payload,
        watchText: watchTextOf(raw),
    };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Exact (not substring) membership, case-insensitive and whitespace-normalised, against a guard-sanitised list.
 * Exactness matters: a substring test would make "Niger" also match "Nigeria". An empty sanitised list means "no
 * filtering requested" (true) - never "match everything by accident of an empty needle" and never a billable
 * condition. The legacy used a case-sensitive exact `Set.has`, whose `new Set([""])` also matched every notice with
 * a null country (`?? ''`); the guard drops such blank entries.
 */
export function matchesExactList(value: string | null | undefined, list: SanitizedKeywordList): boolean {
    if (list.needles.length === 0) return true;
    if (typeof value !== 'string') return false;
    return list.needles.includes(normaliseKeyword(value).toLowerCase());
}

function resolveListFilter(ctx: ConnectorContext, fieldName: string, input: unknown): SanitizedKeywordList {
    const list = sanitizeKeywordList(input);
    if (list.keywords.length > 0) {
        ctx.log.info(`[world_bank_notices] ${describeSanitization(list, fieldName)}`);
    } else if (list.rejected.length > 0 || list.malformedContainer) {
        ctx.log.warning(`[world_bank_notices] ${describeSanitization(list, fieldName)} No valid entry remained, so NO ${fieldName} filtering is applied.`);
    }
    return list;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const worldBankNoticesOptionsSchema = z
    .object({
        /** Exact `project_ctry_name` values (e.g. "Kenya", "Western and Central Africa"), case-insensitive. Empty = all countries. */
        countryFilter: z.union([z.array(z.string()), z.string()]).optional(),
        /** Exact `notice_type` values (e.g. "Invitation for Bids", "Contract Award"), case-insensitive. Empty = all types. */
        noticeTypeFilter: z.union([z.array(z.string()), z.string()]).optional(),
        /** Only notices whose `noticedate` is within this window of the run clock (24h | 7d | 30d | 90d | 365d). */
        dateRange: z.enum(DATE_RANGES).optional(),
        /** Rows requested per page (the upstream accepts up to 200). */
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    })
    .strict();
export type WorldBankNoticesOptions = z.infer<typeof worldBankNoticesOptionsSchema>;

function describeFailure(error: unknown, url: string): string {
    if (error instanceof HttpStatusError) return `World Bank procnotices answered HTTP ${error.status} for ${url}${error.bodyPreview ? `: ${error.bodyPreview}` : ''}`;
    return `network-level failure reaching World Bank procnotices [${url}]: ${error instanceof Error ? error.message : String(error)}`;
}

export const worldBankNoticesConnector: Connector<WorldBankNoticesOptions> = {
    id: 'world_bank_notices',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'actor-20-mdb-procurement-monitor',
    description:
        'World Bank procurement notices (invitations for bids, expressions of interest, general procurement notices, contract-award announcements) from the unauthenticated search.worldbank.org procnotices API. ADB and IDB, which the legacy actor deferred, are not included. No credentials.',
    status: 'active',
    optionsSchema: worldBankNoticesOptionsSchema,

    async fetch(ctx: ConnectorContext, options: WorldBankNoticesOptions, run: RunParams): Promise<SourceRecord[]> {
        const now = ctx.now();
        const countryFilter = resolveListFilter(ctx, 'countryFilter', options.countryFilter);
        const noticeTypeFilter = resolveListFilter(ctx, 'noticeTypeFilter', options.noticeTypeFilter);
        const pageSize = Math.min(Math.max(options.pageSize, 1), MAX_PAGE_SIZE);

        const records: SourceRecord[] = [];
        const seenIds = new Set<string>();
        let os = 0;
        let total = Number.POSITIVE_INFINITY;
        let pagesFetched = 0;
        let stoppedBy = 'end of results';

        while (records.length < run.maxItemsPerSource) {
            if (os >= total) break;
            if (os > MAX_OFFSET) {
                stoppedBy = `the upstream offset ceiling (os <= ${MAX_OFFSET})`;
                break;
            }
            if (pagesFetched >= HARD_PAGE_FETCH_CAP) {
                stoppedBy = `the ${HARD_PAGE_FETCH_CAP}-page safety cap`;
                break;
            }

            const url = `${WORLD_BANK_PROCNOTICES_URL}?format=json&rows=${pageSize}&os=${os}`;
            let json: unknown;
            try {
                json = await ctx.http.getJson<unknown>(url);
            } catch (error) {
                throw new SourceFetchError(describeFailure(error, url), 'world_bank_notices');
            }
            const parsed = WorldBankProcNoticesEnvelopeSchema.safeParse(json);
            if (!parsed.success) {
                throw new SourceFetchError(
                    `World Bank procnotices returned an unexpected envelope for ${url}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
                    'world_bank_notices',
                );
            }
            const envelope = parsed.data;
            total = Number(envelope.total);
            if (!Number.isFinite(total)) {
                throw new SourceFetchError(`World Bank procnotices returned a non-numeric total ("${String(envelope.total)}") for ${url}.`, 'world_bank_notices');
            }
            pagesFetched += 1;

            const batch = envelope.procnotices;
            if (batch.length === 0) break;

            for (const raw of batch) {
                if (!matchesExactList(raw.project_ctry_name, countryFilter)) continue;
                if (!matchesExactList(raw.notice_type, noticeTypeFilter)) continue;
                if (options.dateRange && !isWithinDateRange(parseWorldBankNoticeDate(raw.noticedate), options.dateRange, now)) continue;
                // The feed grows while it is paged by a numeric offset, so a notice can reappear on a later page.
                if (seenIds.has(raw.id)) continue;
                seenIds.add(raw.id);
                records.push(toSourceRecord(raw));
                if (records.length >= run.maxItemsPerSource) break;
            }

            // The feed is newest-first (live-verified), so once an entire page is older than the window every later page is too.
            if (options.dateRange && batch.every((raw) => isOlderThanDateRange(parseWorldBankNoticeDate(raw.noticedate), options.dateRange, now))) {
                stoppedBy = `a page entirely older than ${options.dateRange}`;
                break;
            }

            os += batch.length;
        }

        ctx.log.info(`[world_bank_notices] ${records.length} notice(s) returned from ${pagesFetched} page(s); stopped on ${records.length >= run.maxItemsPerSource ? 'maxItemsPerSource' : stoppedBy}.`);
        return records;
    },
};
