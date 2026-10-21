/**
 * clinicaltrials_orange_book - ClinicalTrials.gov study registry + FDA Orange Book (patent / exclusivity).
 *
 * Absorbs the legacy actor `actor-24-clinical-trials-delta-engine` as ONE connector whose `subSources` option
 * selects `clinicaltrials`, `orange_book` or both.
 *
 * LEGACY SLUG NOTE. The corpus uses TWO names for this actor and they are the same product:
 *   - repository / `legacyActor` here: `actor-24-clinical-trials-delta-engine`
 *     (delta-registry-website/lib/actors.ts, the repo's README, the Apify console id PkYgfW33Sh6teGXUX);
 *   - Apify platform slug after the rename: `clinicaltrials-orange-book-delta`
 *     (delta-registry-website/scripts/generate_dashboard.py APIFY_SLUG_OVERRIDES and
 *     .github/workflows/fleet-health-check.yml; this is also the name `lib/_guards.ts` uses).
 * Other connectors in this repo use the repository name as `legacyActor`; this one follows that convention.
 *
 * WHAT THERE WAS TO PORT - read before relying on it
 * ----------------------------------------------------------------------------
 * `actor-24-clinical-trials-delta-engine` is a README-ONLY wrapper repo: the production TypeScript is closed and
 * there is no `src/`. What exists in the corpus, and what this port is built from:
 *   - the README (documented input: `sources`, `condition`, `orangeBookQuery`, `onlyChanged`, `maxPages`,
 *     `maxRetries`, `fdaApiKey`; documented output vocabulary: nct_id, brief_title, overall_status,
 *     last_update_post_date, status_verified_date, lead_sponsor, conditions, phases, source_url, data_source,
 *     application_number, product_number, trade_name, ingredient, te_code, patent_data);
 *   - the free Python stubs `delta-registry-clinicaltrials-stub/main.py` and
 *     `delta-registry-clinicaltrials-full-stub/main.py`, whose comments say the endpoint and the
 *     `protocolSection.*` paths are "the real endpoint used by the production actor's fetchSources.ts";
 *   - the website's schema export (`public/schemas/actor-24-.../openai-chat-completions.json`).
 * Neither the README nor the website documents any keyword / sponsor / watch-list input: the only free-text
 * inputs are `condition` and `orangeBookQuery`. The two list options below (`sponsors`, `keywords`) are NEW in
 * this port; they exist because a pharma watch-list is the natural use of this source, and because the keyword
 * guard in lib/_guards.ts (the ghost-billing remediation) has to cover every list a connector accepts.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION (2026-10-21, curl through the sandbox egress proxy)
 * ============================================================================
 * ClinicalTrials.gov API v2 - https://clinicaltrials.gov/api/v2/studies (public, no key)
 *   GET /api/v2/version -> 200 {"apiVersion":"2.0.5","dataTimestamp":"2026-10-20T09:00:04"}.
 *   - `fields=` accepts both module paths (the legacy stubs) and piece names; this connector sends piece names
 *     (NCTId,BriefTitle,OverallStatus,LastUpdatePostDate,StatusVerifiedDate,LeadSponsorName,Collaborator,
 *     Condition,Phase,InterventionName) because the response then carries only what is used (~70 KB per 1000
 *     NCT ids instead of whole modules). The response nests exactly as the legacy stub reads it:
 *     protocolSection.identificationModule.{nctId,briefTitle}, statusModule.{overallStatus,statusVerifiedDate,
 *     lastUpdatePostDateStruct.date}, sponsorCollaboratorsModule.{leadSponsor.name,collaborators[].name},
 *     conditionsModule.conditions[], designModule.phases[], armsInterventionsModule.interventions[].name.
 *     Observational studies have no `phases` key at all (seen live, NCT04747522).
 *   - `sort=LastUpdatePostDate:desc` works; `pageToken` (taken from `nextPageToken`) pages without overlap;
 *     `pageSize=1000` is accepted; a bad token is HTTP 400 "Incorrect pageToken format".
 *   - `query.cond`, `query.spons` and `query.term` work. `query.spons="Pfizer"` matches COLLABORATORS as well as
 *     lead sponsors (live: lead sponsor "Astellas Pharma Global Development, Inc." with collaborator "Pfizer"),
 *     which is why `watchText` carries collaborators. `query.spons=Pfizer OR Novartis` returned 11,156 studies
 *     (6,097 + 5,099 = 11,196 less 40 shared), so OR works.
 *   - Quoting matters: UNQUOTED `query.term=(((` is HTTP 400 "Error parsing query in Other terms", but the quoted
 *     phrase `"((("` is inert (200, 0 hits); `"Merck (MSD) AND Co"`, `"NOT"`, `"AREA[LastUpdatePostDate]"`,
 *     `"x:y,z"` and `"Johnson & Johnson"` are all plain phrases. Every sponsor/keyword is therefore sent as a
 *     quoted phrase with `"` and `\` removed first. `condition` is passed through unquoted on purpose: the
 *     legacy README documents it as the raw `query.cond` value and users rely on Essie syntax there.
 *   - `filter.advanced=AREA[LastUpdatePostDate]RANGE[2026-10-19,MAX]` -> 2,103 studies (used by `updatedWithin`).
 *   - No matches is HTTP 200 `{"studies":[]}`, not an error.
 *
 * FDA Orange Book - https://api.fda.gov/drug/orangebook.json (openFDA, the source the legacy README names)
 *   - HTTP 200, `meta.last_updated` 2026-10-20, `meta.results.total` 48,865. Result shape (per record):
 *     {product_number, approval_date "YYYYMMDD" | approved_prior_to_1982, products[{active_ingredients[{name,
 *     strength}], brand_name, application_name, application_full_name, application_type "N"|"A",
 *     application_number, therapeutic_equivalence_codes[], reference_listed_drug, reference_standard,
 *     marketing_status, dosage_form, route}], patents[{patent_number, expiration_date, patent_use_code,
 *     patent_submission_date, drug_product_flag, drug_substance_flag, patent_delist_flag}],
 *     exclusivity[{exclusivity_code, exclusivity_expiration_date}]}. In the first 1000 records 51 carry
 *     `patents` and 29 carry `exclusivity`; the keys are ABSENT (not empty) when there is none.
 *   - `limit` 1001 -> 400 BAD_REQUEST; `skip` above 25000 -> 400 "Skip value must 25000 or less."; three
 *     consecutive 1000-row pages with `sort=approval_date:desc` held 3000 distinct (type, application, product)
 *     keys and no duplicates.
 *   - Search: `products.active_ingredients.name:"metformin"` (429 hits, case-insensitive),
 *     `products.application_number:"022081"` (2 hits; the unpadded "22081" is a 404, so the number is padded to
 *     six digits), `products.brand_name`, `products.application_name`, `products.application_full_name`.
 *     `A OR B` works (419 + 54 = 473 for two applicants); parentheses and `AND` work; quoted phrases are inert.
 *   - LIKE the sibling FDA recall connector, an empty result is HTTP 404 `{"error":{"code":"NOT_FOUND",...}}`
 *     (verified: `products.brand_name:"ZZZNOPE"`), so a 404 whose body says NOT_FOUND is an EMPTY result.
 *   - Authentication: an obviously fake key was rejected with 403 API_KEY_INVALID by BOTH `api_key=` and HTTP
 *     Basic (key as username), so the header form is honoured and is what this connector uses (the key then
 *     never appears in a URL, hence never in lib/http.ts error text). Documented limits (legacy README, openFDA):
 *     no key 240 requests/min and 1,000/day; with a free key 120,000/day.
 *
 * FDA flat files (NOT used): https://www.fda.gov/media/76860/download?attachment is reachable (EOBZIP_2026_09.zip,
 * 1,099,838 bytes) and holds `~`-delimited products.txt (48,864 rows, header
 * `Ingredient~DF;Route~Trade_Name~Applicant~Strength~Appl_Type~Appl_No~Product_No~TE_Code~Approval_Date~RLD~RS~Type~
 * Applicant_Full_Name`), patent.txt (22,437 rows) and exclusivity.txt (2,420 rows). It is a ZIP, and `ctx.http` is
 * text-only (getText decodes UTF-8), so it cannot be consumed through the connector contract; see the
 * libChangeRequests in the group report. openFDA carries the same product / patent / exclusivity data as JSON, so
 * nothing is lost by using it.
 *
 * DELIBERATE DIFFERENCES FROM THE LEGACY ACTOR (nothing renamed; the legacy vocabulary is kept)
 *   - ORDER. Both sub-sources are queried newest-first (`LastUpdatePostDate:desc`, `approval_date:desc`) so a
 *     run capped by maxItemsPerSource sees the most recently changed trials and the newest approvals. The legacy
 *     walked pages in API order up to `maxPages`.
 *   - `event_type` (NEW_TRIAL / STATUS_CHANGE / NEW_LISTING / PATENT_EXCLUSIVITY_CHANGE / SNAPSHOT_NO_DIFF) and
 *     `previous_status` are NOT ported: they are functions of the previous run's state, which the router owns
 *     (`delta_status` first_seen / updated / unchanged, `is_new`). The router cannot say WHICH field changed.
 *   - `onlyChanged`, `maxRetries`, the dead-letter queue and `actor-start` billing are not connector concerns.
 *   - ADDED (additive, and fingerprinted so the record changes iff a visible field changes): `collaborators`,
 *     `interventions` (trials); `applicant`, `applicant_full_name`, `strength`, `dosage_form`, `route`,
 *     `marketing_status`, `approval_date`, `reference_listed_drug`, `reference_standard`,
 *     `approved_prior_to_1982`, `patent_numbers`, `latest_patent_expiry`, `exclusivity_codes`,
 *     `latest_exclusivity_expiry` (Orange Book).
 *   - `source_url` for an Orange Book row is the openFDA query that returns that product (the only product page
 *     verified from this sandbox; www.accessdata.fda.gov answered the sandbox with an abuse-detection page).
 *   - The run-level maxItemsPerSource covers the whole connector. It is shared between the selected sub-sources
 *     (each gets an even share of what is left, so an exhausted sub-source hands its unused share forward).
 *
 * KEYWORD GUARD (the second victim of the ghost-billing bug). Every list option (`sponsors`, `keywords`) and both
 * free-text filters (`condition`, `orangeBookQuery`) is read through sanitizeKeywordList() INSIDE fetch(), so a
 * connector called directly (as the tests do) is protected exactly like one called through the router. A blank,
 * one-character, punctuation-only or non-string entry is dropped; `['', ' ', 'a']` leaves an EMPTY list, which
 * means "no keyword filter requested": no `query.spons` / `query.term` / `search` clause is sent at all, so it
 * neither narrows to nothing nor expands to a vacuous match, and no billable condition is created. `["  Pfizer  "]`
 * is normalised to `Pfizer`.
 *
 * COMPLIANCE. Public, unauthenticated, documented APIs only. The only credential is the OPTIONAL BYOK
 * `fdaApiKey`, which merely raises the caller's own openFDA rate ceiling.
 */
import { z } from 'zod';

import { describeSanitization, sanitizeKeywordList } from '../../lib/_guards.js';
import { DATE_RANGES, dateRangeToFrom, fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID = 'clinicaltrials_orange_book';

export const CLINICALTRIALS_STUDIES_URL = 'https://clinicaltrials.gov/api/v2/studies';
export const OPENFDA_ORANGE_BOOK_URL = 'https://api.fda.gov/drug/orangebook.json';
export const CLINICALTRIALS_STUDY_BASE_URL = 'https://clinicaltrials.gov/study/';

/** The legacy walk used 100-record ClinicalTrials.gov pages ("Hard cap on the number of 100-record pages"). */
export const CT_PAGE_SIZE = 100;
export const CT_DEFAULT_MAX_PAGES = 100;
/** Verified live: a `limit` above 1000 is HTTP 400. */
export const OPENFDA_MAX_LIMIT = 1000;
/** Verified live: a `skip` above 25000 is HTTP 400. */
export const OPENFDA_MAX_SKIP = 25_000;

/** Piece names verified live; they produce the same protocolSection.* nesting the legacy stubs read. */
export const CT_FIELDS = [
    'NCTId',
    'BriefTitle',
    'OverallStatus',
    'LastUpdatePostDate',
    'StatusVerifiedDate',
    'LeadSponsorName',
    'Collaborator',
    'Condition',
    'Phase',
    'InterventionName',
] as const;

export const SUB_SOURCES = ['clinicaltrials', 'orange_book'] as const;
export type SubSource = (typeof SUB_SOURCES)[number];

/** Legacy `sources` vocabulary (README: `clinicaltrials | orangebook`) accepted as input aliases. */
const SUB_SOURCE_ALIASES: Readonly<Record<string, SubSource>> = {
    clinicaltrials: 'clinicaltrials',
    'clinicaltrials.gov': 'clinicaltrials',
    orange_book: 'orange_book',
    orangebook: 'orange_book',
    'orange-book': 'orange_book',
};

/** Character budget of ONE `query.spons` / `query.term` / openFDA `search` expression; longer lists are chunked. */
export const MAX_EXPRESSION_CHARS = 1500;
/** Sanity cap on requests-series per sub-source so a 500-keyword list cannot silently become hundreds of paged walks. */
export const MAX_QUERIES_PER_SUB_SOURCE = 20;

/** openFDA keys are opaque; accept printable ASCII without whitespace or ":" (":" would corrupt Basic-auth encoding). */
const API_KEY_PATTERN = /^[\x21-\x39\x3b-\x7e]{8,200}$/u;

const LOG_PREFIX = `[${CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID}]`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const nullToUndefined = (value: unknown): unknown => (value === null ? undefined : value);

const subSourceSchema = z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const key = value.trim().toLowerCase();
    return SUB_SOURCE_ALIASES[key] ?? key;
}, z.enum(SUB_SOURCES));

export const clinicaltrialsOrangeBookOptionsSchema = z
    .object({
        /** Which registries to read. Default: ClinicalTrials.gov only (so an Orange Book row is never billed by surprise). */
        subSources: z
            .array(subSourceSchema)
            .min(1, 'Select at least one sub-source: clinicaltrials and/or orange_book.')
            .default(['clinicaltrials'])
            .transform((values) => [...new Set(values)]),
        /** Legacy `condition`: passed raw to ClinicalTrials.gov `query.cond` (Essie syntax allowed). ClinicalTrials only. */
        condition: z.preprocess(nullToUndefined, z.string().optional()),
        /** Legacy `orangeBookQuery`: an ingredient name, or an application number (digits only). Orange Book only. */
        orangeBookQuery: z.preprocess(nullToUndefined, z.string().optional()),
        /**
         * Company names (list, or one comma/semicolon/newline separated string). ClinicalTrials: `query.spons`
         * (lead sponsor OR collaborator). Orange Book: applicant (`application_name`, `application_full_name`).
         * Read ONLY through sanitizeKeywordList(); an empty sanitised list means no sponsor filter.
         */
        sponsors: z.unknown().optional(),
        /**
         * Drug / free-text terms (same shapes). ClinicalTrials: `query.term`. Orange Book: `brand_name` and
         * `active_ingredients.name`. Read ONLY through sanitizeKeywordList().
         */
        keywords: z.unknown().optional(),
        /** ClinicalTrials only: restrict to studies whose last update is inside this window. */
        updatedWithin: z.preprocess(nullToUndefined, z.enum(DATE_RANGES).optional()),
        /** ClinicalTrials only: hard cap on 100-record pages walked per query (legacy `maxPages`). */
        maxPages: z.preprocess(nullToUndefined, z.number().int().min(1).max(CT_DEFAULT_MAX_PAGES).default(CT_DEFAULT_MAX_PAGES)),
        /** Optional BYOK openFDA key. Only raises the caller's own rate ceiling; blank is treated as absent. */
        fdaApiKey: z.preprocess(
            (value) => (value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value),
            z.string().trim().regex(API_KEY_PATTERN, 'fdaApiKey must be 8-200 printable characters without spaces or ":"').optional(),
        ),
    })
    .strict();
export type ClinicalTrialsOrangeBookOptions = z.output<typeof clinicaltrialsOrangeBookOptionsSchema>;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

type QueryParams = ReadonlyArray<readonly [string, string]>;

function toQueryString(params: QueryParams): string {
    return params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/gu, ' ').trim();
    return text === '' ? null : text;
}

function textList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(cleanText).filter((item): item is string => item !== null);
}

/** `[{name: 'x'}, ...]` or `['x', ...]` -> `['x', ...]`. */
function namesOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const names: string[] = [];
    for (const item of value) {
        const name = isRecord(item) ? cleanText(item.name) : cleanText(item);
        if (name !== null) names.push(name);
    }
    return names;
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

/** Locale-independent code-unit comparison, so ordering never depends on the host's ICU data. */
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `YYYYMMDD` -> `YYYY-MM-DD`, or null for anything else (openFDA's compact date form). */
export function isoFromCompactDate(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value.trim());
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * Recursive canonical JSON: object keys are sorted at EVERY nesting level (a top-level-only sort leaves nested
 * objects in source order and produces false "changes" - the bug the legacy docs describe for `patent_data`).
 * Arrays keep their order, so callers sort the arrays that are really sets before calling.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => compareText(a, b));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sortedCanonically<T>(items: readonly T[]): T[] {
    return items
        .map((item) => ({ item, key: canonicalJson(item) }))
        .sort((a, b) => compareText(a.key, b.key))
        .map((entry) => entry.item);
}

/** A double-quoted phrase safe to embed in an Essie / openFDA expression (`"` and `\` cannot appear inside). */
export function quotePhrase(term: string): string {
    return `"${term.replace(/["\\]/gu, ' ').replace(/\s+/gu, ' ').trim()}"`;
}

/** Greedy split of `expressions` into OR-joined chunks no longer than `budget` characters. */
export function chunkExpressions(expressions: readonly string[], budget: number = MAX_EXPRESSION_CHARS): string[] {
    const chunks: string[] = [];
    let current: string[] = [];
    let length = 0;
    for (const expression of expressions) {
        const added = (current.length === 0 ? 0 : ' OR '.length) + expression.length;
        if (current.length > 0 && length + added > budget) {
            chunks.push(current.join(' OR '));
            current = [];
            length = 0;
        }
        length += (current.length === 0 ? 0 : ' OR '.length) + expression.length;
        current.push(expression);
    }
    if (current.length > 0) chunks.push(current.join(' OR '));
    return chunks;
}

/** Even share of what is left for the next sub-source (rolls unused share forward). */
function nextShare(remaining: number, partsLeft: number): number {
    return Math.min(remaining, Math.max(1, Math.floor(remaining / Math.max(1, partsLeft))));
}

// ---------------------------------------------------------------------------
// Keyword guard wiring
// ---------------------------------------------------------------------------

/**
 * Reads one keyword-ish option through sanitizeKeywordList(). `stripQuoting` removes `"` and `\` (then
 * re-validates, so `"a"` cannot survive as the one-character phrase `a`) for values that are embedded in a
 * quoted phrase. Returns the clean keywords; an empty array means "no filtering requested".
 */
export function resolveTerms(ctx: ConnectorContext, field: string, input: unknown, stripQuoting = true): string[] {
    const first = sanitizeKeywordList(input);
    let list = first;
    if (stripQuoting && first.keywords.length > 0) {
        list = sanitizeKeywordList(first.keywords.map((keyword) => keyword.replace(/["\\]/gu, ' ')));
        if (list.keywords.length < first.keywords.length) {
            ctx.log.warning(`${LOG_PREFIX} ${field}: ${first.keywords.length - list.keywords.length} keyword(s) were empty after removing quote characters and were dropped.`);
        }
    }
    const provided = input !== undefined && input !== null;
    if (list.keywords.length > 0) {
        ctx.log.info(`${LOG_PREFIX} ${describeSanitization(first, field)}`);
    } else if (provided) {
        ctx.log.warning(`${LOG_PREFIX} ${describeSanitization(first, field)} No valid keyword remained, so NO ${field} filtering is applied.`);
    }
    return list.keywords;
}

/** Single free-text filter (`condition`, `orangeBookQuery`): a one-element list so a comma inside it is NOT a separator. */
export function resolveSingleTerm(ctx: ConnectorContext, field: string, value: unknown, stripQuoting: boolean): string | undefined {
    if (value === undefined || value === null) return undefined;
    return resolveTerms(ctx, field, [value], stripQuoting)[0];
}

// ---------------------------------------------------------------------------
// ClinicalTrials.gov
// ---------------------------------------------------------------------------

export interface ClinicalTrialRaw {
    nctId: string;
    briefTitle: string | null;
    overallStatus: string | null;
    lastUpdatePostDate: string | null;
    statusVerifiedDate: string | null;
    leadSponsor: string | null;
    collaborators: string[];
    conditions: string[];
    phases: string[];
    interventions: string[];
}

export interface ClinicalTrialsPage {
    studies: ClinicalTrialRaw[];
    nextPageToken: string | null;
    /** Study objects that had no usable NCT id. */
    skipped: number;
}

const NCT_ID = /^NCT\d{8}$/iu;

/** Defensive parse of one `GET /studies` page. Throws on a shape the legacy stub could not have read either. */
export function parseClinicalTrialsPage(body: unknown): ClinicalTrialsPage {
    if (!isRecord(body) || !Array.isArray(body.studies)) {
        throw new Error('unexpected ClinicalTrials.gov response shape: no "studies" array');
    }
    const studies: ClinicalTrialRaw[] = [];
    let skipped = 0;
    for (const study of body.studies) {
        const protocol = isRecord(study) && isRecord(study.protocolSection) ? study.protocolSection : {};
        const identification = isRecord(protocol.identificationModule) ? protocol.identificationModule : {};
        const status = isRecord(protocol.statusModule) ? protocol.statusModule : {};
        const sponsors = isRecord(protocol.sponsorCollaboratorsModule) ? protocol.sponsorCollaboratorsModule : {};
        const conditions = isRecord(protocol.conditionsModule) ? protocol.conditionsModule : {};
        const design = isRecord(protocol.designModule) ? protocol.designModule : {};
        const arms = isRecord(protocol.armsInterventionsModule) ? protocol.armsInterventionsModule : {};

        const nctId = cleanText(identification.nctId)?.toUpperCase() ?? null;
        if (nctId === null || !NCT_ID.test(nctId)) {
            skipped += 1;
            continue;
        }
        const lastUpdate = isRecord(status.lastUpdatePostDateStruct) ? cleanText(status.lastUpdatePostDateStruct.date) : null;
        studies.push({
            nctId,
            briefTitle: cleanText(identification.briefTitle),
            overallStatus: cleanText(status.overallStatus),
            lastUpdatePostDate: lastUpdate,
            statusVerifiedDate: cleanText(status.statusVerifiedDate),
            leadSponsor: isRecord(sponsors.leadSponsor) ? cleanText(sponsors.leadSponsor.name) : null,
            collaborators: unique(namesOf(sponsors.collaborators)),
            conditions: textList(conditions.conditions),
            phases: textList(design.phases),
            interventions: unique(namesOf(arms.interventions)),
        });
    }
    return { studies, nextPageToken: cleanText(body.nextPageToken), skipped };
}

/** Legacy dataset vocabulary (nct_id, brief_title, ... phases) plus the additive `collaborators` / `interventions`. */
export function normalizeClinicalTrial(raw: ClinicalTrialRaw): SourceRecord {
    const watchNames = unique([raw.leadSponsor, ...raw.collaborators, ...raw.interventions].filter((n): n is string => typeof n === 'string' && n !== ''));
    return {
        recordId: raw.nctId,
        // Every payload field except the two derived ones (data_source, source_url) feeds the fingerprint, so a
        // change to any consumer-visible field - not only overall_status - re-emits the trial as `updated`.
        fingerprint: fingerprintOf([
            'clinicaltrials',
            raw.nctId,
            raw.briefTitle,
            raw.overallStatus,
            raw.lastUpdatePostDate,
            raw.statusVerifiedDate,
            raw.leadSponsor,
            raw.collaborators,
            raw.conditions,
            raw.phases,
            raw.interventions,
        ]),
        watchText: watchNames.join(' | '),
        payload: {
            data_source: 'clinicaltrials-gov',
            source_url: `${CLINICALTRIALS_STUDY_BASE_URL}${raw.nctId}`,
            nct_id: raw.nctId,
            brief_title: raw.briefTitle,
            overall_status: raw.overallStatus,
            last_update_post_date: raw.lastUpdatePostDate,
            status_verified_date: raw.statusVerifiedDate,
            lead_sponsor: raw.leadSponsor,
            collaborators: raw.collaborators,
            conditions: raw.conditions,
            phases: raw.phases,
            interventions: raw.interventions,
        },
    };
}

export interface ClinicalTrialsQueryInput {
    condition?: string | undefined;
    sponsors: readonly string[];
    keywords: readonly string[];
    /** `YYYY-MM-DD` lower bound for LastUpdatePostDate. */
    updatedFrom?: string | undefined;
}

/**
 * The independent query series for one run. `condition` and `updatedFrom` narrow EVERY series; `sponsors`
 * (`query.spons`) and `keywords` (`query.term`) are ALTERNATIVES, unioned by the caller. With neither list
 * there is exactly one series (the base filters only, possibly none).
 */
export function buildClinicalTrialsQueries(input: ClinicalTrialsQueryInput): QueryParams[] {
    const base: Array<readonly [string, string]> = [];
    if (input.condition) base.push(['query.cond', input.condition]);
    const tail: Array<readonly [string, string]> = [];
    if (input.updatedFrom) tail.push(['filter.advanced', `AREA[LastUpdatePostDate]RANGE[${input.updatedFrom},MAX]`]);

    const alternatives: Array<readonly [string, string]> = [
        ...chunkExpressions(input.sponsors.map(quotePhrase)).map((expression) => ['query.spons', expression] as const),
        ...chunkExpressions(input.keywords.map(quotePhrase)).map((expression) => ['query.term', expression] as const),
    ];
    if (alternatives.length === 0) return [[...base, ...tail]];
    return alternatives.map((alternative) => [...base, alternative, ...tail]);
}

export function buildClinicalTrialsUrl(query: QueryParams, pageSize: number, pageToken?: string): string {
    const params: Array<readonly [string, string]> = [
        ...query,
        ['sort', 'LastUpdatePostDate:desc'],
        ['fields', CT_FIELDS.join(',')],
        ['pageSize', String(pageSize)],
        ['format', 'json'],
    ];
    if (pageToken) params.push(['pageToken', pageToken]);
    return `${CLINICALTRIALS_STUDIES_URL}?${toQueryString(params)}`;
}

export interface ClinicalTrialsFetchParams {
    maxItems: number;
    queries: readonly QueryParams[];
    maxPages: number;
    /** Test hook; production uses {@link CT_PAGE_SIZE}. */
    pageSize?: number;
}

/** Newest-update-first walk of every query series, merged and capped at `maxItems`. */
export async function fetchClinicalTrials(ctx: ConnectorContext, params: ClinicalTrialsFetchParams): Promise<ClinicalTrialRaw[]> {
    const pageSizeCap = params.pageSize ?? CT_PAGE_SIZE;
    const byId = new Map<string, ClinicalTrialRaw>();
    let skipped = 0;

    for (const query of params.queries) {
        let collected = 0;
        let pages = 0;
        let pageToken: string | undefined;
        while (collected < params.maxItems && pages < params.maxPages) {
            const pageSize = Math.min(pageSizeCap, params.maxItems - collected);
            const body = await ctx.http.getJson<unknown>(buildClinicalTrialsUrl(query, pageSize, pageToken), { maxBytes: 20 * 1024 * 1024 });
            const page = parseClinicalTrialsPage(body);
            pages += 1;
            skipped += page.skipped;
            for (const study of page.studies) {
                if (collected >= params.maxItems) break;
                collected += 1;
                if (!byId.has(study.nctId)) byId.set(study.nctId, study);
            }
            const rawCount = page.studies.length + page.skipped;
            if (!page.nextPageToken || rawCount === 0) break;
            pageToken = page.nextPageToken;
        }
    }
    if (skipped > 0) ctx.log.warning(`${LOG_PREFIX} ${skipped} ClinicalTrials.gov study object(s) skipped: no usable NCT id.`);

    const studies = [...byId.values()];
    if (params.queries.length > 1) {
        studies.sort((a, b) => (b.lastUpdatePostDate ?? '').localeCompare(a.lastUpdatePostDate ?? '') || a.nctId.localeCompare(b.nctId));
    }
    return studies.slice(0, params.maxItems);
}

// ---------------------------------------------------------------------------
// FDA Orange Book (openFDA)
// ---------------------------------------------------------------------------

export interface OrangeBookIngredient {
    name: string;
    strength: string | null;
}

export interface OrangeBookProductRaw {
    applicationType: string;
    applicationNumber: string;
    productNumber: string;
    brandName: string | null;
    applicant: string | null;
    applicantFullName: string | null;
    ingredients: OrangeBookIngredient[];
    dosageForm: string | null;
    route: string | null;
    teCodes: string[];
    marketingStatus: string | null;
    referenceListedDrug: boolean | null;
    referenceStandard: boolean | null;
    /** openFDA compact `YYYYMMDD`, absent for products approved before 1982. */
    approvalDate: string | null;
    approvedPriorTo1982: boolean;
    /** Raw openFDA patent objects (primitive-valued keys copied as received, sorted canonically). */
    patents: Array<Record<string, string | number | boolean>>;
    /** Raw openFDA exclusivity objects. */
    exclusivity: Array<Record<string, string | number | boolean>>;
}

export interface OrangeBookPage {
    products: OrangeBookProductRaw[];
    /** Number of top-level openFDA `results` entries on this page (what `skip` must advance by). */
    resultCount: number;
    total: number | null;
    skipped: number;
}

function rawObjects(value: unknown): Array<Record<string, string | number | boolean>> {
    if (!Array.isArray(value)) return [];
    const objects: Array<Record<string, string | number | boolean>> = [];
    for (const item of value) {
        if (!isRecord(item)) continue;
        const copy: Record<string, string | number | boolean> = {};
        for (const key of Object.keys(item).sort()) {
            const field = item[key];
            if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') copy[key] = field;
        }
        if (Object.keys(copy).length > 0) objects.push(copy);
    }
    return sortedCanonically(objects);
}

function booleanOrNull(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

/** Defensive parse of one openFDA Orange Book page. One output row per (result, product). */
export function parseOrangeBookPage(body: unknown): OrangeBookPage {
    if (!isRecord(body) || !Array.isArray(body.results)) {
        throw new Error('unexpected openFDA Orange Book response shape: no "results" array');
    }
    const meta = isRecord(body.meta) && isRecord(body.meta.results) ? body.meta.results : {};
    const total = typeof meta.total === 'number' && Number.isFinite(meta.total) ? meta.total : null;

    const products: OrangeBookProductRaw[] = [];
    let skipped = 0;
    for (const result of body.results) {
        if (!isRecord(result)) {
            skipped += 1;
            continue;
        }
        const productNumber = cleanText(result.product_number);
        const patents = rawObjects(result.patents);
        const exclusivity = rawObjects(result.exclusivity);
        const entries = Array.isArray(result.products) ? result.products : [];
        let usable = 0;
        for (const entry of entries) {
            if (!isRecord(entry)) continue;
            const applicationNumber = cleanText(entry.application_number);
            const applicationType = cleanText(entry.application_type)?.toUpperCase() ?? null;
            if (productNumber === null || applicationNumber === null || applicationType === null) continue;
            usable += 1;
            const ingredients: OrangeBookIngredient[] = [];
            if (Array.isArray(entry.active_ingredients)) {
                for (const ingredient of entry.active_ingredients) {
                    const name = isRecord(ingredient) ? cleanText(ingredient.name) : null;
                    if (name !== null && isRecord(ingredient)) ingredients.push({ name, strength: cleanText(ingredient.strength) });
                }
            }
            // A combination product's ingredients and TE codes are a SET: sorting them makes a re-ordered upstream
            // list invisible to the fingerprint (the source lists ingredients alphabetically anyway).
            ingredients.sort((a, b) => compareText(a.name, b.name) || compareText(a.strength ?? '', b.strength ?? ''));
            products.push({
                applicationType,
                applicationNumber,
                productNumber,
                brandName: cleanText(entry.brand_name),
                applicant: cleanText(entry.application_name),
                applicantFullName: cleanText(entry.application_full_name),
                ingredients,
                dosageForm: cleanText(entry.dosage_form),
                route: cleanText(entry.route),
                teCodes: textList(entry.therapeutic_equivalence_codes).sort(compareText),
                marketingStatus: cleanText(entry.marketing_status),
                referenceListedDrug: booleanOrNull(entry.reference_listed_drug),
                referenceStandard: booleanOrNull(entry.reference_standard),
                approvalDate: cleanText(result.approval_date),
                approvedPriorTo1982: result.approved_prior_to_1982 === true,
                patents,
                exclusivity,
            });
        }
        if (usable === 0) skipped += 1;
    }
    return { products, resultCount: body.results.length, total, skipped };
}

export function orangeBookRecordId(product: Pick<OrangeBookProductRaw, 'applicationType' | 'applicationNumber' | 'productNumber'>): string {
    return `OB-${product.applicationType}${product.applicationNumber}-${product.productNumber}`;
}

function latestIso(values: readonly unknown[]): string | null {
    const dates = values.map(isoFromCompactDate).filter((d): d is string => d !== null);
    if (dates.length === 0) return null;
    return dates.reduce((latest, date) => (date > latest ? date : latest));
}

/** Legacy Orange Book vocabulary (application_number, product_number, trade_name, ingredient, te_code, patent_data). */
export function normalizeOrangeBookProduct(raw: OrangeBookProductRaw): SourceRecord {
    const ingredientNames = raw.ingredients.map((i) => i.name);
    const strengths = raw.ingredients.map((i) => i.strength).filter((s): s is string => s !== null);
    const patentData = { patents: raw.patents, exclusivity: raw.exclusivity };
    const patentNumbers = unique(raw.patents.map((p) => p.patent_number).filter((n): n is string => typeof n === 'string')).sort();
    const exclusivityCodes = unique(raw.exclusivity.map((e) => e.exclusivity_code).filter((c): c is string => typeof c === 'string')).sort();
    const recordId = orangeBookRecordId(raw);

    const visible = {
        applicationType: raw.applicationType,
        applicationNumber: raw.applicationNumber,
        productNumber: raw.productNumber,
        tradeName: raw.brandName,
        ingredients: raw.ingredients,
        applicant: raw.applicant,
        applicantFullName: raw.applicantFullName,
        dosageForm: raw.dosageForm,
        route: raw.route,
        teCodes: raw.teCodes,
        marketingStatus: raw.marketingStatus,
        referenceListedDrug: raw.referenceListedDrug,
        referenceStandard: raw.referenceStandard,
        approvalDate: raw.approvalDate,
        approvedPriorTo1982: raw.approvedPriorTo1982,
        patentData,
    };
    const watchNames = unique([raw.applicant, raw.applicantFullName, raw.brandName, ...ingredientNames].filter((n): n is string => typeof n === 'string' && n !== ''));

    return {
        recordId,
        fingerprint: fingerprintOf(['orange_book', canonicalJson(visible)]),
        watchText: watchNames.join(' | '),
        payload: {
            data_source: 'openfda-orangebook',
            source_url: orangeBookProductUrl(raw),
            application_type: raw.applicationType,
            application_number: raw.applicationNumber,
            product_number: raw.productNumber,
            trade_name: raw.brandName,
            ingredient: ingredientNames.length > 0 ? ingredientNames.join('; ') : null,
            strength: strengths.length > 0 ? strengths.join('; ') : null,
            applicant: raw.applicant,
            applicant_full_name: raw.applicantFullName,
            dosage_form: raw.dosageForm,
            route: raw.route,
            te_code: raw.teCodes.length > 0 ? raw.teCodes.join(', ') : null,
            marketing_status: raw.marketingStatus,
            reference_listed_drug: raw.referenceListedDrug,
            reference_standard: raw.referenceStandard,
            approval_date: isoFromCompactDate(raw.approvalDate),
            approved_prior_to_1982: raw.approvedPriorTo1982,
            patent_data: patentData,
            patent_numbers: patentNumbers,
            latest_patent_expiry: latestIso(raw.patents.map((p) => p.expiration_date)),
            exclusivity_codes: exclusivityCodes,
            latest_exclusivity_expiry: latestIso(raw.exclusivity.map((e) => e.exclusivity_expiration_date)),
        },
    };
}

/** The openFDA query that returns exactly this product (verified live; the only product URL reachable from the sandbox). */
export function orangeBookProductUrl(product: Pick<OrangeBookProductRaw, 'applicationNumber' | 'productNumber'>): string {
    const search = `products.application_number:"${product.applicationNumber}" AND product_number:"${product.productNumber}"`;
    return `${OPENFDA_ORANGE_BOOK_URL}?${toQueryString([['search', search]])}`;
}

export interface OrangeBookSearchInput {
    /** Legacy `orangeBookQuery` after the guard: an ingredient name or an application number. */
    query?: string | undefined;
    sponsors: readonly string[];
    keywords: readonly string[];
}

/** Digits-only (at most six) means an application number; openFDA stores it zero-padded to six digits. */
export function orangeBookQueryClause(query: string): string {
    if (/^\d{1,6}$/u.test(query)) return `products.application_number:${quotePhrase(query.padStart(6, '0'))}`;
    return `products.active_ingredients.name:${quotePhrase(query)}`;
}

/**
 * The independent `search=` series for one run. `query` narrows EVERY series (AND); `sponsors` (applicant names)
 * and `keywords` (brand / ingredient names) are ALTERNATIVES (OR within a series, series unioned by the caller).
 * `undefined` entries mean "no search clause" - an unfiltered, newest-approvals-first walk.
 */
export function buildOrangeBookSearches(input: OrangeBookSearchInput): Array<string | undefined> {
    const sponsorClauses = input.sponsors.map((term) => {
        const phrase = quotePhrase(term);
        return `products.application_name:${phrase} OR products.application_full_name:${phrase}`;
    });
    const keywordClauses = input.keywords.map((term) => {
        const phrase = quotePhrase(term);
        return `products.brand_name:${phrase} OR products.active_ingredients.name:${phrase}`;
    });
    const alternatives = [...chunkExpressions(sponsorClauses), ...chunkExpressions(keywordClauses)];
    const base = input.query ? orangeBookQueryClause(input.query) : undefined;

    if (alternatives.length === 0) return [base];
    return alternatives.map((alternative) => (base ? `${base} AND (${alternative})` : alternative));
}

export function buildOrangeBookUrl(search: string | undefined, limit: number, skip: number): string {
    const params: Array<readonly [string, string]> = [];
    if (search) params.push(['search', search]);
    params.push(['sort', 'approval_date:desc'], ['limit', String(limit)]);
    if (skip > 0) params.push(['skip', String(skip)]);
    return `${OPENFDA_ORANGE_BOOK_URL}?${toQueryString(params)}`;
}

/** openFDA's "empty result" is an HTTP 404 with a NOT_FOUND body (verified live). Any other 404 is a real failure. */
export function isOpenFdaNoMatches(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { status?: unknown; bodyPreview?: unknown };
    return candidate.status === 404 && typeof candidate.bodyPreview === 'string' && /NOT_FOUND|No matches found/iu.test(candidate.bodyPreview);
}

/** `Authorization: Basic base64(key + ":")` (verified live to be honoured by openFDA), so the key never enters a URL. */
export function openFdaAuthHeaders(apiKey: string | undefined): Record<string, string> | undefined {
    return apiKey ? { authorization: `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}` } : undefined;
}

export interface OrangeBookFetchParams {
    maxItems: number;
    searches: ReadonlyArray<string | undefined>;
    apiKey?: string | undefined;
    /** Test hook; production uses {@link OPENFDA_MAX_LIMIT}. */
    pageLimit?: number;
}

/** Newest-approval-first walk of every search series with `skip` paging, merged and capped at `maxItems`. */
export async function fetchOrangeBook(ctx: ConnectorContext, params: OrangeBookFetchParams): Promise<OrangeBookProductRaw[]> {
    const limitCap = params.pageLimit ?? OPENFDA_MAX_LIMIT;
    const headers = openFdaAuthHeaders(params.apiKey);
    const byId = new Map<string, OrangeBookProductRaw>();
    let skippedInvalid = 0;

    for (const search of params.searches) {
        let collected = 0;
        let skip = 0;
        while (collected < params.maxItems) {
            if (skip > OPENFDA_MAX_SKIP) {
                ctx.log.warning(`${LOG_PREFIX} openFDA refuses skip > ${OPENFDA_MAX_SKIP}; stopping this Orange Book query at ${collected} product(s).`);
                break;
            }
            const limit = Math.min(limitCap, params.maxItems - collected);
            let body: unknown;
            try {
                body = await ctx.http.getJson<unknown>(buildOrangeBookUrl(search, limit, skip), {
                    maxBytes: 20 * 1024 * 1024,
                    ...(headers ? { headers } : {}),
                });
            } catch (error) {
                if (isOpenFdaNoMatches(error)) break;
                throw error;
            }
            const page = parseOrangeBookPage(body);
            skippedInvalid += page.skipped;
            for (const product of page.products) {
                if (collected >= params.maxItems) break;
                collected += 1;
                const id = orangeBookRecordId(product);
                if (!byId.has(id)) byId.set(id, product);
            }
            skip += page.resultCount;
            // A page shorter than the requested limit is the last page (openFDA never short-changes a page that has a successor).
            if (page.resultCount < limit || (page.total !== null && skip >= page.total)) break;
        }
    }
    if (skippedInvalid > 0) {
        ctx.log.warning(`${LOG_PREFIX} ${skippedInvalid} openFDA Orange Book result(s) skipped: no usable application type / number / product number.`);
    }

    const products = [...byId.values()];
    if (params.searches.length > 1) {
        products.sort(
            (a, b) => (b.approvalDate ?? '').localeCompare(a.approvalDate ?? '') || orangeBookRecordId(a).localeCompare(orangeBookRecordId(b)),
        );
    }
    return products.slice(0, params.maxItems);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

function assertQueryBudget(subSource: SubSource, count: number): void {
    if (count > MAX_QUERIES_PER_SUB_SOURCE) {
        throw new Error(
            `${subSource}: the sponsors/keywords lists need ${count} separate queries (the limit is ${MAX_QUERIES_PER_SUB_SOURCE}, ` +
                `about ${MAX_EXPRESSION_CHARS} characters of terms per query); split the list across several runs.`,
        );
    }
}

export const clinicaltrialsOrangeBookConnector: Connector<ClinicalTrialsOrangeBookOptions> = {
    id: CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID,
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'actor-24-clinical-trials-delta-engine',
    description:
        'ClinicalTrials.gov v2 studies (newest update first) and FDA Orange Book products with their patent and exclusivity data (openFDA, newest approval first), ' +
        'in the legacy actor-24 vocabulary. Select registries with subSources; narrow with condition, orangeBookQuery, sponsors, keywords, updatedWithin; optional BYOK fdaApiKey.',
    status: 'active',
    // The Orange Book holds 48,865 products and a keyword run can add trials on top; the 5000 default would evict the
    // oldest ids of a full snapshot and re-emit them as first_seen.
    maxSeenIds: 20_000,
    optionsSchema: clinicaltrialsOrangeBookOptionsSchema,
    // No credential is mandatory: fdaApiKey is an optional rate-limit raiser, so requiredOptions is intentionally absent.

    async fetch(ctx: ConnectorContext, options: ClinicalTrialsOrangeBookOptions, run: RunParams): Promise<SourceRecord[]> {
        const selected = SUB_SOURCES.filter((s) => options.subSources.includes(s));
        const sponsors = resolveTerms(ctx, 'sponsors', options.sponsors);
        const keywords = resolveTerms(ctx, 'keywords', options.keywords);
        const condition = resolveSingleTerm(ctx, 'condition', options.condition, false);
        const orangeBookQuery = resolveSingleTerm(ctx, 'orangeBookQuery', options.orangeBookQuery, true);

        if (!selected.includes('clinicaltrials') && (condition !== undefined || options.updatedWithin !== undefined)) {
            ctx.log.info(`${LOG_PREFIX} condition / updatedWithin apply to ClinicalTrials.gov only and are ignored for orange_book.`);
        }
        if (!selected.includes('orange_book') && orangeBookQuery !== undefined) {
            ctx.log.info(`${LOG_PREFIX} orangeBookQuery applies to the Orange Book only and is ignored for clinicaltrials.`);
        }

        const records: SourceRecord[] = [];
        const failures: string[] = [];
        let attempted = 0;

        for (const [index, subSource] of selected.entries()) {
            const remaining = run.maxItemsPerSource - records.length;
            if (remaining < 1) {
                ctx.log.info(`${LOG_PREFIX} ${subSource}: no share left of maxItemsPerSource=${run.maxItemsPerSource}; skipped.`);
                continue;
            }
            const maxItems = nextShare(remaining, selected.length - index);
            attempted += 1;
            try {
                if (subSource === 'clinicaltrials') {
                    const queries = buildClinicalTrialsQueries({
                        condition,
                        sponsors,
                        keywords,
                        updatedFrom: dateRangeToFrom(options.updatedWithin, ctx.now()),
                    });
                    assertQueryBudget(subSource, queries.length);
                    const studies = await fetchClinicalTrials(ctx, { maxItems, queries, maxPages: options.maxPages });
                    ctx.log.info(`${LOG_PREFIX} clinicaltrials: ${studies.length} study record(s).`);
                    records.push(...studies.map(normalizeClinicalTrial));
                } else {
                    const searches = buildOrangeBookSearches({ query: orangeBookQuery, sponsors, keywords });
                    assertQueryBudget(subSource, searches.length);
                    const products = await fetchOrangeBook(ctx, { maxItems, searches, apiKey: options.fdaApiKey });
                    ctx.log.info(`${LOG_PREFIX} orange_book: ${products.length} product record(s).`);
                    records.push(...products.map(normalizeOrangeBookProduct));
                }
            } catch (error) {
                failures.push(`${subSource}: ${messageOf(error)}`);
                ctx.log.warning(`${LOG_PREFIX} ${subSource} failed - ${messageOf(error)}`);
            }
        }

        if (attempted > 0 && failures.length === attempted) {
            throw new SourceFetchError(`All selected sub-sources failed: ${failures.join(' | ')}`, CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID);
        }
        return records;
    },
};
