/**
 * usFlorida.ts - State of Florida MyFloridaMarketPlace (MFMP) Vendor Information Portal bids connector.
 *
 * Absorbs `florida-tenders-monitor` (src/api.ts, src/fetchTenders.ts walk/enrich logic, src/normalize.ts,
 * src/parsers/record.ts and the option semantics of src/input.ts). Also the stub
 * `delta-registry-florida-tenders-stub`, which has no code of its own.
 *
 * NOT ported, because the router owns them: src/main.ts, src/state.ts (seen map, baseline/backlog floors),
 * the NEW_LISTING / UPDATED / STATUS_CHANGE / UNCHANGED classifier, `eventTypes`, `onlyNew`, `deltaStateName`,
 * `resetState`, `maxItems`, Actor.pushData and the `result` / `result-summary` charges.
 *
 * COMPLIANCE: THE LEGACY TLS-IMPERSONATION LAYER IS DELIBERATELY NOT PORTED
 * -------------------------------------------------------------------------
 * The legacy src/http.ts routes every request through `impit` with a Chrome TLS/HTTP2 fingerprint and a
 * Chrome User-Agent ("fleet-wide TLS-fingerprint-hardening pilot", 2026-09-19). The engine doctrine forbids
 * fingerprint spoofing, so this connector uses `ctx.http` only (Node fetch, honest User-Agent). That works
 * for this host (see the verification block): the ONLY gate is the `Accept: application/json` header, which
 * is content negotiation, not bot detection - the portal's own Angular search page sends the same header.
 *
 * TERMS OF USE (read in full by the legacy author on 2026-09-08, PUR 3775 / Rule 60A-1.033 F.A.C.)
 * ------------------------------------------------------------------------------------------------
 * It is a vendor-registration agreement; s.5 licenses REGISTERED vendors to print/download content for
 * non-commercial use; nothing in the 17 sections mentions automated access, robots or rate limits. This
 * connector never registers or logs in, never touches vendor-only endpoints (`intendsToParticipate`,
 * `assignee`), extracts only the factual elements of statutory public notices (Florida Statutes ch. 119;
 * advertised under s. 287.042(3)(b) F.S.) and LINKS to attachments instead of downloading them. Whether a
 * given downstream use is acceptable is the operator's decision; this note is disclosure, not a licence.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Legacy (2026-09-04/07/08, AGENTS.md): endpoints, the Accept gate, the 14-key listing row, the 36-key
 * detail, the all-null detail for an unknown id, the 400 `errorMessage` body, `pageSize` silently capped at
 * 100, the empty array as the only end-of-results marker, no sort parameter (rows come ordered by type name
 * then advertisementId ascending) and a 429 on the LISTING endpoint at 8-10 concurrent requests.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy, honest User-Agent
 * "awesome-regulatory-monitors/0.1 (+https://github.com/stefanoseggio)", no impersonation):
 *   POST https://vendor.myfloridamarketplace.com/mfmp/pub/search/bids
 *     headers Content-Type: application/json, Accept: application/json
 *     body {"pageSize":3,"type":[],"status":["OPEN"],"agency":[],"adNumber":"","agencyAdvertisementNumber":"",
 *           "title":"","publishedDate":"","openDate":"","endDate":"","commodityCodes":[],
 *           "intendsToParticipate":"","assignee":"","page":1}
 *     -> HTTP 200, content-type application/json; charset=utf-8, a JSON array of 3 rows with exactly the
 *        legacy 14 keys (agencyAdNumber, type, title, openDate, closeDate, favorite, status, typeId, version,
 *        advertisementId, uniqueName, publishDate, organization{organizationId, entity, shortName, vbsAgency,
 *        version, name}, agency). Timestamps are "+00:00" UTC instants.
 *   POST .../mfmp/pub/search/bids/count (same body, pageSize 1) -> HTTP 200 application/json, the bare integer 168.
 *   GET  .../mfmp/pub/search/bids/detail?id=17274 with Accept: application/json -> HTTP 200 application/json, 36 keys,
 *        1 document. The SAME request WITHOUT the Accept header -> HTTP 200 with the "<!DOCTYPE html>" Angular shell:
 *        the gate is content negotiation, as the legacy notes say. id=999999999 -> HTTP 200 with every field null.
 *   POST .../count with a wrongly typed filter (`type: ["Request for Proposals"]`, a label instead of the id "6") ->
 *        HTTP 400 application/json {"errorMessage":"We could not complete this action. Please contact the MFMP Help Desk
 *        at 866-FLA-EPRO (866-352-3776) for assistance.","errorId":null}, byte-for-byte the legacy error_400 fixture.
 *   End to end: this connector, driven through lib/http.ts createHttpClient (Node fetch, honest User-Agent) against the
 *   live portal with fetchDetail=true, walked the OPEN register (168 rows on 2 pages) and returned 6 fully populated
 *   records, detail included.
 *   The listing/detail/error FIXTURES used by the tests are the legacy actor's real captures of 2026-09-07 (copied
 *   verbatim, see test/tenders-b.usFlorida.test.ts); this session verified the live shapes above but did not re-capture
 *   those files.
 * ============================================================================
 *
 * OVERLAP NOTE: `emerging-market-sovereign-debt-auction-monitor` does not overlap this source.
 */
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { describeSanitization, findKeywordMatch, type SanitizedKeywordList, sanitizeKeywordList } from '../../lib/_guards.js';
import { DATE_RANGES, dateRangeToFrom, fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const FLORIDA_BASE_URL = 'https://vendor.myfloridamarketplace.com';
export const SEARCH_PATH = '/mfmp/pub/search/bids';
export const COUNT_PATH = '/mfmp/pub/search/bids/count';
export const DETAIL_PATH = '/mfmp/pub/search/bids/detail';

/** The server silently caps pageSize at 100 (pageSize 500 -> 100 rows). */
export const PAGE_SIZE = 100;
/** Runaway guard only: the whole register (OPEN + CLOSED + WITHDRAWN) is ~137 pages of 100. */
export const PAGE_CAP = 300;
/** A title keyword costs one full listing walk each, so only the first few are honoured. */
export const MAX_TITLE_QUERIES = 10;
const REQUEST_TIMEOUT_MS = 30_000;

export const DATA_SOURCE_ATTRIBUTION =
    'MyFloridaMarketPlace Vendor Information Portal (vendor.myfloridamarketplace.com), Florida Department of Management Services - public records under Florida Statutes ch. 119';

/** GET /mfmp/bids/AdTypes, captured by the legacy actor 2026-09-07. Ids are what the `type` filter expects (as strings). */
export const AD_TYPES: Readonly<Record<string, string>> = {
    '1': 'Agency Decision',
    '2': 'Grant Opportunities',
    '3': 'Informational Notice',
    '4': 'Invitation to Bid',
    '5': 'Invitation to Negotiate',
    '6': 'Request for Proposals',
    '7': 'Public Meeting Notice',
    '8': 'Request for Information',
    '9': 'Request for Statement of Qualifications',
    '10': 'Single Source',
};

export const AD_STATUSES = ['OPEN', 'CLOSED', 'WITHDRAWN', 'PREVIEW'] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

// ---------------------------------------------------------------------------
// Types (legacy src/types.ts, trimmed to what the connector reads)
// ---------------------------------------------------------------------------

export interface Organization {
    organizationId: number;
    entity: string | null;
    shortName: string | null;
    name: string | null;
    vbsAgency?: boolean;
    version?: number;
}

/** One entry of the POST /mfmp/pub/search/bids response array. */
export interface ListingItem {
    advertisementId: number;
    uniqueName: string;
    agencyAdNumber: string | null;
    title: string;
    type: string;
    typeId: string;
    status: AdStatus;
    /** Amendment counter - rises on every agency edit. 0 on some 2022 records. */
    version: number;
    openDate: string;
    closeDate: string;
    publishDate: string;
    organization: Organization;
    agency: string;
    favorite?: boolean;
}

export interface CommodityCode {
    id: string;
    value: string;
}

export interface AdDocument {
    attachmentId: number;
    fileName: string;
    description: string | null;
    date: string | null;
    version: number | null;
    docFor: string | null;
}

export interface ResponseContact {
    responseContact: string | null;
    email: string | null;
    ph: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
}

export interface Indicators {
    minorityEncouraged: boolean | null;
    preSolicitationConference: boolean | null;
    disabilitiesAct: boolean | null;
    rightToReject: boolean | null;
    agencyContactPeriod: boolean | null;
}

/** GET /mfmp/pub/search/bids/detail?id=N. An unknown id answers HTTP 200 with every field null. */
export interface DetailData {
    advertisementId: number | null;
    agencyAdNumber: string | null;
    linkedAdNumber: string | null;
    openDate: string | null;
    publishOption: string | null;
    closeDate: string | null;
    responseDate: string | null;
    lastUpdateDate: string | null;
    publishedDate: string | null;
    type: string | null;
    agency: string | null;
    title: string | null;
    description: string | null;
    status: AdStatus | null;
    commodityCodes: CommodityCode[] | null;
    indicators: Partial<Record<keyof Indicators, unknown>> | null;
    docs: AdDocument[] | null;
    responseContact: ResponseContact | null;
    version: number | null;
    uniqueName: string | null;
    timeRemaining: number | null;
    organization: Organization | null;
    withdrawn: boolean | null;
}

export interface DetailResult {
    detail: DetailData | null;
    /** null when detail was fetched, 'NOT_FOUND' when MFMP has no such ad, otherwise the failure message. */
    error: string | null;
}

/** Fully resolved server-side query for POST /mfmp/pub/search/bids. */
export interface SearchFilters {
    statuses: AdStatus[];
    /** AdTypes ids as strings ("1".."10") */
    types: string[];
    /** organization.organizationId values as strings */
    agencyIds: string[];
    title: string | null;
    adNumber: string | null;
    agencyAdNumber: string | null;
    /** YYYY-MM-DD, exact UTC calendar day of publishDate */
    publishedDate: string | null;
    /** YYYY-MM-DD, openDate on or before this day */
    openDate: string | null;
    /** YYYY-MM-DD, closeDate on or after this day */
    endDate: string | null;
    commodityCodes: string[];
}

// ---------------------------------------------------------------------------
// Pure normalisation helpers (legacy src/normalize.ts). Every function is total: invalid input yields null.
// ---------------------------------------------------------------------------

/**
 * MFMP timestamps are genuine UTC instants rendered with a "+00:00" offset (legacy-verified: an openDate of
 * 20:30Z is described in the advertisement body as "4:30 PM", i.e. Eastern Daylight Time). The portal is
 * operated from Tallahassee, so wall-clock twins use America/New_York - the clock a Florida vendor reads.
 */
export const SITE_TIME_ZONE = 'America/New_York';

const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
});

/** "2026-08-13T17:39:51.000+00:00" -> "2026-08-13T17:39:51.000Z" (canonical UTC form); null when unparseable. */
export function toUtcIso(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** UTC calendar day (YYYY-MM-DD) of an instant - the granularity of MFMP's own publishedDate filter. */
export function utcCalendarDay(value: string | null | undefined): string | null {
    const iso = toUtcIso(value);
    return iso ? iso.slice(0, 10) : null;
}

/** "2026-09-09T20:30:00.000+00:00" -> "2026-09-09 16:30 EDT" (Florida wall-clock). */
export function toSiteLocal(value: string | null | undefined): string | null {
    const iso = toUtcIso(value);
    if (!iso) return null;
    const parts = Object.fromEntries(localParts.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    const hour = String(Number(parts.hour) % 24).padStart(2, '0'); // Intl may render midnight as "24"
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * Signed whole days from `now` to `target` (truncated toward zero; negative once passed). `|| 0` normalises the `-0`
 * that truncation yields for a target a few hours in the past, which the legacy code let through.
 */
export function daysUntil(target: string | null | undefined, now: Date): number | null {
    const iso = toUtcIso(target);
    if (!iso) return null;
    return Math.trunc((new Date(iso).getTime() - now.getTime()) / 86_400_000) || 0;
}

/** Whole days between two instants (truncated toward zero). */
export function daysBetween(start: string | null | undefined, end: string | null | undefined): number | null {
    const a = toUtcIso(start);
    const b = toUtcIso(end);
    if (!a || !b) return null;
    return Math.trunc((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000) || 0;
}

/** Raw advertisement HTML -> readable plain text: block elements become line breaks, entities are decoded, whitespace collapses. */
export function htmlToText(html: string | null | undefined): string | null {
    if (!html) return null;
    const $ = cheerio.load(html, null, false);
    $('script, style').remove();
    $('br').replaceWith('\n');
    $('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table').each((_, el) => {
        $(el).append('\n');
    });
    const raw: string = $.root().text();
    const text = raw
        .replace(/ /g, ' ')
        .split('\n')
        .map((line: string) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line: string) => line !== '')
        .join('\n');
    return text === '' ? null : text;
}

/** Every "$1,234,567.89" style figure in a text, de-duplicated, in order of appearance. */
export function parseUsdAmounts(text: string | null | undefined): number[] {
    if (!text) return [];
    const out: number[] = [];
    const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
    for (const match of text.matchAll(re)) {
        const n = Number((match[1] ?? '').replace(/,/g, ''));
        if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
    return out;
}

/** "AD-16672" / "GO-14963" / " 16672 " -> "16672"; anything without digits -> null. */
export function normalizeAdNumber(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = value.replace(/^\s*[A-Za-z]{2,3}-?/, '').replace(/\D/g, '');
    return digits === '' ? null : String(Number(digits));
}

export function yesNoToBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'yes' || v === 'true') return true;
    if (v === 'no' || v === 'false') return false;
    return null;
}

/** Direct download link for an attachment. This connector only builds the URL; it never downloads bytes. */
export function attachmentDownloadUrl(attachmentId: number): string {
    return `${FLORIDA_BASE_URL}/mfmp/bids/detail/attachment/download?attachmentId=${attachmentId}`;
}

/** The public portal page of an advertisement (Angular route). */
export function detailPageUrl(advertisementId: number | string): string {
    return `${FLORIDA_BASE_URL}/search/bids/detail/${advertisementId}`;
}

function absoluteUrl(path: string): string {
    return new URL(path, FLORIDA_BASE_URL).href;
}

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

/** Resolves an AdTypes id ("6") or its label ("Request for Proposals", case-insensitive) to the id; null when unknown. */
export function resolveAdTypeId(value: string): string | null {
    const v = value.trim();
    if (AD_TYPES[v] !== undefined) return v;
    const byLabel = Object.entries(AD_TYPES).find(([, label]) => label.toLowerCase() === v.toLowerCase());
    return byLabel ? byLabel[0] : null;
}

const ABSOLUTE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_INPUT = /^(?:\d{4}-\d{2}-\d{2}|\d+\s*(?:day|week|month|year)s?|\d+[hd])$/i;

function isRealCalendarDate(value: string): boolean {
    const m = ABSOLUTE_DATE.exec(value);
    if (!m) return true; // not an absolute date: relative forms are checked by DATE_INPUT
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Accepts an absolute day ("2026-09-01") or a relative window ("7 days", "2 weeks", "3 months", "1 year", and the
 * legacy "24h" / "7d" presets). Relative windows count back from `now`'s UTC calendar date - the granularity
 * MFMP's own date filters use. Returns YYYY-MM-DD, or null when blank.
 */
export function resolveDate(value: string | undefined, now: Date, field: string): string | null {
    const v = value?.trim();
    if (!v) return null;
    if (ABSOLUTE_DATE.test(v)) {
        if (!isRealCalendarDate(v)) throw new Error(`${field} "${v}" is not a valid date`);
        return v;
    }
    const legacy = /^(\d+)([hd])$/i.exec(v);
    const relative = /^(\d+)\s*(day|week|month|year)s?$/i.exec(v);
    let amount: number;
    let unit: string;
    if (legacy) {
        amount = (legacy[2] ?? '').toLowerCase() === 'h' ? Math.max(1, Math.ceil(Number(legacy[1]) / 24)) : Number(legacy[1]);
        unit = 'day';
    } else if (relative) {
        amount = Number(relative[1]);
        unit = (relative[2] ?? '').toLowerCase();
    } else {
        throw new Error(`${field} must be YYYY-MM-DD or a relative window like "7 days" (got "${v}")`);
    }
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (unit === 'day') date.setUTCDate(date.getUTCDate() - amount);
    else if (unit === 'week') date.setUTCDate(date.getUTCDate() - amount * 7);
    else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() - amount);
    else date.setUTCFullYear(date.getUTCFullYear() - amount);
    return date.toISOString().slice(0, 10);
}

const dateInputSchema = z
    .string()
    .trim()
    .refine((v) => v === '' || (DATE_INPUT.test(v) && isRealCalendarDate(v)), {
        message: 'must be YYYY-MM-DD or a relative window like "7 days" / "2 weeks" / "3 months" / "24h"',
    })
    .optional();

const statusSchema = z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(AD_STATUSES));

const adTypeSchema = z.string().transform((value, ctx) => {
    const id = resolveAdTypeId(value);
    if (id === null) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown ad type "${value}" - use one of ${Object.entries(AD_TYPES)
                .map(([k, label]) => `${k} (${label})`)
                .join(', ')}`,
        });
        return z.NEVER;
    }
    return id;
});

const adNumberSchema = z
    .string()
    .trim()
    .transform((value, ctx) => {
        if (value === '') return undefined;
        const normalised = normalizeAdNumber(value);
        if (normalised === null) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `adNumber "${value}" should look like 16672 or AD-16672` });
            return z.NEVER;
        }
        return normalised;
    })
    .optional();

/** A keyword list: a string[] (documented), or one pasted string (split on newlines, commas, semicolons by the guard). */
const keywordInputSchema = z.union([z.array(z.string()), z.string()]).optional();

export const usFloridaOptionsSchema = z
    .object({
        /** Advertisement statuses to walk. UPPERCASE enum on the wire; case-insensitive here. Empty = OPEN. */
        statuses: z.array(statusSchema).default(['OPEN']),
        /** AdTypes ids ("6") or labels ("Request for Proposals"). Empty = every type. */
        types: z.array(adTypeSchema).default([]),
        /** MFMP `organization.organizationId` values (numeric, e.g. 30000021 for FDOT). */
        agencyIds: z.array(z.string().trim().regex(/^\d{4,12}$/, 'MFMP expects the numeric organizationId (e.g. 30000021 for FDOT), not a short name')).default([]),
        /** Case-insensitive title substring(s), applied server-side; one listing walk per keyword, results unioned. Read through sanitizeKeywordList. */
        titleContains: keywordInputSchema,
        /** Case-insensitive agency-name substring(s), applied client-side to the agency name + short name. Read through sanitizeKeywordList. */
        agencyNameContains: keywordInputSchema,
        /** Exact advertisement id, `16672` or `AD-16672`. */
        adNumber: adNumberSchema,
        /** Substring of the agency's own advertisement number (server-side). */
        agencyAdNumberContains: z.string().trim().optional(),
        /** Exact 8-digit UNSPSC codes (a prefix returns nothing); several = union. */
        commodityCodes: z.array(z.string().trim().regex(/^\d{8}$/, 'MFMP matches exact 8-digit UNSPSC codes only (a prefix such as "83" returns nothing)')).default([]),
        /** Client-side publish-day window (UTC calendar days, inclusive). Absolute or relative. */
        dateFrom: dateInputSchema,
        dateTo: dateInputSchema,
        /** Shortcut for `dateFrom` (24h | 7d | 30d | 90d | 365d); ignored when `dateFrom` is given. */
        dateRange: z.enum(DATE_RANGES).optional(),
        /** Server-side: openDate <= this day. */
        openBefore: dateInputSchema,
        /** Server-side: closeDate >= this day. */
        closesAfter: dateInputSchema,
        /** Fetch each advertisement's detail (description, documents, contact, commodity codes). One extra GET per record kept. */
        fetchDetail: z.boolean().default(true),
        /**
         * Emit the advertisement's response contact (name, e-mail, phone, address). Off by default: it identifies a natural
         * person. These are public statutory notices and the legacy actor emitted them, so a caller may opt in.
         */
        includeContactDetails: z.boolean().default(false),
        /** Parallel requests (listing pages and detail GETs). The listing endpoint answered 429 at 8-10 in flight, hence the low default. */
        maxConcurrency: z.number().int().min(1).max(10).default(5),
    })
    .strict();
export type UsFloridaOptions = z.infer<typeof usFloridaOptionsSchema>;

function resolveKeywordFilter(ctx: ConnectorContext, fieldName: string, input: unknown): SanitizedKeywordList {
    const list = sanitizeKeywordList(input);
    if (list.keywords.length > 0) {
        ctx.log.info(`[us_florida] ${describeSanitization(list, fieldName)}`);
    } else if (list.rejected.length > 0 || list.malformedContainer) {
        ctx.log.warning(`[us_florida] ${describeSanitization(list, fieldName)} No valid keyword remained, so NO ${fieldName} filtering is applied.`);
    }
    return list;
}

/** Resolves the client-side publish-day window. `dateRange` is a shortcut for `dateFrom` and is ignored when `dateFrom` is given. */
export function resolveDateWindow(
    options: Pick<UsFloridaOptions, 'dateFrom' | 'dateTo' | 'dateRange'>,
    now: Date,
): { dateFrom: string | null; dateTo: string | null } {
    const dateFrom = resolveDate(options.dateFrom, now, 'dateFrom') ?? (options.dateRange ? (dateRangeToFrom(options.dateRange, now) ?? null) : null);
    const dateTo = resolveDate(options.dateTo, now, 'dateTo');
    if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('dateFrom is after dateTo');
    return { dateFrom, dateTo };
}

/** Builds the exact server-side filter set. `title` is the single keyword this walk is for (null = no title filter). */
export function buildFilters(options: UsFloridaOptions, title: string | null, now: Date): SearchFilters {
    const statuses = options.statuses.length > 0 ? options.statuses : (['OPEN'] as AdStatus[]);
    const { dateFrom, dateTo } = resolveDateWindow(options, now);
    return {
        // Canonical order: the request must not depend on how the caller ordered the multi-select.
        statuses: AD_STATUSES.filter((s) => statuses.includes(s)),
        types: [...new Set(options.types)].sort((a, b) => Number(a) - Number(b)),
        agencyIds: [...new Set(options.agencyIds)].sort(),
        title,
        adNumber: options.adNumber ?? null,
        agencyAdNumber: options.agencyAdNumberContains?.trim() || null,
        // MFMP's publishedDate filter matches ONE UTC calendar day; a one-day window is pushed server-side, a wider one client-side.
        publishedDate: dateFrom && dateTo && dateFrom === dateTo ? dateFrom : null,
        openDate: resolveDate(options.openBefore, now, 'openBefore'),
        endDate: resolveDate(options.closesAfter, now, 'closesAfter'),
        commodityCodes: [...new Set(options.commodityCodes)].sort(),
    };
}

// ---------------------------------------------------------------------------
// Network layer (legacy src/api.ts over ctx.http)
// ---------------------------------------------------------------------------

/**
 * The exact body the portal's own search page posts. Every key must be present (a missing key or a wrongly
 * typed value -> HTTP 400); the vendor-only `intendsToParticipate` / `assignee` stay empty strings.
 */
export function buildSearchPayload(filters: SearchFilters, page: number, pageSize = PAGE_SIZE) {
    return {
        pageSize,
        type: filters.types,
        status: filters.statuses,
        agency: filters.agencyIds,
        adNumber: filters.adNumber ?? '',
        agencyAdvertisementNumber: filters.agencyAdNumber ?? '',
        title: filters.title ?? '',
        publishedDate: filters.publishedDate ?? '',
        openDate: filters.openDate ?? '',
        endDate: filters.endDate ?? '',
        commodityCodes: filters.commodityCodes,
        intendsToParticipate: '',
        assignee: '',
        page,
    };
}

/** Human-readable description of the query (for logs). */
export function describeFilters(filters: SearchFilters): string {
    const parts = [`status=${filters.statuses.join('|')}`];
    if (filters.types.length) parts.push(`type=${filters.types.map((t) => AD_TYPES[t] ?? t).join('|')}`);
    if (filters.agencyIds.length) parts.push(`agency=${filters.agencyIds.join('|')}`);
    if (filters.title) parts.push(`title~"${filters.title}"`);
    if (filters.adNumber) parts.push(`adNumber=${filters.adNumber}`);
    if (filters.agencyAdNumber) parts.push(`agencyAdNumber~"${filters.agencyAdNumber}"`);
    if (filters.commodityCodes.length) parts.push(`commodity=${filters.commodityCodes.join('|')}`);
    if (filters.publishedDate) parts.push(`publishedDate=${filters.publishedDate}`);
    if (filters.openDate) parts.push(`openDate<=${filters.openDate}`);
    if (filters.endDate) parts.push(`closeDate>=${filters.endDate}`);
    return parts.join(' ');
}

/** Explains a failed MFMP request in the legacy vocabulary (MfmpApiError / NotJsonError / outage). */
export function describeMfmpFailure(error: unknown, url: string): string {
    if (error instanceof HttpStatusError) {
        let apiMessage: string | null = null;
        try {
            const body = JSON.parse(error.bodyPreview) as { errorMessage?: unknown };
            if (typeof body.errorMessage === 'string') apiMessage = body.errorMessage;
        } catch {
            /* the body is not JSON (or was truncated by the HTTP client) - fall through */
        }
        if (error.status === 400) {
            return `MFMP rejected the request (HTTP 400): ${apiMessage ?? (error.bodyPreview || 'no body')} [${url}]`;
        }
        if (error.status === 401) return `MFMP answered HTTP 401 - that endpoint is vendor-login only and is not used by this connector [${url}]`;
        if (error.status === 429) return `MFMP rate-limited the request (HTTP 429) after retries; lower maxConcurrency [${url}]`;
        return `MFMP answered HTTP ${error.status}${apiMessage ? `: ${apiMessage}` : ''} [${url}]`;
    }
    if (error instanceof SyntaxError) {
        return `MFMP answered ${url} with a body that is not JSON (typically the Angular index.html shell). The Accept: application/json gate or the endpoint has changed; aborting instead of reporting "nothing new".`;
    }
    return `network-level failure reaching MFMP [${url}]: ${error instanceof Error ? error.message : String(error)}`;
}

async function postJson(ctx: ConnectorContext, path: string, body: unknown): Promise<unknown> {
    const url = absoluteUrl(path);
    try {
        return await ctx.http.getJson<unknown>(url, {
            method: 'POST',
            // CRITICAL (legacy-verified): every MFMP endpoint serves the SPA shell with HTTP 200 unless Accept: application/json is sent.
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
    } catch (error) {
        throw new SourceFetchError(describeMfmpFailure(error, url), 'us_florida');
    }
}

function isListingItem(value: unknown): value is ListingItem {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.advertisementId === 'number' &&
        typeof v.uniqueName === 'string' &&
        typeof v.status === 'string' &&
        typeof v.type === 'string' &&
        typeof v.publishDate === 'string'
    );
}

/** Validates that a search response really is a listing page, so a blocked or altered endpoint can never be reported as "0 results". */
export function assertListingPage(body: unknown, page: number): ListingItem[] {
    if (!Array.isArray(body)) {
        throw new SourceFetchError(`MFMP search page ${page} is not a JSON array (${typeof body}) - the endpoint contract changed.`, 'us_florida');
    }
    for (const row of body) {
        if (!isListingItem(row)) {
            throw new SourceFetchError(
                `MFMP search page ${page} contains a row without advertisementId/uniqueName/status/type/publishDate - the listing schema changed. Row: ${JSON.stringify(row).slice(0, 200)}`,
                'us_florida',
            );
        }
    }
    return body as ListingItem[];
}

async function fetchListingPage(ctx: ConnectorContext, filters: SearchFilters, page: number): Promise<ListingItem[]> {
    return assertListingPage(await postJson(ctx, SEARCH_PATH, buildSearchPayload(filters, page)), page);
}

/** POST /mfmp/pub/search/bids/count - the exact total for the filter set (a bare integer). */
async function fetchListingCount(ctx: ConnectorContext, filters: SearchFilters): Promise<number> {
    const body = await postJson(ctx, COUNT_PATH, buildSearchPayload(filters, 1));
    const n = typeof body === 'number' ? body : Number(body);
    if (!Number.isInteger(n) || n < 0) {
        throw new SourceFetchError(`MFMP count endpoint returned "${String(body)}" instead of an integer.`, 'us_florida');
    }
    return n;
}

/**
 * GET /mfmp/pub/search/bids/detail?id=N. Resolves to null when the advertisement is unknown: MFMP answers HTTP 200
 * with an all-null object (advertisementId null) rather than a 404, so that case is checked explicitly. A 404/410 is
 * also "unknown". Any other failure propagates to the caller, which degrades to a summary record.
 */
export async function fetchDetail(ctx: ConnectorContext, advertisementId: number): Promise<DetailData | null> {
    const url = absoluteUrl(`${DETAIL_PATH}?id=${advertisementId}`);
    let body: unknown;
    try {
        body = await ctx.http.getJson<unknown>(url, { headers: { accept: 'application/json' }, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
        if (error instanceof HttpStatusError && (error.status === 404 || error.status === 410)) return null;
        throw new Error(describeMfmpFailure(error, url));
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error(`MFMP detail ${advertisementId} is not a JSON object - the endpoint contract changed.`);
    }
    const detail = body as DetailData;
    if (detail.advertisementId === null || detail.advertisementId === undefined) return null;
    return detail;
}

/** Run `fn` over `items` with at most `concurrency` calls in flight, preserving order. Errors propagate after in-flight calls settle. */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    let failed = false;
    let firstError: unknown;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length && !failed) {
            const index = next;
            next += 1;
            try {
                results[index] = await fn(items[index] as T, index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    });
    await Promise.all(workers);
    if (failed) throw firstError;
    return results;
}

/**
 * Fetch every listing page for the filter set. MFMP has no sort parameter (rows come back by type name, then
 * advertisementId ascending, so new postings sit at the END of each type group and amendments anywhere), so
 * there is no page-level early stop; the exact total from /count lets the pages be fetched in parallel. The end
 * marker is an empty array.
 */
export async function fetchAllPages(ctx: ConnectorContext, filters: SearchFilters, maxConcurrency: number): Promise<{ rows: ListingItem[]; pagesWalked: number; totalMatching: number }> {
    const totalMatching = await fetchListingCount(ctx, filters);
    const expectedPages = Math.max(1, Math.ceil(totalMatching / PAGE_SIZE));
    const pageNumbers = Array.from({ length: Math.min(expectedPages, PAGE_CAP) }, (_, i) => i + 1);
    const pages = await mapWithConcurrency(pageNumbers, maxConcurrency, (page) => fetchListingPage(ctx, filters, page));
    let pagesWalked = pages.length;
    // The listing may have grown between /count and the page fetches: keep paging sequentially while pages come back full.
    let last = pages.at(-1) ?? [];
    while (last.length === PAGE_SIZE && pagesWalked < PAGE_CAP) {
        pagesWalked += 1;
        last = await fetchListingPage(ctx, filters, pagesWalked);
        pages.push(last);
    }
    if (pagesWalked >= PAGE_CAP) ctx.log.warning(`[us_florida] page cap (${PAGE_CAP}) reached - stopping the walk.`);
    return { rows: pages.flat(), pagesWalked, totalMatching };
}

// ---------------------------------------------------------------------------
// Record building (legacy src/parsers/record.ts buildRecord)
// ---------------------------------------------------------------------------

function indicatorsOf(detail: DetailData | null): Indicators | null {
    const raw = detail?.indicators;
    if (!raw || typeof raw !== 'object') return null;
    return {
        minorityEncouraged: yesNoToBoolean(raw.minorityEncouraged),
        preSolicitationConference: yesNoToBoolean(raw.preSolicitationConference),
        disabilitiesAct: yesNoToBoolean(raw.disabilitiesAct),
        rightToReject: yesNoToBoolean(raw.rightToReject),
        agencyContactPeriod: yesNoToBoolean(raw.agencyContactPeriod),
    };
}

function joinAddress(contact: ResponseContact | null): string | null {
    if (!contact) return null;
    const parts = [contact.address1, contact.address2].map((p) => p?.trim()).filter((p): p is string => !!p);
    return parts.length ? parts.join(', ') : null;
}

/**
 * Pure function merging one listing row with its (optional) detail response into the dataset row.
 *
 * Legacy keys NOT emitted because they describe the delta engine, which the router now owns: `record_id`,
 * `event_type`, `scraped_at`, `is_new`, `previousVersion`, `previousStatus`. Everything else keeps the legacy name.
 */
export function buildPayload(item: ListingItem, detailResult: DetailResult | null, now: Date, includeContactDetails = true): Record<string, unknown> {
    const detail = detailResult?.detail ?? null;
    const docs = detail?.docs ?? [];
    const commodityCodes = detail?.commodityCodes ?? [];
    // The response contact names a natural person (name, e-mail, phone). Unless the caller opts in, none of it is emitted.
    const contact = includeContactDetails ? (detail?.responseContact ?? null) : null;
    const descriptionText = htmlToText(detail?.description);
    const amountsUsd = parseUsdAmounts(descriptionText);
    const indicators = indicatorsOf(detail);
    const closeDateUtc = toUtcIso(item.closeDate);
    const docDates = docs.map((d) => toUtcIso(d.date)).filter((d): d is string => d !== null);
    const linkedId = detail?.linkedAdNumber?.trim() || null;

    return {
        source_url: detailPageUrl(item.advertisementId),
        data_source: DATA_SOURCE_ATTRIBUTION,

        advertisementId: item.advertisementId,
        uniqueName: item.uniqueName,
        agencyAdNumber: item.agencyAdNumber ?? detail?.agencyAdNumber ?? null,
        title: item.title,
        type: item.type,
        status: item.status,
        agency: item.agency ?? item.organization?.name ?? detail?.agency ?? '',
        openDate: item.openDate,
        closeDate: item.closeDate,
        publishDate: item.publishDate,
        description: detail?.description ?? null,
        commodityCodes,
        documents: docs.map((d) => ({
            fileName: d.fileName,
            downloadUrl: attachmentDownloadUrl(d.attachmentId),
            attachmentId: d.attachmentId,
            description: d.description ?? null,
            date: d.date ?? null,
            dateUtc: toUtcIso(d.date),
            version: d.version ?? null,
            docFor: d.docFor ?? null,
        })),
        responseContact: contact,

        typeId: item.typeId,
        version: item.version,
        isAmended: item.version > 1,
        organizationId: item.organization?.organizationId ?? detail?.organization?.organizationId ?? null,
        organizationShortName: item.organization?.shortName ?? detail?.organization?.shortName ?? null,
        organizationEntity: item.organization?.entity ?? detail?.organization?.entity ?? null,
        isAwardNotice: item.type === 'Agency Decision',
        isSingleSource: item.type === 'Single Source',

        publishDateUtc: toUtcIso(item.publishDate),
        openDateUtc: toUtcIso(item.openDate),
        closeDateUtc,
        publishDateLocal: toSiteLocal(item.publishDate),
        openDateLocal: toSiteLocal(item.openDate),
        closeDateLocal: toSiteLocal(item.closeDate),
        publishDay: utcCalendarDay(item.publishDate),
        closeDay: utcCalendarDay(item.closeDate),
        responseWindowDays: daysBetween(item.openDate, item.closeDate),
        daysUntilClose: daysUntil(item.closeDate, now),
        isOpenForResponses: item.status === 'OPEN' && closeDateUtc !== null && closeDateUtc > now.toISOString(),

        detailFetched: detail !== null,
        detailError: detailResult?.error ?? null,
        descriptionText,
        amountsUsd,
        maxAmountUsd: amountsUsd.length ? Math.max(...amountsUsd) : null,
        currency: 'USD',
        lastUpdateDate: detail?.lastUpdateDate ?? null,
        lastUpdateDateUtc: toUtcIso(detail?.lastUpdateDate),
        responseDate: detail?.responseDate ?? null,
        responseDateUtc: toUtcIso(detail?.responseDate),
        responseDateLocal: toSiteLocal(detail?.responseDate),
        linkedAdNumber: linkedId,
        linkedAdUrl: linkedId && /^\d+$/.test(linkedId) ? detailPageUrl(linkedId) : null,
        publishOption: detail?.publishOption ?? null,
        withdrawn: typeof detail?.withdrawn === 'boolean' ? detail.withdrawn : null,
        timeRemainingMs: typeof detail?.timeRemaining === 'number' ? detail.timeRemaining : null,
        indicators,
        minorityEncouraged: indicators?.minorityEncouraged ?? null,
        preSolicitationConference: indicators?.preSolicitationConference ?? null,
        disabilitiesAct: indicators?.disabilitiesAct ?? null,
        rightToReject: indicators?.rightToReject ?? null,
        agencyContactPeriod: indicators?.agencyContactPeriod ?? null,
        commodityCodeIds: commodityCodes.map((c) => c.id),
        commodityCodesText: commodityCodes.length ? commodityCodes.map((c) => `${c.id} ${c.value}`).join('; ') : null,
        documentCount: detail ? docs.length : null,
        latestDocumentDateUtc: docDates.length ? (docDates.sort().at(-1) ?? null) : null,
        contactName: contact?.responseContact?.trim() || null,
        contactEmail: contact?.email?.trim() || null,
        contactPhone: contact?.ph?.trim() || null,
        contactAddress: joinAddress(contact),
        contactCity: contact?.city?.trim() || null,
        contactState: contact?.state?.trim() || null,
        contactZip: contact?.zip?.trim() || null,
    };
}

/** Payload keys derived from the wall clock at fetch time; they change every run and must not drive the fingerprint. */
const CLOCK_DERIVED_KEYS = ['daysUntilClose', 'isOpenForResponses', 'timeRemainingMs'] as const;

/**
 * recordId = the advertisement id (the legacy `record_id`). The fingerprint covers every consumer-visible field
 * except the clock-derived ones, so a version bump, status flip, addendum, new document or a detail fetch that
 * recovered after a transient failure (`detailFetched` / `detailError` change) all re-emit the record.
 */
/** PPE event for a listing-only (no detail) record; priced in pricing/event_catalog.ts. */
export const FLORIDA_SUMMARY_EVENT = 'tender-summary';

export function toSourceRecord(item: ListingItem, detailResult: DetailResult | null, now: Date, includeContactDetails = true): SourceRecord {
    const payload = buildPayload(item, detailResult, now, includeContactDetails);
    const stable: Record<string, unknown> = { ...payload };
    for (const key of CLOCK_DERIVED_KEYS) delete stable[key];
    const agency = typeof payload.agency === 'string' ? payload.agency : '';
    return {
        recordId: String(item.advertisementId),
        fingerprint: fingerprintOf([stable]),
        payload,
        watchText: [agency, item.title].filter((part) => part.trim().length > 0).join(' '),
        // Legacy pricing: `result` for a full-detail record, `result-summary` for a listing-only one.
        billingEvent: payload.detailFetched === true ? undefined : FLORIDA_SUMMARY_EVENT,
    };
}

// ---------------------------------------------------------------------------
// Selection (walk -> client filters -> newest first -> cap)
// ---------------------------------------------------------------------------

/** Sort key of the listing: the row's own publishDate (canonical UTC), then the advertisement id. Newest first. */
function priorityKey(item: ListingItem): string {
    return `${toUtcIso(item.publishDate) ?? '0000'}|${String(item.advertisementId).padStart(12, '0')}`;
}

export interface SelectionFilters {
    agencyNames: SanitizedKeywordList;
    dateFrom: string | null;
    dateTo: string | null;
}

/** Client-side filters MFMP cannot apply itself. An empty agency keyword list means "no agency filtering", never "match everything by accident". */
export function passesClientFilters(item: ListingItem, filters: SelectionFilters): boolean {
    if (filters.agencyNames.needles.length > 0) {
        const haystack = `${item.agency ?? ''} ${item.organization?.shortName ?? ''}`;
        if (findKeywordMatch(haystack, filters.agencyNames) === null) return false;
    }
    const publishDay = utcCalendarDay(item.publishDate);
    if (filters.dateFrom && (!publishDay || publishDay < filters.dateFrom)) return false;
    if (filters.dateTo && (!publishDay || publishDay > filters.dateTo)) return false;
    return true;
}

export function sortNewestFirst(items: readonly ListingItem[]): ListingItem[] {
    return [...items].sort((a, b) => {
        const ka = priorityKey(a);
        const kb = priorityKey(b);
        return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
}

async function fetchDetailFor(ctx: ConnectorContext, item: ListingItem): Promise<DetailResult> {
    try {
        const detail = await fetchDetail(ctx, item.advertisementId);
        return detail === null ? { detail: null, error: 'NOT_FOUND' } : { detail, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warning(`[us_florida] detail fetch failed for ${item.uniqueName}: ${message}`);
        return { detail: null, error: message };
    }
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const usFloridaConnector: Connector<UsFloridaOptions> = {
    id: 'us_florida',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'florida-tenders-monitor',
    description:
        'State of Florida MyFloridaMarketPlace Vendor Information Portal: every state-agency solicitation (ITB, RFP, ITN, RFI, RSQ, single source, intent-to-award, grants, public meetings), with the portal\'s own filters applied server-side. Also absorbs delta-registry-florida-tenders-stub. Unauthenticated public JSON endpoints; no credentials.',
    status: 'active',
    optionsSchema: usFloridaOptionsSchema,

    async fetch(ctx: ConnectorContext, options: UsFloridaOptions, run: RunParams): Promise<SourceRecord[]> {
        const now = ctx.now();
        const titleKeywords = resolveKeywordFilter(ctx, 'titleContains', options.titleContains);
        const agencyNames = resolveKeywordFilter(ctx, 'agencyNameContains', options.agencyNameContains);

        let titleQueries: Array<string | null> = [null];
        if (titleKeywords.keywords.length > 0) {
            titleQueries = titleKeywords.keywords.slice(0, MAX_TITLE_QUERIES);
            if (titleKeywords.keywords.length > MAX_TITLE_QUERIES) {
                ctx.log.warning(`[us_florida] titleContains has ${titleKeywords.keywords.length} keywords; only the first ${MAX_TITLE_QUERIES} are queried (one listing walk each).`);
            }
        }

        let baseFilters: SearchFilters;
        let dateFrom: string | null;
        let dateTo: string | null;
        try {
            baseFilters = buildFilters(options, null, now);
            ({ dateFrom, dateTo } = resolveDateWindow(options, now));
        } catch (error) {
            throw new SourceFetchError(`invalid us_florida options: ${error instanceof Error ? error.message : String(error)}`, 'us_florida');
        }

        const byId = new Map<number, ListingItem>();
        let pagesWalked = 0;
        let totalMatching = 0;
        for (const title of titleQueries) {
            const filters: SearchFilters = { ...baseFilters, title };
            const walk = await fetchAllPages(ctx, filters, options.maxConcurrency);
            pagesWalked += walk.pagesWalked;
            totalMatching += walk.totalMatching;
            if (walk.rows.length < walk.totalMatching) {
                ctx.log.warning(
                    `[us_florida] MFMP reported ${walk.totalMatching} matching advertisements but ${walk.rows.length} rows were returned - the listing shifted during the walk; the missing rows will be seen by the next run.`,
                );
            }
            for (const row of walk.rows) if (!byId.has(row.advertisementId)) byId.set(row.advertisementId, row);
            ctx.log.info(`[us_florida] ${walk.rows.length} rows on ${walk.pagesWalked} page(s) [${describeFilters(filters)}], ${walk.totalMatching} matching on MFMP.`);
        }

        const filtered = [...byId.values()].filter((item) => passesClientFilters(item, { agencyNames, dateFrom, dateTo }));
        const ordered = sortNewestFirst(filtered);
        const selected = ordered.slice(0, run.maxItemsPerSource);
        if (ordered.length > selected.length) {
            ctx.log.warning(
                `[us_florida] ${ordered.length} advertisements matched but maxItemsPerSource=${run.maxItemsPerSource}; the ${ordered.length - selected.length} oldest-published were not returned. Narrow the filters or raise maxItemsPerSource.`,
            );
        }

        const details: Array<DetailResult | null> = options.fetchDetail
            ? await mapWithConcurrency(selected, options.maxConcurrency, (item) => fetchDetailFor(ctx, item))
            : selected.map(() => null);

        ctx.log.info(
            `[us_florida] ${selected.length} record(s) returned (${totalMatching} matching on MFMP over ${pagesWalked} page(s), ${filtered.length} after client filters${options.fetchDetail ? ', detail fetched' : ', detail skipped'}).`,
        );
        return selected.map((item, index) => toSourceRecord(item, details[index] ?? null, now, options.includeContactDetails));
    },
};
