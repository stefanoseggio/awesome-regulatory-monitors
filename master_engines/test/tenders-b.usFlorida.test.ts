/**
 * us_florida connector tests.
 *
 * Fixtures (test/fixtures/tenders-b/florida_*, no network), ALL COPIED VERBATIM from the legacy actor
 * (florida-tenders-monitor/test/fixtures, real captures of 2026-09-07 - this session did not re-capture them):
 *   - florida_listing_open_page1.json / page2.json: the full OPEN register (100 + 64 = 164 rows)
 *   - florida_listing_open_page3_empty.json: the empty array that ends a walk; florida_count_open.txt: the bare /count answer (164)
 *   - florida_detail_16672.json (Agency Decision with a linked ad) and florida_detail_14963_amended.json (v7, 9 documents)
 *   - florida_detail_unknown_id.json: the all-null detail MFMP answers (HTTP 200) for an unknown id
 *   - florida_error_400.json: MFMP's `{errorMessage}` body for a malformed request
 *   - florida_index_shell.html: the Angular index.html shell served when the Accept header is missing
 * The paging/filter server below is a SYNTHETIC emulation of the documented MFMP behaviour (100-row pages, case-insensitive
 * `title` substring, exact `adNumber`, a bare integer from /count, an empty array past the end); it serves the real rows.
 * Inline rows and clocks are SYNTHETIC and labelled where used.
 */
import { describe, expect, it } from 'vitest';

import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import {
    AD_TYPES,
    assertListingPage,
    attachmentDownloadUrl,
    buildFilters,
    buildPayload,
    buildSearchPayload,
    daysBetween,
    daysUntil,
    describeFilters,
    describeMfmpFailure,
    type DetailData,
    detailPageUrl,
    fetchDetail,
    htmlToText,
    type ListingItem,
    mapWithConcurrency,
    normalizeAdNumber,
    PAGE_SIZE,
    parseUsdAmounts,
    passesClientFilters,
    resolveAdTypeId,
    resolveDate,
    resolveDateWindow,
    sortNewestFirst,
    toSiteLocal,
    toSourceRecord,
    toUtcIso,
    usFloridaConnector,
    usFloridaOptionsSchema,
    utcCalendarDay,
    yesNoToBoolean,
} from '../latam-global-tender-intelligence/connectors/usFlorida.js';
import { sanitizeKeywordList } from '../lib/_guards.js';
import { fixture, jsonFixture, LEGACY_DELTA_KEYS, makeCtx, ROUTER_OWNED_KEYS, type Responder, runThroughRouter } from './tenders-b.helpers.js';

const BASE = 'https://vendor.myfloridamarketplace.com';
const SEARCH = `${BASE}/mfmp/pub/search/bids`;
const COUNT = `${BASE}/mfmp/pub/search/bids/count`;
const DETAIL = `${BASE}/mfmp/pub/search/bids/detail`;

const page1 = jsonFixture<ListingItem[]>('florida_listing_open_page1.json');
const page2 = jsonFixture<ListingItem[]>('florida_listing_open_page2.json');
const register: ListingItem[] = [...page1, ...page2];
const detail16672 = jsonFixture<DetailData>('florida_detail_16672.json');
const detail14963 = jsonFixture<DetailData>('florida_detail_14963_amended.json');
const detailUnknown = jsonFixture<DetailData>('florida_detail_unknown_id.json');

const row16672 = register.find((r) => r.advertisementId === 16672) as ListingItem;
const row14963 = register.find((r) => r.advertisementId === 14963) as ListingItem;

const NOW = new Date('2026-09-07T00:00:00Z');
const RUN: RunParams = { maxItemsPerSource: 500 };
const opts = (overrides: Record<string, unknown> = {}) => usFloridaOptionsSchema.parse(overrides);

interface ServerConfig {
    rows?: ListingItem[];
    details?: Record<number, unknown>;
    /** Override the integer /count answers (to simulate a listing that grew after the count). */
    count?: unknown;
    inFlight?: { current: number; max: number };
}

/** SYNTHETIC emulation of MFMP: 100-row pages, case-insensitive title substring, exact adNumber, bare-integer /count, [] past the end. */
function floridaServer(config: ServerConfig = {}): Responder {
    const rows = config.rows ?? register;
    const matching = (body: { title?: string; adNumber?: string }) =>
        rows.filter((r) => (!body.title || r.title.toLowerCase().includes(body.title.toLowerCase())) && (!body.adNumber || String(r.advertisementId) === body.adNumber));
    return async (request) => {
        if (request.method === 'POST' && request.url === COUNT) {
            return config.count ?? matching(request.body as { title?: string; adNumber?: string }).length;
        }
        if (request.method === 'POST' && request.url === SEARCH) {
            const body = request.body as { page: number; pageSize: number; title?: string; adNumber?: string };
            const start = (Math.max(body.page, 1) - 1) * body.pageSize;
            return matching(body).slice(start, start + body.pageSize);
        }
        if (request.method === 'GET' && request.url.startsWith(`${DETAIL}?id=`)) {
            const id = Number(request.url.split('=')[1]);
            if (config.inFlight) {
                config.inFlight.current += 1;
                config.inFlight.max = Math.max(config.inFlight.max, config.inFlight.current);
                await new Promise((resolve) => setTimeout(resolve, 5));
                config.inFlight.current -= 1;
            }
            return config.details && id in config.details ? config.details[id] : detailUnknown;
        }
        return new Error(`unexpected request ${request.method} ${request.url}`);
    };
}

describe('normalisation helpers (legacy normalize.ts)', () => {
    it('toUtcIso / utcCalendarDay canonicalise MFMP\'s +00:00 timestamps and return null for garbage', () => {
        expect(toUtcIso('2026-08-13T17:39:51.000+00:00')).toBe('2026-08-13T17:39:51.000Z');
        expect(utcCalendarDay('2026-08-13T23:59:59.000+00:00')).toBe('2026-08-13');
        expect(toUtcIso('not a date')).toBeNull();
        expect(toUtcIso(null)).toBeNull();
        expect(toUtcIso('')).toBeNull();
        expect(utcCalendarDay(undefined)).toBeNull();
    });

    it('toSiteLocal renders the America/New_York wall clock with the right zone (EDT in September, EST in January)', () => {
        expect(toSiteLocal('2026-09-09T20:30:00.000+00:00')).toBe('2026-09-09 16:30 EDT');
        expect(toSiteLocal('2026-01-15T17:00:00.000+00:00')).toBe('2026-01-15 12:00 EST');
        expect(toSiteLocal('2026-09-09T04:00:00.000+00:00')).toBe('2026-09-09 00:00 EDT'); // Intl renders midnight as "24"
        expect(toSiteLocal('garbage')).toBeNull();
    });

    it('daysUntil / daysBetween truncate toward zero and go negative once passed', () => {
        expect(daysUntil('2026-09-09T20:30:00.000+00:00', NOW)).toBe(2);
        expect(daysUntil('2026-09-05T00:00:00.000+00:00', NOW)).toBe(-2);
        expect(Object.is(daysUntil('2026-09-06T20:00:00.000+00:00', NOW), -0)).toBe(false); // 4h in the past -> 0, never -0
        expect(daysUntil(null, NOW)).toBeNull();
        expect(daysBetween('2026-09-03T20:30:00.000+00:00', '2026-09-09T20:30:00.000+00:00')).toBe(6);
        expect(daysBetween('2026-09-03T00:00:00Z', null)).toBeNull();
    });

    it('htmlToText turns blocks into lines, decodes entities and collapses &nbsp; / whitespace', () => {
        expect(htmlToText('<p>Single&nbsp;Source <strong>Award</strong></p><p>to:&nbsp;&nbsp;Mobex</p><br>end')).toBe('Single Source Award\nto: Mobex\nend');
        expect(htmlToText('<script>alert(1)</script><p>x</p>')).toBe('x');
        expect(htmlToText('<p>&nbsp;</p>')).toBeNull();
        expect(htmlToText(null)).toBeNull();
    });

    it('parseUsdAmounts finds every dollar figure once, in order of appearance', () => {
        expect(parseUsdAmounts('Total $1,234,567.89 and $500 and again $1,234,567.89, then $ 20.5')).toEqual([1234567.89, 500, 20.5]);
        expect(parseUsdAmounts('no money here')).toEqual([]);
        expect(parseUsdAmounts(null)).toEqual([]);
    });

    it('normalizeAdNumber strips the prefix and zeros, and rejects values without digits', () => {
        expect(normalizeAdNumber('AD-16672')).toBe('16672');
        expect(normalizeAdNumber('GO-14963')).toBe('14963');
        expect(normalizeAdNumber(' 16672 ')).toBe('16672');
        expect(normalizeAdNumber('ad00123')).toBe('123');
        expect(normalizeAdNumber('abc')).toBeNull();
        expect(normalizeAdNumber('')).toBeNull();
    });

    it('yesNoToBoolean accepts booleans and yes/no/true/false strings only', () => {
        expect(yesNoToBoolean(true)).toBe(true);
        expect(yesNoToBoolean(' Yes ')).toBe(true);
        expect(yesNoToBoolean('NO')).toBe(false);
        expect(yesNoToBoolean('maybe')).toBeNull();
        expect(yesNoToBoolean(3)).toBeNull();
    });

    it('URL builders point at the portal and never at a download', () => {
        expect(detailPageUrl(16672)).toBe(`${BASE}/search/bids/detail/16672`);
        expect(attachmentDownloadUrl(39311)).toBe(`${BASE}/mfmp/bids/detail/attachment/download?attachmentId=39311`);
    });
});

describe('option parsing and date resolution', () => {
    it('applies the legacy defaults', () => {
        expect(opts()).toEqual({ statuses: ['OPEN'], types: [], agencyIds: [], commodityCodes: [], fetchDetail: true, maxConcurrency: 5 });
    });

    it('needs no credential (public unauthenticated JSON): no requiredOptions, preflight passes with empty options', () => {
        expect(usFloridaConnector.requiredOptions).toBeUndefined();
        const input = EngineInputSchema.parse({ sources: ['us_florida'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [usFloridaConnector] }, input)).toHaveLength(1);
    });

    it('uppercases statuses and rejects an unknown one', () => {
        expect(opts({ statuses: ['open', ' Closed '] }).statuses).toEqual(['OPEN', 'CLOSED']);
        expect(usFloridaOptionsSchema.safeParse({ statuses: ['ARCHIVED'] }).success).toBe(false);
    });

    it('maps ad-type labels to ids case-insensitively and rejects unknown types', () => {
        expect(opts({ types: ['Request for Proposals', '4', 'invitation to bid'] }).types).toEqual(['6', '4', '4']);
        expect(resolveAdTypeId('6')).toBe('6');
        expect(resolveAdTypeId('Nope')).toBeNull();
        expect(Object.keys(AD_TYPES)).toHaveLength(10);
        const bad = usFloridaOptionsSchema.safeParse({ types: ['Nope'] });
        expect(bad.success).toBe(false);
        expect(bad.error?.issues[0]?.message).toMatch(/unknown ad type "Nope" - use one of 1 \(Agency Decision\)/);
        expect(bad.error?.issues[0]?.path).toEqual(['types', 0]);
    });

    it('validates agency ids, commodity codes and the ad number', () => {
        expect(usFloridaOptionsSchema.safeParse({ agencyIds: ['FDOT'] }).success).toBe(false);
        expect(usFloridaOptionsSchema.safeParse({ agencyIds: ['30000021'] }).success).toBe(true);
        expect(usFloridaOptionsSchema.safeParse({ commodityCodes: ['83'] }).success).toBe(false);
        expect(usFloridaOptionsSchema.safeParse({ commodityCodes: ['83112200'] }).success).toBe(true);
        expect(opts({ adNumber: 'AD-16672' }).adNumber).toBe('16672');
        expect(opts({ adNumber: '' }).adNumber).toBeUndefined();
        expect(usFloridaOptionsSchema.safeParse({ adNumber: 'xyz' }).success).toBe(false);
    });

    it('validates date inputs (absolute must be a real day, relative forms accepted) and the concurrency range', () => {
        expect(usFloridaOptionsSchema.safeParse({ dateFrom: '2026-02-31' }).success).toBe(false);
        expect(usFloridaOptionsSchema.safeParse({ dateFrom: 'yesterday' }).success).toBe(false);
        for (const ok of ['2026-09-01', '7 days', '2 weeks', '3 months', '1 year', '24h', '7d', '']) {
            expect(usFloridaOptionsSchema.safeParse({ dateFrom: ok }).success, ok).toBe(true);
        }
        expect(usFloridaOptionsSchema.safeParse({ dateRange: '3d' }).success).toBe(false);
        expect(usFloridaOptionsSchema.safeParse({ maxConcurrency: 11 }).success).toBe(false);
        expect(usFloridaOptionsSchema.safeParse({ maxConcurrency: 0 }).success).toBe(false);
    });

    it('rejects copied-over legacy delta options (the schema is strict) instead of ignoring them', () => {
        for (const key of ['eventTypes', 'onlyNew', 'deltaStateName', 'resetState', 'maxItems']) {
            expect(usFloridaOptionsSchema.safeParse({ [key]: true }).success, key).toBe(false);
        }
    });

    it('resolveDate: absolute passes through, relative counts back from the run clock\'s UTC date, blank is null', () => {
        expect(resolveDate('2026-09-01', NOW, 'f')).toBe('2026-09-01');
        expect(resolveDate('7 days', NOW, 'f')).toBe('2026-08-31');
        expect(resolveDate('2 weeks', NOW, 'f')).toBe('2026-08-24');
        expect(resolveDate('3 months', NOW, 'f')).toBe('2026-06-07');
        expect(resolveDate('1 year', NOW, 'f')).toBe('2025-09-07');
        expect(resolveDate('24h', NOW, 'f')).toBe('2026-09-06');
        expect(resolveDate('48h', NOW, 'f')).toBe('2026-09-05');
        expect(resolveDate('7d', NOW, 'f')).toBe('2026-08-31');
        expect(resolveDate('', NOW, 'f')).toBeNull();
        expect(resolveDate(undefined, NOW, 'f')).toBeNull();
        expect(() => resolveDate('someday', NOW, 'dateFrom')).toThrow(/dateFrom must be YYYY-MM-DD/);
        expect(() => resolveDate('2026-13-01', NOW, 'dateFrom')).toThrow(/not a valid date/);
    });

    it('resolveDateWindow: dateRange is a shortcut that dateFrom overrides; from > to is an error', () => {
        expect(resolveDateWindow(opts({ dateRange: '7d' }), NOW)).toEqual({ dateFrom: '2026-08-31', dateTo: null });
        expect(resolveDateWindow(opts({ dateRange: '7d', dateFrom: '2026-09-01' }), NOW)).toEqual({ dateFrom: '2026-09-01', dateTo: null });
        expect(() => resolveDateWindow(opts({ dateFrom: '2026-09-05', dateTo: '2026-09-01' }), NOW)).toThrow(/dateFrom is after dateTo/);
    });
});

describe('request payload (exact MFMP body)', () => {
    it('carries EVERY key the portal requires, with vendor-only fields left empty', () => {
        const payload = buildSearchPayload(buildFilters(opts(), null, NOW), 1);
        expect(Object.keys(payload).sort()).toEqual(
            [
                'pageSize',
                'type',
                'status',
                'agency',
                'adNumber',
                'agencyAdvertisementNumber',
                'title',
                'publishedDate',
                'openDate',
                'endDate',
                'commodityCodes',
                'intendsToParticipate',
                'assignee',
                'page',
            ].sort(),
        );
        expect(payload).toMatchObject({ pageSize: 100, type: [], status: ['OPEN'], agency: [], title: '', publishedDate: '', intendsToParticipate: '', assignee: '', page: 1 });
        expect(PAGE_SIZE).toBe(100);
    });

    it('canonicalises filter order and pushes a one-day publish window server-side', () => {
        const filters = buildFilters(
            opts({ statuses: ['CLOSED', 'open'], types: ['6', '4'], agencyIds: ['30000021', '30000019'], commodityCodes: ['83112403', '83112200'], dateFrom: '2026-09-02', dateTo: '2026-09-02', openBefore: '2026-01-01', closesAfter: '2026-12-01', agencyAdNumberContains: ' DOT ' }),
            'software',
            NOW,
        );
        expect(filters).toMatchObject({
            statuses: ['OPEN', 'CLOSED'],
            types: ['4', '6'],
            agencyIds: ['30000019', '30000021'],
            commodityCodes: ['83112200', '83112403'],
            title: 'software',
            publishedDate: '2026-09-02',
            openDate: '2026-01-01',
            endDate: '2026-12-01',
            agencyAdNumber: 'DOT',
        });
        expect(describeFilters(filters)).toContain('title~"software"');
        const wide = buildFilters(opts({ dateFrom: '2026-09-01', dateTo: '2026-09-02' }), null, NOW);
        expect(wide.publishedDate).toBeNull(); // a wider window is filtered client-side
    });

    it('an empty statuses array falls back to OPEN like the legacy', () => {
        expect(buildFilters(opts({ statuses: [] }), null, NOW).statuses).toEqual(['OPEN']);
    });
});

describe('listing validation (a blocked or altered endpoint must never read as "0 results")', () => {
    it('accepts the real captured pages and the empty end-of-results page', () => {
        expect(assertListingPage(page1, 1)).toHaveLength(100);
        expect(assertListingPage(page2, 2)).toHaveLength(64);
        expect(assertListingPage(jsonFixture('florida_listing_open_page3_empty.json'), 3)).toEqual([]);
        expect(new Set(register.map((r) => r.advertisementId)).size).toBe(164);
        // The legacy /count capture agrees with the two captured pages (a bare integer, no JSON wrapper).
        expect(Number(fixture('florida_count_open.txt'))).toBe(register.length);
    });

    it('rejects a non-array and a row without the identity fields', () => {
        expect(() => assertListingPage({ errorMessage: 'x' }, 1)).toThrow(SourceFetchError);
        expect(() => assertListingPage([{ title: 'no id' }], 2)).toThrow(/listing schema changed/);
    });
});

describe('buildPayload / toSourceRecord against the real captured records', () => {
    it('listing row + detail: legacy field names and values (Agency Decision 16672)', () => {
        const p = buildPayload(row16672, { detail: detail16672, error: null }, NOW);
        expect(p).toMatchObject({
            source_url: `${BASE}/search/bids/detail/16672`,
            advertisementId: 16672,
            uniqueName: 'AD-16672',
            agencyAdNumber: 'IA-27-044',
            title: 'Intent to Award Single Source Provider to Mobex',
            type: 'Agency Decision',
            typeId: '1',
            status: 'OPEN',
            version: 1,
            isAmended: false,
            isAwardNotice: true,
            isSingleSource: false,
            agency: 'Florida School for the Deaf and the Blind (FSDB)',
            organizationId: 30000019,
            organizationShortName: 'FSDB',
            organizationEntity: '489000',
            publishDateUtc: '2026-08-13T17:39:51.000Z',
            openDateLocal: '2026-09-03 16:30 EDT',
            closeDateLocal: '2026-09-09 16:30 EDT',
            publishDay: '2026-08-13',
            closeDay: '2026-09-09',
            responseWindowDays: 6,
            daysUntilClose: 2,
            isOpenForResponses: true,
            detailFetched: true,
            detailError: null,
            currency: 'USD',
            lastUpdateDateUtc: '2026-08-13T17:39:51.000Z',
            responseDateUtc: '2026-09-09T20:30:00.000Z',
            linkedAdNumber: '16671',
            linkedAdUrl: `${BASE}/search/bids/detail/16671`,
            publishOption: 'Schedule Start',
            withdrawn: false,
            timeRemainingMs: 424074025,
            commodityCodeIds: ['83112200', '83112403'],
            commodityCodesText: '83112200 Enhanced telecommunications services; 83112403 Point to point digital telecommunications circuit',
            documentCount: 1,
            latestDocumentDateUtc: '2026-08-13T17:39:44.000Z',
            contactName: 'Kim Whitwam',
            contactAddress: '207 San Marco Ave.',
            contactCity: 'SAINT AUGUSTINE',
            contactState: 'FL',
            contactZip: '32084',
            minorityEncouraged: false,
            rightToReject: false,
        });
        expect((p.documents as Array<Record<string, unknown>>)[0]).toMatchObject({
            fileName: '3-Mobex IA-27-044.docx',
            attachmentId: 39311,
            downloadUrl: `${BASE}/mfmp/bids/detail/attachment/download?attachmentId=39311`,
            dateUtc: '2026-08-13T17:39:44.000Z',
        });
        expect(String(p.descriptionText)).toContain('Mobex, Inc.');
    });

    it('an amended multi-document ad (14963, v7, 9 documents) is flagged amended and counts its documents', () => {
        const p = buildPayload(row14963, { detail: detail14963, error: null }, NOW);
        expect(p).toMatchObject({ version: 7, isAmended: true, documentCount: 9, lastUpdateDateUtc: '2026-09-03T21:04:36.000Z', isOpenForResponses: true, isAwardNotice: false });
        expect((p.documents as unknown[]).length).toBe(9);
    });

    it('without detail the detail-only fields are null / empty and detailFetched is false', () => {
        const p = buildPayload(row16672, null, NOW);
        expect(p).toMatchObject({ detailFetched: false, detailError: null, description: null, descriptionText: null, documentCount: null, documents: [], contactName: null, linkedAdNumber: null, indicators: null, commodityCodes: [], amountsUsd: [], maxAmountUsd: null });
    });

    it('a NOT_FOUND detail is recorded as such and the listing fields still come through', () => {
        const p = buildPayload(row16672, { detail: null, error: 'NOT_FOUND' }, NOW);
        expect(p).toMatchObject({ detailFetched: false, detailError: 'NOT_FOUND', title: 'Intent to Award Single Source Provider to Mobex' });
    });

    it('isOpenForResponses is false after the close date and for a non-OPEN status (SYNTHETIC clock)', () => {
        expect(buildPayload(row16672, null, new Date('2026-09-10T00:00:00Z')).isOpenForResponses).toBe(false);
        expect(buildPayload({ ...row16672, status: 'CLOSED' }, null, NOW).isOpenForResponses).toBe(false);
        // 3.5 hours past the close: truncation toward zero gives 0, and it must be +0, not -0.
        expect(Object.is(buildPayload(row16672, null, new Date('2026-09-10T00:00:00Z')).daysUntilClose, 0)).toBe(true);
        expect(buildPayload(row16672, null, new Date('2026-09-12T00:00:00Z')).daysUntilClose).toBe(-2);
    });

    it('the payload carries no router-owned and no legacy delta-engine keys', () => {
        const p = buildPayload(row16672, { detail: detail16672, error: null }, NOW);
        for (const key of [...ROUTER_OWNED_KEYS, ...LEGACY_DELTA_KEYS]) expect(p, key).not.toHaveProperty(key);
    });

    it('recordId is the advertisement id and the fingerprint is stable across clocks (clock-derived fields are excluded)', () => {
        const a = toSourceRecord(row16672, { detail: detail16672, error: null }, NOW);
        const later = toSourceRecord(row16672, { detail: detail16672, error: null }, new Date('2026-09-08T12:00:00Z'));
        expect(a.recordId).toBe('16672');
        expect(a.payload.daysUntilClose).not.toBe(later.payload.daysUntilClose);
        expect(a.fingerprint).toBe(later.fingerprint);
        expect(a.watchText).toBe('Florida School for the Deaf and the Blind (FSDB) Intent to Award Single Source Provider to Mobex');
    });

    it('the fingerprint changes on a version bump, a status flip, an addendum document and a recovered detail fetch', () => {
        const base = toSourceRecord(row16672, { detail: detail16672, error: null }, NOW).fingerprint;
        expect(toSourceRecord({ ...row16672, version: 2 }, { detail: detail16672, error: null }, NOW).fingerprint).not.toBe(base);
        expect(toSourceRecord({ ...row16672, status: 'CLOSED' }, { detail: detail16672, error: null }, NOW).fingerprint).not.toBe(base);
        expect(toSourceRecord({ ...row16672, closeDate: '2026-09-20T20:30:00.000+00:00' }, { detail: detail16672, error: null }, NOW).fingerprint).not.toBe(base);
        const withAddendum: DetailData = { ...detail16672, docs: [...(detail16672.docs ?? []), { attachmentId: 99999, fileName: 'Addendum 1.pdf', description: null, date: '2026-09-05T12:00:00.000+00:00', version: null, docFor: 'advertisementDocuments' }] };
        expect(toSourceRecord(row16672, { detail: withAddendum, error: null }, NOW).fingerprint).not.toBe(base);
        // A transient detail failure first, then success: the record must re-emit once the detail is there.
        const failed = toSourceRecord(row16672, { detail: null, error: 'MFMP answered HTTP 503' }, NOW).fingerprint;
        expect(failed).not.toBe(base);
    });

    it('sortNewestFirst orders by publish instant then id, descending', () => {
        const sorted = sortNewestFirst(register);
        const expected = [...register].sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime() || b.advertisementId - a.advertisementId);
        expect(sorted.map((r) => r.advertisementId)).toEqual(expected.map((r) => r.advertisementId));
        expect(sorted[0]?.publishDate).toBe('2026-09-04T19:31:19.000+00:00');
    });
});

describe('client-side filters', () => {
    const none = sanitizeKeywordList(undefined);

    it('agency keyword matches the agency name or short name case-insensitively; an empty list filters nothing', () => {
        const fdot = sanitizeKeywordList(['fdot']);
        expect(register.filter((r) => passesClientFilters(r, { agencyNames: fdot, dateFrom: null, dateTo: null }))).toHaveLength(20);
        const transport = sanitizeKeywordList(['Department of Transportation']);
        expect(register.filter((r) => passesClientFilters(r, { agencyNames: transport, dateFrom: null, dateTo: null }))).toHaveLength(20);
        expect(register.filter((r) => passesClientFilters(r, { agencyNames: none, dateFrom: null, dateTo: null }))).toHaveLength(164);
    });

    it('the publish-day window is inclusive on both ends and excludes rows with no parseable date', () => {
        const day = (d: string) => register.filter((r) => utcCalendarDay(r.publishDate) === d).length;
        const filtered = register.filter((r) => passesClientFilters(r, { agencyNames: none, dateFrom: '2026-09-03', dateTo: '2026-09-04' }));
        expect(filtered).toHaveLength(day('2026-09-03') + day('2026-09-04'));
        expect(passesClientFilters({ ...row16672, publishDate: 'garbage' }, { agencyNames: none, dateFrom: '2026-01-01', dateTo: null })).toBe(false);
    });
});

describe('fetch (stubbed http, real captured register)', () => {
    it('walks the whole OPEN register (count -> 2 pages), newest-published first, with no detail requests when fetchDetail=false', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const records = await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false }), RUN);
        expect(records).toHaveLength(164);
        expect(records[0]?.recordId).toBe(String(sortNewestFirst(register)[0]?.advertisementId));
        expect(new Set(records.map((r) => r.recordId)).size).toBe(164);
        const urls = stub.requests.map((r) => `${r.method} ${r.url}`);
        expect(urls.filter((u) => u === `POST ${COUNT}`)).toHaveLength(1);
        expect(urls.filter((u) => u === `POST ${SEARCH}`)).toHaveLength(2);
        expect(urls.some((u) => u.startsWith(`GET ${DETAIL}`))).toBe(false);
        const pages = stub.requests.filter((r) => r.url === SEARCH).map((r) => (r.body as { page: number }).page);
        expect(pages.sort()).toEqual([1, 2]);
    });

    it('sends the Accept: application/json gate header on every request and never sets a User-Agent (no impersonation)', async () => {
        const stub = makeCtx(floridaServer({ details: { 16672: detail16672 } }), '2026-09-07T00:00:00Z');
        await usFloridaConnector.fetch(stub.ctx, opts({ adNumber: '16672' }), RUN);
        expect(stub.requests.length).toBeGreaterThanOrEqual(3);
        for (const request of stub.requests) {
            expect(request.headers.accept, `${request.method} ${request.url}`).toBe('application/json');
            expect(request.headers).not.toHaveProperty('user-agent');
            expect(request.headers).not.toHaveProperty('accept-language');
            if (request.method === 'POST') expect(request.headers['content-type']).toBe('application/json');
            expect(request.via).toBe('getJson');
        }
    });

    it('maxItemsPerSource keeps the NEWEST published records and fetches detail only for those', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const records = await usFloridaConnector.fetch(stub.ctx, opts(), { maxItemsPerSource: 10 });
        expect(records).toHaveLength(10);
        expect(records.map((r) => r.recordId)).toEqual(sortNewestFirst(register).slice(0, 10).map((r) => String(r.advertisementId)));
        expect(stub.requests.filter((r) => r.url.startsWith(`${DETAIL}?id=`))).toHaveLength(10);
        expect(stub.logs.warning.some((m) => /maxItemsPerSource=10/.test(m) && /154 oldest-published/.test(m))).toBe(true);
    });

    it('fetches detail for the selected ad and builds the full record (adNumber filter)', async () => {
        const stub = makeCtx(floridaServer({ details: { 16672: detail16672 } }), '2026-09-07T00:00:00Z');
        const records = await usFloridaConnector.fetch(stub.ctx, opts({ adNumber: 'AD-16672' }), RUN);
        expect(records).toHaveLength(1);
        expect(records[0]?.recordId).toBe('16672');
        expect(records[0]?.payload).toMatchObject({ detailFetched: true, linkedAdNumber: '16671', documentCount: 1, contactName: 'Kim Whitwam' });
        expect((stub.requests[0]?.body as { adNumber: string }).adNumber).toBe('16672');
    });

    it('an unknown-id detail (HTTP 200, every field null) degrades to a summary record flagged NOT_FOUND', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const [record] = await usFloridaConnector.fetch(stub.ctx, opts({ adNumber: '16672' }), RUN);
        expect(record?.payload).toMatchObject({ detailFetched: false, detailError: 'NOT_FOUND', title: 'Intent to Award Single Source Provider to Mobex' });
    });

    it('a failed detail request (anything but not-found) degrades that record only and is visible in the row; the fingerprint then changes when it recovers', async () => {
        const broken = makeCtx((request) => (request.url.startsWith(`${DETAIL}?id=`) ? new HttpStatusError(request.url, 503, '') : floridaServer()(request)), '2026-09-07T00:00:00Z');
        const [degraded] = await usFloridaConnector.fetch(broken.ctx, opts({ adNumber: '16672' }), RUN);
        expect(degraded?.payload.detailFetched).toBe(false);
        expect(String(degraded?.payload.detailError)).toMatch(/HTTP 503/);
        expect(broken.logs.warning.some((m) => /detail fetch failed for AD-16672/.test(m))).toBe(true);

        const healthy = makeCtx(floridaServer({ details: { 16672: detail16672 } }), '2026-09-07T00:00:00Z');
        const [recovered] = await usFloridaConnector.fetch(healthy.ctx, opts({ adNumber: '16672' }), RUN);
        expect(recovered?.recordId).toBe(degraded?.recordId);
        expect(recovered?.fingerprint).not.toBe(degraded?.fingerprint);
    });

    it('a 404 / 410 detail is "not found", not an error', async () => {
        for (const status of [404, 410]) {
            const stub = makeCtx((request) => (request.url.startsWith(`${DETAIL}?id=`) ? new HttpStatusError(request.url, status, '') : floridaServer()(request)));
            expect(await fetchDetail(stub.ctx, 16672)).toBeNull();
        }
    });

    it('detail GETs honour maxConcurrency (never more in flight than allowed, but genuinely parallel)', async () => {
        const inFlight = { current: 0, max: 0 };
        const stub = makeCtx(floridaServer({ inFlight }), '2026-09-07T00:00:00Z');
        await usFloridaConnector.fetch(stub.ctx, opts({ maxConcurrency: 3 }), { maxItemsPerSource: 12 });
        expect(inFlight.max).toBeGreaterThan(1);
        expect(inFlight.max).toBeLessThanOrEqual(3);
    });

    it('keeps paging sequentially when the listing grew after /count and the last page came back full', async () => {
        const stub = makeCtx(floridaServer({ count: 100 }), '2026-09-07T00:00:00Z'); // count says 1 page, the server really has 2
        const records = await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false }), RUN);
        expect(records).toHaveLength(164);
        expect(stub.requests.filter((r) => r.url === SEARCH)).toHaveLength(2);
    });

    it('collapses a row that appears on two pages because the listing shifted mid-walk (SYNTHETIC)', async () => {
        const dupRows = [...page1, page1[0] as ListingItem]; // 101 rows: page 2 re-serves page 1's first row
        const stub = makeCtx(floridaServer({ rows: dupRows }), '2026-09-07T00:00:00Z');
        const records = await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false }), RUN);
        expect(records).toHaveLength(100);
    });

    it('statuses / types / agencies / commodity codes are sent to the portal verbatim', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false, statuses: ['open', 'closed'], types: ['Request for Proposals'], agencyIds: ['30000021'], commodityCodes: ['83112200'] }), RUN);
        expect(stub.requests[0]?.body).toMatchObject({ status: ['OPEN', 'CLOSED'], type: ['6'], agency: ['30000021'], commodityCodes: ['83112200'], page: 1 });
    });

    it('client-side agency and date-window filters apply after the walk', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const fdot = await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false, agencyNameContains: ['FDOT'] }), RUN);
        expect(fdot).toHaveLength(20);
        expect(fdot.every((r) => /FDOT/.test(String(r.payload.agency)))).toBe(true);

        const week = await usFloridaConnector.fetch(makeCtx(floridaServer(), '2026-09-07T00:00:00Z').ctx, opts({ fetchDetail: false, dateRange: '7d' }), RUN);
        expect(week).toHaveLength(register.filter((r) => (utcCalendarDay(r.publishDate) ?? '') >= '2026-08-31').length);
        expect(week.every((r) => String(r.payload.publishDay) >= '2026-08-31')).toBe(true);
    });

    it('a one-day window is pushed server-side AND applied client-side', async () => {
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const records = await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false, dateFrom: '2026-09-02', dateTo: '2026-09-02' }), RUN);
        expect((stub.requests[0]?.body as { publishedDate: string }).publishedDate).toBe('2026-09-02');
        expect(records).toHaveLength(register.filter((r) => utcCalendarDay(r.publishDate) === '2026-09-02').length);
    });

    it('a title keyword is applied server-side; several keywords are separate walks whose results are unioned', async () => {
        const one = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const software = await usFloridaConnector.fetch(one.ctx, opts({ fetchDetail: false, titleContains: 'software' }), RUN);
        expect(software.map((r) => r.recordId).sort()).toEqual(['16700', '16821', '16833']);
        expect(one.requests.filter((r) => r.url === SEARCH).every((r) => (r.body as { title: string }).title === 'software')).toBe(true);

        const two = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        const both = await usFloridaConnector.fetch(two.ctx, opts({ fetchDetail: false, titleContains: ['software', 'security', 'SOFTWARE'] }), RUN);
        expect(both.map((r) => r.recordId).sort()).toEqual(['14199', '16700', '16821', '16833']);
        expect(two.requests.filter((r) => r.url === COUNT)).toHaveLength(2); // the case-insensitive duplicate collapsed
    });

    it('keyword guard: blank / one-character / punctuation title and agency lists mean "no filtering", never a vacuous match or an empty result', async () => {
        for (const bad of [[''], [' '], ['a'], ['--'], [null], ''] as unknown[]) {
            const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
            const records = await usFloridaConnector.fetch(
                stub.ctx,
                { ...opts({ fetchDetail: false }), titleContains: bad as never, agencyNameContains: bad as never },
                RUN,
            );
            expect(records, JSON.stringify(bad)).toHaveLength(164);
            expect(stub.requests.filter((r) => r.url === SEARCH).every((r) => (r.body as { title: string }).title === '')).toBe(true);
            expect(stub.logs.warning.some((m) => /No valid keyword remained/.test(m)), JSON.stringify(bad)).toBe(true);
        }
    });

    it('queries at most 10 title keywords and says so', async () => {
        const keywords = Array.from({ length: 12 }, (_, i) => `keyword${i}`);
        const stub = makeCtx(floridaServer(), '2026-09-07T00:00:00Z');
        await usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false, titleContains: keywords }), RUN);
        expect(stub.requests.filter((r) => r.url === COUNT)).toHaveLength(10);
        expect(stub.logs.warning.some((m) => /only the first 10 are queried/.test(m))).toBe(true);
    });

    it('an empty result set returns [] and no detail requests', async () => {
        const stub = makeCtx(floridaServer({ rows: [] }), '2026-09-07T00:00:00Z');
        expect(await usFloridaConnector.fetch(stub.ctx, opts(), RUN)).toEqual([]);
        expect(stub.requests.some((r) => r.url.startsWith(`${DETAIL}?id=`))).toBe(false);
    });

    it('an invalid date window fails the source with a precise message', async () => {
        const stub = makeCtx(floridaServer());
        await expect(usFloridaConnector.fetch(stub.ctx, opts({ dateFrom: '2026-09-05', dateTo: '2026-09-01' }), RUN)).rejects.toThrow(/invalid us_florida options: dateFrom is after dateTo/);
        expect(stub.requests).toHaveLength(0);
    });
});

describe('failure paths (SourceFetchError)', () => {
    it('a 400 surfaces MFMP\'s own errorMessage from the real captured body', async () => {
        const stub = makeCtx(() => new HttpStatusError(COUNT, 400, fixture('florida_error_400.json')));
        const error = await usFloridaConnector.fetch(stub.ctx, opts(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('us_florida');
        expect((error as Error).message).toMatch(/MFMP rejected the request \(HTTP 400\): We could not complete this action\./);
    });

    it('the Angular index.html shell (a non-JSON body, as the real http client reports it) fails loudly instead of reading as "0 results"', async () => {
        expect(fixture('florida_index_shell.html')).toMatch(/<!DOCTYPE html>/);
        const stub = makeCtx(() => new SyntaxError('Unexpected token < in JSON at position 0'));
        await expect(usFloridaConnector.fetch(stub.ctx, opts(), RUN)).rejects.toThrow(/not JSON \(typically the Angular index\.html shell\)/);
    });

    it('401 (vendor-only), 429 and 5xx and network failures each get a distinct message', () => {
        expect(describeMfmpFailure(new HttpStatusError(COUNT, 401, ''), COUNT)).toMatch(/vendor-login only/);
        expect(describeMfmpFailure(new HttpStatusError(COUNT, 429, ''), COUNT)).toMatch(/rate-limited.*lower maxConcurrency/);
        expect(describeMfmpFailure(new HttpStatusError(COUNT, 503, 'down'), COUNT)).toMatch(/HTTP 503/);
        expect(describeMfmpFailure(new TypeError('fetch failed'), COUNT)).toMatch(/network-level failure.*fetch failed/);
    });

    it('a count that is not an integer, a non-array page, and a failure on page 2 each fail the source', async () => {
        await expect(usFloridaConnector.fetch(makeCtx(floridaServer({ count: 'many' })).ctx, opts(), RUN)).rejects.toThrow(/instead of an integer/);
        await expect(usFloridaConnector.fetch(makeCtx((r) => (r.url === COUNT ? 3 : { not: 'an array' })).ctx, opts(), RUN)).rejects.toThrow(/not a JSON array/);
        const server = floridaServer();
        const stub = makeCtx((request) => (request.url === SEARCH && (request.body as { page: number }).page === 2 ? new HttpStatusError(SEARCH, 500, '') : server(request)));
        await expect(usFloridaConnector.fetch(stub.ctx, opts({ fetchDetail: false }), RUN)).rejects.toBeInstanceOf(SourceFetchError);
    });

    it('fetchDetail rejects a detail body that is not an object', async () => {
        const stub = makeCtx(() => [1, 2, 3]);
        await expect(fetchDetail(stub.ctx, 1)).rejects.toThrow(/not a JSON object/);
    });

    it('mapWithConcurrency preserves order and reports the first error after in-flight work settles', async () => {
        const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 2);
        expect(results).toEqual([2, 4, 6, 8]);
        await expect(
            mapWithConcurrency([1, 2, 3], 2, async (n) => {
                if (n === 2) throw new Error('boom');
                return n;
            }),
        ).rejects.toThrow('boom');
    });
});

describe('through the real router', () => {
    const engineInput = (extra: Record<string, unknown> = {}) => ({
        sources: ['us_florida'],
        sourceOptions: { us_florida: { fetchDetail: false } },
        deltaMode: 'onlyChanged',
        maxItemsPerSource: 500,
        ...extra,
    });

    it('first run emits the whole register as first_seen; an identical second run emits nothing and bills nothing', async () => {
        const store = new InMemoryDeltaStore();
        const first = await runThroughRouter(usFloridaConnector, engineInput(), makeCtx(floridaServer(), '2026-09-07T00:00:00Z'), store);
        expect(first.rows).toHaveLength(164);
        expect(first.summary.sources[0]).toMatchObject({ source: 'us_florida', fetched: 164, emitted: 164, firstSeen: 164 });
        expect(first.rows[0]).toMatchObject({ engine: 'latam-global-tender-intelligence', source: 'us_florida', delta_status: 'first_seen', is_new: true, is_watchlist_match: false });
        expect(first.billing.totalFor(RESULT_EVENT)).toBe(164);

        // Same data, a LATER clock: clock-derived fields change but nothing is a consumer-visible change.
        const second = await runThroughRouter(usFloridaConnector, engineInput(), makeCtx(floridaServer(), '2026-09-08T09:00:00Z'), store, undefined, '2026-09-08T09:00:00Z');
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 164, emitted: 0, unchanged: 164 });
        expect(second.billing.totalFor(RESULT_EVENT)).toBe(0);
    });

    it('an addendum (version bump) and a status flip re-emit exactly those two ads as "updated"', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(usFloridaConnector, engineInput(), makeCtx(floridaServer(), '2026-09-07T00:00:00Z'), store);

        const edited = register.map((r) => (r.advertisementId === 16672 ? { ...r, version: 2 } : r.advertisementId === 14963 ? { ...r, status: 'CLOSED' as const } : r));
        const next = await runThroughRouter(usFloridaConnector, engineInput(), makeCtx(floridaServer({ rows: edited }), '2026-09-07T00:00:00Z'), store);
        expect(next.rows.map((r) => [r.record_id, r.delta_status, r.version, r.status])).toEqual(
            expect.arrayContaining([
                ['16672', 'updated', 2, 'OPEN'],
                ['14963', 'updated', 7, 'CLOSED'],
            ]),
        );
        expect(next.rows).toHaveLength(2);
    });

    it('a watchlist keyword matches the agency + title text and bills one watchlist-hit per hit; ghost-billing inputs bill none', async () => {
        const hit = await runThroughRouter(usFloridaConnector, engineInput({ watchlistNames: ['Mobex'] }), makeCtx(floridaServer(), '2026-09-07T00:00:00Z'));
        expect(hit.rows.filter((r) => r.is_watchlist_match === true).map((r) => r.record_id)).toEqual(['16672']);
        expect(hit.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);

        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const none = await runThroughRouter(usFloridaConnector, engineInput({ watchlistNames }), makeCtx(floridaServer(), '2026-09-07T00:00:00Z'));
            expect(none.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(none.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('a portal failure is isolated to the source and reported', async () => {
        const result = await runThroughRouter(usFloridaConnector, engineInput(), makeCtx(() => new HttpStatusError(COUNT, 400, fixture('florida_error_400.json'))));
        expect(result.rows).toHaveLength(0);
        expect(result.summary.sources[0]?.error).toMatch(/MFMP rejected the request/);
    });

    it('rejects a bad option in preflight before any request', () => {
        const input = EngineInputSchema.parse({ sources: ['us_florida'], sourceOptions: { us_florida: { agencyIds: ['FDOT'] } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [usFloridaConnector] }, input)).toThrow(FatalConfigError);
    });
});
