/**
 * fda_ema_recalls connector tests. No network. Fixtures come from `regtech-b.recallFixtures.ts`: the legacy actor's
 * own live-captured samples (2026-09-07) plus records captured live in this session (2026-10-21). Cases marked
 * SYNTHETIC (generated pagination pages, one hand-built failure body) say so and never pose as upstream data.
 */
import { describe, expect, it } from 'vitest';

import { findKeywordMatch, sanitizeKeywordList } from '../lib/_guards.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { SourceFetchError } from '../lib/types.js';
import {
    buildFdaSearchClause,
    buildFdaUrl,
    EMA_DHPC_JSON_URL,
    emaAlertPayloadSchema,
    emaRawSchema,
    emaRecordId,
    emptyToNull,
    fdaAuthHeaders,
    fdaEmaOptionsSchema,
    fdaEmaRecallsConnector,
    fdaRawSchema,
    fdaRecallPayloadSchema,
    isFdaNoMatches,
    isWithinDateRange,
    normalizeEmaRecord,
    normalizeFdaRecord,
    parseEuDateToIso,
    parseFdaDateToIso,
    REGULATORY_DATA_DISCLAIMER,
    sortEmaNewestFirst,
    splitBudget,
    toFdaDateStamp,
} from '../global-regtech-compliance-feed/connectors/fdaEmaRecalls.js';
import { createEngineHarness, createStubHttp, FIXED_NOW, httpError, makeCtx, must, ROUTER_OWNED_KEYS, type StubRoute } from './regtech-b.helpers.js';
import { LEGACY_EMA_SAMPLE, LEGACY_FDA_SAMPLE, LIVE_EMA_2026_10_21, LIVE_FDA_2026_10_21 } from './regtech-b.recallFixtures.js';

const RUN = { maxItemsPerSource: 500 };

const fdaTerminated = fdaRawSchema.parse(LEGACY_FDA_SAMPLE.results[0]); // D-321-2016, Terminated, Class II
const fdaClassI = fdaRawSchema.parse(LEGACY_FDA_SAMPLE.results[1]); // D-0769-2026, Ongoing, Class I
const fdaBlankState = fdaRawSchema.parse(LEGACY_FDA_SAMPLE.results[2]); // D-0759-2026, state ""
const fdaLive = fdaRawSchema.parse(LIVE_FDA_2026_10_21.results[0]); // D-0006-2027 (live 2026-10-21)

const emaJentadueto = emaRawSchema.parse(LEGACY_EMA_SAMPLE.data[0]);
const emaTavneos = emaRawSchema.parse(LEGACY_EMA_SAMPLE.data[1]);
const emaOcrevus = emaRawSchema.parse(LIVE_EMA_2026_10_21.ocrevus_first_in_export);
const emaEcalta = emaRawSchema.parse(LIVE_EMA_2026_10_21.ecalta_blank_dissemination_last_in_export);

const FDA_BASE = 'https://api.fda.gov/drug/enforcement.json';

function fdaPage(results: unknown[], total: number, skip = 0): Record<string, unknown> {
    return { meta: { results: { skip, limit: results.length, total } }, results };
}

/**
 * The 3 real legacy records as an EXHAUSTED result set. The captured `meta.results.total` (17,899) belongs to a
 * `limit=3` request against the whole database; replaying it for a larger limit would tell the connector that more
 * pages exist, so `total` is set to the number of records actually present.
 */
function legacyFdaPage(): Record<string, unknown> {
    return fdaPage([...LEGACY_FDA_SAMPLE.results], LEGACY_FDA_SAMPLE.results.length);
}

/** Deliberately unsorted, so the connector's newest-first ordering is exercised. */
function emaExport(extra: unknown[] = []): Record<string, unknown> {
    return {
        meta: { total_records: 4 + extra.length, timestamp: '2026-10-21T06:00:33Z' },
        data: [LIVE_EMA_2026_10_21.ecalta_blank_dissemination_last_in_export, ...LEGACY_EMA_SAMPLE.data.slice().reverse(), LIVE_EMA_2026_10_21.ocrevus_first_in_export, ...extra],
    };
}

function opts(raw: Record<string, unknown> = {}) {
    return fdaEmaOptionsSchema.parse(raw);
}

// --- dates -----------------------------------------------------------------------------------------------------

describe('date handling', () => {
    it('parses FDA YYYYMMDD and EMA DD/MM/YYYY into UTC ISO instants', () => {
        expect(parseFdaDateToIso('20260819')).toBe('2026-08-19T00:00:00.000Z');
        expect(parseEuDateToIso('20/08/2026')).toBe('2026-08-20T00:00:00.000Z');
    });

    it('returns null, never a rolled-over date, for blank, malformed or impossible input', () => {
        for (const bad of ['', undefined, null, '2026-08-19', '20261340', '20260230', '8/19/2026']) expect(parseFdaDateToIso(bad as string | null | undefined)).toBeNull();
        for (const bad of ['', undefined, null, '2026-08-20', '31/02/2026', '20/13/2026', '1/1/2026']) expect(parseEuDateToIso(bad as string | null | undefined)).toBeNull();
    });

    it('isWithinDateRange rejects future-dated records, blank dates and out-of-window dates', () => {
        const now = FIXED_NOW;
        expect(isWithinDateRange('2026-10-20T00:00:00.000Z', '24h', now)).toBe(false); // 36h old
        expect(isWithinDateRange('2026-10-21T00:00:00.000Z', '24h', now)).toBe(true);
        expect(isWithinDateRange('2026-11-30T00:00:00.000Z', '365d', now)).toBe(false); // future
        expect(isWithinDateRange(null, '30d', now)).toBe(false);
        expect(isWithinDateRange(null, undefined, now)).toBe(true);
        expect(isWithinDateRange('not a date', '30d', now)).toBe(false);
    });

    it('toFdaDateStamp formats the UTC calendar day', () => {
        expect(toFdaDateStamp(FIXED_NOW)).toBe('20261021');
    });

    it('emptyToNull collapses "", "N/A" and nullish values', () => {
        expect(emptyToNull('  ')).toBeNull();
        expect(emptyToNull('N/A')).toBeNull();
        expect(emptyToNull(undefined)).toBeNull();
        expect(emptyToNull(' Ongoing ')).toBe('Ongoing');
    });
});

// --- normalisation ---------------------------------------------------------------------------------------------

describe('normalizeFdaRecord', () => {
    it('maps the Class I live-captured recall to the legacy UMS vocabulary', () => {
        const record = normalizeFdaRecord(fdaClassI);
        expect(record.recordId).toBe('fda:D-0769-2026');
        expect(record.payload).toMatchObject({
            source_url: `${FDA_BASE}?search=recall_number:%22D-0769-2026%22`,
            recipient_or_defendant_name: 'Buy-Herbal',
            entity_identifier_native: '98650',
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: '2026-03-21T00:00:00.000Z',
            publish_date_iso: '2026-08-19T00:00:00.000Z',
            category_or_type: 'Drugs',
            status_or_estado: 'Ongoing',
            awarding_or_regulating_agency: 'U.S. Food and Drug Administration (FDA)',
            jurisdiction: 'US',
            source_document_url: null,
            reference_number: 'D-0769-2026',
            recordSource: 'fda_enforcement',
            classification: 'Class I',
            recallingFirm: 'Buy-Herbal',
            recallNumber: 'D-0769-2026',
            eventId: '98650',
            city: 'Flushing',
            state: 'NY',
            country: 'United States',
            voluntaryMandated: 'Voluntary: Firm initiated',
            terminationDateIso: null,
            codeInfo: 'All lots within expiry.',
            moreCodeInfo: null, // the live value is the empty string
        });
        expect(record.payload.regulatoryDataDisclaimer).toBe(REGULATORY_DATA_DISCLAIMER);
    });

    it('carries the termination date of a Terminated recall and nulls an empty state', () => {
        const terminated = normalizeFdaRecord(fdaTerminated).payload;
        expect(terminated).toMatchObject({ status_or_estado: 'Terminated', terminationDateIso: '2017-12-29T00:00:00.000Z', classification: 'Class II' });
        expect(normalizeFdaRecord(fdaBlankState).payload).toMatchObject({ state: null, country: 'India' });
    });

    it('normalises a record captured live in this session', () => {
        const record = normalizeFdaRecord(fdaLive);
        expect(record.recordId).toBe('fda:D-0006-2027');
        expect(record.payload).toMatchObject({ recordSource: 'fda_enforcement', jurisdiction: 'US', publish_date_iso: '2026-10-14T00:00:00.000Z' });
    });

    it('never sets router-owned fields or the retired legacy event_type', () => {
        const payload = normalizeFdaRecord(fdaClassI).payload;
        for (const key of [...ROUTER_OWNED_KEYS, 'event_type']) expect(payload).not.toHaveProperty(key);
    });

    it('uses the recalling firm plus bounded product text as watchText', () => {
        const record = normalizeFdaRecord(fdaClassI);
        expect(record.watchText).toBe('Buy-Herbal Kian Pee Wan Capsules, 30-count bottles');
        const hit = findKeywordMatch(record.watchText, sanitizeKeywordList(['kian pee wan']));
        expect(hit).toBe('kian pee wan');
        expect(findKeywordMatch(record.watchText, sanitizeKeywordList(['']))).toBeNull();
        const long = normalizeFdaRecord({ ...fdaClassI, product_description: 'x'.repeat(5000) });
        expect((long.watchText ?? '').length).toBeLessThanOrEqual(401);
    });

    it('the mandatory disclaimer is a literal: a payload with any other text cannot be built', () => {
        const payload = { ...normalizeFdaRecord(fdaClassI).payload, regulatoryDataDisclaimer: 'edited' };
        expect(fdaRecallPayloadSchema.safeParse(payload).success).toBe(false);
        const { regulatoryDataDisclaimer: _removed, ...without } = normalizeFdaRecord(fdaClassI).payload;
        expect(fdaRecallPayloadSchema.safeParse(without).success).toBe(false);
    });

    it('has a stable recordId and fingerprint, and a status flip changes only what it should', () => {
        const base = normalizeFdaRecord(fdaClassI);
        expect(normalizeFdaRecord({ ...fdaClassI }).fingerprint).toBe(base.fingerprint);

        const terminated = normalizeFdaRecord({ ...fdaClassI, status: 'Terminated', termination_date: '20261020' });
        expect(terminated.recordId).toBe(base.recordId);
        expect(terminated.fingerprint).not.toBe(base.fingerprint);
        expect(terminated.payload.status_fingerprint).not.toBe(base.payload.status_fingerprint);

        const reclassified = normalizeFdaRecord({ ...fdaClassI, classification: 'Class II' });
        expect(reclassified.fingerprint).not.toBe(base.fingerprint);
        expect(reclassified.payload.status_fingerprint).toBe(base.payload.status_fingerprint);
        expect(reclassified.payload.content_fingerprint).not.toBe(base.payload.content_fingerprint);

        for (const patch of [{ distribution_pattern: 'Nationwide' }, { reason_for_recall: 'Corrected reason' }, { code_info: 'Lot 7' }, { more_code_info: 'More' }]) {
            expect(normalizeFdaRecord({ ...fdaClassI, ...patch }).fingerprint).not.toBe(base.fingerprint);
        }
    });

    it('leaves the fingerprint alone when only a field the consumer never sees changes (address, quantity)', () => {
        const base = normalizeFdaRecord(fdaClassI);
        expect(normalizeFdaRecord({ ...fdaClassI, product_quantity: '1 bottle' }).fingerprint).toBe(base.fingerprint);
    });

    it('skips raw records that have no recall_number at the schema level', () => {
        expect(fdaRawSchema.safeParse({ status: 'Ongoing' }).success).toBe(false);
        expect(fdaRawSchema.safeParse({ recall_number: '' }).success).toBe(false);
    });
});

describe('normalizeEmaRecord', () => {
    it('maps the live-captured Jentadueto quality-defect DHPC', () => {
        const record = normalizeEmaRecord(emaJentadueto);
        expect(record.recordId).toBe('ema:jentadueto:20/08/2026');
        expect(record.payload).toMatchObject({
            source_url: 'https://www.ema.europa.eu/en/medicines/dhpc/jentadueto',
            recipient_or_defendant_name: 'Jentadueto',
            entity_identifier_native: 'A10BD11',
            effective_date_iso: '2026-08-20T00:00:00.000Z',
            publish_date_iso: '2026-08-20T00:00:00.000Z',
            category_or_type: 'Quality defect',
            status_or_estado: null,
            awarding_or_regulating_agency: 'European Medicines Agency (EMA)',
            jurisdiction: 'EU',
            source_document_url: null,
            reference_number: null, // procedure_number is "" in the live record
            recordSource: 'ema_dhpc',
            nameOfMedicine: 'Jentadueto',
            activeSubstances: 'linagliptin;metformin hydrochloride',
            therapeuticAreaMesh: 'Diabetes Mellitus, Type 2',
            referralName: null,
            lastUpdatedDateIso: null,
        });
        expect(record.payload.regulatoryDataDisclaimer).toBe(REGULATORY_DATA_DISCLAIMER);
    });

    it('maps a referral with a regulatory outcome and procedure number', () => {
        expect(normalizeEmaRecord(emaTavneos).payload).toMatchObject({
            status_or_estado: 'Revocation',
            reference_number: 'EMA/REF/0000325221',
            dhpcType: 'Referral - Article 20 procedure',
            referralName: 'Tavneos',
        });
    });

    it('falls back to first_published_date for the id when dissemination_date is blank (real Ecalta record)', () => {
        expect(emaEcalta.dissemination_date).toBe('');
        const record = normalizeEmaRecord(emaEcalta);
        expect(record.recordId).toBe('ema:ecalta:14/02/2020');
        expect(record.payload).toMatchObject({ effective_date_iso: null, publish_date_iso: '2020-02-14T00:00:00.000Z' });
    });

    it('uses "undated" when neither date exists (SYNTHETIC record)', () => {
        expect(emaRecordId({ ...emaEcalta, first_published_date: '' })).toBe('ema:ecalta:undated');
    });

    it('never sets router-owned fields', () => {
        const payload = normalizeEmaRecord(emaOcrevus).payload;
        for (const key of [...ROUTER_OWNED_KEYS, 'event_type']) expect(payload).not.toHaveProperty(key);
    });

    it('uses medicine name plus active substances as watchText', () => {
        expect(normalizeEmaRecord(emaJentadueto).watchText).toBe('Jentadueto linagliptin;metformin hydrochloride');
    });

    it('status flip and content edit change the fingerprint; identity-only churn does not', () => {
        const base = normalizeEmaRecord(emaTavneos);
        expect(normalizeEmaRecord({ ...emaTavneos }).fingerprint).toBe(base.fingerprint);
        const outcome = normalizeEmaRecord({ ...emaTavneos, regulatory_outcome: 'Suspension' });
        expect(outcome.fingerprint).not.toBe(base.fingerprint);
        expect(outcome.payload.status_fingerprint).not.toBe(base.payload.status_fingerprint);
        expect(outcome.payload.content_fingerprint).toBe(base.payload.content_fingerprint);
        const updated = normalizeEmaRecord({ ...emaTavneos, last_updated_date: '01/10/2026' });
        expect(updated.fingerprint).not.toBe(base.fingerprint);
        expect(updated.payload.status_fingerprint).toBe(base.payload.status_fingerprint);
        expect(updated.payload.lastUpdatedDateIso).toBe('2026-10-01T00:00:00.000Z');
        // `category` is not part of the output or the fingerprint.
        expect(normalizeEmaRecord({ ...emaTavneos, category: 'Veterinary' }).fingerprint).toBe(base.fingerprint);
    });

    it('rejects a payload with a mutated disclaimer', () => {
        const payload = { ...normalizeEmaRecord(emaOcrevus).payload, regulatoryDataDisclaimer: 'edited' };
        expect(emaAlertPayloadSchema.safeParse(payload).success).toBe(false);
    });

    it('sortEmaNewestFirst orders by dissemination date, falling back to first publication', () => {
        const sorted = sortEmaNewestFirst([emaEcalta, emaTavneos, emaJentadueto, emaOcrevus]).map((r) => r.dhpc_url.split('/').pop());
        expect(sorted).toEqual(['ocrevus', 'jentadueto', 'tavneos', 'ecalta']);
    });
});

// --- query building --------------------------------------------------------------------------------------------

describe('openFDA query building (live-verified syntax)', () => {
    it('builds no search clause without filters', () => {
        expect(buildFdaSearchClause(undefined, undefined, FIXED_NOW)).toBeUndefined();
        expect(buildFdaSearchClause(undefined, [], FIXED_NOW)).toBeUndefined();
        expect(buildFdaUrl(undefined, 100, 0)).toBe(`${FDA_BASE}?sort=report_date:desc&limit=100`);
    });

    it('ORs classifications and ANDs the report_date window, keeping "+" literal', () => {
        const clause = buildFdaSearchClause('30d', ['Class I', 'Class II'], FIXED_NOW);
        expect(clause).toBe('(classification:%22Class%20I%22+classification:%22Class%20II%22)+AND+report_date:[20260921+TO+20261021]');
        expect(buildFdaUrl(clause, 100, 0)).toBe(`${FDA_BASE}?search=${clause}&sort=report_date:desc&limit=100`);
    });

    it('adds skip only after the first page', () => {
        expect(buildFdaUrl(undefined, 1000, 0)).not.toContain('skip');
        expect(buildFdaUrl(undefined, 500, 2000)).toBe(`${FDA_BASE}?sort=report_date:desc&limit=500&skip=2000`);
    });

    it('sends the API key as Basic-auth username, never in the URL', () => {
        expect(fdaAuthHeaders(undefined)).toBeUndefined();
        expect(fdaAuthHeaders('abcdefgh12345678')).toEqual({ authorization: `Basic ${Buffer.from('abcdefgh12345678:').toString('base64')}` });
        expect(buildFdaUrl(undefined, 10, 0)).not.toContain('api_key');
    });

    it('recognises only the NOT_FOUND "no matches" 404 as an empty result', () => {
        const noMatches = httpError(FDA_BASE, 404, '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}');
        expect(isFdaNoMatches(noMatches)).toBe(true);
        expect(isFdaNoMatches(httpError(FDA_BASE, 404, '<html>Not Found</html>'))).toBe(false);
        expect(isFdaNoMatches(httpError(FDA_BASE, 404))).toBe(false);
        expect(isFdaNoMatches(httpError(FDA_BASE, 500, 'NOT_FOUND'))).toBe(false);
        expect(isFdaNoMatches(new Error('NOT_FOUND'))).toBe(false);
        expect(isFdaNoMatches(null)).toBe(false);
    });
});

// --- options ---------------------------------------------------------------------------------------------------

describe('fdaEmaOptionsSchema', () => {
    it('defaults to both regulators with no filters and no key', () => {
        const parsed = opts();
        expect(parsed.subSources).toEqual(['fda', 'ema']);
        expect(parsed.dateRange).toBeUndefined();
        expect(parsed.fdaClassification).toBeUndefined();
        expect(parsed.fdaApiKey).toBeUndefined();
    });

    it('validates subSources, dateRange and fdaClassification', () => {
        expect(fdaEmaOptionsSchema.safeParse({ subSources: [] }).success).toBe(false);
        expect(fdaEmaOptionsSchema.safeParse({ subSources: ['fda', 'who'] }).success).toBe(false);
        expect(opts({ subSources: ['ema', 'ema'] }).subSources).toEqual(['ema']);
        expect(fdaEmaOptionsSchema.safeParse({ dateRange: '2d' }).success).toBe(false);
        expect(opts({ dateRange: '90d' }).dateRange).toBe('90d');
        expect(fdaEmaOptionsSchema.safeParse({ fdaClassification: ['Class IV'] }).success).toBe(false);
    });

    it('needs no credential, treats a blank key as absent, and rejects a malformed key', () => {
        expect(fdaEmaRecallsConnector.requiredOptions).toBeUndefined();
        expect(opts({ fdaApiKey: '' }).fdaApiKey).toBeUndefined();
        expect(opts({ fdaApiKey: '   ' }).fdaApiKey).toBeUndefined();
        expect(opts({ fdaApiKey: 'abcdefgh12345678' }).fdaApiKey).toBe('abcdefgh12345678');
        for (const bad of ['short', 'has space 12345678', 'colon:inside12345', 'new\nline12345678', 'k'.repeat(201), 12345678]) {
            expect(fdaEmaOptionsSchema.safeParse({ fdaApiKey: bad }).success).toBe(false);
        }
    });

    it('is accepted by the router preflight with no sourceOptions and rejected with a bad key', () => {
        const engine = { slug: 'global-regtech-compliance-feed' as const, connectors: [fdaEmaRecallsConnector] };
        expect(resolveSources(engine, EngineInputSchema.parse({ sources: ['fda_ema_recalls'] }))).toHaveLength(1);
        expect(() =>
            resolveSources(engine, EngineInputSchema.parse({ sources: ['fda_ema_recalls'], sourceOptions: { fda_ema_recalls: { fdaApiKey: 'bad key' } } })),
        ).toThrow(/Invalid options for "fda_ema_recalls"/u);
    });

    it('splitBudget shares the run cap evenly, earlier parts first', () => {
        expect(splitBudget(500, 2)).toEqual([250, 250]);
        expect(splitBudget(5, 2)).toEqual([3, 2]);
        expect(splitBudget(1, 2)).toEqual([1, 0]);
        expect(splitBudget(7, 1)).toEqual([7]);
        expect(splitBudget(10, 0)).toEqual([]);
    });
});

// --- connector.fetch -------------------------------------------------------------------------------------------

describe('fdaEmaRecallsConnector.fetch: FDA', () => {
    it('requests newest-first with the cap as limit and normalises every record', async () => {
        const { http, calls } = createStubHttp({ [buildFdaUrl(undefined, 100, 0)]: legacyFdaPage() });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 100 });
        expect(calls.map((c) => c.url)).toEqual([`${FDA_BASE}?sort=report_date:desc&limit=100`]);
        expect(records.map((r) => r.recordId)).toEqual(['fda:D-321-2016', 'fda:D-0769-2026', 'fda:D-0759-2026']);
        expect(must(calls[0]).init?.headers).toBeUndefined();
    });

    it('applies classification and dateRange filters through the search clause using ctx.now()', async () => {
        const clause = '(classification:%22Class%20I%22)+AND+report_date:[20261014+TO+20261021]';
        const { http, calls } = createStubHttp({ [buildFdaUrl(clause, 50, 0)]: fdaPage([LEGACY_FDA_SAMPLE.results[1]], 1) });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'], fdaClassification: ['Class I'], dateRange: '7d' }), { maxItemsPerSource: 50 });
        expect(must(calls[0]).url).toContain(`search=${clause}`);
        expect(records).toHaveLength(1);
    });

    it('paginates with skip past the 1000-per-request cap (SYNTHETIC pages cloned from a real record)', async () => {
        const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ ...LEGACY_FDA_SAMPLE.results[1], recall_number: `D-${from + i}-SYN` }));
        const routes: Record<string, StubRoute> = {
            [buildFdaUrl(undefined, 1000, 0)]: fdaPage(page(0, 1000), 2500, 0),
            [buildFdaUrl(undefined, 1000, 1000)]: fdaPage(page(1000, 1000), 2500, 1000),
            [buildFdaUrl(undefined, 500, 2000)]: fdaPage(page(2000, 500), 2500, 2000),
        };
        const { http, calls } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 2500 });
        expect(records).toHaveLength(2500);
        expect(new Set(records.map((r) => r.recordId)).size).toBe(2500);
        expect(calls.map((c) => c.url.replace(`${FDA_BASE}?sort=report_date:desc&`, ''))).toEqual(['limit=1000', 'limit=1000&skip=1000', 'limit=500&skip=2000']);
    });

    it('stops paging once skip reaches meta.results.total, even below the cap (SYNTHETIC)', async () => {
        const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ ...LEGACY_FDA_SAMPLE.results[1], recall_number: `D-${from + i}-SYN` }));
        const { http, calls } = createStubHttp({
            [buildFdaUrl(undefined, 1000, 0)]: fdaPage(page(0, 1000), 1200),
            [buildFdaUrl(undefined, 1000, 1000)]: fdaPage(page(1000, 200), 1200),
        });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 2500 });
        expect(records).toHaveLength(1200);
        expect(calls).toHaveLength(2);
    });

    it('honours maxItemsPerSource even when the API returns more than asked (SYNTHETIC over-delivery)', async () => {
        const { http } = createStubHttp({ [buildFdaUrl(undefined, 2, 0)]: fdaPage([...LEGACY_FDA_SAMPLE.results], 3) });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 2 });
        expect(records).toHaveLength(2);
    });

    it('treats the live-verified 404 NOT_FOUND "No matches found!" as an empty result, not a failure', async () => {
        const url = buildFdaUrl(buildFdaSearchClause('24h', ['Class I'], FIXED_NOW), 100, 0);
        const { http } = createStubHttp({ [url]: httpError(url, 404, '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}') });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'], dateRange: '24h', fdaClassification: ['Class I'] }), { maxItemsPerSource: 100 });
        expect(records).toEqual([]);
    });

    it('still fails on any other 404 (SYNTHETIC body)', async () => {
        const url = buildFdaUrl(undefined, 100, 0);
        const { http } = createStubHttp({ [url]: httpError(url, 404, '<html>endpoint moved</html>') });
        const { ctx } = makeCtx(http);
        await expect(fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 100 })).rejects.toBeInstanceOf(SourceFetchError);
    });

    it('skips records without a recall_number and warns (SYNTHETIC record)', async () => {
        const url = buildFdaUrl(undefined, 100, 0);
        const { http } = createStubHttp({ [url]: fdaPage([LEGACY_FDA_SAMPLE.results[1], { status: 'Ongoing' }], 2) });
        const { ctx, logs } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 100 });
        expect(records.map((r) => r.recordId)).toEqual(['fda:D-0769-2026']);
        expect(logs.some((l) => l.level === 'warning' && l.message.includes('no usable recall_number'))).toBe(true);
    });

    it('rejects a response that is not an openFDA page', async () => {
        const url = buildFdaUrl(undefined, 100, 0);
        const { http } = createStubHttp({ [url]: { results: 'not-an-array' } });
        const { ctx } = makeCtx(http);
        await expect(fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'] }), { maxItemsPerSource: 100 })).rejects.toThrow(/unexpected openFDA response shape/u);
    });

    it('sends the BYOK key as a Basic header and never leaks it into the URL or an error message', async () => {
        const key = 'abcdefgh12345678';
        const url = buildFdaUrl(undefined, 100, 0);
        const { http, calls } = createStubHttp({ [url]: legacyFdaPage() });
        const { ctx } = makeCtx(http);
        await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['fda'], fdaApiKey: key }), { maxItemsPerSource: 100 });
        const call = must(calls[0]);
        expect(call.init?.headers?.authorization).toBe(`Basic ${Buffer.from(`${key}:`).toString('base64')}`);
        expect(call.url).not.toContain(key);

        const failing = createStubHttp({ [url]: httpError(url, 403, '{"error":{"code":"API_KEY_INVALID","message":"An invalid api_key was supplied."}}') });
        const failure = await fdaEmaRecallsConnector.fetch(makeCtx(failing.http).ctx, opts({ subSources: ['fda'], fdaApiKey: key }), { maxItemsPerSource: 100 }).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).message).toMatch(/403/u);
        expect((failure as SourceFetchError).message).not.toContain(key);
        expect((failure as SourceFetchError).message).not.toContain(Buffer.from(`${key}:`).toString('base64'));
    });
});

describe('fdaEmaRecallsConnector.fetch: EMA', () => {
    it('downloads once, sorts newest-first and normalises every record', async () => {
        const { http, calls } = createStubHttp({ [EMA_DHPC_JSON_URL]: emaExport() });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['ema'] }), RUN);
        expect(calls).toHaveLength(1);
        expect(records.map((r) => r.recordId)).toEqual(['ema:ocrevus:08/10/2026', 'ema:jentadueto:20/08/2026', 'ema:tavneos:16/07/2026', 'ema:ecalta:14/02/2020']);
    });

    it('filters client-side by dateRange relative to ctx.now(), excluding blank-dated and future records', async () => {
        const future = { ...LIVE_EMA_2026_10_21.ocrevus_first_in_export, dhpc_url: 'https://www.ema.europa.eu/en/medicines/dhpc/futuristic', dissemination_date: '01/12/2026' };
        const { http } = createStubHttp({ [EMA_DHPC_JSON_URL]: emaExport([future]) });
        const { ctx } = makeCtx(http);
        const d30 = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['ema'], dateRange: '30d' }), RUN);
        expect(d30.map((r) => r.recordId)).toEqual(['ema:ocrevus:08/10/2026']);
        const d90 = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['ema'], dateRange: '90d' }), RUN);
        expect(d90.map((r) => r.recordId)).toEqual(['ema:ocrevus:08/10/2026', 'ema:jentadueto:20/08/2026']);
    });

    it('honours maxItemsPerSource', async () => {
        const { http } = createStubHttp({ [EMA_DHPC_JSON_URL]: emaExport() });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['ema'] }), { maxItemsPerSource: 2 });
        expect(records.map((r) => r.recordId)).toEqual(['ema:ocrevus:08/10/2026', 'ema:jentadueto:20/08/2026']);
    });

    it('rejects an export without a data array and skips entries without a dhpc_url (SYNTHETIC bodies)', async () => {
        const bad = createStubHttp({ [EMA_DHPC_JSON_URL]: { meta: {} } });
        await expect(fdaEmaRecallsConnector.fetch(makeCtx(bad.http).ctx, opts({ subSources: ['ema'] }), RUN)).rejects.toThrow(/no "data" array/u);

        const partial = createStubHttp({ [EMA_DHPC_JSON_URL]: emaExport([{ name_of_medicine: 'No URL Medicine' }]) });
        const { ctx, logs } = makeCtx(partial.http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts({ subSources: ['ema'] }), RUN);
        expect(records).toHaveLength(4);
        expect(logs.some((l) => l.level === 'warning' && l.message.includes('no usable dhpc_url'))).toBe(true);
    });
});

describe('fdaEmaRecallsConnector.fetch: both sub-sources', () => {
    it('shares maxItemsPerSource between FDA and EMA, FDA first', async () => {
        const { http, calls } = createStubHttp({
            [buildFdaUrl(undefined, 3, 0)]: legacyFdaPage(),
            [EMA_DHPC_JSON_URL]: emaExport(),
        });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts(), { maxItemsPerSource: 5 });
        expect(calls).toHaveLength(2);
        expect(records.map((r) => r.recordId)).toEqual([
            'fda:D-321-2016',
            'fda:D-0769-2026',
            'fda:D-0759-2026',
            'ema:ocrevus:08/10/2026',
            'ema:jentadueto:20/08/2026',
        ]);
        expect(records.length).toBeLessThanOrEqual(5);
    });

    it('does not even request the second regulator when the cap leaves it no share', async () => {
        const { http, calls } = createStubHttp({ [buildFdaUrl(undefined, 1, 0)]: fdaPage([LEGACY_FDA_SAMPLE.results[1]], 1) });
        const { ctx } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts(), { maxItemsPerSource: 1 });
        expect(records.map((r) => r.recordId)).toEqual(['fda:D-0769-2026']);
        expect(calls.some((c) => c.url === EMA_DHPC_JSON_URL)).toBe(false);
    });

    it('keeps the healthy regulator when the other fails, and logs the failure', async () => {
        const { http } = createStubHttp({ [buildFdaUrl(undefined, 250, 0)]: httpError(FDA_BASE, 503, 'down'), [EMA_DHPC_JSON_URL]: emaExport() });
        const { ctx, logs } = makeCtx(http);
        const records = await fdaEmaRecallsConnector.fetch(ctx, opts(), RUN);
        expect(records).toHaveLength(4);
        expect(records.every((r) => r.recordId.startsWith('ema:'))).toBe(true);
        expect(logs.some((l) => l.level === 'warning' && l.message.includes('fda failed'))).toBe(true);
    });

    it('throws SourceFetchError carrying the source id when every selected regulator fails', async () => {
        const { http } = createStubHttp({ [buildFdaUrl(undefined, 250, 0)]: httpError(FDA_BASE, 503, 'down'), [EMA_DHPC_JSON_URL]: new Error('connect ECONNRESET') });
        const { ctx } = makeCtx(http);
        const failure = await fdaEmaRecallsConnector.fetch(ctx, opts(), RUN).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).source).toBe('fda_ema_recalls');
        expect((failure as SourceFetchError).message).toMatch(/fda: .*503/u);
        expect((failure as SourceFetchError).message).toMatch(/ema: .*ECONNRESET/u);
    });
});

describe('through the router', () => {
    it('adds the router fields, flags a real watchlist hit once and never bills a degenerate watchlist', async () => {
        const routes = { [buildFdaUrl(undefined, 250, 0)]: legacyFdaPage(), [EMA_DHPC_JSON_URL]: emaExport() };
        const hit = createEngineHarness({ connectors: [fdaEmaRecallsConnector], http: createStubHttp(routes).http });
        const summary = await hit.run({ sources: ['fda_ema_recalls'], deltaMode: 'all', watchlistNames: ['Buy-Herbal'] });
        expect(hit.rows).toHaveLength(7);
        expect(hit.rows[0]).toMatchObject({
            engine: 'global-regtech-compliance-feed',
            source: 'fda_ema_recalls',
            record_id: 'fda:D-321-2016',
            delta_status: 'first_seen',
            is_new: true,
            recordSource: 'fda_enforcement',
        });
        const hits = hit.rows.filter((row) => row.is_watchlist_match === true);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ record_id: 'fda:D-0769-2026', matched_watchlist_keyword: 'Buy-Herbal' });
        expect(hit.billing.totalFor('watchlist-hit')).toBe(1);
        expect(summary.watchlist.hitsCharged).toBe(1);

        for (const watchlistNames of [[''], [' '], 'a', ['a'], ['--'], [null], 42]) {
            const ghost = createEngineHarness({ connectors: [fdaEmaRecallsConnector], http: createStubHttp(routes).http });
            await ghost.run({ sources: ['fda_ema_recalls'], deltaMode: 'all', watchlistNames });
            expect(ghost.rows).toHaveLength(7);
            expect(ghost.rows.some((row) => row.is_watchlist_match === true)).toBe(false);
            expect(ghost.billing.totalFor('watchlist-hit')).toBe(0);
        }
    });

    it('reports a changed recall as updated on the next run and an unchanged one as unchanged', async () => {
        const store = createEngineHarness({ connectors: [fdaEmaRecallsConnector], http: createStubHttp({}).http }).store;
        const first = createEngineHarness({
            connectors: [fdaEmaRecallsConnector],
            http: createStubHttp({ [buildFdaUrl(undefined, 100, 0)]: fdaPage([LEGACY_FDA_SAMPLE.results[1]], 1) }).http,
            store,
        });
        await first.run({ sources: ['fda_ema_recalls'], sourceOptions: { fda_ema_recalls: { subSources: ['fda'] } }, deltaMode: 'onlyChanged', maxItemsPerSource: 100 });
        expect(first.rows).toHaveLength(1);

        const terminatedRecord = { ...LEGACY_FDA_SAMPLE.results[1], status: 'Terminated', termination_date: '20261020' };
        const second = createEngineHarness({
            connectors: [fdaEmaRecallsConnector],
            http: createStubHttp({ [buildFdaUrl(undefined, 100, 0)]: fdaPage([terminatedRecord], 1) }).http,
            store,
        });
        await second.run({ sources: ['fda_ema_recalls'], sourceOptions: { fda_ema_recalls: { subSources: ['fda'] } }, deltaMode: 'onlyChanged', maxItemsPerSource: 100 });
        expect(second.rows).toHaveLength(1);
        expect(second.rows[0]).toMatchObject({ delta_status: 'updated', is_new: false, status_or_estado: 'Terminated' });

        const third = createEngineHarness({
            connectors: [fdaEmaRecallsConnector],
            http: createStubHttp({ [buildFdaUrl(undefined, 100, 0)]: fdaPage([terminatedRecord], 1) }).http,
            store,
        });
        await third.run({ sources: ['fda_ema_recalls'], sourceOptions: { fda_ema_recalls: { subSources: ['fda'] } }, deltaMode: 'onlyChanged', maxItemsPerSource: 100 });
        expect(third.rows).toHaveLength(0);
    });
});
