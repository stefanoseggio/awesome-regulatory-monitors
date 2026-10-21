/**
 * eu_ted connector tests.
 *
 * Fixture (test/fixtures/tenders-b/ted_search_live_2026-10-21_excerpt.json, no network): an EXCERPT OF A REAL LIVE
 * RESPONSE captured in this port session on 2026-10-21 with
 *   POST https://api.ted.europa.eu/v3/notices/search  {"query":"publication-date >= today(-3) AND classification-cpv = 72*",
 *   "fields":[...21 ids...],"page":1,"limit":60,"scope":"ALL","paginationMode":"PAGE_NUMBER","onlyLatestVersions":false}
 * trimmed to 4 of the 60 notices (a single-lot award, a multi-lot award, a contract notice, a notice with no value) with
 * `links` cut to the ENG html/htmlDirect entries and `notice-title` cut to its English entry. Every value is verbatim.
 * (The legacy actor's tests build their notices inline; it ships no JSON fixture, so there was nothing to copy.)
 * Anything built inline below is SYNTHETIC and labelled where used.
 */
import { describe, expect, it } from 'vitest';

import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import {
    buildSearchRequest,
    canonicalize,
    computeContentFingerprint,
    computeStatusFingerprint,
    DEFAULT_EXPERT_QUERY,
    DEFAULT_FIELDS,
    describeTedFailure,
    euTedConnector,
    euTedOptionsSchema,
    extractErrorMessage,
    extractSourceUrl,
    firstString,
    normalizeNotice,
    type RawNotice,
    resolveFields,
    stringArray,
    TED_MAX_PAGES_PER_RUN,
    TED_SEARCH_URL,
    toPayload,
    toSourceRecord,
    watchTextOf,
} from '../latam-global-tender-intelligence/connectors/euTed.js';
import { jsonFixture, LEGACY_DELTA_KEYS, makeCtx, ROUTER_OWNED_KEYS, type Responder, runThroughRouter } from './tenders-b.helpers.js';

interface Envelope {
    notices: RawNotice[];
    totalNoticeCount: number;
    timedOut: boolean;
}
const live = jsonFixture<Envelope>('ted_search_live_2026-10-21_excerpt.json');
const [awardPl, awardPt, cnBg, cnNl] = live.notices as [RawNotice, RawNotice, RawNotice, RawNotice];

const RUN: RunParams = { maxItemsPerSource: 100 };
/** TED's real 400 body shape: a summary plus a field-level detail array (legacy tedClient.test.ts). */
const body400 = JSON.stringify({ message: 'Validation error', error: [{ objectName: 'searchRequest', field: 'query', message: 'Unexpected token near AND AND' }] });
const defaults = () => euTedOptionsSchema.parse({});

/** Serves `envelope` for every POST to the TED search URL. */
function serve(envelope: unknown): Responder {
    return (request) => (request.method === 'POST' && request.url === TED_SEARCH_URL ? envelope : new Error(`unexpected request ${request.method} ${request.url}`));
}

/** SYNTHETIC: `count` minimal notices numbered from `from`, ids `n-<index>`. */
function syntheticNotices(from: number, count: number): RawNotice[] {
    return Array.from({ length: count }, (_, i) => ({ 'notice-identifier': `n-${from + i}`, 'notice-title': { eng: `Title ${from + i}` }, 'buyer-name': { eng: ['Buyer'] } }));
}

/** SYNTHETIC paging server over `total` notices; honours `page` / `limit` from the POST body. */
function pagedServer(total: number, extra: { timedOut?: boolean } = {}): Responder {
    return (request) => {
        const body = request.body as { page: number; limit: number };
        const from = (body.page - 1) * body.limit;
        const count = Math.max(0, Math.min(body.limit, total - from));
        return { notices: syntheticNotices(from, count), totalNoticeCount: total, timedOut: extra.timedOut ?? false };
    };
}

describe('field accessors (legacy firstString / stringArray)', () => {
    it('reads a plain string, the first element of a string[] and null for empty values', () => {
        expect(firstString('open')).toBe('open');
        expect(firstString(['a', 'b'])).toBe('a');
        expect(firstString('')).toBeNull();
        expect(firstString([])).toBeNull();
        expect(firstString(undefined)).toBeNull();
        expect(firstString(null)).toBeNull();
        expect(firstString(42)).toBeNull();
    });

    it('handles BOTH real i18n shapes and prefers English (regression: the "F" incident)', () => {
        // {lang: string} - the notice-title shape confirmed live: must return the whole title, never its first character.
        expect(firstString({ hun: 'Teljes cim', lav: 'Pilns nosaukums' })).toBe('Teljes cim');
        expect(firstString({ eng: 'Full title', pol: 'Pelny tytul' })).toBe('Full title');
        // {lang: string[]} - the buyer-name shape confirmed live.
        expect(firstString({ pol: ['Miejskie Przedsiebiorstwo'] })).toBe('Miejskie Przedsiebiorstwo');
        expect(firstString({ pol: ['x'], eng: ['English name'] })).toBe('English name');
        expect(firstString({ pol: [] })).toBeNull();
        expect(firstString({})).toBeNull();
        expect(firstString({ eng: { nested: 'object' } })).toBeNull();
    });

    it('stringArray flattens strings, wraps a scalar and drops non-strings', () => {
        expect(stringArray(['a', 'b'])).toEqual(['a', 'b']);
        expect(stringArray('a')).toEqual(['a']);
        expect(stringArray(undefined)).toEqual([]);
        expect(stringArray({ eng: ['a', 'b'], fra: ['c'] })).toEqual(['a', 'b', 'c']);
        expect(stringArray([1, 'x', null] as unknown[])).toEqual(['x']);
    });

    it('extractSourceUrl prefers htmlDirect.ENG, falls back to html, then to the TED website root', () => {
        expect(extractSourceUrl({ htmlDirect: { ENG: 'https://ted.europa.eu/en/notice/1-2026/html', FRA: 'x' }, html: { ENG: 'y' } })).toBe('https://ted.europa.eu/en/notice/1-2026/html');
        expect(extractSourceUrl({ html: { FRA: 'https://ted.europa.eu/fr/notice/-/detail/1-2026' } })).toBe('https://ted.europa.eu/fr/notice/-/detail/1-2026');
        expect(extractSourceUrl(undefined)).toBe('https://ted.europa.eu');
        expect(extractSourceUrl({ htmlDirect: {} })).toBe('https://ted.europa.eu');
    });
});

describe('normalizeNotice (real live notices)', () => {
    it('single-lot award: buyer from the i18n map, deduplicated sorted CPV codes, notice-level award value and winner', () => {
        const n = normalizeNotice(awardPl);
        expect(n.noticeIdentifier).toBe('52d740c8-2435-4714-acc3-6bca47d46400');
        expect(n.publicationNumber).toBe('718666-2026');
        expect(n.publicationDate).toBe('2026-10-19+02:00');
        expect(n.noticeTitle).toBe(
            'Poland – Maintenance and repair of ticket-issuing machinery – Świadczenie usługi serwisowej i eksploatacyjnej mobilnych automatów biletowych EMtest oraz utrzymanie platformy programowo - sprzętowej wraz z transmisją danych',
        );
        expect(n.noticeType).toBe('can-standard');
        expect(n.legalBasis).toEqual(['32014L0025']);
        expect(n.buyerName).toBe('Miejskie Przedsiębiorstwo Komunikacyjne – Łódź Spółka z ograniczoną odpowiedzialnością');
        expect(n.buyerCountry).toBe('POL');
        expect(n.cpvCodes).toEqual(['50316000', '50324100', '72267000', '72318000']);
        expect(n.procedureType).toBe('open');
        expect(n.estimatedValue).toBeNull();
        expect(n.awardedValue).toBe(3012300);
        expect(n.awardedValueCurrency).toBe('PLN');
        expect(n.winnerIdentifier).toBe('5270023255');
        expect(n.winnerCountry).toBe('POL');
        expect(n.winnerSize).toBe('large');
        expect(n.sourceUrl).toBe('https://ted.europa.eu/en/notice/718666-2026/html');
    });

    it('multi-lot award: scalars show the first lot, the full per-lot arrays are kept for change detection', () => {
        const n = normalizeNotice(awardPt);
        expect(n.estimatedValue).toBe(77952);
        // The live currency list is SHORTER than the value list (["EUR"] for two lots): only the first pair is meaningful.
        expect(n.estimatedValueCurrency).toBe('EUR');
        expect(n.rawLotValues).toEqual({ estimatedValues: ['77952', '97440'], estimatedValueCurrencies: ['EUR'], submissionDeadlines: [] });
        expect(n.awardedValue).toBe(116436.16);
        expect(n.winnerIdentifier).toBe('504243926');
        expect(n.winnerSize).toBe('medium');
        expect(n.buyerName).toBe('Estrutura de Missão «Recuperar Portugal»');
    });

    it('contract notice: deadline and estimated value, non-Latin buyer name preserved', () => {
        const n = normalizeNotice(cnBg);
        expect(n.noticeType).toBe('cn-standard');
        expect(n.submissionDeadline).toBe('2026-11-20+02:00');
        expect(n.estimatedValue).toBe(298270);
        expect(n.buyerName).toBe('ИНФОРМАЦИОННО ОБСЛУЖВАНЕ АД');
        expect(n.cpvCodes).toEqual(['48000000', '48730000', '72260000', '72261000']);
        expect(n.awardedValue).toBeNull();
        expect(n.winnerIdentifier).toBeNull();
    });

    it('a notice with no value fields yields nulls, not zeros or NaN', () => {
        const n = normalizeNotice(cnNl);
        expect(n.estimatedValue).toBeNull();
        expect(n.estimatedValueCurrency).toBeNull();
        expect(n.awardedValue).toBeNull();
        expect(n.buyerName).toBe('Raad van State');
        expect(n.cpvCodes).toEqual(['48000000', '48311000', '72263000', '72267000', '72268000']);
    });

    it('falls back from buyer-name to organisation-name-buyer, and prefers result-value-lot over the notice aggregate (SYNTHETIC)', () => {
        const n = normalizeNotice({
            'notice-identifier': 'x-1',
            'organisation-name-buyer': { fra: ['Mairie de Test'] },
            'result-value-lot': ['100.50'],
            'result-value-notice': '999',
        });
        expect(n.buyerName).toBe('Mairie de Test');
        expect(n.awardedValue).toBe(100.5);
    });

    it('a whitespace-only or non-numeric value is null, never 0 (SYNTHETIC)', () => {
        expect(normalizeNotice({ 'notice-identifier': 'x', 'estimated-value-lot': [' '] }).estimatedValue).toBeNull();
        expect(normalizeNotice({ 'notice-identifier': 'x', 'estimated-value-lot': ['n/a'] }).estimatedValue).toBeNull();
    });

    it('throws when notice-identifier is absent (cannot track the record)', () => {
        expect(() => normalizeNotice({ 'publication-number': '1-2026' })).toThrow(/notice-identifier/);
    });
});

describe('recordId, fingerprint and payload', () => {
    it('recordId is the notice-identifier and is stable across calls', () => {
        const a = toSourceRecord(awardPl);
        const b = toSourceRecord(structuredClone(awardPl));
        expect(a.recordId).toBe('52d740c8-2435-4714-acc3-6bca47d46400');
        expect(b.recordId).toBe(a.recordId);
        expect(b.fingerprint).toBe(a.fingerprint);
    });

    it('fingerprint changes for each consumer-visible change: deadline, award value, winner, title, procedure', () => {
        const base = toSourceRecord(cnBg).fingerprint;
        const changed = (patch: RawNotice) => toSourceRecord({ ...structuredClone(cnBg), ...patch }).fingerprint;
        expect(changed({ 'deadline-receipt-tender-date-lot': ['2026-11-27+01:00'] })).not.toBe(base);
        expect(changed({ 'result-value-notice': '123' })).not.toBe(base);
        expect(changed({ 'winner-identifier': ['BG123456789'] })).not.toBe(base);
        expect(changed({ 'notice-title': { eng: 'A corrected title' } })).not.toBe(base);
        expect(changed({ 'procedure-type': 'restricted' })).not.toBe(base);
    });

    it('fingerprint sees a change to a NON-first lot even though the scalar value does not change', () => {
        const before = toSourceRecord(awardPt);
        const edited = structuredClone(awardPt);
        edited['estimated-value-lot'] = ['77952', '97441'];
        const after = toSourceRecord(edited);
        expect(after.payload.estimated_value).toBe(before.payload.estimated_value);
        expect(after.fingerprint).not.toBe(before.fingerprint);
    });

    it('fingerprint ignores link-language ordering / link changes (legacy: sourceUrl is not content) and CPV repetition order', () => {
        const base = toSourceRecord(awardPl).fingerprint;
        const relinked = { ...structuredClone(awardPl), links: { html: { FRA: 'https://ted.europa.eu/fr/notice/-/detail/718666-2026' } } };
        expect(toSourceRecord(relinked).fingerprint).toBe(base);
        const reordered = { ...structuredClone(awardPl), 'classification-cpv': ['72318000', '72267000', '50324100', '50316000', '72318000'] };
        expect(toSourceRecord(reordered).fingerprint).toBe(base);
    });

    it('payload keeps the legacy OutputRecord names and carries no router-owned or delta-engine keys', () => {
        const { payload } = toSourceRecord(awardPl);
        expect(payload['@type']).toBe('schema:GovernmentPermit');
        for (const key of [
            'notice_identifier',
            'publication_number',
            'publication_date',
            'notice_title',
            'buyer_name',
            'buyer_country',
            'cpv_codes',
            'submission_deadline',
            'procedure_type',
            'estimated_value',
            'estimated_value_currency',
            'awarded_value',
            'awarded_value_currency',
            'winner_identifier',
            'winner_country',
            'winner_size',
            'status_fingerprint',
            'content_fingerprint',
            'source_url',
        ]) {
            expect(payload, key).toHaveProperty(key);
        }
        for (const key of [...ROUTER_OWNED_KEYS, ...LEGACY_DELTA_KEYS]) expect(payload, key).not.toHaveProperty(key);
        expect(payload.status_fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(payload.content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('status fingerprint tracks only procedure/deadline/award/winner; content fingerprint tracks everything but id and link', () => {
        const a = normalizeNotice(cnBg);
        const retitled = normalizeNotice({ ...structuredClone(cnBg), 'notice-title': { eng: 'Different title' } });
        expect(computeStatusFingerprint(retitled)).toBe(computeStatusFingerprint(a));
        expect(computeContentFingerprint(retitled)).not.toBe(computeContentFingerprint(a));
        const redeadlined = normalizeNotice({ ...structuredClone(cnBg), 'deadline-receipt-tender-date-lot': ['2027-01-01+01:00'] });
        expect(computeStatusFingerprint(redeadlined)).not.toBe(computeStatusFingerprint(a));
    });

    it('canonicalize sorts keys at every depth and leaves array order alone', () => {
        expect(JSON.stringify(canonicalize({ b: 1, a: { d: [3, 1, 2], c: 0 } }))).toBe('{"a":{"c":0,"d":[3,1,2]},"b":1}');
    });

    it('watchText is the buyer name plus the title', () => {
        expect(watchTextOf(normalizeNotice(cnNl))).toBe(
            "Raad van State Netherlands – Document management software package – Europese openbare aanbesteding 'Levering, implementatie, beheer en onderhoud van een Record Management Applicatie (RMA)'",
        );
        expect(watchTextOf(normalizeNotice({ 'notice-identifier': 'x' }))).toBe('');
    });

    it('toPayload exposes notice_type / legal_basis (null / [] unless selected in `fields`)', () => {
        expect(toPayload(normalizeNotice({ 'notice-identifier': 'x' }))).toMatchObject({ notice_type: null, legal_basis: [] });
    });
});

describe('options validation', () => {
    it('applies the legacy defaults', () => {
        expect(defaults()).toEqual({ expertQuery: DEFAULT_EXPERT_QUERY, scope: 'ALL', onlyLatestVersions: false, limit: 50 });
        expect(DEFAULT_EXPERT_QUERY).toBe('publication-date >= today(-14) AND classification-cpv = 72*');
    });

    it('needs no credential: TED search is anonymous (no requiredOptions, preflight passes with empty options)', () => {
        expect(euTedConnector.requiredOptions).toBeUndefined();
        const input = EngineInputSchema.parse({ sources: ['eu_ted'] });
        const [resolved] = resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [euTedConnector] }, input);
        expect(resolved?.connector.id).toBe('eu_ted');
    });

    it('trims the query and rejects an empty or oversized one, an out-of-range limit, an unknown scope and an unknown field id', () => {
        expect(euTedOptionsSchema.parse({ expertQuery: '  classification-cpv = 72*  ' }).expertQuery).toBe('classification-cpv = 72*');
        expect(euTedOptionsSchema.safeParse({ expertQuery: '   ' }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ expertQuery: 'x'.repeat(5001) }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ limit: 251 }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ scope: 'EVERYTHING' }).success).toBe(false);
        expect(euTedOptionsSchema.safeParse({ fields: ['not-a-field'] }).success).toBe(false);
    });

    it('rejects a copied-over legacy operation option (the schema is strict) instead of silently ignoring it', () => {
        for (const key of ['operationMode', 'onlyNew', 'maxItems', 'deltaStateName', 'webhookUrl', 'resetState']) {
            expect(euTedOptionsSchema.safeParse({ [key]: 'x' }).success, key).toBe(false);
        }
    });

    it('rejects bad options in router preflight, before any network call', () => {
        const input = EngineInputSchema.parse({ sources: ['eu_ted'], sourceOptions: { eu_ted: { limit: 999 } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [euTedConnector] }, input)).toThrow(FatalConfigError);
    });
});

describe('request building', () => {
    it('resolveFields: empty/absent selection -> legacy defaults; notice-identifier is always present exactly once', () => {
        expect(resolveFields(undefined)).toEqual([...DEFAULT_FIELDS]);
        expect(resolveFields([])).toEqual([...DEFAULT_FIELDS]);
        expect(resolveFields(['notice-title'])).toEqual(['notice-title', 'notice-identifier']);
        expect(resolveFields(['notice-identifier', 'notice-title', 'notice-identifier'])).toEqual(['notice-identifier', 'notice-title']);
        expect(DEFAULT_FIELDS).toHaveLength(19);
    });

    it('buildSearchRequest sends exactly the live-verified body keys in PAGE_NUMBER mode', () => {
        const req = buildSearchRequest(defaults(), ['notice-identifier'], 3, 25);
        expect(req).toEqual({
            query: DEFAULT_EXPERT_QUERY,
            fields: ['notice-identifier'],
            page: 3,
            limit: 25,
            scope: 'ALL',
            paginationMode: 'PAGE_NUMBER',
            onlyLatestVersions: false,
        });
    });
});

describe('fetch (stubbed http)', () => {
    it('returns every notice of a single-page result and POSTs the right request', async () => {
        const stub = makeCtx(serve(live));
        const records = await euTedConnector.fetch(stub.ctx, defaults(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(live.notices.map((n) => n['notice-identifier']));
        expect(stub.requests).toHaveLength(1);
        const [request] = stub.requests;
        expect(request?.method).toBe('POST');
        expect(request?.url).toBe(TED_SEARCH_URL);
        expect(request?.via).toBe('getJson');
        expect(request?.headers['content-type']).toBe('application/json');
        expect(request?.headers).not.toHaveProperty('user-agent'); // honest identification is lib/http.ts's job; no browser UA is set here
        expect(request?.body).toMatchObject({
            query: DEFAULT_EXPERT_QUERY,
            page: 1,
            limit: 50,
            scope: 'ALL',
            paginationMode: 'PAGE_NUMBER',
            onlyLatestVersions: false,
        });
        const sentFields = (request?.body as { fields: string[] }).fields;
        expect(sentFields).toContain('notice-identifier');
        expect(sentFields).toContain('links');
        expect(sentFields).not.toContain('notice-type'); // legacy default selection
    });

    it('passes a custom query, scope, field selection and onlyLatestVersions through unchanged', async () => {
        const stub = makeCtx(serve(live));
        const options = euTedOptionsSchema.parse({ expertQuery: 'buyer-country = DEU', scope: 'ACTIVE', onlyLatestVersions: true, fields: ['notice-title', 'notice-type'] });
        await euTedConnector.fetch(stub.ctx, options, RUN);
        expect(stub.requests[0]?.body).toMatchObject({ query: 'buyer-country = DEU', scope: 'ACTIVE', onlyLatestVersions: true, fields: ['notice-title', 'notice-type', 'notice-identifier'] });
    });

    it('pages until the result set is exhausted, collapsing a notice returned on two pages (SYNTHETIC paging server)', async () => {
        const server = pagedServer(120);
        // Page 2 repeats the last notice of page 1, as TED documents can happen in PAGE_NUMBER mode if an OJ S release lands mid-walk.
        const responder: Responder = (request) => {
            const response = server(request) as { notices: RawNotice[] };
            if ((request.body as { page: number }).page === 2) response.notices[0] = { 'notice-identifier': 'n-49', 'notice-title': { eng: 'Title 49' } };
            return response;
        };
        const stub = makeCtx(responder);
        const records = await euTedConnector.fetch(stub.ctx, euTedOptionsSchema.parse({ limit: 50 }), { maxItemsPerSource: 1000 });
        expect(stub.requests.map((r) => (r.body as { page: number }).page)).toEqual([1, 2, 3]);
        const ids = records.map((r) => r.recordId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(119); // 120 rows served, one duplicate collapsed
        expect(ids[0]).toBe('n-0');
        expect(ids.at(-1)).toBe('n-119');
    });

    it('stops paging once maxItemsPerSource is reached and never asks TED for more than it can keep', async () => {
        const stub = makeCtx(pagedServer(500));
        const records = await euTedConnector.fetch(stub.ctx, euTedOptionsSchema.parse({ limit: 50 }), { maxItemsPerSource: 7 });
        expect(records).toHaveLength(7);
        expect(stub.requests).toHaveLength(1);
        expect((stub.requests[0]?.body as { limit: number }).limit).toBe(7);
    });

    it('stops mid-page when maxItemsPerSource falls inside a page', async () => {
        const stub = makeCtx(pagedServer(500));
        const records = await euTedConnector.fetch(stub.ctx, euTedOptionsSchema.parse({ limit: 10 }), { maxItemsPerSource: 25 });
        expect(records).toHaveLength(25);
        expect(stub.requests).toHaveLength(3);
    });

    it('treats a short page as the end unless TED reports timedOut, in which case it keeps going (legacy reasoning)', async () => {
        const shortPageServer = (timedOut: boolean): Responder => (request) => {
            const page = (request.body as { page: number }).page;
            return { notices: syntheticNotices(page === 1 ? 0 : 3, 3), totalNoticeCount: 6, timedOut };
        };
        const ended = makeCtx(shortPageServer(false));
        expect(await euTedConnector.fetch(ended.ctx, euTedOptionsSchema.parse({ limit: 5 }), RUN)).toHaveLength(3);
        expect(ended.requests).toHaveLength(1);

        const continued = makeCtx(shortPageServer(true));
        expect(await euTedConnector.fetch(continued.ctx, euTedOptionsSchema.parse({ limit: 5 }), RUN)).toHaveLength(6);
        expect(continued.requests).toHaveLength(2);
        expect(continued.logs.warning.some((m) => /timedOut=true/.test(m))).toBe(true);
    });

    it('an empty first page returns no records and one request', async () => {
        const stub = makeCtx(serve({ notices: [], totalNoticeCount: 0 }));
        expect(await euTedConnector.fetch(stub.ctx, defaults(), RUN)).toEqual([]);
        expect(stub.requests).toHaveLength(1);
    });

    it('skips (and logs) a notice that has no notice-identifier but keeps the rest', async () => {
        const stub = makeCtx(serve({ notices: [{ 'publication-number': 'orphan' }, ...live.notices], totalNoticeCount: 5 }));
        const records = await euTedConnector.fetch(stub.ctx, defaults(), RUN);
        expect(records).toHaveLength(4);
        expect(stub.logs.warning.some((m) => /notice-identifier/.test(m))).toBe(true);
    });

    it('caps a runaway walk (tiny `limit`, huge maxItemsPerSource) at TED_MAX_PAGES_PER_RUN requests', async () => {
        const stub = makeCtx(pagedServer(10_000));
        const records = await euTedConnector.fetch(stub.ctx, euTedOptionsSchema.parse({ limit: 1 }), { maxItemsPerSource: 10_000 });
        expect(stub.requests).toHaveLength(TED_MAX_PAGES_PER_RUN);
        expect(records).toHaveLength(TED_MAX_PAGES_PER_RUN);
        expect(stub.logs.warning.some((m) => /stopped after 400 pages/.test(m))).toBe(true);
    });
});

describe('failure paths (SourceFetchError, isolated per source by the router)', () => {
    it('a 400 is a QUERY_ERROR that surfaces TED\'s own field-level message', async () => {
        const stub = makeCtx(() => new HttpStatusError(TED_SEARCH_URL, 400, body400));
        const error = await euTedConnector.fetch(stub.ctx, defaults(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('eu_ted');
        expect((error as Error).message).toMatch(/QUERY_ERROR/);
        expect((error as Error).message).toMatch(/Validation error \(query: Unexpected token near AND AND\)/);
    });

    it('a 429 is RATE_LIMITED, a 5xx and a network failure are UPSTREAM_OUTAGE', async () => {
        for (const [failure, expected] of [
            [new HttpStatusError(TED_SEARCH_URL, 429, 'slow down'), /RATE_LIMITED/],
            [new HttpStatusError(TED_SEARCH_URL, 503, ''), /UPSTREAM_OUTAGE.*503/],
            [new TypeError('fetch failed: ECONNRESET'), /UPSTREAM_OUTAGE.*ECONNRESET/],
        ] as const) {
            const stub = makeCtx(() => failure);
            await expect(euTedConnector.fetch(stub.ctx, defaults(), RUN)).rejects.toThrow(expected);
        }
    });

    it('an unexpected status falls back to the generic QUERY_ERROR class with the body preview', () => {
        expect(describeTedFailure(new HttpStatusError(TED_SEARCH_URL, 404, 'nope'))).toMatch(/QUERY_ERROR.*404.*nope/);
    });

    it('a response that is not {notices[], totalNoticeCount} fails the source instead of reporting "no notices"', async () => {
        for (const bad of [{ error: 'x' }, { notices: 'nope', totalNoticeCount: 1 }, { notices: [], totalNoticeCount: '12' }, null, 'html']) {
            const stub = makeCtx(serve(bad));
            await expect(euTedConnector.fetch(stub.ctx, defaults(), RUN)).rejects.toBeInstanceOf(SourceFetchError);
        }
    });

    it('a failure on page 2 fails the whole source (no silent partial result)', async () => {
        const server = pagedServer(120);
        const stub = makeCtx((request) => ((request.body as { page: number }).page === 2 ? new HttpStatusError(TED_SEARCH_URL, 500, '') : server(request)));
        await expect(euTedConnector.fetch(stub.ctx, euTedOptionsSchema.parse({ limit: 50 }), { maxItemsPerSource: 1000 })).rejects.toThrow(/page 2 failed/);
    });

    it('extractErrorMessage reads message / error[] / detail / error-string bodies', () => {
        expect(extractErrorMessage({ message: 'm', error: [{ field: 'f', message: 'x' }] })).toBe('m (f: x)');
        expect(extractErrorMessage({ error: [{ message: 'only' }] })).toBe('only');
        expect(extractErrorMessage({ message: 'top' })).toBe('top');
        expect(extractErrorMessage({ detail: 'd' })).toBe('d');
        expect(extractErrorMessage({ error: 'e' })).toBe('e');
        expect(extractErrorMessage({})).toBeNull();
        expect(extractErrorMessage(null)).toBeNull();
    });
});

describe('through the real router', () => {
    const engineInput = (extra: Record<string, unknown> = {}) => ({ sources: ['eu_ted'], deltaMode: 'onlyChanged', maxItemsPerSource: 100, ...extra });

    it('first run emits every notice as first_seen with router-added keys; an identical second run emits nothing', async () => {
        const store = new InMemoryDeltaStore();
        const first = await runThroughRouter(euTedConnector, engineInput(), makeCtx(serve(live)), store);
        expect(first.rows).toHaveLength(4);
        expect(first.summary.sources[0]).toMatchObject({ source: 'eu_ted', fetched: 4, emitted: 4, firstSeen: 4 });
        const row = first.rows[0] as Record<string, unknown>;
        expect(row).toMatchObject({
            engine: 'latam-global-tender-intelligence',
            source: 'eu_ted',
            record_id: '52d740c8-2435-4714-acc3-6bca47d46400',
            delta_status: 'first_seen',
            is_new: true,
            is_watchlist_match: false,
            matched_watchlist_keyword: null,
            notice_identifier: '52d740c8-2435-4714-acc3-6bca47d46400',
            awarded_value: 3012300,
        });
        expect(first.billing.totalFor(RESULT_EVENT)).toBe(4);

        const second = await runThroughRouter(euTedConnector, engineInput(), makeCtx(serve(live)), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 4, emitted: 0, unchanged: 4 });
        expect(second.billing.totalFor(RESULT_EVENT)).toBe(0);
    });

    it('a changed deadline is re-emitted as "updated"; deltaMode onlyNew would not re-emit it', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(euTedConnector, engineInput(), makeCtx(serve(live)), store);

        const edited = structuredClone(live);
        edited.notices[2] = { ...(edited.notices[2] as RawNotice), 'deadline-receipt-tender-date-lot': ['2026-11-27+01:00'] };
        const onlyNew = await runThroughRouter(euTedConnector, engineInput({ deltaMode: 'onlyNew' }), makeCtx(serve(edited)), new InMemoryDeltaStore(store.peek()));
        expect(onlyNew.rows).toHaveLength(0);

        const changed = await runThroughRouter(euTedConnector, engineInput(), makeCtx(serve(edited)), store);
        expect(changed.rows).toHaveLength(1);
        expect(changed.rows[0]).toMatchObject({ delta_status: 'updated', is_new: false, record_id: 'a37b8c4f-6c53-4177-8214-a914cb9adb36', submission_deadline: '2026-11-27+01:00' });
    });

    it('a watchlist keyword matches the buyer name and the title, and bills exactly one watchlist-hit each', async () => {
        const byBuyer = await runThroughRouter(euTedConnector, engineInput({ watchlistNames: ['Raad van State'] }), makeCtx(serve(live)));
        const hits = byBuyer.rows.filter((r) => r.is_watchlist_match === true);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ matched_watchlist_keyword: 'Raad van State', notice_identifier: 'afe1c4d0-a2a8-453f-b78b-65c2e93b7aec' });
        expect(byBuyer.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);

        const byTitle = await runThroughRouter(euTedConnector, engineInput({ watchlistNames: ['ticket-issuing'] }), makeCtx(serve(live)));
        expect(byTitle.rows.filter((r) => r.is_watchlist_match === true)).toHaveLength(1);
        expect(byTitle.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
    });

    it('the ghost-billing inputs ([""], [" "], "", ["a"]) accept zero keywords, match nothing and bill no watchlist-hit', async () => {
        for (const watchlistNames of [[''], [' '], '', ['a'], [null], 7]) {
            const result = await runThroughRouter(euTedConnector, engineInput({ watchlistNames }), makeCtx(serve(live)));
            expect(result.rows, JSON.stringify(watchlistNames)).toHaveLength(4);
            expect(result.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
            expect(result.summary.watchlist.accepted).toBe(0);
        }
    });

    it('a failing TED call is isolated: the run completes, reports the source error and bills nothing', async () => {
        const result = await runThroughRouter(euTedConnector, engineInput(), makeCtx(() => new HttpStatusError(TED_SEARCH_URL, 400, body400)));
        expect(result.rows).toHaveLength(0);
        expect(result.summary.sources[0]?.error).toMatch(/QUERY_ERROR/);
        expect(result.billing.totalFor(RESULT_EVENT)).toBe(0);
    });
});
