/**
 * ar_santafe connector tests.
 *
 * Fixtures (test/fixtures/tenders-a/, no network):
 *   - santafe.legacy.*       COPIED VERBATIM from the legacy actor santafe-compras-monitor/test/fixtures
 *                            (real captures, 2026-09-04 .. 2026-09-08): listing_ap.json (5 rows),
 *                            listing_past_end.json, detail_139013_contact_electronic.html,
 *                            detail_139031_usd_notes.html, detail_nonexistent.html.
 *   - santafe.live-2026-10-21.*  REAL responses captured in THIS port session with curl (limit=3 listings
 *                            for AP / ET / CO, and gestion.php?idGestion=139530).
 * Inline strings below are SYNTHETIC and are labelled where used (maintenance page, a refused-parameter
 * JSON body, a 3-entry excerpt of the real organismos combo list).
 */
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
    arSantaFeConnector,
    arSantaFeOptionsSchema,
    buildPayload,
    detailPath,
    documentKind,
    estadoCodeFromLabel,
    extractEmails,
    extractPhones,
    isElectronicExpediente,
    listingPath,
    type ListingFilters,
    type ListingQuery,
    parseDetailPage,
    parseListingResponse,
    parseMoney,
    parseSiteDateTime,
    parseSiteDetailDateTime,
    resolveByName,
    resolveDate,
    SANTAFE_SOURCE_ID,
    valorPliegoIsFree,
} from '../latam-global-tender-intelligence/connectors/arSantaFe.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter, type StubRequest } from './tenders-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };

const LEGACY_AP = fixture('santafe.legacy.listing_ap.json');
const PAST_END = fixture('santafe.legacy.listing_past_end.json');
const LIVE_AP = fixture('santafe.live-2026-10-21.listing_ap_limit3.json');
const LIVE_ET = fixture('santafe.live-2026-10-21.listing_et_limit3.json');
const LIVE_CO = fixture('santafe.live-2026-10-21.listing_co_limit3.json');
const LIVE_DETAIL_139530 = fixture('santafe.live-2026-10-21.detail_139530.html');
const DETAIL_CONTACT = fixture('santafe.legacy.detail_139013_contact_electronic.html');
const DETAIL_USD = fixture('santafe.legacy.detail_139031_usd_notes.html');
const DETAIL_NONE = fixture('santafe.legacy.detail_nonexistent.html');

/** SYNTHETIC: what a maintenance page looks like (HTML, not the JSON the listing endpoint returns). */
const MAINTENANCE_HTML = '<html><body><h1>Sitio en mantenimiento</h1></body></html>';
/** SYNTHETIC: a refused-parameter JSON body in the shape the API uses for errors. */
const REFUSED_JSON = JSON.stringify({ success: false, errors: { reason: 'Parámetro inválido' }, data: [] });
/** EXCERPT (first three entries, verbatim) of the live shared.getOrganismosLey response captured 2026-10-21. */
const ORGANISMOS_EXCERPT = JSON.stringify({
    success: true,
    errors: { reason: 'Ok' },
    data: [
        { idOrganismoLey12510: '27', nombre: 'ADMINISTRACIÓN PROVINCIAL DE IMPUESTOS' },
        { idOrganismoLey12510: '164', nombre: 'AEROPUERTO DE SAUCE VIEJO' },
        { idOrganismoLey12510: '32', nombre: 'AEROPUERTO INTERNACIONAL DE ROSARIO' },
    ],
});

const BASE = 'https://www.santafe.gov.ar';

function params(url: string): URLSearchParams {
    return new URL(url).searchParams;
}

/** Rewrites a listing fixture's `data` array (keeps totalRecords/extraData). */
function withRows(body: string, mutate: (rows: Array<Record<string, string>>) => Array<Record<string, string>>): string {
    const page = JSON.parse(body) as { data: Array<Record<string, string>> };
    page.data = mutate(page.data);
    return JSON.stringify(page);
}

/**
 * Serves listings per estado (start=0 returns the fixture, any later start returns the empty past-the-end page)
 * and details per idGestion. Anything else throws.
 */
function santaFeHandler(opts: {
    listings?: Partial<Record<'AP' | 'ET' | 'CO', string>>;
    details?: Record<string, string | Error>;
    organismos?: string;
}) {
    return (request: StubRequest) => {
        const url = new URL(request.url);
        const a = url.searchParams.get('a');
        if (a === 'consultas.getContrataciones') {
            const estado = url.searchParams.get('estado') as 'AP' | 'ET' | 'CO';
            const start = Number(url.searchParams.get('start'));
            const body = opts.listings?.[estado];
            if (body === undefined) throw new Error(`unrouted estado ${estado}`);
            return start === 0 ? body : withRows(body, () => []);
        }
        if (a === 'shared.getOrganismosLey') {
            if (opts.organismos === undefined) throw new Error('unrouted organismos combo');
            return opts.organismos;
        }
        if (url.pathname.endsWith('/gestion.php')) {
            const id = url.searchParams.get('idGestion') ?? '';
            const detail = opts.details?.[id];
            if (detail === undefined) throw new HttpStatusError(request.url, 404, '');
            return detail;
        }
        throw new Error(`unrouted URL in test: ${request.url}`);
    };
}

function parseOptions(input: Record<string, unknown> = {}) {
    return arSantaFeOptionsSchema.parse(input);
}

const ALL_FILTERS: ListingFilters = {
    anio: 2026,
    objeto: 'limpieza',
    tipoGestion: ['L'],
    tipoModalidad: '2',
    comprador: '27',
    solicitante: '28',
    idEspecie: '57',
    idFamilia: '226',
    nroGestion: '02',
    nroExpediente: 'EE-1',
    sortBy: 'openingSoonest',
};

describe('listing parser (legacy + live fixtures)', () => {
    it('parses the legacy 5-row AP capture and its totals', () => {
        const page = parseListingResponse(LEGACY_AP);
        expect(page.isListingPage).toBe(true);
        expect(page.items.map((i) => i.idGestion)).toEqual(['138825', '138867', '138861', '138772', '138997']);
        expect(page.totalRecords).toBe(95);
        expect(page.totals).toEqual({ AP: 95, ET: 2188, CO: 28918 });
        expect(page.items[0]).toMatchObject({
            tipoGestion: 'LICITACIÓN PÚBLICA',
            numeroGestion: '18',
            anioGestion: '2026',
            fechaHoraAperturaFija: '2026-09-04 09:30:00',
            comprador: 'HOSPITAL PROVINCIAL DE NIÑOS ZONA NORTE DR. ROBERTO M. CARRA ROSARIO',
        });
    });

    it('parses the live 2026-10-21 captures; ET and CO rows carry `destinos`, AP rows do not', () => {
        const ap = parseListingResponse(LIVE_AP);
        const et = parseListingResponse(LIVE_ET);
        const co = parseListingResponse(LIVE_CO);
        expect(ap.items.map((i) => i.idGestion)).toEqual(['139530', '139529', '139528']);
        expect(ap.totals).toEqual({ AP: 98, ET: 2437, CO: 29170 });
        expect(ap.items[0]?.destinos).toBeUndefined();
        expect(et.items.every((i) => typeof i.destinos === 'string')).toBe(true);
        expect(co.items.every((i) => typeof i.destinos === 'string')).toBe(true);
        expect(et.totalRecords).toBe(2437);
        expect(co.totalRecords).toBe(29170);
    });

    it('treats a past-the-end page as a valid listing page with zero rows (not a failure)', () => {
        const page = parseListingResponse(PAST_END);
        expect(page.isListingPage).toBe(true);
        expect(page.items).toEqual([]);
    });

    it('rejects a maintenance page, a refused-parameter body and a row without a numeric idGestion', () => {
        expect(parseListingResponse(MAINTENANCE_HTML).isListingPage).toBe(false);
        const refused = parseListingResponse(REFUSED_JSON);
        expect(refused.isListingPage).toBe(false);
        expect(refused.reason).toBe('Parámetro inválido');
        const badRow = withRows(LIVE_AP, (rows) => [{ ...(rows[0] as Record<string, string>), idGestion: 'abc' }]);
        expect(parseListingResponse(badRow).isListingPage).toBe(false);
    });
});

describe('detail parser (legacy + live fixtures)', () => {
    it('parses the live 2026-10-21 page for idGestion 139530', () => {
        const d = parseDetailPage(cheerio.load(LIVE_DETAIL_139530));
        expect(d.exists).toBe(true);
        expect(d.title).toBe('CONTRATACIÓN DIRECTA Nº 29/2026');
        expect(d.tipoGestionName).toBe('CONTRATACIÓN DIRECTA');
        expect(d.numeroGestion).toBe('29');
        expect(d.anioGestion).toBe('2026');
        expect(d.estadoCode).toBe('AP');
        expect(d.publishedAtLocal).toBe('20-10-2026 12:38 Hs.');
        expect(d.submissionDeadlineLocal).toBe('23-10-2026 08:30 Hs.');
        expect(d.montoOriginalText).toBe('$ 58.500.000,00');
        expect(d.organismoLicitante).toBe('HOSPITAL SAMCO DE SANTO TOME');
        expect(d.rubros.map((r) => r.rubro)).toEqual(['PROD.MEDICINALES-PROD.QUIM.-INSUMOS P/ENV.MEDICINALES', 'PROD.MEDICINALES-PROD.QUIM.-INSUMOS P/ENV.MEDICINALES']);
        expect(d.rubros.map((r) => r.subrubro)).toEqual(['MEDICAMENTOS ALTO COSTO', 'PRODUCTOS MEDICINALES PARA USO HUMANO']);
        expect(d.documents).toHaveLength(1);
        expect(d.documents[0]).toMatchObject({ kind: 'pliego', id: '174539', nombre: 'SOLICITUD DE PRESUPUESTO Nº 29' });
        expect(d.documents[0]?.url.startsWith('https://www.santafe.gov.ar/gestionesdecompras/descargar.php?')).toBe(true);
    });

    it('parses the legacy electronic-expediente page (contact + expediente link)', () => {
        const d = parseDetailPage(cheerio.load(DETAIL_CONTACT));
        expect(d.title).toBe('CONTRATACIÓN DIRECTA Nº 68/2026');
        expect(d.expedientes[0]).toMatchObject({ label: 'EXPEDIENTE NÚMERO', code: 'EE-2026-00044356-APPSF-OD' });
        expect(d.contactInfo).toBe('+54 9 342 45196329 O 342-4910056');
        expect(extractPhones(d.contactInfo)).toEqual(['+54 9 342 45196329', '342-4910056']);
        expect(isElectronicExpediente(d.expedientes[0]?.code)).toBe(true);
    });

    it('parses the legacy USD page with free-form IMPORTANTE notes and several documents', () => {
        const d = parseDetailPage(cheerio.load(DETAIL_USD));
        expect(d.montoOriginalText).toBe('U$S 60.000,00');
        expect(parseMoney(d.montoOriginalText)).toEqual({ amount: 60000, currency: 'USD' });
        expect(d.notes).toHaveLength(3);
        expect(d.notes[0]).toContain('IMPORTANTE CRONOGRAMA');
        expect(d.documents.map((x) => `${x.kind}:${x.id}`)).toEqual(['pliego:171910', 'pliego:171911', 'otros:171912', 'otros:171913']);
        expect(extractEmails(d.contactInfo)).toEqual(['comprasmgp@santafe.gov.ar']);
    });

    it('reports a nonexistent / unpublished id as exists=false', () => {
        const d = parseDetailPage(cheerio.load(DETAIL_NONE));
        expect(d.exists).toBe(false);
        expect(d.title).toBeNull();
    });
});

describe('pure helpers', () => {
    it('converts Santa Fe wall-clock (fixed UTC-3, no DST) to UTC instants', () => {
        expect(parseSiteDateTime('2026-09-04 09:30:00')).toBe('2026-09-04T12:30:00.000Z');
        expect(parseSiteDateTime('1969-12-31 21:00:00')).toBeNull(); // the epoch placeholder is out of the valid range
        expect(parseSiteDateTime('')).toBeNull();
        expect(parseSiteDetailDateTime('23-10-2026 08:30 Hs.')).toBe('2026-10-23T11:30:00.000Z');
        expect(parseSiteDetailDateTime('04-09-2026 09:30 Hs. -  (*** NUEVA FECHA ***)')).toBe('2026-09-04T12:30:00.000Z');
        expect(parseSiteDetailDateTime('31-02-2026')).not.toBeNull(); // calendar overflow is the legacy behaviour (validYmd only bounds day <= 31)
        expect(parseSiteDetailDateTime('99-99-2026')).toBeNull();
    });

    it('parses Argentine money strings', () => {
        expect(parseMoney('$  207.302.040,00')).toEqual({ amount: 207302040, currency: 'ARS' });
        expect(parseMoney('$  7.00')).toEqual({ amount: 7, currency: 'ARS' });
        expect(parseMoney('$  480.-')).toEqual({ amount: 480, currency: 'ARS' });
        expect(parseMoney('NO APLICA')).toBeNull();
        expect(valorPliegoIsFree('NO APLICA')).toBe(true);
        expect(valorPliegoIsFree('$ 1.500,00')).toBe(false);
        expect(valorPliegoIsFree('')).toBeNull();
    });

    it('maps estado labels and document kinds', () => {
        expect(estadoCodeFromLabel('EN TRÁMITE  - Análisis de ofertas')).toBe('ET');
        expect(estadoCodeFromLabel('CONCLUIDA')).toBe('CO');
        expect(estadoCodeFromLabel('otra cosa')).toBeNull();
        expect(documentKind('Informe de Preadjudicación')).toBe('preadjudicacion');
        expect(documentKind('Norma Legal de Adjudicación')).toBe('adjudicacion');
        expect(documentKind('algo raro')).toBe('otros');
    });

    it('resolves relative dates against the injected clock in Santa Fe time', () => {
        const now = new Date('2026-10-21T01:00:00Z'); // 22:00 on the 20th in Santa Fe
        expect(resolveDate('today', now, 'f')).toBe('2026-10-20');
        expect(resolveDate('7 days', now, 'f')).toBe('2026-10-13');
        expect(resolveDate('+30 days', now, 'f')).toBe('2026-11-19');
        expect(resolveDate('2026-07-01', now, 'f')).toBe('2026-07-01');
        expect(() => resolveDate('next tuesday', now, 'openingTo')).toThrow(/openingTo must be YYYY-MM-DD/);
    });

    it('resolves organismo names accent- and case-insensitively, and refuses ambiguity', () => {
        const entries = JSON.parse(ORGANISMOS_EXCERPT).data.map((d: Record<string, string>) => ({ id: d.idOrganismoLey12510 as string, name: d.nombre as string }));
        expect(resolveByName('comprador', 'administracion provincial de impuestos', entries).id).toBe('27');
        expect(resolveByName('comprador', 'sauce', entries).id).toBe('164');
        expect(resolveByName('comprador', '999', entries).id).toBe('999');
        expect(() => resolveByName('comprador', 'aeropuerto', entries)).toThrow(/ambiguous/);
        expect(() => resolveByName('comprador', 'zzz', entries)).toThrow(/matches none/);
    });
});

describe('URL building', () => {
    it('emits exactly the live-verified parameter names, with a single tipoGestion code', () => {
        const query: ListingQuery = { estado: 'ET', tipoGestion: 'L', filters: ALL_FILTERS };
        const url = new URL(`${BASE}${listingPath(query, 40, 60)}`);
        expect(url.pathname).toBe('/gestionesdecompras/site/AppAjax.php');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            a: 'consultas.getContrataciones',
            estado: 'ET',
            anio: '2026',
            objeto: 'limpieza',
            tipoGestion: 'L',
            tipoModalidad: '2',
            comprador: '27',
            solicitante: '28',
            idEspecie: '57',
            idFamilia: '226',
            nroGestion: '02',
            nroExpediente: 'EE-1',
            sort: 'fechaHoraApertura',
            dir: 'ASC',
            start: '40',
            limit: '60',
        });
    });

    it('omits unset filters and never emits the view-counter variant of the detail page', () => {
        const query: ListingQuery = {
            estado: 'AP',
            tipoGestion: null,
            filters: { ...ALL_FILTERS, anio: null, objeto: null, tipoGestion: [], tipoModalidad: null, comprador: null, solicitante: null, idEspecie: null, idFamilia: null, nroGestion: null, nroExpediente: null, sortBy: 'newest' },
        };
        const sp = new URL(`${BASE}${listingPath(query, 0, 50)}`).searchParams;
        expect([...sp.keys()].sort()).toEqual(['a', 'dir', 'estado', 'limit', 'sort', 'start']);
        expect(sp.get('sort')).toBe('idGestion');
        expect(sp.get('dir')).toBe('DESC');
        expect(detailPath('139530')).toBe('/gestionesdecompras/site/gestion.php?idGestion=139530');
        expect(detailPath('139530')).not.toContain('contar');
    });
});

describe('options validation', () => {
    it('applies the documented defaults', () => {
        expect(parseOptions()).toEqual({ estados: ['AP'], tipoGestion: [], sortBy: 'newest', fetchDetail: true, maxConcurrency: 5 });
    });

    it('treats blank strings as "not set" and normalises tipoGestion codes', () => {
        const o = parseOptions({ objeto: '   ', comprador: '', anio: '', tipoGestion: ['p', 'L', 'p'], tipoModalidad: '2' });
        expect(o.objeto).toBeUndefined();
        expect(o.comprador).toBeUndefined();
        expect(o.anio).toBeUndefined();
        expect(o.tipoGestion).toEqual(['L', 'P']);
        expect(o.tipoModalidad).toBe('2');
    });

    it('rejects unknown keys, unknown codes, an empty estados list, a subrubro without rubro and bad dates', () => {
        expect(arSantaFeOptionsSchema.safeParse({ estado: 'AP' }).success).toBe(false); // legacy singular typo, strict schema
        expect(arSantaFeOptionsSchema.safeParse({ tipoGestion: ['ZZ'] }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ tipoModalidad: '42' }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ estados: [] }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ estados: ['XX'] }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ subrubro: 'x' }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ openingFrom: 'soonish' }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ maxConcurrency: 99 }).success).toBe(false);
        expect(arSantaFeOptionsSchema.safeParse({ anio: 1850 }).success).toBe(false);
    });

    it('needs no credential: requiredOptions is empty, so an empty sourceOptions slice passes preflight', () => {
        expect(arSantaFeConnector.requiredOptions ?? []).toEqual([]);
        const input = EngineInputSchema.parse({ sources: ['AR_SantaFe'] });
        const resolved = resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arSantaFeConnector] }, input);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.connector.id).toBe(SANTAFE_SOURCE_ID);
    });

    it('fails preflight (FatalConfigError) on an invalid options slice, before any network call', () => {
        const input = EngineInputSchema.parse({ sources: ['ar_santafe'], sourceOptions: { ar_santafe: { tipoGestion: ['ZZ'] } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arSantaFeConnector] }, input)).toThrow(/Invalid options for "ar_santafe"/);
    });
});

describe('fetch (stubbed http)', () => {
    it('listing only: maps live rows to SourceRecords with stable ids, a fingerprint and a buyer+object watchText', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['139530', '139529', '139528']);
        const first = records[0];
        expect(first?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(first?.watchText).toBe('HOSPITAL SAMCO DE SANTO TOME MEDICAMENTOS VARIOS');
        expect(first?.payload).toMatchObject({
            idGestion: '139530',
            estado: 'AP',
            tipoGestion: 'CONTRATACIÓN DIRECTA',
            fechaHoraApertura: '23-10-2026',
            comprador: 'HOSPITAL SAMCO DE SANTO TOME',
            objeto: 'MEDICAMENTOS VARIOS',
            tipoGestionCode: 'T',
            openingAt: '2026-10-23T12:00:00.000Z',
            openingDate: '2026-10-23',
            daysUntilOpening: 2,
            isOpeningInFuture: true,
            detailFetched: false,
            contentHash: null,
            source_url: 'https://www.santafe.gov.ar/gestionesdecompras/site/gestion.php?idGestion=139530',
        });
        for (const key of ROUTER_OWNED_KEYS) expect(first?.payload).not.toHaveProperty(key);
        expect(first?.payload).not.toHaveProperty('event_type');
        // The fixture says totalRecords=98 but serves 3 rows, so the walk asks for start=3 and gets the empty past-the-end page.
        expect(stub.calls.map((c) => [params(c.url).get('start'), params(c.url).get('limit')])).toEqual([
            ['0', '100'],
            ['3', '97'],
        ]);
    });

    it('stops paging once totalRecords is reached and requests only the rows still needed', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
        const result = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), { maxItemsPerSource: 2 });
        expect(result.map((r) => r.recordId)).toEqual(['139530', '139529']);
        expect(params(stub.calls[0]?.url ?? '').get('limit')).toBe('50');
        expect(params(stub.calls[0]?.url ?? '').get('start')).toBe('0');
        expect(stub.calls).toHaveLength(1); // cap reached inside page 1: no second request
    });

    it('pages with `start` until an empty page when totalRecords is larger than the rows served', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LEGACY_AP } })); // totalRecords 95, only 5 rows served
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN);
        expect(records).toHaveLength(5);
        expect(stub.calls.map((c) => params(c.url).get('start'))).toEqual(['0', '5']);
        expect(stub.logs.info.some((m) => m.includes('no rows - end of list'))).toBe(true);
    });

    it('walks several estados in the order given and de-duplicates by idGestion', async () => {
        const dup = withRows(LIVE_ET, (rows) => [{ ...(rows[0] as Record<string, string>), idGestion: '139530' }, ...rows.slice(1)]);
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP, ET: dup, CO: LIVE_CO } }));
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false, estados: ['AP', 'ET', 'CO'] }), { maxItemsPerSource: 100 });
        expect(records.map((r) => r.recordId)).toEqual(['139530', '139529', '139528', '139503', '139487', '139424', '139375', '139356']);
        expect(records.map((r) => r.payload.estado)).toEqual(['AP', 'AP', 'AP', 'ET', 'ET', 'CO', 'CO', 'CO']);
        // 139530 was served first by AP; the ET duplicate did not displace it
    });

    it('runs one query per tipoGestion code', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
        await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false, tipoGestion: ['L', 'T'] }), RUN);
        const types = stub.calls.map((c) => params(c.url).get('tipoGestion')).filter((t) => t !== null);
        expect(new Set(types)).toEqual(new Set(['L', 'T']));
    });

    it('applies the client-side opening window in Santa Fe calendar dates', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }), { now: '2026-10-21T12:00:00Z' });
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false, openingFrom: '2026-10-24', openingTo: '+10 days' }), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['139528']); // 2026-10-26 only
        const none = await arSantaFeConnector.fetch(makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } })).ctx, parseOptions({ fetchDetail: false, openingFrom: '2027-01-01' }), RUN);
        expect(none).toEqual([]);
    });

    it('rejects an inverted opening window as an option error', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
        await expect(arSantaFeConnector.fetch(stub.ctx, parseOptions({ openingFrom: '2026-12-01', openingTo: '2026-11-01' }), RUN)).rejects.toThrow(/openingFrom is after openingTo/);
        expect(stub.calls).toHaveLength(0);
    });

    it('with fetchDetail: enriches ok pages, keeps UNPUBLISHED records, drops records whose detail request failed', async () => {
        const stub = makeCtx(
            santaFeHandler({
                listings: { AP: LIVE_AP },
                details: { '139530': LIVE_DETAIL_139530, '139529': DETAIL_NONE, '139528': new Error('connection reset') },
            }),
        );
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['139530', '139529']); // 139528 left out -> retried next run
        const enriched = records[0]?.payload;
        expect(enriched).toMatchObject({
            detailFetched: true,
            detailError: null,
            estadoLabel: 'PARA APERTURA',
            publishedAt: '2026-10-20T15:38:00.000Z',
            submissionDeadline: '2026-10-23T11:30:00.000Z',
            daysUntilDeadline: 2,
            montoOriginalAmount: 58500000,
            montoOriginalCurrency: 'ARS',
            hasPliego: true,
            documentCount: 1,
            organismoLicitante: 'HOSPITAL SAMCO DE SANTO TOME',
        });
        expect(typeof (enriched as Record<string, unknown>).contentHash).toBe('string');
        expect(records[1]?.payload).toMatchObject({ detailFetched: false, detailError: 'UNPUBLISHED', contentHash: null });
        expect(stub.logs.warning.some((m) => m.includes('detail fetch failed for idGestion=139528'))).toBe(true);
        expect(stub.logs.warning.some((m) => m.includes('1 record(s) left out'))).toBe(true);
    });

    it('treats a 404 detail page as UNPUBLISHED, not as an error', async () => {
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP }, details: {} })); // every detail -> HttpStatusError 404
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions(), RUN);
        expect(records).toHaveLength(3);
        expect(records.every((r) => r.payload.detailError === 'UNPUBLISHED')).toBe(true);
    });

    it('fails the source when EVERY detail request fails', async () => {
        const boom = new Error('socket hang up');
        const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP }, details: { '139530': boom, '139529': boom, '139528': boom } }));
        await expect(arSantaFeConnector.fetch(stub.ctx, parseOptions(), RUN)).rejects.toThrow(/All 3 detail request\(s\) failed/);
    });

    it('raises SourceFetchError when the listing request fails', async () => {
        const stub = makeCtx(() => new Error('getaddrinfo ENOTFOUND www.santafe.gov.ar'));
        const error = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('ar_santafe');
        expect((error as SourceFetchError).message).toContain('ENOTFOUND');
    });

    it('retries a non-listing body twice and then fails loudly instead of reporting "nothing new"', async () => {
        const stub = makeCtx(() => MAINTENANCE_HTML);
        const error = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).message).toContain('not a Gestiones de Compra listing');
        expect(stub.calls).toHaveLength(3);
        expect(stub.logs.warning).toHaveLength(2);
    });

    it('recovers when the first response is a non-listing body and the retry is a real listing', async () => {
        let n = 0;
        const stub = makeCtx((request) => {
            n += 1;
            return n === 1 ? MAINTENANCE_HTML : (santaFeHandler({ listings: { AP: LIVE_AP } })(request) as string);
        });
        const records = await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN);
        expect(records).toHaveLength(3);
    });

    it('resolves a buyer name through the organismos combo, and reports an ambiguous name as an option error', async () => {
        const ok = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP }, organismos: ORGANISMOS_EXCERPT }));
        await arSantaFeConnector.fetch(ok.ctx, parseOptions({ fetchDetail: false, comprador: 'Aeropuerto de Sauce Viejo' }), RUN);
        const listingCall = ok.calls.find((c) => params(c.url).get('a') === 'consultas.getContrataciones');
        expect(params(listingCall?.url ?? '').get('comprador')).toBe('164');

        const numeric = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } })); // a numeric id needs no combo request
        await arSantaFeConnector.fetch(numeric.ctx, parseOptions({ fetchDetail: false, comprador: '27' }), RUN);
        expect(numeric.calls.some((c) => params(c.url).get('a') === 'shared.getOrganismosLey')).toBe(false);

        const ambiguous = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP }, organismos: ORGANISMOS_EXCERPT }));
        await expect(arSantaFeConnector.fetch(ambiguous.ctx, parseOptions({ fetchDetail: false, comprador: 'aeropuerto' }), RUN)).rejects.toThrow(/Invalid sourceOptions for ar_santafe: comprador "aeropuerto" is ambiguous/);
        expect(ambiguous.calls.some((c) => params(c.url).get('a') === 'consultas.getContrataciones')).toBe(false);
    });

    it('reads the objeto phrase through the keyword guard: a 1-character or punctuation-only phrase means "no filter requested"', async () => {
        const good = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
        await arSantaFeConnector.fetch(good.ctx, parseOptions({ fetchDetail: false, objeto: '  limpieza   general ' }), RUN);
        expect(params(good.calls[0]?.url ?? '').get('objeto')).toBe('limpieza general');

        for (const bad of ['a', '--', '​​']) {
            const stub = makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } }));
            await arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false, objeto: bad }), RUN);
            expect(params(stub.calls[0]?.url ?? '').has('objeto')).toBe(false);
            expect(stub.logs.warning.some((m) => m.includes('The filter was not applied'))).toBe(true);
        }
    });
});

describe('fingerprint and recordId semantics', () => {
    async function fetchWith(listing: string, now = '2026-10-21T12:00:00Z') {
        const stub = makeCtx(santaFeHandler({ listings: { AP: listing, ET: listing } }), { now });
        return arSantaFeConnector.fetch(stub.ctx, parseOptions({ fetchDetail: false }), RUN);
    }

    it('is stable across runs and across the passage of time (time-relative fields are not fingerprinted)', async () => {
        const a = await fetchWith(LIVE_AP, '2026-10-21T12:00:00Z');
        const b = await fetchWith(LIVE_AP, '2026-10-22T12:00:00Z');
        expect(b.map((r) => r.recordId)).toEqual(a.map((r) => r.recordId));
        expect(b.map((r) => r.fingerprint)).toEqual(a.map((r) => r.fingerprint));
        expect(a[0]?.payload.daysUntilOpening).toBe(2);
        expect(b[0]?.payload.daysUntilOpening).toBe(1); // the payload value moves, the fingerprint does not
    });

    it('changes when a consumer-visible listing field changes, and the recordId does not', async () => {
        const base = await fetchWith(LIVE_AP);
        const amended = await fetchWith(withRows(LIVE_AP, (rows) => rows.map((r) => (r.idGestion === '139529' ? { ...r, valorPliego: '$ 1.000,00' } : r))));
        expect(amended.map((r) => r.recordId)).toEqual(base.map((r) => r.recordId));
        expect(amended[0]?.fingerprint).toBe(base[0]?.fingerprint);
        expect(amended[1]?.fingerprint).not.toBe(base[1]?.fingerprint);
        expect(amended[2]?.fingerprint).toBe(base[2]?.fingerprint);
    });

    it('changes when a process moves between estados (the legacy STATUS_CHANGE), keeping its recordId', async () => {
        const inAp = await arSantaFeConnector.fetch(makeCtx(santaFeHandler({ listings: { AP: LIVE_AP } })).ctx, parseOptions({ fetchDetail: false }), RUN);
        const movedToEt = await arSantaFeConnector.fetch(makeCtx(santaFeHandler({ listings: { ET: LIVE_AP } })).ctx, parseOptions({ fetchDetail: false, estados: ['ET'] }), RUN);
        expect(movedToEt.map((r) => r.recordId)).toEqual(inAp.map((r) => r.recordId));
        expect(movedToEt[0]?.payload.estado).toBe('ET');
        expect(movedToEt[0]?.fingerprint).not.toBe(inAp[0]?.fingerprint);
    });

    it('buildPayload never sets a router-owned key', () => {
        const page = parseListingResponse(LIVE_ET);
        const payload = buildPayload({ item: page.items[0] as NonNullable<(typeof page.items)[number]>, estado: 'ET', openingAt: '2026-10-20T15:00:00.000Z' }, null, new Date('2026-10-21T12:00:00Z'));
        for (const key of ROUTER_OWNED_KEYS) expect(payload).not.toHaveProperty(key);
        expect(payload.destinos).toEqual(page.items[0]?.destinos);
    });
});

describe('end to end through the real router', () => {
    it('emits rows with the router envelope, matches the watchlist on buyer+object, and is silent on an unchanged second run', async () => {
        const handler = santaFeHandler({ listings: { AP: LIVE_AP } });
        const store = new InMemoryDeltaStore();
        const input = { sources: ['ar_santafe'], sourceOptions: { ar_santafe: { fetchDetail: false } }, watchlistNames: ['hospital samco'], deltaMode: 'onlyChanged' };

        const first = await runThroughRouter(arSantaFeConnector, input, makeCtx(handler), store);
        expect(first.rows).toHaveLength(3);
        expect(first.rows.map((r) => r.record_id)).toEqual(['139530', '139529', '139528']);
        expect(first.rows.map((r) => r.is_watchlist_match)).toEqual([true, false, false]);
        expect(first.rows[0]).toMatchObject({ engine: 'latam-global-tender-intelligence', source: 'ar_santafe', delta_status: 'first_seen', is_new: true, matched_watchlist_keyword: 'hospital samco' });
        expect(first.summary.watchlist.hitsCharged).toBe(1);

        const second = await runThroughRouter(arSantaFeConnector, input, makeCtx(handler), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 3, unchanged: 3, emitted: 0 });

        // one record is amended upstream -> exactly that one is re-emitted as `updated`
        const amended = santaFeHandler({ listings: { AP: withRows(LIVE_AP, (rows) => rows.map((r) => (r.idGestion === '139528' ? { ...r, fechaHoraAperturaFija: '2026-10-27 10:00:00' } : r))) } });
        const third = await runThroughRouter(arSantaFeConnector, input, makeCtx(amended), store);
        expect(third.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['139528', 'updated']]);
    });

    it('never bills a watchlist hit for blank, whitespace-only or one-character watchlist entries (ghost-billing guard)', async () => {
        const handler = santaFeHandler({ listings: { AP: LIVE_AP } });
        for (const watchlistNames of [[''], [' '], 'a', ['a'], ['​​']]) {
            const run = await runThroughRouter(arSantaFeConnector, { sources: ['ar_santafe'], sourceOptions: { ar_santafe: { fetchDetail: false } }, watchlistNames }, makeCtx(handler));
            expect(run.rows).toHaveLength(3);
            expect(run.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(run.summary.watchlist.hitsCharged).toBe(0);
        }
    });

    it('isolates a failing source: the run completes and the summary carries the error', async () => {
        const run = await runThroughRouter(arSantaFeConnector, { sources: ['ar_santafe'], sourceOptions: { ar_santafe: { fetchDetail: false } } }, makeCtx(() => new Error('upstream down')));
        expect(run.rows).toEqual([]);
        expect(run.summary.sources[0]?.error).toContain('upstream down');
    });
});
