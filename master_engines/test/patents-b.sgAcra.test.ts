/**
 * sg_acra connector tests.
 *
 * Fixtures (test/fixtures/patents-b/acra_*.json, no network) are REAL data.gov.sg `datastore_search` responses for shard W,
 * captured on 2026-10-21, each the answer to the exact URL this connector's `buildAcraUrl` produces. The legacy actor
 * (singapore-acra-registry-monitor) is README-only, so there is no legacy test directory to copy from; the README's own
 * sample (UEN 190700013E "53, MARKET STREET, Singapore 0104", primary_ssic_description null, no_of_officers "0") is reproduced
 * by a live row here. Hand-built rows are labelled SYNTHETIC where used.
 */
import { describe, expect, it } from 'vitest';

import {
    ACRA_COLLECTION_VIEW_URL,
    ACRA_MAX_QUERIES,
    ACRA_SHARD_DATASETS,
    ACRA_SHARDS,
    buildAcraUrl,
    buildRegisteredAddress,
    cleanEntityNameForQuery,
    fetchAcraRows,
    matchesSsicPrefix,
    naToNull,
    normaliseShard,
    normalizeAcraRow,
    parseDatastorePage,
    resolveEntityNames,
    resolveSsicPrefixes,
    SG_ACRA_SOURCE_ID,
    sgAcraConnector,
    sgAcraOptionsSchema,
} from '../global-corporate-patent-intelligence/connectors/sgAcra.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { createEngineHarness, createStubHttp, fixtureJson, httpError, logsAt, makeCtx, must, ROUTER_OWNED_KEYS } from './patents-b.helpers.js';

const SOURCE_ID = SG_ACRA_SOURCE_ID;
const run = (maxItemsPerSource: number): RunParams => ({ maxItemsPerSource });
const parseOptions = (input: unknown = {}) => sgAcraOptionsSchema.parse(input);

const W = ACRA_SHARD_DATASETS.W;
const P1_URL = buildAcraUrl({ datasetId: W, limit: 2, offset: 0 });
const P2_URL = buildAcraUrl({ datasetId: W, limit: 2, offset: 2 });
const P3_URL = buildAcraUrl({ datasetId: W, limit: 2, offset: 4 });
const WEE_URL = buildAcraUrl({ datasetId: W, limit: 6, offset: 0, entityName: 'Wee Brothers' });
const STRUCK1_URL = buildAcraUrl({ datasetId: W, limit: 1, offset: 0, statuses: ['Struck Off'] });
const NONE_URL = buildAcraUrl({ datasetId: W, limit: 1000, offset: 0, entityName: 'Zzzzqqqq' });

const P1 = fixtureJson('acra_p1.json');
const WEE = fixtureJson('acra_wee.json');
const weeRows = parseDatastorePage(WEE).rows;
const steamship = must(weeRows.find((row) => row.uen === '190700013E'));

/** The README's own gateway-quirk body, captured live for an apostrophe in `q` (HTTP 200, no `success` key). */
const GATEWAY_QUIRK_BODY = '{"headers":{"Access-Control-Allow-Origin":"*","Content-Type":"application/json"}}';

describe('options schema', () => {
    it('defaults to shard A (the legacy README default) with a 10-page scan cap', () => {
        const options = parseOptions();
        expect(options.shardSelection).toEqual(['A']);
        expect(options.maxPages).toBe(10);
        expect(options.entityNames).toBeUndefined();
        expect(options.entityStatusFilter).toBeUndefined();
        expect(options.ssicCodeFilter).toBeUndefined();
    });

    it('normalises shard spellings (case, whitespace, Others) and de-duplicates', () => {
        expect(parseOptions({ shardSelection: ['w', ' W ', 'others', 'Others', 'a'] }).shardSelection).toEqual(['W', 'Others', 'A']);
        expect(normaliseShard('q')).toBe('Q');
        expect(normaliseShard('OTHERS')).toBe('Others');
        expect(normaliseShard(5)).toBe(5);
    });

    it('rejects an unknown shard, an empty selection, out-of-range maxPages and unknown keys', () => {
        expect(sgAcraOptionsSchema.safeParse({ shardSelection: ['AA'] }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ shardSelection: ['1'] }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ shardSelection: [] }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ maxPages: 0 }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ maxPages: 201 }).success).toBe(false);
        expect(parseOptions({ maxPages: null }).maxPages).toBe(10);
        // The BYOK Business Profile tier and the delivery knobs are not part of this connector; they fail loudly instead of being ignored.
        expect(sgAcraOptionsSchema.safeParse({ watchlistUens: ['190700013E'] }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ acraBusinessProfileApiKey: 'x' }).success).toBe(false);
        expect(sgAcraOptionsSchema.safeParse({ onlyNew: true }).success).toBe(false);
    });

    it('requires NO credential (the BYOK ACRA Business Profile tier is deliberately not ported), and preflight accepts a bare selection', () => {
        expect(sgAcraConnector.requiredOptions).toBeUndefined();
        expect(sgAcraConnector.status).toBe('active');
        const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [sgAcraConnector] };
        expect(resolveSources(engine, EngineInputSchema.parse({ sources: [SOURCE_ID] }))).toHaveLength(1);
    });

    it('reports an invalid slice at preflight, naming the source (FatalConfigError before any network call)', () => {
        const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [sgAcraConnector] };
        const input = EngineInputSchema.parse({ sources: [SOURCE_ID], sourceOptions: { [SOURCE_ID]: { shardSelection: ['AA'] } } });
        expect(() => resolveSources(engine, input)).toThrow(FatalConfigError);
        expect(() => resolveSources(engine, input)).toThrow(/Invalid options for "sg_acra"/);
    });

    it('is registered for the patent engine under the repository name of the legacy actor', () => {
        expect(sgAcraConnector.engine).toBe('global-corporate-patent-intelligence');
        expect(sgAcraConnector.legacyActor).toBe('singapore-acra-registry-monitor');
        expect(sgAcraConnector.id).toBe('sg_acra');
        expect(sgAcraConnector.maxSeenIds).toBeGreaterThanOrEqual(10_000);
    });

    it('maps all 27 shards (A-Z + Others) to distinct data.gov.sg dataset ids', () => {
        expect(ACRA_SHARDS).toHaveLength(27);
        const ids = ACRA_SHARDS.map((shard) => ACRA_SHARD_DATASETS[shard]);
        expect(new Set(ids).size).toBe(27);
        for (const id of ids) expect(id).toMatch(/^d_[0-9a-f]{32}$/);
        expect(ACRA_SHARD_DATASETS.W).toBe('d_af2042c77ffaf0db5d75561ce9ef5688');
    });
});

describe('datastore page parsing (live captures)', () => {
    it('reads rows and total from a real page', () => {
        const page = parseDatastorePage(P1);
        expect(page.total).toBe(58_040);
        expect(page.rows.map((r) => r.uen)).toEqual(['202558262R', '202645117H']);
    });

    it('rejects the gateway quirk (HTTP 200 without `success`) as an upstream failure, never as zero records', () => {
        expect(() => parseDatastorePage(JSON.parse(GATEWAY_QUIRK_BODY))).toThrow(/no "success: true"/);
        expect(() => parseDatastorePage(JSON.parse(GATEWAY_QUIRK_BODY))).toThrow(/body starts \{"headers"/);
    });

    it('rejects a CKAN-style failure body, quoting the upstream error (SYNTHETIC body)', () => {
        expect(() => parseDatastorePage({ success: false, error: { __type: 'Validation Error', records: ['Size of row data too large.'] } })).toThrow(
            /Validation Error/,
        );
        expect(() => parseDatastorePage('not json')).toThrow(/no "success: true"/);
        expect(() => parseDatastorePage(null)).toThrow(/no "success: true"/);
        expect(() => parseDatastorePage({ success: true, result: {} })).toThrow(/no "result.records" array/);
    });

    it('an empty result is a legal page (captured `total: 0`)', () => {
        expect(parseDatastorePage(fixtureJson('acra_none.json'))).toEqual({ rows: [], total: 0 });
    });
});

describe('normalisation (live rows)', () => {
    it('reproduces the README sample for UEN 190700013E exactly (including the genuinely-null primary_ssic_description)', () => {
        const record = must(normalizeAcraRow(steamship, 'W'));
        expect(record.recordId).toBe('190700013E');
        expect(record.payload).toMatchObject({
            '@type': 'schema:Organization',
            uen: '190700013E',
            entity_name: 'WEE BROTHERS STEAMSHIP COMPANY LIMITED',
            entity_type_description: 'Local Company',
            entity_status_description: 'Struck Off',
            registration_incorporation_date: '1907-12-30',
            uen_issue_date: '1907-12-30',
            registered_address: '53, MARKET STREET, Singapore 0104',
            primary_ssic_code: '96099',
            primary_ssic_description: null,
            secondary_ssic_code: null,
            secondary_ssic_description: null,
            no_of_officers: '0',
            former_entity_names: [],
            audit_firm_names: [],
            shard: 'W',
            source_url: ACRA_COLLECTION_VIEW_URL,
        });
        expect(record.payload.status_fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(record.payload.content_fingerprint).toMatch(/^[0-9a-f]{20}$/);
        for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
    });

    it('never leaks the datastore pseudo-columns (`_id`, `rank entity_name`, `_full_count`) or source-only columns into the payload', () => {
        expect(steamship).toHaveProperty('rank entity_name');
        expect(steamship).toHaveProperty('_full_count');
        const keys = Object.keys(must(normalizeAcraRow(steamship, 'W')).payload);
        for (const key of ['_id', 'rank entity_name', '_full_count', 'account_due_date', 'annual_return_date', 'issuance_agency_id']) {
            expect(keys).not.toContain(key);
        }
        expect(keys).toEqual([
            '@type',
            'uen',
            'entity_name',
            'entity_type_description',
            'entity_status_description',
            'registration_incorporation_date',
            'uen_issue_date',
            'registered_address',
            'primary_ssic_code',
            'primary_ssic_description',
            'secondary_ssic_code',
            'secondary_ssic_description',
            'no_of_officers',
            'former_entity_names',
            'audit_firm_names',
            'status_fingerprint',
            'content_fingerprint',
            'shard',
            'source_url',
        ]);
    });

    it('keeps primary / secondary SSIC code and description independent (WEE LIM BROTHERS ENTERPRISE has a description but no secondary code)', () => {
        const row = must(weeRows.find((r) => r.uen === '53454525D'));
        expect(must(normalizeAcraRow(row, 'W')).payload).toMatchObject({
            primary_ssic_code: '46302',
            primary_ssic_description: 'WHOLESALE OF OTAH AND OTHER FROZEN PRODUCTS',
            secondary_ssic_code: null,
            secondary_ssic_description: 'WHOLESALE OF OTAH AND OTHER FROZEN PRODUCTS',
        });
    });

    it('builds the registered address from block, street, #level-unit, building and Singapore postal code', () => {
        const addressOf = (uen: string) => buildRegisteredAddress(must(parseDatastorePage(WEE).rows.find((r) => r.uen === uen)));
        expect(addressOf('190700013E')).toBe('53, MARKET STREET, Singapore 0104');
        expect(addressOf('202302727R')).toBe('118, HOUGANG AVENUE 1, #04-1182, Singapore 530118');
        expect(addressOf('52862605A')).toBe('5, JASMINE ROAD, ADELPHI PARK ESTATE, Singapore 576580');
        expect(buildRegisteredAddress(must(parseDatastorePage(P1).rows[0]))).toBe('73, UPPER PAYA LEBAR ROAD, #07-01, CENTRO BIANCO, Singapore 534818');
    });

    it('address edge cases (SYNTHETIC rows): all "na" -> null, only a unit, and a non-LOCAL address gets no "Singapore" prefix', () => {
        expect(buildRegisteredAddress({ block: 'na', street_name: 'na', postal_code: 'na', address_type: 'LOCAL' })).toBeNull();
        expect(buildRegisteredAddress({ street_name: 'ORCHARD ROAD', unit_no: '12', postal_code: '238888', address_type: 'LOCAL' })).toBe('ORCHARD ROAD, #12, Singapore 238888');
        expect(buildRegisteredAddress({ other_address_line1: '1 EXAMPLE STREET', other_address_line2: 'ELSEWHERE', postal_code: '12345', address_type: 'OVERSEAS' })).toBe(
            '1 EXAMPLE STREET, ELSEWHERE, 12345',
        );
    });

    it('naToNull maps the literal "na" (any case), blanks and non-text to null, and trims real text', () => {
        expect(naToNull('na')).toBeNull();
        expect(naToNull(' NA ')).toBeNull();
        expect(naToNull('')).toBeNull();
        expect(naToNull('   ')).toBeNull();
        expect(naToNull(null)).toBeNull();
        expect(naToNull({})).toBeNull();
        expect(naToNull('  PUBLISHING   BOOKS ')).toBe('PUBLISHING BOOKS');
        expect(naToNull(0)).toBe('0');
        expect(naToNull('Nagoya')).toBe('Nagoya');
    });

    it('watchText = entity name + former names (SYNTHETIC former names added to a live row)', () => {
        expect(must(normalizeAcraRow(steamship, 'W')).watchText).toBe('WEE BROTHERS STEAMSHIP COMPANY LIMITED');
        const withFormer = must(normalizeAcraRow({ ...steamship, former_entity_name1: 'WEE STEAMSHIP LTD', former_entity_name2: 'na', former_entity_name3: 'WEE BROS' }, 'W'));
        expect(withFormer.watchText).toBe('WEE BROTHERS STEAMSHIP COMPANY LIMITED | WEE STEAMSHIP LTD | WEE BROS');
        expect(withFormer.payload.former_entity_names).toEqual(['WEE STEAMSHIP LTD', 'WEE BROS']);
    });

    it('collects audit firm names (SYNTHETIC) and skips rows without a UEN', () => {
        const record = must(normalizeAcraRow({ ...steamship, name_of_audit_firm1: 'EXAMPLE LLP', name_of_audit_firm2: 'na', name_of_audit_firm3: 'SAMPLE & CO' }, 'W'));
        expect(record.payload.audit_firm_names).toEqual(['EXAMPLE LLP', 'SAMPLE & CO']);
        expect(normalizeAcraRow({ ...steamship, uen: 'na' }, 'W')).toBeNull();
        expect(normalizeAcraRow({ entity_name: 'NO UEN' }, 'W')).toBeNull();
    });

    it('recordId is the upper-case UEN: stable across re-parsing, shard order and letter case', () => {
        const a = must(normalizeAcraRow(steamship, 'W'));
        const again = must(normalizeAcraRow(JSON.parse(JSON.stringify(steamship)), 'W'));
        const lower = must(normalizeAcraRow({ ...steamship, uen: ' 190700013e ' }, 'W'));
        expect(again.recordId).toBe(a.recordId);
        expect(lower.recordId).toBe('190700013E');
        expect(again.fingerprint).toBe(a.fingerprint);
        expect(weeRows.map((r) => must(normalizeAcraRow(r, 'W')).recordId)).toEqual(['202302727R', '53454525D', '52862605A', '23783000X', '00462600A', '190700013E']);
    });

    it('fingerprint changes iff a consumer-visible field changes; status and content fingerprints answer different questions (SYNTHETIC edits of a live row)', () => {
        const base = must(normalizeAcraRow(steamship, 'W'));
        const edit = (patch: Record<string, unknown>) => must(normalizeAcraRow({ ...steamship, ...patch }, 'W'));

        const status = edit({ entity_status_description: 'Live Company' });
        expect(status.fingerprint).not.toBe(base.fingerprint);
        expect(status.payload.status_fingerprint).not.toBe(base.payload.status_fingerprint);
        expect(status.payload.content_fingerprint).toBe(base.payload.content_fingerprint);

        for (const patch of [
            { entity_name: 'WEE BROTHERS SHIPPING LIMITED' },
            { no_of_officers: '2' },
            { block: '55' },
            { postal_code: '0105' },
            { primary_ssic_code: '50111' },
            { secondary_ssic_description: 'SEA TRANSPORT' },
            { former_entity_name1: 'OLD NAME PTE LTD' },
            { name_of_audit_firm1: 'AN AUDIT LLP' },
            { entity_type_description: 'Foreign Company' },
        ]) {
            const changed = edit(patch);
            expect(changed.fingerprint, JSON.stringify(patch)).not.toBe(base.fingerprint);
            expect(changed.payload.content_fingerprint, JSON.stringify(patch)).not.toBe(base.payload.content_fingerprint);
            expect(changed.payload.status_fingerprint, JSON.stringify(patch)).toBe(base.payload.status_fingerprint);
        }

        // Not consumer-visible, so not a change: datastore pseudo-columns, the annual-filing dates, whitespace, "na" vs blank.
        for (const patch of [
            { _id: 999_999, 'rank entity_name': 0.5, _full_count: '1' },
            { account_due_date: '2030-12-31', annual_return_date: '2030-06-30' },
            { entity_name: '  WEE BROTHERS   STEAMSHIP COMPANY LIMITED ' },
            { secondary_ssic_code: '' },
            { former_entity_name1: 'NA' },
        ]) {
            expect(edit(patch).fingerprint, JSON.stringify(patch)).toBe(base.fingerprint);
        }
    });

    it('SSIC prefix matching looks at the primary AND the secondary code and never matches on an empty prefix', () => {
        const fibreglass = must(weeRows.find((r) => r.uen === '23783000X')); // primary 31004, secondary 46542
        expect(matchesSsicPrefix(fibreglass, ['31'])).toBe(true);
        expect(matchesSsicPrefix(fibreglass, ['46'])).toBe(true);
        expect(matchesSsicPrefix(fibreglass, ['465'])).toBe(true);
        expect(matchesSsicPrefix(fibreglass, ['62'])).toBe(false);
        expect(matchesSsicPrefix(fibreglass, [''])).toBe(false);
        expect(matchesSsicPrefix(steamship, ['46'])).toBe(false);
    });
});

describe('keyword guard', () => {
    it("entityNames ['', ' ', 'a'] leaves NO name: the request has no `q` at all, and a warning says so", async () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        expect(resolveEntityNames(ctx, ['', ' ', 'a'])).toEqual([]);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/NO entityNames filtering is applied/);

        const { http, calls } = createStubHttp({ [P1_URL]: P1 });
        const { ctx: runCtx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(runCtx, parseOptions({ shardSelection: ['W'], entityNames: ['', ' ', 'a'] }), run(2));
        expect(calls.map((c) => c.url)).toEqual([P1_URL]);
        expect(P1_URL).not.toContain('q=');
        expect(records).toHaveLength(2);
    });

    it("entityNames ['  Wee Brothers  '] is normalised and reaches data.gov.sg as a per-column JSON `q` (the captured request)", async () => {
        const { http, calls } = createStubHttp({ [WEE_URL]: WEE });
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityNames: ['  Wee Brothers  '] }), run(6));
        expect(calls.map((c) => c.url)).toEqual([WEE_URL]);
        expect(WEE_URL).toBe(
            `https://data.gov.sg/api/action/datastore_search?resource_id=d_af2042c77ffaf0db5d75561ce9ef5688&limit=6&sort=registration_incorporation_date%20desc%2C%20uen%20asc&q=%7B%22entity_name%22%3A%22Wee%20Brothers%22%7D`,
        );
        expect(records).toHaveLength(6);
    });

    it('a bare string is split on separators and a malformed container is no filter; an apostrophe-only name cannot become a blank query', () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        expect(resolveEntityNames(ctx, 'Wee Brothers; Acme Holdings')).toEqual(['Wee Brothers', 'Acme Holdings']);
        expect(resolveEntityNames(ctx, 'a')).toEqual([]);
        expect(resolveEntityNames(ctx, 7)).toEqual([]);
        expect(resolveEntityNames(ctx, [null, {}, 5])).toEqual([]);
        // "''" and "'a'" are rejected by the guard itself (no letter, one letter); "O Brien" passes it as a different string from "O'Brien" but is the SAME name once the apostrophe goes.
        expect(resolveEntityNames(ctx, ["O'Brien", 'O Brien', "''", "'a'"])).toEqual(['O Brien']);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/1 keyword\(s\) were empty or duplicated after apostrophe removal/);
        expect(cleanEntityNameForQuery("O'Brien ’s `x`")).toBe('O Brien s x');
    });

    it("ssicCodeFilter ['', ' ', '6', 'ab'] leaves NO prefix (so nothing is filtered), while ['62', ' 5611 '] are kept", () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        expect(resolveSsicPrefixes(ctx, ['', ' ', '6', 'ab'])).toEqual([]);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/NO SSIC filtering is applied/);
        expect(resolveSsicPrefixes(ctx, ['62', ' 5611 '])).toEqual(['62', '5611']);
        expect(resolveSsicPrefixes(ctx, '62, 47')).toEqual(['62', '47']);
        expect(resolveSsicPrefixes(ctx, ['62', 'x1', '123456'])).toEqual(['62']);
        expect(resolveSsicPrefixes(ctx, undefined)).toEqual([]);
    });

    it("entityStatusFilter ['', ' '] sends no `filters` (not `filters: {status: ['']}`, which would match nothing); ['  Struck Off  '] is normalised", async () => {
        const { http, calls } = createStubHttp({ [P1_URL]: P1, [STRUCK1_URL]: fixtureJson('acra_struck1.json') });
        const { ctx } = makeCtx(http);
        await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityStatusFilter: ['', ' '] }), run(2));
        expect(calls[0]?.url).toBe(P1_URL);
        expect(calls[0]?.url).not.toContain('filters=');

        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityStatusFilter: ['  Struck Off  '] }), run(1));
        expect(calls[1]?.url).toBe(STRUCK1_URL);
        expect(STRUCK1_URL).toContain('filters=%7B%22entity_status_description%22%3A%5B%22Struck%20Off%22%5D%7D');
        expect(records.map((r) => r.payload.entity_status_description)).toEqual(['Struck Off']);
    });

    it('an SSIC filter that sanitises to nothing does not discard any row', async () => {
        const { http } = createStubHttp({ [P1_URL]: P1 });
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], ssicCodeFilter: ['', ' ', '8'] }), run(2));
        expect(records).toHaveLength(2);
    });
});

describe('request building', () => {
    it('builds the captured request URLs exactly', () => {
        expect(P1_URL).toBe(
            'https://data.gov.sg/api/action/datastore_search?resource_id=d_af2042c77ffaf0db5d75561ce9ef5688&limit=2&sort=registration_incorporation_date%20desc%2C%20uen%20asc',
        );
        expect(P2_URL).toBe(`${P1_URL.replace('&limit=2', '&limit=2&offset=2')}`);
        expect(P3_URL).toContain('&limit=2&offset=4&');
    });

    it('never sends `filters` together with `q` (data.gov.sg silently ignores `filters` beside `q`)', () => {
        const url = buildAcraUrl({ datasetId: W, limit: 5, offset: 0, entityName: 'Wee Brothers', statuses: ['Struck Off'] });
        expect(url).toContain('q=');
        expect(url).not.toContain('filters=');
    });

    it('sorts newest registration first with the UEN as a tie-breaker, so offset paging is deterministic', () => {
        expect(decodeURIComponent(P1_URL)).toContain('sort=registration_incorporation_date desc, uen asc');
    });
});

describe('fetching', () => {
    it('walks offset pages until maxItems (captured pages 1-3, page size 2 via the test hook)', async () => {
        const { http, calls } = createStubHttp({
            [P1_URL]: P1,
            [P2_URL]: fixtureJson('acra_p2.json'),
            [P3_URL]: fixtureJson('acra_p3.json'),
        });
        const { ctx } = makeCtx(http);
        const rows = await fetchAcraRows(ctx, { shard: 'W', maxItems: 6, maxPages: 10, pageLimit: 2 });
        expect(rows.map((r) => r.uen)).toEqual(['202558262R', '202645117H', '53532978D', '53533010C', '202644843H', '202644901K']);
        expect(calls.map((c) => c.url)).toEqual([P1_URL, P2_URL, P3_URL]);
    });

    it('newest registrations come first (the capture is sorted by registration date, descending)', async () => {
        const { http } = createStubHttp({ [P1_URL]: P1, [P2_URL]: fixtureJson('acra_p2.json'), [P3_URL]: fixtureJson('acra_p3.json') });
        const { ctx } = makeCtx(http);
        const rows = await fetchAcraRows(ctx, { shard: 'W', maxItems: 6, maxPages: 10, pageLimit: 2 });
        const dates = rows.map((r) => String(r.registration_incorporation_date));
        expect([...dates].sort().reverse()).toEqual(dates);
        expect(dates[0]).toBe('2026-09-30');
    });

    it('honours maxItemsPerSource: asks for exactly that many rows and stops', async () => {
        const { http, calls } = createStubHttp({ [P1_URL]: P1 });
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'] }), run(2));
        expect(records.map((r) => r.recordId)).toEqual(['202558262R', '202645117H']);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain('limit=2');
    });

    it('stops at a short page and when the offset reaches the reported total', async () => {
        const total3 = { ...fixtureJson('acra_p1.json') };
        total3.result = { ...total3.result, total: 2 };
        const { http, calls } = createStubHttp({}, () => total3);
        const { ctx } = makeCtx(http);
        const rows = await fetchAcraRows(ctx, { shard: 'W', maxItems: 100, maxPages: 10, pageLimit: 2 });
        expect(rows).toHaveLength(2); // a full page, but offset 2 >= total 2 -> no second request
        expect(calls).toHaveLength(1);

        const short = createStubHttp({}, () => fixtureJson('acra_wee.json'));
        const { ctx: shortCtx } = makeCtx(short.http);
        const weeAll = await fetchAcraRows(shortCtx, { shard: 'W', maxItems: 100, maxPages: 10, entityName: 'Wee Brothers' });
        expect(weeAll).toHaveLength(6);
        expect(short.calls).toHaveLength(1); // 6 rows < the 100 requested: the last page
    });

    it('with an SSIC filter it reads full pages, keeps only matching rows, and maxPages bounds the scan', async () => {
        const { http, calls } = createStubHttp({ [P1_URL]: P1, [P2_URL]: fixtureJson('acra_p2.json'), [P3_URL]: fixtureJson('acra_p3.json') });
        const { ctx } = makeCtx(http);
        const none = await fetchAcraRows(ctx, { shard: 'W', maxItems: 10, maxPages: 2, ssicPrefixes: ['99'], pageLimit: 2 });
        expect(none).toEqual([]);
        expect(calls.map((c) => c.url)).toEqual([P1_URL, P2_URL]); // two pages, then the cap

        const hit = await fetchAcraRows(ctx, { shard: 'W', maxItems: 10, maxPages: 3, ssicPrefixes: ['5611', '4647'], pageLimit: 2 });
        expect(hit.map((r) => r.uen)).toEqual(['53533010C', '202644843H']); // 46473 WORLD OF STATIONERY, 56111 WK FISH SOUP (secondary 56140 is irrelevant)
    });

    it('searches entity names server-side and returns the empty capture without error', async () => {
        const { http, calls } = createStubHttp({ [NONE_URL]: fixtureJson('acra_none.json') });
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityNames: ['Zzzzqqqq'] }), run(1000));
        expect(records).toEqual([]);
        expect(calls.map((c) => c.url)).toEqual([NONE_URL]);
    });

    it('applies the status filter CLIENT-side when entity names are searched (live: `filters` is ignored beside `q`)', async () => {
        const { http, calls } = createStubHttp({}, (url) => (url.includes('q=') ? WEE : undefined));
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(
            ctx,
            parseOptions({ shardSelection: ['W'], entityNames: ['Wee Brothers'], entityStatusFilter: ['Struck Off'] }),
            run(6),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).not.toContain('filters=');
        expect(records.map((r) => r.recordId)).toEqual(['190700013E']);
        // The comparison is exact and case-sensitive, matching what the server-side filter does.
        const lower = await sgAcraConnector.fetch(
            ctx,
            parseOptions({ shardSelection: ['W'], entityNames: ['Wee Brothers'], entityStatusFilter: ['struck off'] }),
            run(6),
        );
        expect(lower).toEqual([]);
    });

    it('applies an SSIC filter on top of a name search (SSIC 46 matches the primary of one entity and the secondary of another)', async () => {
        const { http } = createStubHttp({}, (url) => (url.includes('q=') ? WEE : undefined));
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityNames: ['Wee Brothers'], ssicCodeFilter: ['46'] }), run(6));
        expect(records.map((r) => r.recordId).sort()).toEqual(['23783000X', '53454525D']);
    });

    it('shares maxItemsPerSource between shard x name queries and de-duplicates across them (route-level replay of the captures)', async () => {
        const { http, calls } = createStubHttp({}, (url) => (url.includes('q=') ? WEE : P1));
        const { ctx } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'], entityNames: ['Wee Brothers', 'Brothers Wee'] }), run(6));
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url).toContain('limit=3');
        expect(calls[1]?.url).toContain('limit=3'); // the first returned 6 rows (replay); 3 left -> share 3
        expect(new Set(records.map((r) => r.recordId)).size).toBe(records.length);
        expect(records.length).toBeLessThanOrEqual(6);
    });

    it('surfaces an upstream failure as a SourceFetchError naming the source, without retrying around a block', async () => {
        const { http, calls } = createStubHttp({ [P1_URL]: httpError(P1_URL, 403, '<title>Attention Required! | Cloudflare</title>') });
        const { ctx, logs } = makeCtx(http);
        const failure = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'] }), run(2)).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).source).toBe(SOURCE_ID);
        expect((failure as SourceFetchError).message).toMatch(/All selected shard queries failed: W: HTTP 403/);
        expect(calls).toHaveLength(1);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/W failed - HTTP 403/);
    });

    it('treats the gateway quirk body (HTTP 200 without `success`) as a failure of that query, never as "no entities"', async () => {
        const { http } = createStubHttp({ [P1_URL]: GATEWAY_QUIRK_BODY });
        const { ctx } = makeCtx(http);
        await expect(sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'] }), run(2))).rejects.toThrow(/no "success: true"/);
    });

    it('an unknown dataset (HTTP 404 text) is a failure', async () => {
        const { http } = createStubHttp({ [P1_URL]: httpError(P1_URL, 404, 'Resource not found') });
        const { ctx } = makeCtx(http);
        await expect(sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'] }), run(2))).rejects.toThrow(/HTTP 404/);
    });

    it('a failing shard does not discard a healthy one (warning logged); every shard failing is a SourceFetchError', async () => {
        const A_URL = buildAcraUrl({ datasetId: ACRA_SHARD_DATASETS.A, limit: 2, offset: 0 });
        // Shard A is queried first and fails; shard W then inherits the whole remaining budget (limit=4), which the
        // route-level replay answers with the live 2-row capture.
        const partial = createStubHttp({ [A_URL]: httpError(A_URL, 500, 'down') }, (url) => (url.includes(W) ? P1 : undefined));
        const { ctx, logs } = makeCtx(partial.http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W', 'A'] }), run(4));
        expect(partial.calls[1]?.url).toContain('limit=4');
        expect(records.map((r) => r.payload.shard)).toEqual(['W', 'W']);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/A failed - HTTP 500/);

        const both = createStubHttp({}, (url) => httpError(url, 500, 'down'));
        const { ctx: bothCtx } = makeCtx(both.http);
        await expect(sgAcraConnector.fetch(bothCtx, parseOptions({ shardSelection: ['W', 'A'] }), run(4))).rejects.toThrow(/All selected shard queries failed: A: HTTP 500 for .*: down \| W: HTTP 500 for /);
    });

    it('refuses a (shard x name) fan-out above the query budget before any request', async () => {
        const { http, calls } = createStubHttp({});
        const { ctx } = makeCtx(http);
        const options = parseOptions({ shardSelection: [...ACRA_SHARDS], entityNames: ['Alpha Holdings', 'Beta Holdings', 'Gamma Holdings'] });
        const failure = await sgAcraConnector.fetch(ctx, options, run(100)).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).message).toContain(`the limit is ${ACRA_MAX_QUERIES}`);
        expect(calls).toHaveLength(0);
    });

    it('rows without a UEN are skipped with a warning (SYNTHETIC row among live rows)', async () => {
        const body = JSON.parse(JSON.stringify(P1));
        body.result.records.push({ entity_name: 'NO UEN ROW', uen: 'na' });
        const { http } = createStubHttp({}, () => body);
        const { ctx, logs } = makeCtx(http);
        const records = await sgAcraConnector.fetch(ctx, parseOptions({ shardSelection: ['W'] }), run(3));
        expect(records).toHaveLength(2);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/1 row\(s\) skipped: no UEN/);
    });
});

describe('through the router (billing and delta, FakeBilling + InMemoryDeltaStore)', () => {
    const input = {
        sources: [SOURCE_ID],
        sourceOptions: { [SOURCE_ID]: { shardSelection: ['W'], entityNames: ['Wee Brothers'] } },
        maxItemsPerSource: 6,
    };

    it("watchlistNames ['', ' ', 'a'] bills ZERO watchlist-hit events (every entity name here contains an 'a')", async () => {
        const { http } = createStubHttp({ [WEE_URL]: WEE });
        const harness = createEngineHarness({ connectors: [sgAcraConnector], http });
        const summary = await harness.run({ ...input, watchlistNames: ['', ' ', 'a'] });
        expect(harness.rows).toHaveLength(6);
        expect(harness.rows.every((row) => row.is_watchlist_match === false)).toBe(true);
        expect(harness.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        expect(harness.billing.totalFor(RESULT_EVENT)).toBe(6);
        expect(summary.watchlist).toMatchObject({ accepted: 0, rejected: 3, hitsCharged: 0 });
    });

    it('a real watch name bills exactly one hit per flagged row, matching entity names and former names', async () => {
        const { http } = createStubHttp({ [WEE_URL]: WEE });
        const harness = createEngineHarness({ connectors: [sgAcraConnector], http });
        await harness.run({ ...input, watchlistNames: ['  steamship  '] });
        expect(harness.rows.filter((r) => r.is_watchlist_match).map((r) => r.record_id)).toEqual(['190700013E']);
        expect(harness.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);

        const all = createEngineHarness({ connectors: [sgAcraConnector], http });
        await all.run({ ...input, watchlistNames: ['wee brothers'] });
        expect(all.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(5); // "WEE LIM BROTHERS ENTERPRISE" does not contain the phrase
    });

    it('delta memory: first_seen, then nothing, then `updated` after a status change (SYNTHETIC status edit of a live capture)', async () => {
        const store = new InMemoryDeltaStore();
        let body: unknown = WEE;
        const { http } = createStubHttp({ [WEE_URL]: () => body as Record<string, unknown> });

        const first = createEngineHarness({ connectors: [sgAcraConnector], http, store });
        await first.run(input);
        expect(first.rows.map((r) => r.delta_status)).toEqual(Array(6).fill('first_seen'));
        expect(first.rows[0]).toMatchObject({ engine: 'global-corporate-patent-intelligence', source: SOURCE_ID, shard: 'W' });

        const second = createEngineHarness({ connectors: [sgAcraConnector], http, store });
        await second.run(input);
        expect(second.rows).toHaveLength(0);

        const edited = JSON.parse(JSON.stringify(WEE));
        const row = edited.result.records.find((r: Record<string, unknown>) => r.uen === '202302727R');
        row.entity_status_description = 'Struck Off';
        body = edited;
        const third = createEngineHarness({ connectors: [sgAcraConnector], http, store });
        await third.run(input);
        expect(third.rows).toHaveLength(1);
        expect(third.rows[0]).toMatchObject({ record_id: '202302727R', delta_status: 'updated', is_new: false, entity_status_description: 'Struck Off' });
        expect(third.rows[0]?.status_fingerprint).not.toBe(first.rows[0]?.status_fingerprint);
    });

    it('a failing connector never reaches billing: the run summary records the error and nothing is emitted', async () => {
        const { http } = createStubHttp({ [WEE_URL]: httpError(WEE_URL, 502, 'bad gateway') });
        const harness = createEngineHarness({ connectors: [sgAcraConnector], http });
        const summary = await harness.run({ ...input, watchlistNames: ['wee'] });
        expect(harness.rows).toHaveLength(0);
        expect(summary.sources[0]?.error).toMatch(/All selected shard queries failed/);
        expect(harness.billing.calls).toHaveLength(0);
    });
});
