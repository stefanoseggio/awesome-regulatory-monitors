/**
 * it_lombardia_grants connector tests.
 *
 * The legacy repo (regione-lombardia-grants-registry-monitor) is README-ONLY: it has no src/, no fixtures and no tests,
 * so there was nothing to copy. The fixture is therefore built from this port session's own live capture:
 *   test/fixtures/tenders-b/lombardia_bukx-h2uy_live_2026-10-21_excerpt.json = 8 of the 1,934 rows returned by
 *   GET https://www.dati.lombardia.it/resource/bukx-h2uy.json?$limit=5000&$order=codice_bando on 2026-10-21, selected to
 *   cover: two long-closed bandi, two open, two upcoming, one with NO closing date, one with no direzione_generale / ente.
 *   Every value is verbatim; absent keys are absent (Socrata omits null columns), not null.
 * Inline rows, the paging server and clocks below are SYNTHETIC and labelled where used. The derived-status edge cases
 * are this connector's reading of the README's one-line description (see the connector header), so those tests pin the
 * documented reading rather than a legacy behaviour.
 */
import { describe, expect, it } from 'vitest';

import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import {
    buildPageUrl,
    computeLombardiaStatus,
    fetchLombardiaGrants,
    itLombardiaGrantsConnector,
    itLombardiaGrantsOptionsSchema,
    LICENSE_NOTICE,
    LOMBARDIA_CRAWL_DELAY_MS,
    LOMBARDIA_RESOURCE_URL,
    type LombardiaRow,
    MAX_KEYWORD_QUERIES,
    normalizeRow,
    PAGE_LIMIT,
    socrataTimestampToIso,
    toSourceRecord,
    watchTextOf,
} from '../latam-global-tender-intelligence/connectors/itLombardiaGrants.js';
import { jsonFixture, LEGACY_DELTA_KEYS, makeCtx, ROUTER_OWNED_KEYS, type Responder, runThroughRouter } from './tenders-b.helpers.js';

const excerpt = jsonFixture<LombardiaRow[]>('lombardia_bukx-h2uy_live_2026-10-21_excerpt.json');
const byCode = (code: string): LombardiaRow => excerpt.find((r) => r.codice_bando === code) as LombardiaRow;

const NOW = new Date('2026-10-21T00:00:00Z');
const RUN: RunParams = { maxItemsPerSource: 500 };
const opts = (overrides: Record<string, unknown> = {}) => itLombardiaGrantsOptionsSchema.parse(overrides);
const noSleep = { sleep: async () => {} };

/** SYNTHETIC: a row opening on a distinct day so ordering is predictable. */
function synthRow(i: number, extra: Record<string, unknown> = {}): LombardiaRow {
    const day = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return { codice_bando: `T${String(i).padStart(5, '0')}`, titolo_bando: `Bando ${i}`, direzione_generale: 'PRESIDENZA', ente: 'Regione Lombardia', apertura_adesione: `${day}T00:00:00.000`, chiusura_adesione: `${day}T00:00:00.000`, tipo_strumento: 'Bando', presentato: '0', ...extra };
}

/** Serves one page of `all` (in code order) for the SODA URL, honouring `$limit` / `$offset` and `$q` (title substring, SYNTHETIC emulation). */
function sodaServer(all: LombardiaRow[]): Responder {
    return (request) => {
        const u = new URL(request.url);
        if (u.origin + u.pathname !== LOMBARDIA_RESOURCE_URL) return new Error(`unexpected request ${request.url}`);
        const q = u.searchParams.get('$q');
        const limit = Number(u.searchParams.get('$limit'));
        const offset = Number(u.searchParams.get('$offset'));
        const rows = [...all].sort((a, b) => (a.codice_bando < b.codice_bando ? -1 : 1)).filter((r) => !q || (r.titolo_bando ?? '').toLowerCase().includes(q.toLowerCase()));
        return rows.slice(offset, offset + limit);
    };
}

describe('timestamps', () => {
    it('reads Socrata\'s naive calendar_date values as UTC and passes zoned values through', () => {
        expect(socrataTimestampToIso('2026-03-21T00:00:00.000')).toBe('2026-03-21T00:00:00.000Z');
        expect(socrataTimestampToIso('2026-03-21T00:00:00')).toBe('2026-03-21T00:00:00.000Z');
        expect(socrataTimestampToIso('2026-03-21T10:00:00+02:00')).toBe('2026-03-21T08:00:00.000Z');
        expect(socrataTimestampToIso('2026-03-21T10:00:00Z')).toBe('2026-03-21T10:00:00.000Z');
        expect(socrataTimestampToIso('garbage')).toBeNull();
        expect(socrataTimestampToIso('')).toBeNull();
        expect(socrataTimestampToIso(null)).toBeNull();
        expect(socrataTimestampToIso(undefined)).toBeNull();
    });
});

describe('computeLombardiaStatus (the README\'s derived UPCOMING / OPEN / CLOSED)', () => {
    const open = '2026-10-01T00:00:00.000Z';
    const close = '2026-10-23T00:00:00.000Z';
    const at = (iso: string) => new Date(iso);

    it('UPCOMING before the opening date, OPEN from the opening date, CLOSED after the closing day', () => {
        expect(computeLombardiaStatus(open, close, at('2026-09-30T23:59:59Z'))).toBe('UPCOMING');
        expect(computeLombardiaStatus(open, close, at('2026-10-01T00:00:00Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(open, close, at('2026-10-15T12:00:00Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(open, close, at('2026-10-24T00:00:00Z'))).toBe('CLOSED');
        expect(computeLombardiaStatus(open, close, at('2030-01-01T00:00:00Z'))).toBe('CLOSED');
    });

    it('a date-only closing date (midnight, as every live value is) is open for that WHOLE day, closing at the next midnight', () => {
        expect(computeLombardiaStatus(open, close, at('2026-10-23T00:00:00Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(open, close, at('2026-10-23T23:59:59.999Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(open, close, at('2026-10-24T00:00:00.000Z'))).toBe('CLOSED');
    });

    it('a closing INSTANT with a time of day is exact (SYNTHETIC: no live row has one)', () => {
        expect(computeLombardiaStatus(open, '2026-10-23T12:30:00.000Z', at('2026-10-23T12:29:59Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(open, '2026-10-23T12:30:00.000Z', at('2026-10-23T12:30:00Z'))).toBe('CLOSED');
    });

    it('no closing date: UPCOMING while not yet open, otherwise null (never a guessed OPEN or CLOSED)', () => {
        expect(computeLombardiaStatus('2027-02-22T00:00:00.000Z', null, NOW)).toBe('UPCOMING');
        expect(computeLombardiaStatus('2023-03-06T00:00:00.000Z', null, NOW)).toBeNull();
        expect(computeLombardiaStatus(null, null, NOW)).toBeNull();
    });

    it('no opening date: OPEN until the closing day passes, then CLOSED (SYNTHETIC)', () => {
        expect(computeLombardiaStatus(null, close, at('2026-10-22T00:00:00Z'))).toBe('OPEN');
        expect(computeLombardiaStatus(null, close, at('2026-10-25T00:00:00Z'))).toBe('CLOSED');
    });

    it('an unparseable closing date is null, not CLOSED (SYNTHETIC)', () => {
        expect(computeLombardiaStatus(open, 'not-a-date', NOW)).toBeNull();
    });
});

describe('normalizeRow (real live rows)', () => {
    it('maps an open bando into the README output vocabulary', () => {
        const p = normalizeRow(byCode('RLA12026054924'), NOW);
        expect(p).toMatchObject({
            source_url: `${LOMBARDIA_RESOURCE_URL}?codice_bando=RLA12026054924`,
            codice_bando: 'RLA12026054924',
            titolo_bando: 'Fondo regionale per il pluralismo e l’innovazione dell’informazione radiotelevisiva e dell\'editoria on line locale – Anno 2026',
            direzione_generale: 'PRESIDENZA',
            ente: 'Regione Lombardia',
            tipo_strumento: 'Bando',
            apertura_adesione_iso: '2026-10-01T00:00:00.000Z',
            chiusura_adesione_iso: '2026-10-23T00:00:00.000Z',
            presentato: 0,
            computed_status: 'OPEN',
            license: LICENSE_NOTICE,
        });
        expect(LICENSE_NOTICE).toMatch(/CC BY 4\.0.*Regione Lombardia/);
    });

    it('presentato is a number (the source serialises it as a string), and absent columns are null', () => {
        expect(normalizeRow(byCode('RLA12015000137'), NOW).presentato).toBe(1067);
        const aria = normalizeRow(byCode('ARIA2020016162'), NOW);
        expect(byCode('ARIA2020016162').direzione_generale).toBeUndefined(); // absent in the live row, not null
        expect(aria).toMatchObject({ direzione_generale: null, ente: null, computed_status: 'CLOSED', presentato: 77 });
    });

    it('covers each derived status on the real rows at the run clock', () => {
        const status = (code: string) => normalizeRow(byCode(code), NOW).computed_status;
        expect(status('RLA12015000137')).toBe('CLOSED');
        expect(status('RLA12026054924')).toBe('OPEN');
        expect(status('RLAV2026052883')).toBe('OPEN');
        expect(status('CRLA2026056463')).toBe('UPCOMING');
        expect(status('CRLA2026056464')).toBe('UPCOMING');
        expect(status('CRLA2018006082')).toBeNull(); // opened in 2023, no closing date published
    });

    it('blank text and a non-numeric presentato become null (SYNTHETIC)', () => {
        const p = normalizeRow({ codice_bando: 'X1', titolo_bando: '   ', presentato: 'n/a' }, NOW);
        expect(p).toMatchObject({ titolo_bando: null, presentato: null, apertura_adesione_iso: null, chiusura_adesione_iso: null, computed_status: null });
        expect(normalizeRow({ codice_bando: 'X2', presentato: 5 }, NOW).presentato).toBe(5);
        expect(normalizeRow({ codice_bando: 'X3', presentato: '' }, NOW).presentato).toBeNull();
    });

    it('the payload carries no router-owned and no legacy delta-engine keys', () => {
        const p = normalizeRow(byCode('RLA12026054924'), NOW);
        for (const key of [...ROUTER_OWNED_KEYS, ...LEGACY_DELTA_KEYS, 'policy_area', 'status_fingerprint', 'content_fingerprint']) expect(p, key).not.toHaveProperty(key);
    });

    it('watchText is publisher + directorate + title', () => {
        expect(watchTextOf(byCode('CRLA2026056463'))).toBe(
            'CONSIGLIO REGIONALE DELLA LOMBARDIA CONSIGLIO REGIONALE DELLA LOMBARDIA Il sacrificio degli italiani della Venezia Giulia e della Dalmazia– XIX edizione',
        );
        expect(watchTextOf({ codice_bando: 'x' })).toBe('');
    });
});

describe('recordId and fingerprint', () => {
    it('recordId is the codice_bando and is stable', () => {
        const a = toSourceRecord(byCode('RLA12026054924'), NOW);
        expect(a.recordId).toBe('RLA12026054924');
        expect(toSourceRecord(structuredClone(byCode('RLA12026054924')), NOW).fingerprint).toBe(a.fingerprint);
    });

    it('the fingerprint changes for each consumer-visible edit', () => {
        const row = byCode('RLA12026054924');
        const base = toSourceRecord(row, NOW).fingerprint;
        const changed = (patch: Partial<LombardiaRow>) => toSourceRecord({ ...row, ...patch }, NOW).fingerprint;
        expect(changed({ titolo_bando: 'A corrected title' })).not.toBe(base);
        expect(changed({ chiusura_adesione: '2026-11-30T00:00:00.000' })).not.toBe(base);
        expect(changed({ direzione_generale: 'ALTRA DG' })).not.toBe(base);
        expect(changed({ presentato: '12' })).not.toBe(base);
        expect(changed({ tipo_strumento: 'Avviso Dote' })).not.toBe(base);
    });

    it('a status TRANSITION changes the fingerprint (the README\'s STATUS_CHANGE); the clock moving inside one status does not', () => {
        const row = byCode('RLA12026054924'); // opened 2026-10-01, closes (date-only) 2026-10-23
        const at = (iso: string) => toSourceRecord(row, new Date(iso)).fingerprint;
        expect(at('2026-10-21T00:00:00Z')).toBe(at('2026-10-22T18:00:00Z')); // OPEN -> OPEN
        expect(at('2026-10-21T00:00:00Z')).not.toBe(at('2026-10-24T00:00:00Z')); // OPEN -> CLOSED
        expect(at('2026-09-01T00:00:00Z')).not.toBe(at('2026-10-21T00:00:00Z')); // UPCOMING -> OPEN
    });
});

describe('options', () => {
    it('applies defaults, needs no credential (the Socrata token is optional) and passes preflight with none', () => {
        expect(opts()).toEqual({});
        expect(itLombardiaGrantsConnector.requiredOptions).toBeUndefined();
        const input = EngineInputSchema.parse({ sources: ['it_lombardia_grants'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [itLombardiaGrantsConnector] }, input)).toHaveLength(1);
    });

    it('rejects the README options that are not implemented (policy area, delta, retry knobs) instead of silently ignoring them', () => {
        for (const key of ['policyAreaFilter', 'eventTypes', 'onlyNew', 'deltaStateName', 'resetState', 'maxItems', 'requestTimeoutSecs', 'maxRetries']) {
            expect(itLombardiaGrantsOptionsSchema.safeParse({ [key]: 'x' }).success, key).toBe(false);
        }
    });

    it('validates statusFilter and keyword container types', () => {
        expect(itLombardiaGrantsOptionsSchema.safeParse({ statusFilter: ['OPEN', 'UPCOMING'] }).success).toBe(true);
        expect(itLombardiaGrantsOptionsSchema.safeParse({ statusFilter: ['ACTIVE'] }).success).toBe(false);
        expect(itLombardiaGrantsOptionsSchema.safeParse({ keyword: 12 }).success).toBe(false);
        expect(itLombardiaGrantsOptionsSchema.safeParse({ keyword: ['a'], directorateFilter: 'x' }).success).toBe(true);
        expect(opts({ socrataAppToken: '  tok  ' }).socrataAppToken).toBe('tok');
    });

    it('rejects a bad option in router preflight', () => {
        const input = EngineInputSchema.parse({ sources: ['it_lombardia_grants'], sourceOptions: { it_lombardia_grants: { policyAreaFilter: ['AGRICULTURE_FOOD'] } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [itLombardiaGrantsConnector] }, input)).toThrow(FatalConfigError);
    });
});

describe('request building', () => {
    it('buildPageUrl uses the live-verified dataset, a stable $order and an encoded $q', () => {
        expect(buildPageUrl(0, null)).toBe('https://www.dati.lombardia.it/resource/bukx-h2uy.json?$limit=1000&$offset=0&$order=codice_bando');
        expect(buildPageUrl(2000, 'agricoltura')).toBe('https://www.dati.lombardia.it/resource/bukx-h2uy.json?$limit=1000&$offset=2000&$order=codice_bando&$q=agricoltura');
        expect(buildPageUrl(0, 'sport & giovani')).toContain('&$q=sport%20%26%20giovani');
        expect(PAGE_LIMIT).toBe(1000);
    });
});

describe('fetch (stubbed http, no real waiting)', () => {
    it('returns the live excerpt in one request, newest-opened first, with no crawl-delay wait for a single request', async () => {
        const sleeps: number[] = [];
        const stub = makeCtx(sodaServer(excerpt));
        const records = await fetchLombardiaGrants(stub.ctx, opts(), RUN, { sleep: async (ms) => void sleeps.push(ms) });
        expect(records.map((r) => r.recordId)).toEqual([
            'CRLA2026056464',
            'CRLA2026056463',
            'RLAV2026052883',
            'RLA12026054924',
            'CRLA2018006082',
            'ARIA2020016162',
            'RLA12016000182',
            'RLA12015000137',
        ]);
        expect(stub.requests).toHaveLength(1);
        expect(stub.requests[0]?.url).toBe(buildPageUrl(0, null));
        expect(stub.requests[0]?.method).toBe('GET');
        expect(sleeps).toEqual([]);
    });

    it('sends only an Accept header by default: no User-Agent override and no app token', async () => {
        const stub = makeCtx(sodaServer(excerpt));
        await fetchLombardiaGrants(stub.ctx, opts(), RUN, noSleep);
        expect(stub.requests[0]?.headers).toEqual({ accept: 'application/json' });
    });

    it('a configured Socrata app token is sent as X-App-Token; a blank one is not', async () => {
        const withToken = makeCtx(sodaServer(excerpt));
        await fetchLombardiaGrants(withToken.ctx, opts({ socrataAppToken: 'abc123' }), RUN, noSleep);
        expect(withToken.requests[0]?.headers).toEqual({ accept: 'application/json', 'x-app-token': 'abc123' });

        const blank = makeCtx(sodaServer(excerpt));
        await fetchLombardiaGrants(blank.ctx, opts({ socrataAppToken: '   ' }), RUN, noSleep);
        expect(blank.requests[0]?.headers).not.toHaveProperty('x-app-token');
    });

    it('an invalid app token (live: HTTP 403 "Invalid app_token specified") fails the source with a pointed message', async () => {
        const body = '{"code":"permission_denied","error":true,"message":"Invalid app_token specified"}';
        const stub = makeCtx(() => new HttpStatusError(buildPageUrl(0, null), 403, body));
        const error = await fetchLombardiaGrants(stub.ctx, opts({ socrataAppToken: 'bad' }), RUN, noSleep).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('it_lombardia_grants');
        expect((error as Error).message).toMatch(/HTTP 403.*Invalid app_token specified.*socrataAppToken/);
    });

    it('honours robots.txt Crawl-delay: waits 1 s before every request after the first, across pages (SYNTHETIC 1,005 rows)', async () => {
        const all = Array.from({ length: 1005 }, (_, i) => synthRow(i));
        const sleeps: number[] = [];
        const stub = makeCtx(sodaServer(all));
        const records = await fetchLombardiaGrants(stub.ctx, opts(), { maxItemsPerSource: 10_000 }, { sleep: async (ms) => void sleeps.push(ms) });
        expect(records).toHaveLength(1005);
        expect(stub.requests.map((r) => new URL(r.url).searchParams.get('$offset'))).toEqual(['0', '1000']);
        expect(sleeps).toEqual([LOMBARDIA_CRAWL_DELAY_MS]);
        expect(LOMBARDIA_CRAWL_DELAY_MS).toBe(1000);
        // Newest-opened first: the synthetic row with the latest opening date leads.
        expect(records[0]?.recordId).toBe('T01004');
    });

    it('the real connector.fetch really waits out the crawl-delay between its own requests (SYNTHETIC two-page register)', async () => {
        const all = Array.from({ length: 1002 }, (_, i) => synthRow(i));
        const stub = makeCtx(sodaServer(all));
        const started = Date.now();
        const records = await itLombardiaGrantsConnector.fetch(stub.ctx, opts(), { maxItemsPerSource: 2000 });
        expect(records).toHaveLength(1002);
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it('a keyword is a Socrata $q query; several keywords are separate walks, unioned, one crawl-delay apart', async () => {
        const all = [synthRow(1, { titolo_bando: 'Agricoltura giovani' }), synthRow(2, { titolo_bando: 'Sport e Agricoltura' }), synthRow(3, { titolo_bando: 'Sport' }), synthRow(4, { titolo_bando: 'Cultura' })];
        const one = makeCtx(sodaServer(all));
        expect((await fetchLombardiaGrants(one.ctx, opts({ keyword: 'agricoltura' }), RUN, noSleep)).map((r) => r.recordId).sort()).toEqual(['T00001', 'T00002']);
        expect(one.requests.map((r) => r.url)).toEqual([buildPageUrl(0, 'agricoltura')]);

        const sleeps: number[] = [];
        const two = makeCtx(sodaServer(all));
        const union = await fetchLombardiaGrants(two.ctx, opts({ keyword: ['agricoltura', 'sport', 'AGRICOLTURA'] }), RUN, { sleep: async (ms) => void sleeps.push(ms) });
        expect(union.map((r) => r.recordId).sort()).toEqual(['T00001', 'T00002', 'T00003']);
        expect(two.requests.map((r) => r.url)).toEqual([buildPageUrl(0, 'agricoltura'), buildPageUrl(0, 'sport')]);
        expect(sleeps).toEqual([1000]);
    });

    it('queries at most 5 keywords and says so', async () => {
        const stub = makeCtx(sodaServer(excerpt));
        await fetchLombardiaGrants(stub.ctx, opts({ keyword: ['kwa', 'kwb', 'kwc', 'kwd', 'kwe', 'kwf', 'kwg'] }), RUN, noSleep);
        expect(stub.requests).toHaveLength(MAX_KEYWORD_QUERIES);
        expect(stub.logs.warning.some((m) => /only the first 5 are queried/.test(m))).toBe(true);
    });

    it('keyword guard: blank / one-character / punctuation / non-string keyword and directorate lists mean "no filtering", logged', async () => {
        for (const bad of [[''], [' '], ['a'], ['--'], [null], ''] as unknown[]) {
            const stub = makeCtx(sodaServer(excerpt));
            const records = await fetchLombardiaGrants(stub.ctx, { ...opts(), keyword: bad as never, directorateFilter: bad as never }, RUN, noSleep);
            expect(records, JSON.stringify(bad)).toHaveLength(8);
            expect(stub.requests.map((r) => r.url), JSON.stringify(bad)).toEqual([buildPageUrl(0, null)]); // no $q was sent
            expect(stub.logs.warning.some((m) => /No valid keyword remained/.test(m)), JSON.stringify(bad)).toBe(true);
        }
    });

    it('directorateFilter is a case-insensitive substring match on direzione_generale; a row with no directorate never matches', async () => {
        const stub = makeCtx(sodaServer(excerpt));
        const consiglio = await fetchLombardiaGrants(stub.ctx, opts({ directorateFilter: ['consiglio regionale'] }), RUN, noSleep);
        expect(consiglio.map((r) => r.recordId).sort()).toEqual(['CRLA2026056463', 'CRLA2026056464']);
        const sport = await fetchLombardiaGrants(makeCtx(sodaServer(excerpt)).ctx, opts({ directorateFilter: 'sport' }), RUN, noSleep);
        expect(sport.map((r) => r.recordId)).toEqual(['RLAV2026052883']);
        const absent = await fetchLombardiaGrants(makeCtx(sodaServer(excerpt)).ctx, opts({ directorateFilter: ['ARIA'] }), RUN, noSleep);
        expect(absent).toEqual([]); // ARIA2020016162 has no direzione_generale, and its code is not searched
    });

    it('statusFilter keeps only the derived statuses asked for and excludes rows whose status is null', async () => {
        const open = await fetchLombardiaGrants(makeCtx(sodaServer(excerpt)).ctx, opts({ statusFilter: ['OPEN'] }), RUN, noSleep);
        expect(open.map((r) => r.recordId).sort()).toEqual(['RLA12026054924', 'RLAV2026052883']);
        const upcomingOrClosed = await fetchLombardiaGrants(makeCtx(sodaServer(excerpt)).ctx, opts({ statusFilter: ['UPCOMING', 'CLOSED'] }), RUN, noSleep);
        expect(upcomingOrClosed.map((r) => r.recordId)).not.toContain('CRLA2018006082');
        expect(upcomingOrClosed).toHaveLength(5);
        const all = await fetchLombardiaGrants(makeCtx(sodaServer(excerpt)).ctx, opts({ statusFilter: [] }), RUN, noSleep);
        expect(all).toHaveLength(8); // an empty list is "no filter"
    });

    it('statusFilter is evaluated against the run clock (SYNTHETIC later clock: the 23 October closer is no longer open)', async () => {
        const later = makeCtx(sodaServer(excerpt), '2026-10-24T00:00:00Z');
        const open = await fetchLombardiaGrants(later.ctx, opts({ statusFilter: ['OPEN'] }), RUN, noSleep);
        expect(open.map((r) => r.recordId)).toEqual(['RLAV2026052883']);
    });

    it('maxItemsPerSource keeps the newest-opened bandi and warns about the rest', async () => {
        const stub = makeCtx(sodaServer(excerpt));
        const records = await fetchLombardiaGrants(stub.ctx, opts(), { maxItemsPerSource: 3 }, noSleep);
        expect(records.map((r) => r.recordId)).toEqual(['CRLA2026056464', 'CRLA2026056463', 'RLAV2026052883']);
        expect(stub.logs.warning.some((m) => /8 bandi matched but maxItemsPerSource=3/.test(m))).toBe(true);
    });

    it('skips rows without a usable codice_bando (logged) but keeps the rest (SYNTHETIC)', async () => {
        const stub = makeCtx(() => [{ titolo_bando: 'orphan' }, { codice_bando: '   ', titolo_bando: 'blank code' }, synthRow(1)]);
        const records = await fetchLombardiaGrants(stub.ctx, opts(), RUN, noSleep);
        expect(records.map((r) => r.recordId)).toEqual(['T00001']);
        expect(stub.logs.warning.some((m) => /skipped 2 row\(s\)/.test(m))).toBe(true);
    });

    it('collapses a codice_bando served twice (SYNTHETIC)', async () => {
        const stub = makeCtx(() => [synthRow(1), synthRow(1, { titolo_bando: 'duplicate' }), synthRow(2)]);
        const records = await fetchLombardiaGrants(stub.ctx, opts(), RUN, noSleep);
        expect(records.map((r) => r.recordId).sort()).toEqual(['T00001', 'T00002']);
        expect(records.find((r) => r.recordId === 'T00001')?.payload.titolo_bando).toBe('Bando 1'); // first wins
    });

    it('an empty register returns [] after one request', async () => {
        const stub = makeCtx(() => []);
        expect(await fetchLombardiaGrants(stub.ctx, opts(), RUN, noSleep)).toEqual([]);
        expect(stub.requests).toHaveLength(1);
    });
});

describe('failure paths (SourceFetchError)', () => {
    it('HTTP errors fail the source with the status (429 mentions the app token as the remedy)', async () => {
        const e500 = await fetchLombardiaGrants(makeCtx(() => new HttpStatusError(buildPageUrl(0, null), 500, 'boom')).ctx, opts(), RUN, noSleep).catch((e: unknown) => e);
        expect(e500).toBeInstanceOf(SourceFetchError);
        expect((e500 as Error).message).toMatch(/HTTP 500.*boom/);
        await expect(fetchLombardiaGrants(makeCtx(() => new HttpStatusError(buildPageUrl(0, null), 429, '')).ctx, opts(), RUN, noSleep)).rejects.toThrow(/rate-limited.*socrataAppToken/);
        await expect(fetchLombardiaGrants(makeCtx(() => new TypeError('fetch failed')).ctx, opts(), RUN, noSleep)).rejects.toThrow(/network-level failure.*fetch failed/);
    });

    it('a body that is not an array (the dataset contract changed) fails the source instead of reading as "no bandi"', async () => {
        for (const bad of [{ code: 'dataset.missing', error: true }, 'html', null]) {
            await expect(fetchLombardiaGrants(makeCtx(() => bad).ctx, opts(), RUN, noSleep)).rejects.toThrow(/instead of a JSON array/);
        }
    });

    it('a page where no row has a codice_bando fails the source (schema drift), rather than returning an empty set', async () => {
        await expect(fetchLombardiaGrants(makeCtx(() => [{ code: 'A' }, { code: 'B' }]).ctx, opts(), RUN, noSleep)).rejects.toThrow(/none had a codice_bando/);
    });

    it('a failure on a later page fails the whole source (no silent partial register)', async () => {
        const all = Array.from({ length: 1005 }, (_, i) => synthRow(i));
        const server = sodaServer(all);
        const stub = makeCtx((request) => (new URL(request.url).searchParams.get('$offset') === '1000' ? new HttpStatusError(request.url, 503, '') : server(request)));
        await expect(fetchLombardiaGrants(stub.ctx, opts(), { maxItemsPerSource: 10_000 }, noSleep)).rejects.toThrow(/HTTP 503/);
    });
});

describe('through the real router', () => {
    const engineInput = (extra: Record<string, unknown> = {}) => ({ sources: ['it_lombardia_grants'], deltaMode: 'onlyChanged', maxItemsPerSource: 100, ...extra });

    it('first run emits the eight live rows as first_seen; an identical run emits nothing; a clock move inside the same statuses emits nothing', async () => {
        const store = new InMemoryDeltaStore();
        const first = await runThroughRouter(itLombardiaGrantsConnector, engineInput(), makeCtx(sodaServer(excerpt), '2026-10-21T00:00:00Z'), store);
        expect(first.rows).toHaveLength(8);
        expect(first.rows[0]).toMatchObject({
            engine: 'latam-global-tender-intelligence',
            source: 'it_lombardia_grants',
            record_id: 'CRLA2026056464',
            delta_status: 'first_seen',
            is_new: true,
            computed_status: 'UPCOMING',
        });
        expect(first.billing.totalFor(RESULT_EVENT)).toBe(8);

        const second = await runThroughRouter(itLombardiaGrantsConnector, engineInput(), makeCtx(sodaServer(excerpt), '2026-10-22T09:00:00Z'), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 8, emitted: 0, unchanged: 8 });
    });

    it('a bando that closes between two runs is re-emitted as "updated" with computed_status CLOSED (the README\'s STATUS_CHANGE)', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(itLombardiaGrantsConnector, engineInput(), makeCtx(sodaServer(excerpt), '2026-10-21T00:00:00Z'), store);
        const later = await runThroughRouter(itLombardiaGrantsConnector, engineInput(), makeCtx(sodaServer(excerpt), '2026-10-24T00:00:00Z'), store);
        expect(later.rows).toHaveLength(1);
        expect(later.rows[0]).toMatchObject({ record_id: 'RLA12026054924', delta_status: 'updated', is_new: false, computed_status: 'CLOSED' });
    });

    it('a watchlist keyword matches the publisher / directorate / title; ghost-billing inputs bill nothing', async () => {
        const hit = await runThroughRouter(itLombardiaGrantsConnector, engineInput({ watchlistNames: ['Consiglio Regionale'] }), makeCtx(sodaServer(excerpt)));
        expect(hit.rows.filter((r) => r.is_watchlist_match === true).map((r) => r.record_id).sort()).toEqual(['CRLA2018006082', 'CRLA2026056463', 'CRLA2026056464']);
        expect(hit.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(3);

        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const none = await runThroughRouter(itLombardiaGrantsConnector, engineInput({ watchlistNames }), makeCtx(sodaServer(excerpt)));
            expect(none.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(none.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('an upstream failure is isolated to the source and reported', async () => {
        const result = await runThroughRouter(itLombardiaGrantsConnector, engineInput(), makeCtx(() => new HttpStatusError(buildPageUrl(0, null), 503, 'down')));
        expect(result.rows).toHaveLength(0);
        expect(result.summary.sources[0]?.error).toMatch(/HTTP 503/);
    });
});
