/**
 * ar_entrerios connector tests.
 *
 * Fixtures (test/fixtures/tenders-a/, no network, all byte-exact Windows-1252 responses):
 *   - entrerios.legacy.licitaciones_organismo8.html           COPIED VERBATIM from the legacy actor
 *       (entrerios-compras-monitor/test/fixtures): real capture, estado blank -> 5-column layout, 54 rows.
 *   - entrerios.legacy.licitaciones_estado3_organismo8.html   COPIED VERBATIM: estado=3 -> 4-column layout, 17 rows.
 *   - entrerios.legacy.licitaciones_vacio.html                COPIED VERBATIM: the portal's genuine empty state
 *       (the "No hay información con ese criterio" notice, no table at all).
 *   - entrerios.live-2026-10-21.estado4_organismo8.html       REAL response captured in THIS port session with
 *       `POST estado=4 cmb_organismo=8` (2 rows, 12,000 bytes, raw 0x93/0x94/0xF3/0xED/0xFA bytes).
 * Inline strings are SYNTHETIC and labelled where used (a bot-check page).
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    arEntreRiosConnector,
    arEntreRiosOptionsSchema,
    buildFormBody,
    classifyResponse,
    ENTRERIOS_SOURCE_ID,
    extractAnioProcedimiento,
    normalizeEstadoText,
    parseResponse,
    parseTenders,
    stableId,
    TARGET_URL,
    toSourceRecord,
} from '../latam-global-tender-intelligence/connectors/arEntreRios.js';
import { decodePortalBytes, decodeWindows1252 } from '../latam-global-tender-intelligence/support/portalHttp.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type RunParams, SourceFetchError } from '../lib/types.js';
import { fixtureBytes, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter } from './tenders-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const ALL = 'entrerios.legacy.licitaciones_organismo8.html';
const E3 = 'entrerios.legacy.licitaciones_estado3_organismo8.html';
const EMPTY = 'entrerios.legacy.licitaciones_vacio.html';
const LIVE = 'entrerios.live-2026-10-21.estado4_organismo8.html';

const html = (name: string) => decodeWindows1252(fixtureBytes(name));
const options = (input: Record<string, unknown> = {}) => arEntreRiosOptionsSchema.parse(input);

/** SYNTHETIC: what a bot-check / session-dropped interstitial looks like (HTTP 200, neither table nor notice). */
const INTERSTITIAL = '<html><head><title>Verificando</title></head><body><script>window.bobcmn="x"</script></body></html>';

describe('windows-1252 decoding', () => {
    it('decodes accented bytes and the 0x80-0x9F block like a browser (explicit table, not TextDecoder)', () => {
        expect(decodeWindows1252(new Uint8Array([0x4c, 0x69, 0x63, 0x69, 0x74, 0x61, 0x63, 0x69, 0xf3, 0x6e]))).toBe('Licitación');
        expect(decodeWindows1252(new Uint8Array([0x41, 0x20, 0x96, 0x20, 0x42]))).toBe('A – B'); // en dash, not the control U+0096
        expect(decodeWindows1252(new Uint8Array([0x93, 0x50, 0x94]))).toBe('“P”');
        expect(decodeWindows1252(new Uint8Array([0x80, 0x9f]))).toBe('€Ÿ');
        expect(decodeWindows1252(new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d]))).toBe('\u0081\u008d\u008f\u0090\u009d');
        expect(decodeWindows1252(new Uint8Array([0xff, 0x00, 0xa0]))).toBe('ÿ\u0000 ');
    });

    it('honours a Uint8Array that is a view into a larger buffer', () => {
        const backing = new Uint8Array([0x00, 0x00, 0x93, 0x41, 0x94, 0x00]);
        expect(decodeWindows1252(backing.subarray(2, 5))).toBe('“A”');
    });

    it('treats iso-8859-1 as windows-1252 (WHATWG label rule) and utf-8 as utf-8', () => {
        expect(decodePortalBytes(new Uint8Array([0x96]), 'iso-8859-1')).toBe('–');
        expect(decodePortalBytes(new Uint8Array([0xc3, 0xb3]), 'utf-8')).toBe('ó');
    });

    it('documents why the connector refuses getText: a UTF-8 decode of the real bytes is irreversibly corrupted', () => {
        const utf8 = new TextDecoder('utf-8').decode(fixtureBytes(LIVE));
        expect(utf8).toContain('�');
        expect(html(LIVE)).not.toContain('�');
        expect(html(LIVE)).toContain('Licitación Privada 18/2024');
    });
});

describe('parseTenders (real captures)', () => {
    it('5-column layout (estado blank): 54 rows, accents intact, corrupted estado label normalised, only the known estados', () => {
        const rows = parseTenders(html(ALL), '');
        expect(rows).toHaveLength(54);
        expect(rows[0]).toMatchObject({
            procedimiento: 'Licitación Pública 17/2024',
            anioProcedimiento: '2024',
            objeto: 'Adquisicion de Una (01) Mesa de Anestesia',
            organismo: 'Ministerio de Salud',
            estado: 'Realizada',
            record_id: 'f2d2505dbf88b8e3ca1b7353ed7465dd6f7a204f',
        });
        // the typographic quotes are bytes 0x93/0x94 in the source: the record id hashes them, so a wrong decoder would also mint a wrong id
        expect(rows[0]?.destino).toBe('Servicio de Cirugía del Hospital \u201cJusto José de Urquiza\u201d de Federal, dependiente del Ministerio de Salud de la Provincia de Entre Ríos');
        expect(new Set(rows.map((r) => r.estado))).toEqual(new Set(['Realizada', 'En proceso de Evaluación', 'Fracasada']));
        for (const r of rows) {
            expect(`${r.procedimiento}${r.objeto}${r.destino}${r.organismo}${r.estado}`).not.toMatch(/�|ï¿½/);
            expect(r.record_id).toMatch(/^[0-9a-f]{40}$/);
        }
    });

    it('4-column layout (estado applied): the estado comes from the applied filter code', () => {
        const rows = parseTenders(html(E3), '3');
        expect(rows).toHaveLength(17);
        expect(rows.every((r) => r.estado === 'Realizada')).toBe(true);
        expect(new Set(rows.map((r) => r.record_id)).size).toBe(17);
    });

    it('live 2026-10-21 capture: 2 rows, typographic quotes from bytes 0x93/0x94 decoded correctly', () => {
        const rows = parseTenders(html(LIVE), '4');
        expect(rows.map((r) => r.procedimiento)).toEqual(['Licitación Privada 18/2024', 'Licitación Privada 22/2024']);
        expect(rows.every((r) => r.estado === 'Fracasada' && r.organismo === 'Ministerio de Salud')).toBe(true);
        expect(rows[0]?.destino).toBe('Ambulancia de agua perteneciente al Hospital “Paranacito” de Villa Paranacito');
        expect(rows[1]?.objeto).toBe('Adquirir Larvicidas biológicos');
    });

    it('the same procurement keeps the same id whichever estado filter was applied (estado is not part of the id)', () => {
        const filtered = parseTenders(html(E3), '3');
        const unfiltered = parseTenders(html(ALL), '');
        const inBoth = filtered.filter((r) => unfiltered.some((u) => u.record_id === r.record_id));
        expect(inBoth.length).toBeGreaterThan(0);
        expect(stableId('a', 'b', 'c', 'd')).toBe(createHash('sha1').update('a|b|c|d').digest('hex'));
    });

    it('extractAnioProcedimiento and normalizeEstadoText behave like the legacy functions', () => {
        expect(extractAnioProcedimiento('Solicitud De Cotizacion 54/2025')).toBe('2025');
        expect(extractAnioProcedimiento('Licitacion Privada /2018')).toBe('2018');
        expect(extractAnioProcedimiento('Solicitud De Cotización 303/0')).toBe('0');
        expect(extractAnioProcedimiento('Sin numero ni anio')).toBeNull();
        expect(normalizeEstadoText('Realizada')).toBe('Realizada');
        expect(normalizeEstadoText('En proceso de Evaluaciï¿½n')).toBe('En proceso de Evaluación');
        expect(normalizeEstadoText('Próximas Aperturas')).toBe('Próxima Apertura');
        expect(normalizeEstadoText('Algo Inesperado')).toBe('Algo Inesperado');
    });
});

describe('response classification', () => {
    it('distinguishes a results table, the genuine empty notice and an unrecognised page', () => {
        expect(classifyResponse(html(ALL))).toBe('table');
        expect(classifyResponse(html(LIVE))).toBe('table');
        expect(classifyResponse(html(EMPTY))).toBe('no-results');
        expect(classifyResponse(INTERSTITIAL)).toBe('unrecognised');
        expect(parseResponse(html(EMPTY), '1')).toEqual({ kind: 'no-results', rows: [] });
        expect(parseResponse(html(E3), '3').rows).toHaveLength(17);
    });
});

describe('options validation', () => {
    it('defaults to "everything": all statuses, types, organisms and years, no keyword', () => {
        expect(options()).toEqual({ estado: '', tipoLicitacion: '', organismo: '', anio: '', palabra: '' });
    });

    it('builds exactly the site form fields, always as a POST body', () => {
        const body = buildFormBody(options({ estado: '3', tipoLicitacion: '2', organismo: '8', anio: ' 2024 ' }), 'mesa de cirugía');
        expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
            tipo_licitacion: '2',
            anio: '2024',
            estado: '3',
            palabra: 'mesa de cirugía',
            cmb_organismo: '8',
            buscar: 'Buscar',
        });
    });

    it('rejects codes the form does not offer, bad years, unknown keys and the legacy no-op dateRange (preflight)', () => {
        for (const bad of [{ estado: '5' }, { tipoLicitacion: '9' }, { organismo: '2' }, { anio: '20x4' }, { anio: '20245' }, { dateRange: '7d' }, { maxItems: 10 }, { onlyNew: true }]) {
            expect(arEntreRiosOptionsSchema.safeParse(bad).success).toBe(false);
        }
        const input = EngineInputSchema.parse({ sources: ['ar_entrerios'], sourceOptions: { ar_entrerios: { estado: '7' } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arEntreRiosConnector] }, input)).toThrow(/Invalid options for "ar_entrerios"/);
    });

    it('needs no credential: an empty slice passes preflight', () => {
        expect(arEntreRiosConnector.requiredOptions ?? []).toEqual([]);
        const input = EngineInputSchema.parse({ sources: ['AR_EntreRios'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arEntreRiosConnector] }, input)).toHaveLength(1);
    });
});

describe('fetch (stubbed raw-capable http)', () => {
    it('POSTs the form (never a GET) and maps rows to SourceRecords', async () => {
        const stub = makeCtx(() => fixtureBytes(LIVE), { raw: true });
        const records = await arEntreRiosConnector.fetch(stub.ctx, options({ estado: '4', organismo: '8' }), RUN);
        expect(stub.calls).toHaveLength(1);
        const call = stub.calls[0];
        expect(call?.url).toBe(TARGET_URL);
        expect(call?.init?.method).toBe('POST');
        expect(call?.init?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
        expect(Object.fromEntries(new URLSearchParams(call?.init?.body))).toMatchObject({ estado: '4', cmb_organismo: '8', buscar: 'Buscar', palabra: '', anio: '' });

        expect(records).toHaveLength(2);
        const first = records[0];
        expect(first?.recordId).toBe(stableId('Licitación Privada 18/2024', 'Adquirir Un (01) Motor para embarcación fuera de borda pata larga nuevo y sin uso', 'Ambulancia de agua perteneciente al Hospital “Paranacito” de Villa Paranacito', 'Ministerio de Salud'));
        expect(first?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(first?.watchText).toBe('Ministerio de Salud Adquirir Un (01) Motor para embarcación fuera de borda pata larga nuevo y sin uso');
        expect(first?.payload).toEqual({
            procedimiento: 'Licitación Privada 18/2024',
            anioProcedimiento: '2024',
            objeto: 'Adquirir Un (01) Motor para embarcación fuera de borda pata larga nuevo y sin uso',
            destino: 'Ambulancia de agua perteneciente al Hospital “Paranacito” de Villa Paranacito',
            organismo: 'Ministerio de Salud',
            estado: 'Fracasada',
            source_url: TARGET_URL,
        });
        for (const key of ROUTER_OWNED_KEYS) expect(first?.payload).not.toHaveProperty(key);
    });

    it('honours maxItemsPerSource', async () => {
        const stub = makeCtx(() => fixtureBytes(ALL), { raw: true });
        const records = await arEntreRiosConnector.fetch(stub.ctx, options(), { maxItemsPerSource: 5 });
        expect(records).toHaveLength(5);
        expect(records.map((r) => r.recordId)).toEqual(parseTenders(html(ALL), '').slice(0, 5).map((r) => r.record_id));
    });

    it('collapses byte-identical duplicate rows listed by the source (first wins)', async () => {
        // SYNTHETIC mutation of the real 17-row capture (done on the raw bytes): its first <tbody> row is repeated once.
        const bytes = Buffer.from(fixtureBytes(E3));
        const bodyStart = bytes.indexOf('<tbody>');
        const rowStart = bytes.indexOf('<tr', bodyStart);
        const rowEnd = bytes.indexOf('</tr>', rowStart) + '</tr>'.length;
        const row = bytes.subarray(rowStart, rowEnd);
        const doubled = new Uint8Array(Buffer.concat([bytes.subarray(0, rowEnd), row, bytes.subarray(rowEnd)]));
        expect(parseTenders(decodeWindows1252(doubled), '3')).toHaveLength(18);
        const stub = makeCtx(() => doubled, { raw: true });
        const records = await arEntreRiosConnector.fetch(stub.ctx, options({ estado: '3' }), RUN);
        expect(records).toHaveLength(17);
        expect(new Set(records.map((r) => r.recordId)).size).toBe(17);
        expect(stub.logs.info.some((m) => m.includes('1 byte-identical duplicate row(s)'))).toBe(true);
    });

    it('an empty result is a normal empty result, not an error', async () => {
        const stub = makeCtx(() => fixtureBytes(EMPTY), { raw: true });
        expect(await arEntreRiosConnector.fetch(stub.ctx, options({ estado: '1' }), RUN)).toEqual([]);
    });

    it('fails the source on a page that is neither a table nor the empty notice', async () => {
        const stub = makeCtx(() => INTERSTITIAL, { raw: true });
        const error = await arEntreRiosConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).message).toContain('Refusing to report "0 tenders"');
    });

    it('wraps a transport failure in SourceFetchError', async () => {
        const stub = makeCtx(() => new Error('HTTP 502 for https://www.entrerios.gov.ar/contrataciones/licitaciones.php'), { raw: true });
        const error = await arEntreRiosConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe(ENTRERIOS_SOURCE_ID);
        expect((error as SourceFetchError).message).toContain('HTTP 502');
    });

    it('reads the keyword through the guard: a 1-character / blank / punctuation-only palabra means "no keyword filter requested"', async () => {
        const good = makeCtx(() => fixtureBytes(LIVE), { raw: true });
        await arEntreRiosConnector.fetch(good.ctx, options({ palabra: '  motor   fuera de borda ' }), RUN);
        expect(new URLSearchParams(good.calls[0]?.init?.body).get('palabra')).toBe('motor fuera de borda');

        for (const bad of ['a', ' ', '--', '​​']) {
            const stub = makeCtx(() => fixtureBytes(LIVE), { raw: true });
            await arEntreRiosConnector.fetch(stub.ctx, options({ palabra: bad }), RUN);
            expect(new URLSearchParams(stub.calls[0]?.init?.body).get('palabra')).toBe('');
            expect(stub.logs.warning.some((m) => m.includes('keyword filter was not applied'))).toBe(bad.trim() !== '');
        }
    });
});

describe('fail-closed without raw bytes', () => {
    it('throws SourceFetchError BEFORE any request when ctx.http cannot return raw bytes (the text would be corrupted)', async () => {
        const stub = makeCtx(() => fixtureBytes(LIVE)); // getText only, no getRaw
        const error = await arEntreRiosConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe(ENTRERIOS_SOURCE_ID);
        expect((error as SourceFetchError).message).toContain('HttpClient.getRaw');
        expect((error as SourceFetchError).message).toContain('U+FFFD');
        expect(stub.calls).toHaveLength(0);
    });

    it('is isolated by the router: the run completes, nothing is emitted, the summary carries the reason', async () => {
        const run = await runThroughRouter(arEntreRiosConnector, { sources: ['ar_entrerios'] }, makeCtx(() => fixtureBytes(LIVE)));
        expect(run.rows).toEqual([]);
        expect(run.summary.sources[0]?.error).toContain('HttpClient.getRaw');
    });
});

describe('fingerprint and recordId semantics', () => {
    it('the recordId and fingerprint are stable across runs; an estado change moves only the fingerprint', async () => {
        const fetchWith = async (estado: string) => {
            const stub = makeCtx(() => fixtureBytes(E3), { raw: true });
            return arEntreRiosConnector.fetch(stub.ctx, options({ estado }), RUN);
        };
        const a = await fetchWith('3');
        const b = await fetchWith('3');
        expect(b.map((r) => r.fingerprint)).toEqual(a.map((r) => r.fingerprint));
        // The same 17 procurements, now read under estado 4: identical ids, different estado, different fingerprint.
        const moved = await fetchWith('4');
        expect(moved.map((r) => r.recordId)).toEqual(a.map((r) => r.recordId));
        expect(moved.every((r, i) => r.fingerprint !== a[i]?.fingerprint)).toBe(true);
        expect(moved[0]?.payload.estado).toBe('Fracasada');
    });

    it('toSourceRecord never sets a router-owned key', () => {
        const [row] = parseTenders(html(LIVE), '4');
        if (!row) throw new Error('fixture has rows');
        const record = toSourceRecord(row);
        for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
        expect(record.recordId).toBe(row.record_id);
    });
});

describe('end to end through the real router', () => {
    it('emits first_seen rows, nothing on an unchanged rerun, and `updated` for an estado change; watchlist matches buyer + object', async () => {
        const store = new InMemoryDeltaStore();
        const input = { sources: ['ar_entrerios'], sourceOptions: { ar_entrerios: { estado: '4', organismo: '8' } }, watchlistNames: ['larvicidas'], deltaMode: 'onlyChanged' };
        const first = await runThroughRouter(arEntreRiosConnector, input, makeCtx(() => fixtureBytes(LIVE), { raw: true }), store);
        expect(first.rows).toHaveLength(2);
        expect(first.rows.map((r) => r.is_watchlist_match)).toEqual([false, true]);
        expect(first.rows[1]).toMatchObject({ source: 'ar_entrerios', delta_status: 'first_seen', matched_watchlist_keyword: 'larvicidas', record_id: '0bd88c51e880775e717c742feab89eccee09ad7c' });
        expect(first.summary.watchlist.hitsCharged).toBe(1);

        const second = await runThroughRouter(arEntreRiosConnector, input, makeCtx(() => fixtureBytes(LIVE), { raw: true }), store);
        expect(second.rows).toHaveLength(0);

        // the same two rows now read under estado 3 (as if both procurements had been completed)
        const moved = { ...input, sourceOptions: { ar_entrerios: { estado: '3', organismo: '8' } } };
        const third = await runThroughRouter(arEntreRiosConnector, moved, makeCtx(() => fixtureBytes(LIVE), { raw: true }), store);
        expect(third.rows.map((r) => [r.delta_status, r.estado])).toEqual([
            ['updated', 'Realizada'],
            ['updated', 'Realizada'],
        ]);
    });

    it('never bills a hit for blank / whitespace / one-character watchlist entries (ghost-billing guard)', async () => {
        for (const watchlistNames of [[''], [' '], 'e', ['a']]) {
            const run = await runThroughRouter(arEntreRiosConnector, { sources: ['ar_entrerios'], watchlistNames }, makeCtx(() => fixtureBytes(LIVE), { raw: true }));
            expect(run.rows).toHaveLength(2);
            expect(run.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(run.summary.watchlist.hitsCharged).toBe(0);
        }
    });
});
