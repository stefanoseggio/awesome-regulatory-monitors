/**
 * ae_registers connector tests (ADGM + DIFC active, Dubai Pulse held).
 *
 * Fixtures (test/fixtures/patents-a/, no network), and what each one honestly is:
 *   - adgm_bootstrap_live_excerpt.html   REAL: the bootstrap.js <script> tag of https://newreg.adgm.com/s/search-results, fetched live
 *                                        2026-10-21. Proves the bootstrap extraction against the real page.
 *   - adgm_aura_error_live.json          REAL: the Aura reply ADGM sent for the connector's search request on 2026-10-21 (an Apex
 *                                        System.NullPointerException, the documented outage). Only `actions` kept.
 *   - adgm_aura_page_reconstructed.json  RECONSTRUCTED, not a live reply: ADGM answers an error today. Row 1 rebuilds the record the
 *                                        legacy README says was captured live (0727 HOLDING LIMITED); row 2 is the legacy test row.
 *   - difc_page_reconstructed.json       RECONSTRUCTED from the legacy test row + one SYNTHETIC row; DIFC answers HTTP 500 today.
 * No live ADGM or DIFC ROW was obtainable in this session, so the row parsers rest on the legacy fixtures and on the
 * byte-for-byte match of the status / content fingerprints with the real record printed in the legacy README (asserted below).
 */
import { describe, expect, it } from 'vitest';

import {
    AE_ACTIVE_SUB_SOURCES,
    AE_MAX_SEEN_IDS,
    ADGM_AURA_ENDPOINT,
    ADGM_PAGE_SIZE,
    ADGM_SEARCH_PAGE_URL,
    adgmRowToRecord,
    type AdgmEntityRow,
    aeRegistersConnector,
    aeRegistersOptionsSchema,
    buildAuraContext,
    buildAuraRequestBody,
    buildDifcRequestBody,
    buildJsonSearchString,
    computeContentFingerprint,
    computeStatusFingerprint,
    DIFC_HANDLE_REQUEST_URL,
    DIFC_OBSERVED_PAGE_SIZE,
    difcRowToRecord,
    type DifcCompanyRow,
    entityPayload,
    entityWatchText,
    extractAuraBootstrap,
    fetchAdgmRows,
    fetchAeRegisters,
    fetchDifcRows,
    normalizeAdgmEntity,
    normalizeArabicText,
    normalizeDifcEntity,
    normalizeEnglishText,
    parseAuraSearchResponse,
    parseDifcResponse,
    splitActivityList,
} from '../global-corporate-patent-intelligence/connectors/aeRegisters.js';
import { findKeywordMatch, sanitizeKeywordList } from '../lib/_guards.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, jsonFixture, makeCtx, type RecordedRequest, ROUTER_OWNED_KEYS, runThroughRouter } from './patents-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 500 };
const bootstrapHtml = fixture('adgm_bootstrap_live_excerpt.html');
const auraError = jsonFixture('adgm_aura_error_live.json');
const adgmPage = jsonFixture('adgm_aura_page_reconstructed.json');
const difcPage = jsonFixture('difc_page_reconstructed.json');
const adgmFixtureRows: AdgmEntityRow[] = adgmPage.actions[0].returnValue.returnValue.data.data;
const difcFixtureRows: DifcCompanyRow[] = difcPage.Data.companyList;
const [zeroSevenTwoSeven, testEntity] = adgmFixtureRows as [AdgmEntityRow, AdgmEntityRow];
const [oneFoods, managingOffice] = difcFixtureRows as [DifcCompanyRow, DifcCompanyRow];

/** The real fwuid / app marker of the live excerpt (the same values ADGM echoed back in its reply context). */
const LIVE_FWUID = 'SGRNczhXdnNHNDNKUWhIdXFhdFJlUWtVMjdnTGFERUU2S3FfSVdrcU92bkExNS4zLjE2MDEw';
const LIVE_MARKER = '1893_tc0hDgV9c96ds91w6tiHCw';

const auraSuccess = (rows: unknown[]) => ({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: { returnValue: { data: { data: rows } } } }] });
const difcSuccess = (rows: unknown[]) => ({ Data: { companyList: rows }, ErrorData: null, IsSuccess: true, Errors: null, Message: null, StatusCode: 200, SubStatusCode: null });

const adgmRow = (n: number, extra: Partial<AdgmEntityRow> = {}): AdgmEntityRow => ({
    Name: `ADGM ENTITY ${n} LIMITED`,
    Entity_Type__c: 'Private Company Limited By Shares',
    Incorporation_Date__c: '2024-01-01',
    Registration_Number__c: String(n),
    Entity_Status__c: 'Registered',
    Category__c: 'Non-Financial (Category B)',
    License_Status__c: 'Licensed',
    ...extra,
});
const difcRow = (n: number, extra: Partial<DifcCompanyRow> = {}): DifcCompanyRow => ({
    Name: `DIFC Company ${n} Limited`,
    ROC_Status__c: 'Active',
    Registration_License_No__c: String(5000 + n),
    Legal_Type_of_Entity__c: 'LTD',
    License_Activity_Details__c: 'Holding Company;',
    ...extra,
});

type Serve<T> = unknown[] | ((position: number, request: RecordedRequest) => unknown);
interface UaeServer {
    /** Rows of the ADGM register (served 50 per Aura page), or a function answering each Aura page. */
    adgm?: Serve<AdgmEntityRow>;
    /** Answer for the ADGM search-page GET (default: the real bootstrap excerpt). */
    adgmPage?: unknown;
    /** Rows of the DIFC register (served 10 per offset), or a function answering each offset. */
    difc?: Serve<DifcCompanyRow>;
}

/** A stand-in for the two registers; any request to a host the test did not declare returns an Error. */
function uaeServer(spec: UaeServer) {
    return (request: RecordedRequest): unknown => {
        if (request.url === ADGM_SEARCH_PAGE_URL) return spec.adgmPage ?? bootstrapHtml;
        if (request.url.startsWith(`${ADGM_AURA_ENDPOINT}?`)) {
            if (spec.adgm === undefined) return new Error('ADGM not expected in this test');
            const message = JSON.parse(request.form!.get('message')!);
            const search = JSON.parse(message.actions[0].params.params.jsonSearchString);
            const pageNumber = search.pageNumber as number;
            if (typeof spec.adgm === 'function') return spec.adgm(pageNumber, request);
            return auraSuccess(spec.adgm.slice((pageNumber - 1) * ADGM_PAGE_SIZE, pageNumber * ADGM_PAGE_SIZE));
        }
        if (request.url === DIFC_HANDLE_REQUEST_URL) {
            if (spec.difc === undefined) return new Error('DIFC not expected in this test');
            const offset = request.json.offset as number;
            if (typeof spec.difc === 'function') return spec.difc(offset, request);
            return difcSuccess(spec.difc.slice(offset, offset + DIFC_OBSERVED_PAGE_SIZE));
        }
        return new Error(`unrouted request: ${request.method} ${request.url}`);
    };
}

const options = (subSources?: string[]) => aeRegistersConnector.optionsSchema.parse(subSources ? { subSources } : {});
const aura500 = (request: RecordedRequest) => new HttpStatusError(request.url, 500, 'Internal Server Error');

describe('bilingual normalisation (verbatim port of the legacy bilingualNormalizer.ts)', () => {
    const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

    it('normalizeArabicText strips tashkeel and tatweel, folds alef / alef-maksura variants, maps Arabic-Indic digits, drops bidi controls', () => {
        // Muhammad with a shadda (U+0651) -> plain letters
        expect(normalizeArabicText(cp(0x645, 0x62d, 0x645, 0x651, 0x62f))).toBe(cp(0x645, 0x62d, 0x645, 0x62f));
        // hamza-alef (U+0623), alef-madda (U+0622), hamza-below (U+0625), alef-wasla (U+0671) -> bare alef (U+0627)
        expect(normalizeArabicText(cp(0x623, 0x622, 0x625, 0x671))).toBe(cp(0x627, 0x627, 0x627, 0x627));
        // alef maksura (U+0649) -> yeh (U+064A)
        expect(normalizeArabicText(cp(0x639, 0x644, 0x649))).toBe(cp(0x639, 0x644, 0x64a));
        // tatweel (U+0640) removed
        expect(normalizeArabicText(cp(0x645, 0x640, 0x640, 0x62d))).toBe(cp(0x645, 0x62d));
        // Arabic-Indic digits -> western digits
        expect(normalizeArabicText(cp(0x662, 0x660, 0x662, 0x664))).toBe('2024');
        // bidi controls (LRM U+200E, RLM U+200F, embedding U+202A) removed, whitespace collapsed
        expect(normalizeArabicText(`${cp(0x200e)}a${cp(0x200f)}  b${cp(0x202a)}`)).toBe('a b');
    });

    it('normalizeArabicText keeps "no name" distinct from "a name that normalised to nothing"', () => {
        expect(normalizeArabicText(null)).toBeNull();
        expect(normalizeArabicText(cp(0x651))).toBe('');
    });

    it('normalizeEnglishText canonicalises UAE legal-form suffix punctuation without merging different names', () => {
        expect(normalizeEnglishText('Acme Trading L.L.C.')).toBe('Acme Trading LLC');
        expect(normalizeEnglishText('ACME TRADING l.l.c')).toBe('ACME TRADING LLC');
        expect(normalizeEnglishText('Acme Trading LLC.')).toBe('Acme Trading LLC'); // the legacy trailing-period regression
        expect(normalizeEnglishText('Acme ( LLC )')).toBe('Acme LLC');
        expect(normalizeEnglishText('Acme (LLC)')).toBe('Acme LLC');
        expect(normalizeEnglishText('Acme Trading LLC')).toBe('Acme Trading LLC'); // words not fused
        expect(normalizeEnglishText('Acme Foods F.Z.-L.L.C')).toBe('Acme Foods FZ-LLC');
        expect(normalizeEnglishText('Acme (Middle East) LLC')).toBe('Acme (Middle East) LLC'); // unrelated parentheses untouched
        expect(normalizeEnglishText('Gulf Holdings Ltd.')).toBe('Gulf Holdings Ltd');
        expect(normalizeEnglishText('  Spaced    Out   ')).toBe('Spaced Out');
        expect(normalizeEnglishText(null)).toBeNull();
    });

    it('splitActivityList splits the semicolon-delimited free text and drops empty segments', () => {
        expect(splitActivityList('Holding Company;Managing Office;')).toEqual(['Holding Company', 'Managing Office']);
        expect(splitActivityList(' A ;; B ;')).toEqual(['A', 'B']);
        expect(splitActivityList(null)).toEqual([]);
    });
});

describe('legacy fidelity: the real ADGM record the legacy README prints', () => {
    const entity = normalizeAdgmEntity(zeroSevenTwoSeven);

    it('rebuilds the README record field by field', () => {
        expect(entity).toEqual({
            dataSource: 'ADGM_FREEZONE',
            recordId: 'ADGM_FREEZONE::22086',
            sourceSpecificId: '22086',
            commercialNameEn: '0727 HOLDING LIMITED',
            commercialNameEnNormalized: '0727 HOLDING Limited', // the legacy legal-form canonicalisation ("LIMITED" -> "Limited"); the README content fingerprint below depends on it
            commercialNameAr: null,
            commercialNameArNormalized: null,
            legalForm: 'Private Company Limited By Shares',
            registrationStatus: 'Registered',
            licenseStatus: 'Licensed',
            tradeNameStatus: 'Active',
            activities: ['Non-Financial (Category B)', 'Special Purpose Vehicle'],
            issueDate: '2024-11-07',
            expiryDate: null,
            cancelDate: null,
            registeredAddress: 'Sub-Unit 1 of the Unit 4, Level 8, Al Sarab Tower, Adgm Square, Al Maryah Island, Abu Dhabi, United Arab Emirates',
            freeZone: true,
        });
    });

    it('reproduces the status and content fingerprints the legacy README documents, byte for byte', () => {
        // Both values are copied from the legacy README's "real record ... generated by running this actor's own pipeline against real data
        // captured live from ADGM's public register". A mismatch would mean the normalisation or the hashing was ported wrongly.
        expect(computeStatusFingerprint(entity)).toBe('1345e799976260d9385e820a0cb3a399782cf8865576b35661ade7386309b891');
        expect(computeContentFingerprint(entity)).toBe('29763666dd29ac3d096f7611a4068fc4102a4b6b75a160f64e552344dc07030b');
    });

    it('the payload is the legacy OutputRecord minus router-owned and delta-derived keys', () => {
        expect(entityPayload(entity)).toEqual({
            '@type': 'schema:Corporation',
            data_source: 'ADGM_FREEZONE',
            free_zone: true,
            commercial_name_en: '0727 HOLDING LIMITED',
            commercial_name_ar: null,
            legal_form: 'Private Company Limited By Shares',
            registration_status: 'Registered',
            license_status: 'Licensed',
            trade_name_status: 'Active',
            activities: ['Non-Financial (Category B)', 'Special Purpose Vehicle'],
            issue_date: '2024-11-07',
            expiry_date: null,
            cancel_date: null,
            registered_address: 'Sub-Unit 1 of the Unit 4, Level 8, Al Sarab Tower, Adgm Square, Al Maryah Island, Abu Dhabi, United Arab Emirates',
            status_fingerprint: '1345e799976260d9385e820a0cb3a399782cf8865576b35661ade7386309b891',
            content_fingerprint: '29763666dd29ac3d096f7611a4068fc4102a4b6b75a160f64e552344dc07030b',
        });
        for (const key of [...ROUTER_OWNED_KEYS, 'event_id', 'event_type', 'previous_registration_status', 'previous_license_status', 'previous_trade_name_status']) {
            expect(Object.keys(entityPayload(entity))).not.toContain(key);
        }
    });
});

describe('row normalisation', () => {
    it('ADGM: requires a registration number and a name; accepts a numeric registration number', () => {
        expect(() => normalizeAdgmEntity({ ...testEntity, Registration_Number__c: null })).toThrow(/Registration_Number__c/);
        expect(() => normalizeAdgmEntity({ ...testEntity, Registration_Number__c: '   ' })).toThrow(/Registration_Number__c/);
        expect(() => normalizeAdgmEntity({ ...testEntity, Name: '' })).toThrow(/\(Name\)/);
        expect(normalizeAdgmEntity({ ...testEntity, Registration_Number__c: 4711 as unknown as string }).recordId).toBe('ADGM_FREEZONE::4711');
    });

    it('ADGM: legacy quirks kept - sub type is listed only with a category; address falls back to Address_for_DDP__c; trade status needs a trade name', () => {
        expect(normalizeAdgmEntity({ ...testEntity, Category__c: null, Entity_Sub_Type__c: 'Special Purpose Vehicle' }).activities).toEqual([]);
        expect(normalizeAdgmEntity({ ...testEntity, Addresses__r: [{ Address_for_DDP__c: 'Fallback Street' }] }).registeredAddress).toBe('Fallback Street');
        expect(normalizeAdgmEntity({ ...testEntity, Trade_Names__r: [] }).tradeNameStatus).toBeNull();
        expect(normalizeAdgmEntity({ ...testEntity, Trade_Names__r: [{ Name_in_English__c: 'X', Status__c: 'Inactive' }] }).tradeNameStatus).toBe('Inactive');
    });

    it('DIFC: id, statuses from ROC_Status__c, legal form fallback, activities split', () => {
        const one = normalizeDifcEntity(oneFoods);
        expect(one).toMatchObject({
            dataSource: 'DIFC_FREEZONE',
            recordId: 'DIFC_FREEZONE::2368',
            commercialNameEn: 'One Foods Holdings Limited',
            legalForm: 'LTD',
            registrationStatus: 'Active',
            licenseStatus: 'Active',
            tradeNameStatus: null,
            activities: ['Holding Company'],
            issueDate: '2017-01-11',
            registeredAddress: 'Innovation Hub, DIFC, Dubai',
            freeZone: true,
        });
        const two = normalizeDifcEntity(managingOffice);
        expect(two.legalForm).toBe('Private Company'); // Legal_Type_of_Entity__c is null: the fallback field
        expect(two.activities).toEqual(['Holding Company', 'Managing Office']);
        expect(two.registrationStatus).toBe('Inactive - Struck Off');
        expect(() => normalizeDifcEntity({ ...oneFoods, Registration_License_No__c: null })).toThrow(/Registration_License_No__c/);
    });

    it('ids of the two registers never collide even when they reuse a number', () => {
        expect(normalizeAdgmEntity({ ...testEntity, Registration_Number__c: '2368' }).recordId).toBe('ADGM_FREEZONE::2368');
        expect(normalizeDifcEntity(oneFoods).recordId).toBe('DIFC_FREEZONE::2368');
    });
});

describe('record building: fingerprint and watch text', () => {
    it('the record fingerprint is stable, and moves with a status change AND with a cosmetic content change', () => {
        const base = adgmRowToRecord(zeroSevenTwoSeven);
        expect(adgmRowToRecord(structuredClone(zeroSevenTwoSeven)).fingerprint).toBe(base.fingerprint);
        const deregistered = adgmRowToRecord({ ...zeroSevenTwoSeven, Entity_Status__c: 'Deregistered' });
        expect(deregistered.fingerprint).not.toBe(base.fingerprint);
        expect(deregistered.payload.status_fingerprint).not.toBe(base.payload.status_fingerprint);
        const moved = adgmRowToRecord({ ...zeroSevenTwoSeven, Addresses__r: [{ Full_Address__c: 'Another Tower, Al Maryah Island' }] });
        expect(moved.fingerprint).not.toBe(base.fingerprint);
        expect(moved.payload.status_fingerprint).toBe(base.payload.status_fingerprint); // a cosmetic edit leaves the status fingerprint alone
        expect(moved.payload.content_fingerprint).not.toBe(base.payload.content_fingerprint);
    });

    it('watch text lists the register name and every English trade name once, case-insensitively', () => {
        expect(adgmRowToRecord(zeroSevenTwoSeven).watchText).toBe('0727 HOLDING LIMITED');
        const withTrade = adgmRowToRecord({ ...zeroSevenTwoSeven, Trade_Names__r: [{ Name_in_English__c: '0727 Holding Limited', Status__c: 'Active' }, { Name_in_English__c: 'Seven Two Seven Capital', Status__c: 'Inactive' }, { Name_in_English__c: '  ' }] });
        expect(withTrade.watchText).toBe('0727 HOLDING LIMITED Seven Two Seven Capital');
        expect(difcRowToRecord(oneFoods).watchText).toBe('One Foods Holdings Limited');
    });

    it('watch text carries both Latin and Arabic names, raw and normalised, so either spelling of a keyword matches', () => {
        const entity = normalizeDifcEntity(oneFoods);
        const arabicRaw = `${String.fromCodePoint(0x645, 0x62d, 0x645, 0x651, 0x62f)} ${String.fromCodePoint(0x623, 0x62d, 0x645, 0x62f)}`;
        const arabicNormalised = normalizeArabicText(arabicRaw)!;
        const text = entityWatchText({ ...entity, commercialNameAr: arabicRaw, commercialNameArNormalized: arabicNormalised });
        expect(text).toBe(`One Foods Holdings Limited ${arabicRaw} ${arabicNormalised}`);
        for (const keyword of ['one foods', arabicRaw, arabicNormalised]) {
            expect(findKeywordMatch(text, sanitizeKeywordList([keyword]))).not.toBeNull();
        }
        // when the normalised form equals the raw form it is listed once
        expect(entityWatchText({ ...entity, commercialNameAr: 'abc', commercialNameArNormalized: 'abc' })).toBe('One Foods Holdings Limited abc');
    });
});

describe('ADGM transport', () => {
    it('reads the real fwuid and app marker out of the real page excerpt', () => {
        expect(extractAuraBootstrap(bootstrapHtml)).toEqual({ fwuid: LIVE_FWUID, appLoadedMarker: LIVE_MARKER });
    });

    it('fails loudly when the page has no bootstrap reference, an undecodable one, or one without fwuid', () => {
        expect(() => extractAuraBootstrap('<html><body>nothing here</body></html>')).toThrow(/Could not locate the Aura bootstrap config/);
        expect(() => extractAuraBootstrap('<script src="/s/sfsites/l/%7Bnot-json%7D/bootstrap.js"></script>')).toThrow(/could not be decoded/);
        const noFwuid = encodeURIComponent(JSON.stringify({ mode: 'PROD', loaded: { 'APPLICATION@markup://siteforce:communityApp': 'm' } }));
        expect(() => extractAuraBootstrap(`<script src="/s/sfsites/l/${noFwuid}/bootstrap.js"></script>`)).toThrow(/missing fwuid\/app-loaded fields/);
    });

    it('builds the Aura context and the anonymous (aura.token=null) RASearchUtil.getSearchResponseForPR request', () => {
        const bootstrap = { fwuid: 'FW', appLoadedMarker: 'MK' };
        expect(JSON.parse(buildAuraContext(bootstrap))).toEqual({ mode: 'PROD', fwuid: 'FW', app: 'siteforce:communityApp', loaded: { 'APPLICATION@markup://siteforce:communityApp': 'MK' }, dn: [], globals: {}, uad: true });

        const form = new URLSearchParams(buildAuraRequestBody(bootstrap, '', 3));
        expect(form.get('aura.token')).toBe('null');
        expect(form.get('aura.pageURI')).toBe('/s/search-results');
        expect(JSON.parse(form.get('aura.context')!).fwuid).toBe('FW');
        const action = JSON.parse(form.get('message')!).actions[0];
        expect(action).toMatchObject({ id: '3;a', descriptor: 'aura://ApexActionController/ACTION$execute', params: { namespace: '', classname: 'RASearchUtil', method: 'getSearchResponseForPR', cacheable: false, isContinuation: false } });
        const search = JSON.parse(action.params.params.jsonSearchString);
        expect(search).toMatchObject({ pageNumber: 3, pageSize: '50', orderByFields: 'Name', defaultOrderBy: 'ASC', resultFieldSet: 'RequestAccessSearchResult', showRegisteredEntities: true });
        expect(search.generalSearch[0].headers[0]).toMatchObject({ fieldAPIName: 'Name', dataType: 'STRING', value: '' });
    });

    it('the captured search template keeps ADGM\'s own metadata and only mutates the name filter, page number and page size', () => {
        const a = JSON.parse(buildJsonSearchString('', 1, 50));
        const b = JSON.parse(buildJsonSearchString('acme', 7, 25));
        expect(b.generalSearch[0].headers[0].value).toBe('acme');
        expect({ ...b, pageNumber: 1, pageSize: '50', generalSearch: a.generalSearch }).toEqual(a);
        expect(Object.keys(a)).toEqual(expect.arrayContaining(['advancedSearch', 'advancedSearch_role', 'advancedsearch_RegisteredLease', 'buttonConfig', 'generalSearch_StrataPlan', 'advancedSearch_reservedname']));
    });

    it('parseAuraSearchResponse returns the rows of a SUCCESS action, including a legitimately empty page', () => {
        expect(parseAuraSearchResponse(adgmPage)).toHaveLength(2);
        expect(parseAuraSearchResponse(auraSuccess([]))).toEqual([]);
    });

    it('parseAuraSearchResponse turns the REAL live ADGM error reply into an error naming the Apex frame', () => {
        expect(() => parseAuraSearchResponse(auraError)).toThrow(/ADGM Aura search action did not succeed/);
        expect(() => parseAuraSearchResponse(auraError)).toThrow(/System\.NullPointerException.*null input to JSON parser.*RASearchUtil\.getSearchResponseForPR: line 2889/s);
    });

    it('parseAuraSearchResponse never reads a structurally broken SUCCESS as an empty register', () => {
        for (const broken of [{ actions: [{ state: 'SUCCESS' }] }, { actions: [{ state: 'SUCCESS', returnValue: { returnValue: { data: { data: 'x' } } } }] }, { actions: [{ state: 'SUCCESS', returnValue: { returnValue: { data: null } } }] }]) {
            expect(() => parseAuraSearchResponse(broken)).toThrow(/did not contain the expected returnValue\.returnValue\.data\.data array/);
        }
        for (const notAura of [null, {}, { actions: [] }, 'oops', 42]) expect(() => parseAuraSearchResponse(notAura)).toThrow(/did not succeed/);
    });

    it('fetchAdgmRows: one bootstrap GET, then sequential form POSTs to ?r=<page>&aura.ApexAction.execute=1 that carry the live fwuid', async () => {
        const rows = Array.from({ length: 57 }, (_, i) => adgmRow(i + 1));
        const stub = makeCtx(uaeServer({ adgm: rows }));
        const fetched = await fetchAdgmRows(stub.ctx, 500);
        expect(fetched).toHaveLength(57);
        expect(stub.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
            `GET ${ADGM_SEARCH_PAGE_URL}`,
            `POST ${ADGM_AURA_ENDPOINT}?r=1&aura.ApexAction.execute=1`,
            `POST ${ADGM_AURA_ENDPOINT}?r=2&aura.ApexAction.execute=1`,
        ]);
        const post = stub.requests[1]!;
        expect(post.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(post.via).toBe('getJson');
        expect(JSON.parse(post.form!.get('aura.context')!).fwuid).toBe(LIVE_FWUID);
        expect(post.headers.cookie).toBeUndefined();
        expect(post.headers.authorization).toBeUndefined();
    });

    it('fetchAdgmRows honours the budget: it stops paging once enough rows are read and trims to the budget', async () => {
        const rows = Array.from({ length: 200 }, (_, i) => adgmRow(i + 1));
        const exact = makeCtx(uaeServer({ adgm: rows }));
        expect(await fetchAdgmRows(exact.ctx, 50)).toHaveLength(50);
        expect(exact.requests.filter((r) => r.method === 'POST')).toHaveLength(1);

        const trimmed = makeCtx(uaeServer({ adgm: rows }));
        const fetched = await fetchAdgmRows(trimmed.ctx, 60);
        expect(fetched).toHaveLength(60);
        expect(fetched[59]!.Registration_Number__c).toBe('60');
        expect(trimmed.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
    });

    it('fetchAdgmRows: an empty first page is an empty register, not an error', async () => {
        const stub = makeCtx(uaeServer({ adgm: [] }));
        expect(await fetchAdgmRows(stub.ctx, 100)).toEqual([]);
    });

    it('fetchAdgmRows: the first page failing is a failure (bootstrap or Aura), a later page failing keeps the earlier rows and logs it', async () => {
        const bootstrapDown = makeCtx(uaeServer({ adgm: [], adgmPage: new HttpStatusError(ADGM_SEARCH_PAGE_URL, 503, 'busy') }));
        await expect(fetchAdgmRows(bootstrapDown.ctx, 100)).rejects.toBeInstanceOf(HttpStatusError);

        const firstAura = makeCtx(uaeServer({ adgm: () => auraError }));
        await expect(fetchAdgmRows(firstAura.ctx, 100)).rejects.toThrow(/NullPointerException/);

        const rows = Array.from({ length: 120 }, (_, i) => adgmRow(i + 1));
        const later = makeCtx(uaeServer({ adgm: (page, request) => (page === 1 ? auraSuccess(rows.slice(0, 50)) : aura500(request)) }));
        const fetched = await fetchAdgmRows(later.ctx, 500);
        expect(fetched).toHaveLength(50);
        expect(later.logs.warning.join('\n')).toMatch(/adgm: page 2 failed after 50 row\(s\); returning what was read.*HTTP 500/);
    });
});

describe('DIFC transport', () => {
    it('sends the captured all-blank body with an offset', () => {
        expect(JSON.parse(buildDifcRequestBody(20))).toEqual({ name: '', licenseType: '', licenseNo: '', status: '', offset: 20, slug: '/CRM/public-register', method: 'POST' });
    });

    it('parseDifcResponse returns Data.companyList, and refuses failures and broken shapes', () => {
        expect(parseDifcResponse(difcPage)).toHaveLength(2);
        expect(parseDifcResponse(difcSuccess([]))).toEqual([]);
        expect(() => parseDifcResponse({ ...difcSuccess([]), IsSuccess: false, Message: 'boom' })).toThrow(/reported failure: boom/);
        expect(() => parseDifcResponse({ IsSuccess: true, Data: null })).toThrow(/did not contain the expected Data\.companyList array/);
        expect(() => parseDifcResponse({ IsSuccess: true, Data: { companyList: 'x' } })).toThrow(/did not contain the expected Data\.companyList array/);
        expect(() => parseDifcResponse(null)).toThrow(/not a JSON object/);
    });

    it('fetchDifcRows pages by offset in tens until a short page', async () => {
        const rows = Array.from({ length: 25 }, (_, i) => difcRow(i + 1));
        const stub = makeCtx(uaeServer({ difc: rows }));
        expect(await fetchDifcRows(stub.ctx, 500)).toHaveLength(25);
        expect(stub.requests.map((r) => r.json.offset)).toEqual([0, 10, 20]);
        expect(stub.requests.every((r) => r.method === 'POST' && r.url === 'https://www.difc.com/api/handleRequest' && r.headers['content-type'] === 'application/json')).toBe(true);
    });

    it('fetchDifcRows honours the budget and trims to it', async () => {
        const rows = Array.from({ length: 100 }, (_, i) => difcRow(i + 1));
        const stub = makeCtx(uaeServer({ difc: rows }));
        const fetched = await fetchDifcRows(stub.ctx, 15);
        expect(fetched).toHaveLength(15);
        expect(stub.requests.map((r) => r.json.offset)).toEqual([0, 10]);
    });

    it('fetchDifcRows: the first page failing is a failure; a later page failing keeps the earlier rows and logs it', async () => {
        const down = makeCtx(uaeServer({ difc: (_o, request) => new HttpStatusError(request.url, 500, 'Internal Server Error') }));
        await expect(fetchDifcRows(down.ctx, 100)).rejects.toThrow(/HTTP 500/);

        const rows = Array.from({ length: 40 }, (_, i) => difcRow(i + 1));
        const later = makeCtx(uaeServer({ difc: (offset, request) => (offset === 0 ? difcSuccess(rows.slice(0, 10)) : new HttpStatusError(request.url, 502, '')) }));
        expect(await fetchDifcRows(later.ctx, 100)).toHaveLength(10);
        expect(later.logs.warning.join('\n')).toMatch(/difc: offset 10 failed after 10 row\(s\); returning what was read/);
    });
});

describe('fetchAeRegisters', () => {
    it('reads both registers into records with the legacy ids and data_source values', async () => {
        const stub = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        const records = await aeRegistersConnector.fetch(stub.ctx, options(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['ADGM_FREEZONE::22086', 'ADGM_FREEZONE::1000', 'DIFC_FREEZONE::2368', 'DIFC_FREEZONE::2403']);
        expect(records.map((r) => r.payload.data_source)).toEqual(['ADGM_FREEZONE', 'ADGM_FREEZONE', 'DIFC_FREEZONE', 'DIFC_FREEZONE']);
        expect(stub.logs.info.join('\n')).toMatch(/adgm: 2 entities.*difc: 2 entities/s);
    });

    it('only ever talks to the two register hosts - Dubai Pulse is never contacted', async () => {
        const stub = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        await aeRegistersConnector.fetch(stub.ctx, options(), RUN);
        const hosts = new Set(stub.requests.map((r) => new URL(r.url).hostname));
        expect(hosts).toEqual(new Set(['newreg.adgm.com', 'www.difc.com']));
    });

    it('subSources selects the registers: difc only makes no ADGM request, adgm only no DIFC request', async () => {
        const difcOnly = makeCtx(uaeServer({ difc: difcFixtureRows }));
        expect(await aeRegistersConnector.fetch(difcOnly.ctx, options(['difc']), RUN)).toHaveLength(2);
        expect(difcOnly.requests.every((r) => r.url === DIFC_HANDLE_REQUEST_URL)).toBe(true);

        const adgmOnly = makeCtx(uaeServer({ adgm: adgmFixtureRows }));
        expect(await aeRegistersConnector.fetch(adgmOnly.ctx, options(['adgm']), RUN)).toHaveLength(2);
        expect(adgmOnly.requests.some((r) => r.url === DIFC_HANDLE_REQUEST_URL)).toBe(false);
    });

    it('splits the budget evenly, so ADGM never starves DIFC', async () => {
        const stub = makeCtx(uaeServer({ adgm: Array.from({ length: 200 }, (_, i) => adgmRow(i + 1)), difc: Array.from({ length: 200 }, (_, i) => difcRow(i + 1)) }));
        const records = await fetchAeRegisters(stub.ctx, options(), { maxItemsPerSource: 6 });
        expect(records.map((r) => r.payload.data_source)).toEqual(['ADGM_FREEZONE', 'ADGM_FREEZONE', 'ADGM_FREEZONE', 'DIFC_FREEZONE', 'DIFC_FREEZONE', 'DIFC_FREEZONE']);
    });

    it('rolls the budget a short register did not use over to the next one', async () => {
        const stub = makeCtx(uaeServer({ adgm: [adgmRow(1), adgmRow(2)], difc: Array.from({ length: 100 }, (_, i) => difcRow(i + 1)) }));
        const records = await fetchAeRegisters(stub.ctx, options(), { maxItemsPerSource: 10 });
        expect(records.filter((r) => r.payload.data_source === 'ADGM_FREEZONE')).toHaveLength(2);
        expect(records.filter((r) => r.payload.data_source === 'DIFC_FREEZONE')).toHaveLength(8);
    });

    it('a budget of 1 over two registers reads the first one only; a budget of 0 reads nothing', async () => {
        const stub = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        expect(await fetchAeRegisters(stub.ctx, options(), { maxItemsPerSource: 1 })).toHaveLength(1);
        expect(stub.requests.some((r) => r.url === DIFC_HANDLE_REQUEST_URL)).toBe(false);
        const none = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        expect(await fetchAeRegisters(none.ctx, options(), { maxItemsPerSource: 0 })).toEqual([]);
        expect(none.requests).toHaveLength(0);
    });

    it('isolates a failing register: ADGM down (the real NPE reply) still delivers DIFC, and the failure is logged', async () => {
        const stub = makeCtx(uaeServer({ adgm: () => auraError, difc: difcFixtureRows }));
        const records = await aeRegistersConnector.fetch(stub.ctx, options(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['DIFC_FREEZONE::2368', 'DIFC_FREEZONE::2403']);
        expect(stub.logs.warning.join('\n')).toMatch(/\[ae_registers\] adgm: ADGM Aura search action did not succeed.*NullPointerException/s);
    });

    it('isolates the other way round: DIFC down (HTTP 500) still delivers ADGM, and DIFC inherits the whole budget', async () => {
        const stub = makeCtx(uaeServer({ adgm: Array.from({ length: 30 }, (_, i) => adgmRow(i + 1)), difc: (_o, request) => aura500(request) }));
        const records = await fetchAeRegisters(stub.ctx, options(['difc', 'adgm']), { maxItemsPerSource: 20 });
        expect(records).toHaveLength(20); // difc failed first, so adgm (second) got floor(20 / 1) = 20
        expect(stub.logs.warning.join('\n')).toMatch(/difc: HTTP 500 for https:\/\/www\.difc\.com\/api\/handleRequest: Internal Server Error/);
    });

    it('fails the source only when EVERY selected register failed, naming each failure (today\'s live situation)', async () => {
        const stub = makeCtx(uaeServer({ adgm: () => auraError, difc: (_o, request) => new HttpStatusError(request.url, 500, 'Internal Server Error') }));
        const error = await aeRegistersConnector.fetch(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as SourceFetchError,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expect(error!.source).toBe('ae_registers');
        expect(error!.message).toMatch(/every selected UAE register sub-source failed - adgm: .*NullPointerException.* \| difc: HTTP 500 .*Internal Server Error/s);
    });

    it('two empty registers are an empty result, not an error', async () => {
        const stub = makeCtx(uaeServer({ adgm: [], difc: [] }));
        expect(await aeRegistersConnector.fetch(stub.ctx, options(), RUN)).toEqual([]);
        expect(stub.logs.warning).toEqual([]);
    });

    it('skips rows that cannot be normalised (no identity is ever fabricated) and reports them once', async () => {
        const bad: AdgmEntityRow[] = [adgmRow(1), { ...adgmRow(2), Registration_Number__c: null }, adgmRow(3, { Name: null }), null as unknown as AdgmEntityRow, adgmRow(4)];
        const stub = makeCtx(uaeServer({ adgm: bad }));
        const records = await aeRegistersConnector.fetch(stub.ctx, options(['adgm']), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['ADGM_FREEZONE::1', 'ADGM_FREEZONE::4']);
        expect(stub.logs.warning).toHaveLength(1);
        expect(stub.logs.warning[0]).toMatch(/adgm: skipped 3 row\(s\) that could not be normalised \(first: Row is missing a required field \(Registration_Number__c\)/);
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [aeRegistersConnector] };
    const resolve = (sourceOptions: Record<string, unknown> | undefined) =>
        resolveSources(engine, EngineInputSchema.parse({ sources: ['ae_registers'], sourceOptions: sourceOptions === undefined ? {} : { ae_registers: sourceOptions } }));

    it('is an active, anonymous connector of the patent engine with room for both registers in delta memory', () => {
        expect(aeRegistersConnector.id).toBe('ae_registers');
        expect(aeRegistersConnector.engine).toBe('global-corporate-patent-intelligence');
        expect(aeRegistersConnector.legacyActor).toBe('uae-corporate-registry-monitor');
        expect(aeRegistersConnector.status).toBe('active');
        expect(aeRegistersConnector.requiredOptions ?? []).toEqual([]);
        expect(aeRegistersConnector.maxSeenIds).toBe(AE_MAX_SEEN_IDS);
        expect(AE_ACTIVE_SUB_SOURCES).toEqual(['adgm', 'difc']);
    });

    it('defaults to both active registers with no options at all', () => {
        expect(resolve(undefined)[0]!.options).toEqual({ subSources: ['adgm', 'difc'] });
        expect(resolve({})[0]!.options).toEqual({ subSources: ['adgm', 'difc'] });
    });

    it('normalises sub-source names: case, surrounding space, duplicates; keeps the requested order', () => {
        expect(aeRegistersOptionsSchema.parse({ subSources: [' DIFC ', 'Adgm', 'difc'] }).subSources).toEqual(['difc', 'adgm']);
    });

    it('refuses the held dubai_pulse sub-source at preflight with its reason, alone or mixed', () => {
        expect(() => resolve({ subSources: ['dubai_pulse'] })).toThrow(FatalConfigError);
        expect(() => resolve({ subSources: ['dubai_pulse'] })).toThrow(/sub-source "dubai_pulse" is held: .*never verified its wire protocol against live traffic/);
        expect(() => resolve({ subSources: ['adgm', 'Dubai_Pulse'] })).toThrow(/dubai_pulse" is held/);
    });

    it('rejects unknown sub-sources (including the legacy DUBAI_MAINLAND / ADGM_FREEZONE ids), an empty list and a non-list', () => {
        expect(() => resolve({ subSources: ['sharjah'] })).toThrow(/unknown sub-source "sharjah"; available: adgm, difc/);
        expect(() => resolve({ subSources: ['DUBAI_MAINLAND'] })).toThrow(/unknown sub-source "DUBAI_MAINLAND"/);
        expect(() => resolve({ subSources: ['ADGM_FREEZONE'] })).toThrow(/unknown sub-source/);
        expect(() => resolve({ subSources: [] })).toThrow(/Select at least one sub-source/);
        expect(() => resolve({ subSources: 'adgm' })).toThrow(/subSources/);
        expect(() => resolve({ subSources: [7] })).toThrow(/subSources/);
    });

    it('rejects unknown keys, so a copied-over legacy dubaiPulseApiKey / dataSources fails loudly instead of being ignored', () => {
        expect(() => resolve({ dubaiPulseApiKey: 'k-12345678' })).toThrow(/Invalid options for "ae_registers"/);
        expect(() => resolve({ dataSources: ['ADGM_FREEZONE'] })).toThrow(/Invalid options for "ae_registers"/);
    });
});

describe('end to end through the real router', () => {
    const input = (extra: Record<string, unknown> = {}) => ({ sources: ['ae_registers'], deltaMode: 'onlyChanged', ...extra });

    it('first run emits both registers as first_seen with the router envelope and the legacy field names', async () => {
        const result = await runThroughRouter(aeRegistersConnector, input(), makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows })));
        expect(result.rows).toHaveLength(4);
        const row = result.rows.find((r) => r.record_id === 'ADGM_FREEZONE::22086')!;
        expect(row).toMatchObject({
            engine: 'global-corporate-patent-intelligence',
            source: 'ae_registers',
            delta_status: 'first_seen',
            is_new: true,
            '@type': 'schema:Corporation',
            data_source: 'ADGM_FREEZONE',
            free_zone: true,
            commercial_name_en: '0727 HOLDING LIMITED',
            registration_status: 'Registered',
            license_status: 'Licensed',
            trade_name_status: 'Active',
            status_fingerprint: '1345e799976260d9385e820a0cb3a399782cf8865576b35661ade7386309b891',
        });
        expect(result.billing.totalFor(RESULT_EVENT)).toBe(4);
    });

    it('delta memory: unchanged emits nothing; a status change and a cosmetic edit each re-emit as updated, distinguishable by status_fingerprint', async () => {
        const store = new InMemoryDeltaStore();
        const serve = (adgm: AdgmEntityRow[], difc: DifcCompanyRow[]) => makeCtx(uaeServer({ adgm, difc }));
        await runThroughRouter(aeRegistersConnector, input(), serve(adgmFixtureRows, difcFixtureRows), store);

        const second = await runThroughRouter(aeRegistersConnector, input(), serve(adgmFixtureRows, difcFixtureRows), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 4, unchanged: 4 });

        const statusChanged = [{ ...zeroSevenTwoSeven, Entity_Status__c: 'Deregistered', License_Status__c: 'License cancelled' }, testEntity];
        const third = await runThroughRouter(aeRegistersConnector, input(), serve(statusChanged, difcFixtureRows), store);
        expect(third.rows).toHaveLength(1);
        expect(third.rows[0]).toMatchObject({ record_id: 'ADGM_FREEZONE::22086', delta_status: 'updated', registration_status: 'Deregistered', license_status: 'License cancelled' });
        const statusFingerprintAfterChange = third.rows[0]!.status_fingerprint;
        expect(statusFingerprintAfterChange).not.toBe('1345e799976260d9385e820a0cb3a399782cf8865576b35661ade7386309b891');

        const cosmetic = [{ ...statusChanged[0]!, Addresses__r: [{ Full_Address__c: 'New Tower, Al Maryah Island' }] }, testEntity];
        const fourth = await runThroughRouter(aeRegistersConnector, input(), serve(cosmetic, difcFixtureRows), store);
        expect(fourth.rows).toHaveLength(1);
        expect(fourth.rows[0]).toMatchObject({ delta_status: 'updated', registered_address: 'New Tower, Al Maryah Island', status_fingerprint: statusFingerprintAfterChange });
    });

    it('delta memory keeps more than the default 5,000 ids: a 6,000-entity register is fully "unchanged" on the second run', async () => {
        const rows = Array.from({ length: 6000 }, (_, i) => adgmRow(i + 1));
        const store = new InMemoryDeltaStore();
        const run = () => runThroughRouter(aeRegistersConnector, input({ sources: ['ae_registers'], sourceOptions: { ae_registers: { subSources: ['adgm'] } }, maxItemsPerSource: 6000 }), makeCtx(uaeServer({ adgm: rows })), store);
        expect((await run()).rows).toHaveLength(6000);
        const second = await run();
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 6000, unchanged: 6000, firstSeen: 0 });
    }, 30_000);

    it('the watchlist matches register names and trade names, and bills one watchlist-hit per matched row', async () => {
        const result = await runThroughRouter(aeRegistersConnector, input({ watchlistNames: ['holding', 'managing office'] }), makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows })));
        const matched = result.rows.filter((r) => r.is_watchlist_match);
        expect(matched.map((r) => [r.record_id, r.matched_watchlist_keyword])).toEqual([
            ['ADGM_FREEZONE::22086', 'holding'],
            ['DIFC_FREEZONE::2368', 'holding'],
            ['DIFC_FREEZONE::2403', 'managing office'], // "Example Managing Office Limited"
        ]);
        expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(3);

        const withTrade = [{ ...zeroSevenTwoSeven, Trade_Names__r: [{ Name_in_English__c: 'Seven Two Seven Capital', Status__c: 'Active' }] }, testEntity];
        const byTrade = await runThroughRouter(aeRegistersConnector, input({ watchlistNames: ['seven two seven'] }), makeCtx(uaeServer({ adgm: withTrade, difc: difcFixtureRows })));
        expect(byTrade.rows.filter((r) => r.is_watchlist_match).map((r) => r.record_id)).toEqual(['ADGM_FREEZONE::22086']);
    });

    it('ghost-billing guard: empty, blank and one-letter watchlists match nothing and bill nothing', async () => {
        for (const watchlistNames of [[''], [' '], ['a'], '', [], undefined, null, 3]) {
            const result = await runThroughRouter(aeRegistersConnector, input({ watchlistNames }), makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows })));
            expect(result.rows).toHaveLength(4);
            expect(result.rows.some((r) => r.is_watchlist_match)).toBe(false);
            expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('today\'s outage end to end: the run completes, nothing is emitted or billed, and the summary carries the source error', async () => {
        const stub = makeCtx(uaeServer({ adgm: () => auraError, difc: (_o, request) => new HttpStatusError(request.url, 500, 'Internal Server Error') }));
        const result = await runThroughRouter(aeRegistersConnector, input(), stub);
        expect(result.rows).toHaveLength(0);
        expect(result.billing.calls).toEqual([]);
        expect(result.summary.sources[0]!.error).toMatch(/every selected UAE register sub-source failed/);
        expect(result.store.peek().sources['ae_registers']?.seenIds ?? []).toEqual([]);
    });

    it('selecting the held dubai_pulse aborts the run in preflight: no request is made', async () => {
        const stub = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        await expect(runThroughRouter(aeRegistersConnector, { sources: ['ae_registers'], sourceOptions: { ae_registers: { subSources: ['adgm', 'dubai_pulse'] } } }, stub)).rejects.toThrow(/dubai_pulse" is held/);
        expect(stub.requests).toHaveLength(0);
    });

    it('the payload never sets a router-owned key', async () => {
        const stub = makeCtx(uaeServer({ adgm: adgmFixtureRows, difc: difcFixtureRows }));
        const records = await aeRegistersConnector.fetch(stub.ctx, options(), RUN);
        for (const record of records) for (const key of ROUTER_OWNED_KEYS) expect(Object.keys(record.payload)).not.toContain(key);
    });
});
