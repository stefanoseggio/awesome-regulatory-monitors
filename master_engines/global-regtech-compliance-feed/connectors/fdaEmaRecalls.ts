/**
 * fda_ema_recalls - FDA drug enforcement (recalls) + EMA DHPC safety communications.
 *
 * Absorbs the legacy actor `actor-22-drug-safety-recalls-monitor` (src/sources/fdaEnforcement.ts,
 * emaAlerts.ts, umsNormalizer.ts, dateUtils.ts, fingerprint.ts, schemas.ts) as ONE connector whose
 * `subSources` option selects `fda`, `ema` or both. The free Python stub `delta-registry-fda-recalls-stub`
 * confirmed the intent (same two feeds, one normalised shape) and adds nothing else to port.
 *
 * LIVE SOURCE VERIFICATION (re-verified 2026-10-21; the legacy comments record the original 2026-09-07 check):
 *   FDA - https://api.fda.gov/drug/enforcement.json
 *     - Plain unauthenticated GET with an honest User-Agent: HTTP 200, `meta.results.total` 18,043 today.
 *       The legacy actor routed this through `impit` with a spoofed Chrome TLS fingerprint. That is NOT
 *       ported: openFDA needs no such thing (verified), and the compliance doctrine forbids fingerprint spoofing.
 *     - `limit` above 1000 -> HTTP 400 BAD_REQUEST ("Limit cannot exceed 1000 results for search requests...").
 *       `skip` pagination works (skip=2&limit=2 returned records 3-4 of the same ordering).
 *     - `search=report_date:[20261001+TO+20261021]` and `search=(classification:"Class I"+classification:"Class II")`
 *       work as the legacy code builds them; the multi-class form is an OR (1,750 + 14,572 = 16,322 verified).
 *     - LATENT LEGACY BUG, VERIFIED LIVE: a search with NO matches does not return an empty list. It returns
 *       HTTP 404 `{"error":{"code":"NOT_FOUND","message":"No matches found!"}}`. The legacy fetcher threw on
 *       that, so a quiet `dateRange` + `fdaClassification` window failed the whole run. Here a 404 whose body
 *       says NOT_FOUND / "No matches found" is an EMPTY RESULT, while any other 404 is still a failure.
 *     - Authentication (openFDA's own page, https://open.fda.gov/apis/authentication/, read this session): the
 *       key may be sent as `api_key=` OR as the Basic-auth username. A deliberately fake key was rejected with
 *       403 API_KEY_INVALID by BOTH mechanisms, proving the header form is honoured. This connector uses the
 *       header (`Authorization: Basic base64(key + ":")`), so the key never appears in a URL and therefore never
 *       in lib/http.ts error messages or debug logs. Documented limits: no key 240 req/min + 1,000 req/day per
 *       IP; with a key 240 req/min + 120,000 req/day.
 *   EMA - https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json
 *     - HTTP 200 application/json, 175 records today (`meta.total_records`, `meta.timestamp`), keys exactly as the
 *       legacy `EmaDhpcRawRecord`. 14 records have a blank `dissemination_date` (id falls back to
 *       `first_published_date`); every date matches DD/MM/YYYY; slug+date ids were unique (175 of 175).
 *     - https://www.ema.europa.eu/robots.txt carries `Allow: /*\/documents/report/*.json$`, so this export path is
 *       explicitly allowed. The export is a full snapshot (no server-side paging or filtering): downloaded once,
 *       then sorted newest-first, date-filtered and capped client-side.
 *
 * ADDITIVE vs the legacy output (nothing renamed or removed): `status_fingerprint` / `content_fingerprint` (the
 * legacy pair, so a consumer can still tell a status flip such as Ongoing -> Terminated from another edit), and
 * the fields the legacy fingerprint already depended on but never output - `terminationDateIso`, `codeInfo`,
 * `moreCodeInfo` (FDA), `referralName`, `lastUpdatedDateIso` (EMA) - so the record fingerprint changes only when a
 * consumer-visible field changes.
 *
 * NOT PORTED: the legacy `event_type` (SANCTION / NEW_LISTING / STATUS_CHANGE / UPDATED / SNAPSHOT_NO_DIFF),
 * `is_new` and `scraped_at` are computed by the router now (`delta_status`, `is_new`, `scraped_at`); the
 * STATUS_CHANGE / UPDATED split needs the previous fingerprint pair, which a connector is not given. The legacy
 * `maxItemsPerSource` applied to each regulator separately; here the run-level cap covers the whole connector and
 * is shared evenly between the selected sub-sources.
 */
import { z } from 'zod';

import { DATE_RANGES, type DateRange, dateRangeToFrom, fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const FDA_EMA_SOURCE_ID = 'fda_ema_recalls';

export const FDA_ENFORCEMENT_URL = 'https://api.fda.gov/drug/enforcement.json';
export const EMA_DHPC_JSON_URL = 'https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json';
/** Verified live: a limit above 1000 returns HTTP 400. */
export const FDA_MAX_LIMIT_PER_REQUEST = 1000;

export const SUB_SOURCES = ['fda', 'ema'] as const;
export type SubSource = (typeof SUB_SOURCES)[number];

export const FDA_CLASSIFICATIONS = ['Class I', 'Class II', 'Class III'] as const;
export type FdaClassification = (typeof FDA_CLASSIFICATIONS)[number];

/** Mandatory regulatory-data disclaimer, carried verbatim from the legacy actor's `schemas.ts`. */
export const REGULATORY_DATA_DISCLAIMER =
    "This record is sourced directly from the named regulator's own public enforcement/safety-communication feed " +
    '(US FDA openFDA drug enforcement API, or EU EMA Direct Healthcare Professional Communications). It has not ' +
    'been independently medically verified by this actor, may not reflect the regulator\'s current live status, ' +
    'and is not intended as clinical or consumer medical advice. Consult the source regulator and a qualified ' +
    'healthcare professional before making any medical or clinical decision.';

/** openFDA keys are opaque; accept printable ASCII without whitespace or ":" (":" would corrupt Basic-auth encoding). */
const API_KEY_PATTERN = /^[\x21-\x39\x3b-\x7e]{8,200}$/u;

export const fdaEmaOptionsSchema = z.object({
    /** Which regulators to query. */
    subSources: z
        .array(z.enum(SUB_SOURCES))
        .min(1)
        .max(SUB_SOURCES.length)
        .default([...SUB_SOURCES])
        .transform((values) => [...new Set(values)]),
    /** Restrict to records whose own date (FDA report_date, EMA dissemination_date) falls in this window. */
    dateRange: z.enum(DATE_RANGES).optional(),
    /** FDA only: recall severity tiers. Empty / omitted = all tiers (never "match nothing"). */
    fdaClassification: z.array(z.enum(FDA_CLASSIFICATIONS)).max(FDA_CLASSIFICATIONS.length).optional(),
    /** Optional BYOK openFDA key. Only raises the caller's own rate ceiling; blank is treated as absent. */
    fdaApiKey: z.preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
        z.string().trim().regex(API_KEY_PATTERN, 'fdaApiKey must be 8-200 printable characters without spaces or ":"').optional(),
    ),
});
export type FdaEmaOptions = z.output<typeof fdaEmaOptionsSchema>;

// ---------------------------------------------------------------------------
// Raw record shapes (copied field-for-field from the legacy interfaces, verified live)
// ---------------------------------------------------------------------------

const text = z.string().nullish();

/** openFDA omits `termination_date` / `more_code_info` instead of sending null, so everything but the id is optional. */
export const fdaRawSchema = z.object({
    recall_number: z.string().min(1),
    status: text,
    city: text,
    state: text,
    country: text,
    classification: text,
    product_type: text,
    event_id: text,
    recalling_firm: text,
    voluntary_mandated: text,
    distribution_pattern: text,
    product_description: text,
    product_quantity: text,
    reason_for_recall: text,
    recall_initiation_date: text,
    center_classification_date: text,
    termination_date: text,
    report_date: text,
    code_info: text,
    more_code_info: text,
});
export type FdaEnforcementRawRecord = z.infer<typeof fdaRawSchema>;

const fdaPageSchema = z.object({
    meta: z.object({ results: z.object({ total: z.number().optional() }).optional() }).optional(),
    results: z.array(z.unknown()).optional(),
});

/** EMA uses the empty string (never null) for "not applicable"; `dhpc_url` is the only identity field. */
export const emaRawSchema = z.object({
    dhpc_url: z.string().min(1),
    category: text,
    name_of_medicine: text,
    procedure_number: text,
    active_substances: text,
    dhpc_type: text,
    regulatory_outcome: text,
    referral_name: text,
    atc_code_human: text,
    therapeutic_area_mesh: text,
    dissemination_date: text,
    first_published_date: text,
    last_updated_date: text,
});
export type EmaDhpcRawRecord = z.infer<typeof emaRawSchema>;

const emaResponseSchema = z.object({ data: z.array(z.unknown()) });

// ---------------------------------------------------------------------------
// Dates (ported from legacy dateUtils.ts, with calendar validation added)
// ---------------------------------------------------------------------------

function utcDateOrNull(year: number, month: number, day: number): string | null {
    const date = new Date(Date.UTC(year, month - 1, day));
    // "20261340" must not silently roll over into the next year.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString();
}

/** FDA dates are bare `YYYYMMDD` strings (verified live). */
export function parseFdaDateToIso(value: string | null | undefined): string | null {
    const match = value ? /^(\d{4})(\d{2})(\d{2})$/u.exec(value) : null;
    return match ? utcDateOrNull(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** EMA dates are `DD/MM/YYYY` strings (verified live). */
export function parseEuDateToIso(value: string | null | undefined): string | null {
    const match = value ? /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value) : null;
    return match ? utcDateOrNull(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

const RANGE_DAYS: Record<DateRange, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

/**
 * True when `isoDate` lies within `range` before `now`. Requires `diff >= 0` so a future-dated record cannot
 * match every window (the same bug class the legacy fleet hit on other actors).
 */
export function isWithinDateRange(isoDate: string | null, range: DateRange | undefined, now: Date): boolean {
    if (!range) return true;
    if (!isoDate) return false;
    const time = Date.parse(isoDate);
    if (Number.isNaN(time)) return false;
    const diff = now.getTime() - time;
    return diff >= 0 && diff <= RANGE_DAYS[range] * 86_400_000;
}

// ---------------------------------------------------------------------------
// Normalisation (ported from legacy umsNormalizer.ts; router-owned fields are not set here)
// ---------------------------------------------------------------------------

/** Trimmed string, or null for empty / "N/A" / absent (both regulators use these to mean "no value"). */
export function emptyToNull(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' || trimmed === 'N/A' ? null : trimmed;
}

function cleanText(value: string | null | undefined, maxLength: number): string {
    return (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

const envelopeShape = {
    source_url: z.string().nullable(),
    recipient_or_defendant_name: z.string().nullable(),
    entity_identifier_native: z.string().nullable(),
    value_native: z.null(),
    value_currency: z.null(),
    value_usd_normalized: z.null(),
    effective_date_iso: z.string().nullable(),
    publish_date_iso: z.string().nullable(),
    category_or_type: z.string().nullable(),
    status_or_estado: z.string().nullable(),
    awarding_or_regulating_agency: z.string(),
    source_document_url: z.null(),
    reference_number: z.string().nullable(),
    /** A z.literal, exactly like the legacy schema: a payload without the exact disclaimer cannot be built. */
    regulatoryDataDisclaimer: z.literal(REGULATORY_DATA_DISCLAIMER),
    status_fingerprint: z.string(),
    content_fingerprint: z.string(),
};

export const fdaRecallPayloadSchema = z.object({
    ...envelopeShape,
    jurisdiction: z.literal('US'),
    recordSource: z.literal('fda_enforcement'),
    classification: z.string().nullable(),
    productDescription: z.string().nullable(),
    reasonForRecall: z.string().nullable(),
    recallingFirm: z.string().nullable(),
    distributionPattern: z.string().nullable(),
    voluntaryMandated: z.string().nullable(),
    recallNumber: z.string().nullable(),
    eventId: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    terminationDateIso: z.string().nullable(),
    codeInfo: z.string().nullable(),
    moreCodeInfo: z.string().nullable(),
});

export const emaAlertPayloadSchema = z.object({
    ...envelopeShape,
    jurisdiction: z.literal('EU'),
    recordSource: z.literal('ema_dhpc'),
    nameOfMedicine: z.string().nullable(),
    activeSubstances: z.string().nullable(),
    dhpcType: z.string().nullable(),
    atcCodeHuman: z.string().nullable(),
    therapeuticAreaMesh: z.string().nullable(),
    procedureNumber: z.string().nullable(),
    regulatoryOutcome: z.string().nullable(),
    referralName: z.string().nullable(),
    lastUpdatedDateIso: z.string().nullable(),
});

export function normalizeFdaRecord(raw: FdaEnforcementRawRecord): SourceRecord {
    const statusFingerprint = fingerprintOf([raw.status]);
    const contentFingerprint = fingerprintOf([
        raw.classification,
        raw.product_description,
        raw.reason_for_recall,
        raw.distribution_pattern,
        raw.voluntary_mandated,
        raw.termination_date,
        raw.code_info,
        raw.more_code_info,
    ]);
    // openFDA exposes no per-recall detail page; the API request that returns exactly this record is the most
    // honest dereferenceable URL (verified: it answers 200). No HTML page is invented in its place.
    const sourceUrl = `${FDA_ENFORCEMENT_URL}?search=recall_number:%22${encodeURIComponent(raw.recall_number)}%22`;

    const payload = fdaRecallPayloadSchema.parse({
        source_url: sourceUrl,
        recipient_or_defendant_name: emptyToNull(raw.recalling_firm),
        entity_identifier_native: emptyToNull(raw.event_id),
        value_native: null,
        value_currency: null,
        value_usd_normalized: null,
        effective_date_iso: parseFdaDateToIso(raw.recall_initiation_date),
        publish_date_iso: parseFdaDateToIso(raw.report_date),
        category_or_type: emptyToNull(raw.product_type),
        status_or_estado: emptyToNull(raw.status),
        awarding_or_regulating_agency: 'U.S. Food and Drug Administration (FDA)',
        jurisdiction: 'US',
        source_document_url: null,
        reference_number: emptyToNull(raw.recall_number),
        regulatoryDataDisclaimer: REGULATORY_DATA_DISCLAIMER,
        status_fingerprint: statusFingerprint,
        content_fingerprint: contentFingerprint,
        recordSource: 'fda_enforcement',
        classification: emptyToNull(raw.classification),
        productDescription: emptyToNull(raw.product_description),
        reasonForRecall: emptyToNull(raw.reason_for_recall),
        recallingFirm: emptyToNull(raw.recalling_firm),
        distributionPattern: emptyToNull(raw.distribution_pattern),
        voluntaryMandated: emptyToNull(raw.voluntary_mandated),
        recallNumber: emptyToNull(raw.recall_number),
        eventId: emptyToNull(raw.event_id),
        city: emptyToNull(raw.city),
        state: emptyToNull(raw.state),
        country: emptyToNull(raw.country),
        terminationDateIso: parseFdaDateToIso(raw.termination_date),
        codeInfo: emptyToNull(raw.code_info),
        moreCodeInfo: emptyToNull(raw.more_code_info),
    });

    return {
        recordId: `fda:${raw.recall_number}`,
        fingerprint: fingerprintOf([statusFingerprint, contentFingerprint]),
        payload,
        // The recalling firm is the respondent; the product text (bounded) lets a drug-name watchlist hit too.
        watchText: `${cleanText(raw.recalling_firm, 200)} ${cleanText(raw.product_description, 200)}`.trim(),
    };
}

function slugFromDhpcUrl(url: string): string {
    const parts = url.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? url;
}

export function emaRecordId(raw: EmaDhpcRawRecord): string {
    // No numeric id exists in this feed (verified live): slug + dissemination date is the most stable composite
    // available, without inventing an id the source does not provide.
    return `ema:${slugFromDhpcUrl(raw.dhpc_url)}:${raw.dissemination_date || raw.first_published_date || 'undated'}`;
}

export function normalizeEmaRecord(raw: EmaDhpcRawRecord): SourceRecord {
    const statusFingerprint = fingerprintOf([raw.regulatory_outcome]);
    const contentFingerprint = fingerprintOf([
        raw.name_of_medicine,
        raw.active_substances,
        raw.dhpc_type,
        raw.atc_code_human,
        raw.therapeutic_area_mesh,
        raw.procedure_number,
        raw.referral_name,
        raw.last_updated_date,
    ]);

    const payload = emaAlertPayloadSchema.parse({
        source_url: emptyToNull(raw.dhpc_url),
        // The feed has no marketing-authorisation-holder field: the medicine itself is the named subject.
        recipient_or_defendant_name: emptyToNull(raw.name_of_medicine),
        entity_identifier_native: emptyToNull(raw.atc_code_human),
        value_native: null,
        value_currency: null,
        value_usd_normalized: null,
        effective_date_iso: parseEuDateToIso(raw.dissemination_date),
        publish_date_iso: parseEuDateToIso(raw.first_published_date),
        category_or_type: emptyToNull(raw.dhpc_type),
        status_or_estado: emptyToNull(raw.regulatory_outcome),
        awarding_or_regulating_agency: 'European Medicines Agency (EMA)',
        jurisdiction: 'EU',
        // One URL per DHPC (the page that links the letter): no separate document endpoint exists.
        source_document_url: null,
        reference_number: emptyToNull(raw.procedure_number),
        regulatoryDataDisclaimer: REGULATORY_DATA_DISCLAIMER,
        status_fingerprint: statusFingerprint,
        content_fingerprint: contentFingerprint,
        recordSource: 'ema_dhpc',
        nameOfMedicine: emptyToNull(raw.name_of_medicine),
        activeSubstances: emptyToNull(raw.active_substances),
        dhpcType: emptyToNull(raw.dhpc_type),
        atcCodeHuman: emptyToNull(raw.atc_code_human),
        therapeuticAreaMesh: emptyToNull(raw.therapeutic_area_mesh),
        procedureNumber: emptyToNull(raw.procedure_number),
        regulatoryOutcome: emptyToNull(raw.regulatory_outcome),
        referralName: emptyToNull(raw.referral_name),
        lastUpdatedDateIso: parseEuDateToIso(raw.last_updated_date),
    });

    return {
        recordId: emaRecordId(raw),
        fingerprint: fingerprintOf([statusFingerprint, contentFingerprint]),
        payload,
        watchText: `${cleanText(raw.name_of_medicine, 200)} ${cleanText(raw.active_substances, 200)}`.trim(),
    };
}

// ---------------------------------------------------------------------------
// FDA fetching
// ---------------------------------------------------------------------------

/** `YYYYMMDD` stamp used by openFDA's search syntax. */
export function toFdaDateStamp(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/gu, '');
}

/**
 * The `search=` value. Only fixed field names and zod-validated enum values are interpolated, so there is no
 * free-form caller text in the query. `+` is openFDA's own token separator and must stay literal, which is why
 * the clause is appended to the query string raw instead of going through URLSearchParams.
 */
export function buildFdaSearchClause(dateRange: DateRange | undefined, classification: readonly FdaClassification[] | undefined, now: Date): string | undefined {
    const clauses: string[] = [];
    if (classification && classification.length > 0) {
        clauses.push(`(${classification.map((c) => `classification:%22${encodeURIComponent(c)}%22`).join('+')})`);
    }
    const from = dateRangeToFrom(dateRange, now);
    if (from) clauses.push(`report_date:[${from.replace(/-/gu, '')}+TO+${toFdaDateStamp(now)}]`);
    return clauses.length > 0 ? clauses.join('+AND+') : undefined;
}

export function buildFdaUrl(searchClause: string | undefined, limit: number, skip: number): string {
    const params = ['sort=report_date:desc', `limit=${limit}`];
    if (skip > 0) params.push(`skip=${skip}`);
    return `${FDA_ENFORCEMENT_URL}?${searchClause ? [`search=${searchClause}`, ...params].join('&') : params.join('&')}`;
}

/** openFDA's "empty result" is an HTTP 404 with a NOT_FOUND body (verified live). Any other 404 is a real failure. */
export function isFdaNoMatches(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { status?: unknown; bodyPreview?: unknown };
    return candidate.status === 404 && typeof candidate.bodyPreview === 'string' && /NOT_FOUND|No matches found/iu.test(candidate.bodyPreview);
}

export function fdaAuthHeaders(apiKey: string | undefined): Record<string, string> | undefined {
    return apiKey ? { authorization: `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}` } : undefined;
}

export interface FdaFetchParams {
    maxItems: number;
    dateRange?: DateRange | undefined;
    classification?: readonly FdaClassification[] | undefined;
    apiKey?: string | undefined;
}

/** Newest-first by report_date, paginating with `skip` past openFDA's 1000-per-request cap. */
export async function fetchFdaRecords(ctx: ConnectorContext, params: FdaFetchParams): Promise<FdaEnforcementRawRecord[]> {
    const searchClause = buildFdaSearchClause(params.dateRange, params.classification, ctx.now());
    const headers = fdaAuthHeaders(params.apiKey);
    const records: FdaEnforcementRawRecord[] = [];
    let skip = 0;
    let skippedInvalid = 0;

    while (records.length < params.maxItems) {
        const limit = Math.min(FDA_MAX_LIMIT_PER_REQUEST, params.maxItems - records.length);
        let body: unknown;
        try {
            body = await ctx.http.getJson<unknown>(buildFdaUrl(searchClause, limit, skip), headers ? { headers } : undefined);
        } catch (error) {
            if (isFdaNoMatches(error)) break;
            throw error;
        }
        const page = fdaPageSchema.safeParse(body);
        if (!page.success) throw new Error(`unexpected openFDA response shape: ${page.error.issues[0]?.message ?? 'invalid'}`);

        const results = page.data.results ?? [];
        for (const item of results) {
            const parsed = fdaRawSchema.safeParse(item);
            if (parsed.success) records.push(parsed.data);
            else skippedInvalid += 1;
        }
        skip += results.length;
        const total = page.data.meta?.results?.total ?? skip;
        if (results.length === 0 || skip >= total) break;
    }
    if (skippedInvalid > 0) ctx.log.warning(`[${FDA_EMA_SOURCE_ID}] ${skippedInvalid} openFDA record(s) skipped: no usable recall_number.`);
    return records.slice(0, params.maxItems);
}

// ---------------------------------------------------------------------------
// EMA fetching
// ---------------------------------------------------------------------------

function emaSortTime(record: EmaDhpcRawRecord): number {
    const iso = parseEuDateToIso(record.dissemination_date) ?? parseEuDateToIso(record.first_published_date);
    return iso ? Date.parse(iso) : 0;
}

export function sortEmaNewestFirst(records: readonly EmaDhpcRawRecord[]): EmaDhpcRawRecord[] {
    return [...records].sort((a, b) => emaSortTime(b) - emaSortTime(a));
}

export interface EmaFetchParams {
    maxItems: number;
    dateRange?: DateRange | undefined;
}

/** One full-snapshot download per run; sorting, date filtering and capping happen client-side. */
export async function fetchEmaRecords(ctx: ConnectorContext, params: EmaFetchParams): Promise<EmaDhpcRawRecord[]> {
    const body = await ctx.http.getJson<unknown>(EMA_DHPC_JSON_URL);
    const response = emaResponseSchema.safeParse(body);
    if (!response.success) throw new Error('unexpected EMA DHPC export shape: no "data" array');

    const valid: EmaDhpcRawRecord[] = [];
    let skippedInvalid = 0;
    for (const item of response.data.data) {
        const parsed = emaRawSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
        else skippedInvalid += 1;
    }
    if (skippedInvalid > 0) ctx.log.warning(`[${FDA_EMA_SOURCE_ID}] ${skippedInvalid} EMA record(s) skipped: no usable dhpc_url.`);

    const now = ctx.now();
    let records = sortEmaNewestFirst(valid);
    if (params.dateRange) {
        const range = params.dateRange;
        records = records.filter((r) => isWithinDateRange(parseEuDateToIso(r.dissemination_date) ?? parseEuDateToIso(r.first_published_date), range, now));
    }
    return records.slice(0, params.maxItems);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/** Splits `total` as evenly as possible over `parts` (earlier parts get the remainder). */
export function splitBudget(total: number, parts: number): number[] {
    if (parts <= 0) return [];
    const base = Math.floor(total / parts);
    const remainder = total % parts;
    return Array.from({ length: parts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const fdaEmaRecallsConnector: Connector<FdaEmaOptions> = {
    id: FDA_EMA_SOURCE_ID,
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'actor-22-drug-safety-recalls-monitor',
    description:
        'US FDA drug enforcement (recall) records from openFDA and EU EMA Direct Healthcare Professional Communications, newest first, in the legacy 18-field UMS envelope plus native fields. ' +
        'Select regulators with subSources; optional dateRange, fdaClassification and BYOK fdaApiKey.',
    status: 'active',
    optionsSchema: fdaEmaOptionsSchema,

    async fetch(ctx: ConnectorContext, options: FdaEmaOptions, run: RunParams): Promise<SourceRecord[]> {
        const selected = SUB_SOURCES.filter((s) => options.subSources.includes(s));
        const shares = splitBudget(run.maxItemsPerSource, selected.length);

        const records: SourceRecord[] = [];
        const failures: string[] = [];
        let attempted = 0;

        for (const [index, sub] of selected.entries()) {
            const maxItems = shares[index] ?? 0;
            if (maxItems < 1) {
                ctx.log.info(`[${FDA_EMA_SOURCE_ID}] ${sub}: no share of maxItemsPerSource=${run.maxItemsPerSource}; skipped.`);
                continue;
            }
            attempted += 1;
            try {
                if (sub === 'fda') {
                    const raw = await fetchFdaRecords(ctx, {
                        maxItems,
                        dateRange: options.dateRange,
                        classification: options.fdaClassification,
                        apiKey: options.fdaApiKey,
                    });
                    ctx.log.info(`[${FDA_EMA_SOURCE_ID}] fda: ${raw.length} record(s).`);
                    records.push(...raw.map(normalizeFdaRecord));
                } else {
                    const raw = await fetchEmaRecords(ctx, { maxItems, dateRange: options.dateRange });
                    ctx.log.info(`[${FDA_EMA_SOURCE_ID}] ema: ${raw.length} record(s).`);
                    records.push(...raw.map(normalizeEmaRecord));
                }
            } catch (error) {
                failures.push(`${sub}: ${messageOf(error)}`);
                ctx.log.warning(`[${FDA_EMA_SOURCE_ID}] ${sub} failed - ${messageOf(error)}`);
            }
        }

        if (attempted > 0 && failures.length === attempted) {
            throw new SourceFetchError(`All selected regulators failed: ${failures.join(' | ')}`, FDA_EMA_SOURCE_ID);
        }
        return records;
    },
};
