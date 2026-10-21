/**
 * ar_tucuman connector tests.
 *
 * Fixtures (test/fixtures/tenders-a/, no network), COPIED VERBATIM from the legacy actor
 * tucuman-compras-monitor/test/fixtures (real byte-for-byte captures served as ISO-8859-1):
 *   - tucuman.legacy.listing_estado1_pagina7.html   estado 1, last page: num_total 31, ONE tender (id 8233)
 *   - tucuman.legacy.listing_estado1_pagina99.html  estado 1, out-of-range page: num_total 31, zero tenders
 *   - tucuman.legacy.listing_estado3_pagina10.html  estado 3: num_total 313, five awarded tenders (2014)
 * The same portal was re-fetched live on 2026-10-21 (estado 1, page 1: HTTP 200, num_total 27) to confirm the
 * shape; that 92 KB page is not stored. SYNTHETIC mutations of the fixtures are labelled where used.
 */
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
    arTucumanConnector,
    arTucumanOptionsSchema,
    buildListingUrl,
    ESTADO_LABELS,
    isWithinDateRange,
    parseListingPage,
    parseSourceDate,
    toSourceRecord,
    TUCUMAN_SOURCE_ID,
} from '../latam-global-tender-intelligence/connectors/arTucuman.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, fixtureBytes, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter, type StubRequest } from './tenders-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const PAGE7 = 'tucuman.legacy.listing_estado1_pagina7.html';
const PAGE99 = 'tucuman.legacy.listing_estado1_pagina99.html';
const E3P10 = 'tucuman.legacy.listing_estado3_pagina10.html';

/** Fixtures hold raw ISO-8859-1 bytes; this is exactly how the legacy actor decodes a live response. */
function latin1(name: string): string {
    return new TextDecoder('iso-8859-1').decode(fixtureBytes(name));
}

function pagesHandler(pages: Record<string, string | Uint8Array | Error>) {
    return (request: StubRequest) => {
        const page = pages[request.url];
        if (page === undefined) throw new Error(`unrouted URL in test: ${request.url}`);
        return page;
    };
}

function replaceAscii(bytes: Uint8Array, find: string, replacement: number[]): Uint8Array {
    const buffer = Buffer.from(bytes);
    const index = buffer.indexOf(Buffer.from(find, 'latin1'));
    if (index < 0) throw new Error(`fixture does not contain ${find}`);
    return new Uint8Array(Buffer.concat([buffer.subarray(0, index), Buffer.from(replacement), buffer.subarray(index + find.length)]));
}

describe('parseListingPage (legacy fixtures, verbatim)', () => {
    it('estado 1, last page: reads num_total and the single true-remainder tender with every field', () => {
        const parsed = parseListingPage(latin1(PAGE7), buildListingUrl('1', 7));
        expect(parsed.numTotal).toBe(31);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0]).toEqual({
            idCompra: '8233',
            reparticion: 'MINISTERIO DE SEGURIDAD - DEPARTAMENTO GENERAL DE POLICIA',
            tipoCompra: 'CONCURSO DE PRECIOS',
            valorPliego: 'Gratuito',
            numeroExpediente: '370/208-ADM-2026',
            rubro: 'UTILES DE OFICINA',
            primerRenglon: 'Utiles de oficina, listado en solicitud de compra obrante en archivo adjunto',
            fechaAperturaSobres: '19/12/2026, 11:10:00',
            fechaAdjudicacion: null,
            numeroConvocatoria: 'CONCURSO DE PRECIOS Nº 21//26',
            autorizadoPor: null,
            presupuestoOficial: null,
            garantiaOfertaExigida: null,
            lugarApertura: 'Direccion de Administración - Calle Italia N° 2601',
            informesAdquisicionPliegos: 'Direccion de Administración - Calle Italia N° 2601 hasta fecha 13/02/2026 a horas 13:00',
            objetoLibre: 'Compra de Utiles de oficina detallados en pedido de cotizacion que se adjunta a continuacion.',
            renglones: [{ renglon: '1', descripcion: '1 unidad de Utiles de oficina, listado en solicitud de compra obrante en archivo adjunto -Rubro: UTILES DE OFICINA' }],
            pliegoPdfUrl: 'https://comprasbys.tucuman.gob.ar/aplicacion/a_pdf/Licitacion8233.pdf',
        });
    });

    it('estado 3 uses a different opening-date label ("Se abrio sobres el dia") and carries fechaAdjudicacion + multi-renglón breakdowns', () => {
        const parsed = parseListingPage(latin1(E3P10), buildListingUrl('3', 10));
        expect(parsed.numTotal).toBe(313);
        expect(parsed.items.map((t) => t.idCompra)).toEqual(['1547', '1554', '1545', '1539', '1530']);
        expect(parsed.items.map((t) => t.fechaAperturaSobres)).toEqual(['02/09/2014, 10:00:00', '02/09/2014, 10:00:00', '01/09/2014, 10:30:00', '29/08/2014, 11:00:00', '28/08/2014, 10:00:00']);
        expect(parsed.items.map((t) => t.fechaAdjudicacion)).toEqual(['11/09/2014', '20/02/2015', '20/10/2014', '20/10/2014', '05/12/2014']);
        expect(parsed.items.map((t) => t.renglones.length)).toEqual([3, 1, 2, 4, 1]); // the card shows only Renglón 1; the modal has all of them
        expect(parsed.items.map((t) => t.presupuestoOficial)).toEqual([null, '$ 60.000,00.-', '$ 50.000,00', '$80.000,00', '$254.761']);
    });

    it('an out-of-range page parses to zero tenders (num_total stays correct) instead of throwing', () => {
        const parsed = parseListingPage(latin1(PAGE99), buildListingUrl('1', 99));
        expect(parsed.numTotal).toBe(31);
        expect(parsed.items).toEqual([]);
    });

    it('decodes identically as ISO-8859-1 and as UTF-8: the only raw high bytes of the portal sit in HTML comments', () => {
        const asLatin1 = parseListingPage(latin1(E3P10), 'https://x/y');
        const asUtf8 = parseListingPage(new TextDecoder('utf-8').decode(fixtureBytes(E3P10)), 'https://x/y');
        expect(asUtf8).toEqual(asLatin1);
    });

    it('refuses to guess when tender modals and cards cannot be paired 1:1', () => {
        // SYNTHETIC mutation: the modal ids lose their `myModal` prefix, so 0 modals vs 1 card.
        const broken = latin1(PAGE7).replaceAll('myModal', 'zzModal');
        expect(() => parseListingPage(broken, 'https://x/y')).toThrow(/Listing page structure mismatch: found 0 tender modal\(s\) but 1 tender card\(s\)/);
        // sanity: cheerio still sees the page
        expect(cheerio.load(broken)('input[name="num_total"]').attr('value')).toBe('31');
    });
});

describe('date window', () => {
    it('converts the portal\'s Tucumán wall-clock strings (fixed UTC-3) to UTC and rejects other shapes', () => {
        expect(parseSourceDate('10/09/2026, 12:30:00')?.toISOString()).toBe('2026-09-10T15:30:00.000Z');
        expect(parseSourceDate('08/11/2023')?.toISOString()).toBe('2023-11-08T03:00:00.000Z');
        expect(parseSourceDate(null)).toBeNull();
        expect(parseSourceDate('')).toBeNull();
        expect(parseSourceDate('2026-09-10')).toBeNull();
        expect(parseSourceDate('10/09/2026 12:30')).toBeNull();
    });

    it('is a backward-looking window: a future date is never inside it, the boundary is inclusive', () => {
        const now = new Date('2026-10-21T12:00:00Z');
        expect(isWithinDateRange(new Date('2026-10-22T12:00:00Z'), '24h', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-10-20T12:00:00Z'), '24h', now)).toBe(true);
        expect(isWithinDateRange(new Date('2026-10-20T11:59:59Z'), '24h', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-09-21T12:00:00Z'), '30d', now)).toBe(true);
        expect(isWithinDateRange(new Date('2026-10-14T12:00:00Z'), '7d', now)).toBe(true);
    });
});

describe('options validation', () => {
    it('defaults to estado 1 only and accepts the three estados and the three windows', () => {
        expect(arTucumanOptionsSchema.parse({})).toEqual({ estados: ['1'] });
        expect(arTucumanOptionsSchema.parse({ estados: ['1', '2', '3'], dateRange: '30d' })).toEqual({ estados: ['1', '2', '3'], dateRange: '30d' });
    });

    it('rejects unknown estados, an empty list, an unknown window and unknown keys (preflight, before any request)', () => {
        for (const bad of [{ estados: ['4'] }, { estados: [] }, { estados: 'x' }, { dateRange: '1y' }, { maxItems: 5 }]) {
            expect(arTucumanOptionsSchema.safeParse(bad).success).toBe(false);
        }
        const input = EngineInputSchema.parse({ sources: ['ar_tucuman'], sourceOptions: { ar_tucuman: { estados: ['9'] } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arTucumanConnector] }, input)).toThrow(/Invalid options for "ar_tucuman"/);
    });

    it('needs no credential: an empty slice passes preflight', () => {
        expect(arTucumanConnector.requiredOptions ?? []).toEqual([]);
        const input = EngineInputSchema.parse({ sources: ['AR_Tucuman'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arTucumanConnector] }, input)).toHaveLength(1);
    });
});

describe('fetch (stubbed http)', () => {
    const options = (input: Record<string, unknown> = {}) => arTucumanOptionsSchema.parse(input);

    it('builds the legacy URL and maps a tender to a SourceRecord (stable id, fingerprint, buyer + first renglón watchText)', async () => {
        const url1 = buildListingUrl('1', 1);
        expect(url1).toBe('https://comprasbys.tucuman.gob.ar/ver_llamados_compras_avanzado.php?n=1&pagina_actual=1&estado_compra=1');
        // page 1 = the 31-tender estado-1 last page (1 tender); page 2 = the empty out-of-range page ends the series
        const stub = makeCtx(pagesHandler({ [url1]: fixtureBytes(PAGE7), [buildListingUrl('1', 2)]: fixtureBytes(PAGE99) }));
        const records = await arTucumanConnector.fetch(stub.ctx, options(), RUN);
        expect(stub.calls.map((c) => c.url)).toEqual([url1, buildListingUrl('1', 2)]);
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record?.recordId).toBe('8233');
        expect(record?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(record?.watchText).toBe('MINISTERIO DE SEGURIDAD - DEPARTAMENTO GENERAL DE POLICIA Utiles de oficina, listado en solicitud de compra obrante en archivo adjunto');
        expect(record?.payload).toMatchObject({
            idCompra: '8233',
            estadoCompra: '1',
            estadoCompraLabel: ESTADO_LABELS['1'],
            tipoCompra: 'CONCURSO DE PRECIOS',
            source_url: `${url1}#myModal8233`,
        });
        expect(typeof record?.payload.contentHash).toBe('string');
        for (const key of ROUTER_OWNED_KEYS) expect(record?.payload).not.toHaveProperty(key);
        expect(record?.payload).not.toHaveProperty('listingPageUrl');
        expect(record?.payload).not.toHaveProperty('scrapedAt');
    });

    it('stops paging once maxItemsPerSource is reached (inside a page: no further request)', async () => {
        const url = buildListingUrl('3', 1);
        const stub = makeCtx(pagesHandler({ [url]: fixtureBytes(E3P10) }));
        const records = await arTucumanConnector.fetch(stub.ctx, options({ estados: ['3'] }), { maxItemsPerSource: 3 });
        expect(records.map((r) => r.recordId)).toEqual(['1547', '1554', '1545']);
        expect(stub.calls).toHaveLength(1);
    });

    it('walks ceil(num_total/5) pages and several estados in order, tagging each record with its estado', async () => {
        const routes = {
            [buildListingUrl('3', 1)]: fixtureBytes(E3P10), // num_total 313 -> 63 pages
            [buildListingUrl('3', 2)]: fixtureBytes(PAGE99), // empty: the series ends here
            [buildListingUrl('1', 1)]: fixtureBytes(PAGE7), // num_total 31 -> 7 pages
            [buildListingUrl('1', 2)]: fixtureBytes(PAGE99),
        };
        const stub = makeCtx(pagesHandler(routes));
        const records = await arTucumanConnector.fetch(stub.ctx, options({ estados: ['3', '1'] }), RUN);
        expect(records.map((r) => [r.recordId, r.payload.estadoCompra])).toEqual([
            ['1547', '3'],
            ['1554', '3'],
            ['1545', '3'],
            ['1539', '3'],
            ['1530', '3'],
            ['8233', '1'],
        ]);
        expect(stub.calls).toHaveLength(4);
    });

    it('de-duplicates a tender listed twice in one run (first occurrence wins)', async () => {
        const stub = makeCtx(pagesHandler({ [buildListingUrl('1', 1)]: fixtureBytes(PAGE7), [buildListingUrl('1', 2)]: fixtureBytes(PAGE7), [buildListingUrl('1', 3)]: fixtureBytes(PAGE99) }));
        // num_total 31 -> 7 pages, so page 2 and page 3 are requested; the repeated tender collapses to one record
        const records = await arTucumanConnector.fetch(stub.ctx, options(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['8233']);
    });

    it('dateRange filters on fechaAperturaSobres AFTER the capped walk, against the injected clock', async () => {
        const routes = { [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: fixtureBytes(PAGE99) };
        const day = async (dateRange: string, now: string) => {
            const stub = makeCtx(pagesHandler(routes), { now });
            const records = await arTucumanConnector.fetch(stub.ctx, options({ estados: ['3'], dateRange }), RUN);
            return records.map((r) => r.recordId);
        };
        // 02/09/2014 10:00 ART = 13:00Z; 01/09 10:30 ART = 13:30Z; 29/08 11:00 ART = 14:00Z; 28/08 10:00 ART = 13:00Z
        expect(await day('24h', '2014-09-03T12:00:00Z')).toEqual(['1547', '1554']);
        expect(await day('7d', '2014-09-03T12:00:00Z')).toEqual(['1547', '1554', '1545', '1539', '1530']);
        expect(await day('30d', '2026-10-21T12:00:00Z')).toEqual([]);
        // estado 1 is a scheduled FUTURE date, which never falls into a backward-looking window (documented behaviour)
        const future = makeCtx(pagesHandler({ [buildListingUrl('1', 1)]: fixtureBytes(PAGE7), [buildListingUrl('1', 2)]: fixtureBytes(PAGE99) }), { now: '2026-10-21T12:00:00Z' });
        expect(await arTucumanConnector.fetch(future.ctx, options({ dateRange: '30d' }), RUN)).toEqual([]);
    });

    it('raw-capable client: pages are decoded as ISO-8859-1 exactly like the legacy actor', async () => {
        // SYNTHETIC mutation: the first renglón text "Utiles de oficina, listado" starts with a RAW 0xDA byte (U-acute in ISO-8859-1).
        const accented = replaceAscii(fixtureBytes(PAGE7), 'Utiles de oficina, listado en solicitud', [0xda, ...Buffer.from('tiles de oficina, listado en solicitud', 'latin1')]);
        const url = buildListingUrl('1', 1);
        const stub = makeCtx(pagesHandler({ [url]: accented, [buildListingUrl('1', 2)]: fixtureBytes(PAGE99) }), { raw: true });
        const records = await arTucumanConnector.fetch(stub.ctx, options(), RUN);
        expect(records[0]?.payload.primerRenglon).toBe('Útiles de oficina, listado en solicitud de compra obrante en archivo adjunto');
        expect(stub.logs.warning).toEqual([]);
    });

    it('text-only client: falls back to UTF-8 getText and WARNS when real field data is lost; comment-only high bytes do not warn', async () => {
        const accented = replaceAscii(fixtureBytes(PAGE7), 'Utiles de oficina, listado en solicitud', [0xda, ...Buffer.from('tiles de oficina, listado en solicitud', 'latin1')]);
        const lossy = makeCtx(pagesHandler({ [buildListingUrl('1', 1)]: accented, [buildListingUrl('1', 2)]: fixtureBytes(PAGE99) }));
        const records = await arTucumanConnector.fetch(lossy.ctx, options(), RUN);
        expect(records[0]?.payload.primerRenglon).toContain('�');
        expect(lossy.logs.warning.some((m) => m.includes('U+FFFD'))).toBe(true);

        const clean = makeCtx(pagesHandler({ [buildListingUrl('1', 1)]: fixtureBytes(PAGE7), [buildListingUrl('1', 2)]: fixtureBytes(PAGE99) }));
        await arTucumanConnector.fetch(clean.ctx, options(), RUN);
        expect(clean.logs.warning).toEqual([]); // the fixture's raw 0xF3 bytes are inside <!-- ... --> comments only
    });

    it('a failing later page keeps what was collected and warns; a failing first estado does not stop the next one', async () => {
        const partial = makeCtx(pagesHandler({ [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: new Error('HTTP 503') }));
        const records = await arTucumanConnector.fetch(partial.ctx, options({ estados: ['3'] }), RUN);
        expect(records).toHaveLength(5);
        expect(partial.logs.warning.some((m) => m.includes('estado=3 pagina=2') && m.includes('HTTP 503'))).toBe(true);

        const next = makeCtx(pagesHandler({ [buildListingUrl('1', 1)]: new Error('ECONNRESET'), [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: fixtureBytes(PAGE99) }));
        const second = await arTucumanConnector.fetch(next.ctx, options({ estados: ['1', '3'] }), RUN);
        expect(second.map((r) => r.payload.estadoCompra)).toEqual(['3', '3', '3', '3', '3']);
    });

    it('fails the source (SourceFetchError) when nothing at all could be fetched', async () => {
        const stub = makeCtx(() => new Error('getaddrinfo ENOTFOUND comprasbys.tucuman.gob.ar'));
        const error = await arTucumanConnector.fetch(stub.ctx, options({ estados: ['1', '3'] }), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe(TUCUMAN_SOURCE_ID);
        expect((error as SourceFetchError).message).toContain('ENOTFOUND');
        expect((error as SourceFetchError).message).toContain('2 failed request series');
    });

    it('fails the source on a structural mismatch instead of returning a guessed pairing (even if earlier pages worked)', async () => {
        // SYNTHETIC mutation (see the parser test): page 2 has lost its modal ids.
        const broken = latin1(E3P10).replaceAll('myModal', 'zzModal');
        const stub = makeCtx(pagesHandler({ [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: new TextEncoder().encode(broken) }));
        await expect(arTucumanConnector.fetch(stub.ctx, options({ estados: ['3'] }), RUN)).rejects.toThrow(/Refusing to guess the pairing/);
    });
});

describe('fingerprint semantics', () => {
    async function fetchE3(bytes: Uint8Array, estados: Array<'1' | '3'> = ['3']) {
        const routes: Record<string, Uint8Array> = {};
        for (const e of estados) {
            routes[buildListingUrl(e, 1)] = bytes;
            routes[buildListingUrl(e, 2)] = fixtureBytes(PAGE99);
        }
        const stub = makeCtx(pagesHandler(routes));
        return arTucumanConnector.fetch(stub.ctx, arTucumanOptionsSchema.parse({ estados }), RUN);
    }

    it('is identical across runs, changes when a monto is amended, and the recordId never changes', async () => {
        const base = await fetchE3(fixtureBytes(E3P10));
        const again = await fetchE3(fixtureBytes(E3P10));
        expect(again.map((r) => r.fingerprint)).toEqual(base.map((r) => r.fingerprint));
        // SYNTHETIC mutation: tender 1554's budget "$ 60.000,00.-" is amended to "$ 61.000,00.-"
        const amended = await fetchE3(replaceAscii(fixtureBytes(E3P10), '$ 60.000,00.-', [...Buffer.from('$ 61.000,00.-', 'latin1')]));
        expect(amended.map((r) => r.recordId)).toEqual(base.map((r) => r.recordId));
        expect(amended.map((r, i) => r.fingerprint === base[i]?.fingerprint)).toEqual([true, false, true, true, true]);
        expect(amended[1]?.payload.presupuestoOficial).toBe('$ 61.000,00.-');
    });

    it('changes when the same tender moves to another estado (the legacy STATUS_CHANGE)', async () => {
        const asEstado1 = await fetchE3(fixtureBytes(E3P10), ['1']);
        const asEstado3 = await fetchE3(fixtureBytes(E3P10), ['3']);
        expect(asEstado3.map((r) => r.recordId)).toEqual(asEstado1.map((r) => r.recordId));
        expect(asEstado3[0]?.fingerprint).not.toBe(asEstado1[0]?.fingerprint);
    });

    it('toSourceRecord is a pure function of the parsed tender', () => {
        const [tender] = parseListingPage(latin1(PAGE7), buildListingUrl('1', 7)).items;
        if (!tender) throw new Error('fixture has a tender');
        const a = toSourceRecord({ ...tender, estadoCompra: '1', listingPageUrl: buildListingUrl('1', 7) });
        const b = toSourceRecord({ ...tender, estadoCompra: '1', listingPageUrl: buildListingUrl('1', 7) });
        expect(a).toEqual(b);
    });
});

describe('end to end through the real router', () => {
    it('first run emits first_seen rows, an unchanged second run emits none, and a watchlist hit is matched on buyer + renglón', async () => {
        const routes = { [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: fixtureBytes(PAGE99) };
        const input = { sources: ['ar_tucuman'], sourceOptions: { ar_tucuman: { estados: ['3'] } }, watchlistNames: ['rentas'], deltaMode: 'onlyChanged' };
        const store = new InMemoryDeltaStore();
        const first = await runThroughRouter(arTucumanConnector, input, makeCtx(pagesHandler(routes)), store);
        expect(first.rows.map((r) => r.record_id)).toEqual(['1547', '1554', '1545', '1539', '1530']);
        expect(first.rows.map((r) => r.is_watchlist_match)).toEqual([false, false, false, false, true]); // DIRECCION GRAL. RENTAS
        expect(first.rows[4]).toMatchObject({ source: 'ar_tucuman', engine: 'latam-global-tender-intelligence', matched_watchlist_keyword: 'rentas', delta_status: 'first_seen' });
        expect(first.summary.watchlist.hitsCharged).toBe(1);

        const second = await runThroughRouter(arTucumanConnector, input, makeCtx(pagesHandler(routes)), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 5, unchanged: 5 });
    });

    it('never bills a hit for blank / whitespace / one-character watchlist entries (ghost-billing guard)', async () => {
        const routes = { [buildListingUrl('3', 1)]: fixtureBytes(E3P10), [buildListingUrl('3', 2)]: fixtureBytes(PAGE99) };
        for (const watchlistNames of [[''], ['   '], 'a', ['e']]) {
            const run = await runThroughRouter(arTucumanConnector, { sources: ['ar_tucuman'], sourceOptions: { ar_tucuman: { estados: ['3'] } }, watchlistNames }, makeCtx(pagesHandler(routes)));
            expect(run.rows).toHaveLength(5);
            expect(run.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(run.summary.watchlist.hitsCharged).toBe(0);
        }
    });
});
