/**
 * usptoPtab.ts - USPTO PTAB Trials ("uspto_ptab") connector.
 *
 * Absorbs the `uspto_ptab` source of `actor-21-patent-ip-enforcement-monitor`
 * (src/sources/usptoPtab.ts, the PTAB half of umsNormalizer.ts, the request/response
 * types in types.ts and the input contract in schemas.ts). Intent reference: the free
 * `delta-registry-uspto-ptab-stub` (a one-shot puller of the 20 newest proceedings from
 * the same endpoint with the same body shape).
 *
 * Out of scope here (router / other connectors): delta state, `onlyNew`, the legacy
 * `SANCTION | UPDATED | TERMINATED | SNAPSHOT_NO_DIFF` event vocabulary (it is derived
 * from delta memory, which `router_core.ts` now owns and exposes as `delta_status`),
 * Actor.charge / pushData, and the EPO half of the legacy actor (`epoOpposition.ts`).
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION (legacy record, performed 2026-09-07, condensed)
 * ============================================================================
 * 1. USPTO PatentsView PatentSearch API (search.patentsview.org/api) -- CONFIRMED NOT
 *    USABLE and excluded. data.uspto.gov/support/transition-guide/patentsview: "temporary
 *    interruptions are expected ... There is currently no estimate for the launch date of
 *    these API functions on ODP" and "Previously-issued API keys for the PatentSearch API
 *    will not be compatible with ODP APIs"; a DNS lookup of search.patentsview.org failed
 *    (ENOTFOUND). PatentsView only ever covered grants/applications, not disputes, so it
 *    would not fit this source's brief even when it returns.
 * 2. USPTO PTAB Trials API, served from the USPTO Open Data Portal (ODP) -- CONFIRMED real
 *    and live. Inter Partes Review (IPR), Post-Grant Review (PGR), Covered Business Method
 *    (CBM) and Derivation (DER) proceedings are adversarial validity disputes, the closest
 *    genuine match to "enforcement actions". Endpoint, browsed on
 *    https://data.uspto.gov/apis/ptab-trials/search-proceedings:
 *      POST https://api.uspto.gov/api/v1/patent/trials/proceedings/search
 *    Auth header `x-api-key: <ODP API key>` ("API Key is required."). Body shape
 *    (q / filters / rangeFilters / pagination / sort) confirmed against the worked example
 *    on https://data.uspto.gov/apis/api-syntax-examples. Response fields (trialNumber,
 *    trialMetaData.{trialTypeCode, trialStatusCategory, petitionFilingDate,
 *    accordedFilingDate, institutionDecisionDate, latestDecisionDate, terminationDate,
 *    fileDownloadURI}, patentOwnerData / regularPetitionerData / respondentData /
 *    derivationPetitionerData each with {patentNumber, applicationNumberText,
 *    realPartyInInterestName, grantDate, patentOwnerName, inventorName, counselName,
 *    technologyCenterNumber, groupArtUnitNumber}) were read off that page's "Response ->
 *    200 -> Data Property" table.
 *    Not a bot-detection gate: an unauthenticated request to a non-existent path returns
 *    HTTP 403 `{"message":"Missing Authentication Token"}` (API-gateway auth check).
 *    Rate limits (https://data.uspto.gov/apis/api-rate-limits): burst = 1 (no concurrent
 *    calls per key - this connector never issues parallel requests), 4-15 req/s depending
 *    on endpoint, 5,000,000 calls/week shared across the "metadata retrieval" endpoints,
 *    weekly reset Sunday 00:00 UTC, HTTP 429 on excess with the page's own guidance "we
 *    strongly discourage automatic retries ... without at least 5 second delay".
 *    ACCESS MODEL (why this is BYOK): the in-app banner at https://data.uspto.gov says that
 *    from 2026-06-18 a valid USPTO.gov account with MFA is required and, from 2026-08-18,
 *    four extra profile fields (else access to ODP products and the API key is lost). That
 *    is a legitimate free front door (account + MFA, no CAPTCHA or WAF bypass), so this
 *    connector never automates the registration: the operator supplies an already-issued
 *    key through `sourceOptions.uspto_ptab.usptoOdpApiKey`.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy, no key):
 *   POST https://api.uspto.gov/api/v1/patent/trials/proceedings/search  (the legacy body, limit 1)
 *     -> HTTP 401 {"message":"Unauthorized"}
 *   POST https://api.uspto.gov/api/v1/patent/trials/nonexistent-route/search
 *     -> HTTP 403 {"message":"Missing Authentication Token"}
 *   POST (same body) with a syntactically plausible but invalid `x-api-key` -> HTTP 403 {"message":"Forbidden"}
 *   i.e. the real route exists and is key-gated (a different gateway answer from an unknown
 *   route, and an invalid key is told apart from a missing one), and there is no CAPTCHA / WAF challenge on the
 *   API host. The AUTHENTICATED
 *   response shape could NOT be re-verified (no ODP key is held by this codebase): the
 *   field names below rest on the legacy record above and on the stub's README sample.
 *   The data.uspto.gov documentation site itself sits behind an AWS WAF challenge script and
 *   was deliberately not scraped.
 * ============================================================================
 *
 * RATE-LIMIT FLOOR: every request passes `minRetryDelayMs: PTAB_MIN_RETRY_DELAY_MS` so the shared client
 * never retries a 429/5xx sooner than the "at least 5 second delay" USPTO publishes (a larger
 * `Retry-After` still wins).
 */
import { z } from 'zod';

import { DATE_RANGES, dateRangeToFrom, fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const PTAB_SOURCE_ID = 'uspto_ptab';
export const PTAB_SEARCH_URL = 'https://api.uspto.gov/api/v1/patent/trials/proceedings/search';
export const PTAB_TRIAL_TYPE_CODES = ['IPR', 'PGR', 'CBM', 'DER'] as const;
export type PtabTrialTypeCode = (typeof PTAB_TRIAL_TYPE_CODES)[number];
/** Legacy page size: min(maxItems, 100). */
export const PTAB_MAX_PAGE_SIZE = 100;
export const PTAB_AGENCY_NAME = 'USPTO Patent Trial and Appeal Board (PTAB)';
export const PTAB_JURISDICTION = 'US';

/** Response-size ceiling per page (100 proceedings are far below this; it only bounds a hostile/broken reply). */
const PTAB_MAX_RESPONSE_BYTES = 25_000_000;
/** USPTO ODP: "we strongly discourage automatic retries ... without at least 5 second delay". */
const PTAB_MIN_RETRY_DELAY_MS = 5000;
const PTAB_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Raw response shape (mirrors the ODP "Data Property" table; every field optional because a
// real response may omit what it does not have - the legacy interface typed them `| null`)
// ---------------------------------------------------------------------------

export interface PtabPartyData {
    patentNumber?: string | null;
    applicationNumberText?: string | null;
    realPartyInInterestName?: string | null;
    grantDate?: string | null;
    patentOwnerName?: string | null;
    inventorName?: string | null;
    counselName?: string | null;
    technologyCenterNumber?: string | number | null;
    groupArtUnitNumber?: string | number | null;
}

export interface PtabTrialMetaData {
    trialTypeCode?: string | null;
    trialStatusCategory?: string | null;
    trialLastModifiedDate?: string | null;
    petitionFilingDate?: string | null;
    trialLastModifiedDateTime?: string | null;
    accordedFilingDate?: string | null;
    institutionDecisionDate?: string | null;
    latestDecisionDate?: string | null;
    terminationDate?: string | null;
    fileDownloadURI?: string | null;
}

export interface PtabTrialProceeding {
    trialNumber?: string | null;
    trialRecordIdentifier?: string | null;
    lastModifiedDateTime?: string | null;
    trialMetaData?: PtabTrialMetaData | null;
    patentOwnerData?: PtabPartyData | null;
    regularPetitionerData?: PtabPartyData | null;
    respondentData?: PtabPartyData | null;
    derivationPetitionerData?: PtabPartyData | null;
}

export interface PtabSearchResponse {
    patentTrialProceedingDataBag?: PtabTrialProceeding[];
}

/** The legacy `PtabRawRecord` minus the envelope fields the router owns (record_id, event_type, scraped_at, is_new) and `source`. */
export interface PtabFlatRecord {
    trialNumber: string;
    trialTypeCode: string | null;
    trialStatusCategory: string | null;
    petitionFilingDate: string | null;
    accordedFilingDate: string | null;
    institutionDecisionDate: string | null;
    latestDecisionDate: string | null;
    terminationDate: string | null;
    trialLastModifiedDateTime: string | null;
    fileDownloadURI: string | null;
    patentNumber: string | null;
    applicationNumberText: string | null;
    patentOwnerName: string | null;
    patentOwnerRealPartyInInterestName: string | null;
    petitionerRealPartyInInterestName: string | null;
    petitionerCounselName: string | null;
    inventorName: string | null;
    technologyCenterNumber: string | null;
}

// ---------------------------------------------------------------------------
// Request building (port of legacy buildRequestBody)
// ---------------------------------------------------------------------------

export interface PtabSearchParams {
    trialTypeCodes: readonly PtabTrialTypeCode[];
    /** ISO date (YYYY-MM-DD), inclusive, applied to trialMetaData.petitionFilingDate as a rangeFilter exactly like the worked ODP example. */
    filingDateFrom?: string;
    /** ISO date (YYYY-MM-DD) upper bound of that rangeFilter (the legacy actor used "today"). */
    filingDateTo: string;
}

/**
 * The real ODP "advanced syntax" request body -- q / filters / rangeFilters / pagination /
 * sort -- per https://data.uspto.gov/apis/api-syntax-examples, applied to proceedings/search.
 * `trialNumber` is a secondary/tie-breaking sort field: petitionFilingDate is a calendar date,
 * so ties are common, and sorting by one non-unique field with offset pagination risks a trial
 * being skipped or double-emitted at a page boundary when ties straddle it.
 */
export function buildPtabRequestBody(params: PtabSearchParams, offset: number, limit: number) {
    const filters: { name: string; value: string[] }[] = [];
    if (params.trialTypeCodes.length > 0) {
        filters.push({ name: 'trialMetaData.trialTypeCode', value: [...params.trialTypeCodes] });
    }

    const rangeFilters: { field: string; valueFrom: string; valueTo: string }[] = [];
    if (params.filingDateFrom) {
        rangeFilters.push({ field: 'trialMetaData.petitionFilingDate', valueFrom: params.filingDateFrom, valueTo: params.filingDateTo });
    }

    return {
        q: '*',
        filters,
        rangeFilters,
        pagination: { offset, limit },
        sort: [
            { field: 'trialMetaData.petitionFilingDate', order: 'Desc' },
            { field: 'trialNumber', order: 'Asc' },
        ],
    };
}

// ---------------------------------------------------------------------------
// Parsing / normalisation (port of legacy flattenProceeding + normalizePtabRecord)
// ---------------------------------------------------------------------------

/** Trimmed non-empty string, or `null`. Numbers are stringified (technologyCenterNumber may arrive numeric). */
function text(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Pulls the highest-value single party name out of the four possible party-data objects for a
 * "who is being challenged" and "who is challenging" view: the patent owner (falling back to
 * respondentData) is the enforcement target, the petitioner (regular, falling back to
 * derivation) the challenger. Returns `null` for a row with no usable trial number - the
 * record identity - rather than fabricating one.
 */
export function flattenProceeding(proceeding: PtabTrialProceeding): PtabFlatRecord | null {
    const trialNumber = text(proceeding.trialNumber);
    if (trialNumber === null) return null;
    const meta = proceeding.trialMetaData ?? {};
    const owner = proceeding.patentOwnerData ?? proceeding.respondentData ?? undefined;
    const petitioner = proceeding.regularPetitionerData ?? proceeding.derivationPetitionerData ?? undefined;

    return {
        trialNumber,
        trialTypeCode: text(meta.trialTypeCode),
        trialStatusCategory: text(meta.trialStatusCategory),
        petitionFilingDate: text(meta.petitionFilingDate),
        accordedFilingDate: text(meta.accordedFilingDate),
        institutionDecisionDate: text(meta.institutionDecisionDate),
        latestDecisionDate: text(meta.latestDecisionDate),
        terminationDate: text(meta.terminationDate),
        trialLastModifiedDateTime: text(meta.trialLastModifiedDateTime) ?? text(proceeding.lastModifiedDateTime),
        fileDownloadURI: text(meta.fileDownloadURI),
        patentNumber: text(owner?.patentNumber) ?? text(petitioner?.patentNumber),
        applicationNumberText: text(owner?.applicationNumberText) ?? text(petitioner?.applicationNumberText),
        patentOwnerName: text(owner?.patentOwnerName),
        patentOwnerRealPartyInInterestName: text(owner?.realPartyInInterestName),
        petitionerRealPartyInInterestName: text(petitioner?.realPartyInInterestName),
        petitionerCounselName: text(petitioner?.counselName),
        inventorName: text(owner?.inventorName) ?? text(petitioner?.inventorName),
        technologyCenterNumber: text(owner?.technologyCenterNumber) ?? text(petitioner?.technologyCenterNumber),
    };
}

/**
 * Legacy UMS mapping (normalizePtabRecord), minus the router-owned `record_id`, `event_type`,
 * `scraped_at` and `is_new`. Every mapping decision is the legacy one:
 *  - recipient_or_defendant_name: the patent owner (patentOwnerName, falling back to the owner-side
 *    realPartyInInterestName) - the party whose patent is under challenge, the closest analogue to
 *    "defendant" in an administrative tribunal.
 *  - entity_identifier_native: the challenged patentNumber (falling back to applicationNumberText).
 *    It identifies the patent, not a company registration number (PTAB data has none).
 *  - value_*: null - PTAB proceedings carry no monetary amount (checked against the full Data
 *    Property table); the stakes of an IPR/PGR/CBM/DER are the patent's validity.
 *  - effective_date_iso: institutionDecisionDate (when the trial formally took hold), falling back to
 *    accordedFilingDate; publish_date_iso: petitionFilingDate.
 *  - source_url: null, deliberately - no public per-proceeding case-viewer URL pattern was ever
 *    confirmed live, and a fabricated URL is worse than an honest null.
 *  - source_document_url: fileDownloadURI - the one verified per-record document link.
 */
export function ptabUmsFields(flat: PtabFlatRecord): Record<string, unknown> {
    return {
        source_url: null,
        recipient_or_defendant_name: flat.patentOwnerName ?? flat.patentOwnerRealPartyInInterestName ?? null,
        entity_identifier_native: flat.patentNumber ?? flat.applicationNumberText ?? null,
        value_native: null,
        value_currency: null,
        value_usd_normalized: null,
        effective_date_iso: flat.institutionDecisionDate ?? flat.accordedFilingDate ?? null,
        publish_date_iso: flat.petitionFilingDate ?? null,
        category_or_type: flat.trialTypeCode,
        status_or_estado: flat.trialStatusCategory,
        awarding_or_regulating_agency: PTAB_AGENCY_NAME,
        jurisdiction: PTAB_JURISDICTION,
        source_document_url: flat.fileDownloadURI,
        reference_number: flat.trialNumber,
    };
}

/**
 * Fingerprint = the lifecycle and party fields a consumer acts on. The legacy actor tracked
 * `trialStatusCategory | latestDecisionDate | terminationDate | fileDownloadURI` (the document link
 * is included because a decision document that only became linked in the interim is a real,
 * consumer-visible change). Parties, the trial type and the institution date are added because they
 * are emitted fields too. `trialLastModifiedDateTime` is deliberately excluded: it is a server-side
 * "touched" timestamp that moves on edits no consumer can see and would turn every re-touch into an
 * `updated` row.
 */
export function ptabFingerprint(flat: PtabFlatRecord): string {
    return fingerprintOf([
        flat.trialStatusCategory,
        flat.institutionDecisionDate,
        flat.latestDecisionDate,
        flat.terminationDate,
        flat.fileDownloadURI,
        flat.trialTypeCode,
        flat.patentNumber,
        flat.patentOwnerName,
        flat.patentOwnerRealPartyInInterestName,
        flat.petitionerRealPartyInInterestName,
    ]);
}

/** Patent owner / petitioner entity names, space-joined and de-duplicated (counsel and inventors are people/law firms, not the entities a watchlist targets). */
export function ptabWatchText(flat: PtabFlatRecord): string {
    const names: string[] = [];
    for (const name of [flat.patentOwnerName, flat.patentOwnerRealPartyInInterestName, flat.petitionerRealPartyInInterestName]) {
        if (name !== null && !names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    return names.join(' ');
}

export function toPtabSourceRecord(flat: PtabFlatRecord): SourceRecord {
    return {
        recordId: flat.trialNumber,
        fingerprint: ptabFingerprint(flat),
        payload: { ...flat, ...ptabUmsFields(flat) },
        watchText: ptabWatchText(flat),
    };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Upper-cases string elements so `ipr` and `IPR` select the same trial type; non-strings pass through to the enum check. */
function upperCaseElements(value: unknown): unknown {
    return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : item)) : value;
}

/**
 * `usptoOdpApiKey` is deliberately NOT required by the schema itself: the router checks
 * `requiredOptions` right after parsing and reports "Source "uspto_ptab" requires option(s):
 * usptoOdpApiKey" (a blank key counts as missing), which is the clearer preflight message.
 * Unknown keys are rejected so a copied-over legacy option (`onlyNew`, `maxItemsPerSource`, ...)
 * fails loudly instead of being silently ignored.
 */
export const usptoPtabOptionsSchema = z
    .object({
        /** BYOK: an already-issued USPTO Open Data Portal API key (sent as `x-api-key`; never logged). */
        usptoOdpApiKey: z.string().trim().optional(),
        /** Filters by trialMetaData.trialTypeCode. Empty = all four trial types. */
        trialTypeCodes: z.preprocess(upperCaseElements, z.array(z.enum(PTAB_TRIAL_TYPE_CODES))).default([]),
        /** Restricts to proceedings whose petitionFilingDate is inside this window (applied server-side as a rangeFilter). */
        dateRange: z.enum(DATE_RANGES).optional(),
    })
    .strict();
export type UsptoPtabOptions = z.infer<typeof usptoPtabOptionsSchema>;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Replaces every occurrence of each secret (length >= 4) with `***`. Pure; exported for tests. */
export function scrubSecrets(message: string, secrets: ReadonlyArray<string | undefined>): string {
    let scrubbed = message;
    for (const secret of secrets) {
        if (secret !== undefined && secret.length >= 4) scrubbed = scrubbed.split(secret).join('***');
    }
    return scrubbed;
}

function describeFailure(error: unknown, secrets: ReadonlyArray<string | undefined>): string {
    if (error instanceof HttpStatusError) {
        const hint =
            error.status === 401 || error.status === 403
                ? ' - the USPTO ODP key was rejected (missing, mistyped, expired, or the USPTO.gov account lost ODP access)'
                : error.status === 429
                  ? ' - rate limited (ODP allows burst = 1 and asks for at least 5 s between retries)'
                  : '';
        const preview = error.bodyPreview ? `: ${error.bodyPreview.replace(/\s+/g, ' ').trim()}` : '';
        return scrubSecrets(`USPTO ODP PTAB search answered HTTP ${error.status}${preview}${hint}`, secrets);
    }
    return scrubSecrets(`USPTO ODP PTAB search failed: ${error instanceof Error ? error.message : String(error)}`, secrets);
}

/**
 * Pages through proceedings/search newest-filed-first, up to `maxItemsPerSource`. Strictly
 * sequential (ODP burst = 1). A failure on the FIRST page is a source failure; a failure on a
 * LATER page keeps the pages already fetched (they are valid, and delta memory simply has not
 * seen the rest yet) and logs the truncation.
 */
export async function fetchPtabProceedings(ctx: ConnectorContext, options: UsptoPtabOptions, run: RunParams): Promise<SourceRecord[]> {
    const apiKey = options.usptoOdpApiKey;
    if (apiKey === undefined || apiKey === '') {
        throw new SourceFetchError('usptoOdpApiKey is required for source uspto_ptab (BYOK; see sourceOptions.uspto_ptab).', PTAB_SOURCE_ID);
    }
    const secrets = [apiKey];
    const maxItems = run.maxItemsPerSource;
    if (maxItems <= 0) return [];

    const now = ctx.now();
    const params: PtabSearchParams = {
        trialTypeCodes: options.trialTypeCodes,
        filingDateFrom: dateRangeToFrom(options.dateRange, now),
        filingDateTo: now.toISOString().slice(0, 10),
    };

    const byTrial = new Map<string, SourceRecord>();
    let skippedWithoutTrialNumber = 0;
    let offset = 0;

    while (byTrial.size < maxItems) {
        const requested = Math.min(PTAB_MAX_PAGE_SIZE, maxItems - byTrial.size);
        let page: PtabSearchResponse;
        try {
            page = await ctx.http.getJson<PtabSearchResponse>(PTAB_SEARCH_URL, {
                method: 'POST',
                headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
                body: JSON.stringify(buildPtabRequestBody(params, offset, requested)),
                timeoutMs: PTAB_TIMEOUT_MS,
                maxBytes: PTAB_MAX_RESPONSE_BYTES,
                minRetryDelayMs: PTAB_MIN_RETRY_DELAY_MS,
            });
        } catch (error) {
            const message = describeFailure(error, secrets);
            if (byTrial.size === 0) throw new SourceFetchError(message, PTAB_SOURCE_ID);
            ctx.log.warning(`[${PTAB_SOURCE_ID}] page at offset ${offset} failed after ${byTrial.size} proceeding(s); returning what was fetched. ${message}`);
            break;
        }

        if (page === null || typeof page !== 'object' || Array.isArray(page)) {
            throw new SourceFetchError('USPTO ODP PTAB search returned a response that is not a JSON object.', PTAB_SOURCE_ID);
        }
        const bag = page.patentTrialProceedingDataBag;
        if (bag !== undefined && !Array.isArray(bag)) {
            throw new SourceFetchError('USPTO ODP PTAB search returned a patentTrialProceedingDataBag that is not an array - the response shape may have changed.', PTAB_SOURCE_ID);
        }
        if (bag === undefined) ctx.log.warning(`[${PTAB_SOURCE_ID}] response at offset ${offset} had no patentTrialProceedingDataBag; treating it as an empty page.`);
        const proceedings = bag ?? [];
        if (proceedings.length === 0) break;

        const before = byTrial.size;
        for (const proceeding of proceedings) {
            const flat = flattenProceeding(proceeding);
            if (flat === null) {
                skippedWithoutTrialNumber += 1;
                continue;
            }
            // De-duplicate by trialNumber: even with the trialNumber tie-break sort, a record can be
            // re-served across two page requests (a tie-break shifting between requests, a retried page).
            if (!byTrial.has(flat.trialNumber)) byTrial.set(flat.trialNumber, toPtabSourceRecord(flat));
            if (byTrial.size >= maxItems) break;
        }

        if (proceedings.length < requested) break; // short page = last page
        if (byTrial.size === before) {
            ctx.log.warning(`[${PTAB_SOURCE_ID}] page at offset ${offset} added no new proceedings (all duplicates); stopping to avoid looping on a repeated page.`);
            break;
        }
        offset += proceedings.length;
    }

    if (skippedWithoutTrialNumber > 0) ctx.log.warning(`[${PTAB_SOURCE_ID}] skipped ${skippedWithoutTrialNumber} proceeding(s) with no trialNumber.`);
    ctx.log.info(`[${PTAB_SOURCE_ID}] fetched ${byTrial.size} trial proceeding(s).`);
    return [...byTrial.values()];
}

export const usptoPtabConnector: Connector<UsptoPtabOptions> = {
    id: PTAB_SOURCE_ID,
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'actor-21-patent-ip-enforcement-monitor',
    description:
        'USPTO Patent Trial and Appeal Board trial proceedings (IPR / PGR / CBM / DER) from the USPTO Open Data Portal, newest petition first. BYOK: needs your own USPTO ODP API key.',
    status: 'active',
    optionsSchema: usptoPtabOptionsSchema,
    requiredOptions: ['usptoOdpApiKey'],
    fetch: fetchPtabProceedings,
};
