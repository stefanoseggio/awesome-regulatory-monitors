/**
 * cl_diario_oficial connector tests.
 *
 * Fixtures:
 *   - test/fixtures/tenders-a/diario_oficial_cl.live-2026-10-21.index_quiet_day.html: the REAL `index.php?` page
 *     fetched in this port session with Node's global fetch (a genuine quiet day: no <table>, the site's own
 *     `<p class="nofound">` notice, header "Miércoles 21 de Octubre de 2026").
 *   - diario_oficial_cl.live-2026-10-21.bom_quiet_day.html: the REAL `bom.php?` page of the same day: its `.nofound`
 *     paragraph is inside an HTML comment and the visible sentence "no hubo publicaciones del Boletín Oficial de Minería"
 *     is the notice (found by running the connector against the live site).
 *   - EDITION_HTML below: copied from the legacy actor's own parser test (diario-oficial-cl-monitor/test/parsers/
 *     table.test.ts), where its authors describe it as "reconstructed from a real fetch of index.php?date=04-09-2026
 *     &edition=44542 on 2026-09-04 - same class names, same nesting, same link/CVE format". NO populated live page
 *     was available when this port was written (every section was on a quiet day), so this is reconstructed, not a capture.
 *   - Every other HTML string is SYNTHETIC and labelled where used (a no-CVE row, the bot-check stub, a redesigned page).
 */
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
    buildSectionUrl,
    classifySectionPage,
    clDiarioOficialConnector,
    clDiarioOficialOptionsSchema,
    DIARIO_OFICIAL_SOURCE_ID,
    hasNoPublicationsNotice,
    isBotCheckStub,
    parseTable,
    recordIdOf,
    resolveEdition,
    SECTION_NAMES,
    SECTION_PATHS,
    toSourceRecord,
} from '../latam-global-tender-intelligence/connectors/clDiarioOficial.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter, type StubRequest } from './tenders-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const QUIET_DAY = fixture('diario_oficial_cl.live-2026-10-21.index_quiet_day.html');
const BOM_QUIET_DAY = fixture('diario_oficial_cl.live-2026-10-21.bom_quiet_day.html');

const EDITION_HTML = [
    '<table cellmargin="10">',
    '<tr><td class="title1">Sumario</td><td></td></tr>',
    '<tr><td class="title2">Normas Generales</td><td></td></tr>',
    '<tr><td class="title3">PODER EJECUTIVO</td><td></td></tr>',
    '<tr><td class="title4">MINISTERIO DE ECONOMIA, FOMENTO Y TURISMO</td><td></td></tr>',
    '<tr><td class="title5">Subsecretaria de Pesca y Acuicultura</td><td></td></tr>',
    '<tr class="content">',
    '<td>Extracto de resolucion exenta numero 2.092, de 2026.- Modifica resolucion N 159 exenta, de 2026</td>',
    '<td><a target="_blank" href="https://www.diariooficial.interior.gob.cl/publicaciones/2026/09/04/44542/01/2865015.pdf" title="">Ver PDF (CVE-2865015)</a></td>',
    '</tr>',
    '<tr><td class="title4">MINISTERIO DE TRANSPORTES Y TELECOMUNICACIONES</td><td></td></tr>',
    '<tr><td class="title5">Subsecretaria de Telecomunicaciones</td><td></td></tr>',
    '<tr class="content">',
    '<td>Resolucion exenta numero 1.545, de 2026.- Aprueba norma tecnica</td>',
    '<td><a target="_blank" href="https://www.diariooficial.interior.gob.cl/publicaciones/2026/09/04/44542/01/2863871.pdf" title="">Ver PDF (CVE-2863871)</a></td>',
    '</tr>',
    '</table>',
].join('\n');

/** SYNTHETIC: a row whose link text carries no CVE (the legacy "disclosed edge case"), under a heading-less ministry. */
const NO_CVE_HTML = [
    '<table>',
    '<tr><td class="title3">PODER LEGISLATIVO</td><td></td></tr>',
    '<tr class="content"><td>Ley numero 21.999.- Sin codigo de verificacion en el enlace</td>',
    '<td><a href="https://www.diariooficial.interior.gob.cl/publicaciones/2026/10/21/45000/01/ley.pdf">Ver PDF</a></td></tr>',
    '<tr class="content"><td>Fila sin enlace alguno</td><td></td></tr>',
    '</table>',
].join('\n');

/** SYNTHETIC: the JavaScript bot-check stub (~6 KB in reality): no table, a `bobcmn` marker variable. */
const BOT_CHECK_STUB = '<html><head><script>window["bobcmn"] = "1010101010";</script></head><body></body></html>';
/** SYNTHETIC: a redesigned page: HTTP 200, a table with unknown classes and no "nothing published" notice. */
const REDESIGNED = '<html><body><table><tr><td class="x">algo nuevo</td></tr></table></body></html>';

const URL_INDEX = buildSectionUrl('normas_generales');
const NOW = '2026-10-21T12:00:00Z';

function sectionHandler(pages: Partial<Record<string, string | Error>>) {
    return (request: StubRequest) => {
        const page = pages[request.url];
        if (page === undefined) throw new Error(`unrouted URL in test: ${request.url}`);
        return page;
    };
}

describe('URLs and edition', () => {
    it('builds the bare /edicionelectronica/ URLs (never the root page, never date/edition parameters)', () => {
        expect(URL_INDEX).toBe('https://www.diariooficial.interior.gob.cl/edicionelectronica/index.php?');
        expect(buildSectionUrl('marcas_patentes')).toBe('https://www.diariooficial.interior.gob.cl/edicionelectronica/marcas_patentes.php?');
        expect(SECTION_NAMES).toHaveLength(7);
        for (const name of SECTION_NAMES) {
            const url = buildSectionUrl(name);
            expect(url).toBe(`https://www.diariooficial.interior.gob.cl/edicionelectronica/${SECTION_PATHS[name]}?`);
            expect(url).not.toMatch(/date=|edition=/);
        }
    });

    it('resolves "today" in Santiago from the injected clock, across the DST switch', () => {
        expect(resolveEdition(new Date('2026-10-21T12:00:00Z'))).toEqual({ fecha: '21-10-2026', edicion: '20261021' });
        // Chile is on summer time (UTC-3) in October: 01:00Z is still the evening of the 20th
        expect(resolveEdition(new Date('2026-10-21T01:00:00Z'))).toEqual({ fecha: '20-10-2026', edicion: '20261020' });
        expect(resolveEdition(new Date('2026-10-21T03:30:00Z'))).toEqual({ fecha: '21-10-2026', edicion: '20261021' });
        // winter time (UTC-4) in July: 02:00Z is 22:00 on the previous day
        expect(resolveEdition(new Date('2026-07-01T02:00:00Z'))).toEqual({ fecha: '30-06-2026', edicion: '20260630' });
    });
});

describe('parseTable', () => {
    const opts = { seccion: 'normas_generales' as const, edicion: '20260904', fecha: '04-09-2026' };

    it('tracks the rama / ministerio / organismo hierarchy per content row and extracts the CVE and PDF link', () => {
        const { entries, headingsEncountered, noPublicationsNoticeFound } = parseTable(cheerio.load(EDITION_HTML), opts);
        expect(headingsEncountered).toBe(true);
        expect(noPublicationsNoticeFound).toBe(false);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual({
            rama: 'PODER EJECUTIVO',
            ministerio: 'MINISTERIO DE ECONOMIA, FOMENTO Y TURISMO',
            organismo: 'Subsecretaria de Pesca y Acuicultura',
            descripcion: 'Extracto de resolucion exenta numero 2.092, de 2026.- Modifica resolucion N 159 exenta, de 2026',
            pdfUrl: 'https://www.diariooficial.interior.gob.cl/publicaciones/2026/09/04/44542/01/2865015.pdf',
            cve: '2865015',
            seccion: 'normas_generales',
            edicion: '20260904',
            fecha: '04-09-2026',
        });
        // a new title5 resets organismo but not ministerio; a new title4 resets both
        expect(entries[1]).toMatchObject({ rama: 'PODER EJECUTIVO', ministerio: 'MINISTERIO DE TRANSPORTES Y TELECOMUNICACIONES', organismo: 'Subsecretaria de Telecomunicaciones' });
    });

    it('reads the REAL live quiet-day page as zero entries with the site\'s own notice and no headings', () => {
        const result = parseTable(cheerio.load(QUIET_DAY), opts);
        expect(result).toEqual({ entries: [], headingsEncountered: false, noPublicationsNoticeFound: true });
    });

    it('reads the REAL live bom page (its .nofound notice is commented out; a visible "no hubo publicaciones" sentence replaces it) as a quiet day', () => {
        expect(BOM_QUIET_DAY).toContain('<!--<p class="nofound">');
        const bomOpts = { ...opts, seccion: 'bom' as const };
        const result = parseTable(cheerio.load(BOM_QUIET_DAY), bomOpts);
        expect(result).toEqual({ entries: [], headingsEncountered: false, noPublicationsNoticeFound: true });
        expect(classifySectionPage(BOM_QUIET_DAY, result)).toBe('quiet-day');
        expect(hasNoPublicationsNotice(cheerio.load('<body><!--<p class="nofound">x</p>--><p>algo</p></body>'))).toBe(false); // a commented-out notice alone is not a notice
        expect(hasNoPublicationsNotice(cheerio.load('<body><p>En la edición del día X, no hubo publicaciones del Boletín</p></body>'))).toBe(true);
    });

    it('keeps the two signals separate: headings without rows, and a table that is neither', () => {
        expect(parseTable(cheerio.load('<table><tr><td class="title3">PODER EJECUTIVO</td></tr></table>'), opts)).toEqual({ entries: [], headingsEncountered: true, noPublicationsNoticeFound: false });
        expect(parseTable(cheerio.load(REDESIGNED), opts)).toEqual({ entries: [], headingsEncountered: false, noPublicationsNoticeFound: false });
    });

    it('classifies pages: publications, quiet day (notice or headings), bot-check stub, unrecognised', () => {
        const kind = (html: string) => classifySectionPage(html, parseTable(cheerio.load(html), opts));
        expect(kind(EDITION_HTML)).toBe('publications');
        expect(kind(QUIET_DAY)).toBe('quiet-day');
        expect(kind('<table><tr><td class="title3">PODER EJECUTIVO</td></tr></table>')).toBe('quiet-day');
        expect(kind(BOT_CHECK_STUB)).toBe('bot-check');
        expect(kind(REDESIGNED)).toBe('unrecognised');
        expect(isBotCheckStub(QUIET_DAY)).toBe(false);
    });
});

describe('options validation', () => {
    it('defaults to the one section the legacy actor confirmed end to end', () => {
        expect(clDiarioOficialOptionsSchema.parse({})).toEqual({ sections: ['normas_generales'] });
        expect(clDiarioOficialOptionsSchema.parse({ sections: ['bom', 'marcas_patentes'] })).toEqual({ sections: ['bom', 'marcas_patentes'] });
    });

    it('rejects unknown sections, an empty list and unknown keys in preflight', () => {
        for (const bad of [{ sections: ['normas'] }, { sections: [] }, { sections: 'bom' }, { date: '2026-10-21' }, { onlyNew: true }]) {
            expect(clDiarioOficialOptionsSchema.safeParse(bad).success).toBe(false);
        }
        const input = EngineInputSchema.parse({ sources: ['cl_diario_oficial'], sourceOptions: { cl_diario_oficial: { sections: ['nope'] } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [clDiarioOficialConnector] }, input)).toThrow(/Invalid options for "cl_diario_oficial"/);
    });

    it('needs no credential: an empty slice passes preflight', () => {
        expect(clDiarioOficialConnector.requiredOptions ?? []).toEqual([]);
        const input = EngineInputSchema.parse({ sources: ['CL_Diario_Oficial'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [clDiarioOficialConnector] }, input)).toHaveLength(1);
    });
});

describe('fetch (stubbed http)', () => {
    const options = (input: Record<string, unknown> = {}) => clDiarioOficialOptionsSchema.parse(input);

    it('maps publications to SourceRecords: CVE as id, legacy fields, PDF as source_url, ministry + agency + description as watchText', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML }), { now: NOW });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN);
        expect(stub.calls.map((c) => c.url)).toEqual([URL_INDEX]);
        expect(records.map((r) => r.recordId)).toEqual(['2865015', '2863871']);
        const first = records[0];
        expect(first?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(first?.watchText).toBe(
            'MINISTERIO DE ECONOMIA, FOMENTO Y TURISMO Subsecretaria de Pesca y Acuicultura Extracto de resolucion exenta numero 2.092, de 2026.- Modifica resolucion N 159 exenta, de 2026',
        );
        expect(first?.payload).toMatchObject({
            rama: 'PODER EJECUTIVO',
            ministerio: 'MINISTERIO DE ECONOMIA, FOMENTO Y TURISMO',
            organismo: 'Subsecretaria de Pesca y Acuicultura',
            cve: '2865015',
            seccion: 'normas_generales',
            edicion: '20261021',
            fecha: '21-10-2026',
            source_url: 'https://www.diariooficial.interior.gob.cl/publicaciones/2026/09/04/44542/01/2865015.pdf',
        });
        expect(typeof first?.payload.contentHash).toBe('string');
        for (const key of ROUTER_OWNED_KEYS) expect(first?.payload).not.toHaveProperty(key);
        expect(first?.payload).not.toHaveProperty('scrapedAt');
    });

    it('a row without a CVE gets the legacy content-hash id and falls back to the section URL as source_url; empty rows are skipped', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: NO_CVE_HTML }), { now: NOW });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN);
        expect(records).toHaveLength(2);
        const [withLink, noLink] = records;
        expect(withLink?.payload.cve).toBeNull();
        expect(withLink?.recordId).toMatch(/^[0-9a-f]{40}$/);
        expect(withLink?.payload.source_url).toBe('https://www.diariooficial.interior.gob.cl/publicaciones/2026/10/21/45000/01/ley.pdf');
        expect(noLink?.payload.pdfUrl).toBeNull();
        expect(noLink?.payload.source_url).toBe(URL_INDEX);
        // the fallback id is a pure function of seccion|edicion|descripcion|pdfUrl
        const entry = parseTable(cheerio.load(NO_CVE_HTML), { seccion: 'normas_generales', edicion: '20261021', fecha: '21-10-2026' }).entries[0];
        if (!entry) throw new Error('fixture has an entry');
        expect(recordIdOf(entry)).toBe(withLink?.recordId);
        expect(recordIdOf({ ...entry, edicion: '20261022' })).not.toBe(withLink?.recordId); // same-day key only, as documented
    });

    it('honours maxItemsPerSource and does not request the remaining sections once it is reached', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML, [buildSectionUrl('bom')]: EDITION_HTML }), { now: NOW });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options({ sections: ['normas_generales', 'bom'] }), { maxItemsPerSource: 1 });
        expect(records.map((r) => r.recordId)).toEqual(['2865015']);
        expect(stub.calls).toHaveLength(1);
    });

    it('reads a genuine quiet day (the REAL live page) as an empty result, not an error', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: QUIET_DAY }), { now: NOW });
        expect(await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN)).toEqual([]);
        expect(stub.logs.info.some((m) => m.includes('nothing published today'))).toBe(true);
        expect(stub.logs.error).toEqual([]);
    });

    it('walks several sections in order and tags each record with its section', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML, [buildSectionUrl('bom')]: BOM_QUIET_DAY, [buildSectionUrl('avisos_destacados')]: NO_CVE_HTML }), { now: NOW });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options({ sections: ['normas_generales', 'bom', 'avisos_destacados'] }), RUN);
        expect(records.map((r) => r.payload.seccion)).toEqual(['normas_generales', 'normas_generales', 'avisos_destacados', 'avisos_destacados']);
    });

    it('fails the source when the ONLY section is the bot-check stub, and never retries or tries to get past it', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: BOT_CHECK_STUB }), { now: NOW });
        const error = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe(DIARIO_OFICIAL_SOURCE_ID);
        expect((error as SourceFetchError).message).toContain('bot-check stub');
        expect(stub.calls).toHaveLength(1);
    });

    it('an unrecognised 200 page is a FAILED section, not "nothing published" (deliberate deviation from the legacy non-default behaviour)', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: REDESIGNED }), { now: NOW });
        const error = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).message).toContain('possible site redesign');
    });

    it('returns what the healthy sections produced when another one fails, and warns', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML, [buildSectionUrl('bom')]: BOT_CHECK_STUB, [buildSectionUrl('empresas_cooperativas')]: new HttpStatusError(buildSectionUrl('empresas_cooperativas'), 404, '') }), { now: NOW });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options({ sections: ['normas_generales', 'bom', 'empresas_cooperativas'] }), RUN);
        expect(records).toHaveLength(2);
        const warning = stub.logs.warning.join('\n');
        expect(warning).toContain('2 section(s) failed');
        expect(warning).toContain('bom: the site served its JavaScript bot-check stub');
        expect(warning).toContain('empresas_cooperativas: request failed (HTTP 404');
    });

    it('wraps a transport failure of the only section in SourceFetchError', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: new Error('getaddrinfo ENOTFOUND www.diariooficial.interior.gob.cl') }), { now: NOW });
        const error = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).message).toContain('ENOTFOUND');
    });

    it('uses the injected clock for the edition, never the wall clock', async () => {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML }), { now: '2030-01-15T12:00:00Z' });
        const records = await clDiarioOficialConnector.fetch(stub.ctx, options(), RUN);
        expect(records[0]?.payload).toMatchObject({ fecha: '15-01-2030', edicion: '20300115' });
    });
});

describe('fingerprint semantics', () => {
    async function fetchHtml(html: string, now = NOW) {
        const stub = makeCtx(sectionHandler({ [URL_INDEX]: html }), { now });
        return clDiarioOficialConnector.fetch(stub.ctx, clDiarioOficialOptionsSchema.parse({}), RUN);
    }

    it('is stable across runs and across days (edicion / fecha are context, not content)', async () => {
        const a = await fetchHtml(EDITION_HTML, '2026-10-21T12:00:00Z');
        const b = await fetchHtml(EDITION_HTML, '2026-10-22T12:00:00Z');
        expect(b.map((r) => r.recordId)).toEqual(a.map((r) => r.recordId));
        expect(b.map((r) => r.fingerprint)).toEqual(a.map((r) => r.fingerprint));
    });

    it('changes when a correction is re-published under the same CVE, keeping the recordId', async () => {
        const base = await fetchHtml(EDITION_HTML);
        // SYNTHETIC correction: same CVE, amended description text
        const corrected = await fetchHtml(EDITION_HTML.replace('Aprueba norma tecnica', 'Aprueba norma tecnica (fe de erratas)'));
        expect(corrected.map((r) => r.recordId)).toEqual(base.map((r) => r.recordId));
        expect(corrected[0]?.fingerprint).toBe(base[0]?.fingerprint);
        expect(corrected[1]?.fingerprint).not.toBe(base[1]?.fingerprint);
    });

    it('toSourceRecord is a pure function of the entry', () => {
        const entry = parseTable(cheerio.load(EDITION_HTML), { seccion: 'normas_generales', edicion: 'e', fecha: 'f' }).entries[0];
        if (!entry) throw new Error('fixture has an entry');
        expect(toSourceRecord(entry, URL_INDEX)).toEqual(toSourceRecord({ ...entry }, URL_INDEX));
    });
});

describe('end to end through the real router', () => {
    it('emits first_seen rows, is silent on an unchanged rerun, re-emits a correction as `updated`, and matches the watchlist on the issuing authority', async () => {
        const store = new InMemoryDeltaStore();
        const input = { sources: ['cl_diario_oficial'], watchlistNames: ['subsecretaria de pesca'], deltaMode: 'onlyChanged' };
        const run1 = await runThroughRouter(clDiarioOficialConnector, input, makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML }), { now: NOW }), store);
        expect(run1.rows.map((r) => [r.record_id, r.delta_status, r.is_watchlist_match])).toEqual([
            ['2865015', 'first_seen', true],
            ['2863871', 'first_seen', false],
        ]);
        expect(run1.rows[0]).toMatchObject({ engine: 'latam-global-tender-intelligence', source: 'cl_diario_oficial', matched_watchlist_keyword: 'subsecretaria de pesca' });
        expect(run1.summary.watchlist.hitsCharged).toBe(1);

        const run2 = await runThroughRouter(clDiarioOficialConnector, input, makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML }), { now: NOW }), store);
        expect(run2.rows).toHaveLength(0);

        const corrected = EDITION_HTML.replace('Aprueba norma tecnica', 'Aprueba norma tecnica (fe de erratas)');
        const run3 = await runThroughRouter(clDiarioOficialConnector, input, makeCtx(sectionHandler({ [URL_INDEX]: corrected }), { now: NOW }), store);
        expect(run3.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['2863871', 'updated']]);
    });

    it('never bills a hit for blank / whitespace / one-character watchlist entries (ghost-billing guard)', async () => {
        for (const watchlistNames of [[''], ['  '], 'a', ['e']]) {
            const run = await runThroughRouter(clDiarioOficialConnector, { sources: ['cl_diario_oficial'], watchlistNames }, makeCtx(sectionHandler({ [URL_INDEX]: EDITION_HTML }), { now: NOW }));
            expect(run.rows).toHaveLength(2);
            expect(run.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(run.summary.watchlist.hitsCharged).toBe(0);
        }
    });

    it('isolates a failing source in the run summary', async () => {
        const run = await runThroughRouter(clDiarioOficialConnector, { sources: ['cl_diario_oficial'] }, makeCtx(sectionHandler({ [URL_INDEX]: BOT_CHECK_STUB }), { now: NOW }));
        expect(run.rows).toEqual([]);
        expect(run.summary.sources[0]?.error).toContain('bot-check stub');
    });
});
