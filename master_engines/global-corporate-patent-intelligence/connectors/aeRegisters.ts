/**
 * aeRegisters.ts - UAE corporate registers ("ae_registers") connector: ADGM and DIFC.
 *
 * Absorbs `uae-corporate-registry-monitor` (src/adgmSource.ts, difcSource.ts, the three
 * normalize*Entity functions of deltaEngine.ts, bilingualNormalizer.ts and the output mapping of
 * routes.ts). The legacy delta engine (state.ts, deltaEngine classify / shouldDeliver, the
 * baseline-completion bookkeeping, notifier.ts, timeBudget.ts), main.ts and Actor.pushData / charge
 * are the router's business and are not ported.
 *
 * SUB-SOURCES (option `subSources`, default both)
 *   adgm  Abu Dhabi Global Market public register (Salesforce Aura guest RPC)         ACTIVE
 *   difc  Dubai International Financial Centre public register (Next.js API route)    ACTIVE
 *   dubai_pulse  Dubai mainland DED licences via Dubai Pulse                          HELD (see below)
 *
 * WHY dubai_pulse IS HELD, NOT PORTED. The legacy actor's own record (AGENTS.md section 0.2, source
 * header of dubaiPulseSource.ts: "CONFIDENCE TIER, READ BEFORE MODIFYING") says its wire protocol was
 * NEVER verified against live traffic: the dataset's column schema comes from an archived
 * documentation page, but the JSON response envelope ("array vs {result:{records:[]}} vs something
 * else"), the status-code vocabulary and the authentication mechanism are guesses defended by a
 * fallback chain, access needs a "Request Permission" approval of up to 14 days, and the host rejected
 * every connection attempted from the legacy build environment. A fetcher that guesses the envelope is
 * exactly what the porting doctrine forbids. Re-probed in this session (2026-10-21, no credentials):
 * `GET https://api.dubaipulse.gov.ae/open/ded/ded_license_master-open-api?limit=1&offset=0` with
 * `Authorization: bogus` -> HTTP 401 `{"Exception":"API Gateway encountered an error. Error Message:
 * Unauthorized application request. Request Details: Service - SDG-DDADS-OpenAPI, Operation -
 * /{entity}/{dataset_name}, ... User - Default and Application:sys:defaultApplication"}`: the host is
 * reachable and fronted by an API gateway that wants an APPLICATION identity, which is not evidence for
 * the legacy "one opaque key as the literal Authorization value" assumption either. Selecting it
 * fails preflight (see the options schema) with that reason; no `dubaiPulseApiKey` option exists.
 * Because requiredOptions is static it could not express "needs a credential only when dubai_pulse is
 * selected" anyway; the zod options schema is therefore where sub-source rules live (it rejects the held
 * sub-source) and `requiredOptions` is empty - ADGM and DIFC are anonymous.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * LEGACY RECORD (AGENTS.md section 0, condensed; captured 2026-09-17 / 2026-09-19 in a real browser
 * session, request + response + field vocabulary)
 *  - UAE National Economic Register ("Growth", growth.gov.ae): real, but its open data is 7 legal PDFs and
 *    its licence-search service sits behind UAE Pass (national digital identity) - not automatable.
 *  - ADGM (newreg.adgm.com/s/search-results): a Salesforce Experience Cloud ("Aura") site. A blank name
 *    search returns "Displaying 1 - 10 of 18745 Results" with pagination (true bulk enumeration). The
 *    request is `POST /s/sfsites/aura?r=N&aura.ApexAction.execute=1` invoking Apex controller
 *    `RASearchUtil.getSearchResponseForPR` with a `jsonSearchString` parameter, and carries
 *    `aura.token=null` - genuinely anonymous/guest. It needs a `fwuid` (framework build id) and an
 *    app-loaded marker that rotate when ADGM redeploys, both embedded in the search page's
 *    `/s/sfsites/l/{urlEncodedJson}/bootstrap.js` reference, so they are re-read on every fetch(), never
 *    hard-coded. Real row fields: Name, Entity_Type__c, Incorporation_Date__c, Registration_Number__c,
 *    Entity_Status__c ("Registered", "Deregistered"), Category__c, Entity_Sub_Type__c, License_Status__c
 *    ("Licensed", "Expired", "License cancelled"), nested Addresses__r and Trade_Names__r.
 *  - DIFC (difc.com/business/public-register): the default list loads with no search term. First-party
 *    Next.js route `POST https://www.difc.com/api/handleRequest`, body `{name:"", licenseType:"",
 *    licenseNo:"", status:"", offset:0, slug:"/CRM/public-register", method:"POST"}`, reply
 *    `{Data:{companyList:[...]}, IsSuccess:true, ...}`, 10 rows per page, `offset` pagination. Real row
 *    fields: Name, ROC_Status__c ("Active", "Dissolved", "Inactive - Struck Off"),
 *    Registration_License_No__c, Legal_Type_of_Entity__c, Legal_Entity_Type__c, ROC_reg_incorp_Date__c,
 *    License_Activity_Details__c (semicolon-delimited), Nature_of_business__c, Registered_Address__c,
 *    Company_Type__c.
 *  - Not viable (legacy section 0.5): Abu Dhabi mainland (ADDED catalogue stale since 2023), Sharjah
 *    (single-record lookup only), Ajman (static codebooks), RAK / UAQ / Fujairah (no portal found), federal
 *    CKAN portals (HTTP 403 bot protection), SCA/CMA and CBUAE (financial-sector licensees only, request
 *    mechanics never captured).
 *  - OUTAGE (docs/monitoring/UAE_OUTAGE_PLAYBOOK.md, confirmed 2026-09-17 by 4 independent checks): ADGM's
 *    Apex controller throws `System.NullPointerException` ("null input to JSON parser") at
 *    `Class.RASearchUtil.getSearchResponseForPR: line 2889` and DIFC's route answers HTTP 500 - both
 *    server-side, reproduced with fresh tokens and connections, not fixable client-side.
 *
 * RE-VERIFIED IN THIS PORT SESSION (2026-10-21, curl / the lib HTTP client through the sandbox egress proxy)
 *   GET https://newreg.adgm.com/s/search-results -> HTTP 200, 115,857 bytes, containing the
 *     `/s/sfsites/l/%7B...%7D/bootstrap.js` reference; extractAuraBootstrap() read a 72-character fwuid and a
 *     27-character app-loaded marker from the live page (lib HTTP client, honest User-Agent, no impersonation).
 *   POST https://newreg.adgm.com/s/sfsites/aura?r=1&aura.ApexAction.execute=1 (legacy search string, blank name,
 *     aura.token=null, that fresh bootstrap) -> a 2xx reply whose action is in ERROR:
 *       [{"exceptionType":"System.NullPointerException","message":"null input to JSON parser","stackTrace":
 *        "(System Code)\nClass.RASearchUtil.getSearchResponseForPR: line 2889, column 1"}]
 *     i.e. exactly the signature the legacy outage playbook recorded on 2026-09-17, so the ADGM failure is still
 *     in place on 2026-10-21, 34 days later. The request does reach the Apex method; this session could NOT tell a
 *     server-side defect from a drifted request contract (that needs a browser capture of ADGM's own page, and no
 *     browser exists in the sandbox). ZERO live ADGM rows were obtained: the row parser rests on the legacy
 *     fixtures and README capture alone.
 *   POST https://www.difc.com/api/handleRequest (legacy body, offset 0) -> HTTP 500 "Internal Server Error", via
 *     both curl and the lib HTTP client - the legacy outage signature again. ZERO live DIFC rows.
 *   Consequence: the connector is `active` (the legacy design, and its outage playbook, is "recovery on the
 *   government's end is enough" and a failing source degrades gracefully), but today a run that selects only
 *   ae_registers reports `every selected UAE register sub-source failed` with those two upstream errors.
 *
 * Honest limits of this connector, stated where they bite:
 *  - TRANSPORT. The legacy actor used `impit` (real Chrome TLS/HTTP2 fingerprint impersonation). The
 *    master engines' compliance doctrine forbids fingerprint spoofing, so this connector goes through
 *    `ctx.http` (Node fetch, honest User-Agent) only. If a register answers an honest client differently
 *    from an impersonated browser, the connector fails loudly (SourceFetchError) instead of imitating one.
 *  - COVERAGE. Both registers are alphabetical / default-ordered snapshots of ~10^4 entities (ADGM listed
 *    18,745 when verified), not newest-first feeds, and `maxItemsPerSource` is capped at 10,000 by the
 *    router: a run reads the FIRST `maxItemsPerSource` entities of each register. Entities beyond that
 *    window are not monitored by this connector. The legacy actor enumerated the whole register
 *    (~375 ADGM pages) within its run-time budget.
 *  - NO OFFICER DATA. None of the verified list views expose officers, directors or beneficial owners
 *    (legacy AGENTS.md section 3); none is invented.
 * ============================================================================
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const AE_SOURCE_ID = 'ae_registers';
export const ADGM_SEARCH_PAGE_URL = 'https://newreg.adgm.com/s/search-results';
export const ADGM_AURA_ENDPOINT = 'https://newreg.adgm.com/s/sfsites/aura';
export const DIFC_HANDLE_REQUEST_URL = 'https://www.difc.com/api/handleRequest';
/** Legacy page sizes: ADGM 50 (a `pageSize` field of the search string), DIFC 10 (observed live; no size parameter was ever seen on the request). */
export const ADGM_PAGE_SIZE = 50;
export const DIFC_OBSERVED_PAGE_SIZE = 10;
/** ADGM + DIFC together; the router slices to maxItemsPerSource (<= 10,000) so this is headroom for renames, not a feature. */
export const AE_MAX_SEEN_IDS = 20_000;

const MAX_HTML_BYTES = 5_000_000;
const MAX_PAGE_BYTES = 10_000_000;

export type AeSubSource = 'adgm' | 'difc';
export const AE_ACTIVE_SUB_SOURCES: readonly AeSubSource[] = ['adgm', 'difc'];

export const DUBAI_PULSE_HELD_REASON =
    'sub-source "dubai_pulse" is held: the legacy actor never verified its wire protocol against live traffic (response envelope, status vocabulary and authentication are guesses behind a 14-day access-approval gate), and a live probe on 2026-10-21 got an API-gateway "Unauthorized application request" that does not confirm the assumed raw-key Authorization header. Use "adgm" and/or "difc".';

// ---------------------------------------------------------------------------
// Raw row shapes (field names are the exact Account-object / API names observed live)
// ---------------------------------------------------------------------------

export interface AdgmEntityRow {
    Id?: string | null;
    Name?: string | null;
    Entity_Type__c?: string | null;
    Is_continued__c?: boolean | null;
    Incorporation_Date__c?: string | null;
    Registration_Number__c?: string | null;
    Entity_Status__c?: string | null;
    Category__c?: string | null;
    Entity_Sub_Type__c?: string | null;
    License_Status__c?: string | null;
    Addresses__r?: { Full_Address__c?: string; Address_for_DDP__c?: string }[] | null;
    Trade_Names__r?: { Name_in_English__c?: string; Status__c?: string }[] | null;
}

/** `Type_for_PR__c` (present on every real row) is deliberately unmodelled: observed always null, significance unconfirmed. */
export interface DifcCompanyRow {
    Id?: string | null;
    Name?: string | null;
    ROC_Status__c?: string | null;
    Registration_License_No__c?: string | null;
    Legal_Type_of_Entity__c?: string | null;
    Legal_Entity_Type__c?: string | null;
    ROC_reg_incorp_Date__c?: string | null;
    License_Activity_Details__c?: string | null;
    Nature_of_business__c?: string | null;
    Registered_Address__c?: string | null;
    Company_Type__c?: string | null;
    Website?: string | null;
}

export type DataSourceId = 'ADGM_FREEZONE' | 'DIFC_FREEZONE';

/** The legacy shared envelope. Key ORDER matters: content_fingerprint hashes it as serialised. */
export interface NormalizedEntity {
    dataSource: DataSourceId;
    recordId: string;
    sourceSpecificId: string;
    commercialNameEn: string;
    commercialNameEnNormalized: string;
    commercialNameAr: string | null;
    commercialNameArNormalized: string | null;
    legalForm: string | null;
    registrationStatus: string | null;
    licenseStatus: string | null;
    /** The primary trade name's own status (ADGM `Trade_Names__r[0].Status__c`); null where the source has no such concept. */
    tradeNameStatus: string | null;
    activities: string[];
    issueDate: string | null;
    expiryDate: string | null;
    cancelDate: string | null;
    registeredAddress: string | null;
    freeZone: boolean;
}

// ---------------------------------------------------------------------------
// Bilingual normalisation (verbatim port of the legacy bilingualNormalizer.ts)
// ---------------------------------------------------------------------------

/** Builds a `[...]`-style character-class body from one or more [start, end] decimal code-point ranges (end omitted for a single code point). */
function codePointRangesToClassBody(ranges: [number, number?][]): string {
    return ranges.map(([start, end]) => (end === undefined ? String.fromCodePoint(start) : `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`)).join('');
}

/** Arabic combining diacritics (tashkeel: fatha, damma, kasra, sukun, shadda, tanwin - U+0610-U+061A, U+064B-U+065F, U+0670, U+06D6-U+06DC, U+06DF-U+06E8, U+06EA-U+06ED) plus the tatweel/kashida elongation character (U+0640) - both are purely presentational and carry no distinguishing identity information for an entity name. */
const ARABIC_DIACRITICS_AND_TATWEEL = new RegExp(
    `[${codePointRangesToClassBody([[0x0610, 0x061a], [0x064b, 0x065f], [0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e8], [0x06ea, 0x06ed], [0x0640]])}]`,
    'gu',
);

/** Unicode bidi control characters (LRM U+200E, RLM U+200F, ALM U+061C, the explicit embedding/override range U+202A-U+202E, and the isolate range U+2066-U+2069) that can appear invisibly in copy-pasted or exported bilingual text and would otherwise corrupt exact-match comparison. */
const BIDI_CONTROL_CHARS = new RegExp(`[${codePointRangesToClassBody([[0x200e], [0x200f], [0x061c], [0x202a, 0x202e], [0x2066, 0x2069]])}]`, 'gu');

const ARABIC_INDIC_DIGIT_BASE = 0x0660; // U+0660 ARABIC-INDIC DIGIT ZERO; U+0660..U+0669 map onto '0'..'9' in order.
const ARABIC_INDIC_DIGITS_PATTERN = new RegExp(`[${String.fromCodePoint(ARABIC_INDIC_DIGIT_BASE)}-${String.fromCodePoint(ARABIC_INDIC_DIGIT_BASE + 9)}]`, 'gu');

function normalizeArabicDigits(text: string): string {
    return text.replace(ARABIC_INDIC_DIGITS_PATTERN, (digit) => String((digit.codePointAt(0) ?? ARABIC_INDIC_DIGIT_BASE) - ARABIC_INDIC_DIGIT_BASE));
}

const ARABIC_ALEF_VARIANTS_PATTERN = new RegExp(`[${codePointRangesToClassBody([[0x0623], [0x0625], [0x0622], [0x0671]])}]`, 'gu');
const ARABIC_BARE_ALEF = String.fromCodePoint(0x0627);

/** Collapses the four hamza-bearing/plain alef forms (U+0623, U+0625, U+0622, U+0671) to bare alef (U+0627) - the standard Arabic search-normalization step, since these are typically orthographic/spelling variants of the same name rather than distinguishing information at the entity-name level. */
function normalizeArabicAlef(text: string): string {
    return text.replace(ARABIC_ALEF_VARIANTS_PATTERN, ARABIC_BARE_ALEF);
}

const ARABIC_ALEF_MAKSURA_PATTERN = new RegExp(String.fromCodePoint(0x0649), 'gu');
const ARABIC_YEH = String.fromCodePoint(0x064a);

/** Collapses alef maksura (U+0649) to yeh (U+064A) - the other standard Arabic search-normalization step for Gulf-region text, where the two are used near-interchangeably in practice. */
function normalizeArabicYeh(text: string): string {
    return text.replace(ARABIC_ALEF_MAKSURA_PATTERN, ARABIC_YEH);
}

const NBSP = String.fromCodePoint(0x00a0);
const WHITESPACE_PATTERN = new RegExp(`[\\s${NBSP}]+`, 'g');

function collapseWhitespace(text: string): string {
    return text.replace(WHITESPACE_PATTERN, ' ').trim();
}

/**
 * Strips diacritics, tatweel, and bidi control characters; normalizes alef/yeh variants and
 * Arabic-Indic digits to Western digits; collapses whitespace. Returns null for null input rather
 * than an empty string, so "no Arabic name on this record" stays distinguishable from "an Arabic
 * name that normalized to nothing."
 */
export function normalizeArabicText(text: string | null): string | null {
    if (text === null) return null;
    let result = text;
    result = result.replace(BIDI_CONTROL_CHARS, '');
    result = result.replace(ARABIC_DIACRITICS_AND_TATWEEL, '');
    result = normalizeArabicAlef(result);
    result = normalizeArabicYeh(result);
    result = normalizeArabicDigits(result);
    result = collapseWhitespace(result);
    return result;
}

/**
 * Canonical English legal-entity-suffix forms. Matched case-insensitively against a name's
 * trailing tokens, longest pattern first so e.g. "FZ-LLC" is not partially matched by a bare "LLC"
 * rule first. This is deliberately a small, real, UAE-specific list (not a generic company-suffix
 * library) - each pattern below was named explicitly in the engineering mandate or observed live
 * in the three verified data sources' own Entity_Type__c / Legal_Type_of_Entity__c / license
 * category vocabularies during this build.
 *
 * Every pattern ends in `(?![a-zA-Z])` rather than `\b` - found necessary by this actor's own test
 * suite: `\b` requires a transition between a word and a non-word character, so when the matched
 * text's own last group is an OPTIONAL trailing period (`\.?`) followed by `\b`, the regex engine
 * backtracks to NOT consume that period whenever the abbreviation is itself followed by
 * end-of-string or another punctuation character (e.g. "L.L.C." at the end of a name) - `\b` can
 * never match between two non-word characters ("." and end-of-string), so the trailing period was
 * silently left unconsumed, producing a doubled-up "LLC." instead of "LLC". `(?![a-zA-Z])` has no
 * such requirement: it only asserts "not immediately followed by a letter," which is true whether
 * followed by a period, whitespace, or the end of the string.
 *
 * Every pattern is also wrapped in an optional `(?:\(\s*)?`/`(?:\s*\))?` pair immediately around
 * the legal-form token itself - found missing by adversarial review: this module's own docstring
 * documented "( LLC )" normalizing to "LLC" as a supported example, but no pattern actually matched
 * or stripped the parentheses, so `normalizeEnglishText('Acme (LLC)')` produced 'Acme (LLC)'
 * unchanged while `normalizeEnglishText('Acme LLC')` produced 'Acme LLC' - two real-world export
 * variants of the identical company name that would have fired a spurious ENTITY_UPDATED event.
 * The space is nested INSIDE the optional paren group (`(?:\(\s*)?`), not a separate top-level
 * `\s*` - a first attempt used a top-level `\(?\s*` prefix, which happily matches a bare leading
 * space with NO paren present at all, so it silently swallowed the ordinary separator space before
 * every unparenthesized legal form too (e.g. "Acme Trading LLC" -> "Acme TradingLLC", words fused
 * together) - caught by re-running this exact function against all four documented cases before
 * shipping, not by the test suite. Nesting the `\s*` inside the same non-capturing group as the
 * `\(` ties its consumption to the paren actually being present. This only strips parentheses
 * immediately hugging the legal-form token itself - unrelated parentheses elsewhere in a name (e.g.
 * "Acme (Middle East) LLC") are untouched, since the regex only starts matching at the legal-form
 * letters themselves.
 */
const LEGAL_FORM_PATTERNS: [RegExp, string][] = [
    [/(?:\(\s*)?\bf\.?\s*z\.?\s*-?\s*l\.?\s*l\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'FZ-LLC'],
    [/(?:\(\s*)?\bl\.?\s*l\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'LLC'],
    [/(?:\(\s*)?\bp\.?\s*j\.?\s*s\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'PJSC'],
    [/(?:\(\s*)?\bp\.?\s*s\.?\s*c\.?(?![a-zA-Z])(?:\s*\))?/gi, 'PSC'],
    [/(?:\(\s*)?\bsole\s+establishment(?![a-zA-Z])(?:\s*\))?/gi, 'Sole Establishment'],
    [/(?:\(\s*)?\bsole\s+proprietorship(?![a-zA-Z])(?:\s*\))?/gi, 'Sole Establishment'],
    [/(?:\(\s*)?\best\.?(?![a-zA-Z])(?:\s*\))?/gi, 'Est.'],
    [/(?:\(\s*)?\bltd\.?(?![a-zA-Z])(?:\s*\))?/gi, 'Ltd'],
    [/(?:\(\s*)?\blimited(?![a-zA-Z])(?:\s*\))?/gi, 'Limited'],
];

/**
 * Applies canonical spacing/punctuation to known UAE legal-entity-suffix tokens (e.g. "L.L.C",
 * "l.l.c.", "( LLC )" all normalize toward "LLC") and collapses whitespace. This does NOT reorder
 * or strip the suffix - only canonicalizes its punctuation/casing - so "Acme Trading LLC" and
 * "ACME TRADING L.L.C." normalize to the same comparable string without merging two genuinely
 * different company names that happen to share a legal form.
 */
export function normalizeEnglishText(text: string | null): string | null {
    if (text === null) return null;
    let result = collapseWhitespace(text);
    for (const [pattern, canonical] of LEGAL_FORM_PATTERNS) {
        result = result.replace(pattern, canonical);
    }
    result = collapseWhitespace(result);
    return result;
}

/** Splits a semicolon-delimited activity list (the real format observed in ADGM/DIFC's License_Activity_Details__c fields) into a clean array, dropping empty segments produced by a trailing delimiter. */
export function splitActivityList(raw: string | null): string[] {
    if (raw === null) return [];
    return raw
        .split(';')
        .map((activity) => collapseWhitespace(activity))
        .filter((activity) => activity.length > 0);
}

// ---------------------------------------------------------------------------
// ADGM search-string template (verbatim from the legacy actor)
// ---------------------------------------------------------------------------

/**
 * The exact `jsonSearchString` field-schema object ADGM's own guest search page echoes back to
 * itself between its "get search config" call and its "submit search" call - captured verbatim
 * from a real, live response during the legacy actor build (see its AGENTS.md section 0.3). Only
 * `generalSearch[0].headers[0].value` (the name filter), `pageNumber`, and `pageSize` are mutated
 * per request; everything else is ADGM's own object-model metadata, not user-specific state, so
 * reusing a captured copy rather than re-fetching the config every run is a deliberate
 * fewer-requests optimization, not a shortcut - it is exactly what a real browser session does for
 * the lifetime of one page view.
 */
export function buildJsonSearchString(nameFilter: string, pageNumber: number, pageSize: number): string {
    const template = {
        advancedSearch: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    {
                        dataType: 'BOOLEAN',
                        fieldAPIName: 'Is_continued__c',
                        isRequired: false,
                        label: 'Is continued?',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Entity_Status__c',
                        isRequired: false,
                        label: 'Entity Status',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'DATE',
                        fieldAPIName: 'Incorporation_Date__c',
                        isRequired: false,
                        label: 'Incorporation Date',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Category__c',
                        isRequired: false,
                        label: 'Category',
                        options: [],
                        value: '',
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_auditors: [
            {
                fieldSetName: 'SearchFieldsAuditor',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_companies: [
            {
                fieldSetName: 'SearchFieldsAdvComp',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_foliostrataplanstratalot: [
            {
                fieldSetName: 'SearchFieldsFolioStrataPlanLotAdvanced',
                headers: [],
                isParent: false,
                objectName: 'Property__c',
            },
        ],
        advancedSearch_foundation: [
            {
                fieldSetName: 'SearchFieldsAdvFoun',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_general: [
            {
                fieldSetName: 'SearchFieldsAdvGen',
                headers: [
                    {
                        dataType: 'BOOLEAN',
                        fieldAPIName: 'Is_continued__c',
                        isRequired: false,
                        label: 'Is continued?',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Entity_Status__c',
                        isRequired: false,
                        label: 'Entity Status',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'DATE',
                        fieldAPIName: 'Incorporation_Date__c',
                        isRequired: false,
                        label: 'Incorporation Date',
                        options: [],
                        value: '',
                    },
                    {
                        dataType: 'PICKLIST',
                        fieldAPIName: 'Category__c',
                        isRequired: false,
                        label: 'Category',
                        options: [],
                        value: '',
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedSearch_InsolvencyPractitioner: [
            {
                fieldSetName: 'SearchFieldsInsolvencyPractitioner',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_partnership: [
            {
                fieldSetName: 'SearchFieldsAdvPart',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        advancedsearch_RegisteredBuilding: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedBuilding',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredLand: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedLand',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredLease: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvanced',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedsearch_RegisteredUnit: [
            {
                fieldSetName: 'SearchFieldsLeaseAdvancedUnit',
                headers: [],
                isParent: false,
                objectName: 'Linked_Unit__c',
            },
        ],
        advancedSearch_reservedname: [
            {
                fieldSetName: 'ReservedName',
                headers: [],
                isParent: true,
                objectName: 'Trade_Name__c',
            },
        ],
        advancedSearch_role: [
            {
                fieldSetName: 'RoleSearchFields',
                headers: [],
                isParent: true,
                objectName: 'Role__c',
            },
            {
                fieldSetName: 'RoleFieldSet',
                headers: [],
                isParent: false,
                objectName: 'Account',
                relationshipName: 'Subject_Account__r',
            },
        ],
        advancedSearch_temporarypermit: [
            {
                fieldSetName: 'TempPermitSearchFields',
                headers: [],
                isParent: true,
                objectName: 'Account',
            },
        ],
        buttonConfig: {
            buttonPlacement: 'RIGHT',
            buttons: [
                {
                    actionType: 'Create_BookMark',
                    label: 'Add to Watchlist',
                    renderCheckField: 'Show_Request_Option__c',
                    renderCheckValue: 'Add BookMark',
                    styleClass: 'requestBtn',
                },
                {
                    actionType: 'Remove_BookMark',
                    label: 'Remove from Watchlist',
                    renderCheckField: 'Show_Request_Option__c',
                    renderCheckValue: 'Remove BookMark',
                    styleClass: 'cancelBtn',
                },
            ],
            canSelectMultiple: false,
            rowLevel: true,
        },
        defaultOrderBy: 'ASC',
        generalSearch: [
            {
                fieldSetName: 'SearchFields',
                headers: [
                    {
                        dataType: 'STRING',
                        fieldAPIName: 'Name',
                        isRequired: false,
                        label: 'Account Name',
                        options: [],
                        value: nameFilter,
                    },
                ],
                isParent: true,
                objectName: 'Account',
            },
        ],
        generalSearch_Folio: [
            {
                fieldSetName: 'SearchFieldsFolioGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        generalsearch_RegisteredLease: [
            {
                fieldSetName: 'SearchFieldsLeaseGeneral',
                headers: [],
                isParent: true,
                objectName: 'Linked_Unit__c',
            },
        ],
        generalSearch_StrataLot: [
            {
                fieldSetName: 'SearchFieldsStrataLotGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        generalSearch_StrataPlan: [
            {
                fieldSetName: 'SearchFieldsStrataPlanGeneral',
                headers: [],
                isParent: true,
                objectName: 'Property__c',
            },
        ],
        orderByFields: 'Name',
        resultFieldSet: 'RequestAccessSearchResult',
        showAdvancedSearch: false,
        showRegisteredEntities: true,
        pageNumber,
        pageSize: String(pageSize),
    };
    return JSON.stringify(template);
}

// ---------------------------------------------------------------------------
// Row normalisation (port of deltaEngine.ts normalizeAdgmEntity / normalizeDifcEntity)
// ---------------------------------------------------------------------------

/** The string itself (untouched, so fingerprints match the legacy hashes) when it has any non-blank content, else `null`. */
function nonBlank(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** An identity field: a non-blank string, or a finite number stringified. */
function identity(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return nonBlank(value);
}

function requireNonEmpty(value: string | null, fieldLabel: string): string {
    if (value === null) throw new Error(`Row is missing a required field (${fieldLabel}) - cannot normalize this record.`);
    return value;
}

/**
 * ADGM `Registration_Number__c` is the register's own stable per-entity identifier: required, and the
 * record id is `ADGM_FREEZONE::<it>` exactly as the legacy actor built it, so ids never collide with
 * DIFC's even if the two registers reuse a number.
 */
export function normalizeAdgmEntity(row: AdgmEntityRow): NormalizedEntity {
    const registrationNumber = requireNonEmpty(identity(row.Registration_Number__c), 'Registration_Number__c');
    const nameEn = requireNonEmpty(nonBlank(row.Name), 'Name');
    const address = nonBlank(row.Addresses__r?.[0]?.Full_Address__c) ?? nonBlank(row.Addresses__r?.[0]?.Address_for_DDP__c);
    const category = nonBlank(row.Category__c);
    const subType = nonBlank(row.Entity_Sub_Type__c);
    return {
        dataSource: 'ADGM_FREEZONE',
        recordId: `ADGM_FREEZONE::${registrationNumber}`,
        sourceSpecificId: registrationNumber,
        commercialNameEn: nameEn,
        commercialNameEnNormalized: normalizeEnglishText(nameEn) ?? nameEn,
        commercialNameAr: null,
        commercialNameArNormalized: null,
        legalForm: nonBlank(row.Entity_Type__c),
        registrationStatus: nonBlank(row.Entity_Status__c),
        licenseStatus: nonBlank(row.License_Status__c),
        // ADGM's real Trade_Names__r array carries its own Status__c ("Active" -> "Inactive"), a status signal
        // distinct from Entity_Status__c / License_Status__c. The primary (first-listed) trade name is used,
        // matching how ADGM's captured examples always list the main trading name first.
        tradeNameStatus: nonBlank(row.Trade_Names__r?.[0]?.Status__c),
        activities: category !== null ? [category, ...(subType !== null ? [subType] : [])] : [],
        issueDate: nonBlank(row.Incorporation_Date__c),
        expiryDate: null,
        cancelDate: null,
        registeredAddress: address,
        freeZone: true,
    };
}

/** DIFC `Registration_License_No__c` is the register's stable per-entity identifier: required. */
export function normalizeDifcEntity(row: DifcCompanyRow): NormalizedEntity {
    const licenseNo = requireNonEmpty(identity(row.Registration_License_No__c), 'Registration_License_No__c');
    const nameEn = requireNonEmpty(nonBlank(row.Name), 'Name');
    return {
        dataSource: 'DIFC_FREEZONE',
        recordId: `DIFC_FREEZONE::${licenseNo}`,
        sourceSpecificId: licenseNo,
        commercialNameEn: nameEn,
        commercialNameEnNormalized: normalizeEnglishText(nameEn) ?? nameEn,
        commercialNameAr: null,
        commercialNameArNormalized: null,
        legalForm: nonBlank(row.Legal_Type_of_Entity__c) ?? nonBlank(row.Legal_Entity_Type__c),
        registrationStatus: nonBlank(row.ROC_Status__c),
        licenseStatus: nonBlank(row.ROC_Status__c),
        tradeNameStatus: null,
        activities: splitActivityList(nonBlank(row.License_Activity_Details__c)),
        issueDate: nonBlank(row.ROC_reg_incorp_Date__c),
        expiryDate: null,
        cancelDate: null,
        registeredAddress: nonBlank(row.Registered_Address__c),
        freeZone: true,
    };
}

/** SHA-256 over the fields that define "has the entity's STATUS changed" (legacy computeStatusFingerprint, byte-identical). */
export function computeStatusFingerprint(entity: NormalizedEntity): string {
    return createHash('sha256').update(JSON.stringify([entity.registrationStatus, entity.licenseStatus, entity.tradeNameStatus])).digest('hex');
}

/** SHA-256 over every field EXCEPT `recordId` (legacy computeContentFingerprint, byte-identical). */
export function computeContentFingerprint(entity: NormalizedEntity): string {
    const { recordId, ...hashableFields } = entity;
    void recordId;
    return createHash('sha256').update(JSON.stringify(hashableFields)).digest('hex');
}

/**
 * The legacy `OutputRecord` minus what the router now owns: `record_id`, `is_new`, `scraped_at`, and the
 * delta vocabulary derived from legacy state (`event_id`, `event_type`, `previous_registration_status`,
 * `previous_license_status`, `previous_trade_name_status`). The router's `delta_status` replaces
 * `event_type`; it cannot say "STATUS_CHANGED" vs "ENTITY_UPDATED" - the two fingerprints below are kept
 * so a consumer can still tell a status change from a cosmetic edit by comparing `status_fingerprint`
 * across runs.
 */
export function entityPayload(entity: NormalizedEntity): Record<string, unknown> {
    return {
        '@type': 'schema:Corporation',
        data_source: entity.dataSource,
        free_zone: entity.freeZone,
        commercial_name_en: entity.commercialNameEn,
        commercial_name_ar: entity.commercialNameAr,
        legal_form: entity.legalForm,
        registration_status: entity.registrationStatus,
        license_status: entity.licenseStatus,
        trade_name_status: entity.tradeNameStatus,
        activities: entity.activities,
        issue_date: entity.issueDate,
        expiry_date: entity.expiryDate,
        cancel_date: entity.cancelDate,
        registered_address: entity.registeredAddress,
        status_fingerprint: computeStatusFingerprint(entity),
        content_fingerprint: computeContentFingerprint(entity),
    };
}

/**
 * Watch text: every name the entity is known by, Latin and Arabic - the register name, ADGM's English trade
 * names, an Arabic commercial name when the source has one, and its normalised form (so a keyword typed
 * without diacritics still matches). None of the ACTIVE sub-sources publishes an Arabic name today (only the
 * held Dubai Pulse dataset does), so in practice the text is the Latin names; the Arabic branch is the
 * contract for when one appears. Space-joined, de-duplicated case-insensitively.
 */
export function entityWatchText(entity: NormalizedEntity, extraNames: ReadonlyArray<string | null> = []): string {
    const names: string[] = [];
    for (const name of [entity.commercialNameEn, ...extraNames, entity.commercialNameAr, entity.commercialNameArNormalized]) {
        if (name === null || name.trim() === '') continue;
        if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    return names.join(' ');
}

export function toEntityRecord(entity: NormalizedEntity, extraNames: ReadonlyArray<string | null> = []): SourceRecord {
    const payload = entityPayload(entity);
    return {
        recordId: entity.recordId,
        fingerprint: fingerprintOf([payload.status_fingerprint, payload.content_fingerprint]),
        payload,
        watchText: entityWatchText(entity, extraNames),
    };
}

export function adgmRowToRecord(row: AdgmEntityRow): SourceRecord {
    const tradeNames = (Array.isArray(row.Trade_Names__r) ? row.Trade_Names__r : []).map((trade) => nonBlank(trade?.Name_in_English__c));
    return toEntityRecord(normalizeAdgmEntity(row), tradeNames);
}

export function difcRowToRecord(row: DifcCompanyRow): SourceRecord {
    return toEntityRecord(normalizeDifcEntity(row));
}

/** Rows that cannot be normalised are skipped (never given a fabricated identity) and reported once. */
function rowsToRecords<T>(ctx: ConnectorContext, label: string, rows: readonly T[], convert: (row: T) => SourceRecord): SourceRecord[] {
    const records: SourceRecord[] = [];
    let skipped = 0;
    let firstProblem = '';
    for (const row of rows) {
        try {
            if (row === null || typeof row !== 'object') throw new Error('Row is not an object - cannot normalize this record.');
            records.push(convert(row));
        } catch (error) {
            skipped += 1;
            if (firstProblem === '') firstProblem = error instanceof Error ? error.message : String(error);
        }
    }
    if (skipped > 0) ctx.log.warning(`[${AE_SOURCE_ID}] ${label}: skipped ${skipped} row(s) that could not be normalised (first: ${firstProblem})`);
    return records;
}

// ---------------------------------------------------------------------------
// ADGM transport (port of adgmSource.ts: bootstrap, Aura message, response checks, pagination)
// ---------------------------------------------------------------------------

export interface AuraBootstrap {
    fwuid: string;
    appLoadedMarker: string;
}

/**
 * ADGM's Aura RPC needs a `fwuid` (framework build id) and an app-instance marker that both rotate whenever
 * ADGM's Salesforce org is redeployed - there is no stable value to hard-code. Both are embedded in the
 * search-results page's HTML, in a `/s/sfsites/l/{urlEncodedJson}/bootstrap.js` resource reference; this
 * reads them from a fresh page exactly as a browser session would before making any Aura call.
 */
export function extractAuraBootstrap(html: string): AuraBootstrap {
    const bootstrapMatch = /\/s\/sfsites\/l\/(%7B[^"'\s]+?%7D)\/bootstrap\.js/.exec(html);
    if (!bootstrapMatch || bootstrapMatch[1] === undefined) {
        throw new Error("Could not locate the Aura bootstrap config in ADGM's search-results page - the site structure may have changed.");
    }
    let decoded: { fwuid?: string; loaded?: Record<string, string> };
    try {
        decoded = JSON.parse(decodeURIComponent(bootstrapMatch[1])) as typeof decoded;
    } catch {
        throw new Error("ADGM's Aura bootstrap config was found but could not be decoded - the site structure may have changed.");
    }
    const { fwuid } = decoded;
    const appLoadedMarker = decoded.loaded?.['APPLICATION@markup://siteforce:communityApp'];
    if (!fwuid || !appLoadedMarker) {
        throw new Error("ADGM's Aura bootstrap config was found but is missing fwuid/app-loaded fields - the site structure may have changed.");
    }
    return { fwuid, appLoadedMarker };
}

export function buildAuraContext(bootstrap: AuraBootstrap): string {
    return JSON.stringify({
        mode: 'PROD',
        fwuid: bootstrap.fwuid,
        app: 'siteforce:communityApp',
        loaded: { 'APPLICATION@markup://siteforce:communityApp': bootstrap.appLoadedMarker },
        dn: [],
        globals: {},
        uad: true,
    });
}

/** The form-encoded body of one Aura `RASearchUtil.getSearchResponseForPR` call (`aura.token=null`: anonymous guest). */
export function buildAuraRequestBody(bootstrap: AuraBootstrap, nameFilter: string, pageNumber: number): string {
    const message = {
        actions: [
            {
                id: `${pageNumber};a`,
                descriptor: 'aura://ApexActionController/ACTION$execute',
                callingDescriptor: 'UNKNOWN',
                params: {
                    namespace: '',
                    classname: 'RASearchUtil',
                    method: 'getSearchResponseForPR',
                    params: { jsonSearchString: buildJsonSearchString(nameFilter, pageNumber, ADGM_PAGE_SIZE) },
                    cacheable: false,
                    isContinuation: false,
                },
            },
        ],
    };
    return new URLSearchParams({
        message: JSON.stringify(message),
        'aura.context': buildAuraContext(bootstrap),
        'aura.pageURI': '/s/search-results',
        'aura.token': 'null',
    }).toString();
}

interface AuraApexResponse {
    actions?: { state?: string; returnValue?: { returnValue?: { data?: { data?: unknown } } }; error?: unknown[] }[];
}

/**
 * `state === 'SUCCESS'` only says the Apex call did not error, NOT that the expected
 * `returnValue.returnValue.data.data` path exists. A structurally broken reply (a bot-check page that still
 * parses as JSON, a reshaped envelope) must fail loudly rather than masquerade as an empty register page.
 */
export function parseAuraSearchResponse(json: unknown): AdgmEntityRow[] {
    const action = (json as AuraApexResponse | null)?.actions?.[0];
    if (!action || action.state !== 'SUCCESS') {
        throw new Error(`ADGM Aura search action did not succeed: ${String(JSON.stringify(action?.error ?? 'unknown error')).slice(0, 500)}`);
    }
    const container = action.returnValue?.returnValue?.data;
    if (container === undefined || container === null || !Array.isArray(container.data)) {
        throw new Error(
            `ADGM Aura search reported SUCCESS but its response did not contain the expected returnValue.returnValue.data.data array - the site's response shape may have changed (or the page returned a bot-check/interstitial instead of real search results). Raw returnValue: ${String(JSON.stringify(action.returnValue)).slice(0, 500)}`,
        );
    }
    return container.data as AdgmEntityRow[];
}

/**
 * Bulk enumeration with a blank name filter (true bulk, not a per-company lookup). Pages until a page
 * returns fewer rows than the page size or `maxItems` is reached. A failure on the first page is a
 * sub-source failure; a failure on a later page keeps the pages already read and logs the truncation.
 */
export async function fetchAdgmRows(ctx: ConnectorContext, maxItems: number): Promise<AdgmEntityRow[]> {
    const html = await ctx.http.getText(ADGM_SEARCH_PAGE_URL, { maxBytes: MAX_HTML_BYTES });
    const bootstrap = extractAuraBootstrap(html);
    const rows: AdgmEntityRow[] = [];
    for (let pageNumber = 1; rows.length < maxItems; pageNumber += 1) {
        let batch: AdgmEntityRow[];
        try {
            const json = await ctx.http.getJson<unknown>(`${ADGM_AURA_ENDPOINT}?r=${pageNumber}&aura.ApexAction.execute=1`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: buildAuraRequestBody(bootstrap, '', pageNumber),
                maxBytes: MAX_PAGE_BYTES,
            });
            batch = parseAuraSearchResponse(json);
        } catch (error) {
            if (pageNumber === 1) throw error;
            ctx.log.warning(`[${AE_SOURCE_ID}] adgm: page ${pageNumber} failed after ${rows.length} row(s); returning what was read. ${describeFailure(error)}`);
            break;
        }
        rows.push(...batch);
        if (batch.length < ADGM_PAGE_SIZE) break;
    }
    return rows.slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// DIFC transport (port of difcSource.ts)
// ---------------------------------------------------------------------------

interface DifcApiResponse {
    Data?: { companyList?: unknown } | null;
    IsSuccess?: boolean;
    Message?: string | null;
}

/** The `handleRequest` body with every filter blank (full bulk enumeration), exactly as captured live. */
export function buildDifcRequestBody(offset: number): string {
    return JSON.stringify({ name: '', licenseType: '', licenseNo: '', status: '', offset, slug: '/CRM/public-register', method: 'POST' });
}

/** Same structural discipline as the ADGM parser: `IsSuccess: true` without a real `Data.companyList` array is a shape break, not "zero companies". */
export function parseDifcResponse(json: unknown): DifcCompanyRow[] {
    const reply = json as DifcApiResponse | null;
    if (reply === null || typeof reply !== 'object') throw new Error('DIFC handleRequest returned a response that is not a JSON object.');
    if (!reply.IsSuccess) throw new Error(`DIFC handleRequest reported failure: ${reply.Message ?? 'no message'}`);
    const list = reply.Data?.companyList;
    if (!Array.isArray(list)) {
        throw new Error(
            `DIFC handleRequest reported IsSuccess but its response did not contain the expected Data.companyList array - the site's response shape may have changed. Raw response: ${String(JSON.stringify(reply)).slice(0, 500)}`,
        );
    }
    return list as DifcCompanyRow[];
}

/** Bulk enumeration by `offset`, 10 rows per page; stops on a short page or at `maxItems`. Failure policy as for ADGM. */
export async function fetchDifcRows(ctx: ConnectorContext, maxItems: number): Promise<DifcCompanyRow[]> {
    const rows: DifcCompanyRow[] = [];
    for (let offset = 0; rows.length < maxItems; offset += DIFC_OBSERVED_PAGE_SIZE) {
        let batch: DifcCompanyRow[];
        try {
            const json = await ctx.http.getJson<unknown>(DIFC_HANDLE_REQUEST_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: buildDifcRequestBody(offset),
                maxBytes: MAX_PAGE_BYTES,
            });
            batch = parseDifcResponse(json);
        } catch (error) {
            if (offset === 0) throw error;
            ctx.log.warning(`[${AE_SOURCE_ID}] difc: offset ${offset} failed after ${rows.length} row(s); returning what was read. ${describeFailure(error)}`);
            break;
        }
        rows.push(...batch);
        if (batch.length < DIFC_OBSERVED_PAGE_SIZE) break;
    }
    return rows.slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * One sub-source name. `dubai_pulse` is recognised only to be refused with its reason (a bare "Invalid enum
 * value" would hide why a legacy `DUBAI_MAINLAND` user cannot have it). Case and surrounding space are ignored.
 */
const subSourceSchema = z.string().transform((raw, issueCtx): AeSubSource => {
    const value = raw.trim().toLowerCase();
    if (value === 'adgm' || value === 'difc') return value;
    issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: value === 'dubai_pulse' ? DUBAI_PULSE_HELD_REASON : `unknown sub-source "${raw}"; available: ${AE_ACTIVE_SUB_SOURCES.join(', ')}.`,
    });
    return z.NEVER;
});

/** Unknown keys are rejected so a copied-over legacy option (`dubaiPulseApiKey`, `dataSources`, ...) fails loudly. */
export const aeRegistersOptionsSchema = z
    .object({
        subSources: z
            .array(subSourceSchema)
            .min(1, 'Select at least one sub-source (adgm, difc).')
            .transform((list) => [...new Set(list)])
            .default(['adgm', 'difc']),
    })
    .strict();
export type AeRegistersOptions = z.infer<typeof aeRegistersOptionsSchema>;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function describeFailure(error: unknown): string {
    if (error instanceof HttpStatusError) {
        const kind = error.status >= 500 ? ' (upstream server error; the legacy actor documented multi-week ADGM / DIFC server-side outages)' : '';
        return `HTTP ${error.status} for ${error.url}${error.bodyPreview ? `: ${error.bodyPreview}` : ''}${kind}`;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the selected sub-sources in order, each isolated: one register being down (both have had long
 * server-side outages) must not discard the other's rows. The run budget is split evenly over what is left,
 * and whatever a short or failed sub-source did not use rolls over to the next, so a failed ADGM never
 * starves DIFC. Only when EVERY selected sub-source failed does the source fail.
 */
export async function fetchAeRegisters(ctx: ConnectorContext, options: AeRegistersOptions, run: RunParams): Promise<SourceRecord[]> {
    const selected = options.subSources;
    const records: SourceRecord[] = [];
    const failures: string[] = [];
    let remaining = run.maxItemsPerSource;
    let succeeded = 0;

    for (const [index, subSource] of selected.entries()) {
        if (remaining <= 0) break;
        const share = Math.max(1, Math.floor(remaining / (selected.length - index)));
        try {
            const fetched =
                subSource === 'adgm'
                    ? rowsToRecords(ctx, 'adgm', await fetchAdgmRows(ctx, share), adgmRowToRecord)
                    : rowsToRecords(ctx, 'difc', await fetchDifcRows(ctx, share), difcRowToRecord);
            records.push(...fetched);
            remaining -= fetched.length;
            succeeded += 1;
            ctx.log.info(`[${AE_SOURCE_ID}] ${subSource}: ${fetched.length} entit${fetched.length === 1 ? 'y' : 'ies'} (budget ${share}).`);
        } catch (error) {
            const message = `${subSource}: ${describeFailure(error)}`;
            failures.push(message);
            ctx.log.warning(`[${AE_SOURCE_ID}] ${message}`);
        }
    }

    if (succeeded === 0 && failures.length > 0) {
        throw new SourceFetchError(`every selected UAE register sub-source failed - ${failures.join(' | ')}`, AE_SOURCE_ID);
    }
    return records;
}

export const aeRegistersConnector: Connector<AeRegistersOptions> = {
    id: AE_SOURCE_ID,
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'uae-corporate-registry-monitor',
    description:
        'UAE corporate registers - ADGM (Abu Dhabi Global Market) and DIFC (Dubai International Financial Centre) public entity registers, anonymous, with bilingual-safe names and registration / licence status. Dubai Pulse mainland licences are held (unverified wire protocol).',
    status: 'active',
    maxSeenIds: AE_MAX_SEEN_IDS,
    optionsSchema: aeRegistersOptionsSchema,
    fetch: fetchAeRegisters,
};
