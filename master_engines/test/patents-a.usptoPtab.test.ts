/**
 * uspto_ptab connector tests.
 *
 * Fixture (test/fixtures/patents-a/, no network): ptab_search_page_synthetic.json is SYNTHETIC - shaped by the USPTO ODP
 * "Search Proceedings" field set recorded in the legacy actor, with proceeding 1 using the sample values of the legacy
 * test/umsNormalizer.test.ts. No ODP key is held by this codebase, so no authenticated upstream response was ever captured;
 * the fixture says so in its own `_fixtureNote`. Pagination servers below are inline stubs that honour `pagination.offset`
 * / `pagination.limit` of the request body, the way the legacy actor's body shape implies.
 */
import { describe, expect, it } from 'vitest';

import {
    buildPtabRequestBody,
    flattenProceeding,
    fetchPtabProceedings,
    PTAB_AGENCY_NAME,
    PTAB_SEARCH_URL,
    ptabFingerprint,
    ptabUmsFields,
    ptabWatchText,
    scrubSecrets,
    toPtabSourceRecord,
    usptoPtabConnector,
    usptoPtabOptionsSchema,
} from '../global-corporate-patent-intelligence/connectors/usptoPtab.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { jsonFixture, makeCtx, type RecordedRequest, ROUTER_OWNED_KEYS, runThroughRouter } from './patents-a.helpers.js';

const KEY = 'odp-test-key-0123456789';
const RUN: RunParams = { maxItemsPerSource: 100 };
const page = jsonFixture('ptab_search_page_synthetic.json');
const [p1, p2, p3, p4] = page.patentTrialProceedingDataBag;

function options(extra: Record<string, unknown> = {}) {
    return usptoPtabConnector.optionsSchema.parse({ usptoOdpApiKey: KEY, ...extra });
}

/** A minimal proceeding with a unique trial number. */
function proceeding(n: number, extra: Record<string, unknown> = {}) {
    return {
        trialNumber: `T${String(n).padStart(4, '0')}`,
        trialMetaData: { trialTypeCode: 'IPR', trialStatusCategory: 'Instituted', petitionFilingDate: '2026-01-01' },
        patentOwnerData: { patentNumber: String(1000 + n), patentOwnerName: `Owner ${n} Corp` },
        ...extra,
    };
}

/** An ODP stand-in holding `all` and answering by the request's pagination window. */
function pagedServer(all: unknown[]) {
    return (request: RecordedRequest) => {
        if (request.method !== 'POST' || request.url !== PTAB_SEARCH_URL) return new Error(`unrouted request: ${request.method} ${request.url}`);
        const { offset, limit } = request.json.pagination as { offset: number; limit: number };
        return { patentTrialProceedingDataBag: all.slice(offset, offset + limit) };
    };
}

describe('flattenProceeding / ptabUmsFields (synthetic fixture)', () => {
    it('flattens the owner / petitioner view of a regular IPR exactly as the legacy actor did', () => {
        const flat = flattenProceeding(p1)!;
        expect(flat).toEqual({
            trialNumber: 'IPR2024-00123',
            trialTypeCode: 'IPR',
            trialStatusCategory: 'Instituted',
            petitionFilingDate: '2024-01-15',
            accordedFilingDate: '2024-01-20',
            institutionDecisionDate: '2024-07-10',
            latestDecisionDate: '2024-07-10',
            terminationDate: null,
            trialLastModifiedDateTime: '2024-07-10T12:00:00Z',
            fileDownloadURI: 'https://api.uspto.gov/api/v1/patent/trials/documents/IPR2024-00123/download',
            patentNumber: '10123456',
            applicationNumberText: '15123456',
            patentOwnerName: 'Acme Widgets Inc.',
            patentOwnerRealPartyInInterestName: 'Acme Widgets Inc.',
            petitionerRealPartyInInterestName: 'Globex Corp',
            petitionerCounselName: 'Jane Counsel',
            inventorName: 'John Inventor',
            technologyCenterNumber: '2600',
        });
    });

    it('falls back to respondentData / derivationPetitionerData and to the proceeding-level modified time', () => {
        const flat = flattenProceeding(p2)!;
        expect(flat.patentOwnerName).toBe('Initech LLC');
        expect(flat.patentOwnerRealPartyInInterestName).toBe('Initech Holdings LLC');
        expect(flat.petitionerRealPartyInInterestName).toBe('Umbrella Research Ltd');
        expect(flat.petitionerCounselName).toBe('Counsel & Partners');
        expect(flat.patentNumber).toBe('9876543');
        expect(flat.applicationNumberText).toBe('14999999'); // owner side has none: the petitioner's is used
        expect(flat.terminationDate).toBe('2025-03-01');
        expect(flat.trialLastModifiedDateTime).toBe('2025-03-02T08:30:00Z');
    });

    it('trims names, turns blanks into null and stringifies a numeric technology centre', () => {
        const flat = flattenProceeding(p3)!;
        expect(flat.patentOwnerName).toBe('Hooli Devices, Inc.');
        expect(flat.patentOwnerRealPartyInInterestName).toBeNull();
        expect(flat.technologyCenterNumber).toBe('1600');
        expect(flat.fileDownloadURI).toBeNull();
        expect(flat.institutionDecisionDate).toBeNull();
    });

    it('returns null for a proceeding with no trial number rather than inventing an identity', () => {
        expect(flattenProceeding(p4)).toBeNull();
        expect(flattenProceeding({ trialNumber: '   ' })).toBeNull();
    });

    it('maps the legacy UMS fields: owner as the "defendant", the patent as the entity id, no money, no invented URL', () => {
        const ums = ptabUmsFields(flattenProceeding(p1)!);
        expect(ums).toEqual({
            source_url: null,
            recipient_or_defendant_name: 'Acme Widgets Inc.',
            entity_identifier_native: '10123456',
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: '2024-07-10',
            publish_date_iso: '2024-01-15',
            category_or_type: 'IPR',
            status_or_estado: 'Instituted',
            awarding_or_regulating_agency: PTAB_AGENCY_NAME,
            jurisdiction: 'US',
            source_document_url: 'https://api.uspto.gov/api/v1/patent/trials/documents/IPR2024-00123/download',
            reference_number: 'IPR2024-00123',
        });
    });

    it('effective_date_iso falls back to the accorded filing date, then to null; the petitioner is never the "defendant"', () => {
        expect(ptabUmsFields(flattenProceeding(p2)!).effective_date_iso).toBe('2025-01-14');
        expect(ptabUmsFields(flattenProceeding(p3)!).effective_date_iso).toBeNull();
        expect(ptabUmsFields(flattenProceeding(p3)!).recipient_or_defendant_name).toBe('Hooli Devices, Inc.');
        const noNames = flattenProceeding({ trialNumber: 'X-1', trialMetaData: {} })!;
        expect(ptabUmsFields(noNames).recipient_or_defendant_name).toBeNull();
        expect(ptabUmsFields(noNames).entity_identifier_native).toBeNull();
    });
});

describe('record identity, fingerprint and watch text', () => {
    const base = flattenProceeding(p1)!;

    it('recordId is the trial number (the legacy record_id) and the payload merges raw + UMS fields', () => {
        const record = toPtabSourceRecord(base);
        expect(record.recordId).toBe('IPR2024-00123');
        expect(record.payload.trialNumber).toBe('IPR2024-00123');
        expect(record.payload.reference_number).toBe('IPR2024-00123');
        expect(record.payload.petitionerCounselName).toBe('Jane Counsel');
        expect(record.payload.jurisdiction).toBe('US');
    });

    it('the payload never sets a router-owned key (nor the delta-derived legacy event_type)', () => {
        for (const raw of [p1, p2, p3]) {
            const payload = toPtabSourceRecord(flattenProceeding(raw)!).payload;
            for (const key of [...ROUTER_OWNED_KEYS, 'event_type']) expect(Object.keys(payload)).not.toContain(key);
        }
    });

    it('the fingerprint is stable, and changes when status, decision, termination, document link, owner or petitioner change', () => {
        const fp = ptabFingerprint(base);
        expect(ptabFingerprint({ ...base })).toBe(fp);
        for (const change of [
            { trialStatusCategory: 'FWD Entered' },
            { latestDecisionDate: '2025-07-10' },
            { institutionDecisionDate: '2024-08-01' },
            { terminationDate: '2025-02-02' },
            { fileDownloadURI: null },
            { patentOwnerName: 'Acme Widgets Incorporated' },
            { petitionerRealPartyInInterestName: 'Globex Corporation' },
        ]) {
            expect(ptabFingerprint({ ...base, ...change })).not.toBe(fp);
        }
    });

    it('the fingerprint ignores the server-side "last modified" timestamp (it moves on edits nobody can see)', () => {
        expect(ptabFingerprint({ ...base, trialLastModifiedDateTime: '2030-01-01T00:00:00Z' })).toBe(ptabFingerprint(base));
    });

    it('watch text is the owner and petitioner entity names, de-duplicated, without counsel or inventors', () => {
        expect(ptabWatchText(base)).toBe('Acme Widgets Inc. Globex Corp');
        expect(ptabWatchText(base)).not.toContain('Jane Counsel');
        expect(ptabWatchText(base)).not.toContain('John Inventor');
        expect(ptabWatchText(flattenProceeding(p2)!)).toBe('Initech LLC Initech Holdings LLC Umbrella Research Ltd');
    });
});

describe('request building', () => {
    it('sends the legacy body: q "*", no filters, pagination from offset 0 and the trialNumber tie-break sort', async () => {
        const stub = makeCtx(pagedServer([proceeding(1)]));
        await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 500 });
        expect(stub.requests).toHaveLength(1);
        const request = stub.requests[0]!;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://api.uspto.gov/api/v1/patent/trials/proceedings/search');
        expect(request.json).toEqual({
            q: '*',
            filters: [],
            rangeFilters: [],
            pagination: { offset: 0, limit: 100 },
            sort: [
                { field: 'trialMetaData.petitionFilingDate', order: 'Desc' },
                { field: 'trialNumber', order: 'Asc' },
            ],
        });
    });

    it('authenticates with x-api-key only and declares a JSON body', async () => {
        const stub = makeCtx(pagedServer([proceeding(1)]));
        await fetchPtabProceedings(stub.ctx, options(), RUN);
        const request = stub.requests[0]!;
        expect(request.headers['x-api-key']).toBe(KEY);
        expect(request.headers['content-type']).toBe('application/json');
        expect(request.url).not.toContain(KEY);
        expect(request.via).toBe('getJson');
    });

    it('applies trialTypeCodes as a filter and dateRange as a petitionFilingDate rangeFilter ending on the connector clock', async () => {
        const stub = makeCtx(pagedServer([proceeding(1)]), '2026-10-21T08:00:00Z');
        await fetchPtabProceedings(stub.ctx, options({ trialTypeCodes: ['IPR', 'PGR'], dateRange: '30d' }), RUN);
        expect(stub.requests[0]!.json.filters).toEqual([{ name: 'trialMetaData.trialTypeCode', value: ['IPR', 'PGR'] }]);
        expect(stub.requests[0]!.json.rangeFilters).toEqual([{ field: 'trialMetaData.petitionFilingDate', valueFrom: '2026-09-21', valueTo: '2026-10-21' }]);
    });

    it('buildPtabRequestBody is pure and omits empty filters', () => {
        const body = buildPtabRequestBody({ trialTypeCodes: [], filingDateTo: '2026-10-21' }, 200, 50);
        expect(body.filters).toEqual([]);
        expect(body.rangeFilters).toEqual([]);
        expect(body.pagination).toEqual({ offset: 200, limit: 50 });
    });
});

describe('fetch against the synthetic fixture', () => {
    it('returns one record per usable proceeding, skips the one without a trial number and reports it', async () => {
        const stub = makeCtx(() => page);
        const records = await usptoPtabConnector.fetch(stub.ctx, options(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['IPR2024-00123', 'DER2025-00007', 'PGR2026-00002']);
        expect(stub.logs.warning.join('\n')).toMatch(/skipped 1 proceeding\(s\) with no trialNumber/);
        expect(stub.logs.info.join('\n')).toMatch(/fetched 3 trial proceeding/);
    });

    it('recordId and fingerprint are identical across two fetches of the same data', async () => {
        const first = await usptoPtabConnector.fetch(makeCtx(() => page).ctx, options(), RUN);
        const second = await usptoPtabConnector.fetch(makeCtx(() => structuredClone(page)).ctx, options(), RUN);
        expect(second.map((r) => [r.recordId, r.fingerprint])).toEqual(first.map((r) => [r.recordId, r.fingerprint]));
    });

    it('a changed trial status changes the fingerprint but not the recordId', async () => {
        const before = (await usptoPtabConnector.fetch(makeCtx(() => page).ctx, options(), RUN))[0]!;
        const changed = structuredClone(page);
        changed.patentTrialProceedingDataBag[0].trialMetaData.trialStatusCategory = 'FWD Entered';
        const after = (await usptoPtabConnector.fetch(makeCtx(() => changed).ctx, options(), RUN))[0]!;
        expect(after.recordId).toBe(before.recordId);
        expect(after.fingerprint).not.toBe(before.fingerprint);
    });
});

describe('pagination and maxItemsPerSource', () => {
    const all = Array.from({ length: 250 }, (_, i) => proceeding(i + 1));

    it('pages sequentially in windows of 100, shrinking the last window to what is still wanted', async () => {
        const stub = makeCtx(pagedServer(all));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 250 });
        expect(records).toHaveLength(250);
        expect(stub.requests.map((r) => r.json.pagination)).toEqual([
            { offset: 0, limit: 100 },
            { offset: 100, limit: 100 },
            { offset: 200, limit: 50 },
        ]);
    });

    it('honours maxItemsPerSource: a budget of 3 is one request of limit 3 and exactly 3 records', async () => {
        const stub = makeCtx(pagedServer(all));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 3 });
        expect(records.map((r) => r.recordId)).toEqual(['T0001', 'T0002', 'T0003']);
        expect(stub.requests).toHaveLength(1);
        expect(stub.requests[0]!.json.pagination.limit).toBe(3);
    });

    it('stops at a short page (the last page) without asking for another', async () => {
        const stub = makeCtx(pagedServer(all.slice(0, 30)));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 500 });
        expect(records).toHaveLength(30);
        expect(stub.requests).toHaveLength(1);
    });

    it('stops on an empty page after an exactly full one', async () => {
        const stub = makeCtx(pagedServer(all.slice(0, 100)));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 500 });
        expect(records).toHaveLength(100);
        expect(stub.requests).toHaveLength(2);
    });

    it('de-duplicates a trial re-served across a page boundary and asks for one more row to fill the slot it lost', async () => {
        // Page 1: T0001..T0100. Page 2 (5 wanted) re-serves T0100 plus 4 new rows. Unique so far: 104 of 105.
        const page1 = Array.from({ length: 100 }, (_, i) => proceeding(i + 1));
        const page2 = [proceeding(100), ...Array.from({ length: 4 }, (_, i) => proceeding(i + 101))];
        const stub = makeCtx((request) => {
            const { offset } = request.json.pagination as { offset: number };
            return { patentTrialProceedingDataBag: offset === 0 ? page1 : offset === 100 ? page2 : [] };
        });
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 105 });
        const ids = records.map((r) => r.recordId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((id) => id === 'T0100')).toHaveLength(1);
        expect(records).toHaveLength(104);
        expect(stub.requests.map((r) => r.json.pagination.offset)).toEqual([0, 100, 105]);
    });

    it('does not loop on a server that keeps re-serving the same page', async () => {
        const same = Array.from({ length: 100 }, (_, i) => proceeding(i + 1));
        const stub = makeCtx(() => ({ patentTrialProceedingDataBag: same }));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 500 });
        expect(records).toHaveLength(100);
        expect(stub.requests).toHaveLength(2);
        expect(stub.logs.warning.join('\n')).toMatch(/added no new proceedings/);
    });

    it('a non-positive budget makes no request at all', async () => {
        const stub = makeCtx(pagedServer(all));
        expect(await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 0 })).toEqual([]);
        expect(stub.requests).toHaveLength(0);
    });
});

describe('response validation', () => {
    it('treats a response without the bag as an empty page and says so', async () => {
        const stub = makeCtx(() => ({}));
        expect(await fetchPtabProceedings(stub.ctx, options(), RUN)).toEqual([]);
        expect(stub.logs.warning.join('\n')).toMatch(/no patentTrialProceedingDataBag/);
    });

    it('rejects a JSON null, an array, and a bag that is not an array - never reads them as "no trials"', async () => {
        for (const bad of [null, [], { patentTrialProceedingDataBag: 'nope' }, { patentTrialProceedingDataBag: { 0: p1 } }]) {
            const stub = makeCtx(() => bad);
            await expect(fetchPtabProceedings(stub.ctx, options(), RUN)).rejects.toBeInstanceOf(SourceFetchError);
        }
    });
});

describe('failure handling', () => {
    it('a failure on the first page is a SourceFetchError that names the source, the status and the likely cause', async () => {
        const stub = makeCtx(() => new HttpStatusError(PTAB_SEARCH_URL, 403, '{"message":"Forbidden"}'));
        const error = await fetchPtabProceedings(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('uspto_ptab');
        expect((error as SourceFetchError).message).toMatch(/HTTP 403: \{"message":"Forbidden"\}.*key was rejected/);
    });

    it('a 429 names the burst = 1 / 5 second guidance', async () => {
        const stub = makeCtx(() => new HttpStatusError(PTAB_SEARCH_URL, 429, ''));
        await expect(fetchPtabProceedings(stub.ctx, options(), RUN)).rejects.toThrow(/rate limited.*burst = 1.*5 s/);
    });

    it('a failure on a LATER page keeps the pages already read and logs the truncation', async () => {
        const all = Array.from({ length: 200 }, (_, i) => proceeding(i + 1));
        const stub = makeCtx((request) => (request.json.pagination.offset === 0 ? pagedServer(all)(request) : new HttpStatusError(PTAB_SEARCH_URL, 503, 'busy')));
        const records = await fetchPtabProceedings(stub.ctx, options(), { maxItemsPerSource: 200 });
        expect(records).toHaveLength(100);
        expect(stub.logs.warning.join('\n')).toMatch(/page at offset 100 failed after 100 proceeding\(s\); returning what was fetched/);
    });

    it('never leaks the API key: it is scrubbed from upstream error bodies and from every log line', async () => {
        const echoing = new HttpStatusError(PTAB_SEARCH_URL, 401, `invalid key ${KEY} for caller`);
        const stub = makeCtx(() => echoing);
        const error = await fetchPtabProceedings(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expect(error!.message).not.toContain(KEY);
        expect(error!.message).toContain('***');

        const generic = makeCtx(() => new Error(`socket hang up while sending x-api-key: ${KEY}`));
        const error2 = await fetchPtabProceedings(generic.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(error2!.message).not.toContain(KEY);
        for (const line of [...stub.allLogLines(), ...generic.allLogLines()]) expect(line).not.toContain(KEY);
    });

    it('a successful run does not log the key either', async () => {
        const stub = makeCtx(() => page);
        await fetchPtabProceedings(stub.ctx, options(), RUN);
        expect(stub.allLogLines().length).toBeGreaterThan(0);
        for (const line of stub.allLogLines()) expect(line).not.toContain(KEY);
    });

    it('scrubSecrets only touches secrets of length >= 4 and leaves other text alone', () => {
        expect(scrubSecrets('a abcd b', ['abcd'])).toBe('a *** b');
        expect(scrubSecrets('a abc b', ['abc'])).toBe('a abc b');
        expect(scrubSecrets('x', [undefined, ''])).toBe('x');
    });

    it('called directly without a key it fails with a clear SourceFetchError (the router normally stops this in preflight)', async () => {
        const stub = makeCtx(() => page);
        await expect(fetchPtabProceedings(stub.ctx, usptoPtabOptionsSchema.parse({}), RUN)).rejects.toThrow(/usptoOdpApiKey is required/);
        expect(stub.requests).toHaveLength(0);
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [usptoPtabConnector] };
    const resolve = (sourceOptions: Record<string, Record<string, unknown>>) => resolveSources(engine, EngineInputSchema.parse({ sources: ['uspto_ptab'], sourceOptions }));

    it('declares BYOK through requiredOptions and is an active connector of the patent engine', () => {
        expect(usptoPtabConnector.requiredOptions).toEqual(['usptoOdpApiKey']);
        expect(usptoPtabConnector.id).toBe('uspto_ptab');
        expect(usptoPtabConnector.engine).toBe('global-corporate-patent-intelligence');
        expect(usptoPtabConnector.legacyActor).toBe('actor-21-patent-ip-enforcement-monitor');
        expect(usptoPtabConnector.status).toBe('active');
    });

    it('a missing credential fails preflight naming the option, before any network call', () => {
        expect(() => resolve({})).toThrow(FatalConfigError);
        expect(() => resolve({})).toThrow(/Source "uspto_ptab" requires option\(s\): usptoOdpApiKey/);
        expect(() => resolve({ uspto_ptab: {} })).toThrow(/requires option\(s\): usptoOdpApiKey/);
    });

    it('a blank or whitespace-only credential counts as missing', () => {
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: '' } })).toThrow(/requires option\(s\): usptoOdpApiKey/);
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: '    ' } })).toThrow(/requires option\(s\): usptoOdpApiKey/);
    });

    it('accepts a credential and trims it', () => {
        const [resolved] = resolve({ uspto_ptab: { usptoOdpApiKey: `  ${KEY}  ` } });
        expect(resolved!.options.usptoOdpApiKey).toBe(KEY);
        expect(resolved!.options.trialTypeCodes).toEqual([]);
        expect(resolved!.options.dateRange).toBeUndefined();
    });

    it('rejects an unknown option key so a copied-over legacy option fails loudly', () => {
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: KEY, onlyNew: true } })).toThrow(/Invalid options for "uspto_ptab".*onlyNew|Unrecognized key/);
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: KEY, maxItemsPerSource: 10 } })).toThrow(FatalConfigError);
    });

    it('upper-cases trial type codes and rejects unknown ones', () => {
        expect(usptoPtabOptionsSchema.parse({ trialTypeCodes: ['ipr', ' Pgr '] }).trialTypeCodes).toEqual(['IPR', 'PGR']);
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: KEY, trialTypeCodes: ['XYZ'] } })).toThrow(/trialTypeCodes/);
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: KEY, trialTypeCodes: 'IPR' } })).toThrow(/trialTypeCodes/);
    });

    it('accepts the shared date-range vocabulary and rejects anything else', () => {
        for (const dateRange of ['24h', '7d', '30d', '90d', '365d']) expect(usptoPtabOptionsSchema.parse({ dateRange }).dateRange).toBe(dateRange);
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: KEY, dateRange: '2y' } })).toThrow(/dateRange/);
    });

    it('a non-string credential is a schema error that does not echo the value', () => {
        expect(() => resolve({ uspto_ptab: { usptoOdpApiKey: 12345678 } })).toThrow(/usptoOdpApiKey/);
        try {
            resolve({ uspto_ptab: { usptoOdpApiKey: 12345678 } });
        } catch (error) {
            expect((error as Error).message).not.toContain('12345678');
        }
    });
});

describe('end to end through the real router', () => {
    const input = (extra: Record<string, unknown> = {}) => ({
        sources: ['uspto_ptab'],
        sourceOptions: { uspto_ptab: { usptoOdpApiKey: KEY } },
        deltaMode: 'onlyChanged',
        ...extra,
    });
    const serve = (data: unknown) => () => data;

    it('first run emits every proceeding as first_seen with engine / source / record_id from the router and the legacy field names kept', async () => {
        const result = await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(page)));
        expect(result.rows).toHaveLength(3);
        const row = result.rows.find((r) => r.record_id === 'IPR2024-00123')!;
        expect(row).toMatchObject({
            engine: 'global-corporate-patent-intelligence',
            source: 'uspto_ptab',
            delta_status: 'first_seen',
            is_new: true,
            trialNumber: 'IPR2024-00123',
            patentOwnerName: 'Acme Widgets Inc.',
            petitionerRealPartyInInterestName: 'Globex Corp',
            recipient_or_defendant_name: 'Acme Widgets Inc.',
            jurisdiction: 'US',
            is_watchlist_match: false,
            matched_watchlist_keyword: null,
        });
        expect(result.billing.totalFor(RESULT_EVENT)).toBe(3);
        expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
    });

    it('delta memory: an unchanged second run emits nothing; a status change re-emits that one trial as updated', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(page)), store);

        const second = await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(page)), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 3, unchanged: 3, emitted: 0 });

        const changed = structuredClone(page);
        changed.patentTrialProceedingDataBag[0].trialMetaData.trialStatusCategory = 'FWD Entered';
        const third = await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(changed)), store);
        expect(third.rows).toHaveLength(1);
        expect(third.rows[0]).toMatchObject({ record_id: 'IPR2024-00123', delta_status: 'updated', is_new: false, trialStatusCategory: 'FWD Entered', status_or_estado: 'FWD Entered' });
    });

    it('a newly set terminationDate is an update, a bare "last modified" bump is not', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(page)), store);

        const touched = structuredClone(page);
        touched.patentTrialProceedingDataBag[0].trialMetaData.trialLastModifiedDateTime = '2030-01-01T00:00:00Z';
        expect((await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(touched)), store)).rows).toHaveLength(0);

        const terminated = structuredClone(page);
        terminated.patentTrialProceedingDataBag[0].trialMetaData.terminationDate = '2026-10-01';
        const result = await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(terminated)), store);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({ record_id: 'IPR2024-00123', delta_status: 'updated', terminationDate: '2026-10-01' });
    });

    it('deltaMode "all" re-emits unchanged trials', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(usptoPtabConnector, input(), makeCtx(serve(page)), store);
        const all = await runThroughRouter(usptoPtabConnector, input({ deltaMode: 'all' }), makeCtx(serve(page)), store);
        expect(all.rows).toHaveLength(3);
        expect(all.rows.every((r) => r.delta_status === 'unchanged')).toBe(true);
    });

    it('the engine-level maxItemsPerSource reaches the connector as its page budget', async () => {
        const stub = makeCtx(pagedServer(Array.from({ length: 50 }, (_, i) => proceeding(i + 1))));
        const result = await runThroughRouter(usptoPtabConnector, input({ maxItemsPerSource: 7 }), stub);
        expect(result.rows).toHaveLength(7);
        expect(stub.requests[0]!.json.pagination.limit).toBe(7);
    });

    it('the watchlist matches owner AND petitioner entity names and bills one watchlist-hit per matched row', async () => {
        const result = await runThroughRouter(usptoPtabConnector, input({ watchlistNames: ['acme', 'umbrella research'] }), makeCtx(serve(page)));
        const matched = result.rows.filter((r) => r.is_watchlist_match);
        expect(matched.map((r) => [r.record_id, r.matched_watchlist_keyword])).toEqual([
            ['IPR2024-00123', 'acme'],
            ['DER2025-00007', 'umbrella research'],
        ]);
        expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(2);

        const byPetitioner = await runThroughRouter(usptoPtabConnector, input({ watchlistNames: ['Globex'] }), makeCtx(serve(page)));
        expect(byPetitioner.rows.filter((r) => r.is_watchlist_match).map((r) => r.record_id)).toEqual(['IPR2024-00123']);
    });

    it('ghost-billing guard: empty, blank and one-letter watchlists match nothing and bill nothing', async () => {
        for (const watchlistNames of [[''], [' '], ['a'], '', ' ', [], undefined, null, 42]) {
            const result = await runThroughRouter(usptoPtabConnector, input({ watchlistNames }), makeCtx(serve(page)));
            expect(result.rows).toHaveLength(3);
            expect(result.rows.some((r) => r.is_watchlist_match)).toBe(false);
            expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('a missing credential aborts the whole run in preflight, with no request and no billing', async () => {
        const stub = makeCtx(serve(page));
        await expect(runThroughRouter(usptoPtabConnector, { sources: ['uspto_ptab'] }, stub)).rejects.toThrow(/requires option\(s\): usptoOdpApiKey/);
        expect(stub.requests).toHaveLength(0);
    });

    it('an upstream failure is isolated to the source: the run completes and the summary carries the error', async () => {
        const stub = makeCtx(() => new HttpStatusError(PTAB_SEARCH_URL, 403, '{"message":"Forbidden"}'));
        const result = await runThroughRouter(usptoPtabConnector, input(), stub);
        expect(result.rows).toHaveLength(0);
        expect(result.summary.sources[0]!.error).toMatch(/HTTP 403/);
        expect(result.summary.sources[0]!.error).not.toContain(KEY);
        for (const line of stub.allLogLines()) expect(line).not.toContain(KEY);
    });
});
