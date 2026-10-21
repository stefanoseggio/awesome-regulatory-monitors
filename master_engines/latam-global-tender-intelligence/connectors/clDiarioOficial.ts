/**
 * clDiarioOficial.ts - Chile "Diario Oficial de la República de Chile" (electronic edition) connector.
 *
 * Absorbs the legacy actor `diario-oficial-cl-monitor` (src/fetchSection.ts, resolve.ts, fingerprint.ts,
 * types.ts, parsers/table.ts). Ported: section URLs, the Chile-local edition date, the table parser, the
 * zero-entry diagnostics, record id, fingerprint. NOT ported (router concerns): state.ts, delta.ts
 * (NEW_LISTING / UPDATED / UNCHANGED), main.ts, Actor.pushData / charging.
 *
 * WHAT A RECORD IS
 * ----------------------------------------------------------------------------
 * One publication (a law, decree, resolution, notice ...) of TODAY's edition in one of the seven
 * sections. The gazette has no lifecycle (a published act is a permanent record): the only thing that
 * can happen to an entry is a correction (a "fe de erratas") re-published under the same CVE, which
 * the router sees as an update through the fingerprint.
 *
 *   recordId     the CVE (Código de Verificación Electrónica) parsed from the link text `Ver PDF
 *                (CVE-NNNNNNN)`; when the link text carries none, sha1 of
 *                `seccion|edicion|descripcion|pdfUrl` (legacy `recordIdOf`; `edicion` is the
 *                same-day key derived below, so the fallback id is unique within one day only).
 *   fingerprint  rama, ministerio, organismo, descripcion, pdfUrl - the legacy `contentHash` fields
 *                (cve / seccion / edicion / fecha are identity or context, not content).
 *   watchText    ministerio + organismo (the issuing authority) + descripcion (the act's title).
 *
 * "Today's edition": the site no longer exposes an edition number or date parameter (legacy resolve.ts,
 * SITE CHANGE 2026-09-19: the bare `index.php?` URLs show today's edition inline). `fecha`
 * (DD-MM-YYYY) is computed from the injected clock in the America/Santiago time zone and `edicion` is
 * `YYYYMMDD` of the same date - a same-day key, NOT the government's edition number (not published).
 * No historical-date support exists in the legacy actor and none is invented here.
 *
 * Section failures: a section whose request fails, whose body is the bot-check stub (`bobcmn`), or whose
 * page shows none of the markup the parser has ever recognised (no title3/4/5 headings, no `.nofound`
 * notice) is a FAILED section, never "nothing published". Other sections are still returned; if nothing
 * was returned and at least one section failed, the source fails (SourceFetchError). A genuine quiet
 * day (the site's own `.nofound` notice, or headings without rows) is an empty result. DEVIATION from
 * the legacy actor, deliberately: it only warned about an unrecognised page on the default section and
 * silently treated it as "nothing published" on the other six.
 *
 * COMPLIANCE NOTE - the bot-check: the source runs a client-fingerprint check that serves a ~6 KB
 * JavaScript stub (`window["bobcmn"] = ...`) to browser-impersonating TLS stacks (got-scraping,
 * impit - legacy AGENTS.md) while Node's own honest `fetch` gets the real page. The shared lib/http.ts
 * client IS plain Node `fetch` with an honest User-Agent. This connector never tries to get past the
 * check: when the stub is served it fails the section with a precise error.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md, 2026-09-04 / 2026-09-19): plain PHP, one hierarchical `<table>` per
 * edition (`td.title3` = branch of government, `td.title4` = ministry, `td.title5` = agency,
 * `tr.content` = the publication), real page under `/edicionelectronica/` (the root `/index.php` is an
 * unrelated page); a genuine quiet day returns HTTP 200 with no table and the notice
 * `<p class="nofound">No existen publicaciones en esta edición en la fecha seleccionada</p>`.
 *
 * Re-verified in THIS port session (2026-10-21, ~06:30 UTC = early morning in Chile):
 *   Node 22 global `fetch` (honest custom User-Agent and also the default one; both returned the same
 *   page) for all seven bare URLs `https://www.diariooficial.interior.gob.cl/edicionelectronica/
 *   {index,avisos_destacados,marcas_patentes,normas_particulares,publicaciones_judiciales,
 *   empresas_cooperativas,bom}.php?` -> HTTP 200, 10.3-13.7 KB each, no `bobcmn`, no `title3`, and the
 *   `.nofound` notice in every one (the page header reads "Miércoles 21 de Octubre de 2026": today's
 *   edition had not published anything yet). `curl` (a different TLS fingerprint) got HTTP 403 for the
 *   same URL, consistent with the legacy note that this site fingerprints clients.
 *   Correction found by running the connector end to end against all seven live pages: the `bom` page
 *   does NOT carry the `.nofound` notice (it is inside an HTML comment there); it shows the visible sentence
 *   "En la edición del día Miércoles 21 de Octubre de 2026, no hubo publicaciones del Boletín Oficial de
 *   Minería" instead. Both variants are recognised as a quiet day (see hasNoPublicationsNotice); the other six
 *   pages carry a real `.nofound` element. Both live quiet-day pages are stored as
 *   `diario_oficial_cl.live-2026-10-21.*` fixtures.
 *   Consequence: NO populated live page was available in this session, so the row parser is verified
 *   against the legacy test's HTML (which its authors describe as reconstructed from a real fetch of
 *   2026-09-04), not against a live populated edition.
 *
 * UNVERIFIED, plainly: the legacy README says only `normas_generales` was confirmed to carry real content
 * end to end; the other six sections are "wired against the same parser but never confirmed". The `bom` page
 * in particular has a different layout (an icon list of mining-notice categories), so a populated BOM page may
 * not match the title3/4/5 + `tr.content` table and would then be reported as a FAILED section ("no recognised
 * markup") rather than as an empty one - which is the intended, honest outcome until someone captures one.
 * ============================================================================
 */
import { createHash } from 'node:crypto';

import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';
import { errorMessage } from '../support/portalHttp.js';

export const DIARIO_OFICIAL_SOURCE_ID = 'cl_diario_oficial';

const BASE_URL = 'https://www.diariooficial.interior.gob.cl';

export const SECTION_NAMES = [
    'normas_generales',
    'avisos_destacados',
    'marcas_patentes',
    'normas_particulares',
    'publicaciones_judiciales',
    'empresas_cooperativas',
    'bom',
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export const SECTION_PATHS: Record<SectionName, string> = {
    normas_generales: 'index.php',
    avisos_destacados: 'avisos_destacados.php',
    marcas_patentes: 'marcas_patentes.php',
    normas_particulares: 'normas_particulares.php',
    publicaciones_judiciales: 'publicaciones_judiciales.php',
    empresas_cooperativas: 'empresas_cooperativas.php',
    bom: 'bom.php',
};

/**
 * Real bug caught by the legacy live test: the root-level /index.php is a completely different,
 * unrelated page - only /edicionelectronica/index.php is the actual edition page. The `date=` /
 * `edition=` query params were removed (SITE CHANGE 2026-09-19): the site's own current links are
 * bare ("index.php?") and fetching that exact bare URL returns today's real content; passing stale or
 * synthetic values risked the server honouring a wrong edition and silently serving the wrong day.
 */
export function buildSectionUrl(section: SectionName): string {
    return `${BASE_URL}/edicionelectronica/${SECTION_PATHS[section]}?`;
}

export interface ResolvedEdition {
    fecha: string;
    edicion: string;
}

/** Today's date in Chile's own time zone (the source publishes on Chile time) from the injected clock. */
export function resolveEdition(now: Date): ResolvedEdition {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const day = get('day');
    const month = get('month');
    const year = get('year');
    return { fecha: `${day}-${month}-${year}`, edicion: `${year}${month}${day}` };
}

// ---------------------------------------------------------------------------
// Parser (legacy parsers/table.ts)
// ---------------------------------------------------------------------------

export interface GazetteEntry {
    rama: string | null;
    ministerio: string | null;
    organismo: string | null;
    descripcion: string;
    pdfUrl: string | null;
    cve: string | null;
    seccion: SectionName;
    edicion: string;
    fecha: string;
}

export interface ParseTableResult {
    entries: GazetteEntry[];
    /** Whether any title3/title4/title5 heading cell was seen anywhere in the table, regardless of whether entries ended up empty. */
    headingsEncountered: boolean;
    /**
     * Whether the page's own explicit "nothing published" notice was present: `.nofound` (six sections) or the
     * visible "no hubo publicaciones" sentence (the `bom` section) - see {@link hasNoPublicationsNotice}. Verified
     * live (legacy 2026-09-19 and again 2026-10-21): on a genuine quiet day the page has no `<table>` at all -
     * not even empty title3/4/5 headings - and shows this notice. So `headingsEncountered` alone cannot tell a
     * quiet day from a structural break; this flag can.
     */
    noPublicationsNoticeFound: boolean;
}

interface ParseTableOptions {
    seccion: SectionName;
    edicion: string;
    fecha: string;
}

/**
 * The edition page is one hierarchical table: title3 = branch of government (PODER EJECUTIVO...),
 * title4 = ministry, title5 = agency, then one or more class="content" rows are the actual publications
 * under whichever heading last appeared. Not every level is always present, so context resets to null
 * (not stale) whenever a shallower heading reappears, rather than carrying over from an unrelated ministry.
 */
export function parseTable($: CheerioAPI, options: ParseTableOptions): ParseTableResult {
    const entries: GazetteEntry[] = [];
    let headingsEncountered = false;

    let rama: string | null = null;
    let ministerio: string | null = null;
    let organismo: string | null = null;

    $('table tr').each((_i, el) => {
        const row = $(el);
        const cell = row.find('td').first();

        if (cell.hasClass('title3')) {
            headingsEncountered = true;
            rama = cell.text().trim();
            ministerio = null;
            organismo = null;
            return;
        }
        if (cell.hasClass('title4')) {
            headingsEncountered = true;
            ministerio = cell.text().trim();
            organismo = null;
            return;
        }
        if (cell.hasClass('title5')) {
            headingsEncountered = true;
            organismo = cell.text().trim();
            return;
        }
        if (!row.hasClass('content')) return;

        const cells = row.find('td');
        const descripcion = cells.eq(0).text().trim();
        if (!descripcion) return;

        const link = cells.eq(1).find('a').first();
        const pdfUrl = link.attr('href')?.trim() ?? null;
        const cveMatch = link.text().match(/CVE-(\d+)/);
        const cve = cveMatch ? (cveMatch[1] ?? null) : null;

        entries.push({
            rama,
            ministerio,
            organismo,
            descripcion,
            pdfUrl,
            cve,
            seccion: options.seccion,
            edicion: options.edicion,
            fecha: options.fecha,
        });
    });

    return { entries, headingsEncountered, noPublicationsNoticeFound: hasNoPublicationsNotice($) };
}

/**
 * The two "nothing published" notices seen live (2026-10-21): the standard `<p class="nofound">No existen
 * publicaciones en esta edición en la fecha seleccionada</p>` of the six ordinary sections, and the one of the
 * Boletín Oficial de Minería page (`bom`), which has that paragraph COMMENTED OUT and shows instead, as visible
 * text, "En la edición del día <fecha>, no hubo publicaciones del Boletín Oficial de Minería". HTML comments are
 * not part of `.text()`, so the commented-out variant never counts.
 */
export function hasNoPublicationsNotice($: CheerioAPI): boolean {
    return $('.nofound').length > 0 || /no hubo publicaciones/i.test($('body').text());
}

/** `bobcmn` is the marker variable of the JavaScript bot-check stub the source serves to fingerprinted clients (legacy). */
export function isBotCheckStub(html: string): boolean {
    return /bobcmn/.test(html);
}

export type SectionPageKind = 'bot-check' | 'publications' | 'quiet-day' | 'unrecognised';

/** What a 200 response for a section page is. Pure; `result` is the parser output for the same page. */
export function classifySectionPage(html: string, result: ParseTableResult): SectionPageKind {
    if (isBotCheckStub(html)) return 'bot-check';
    if (result.entries.length > 0) return 'publications';
    if (result.headingsEncountered || result.noPublicationsNoticeFound) return 'quiet-day';
    return 'unrecognised';
}

// ---------------------------------------------------------------------------
// Record (legacy fingerprint.ts / delta.ts buildRecord, minus the router-owned envelope)
// ---------------------------------------------------------------------------

/** Legacy `recordIdOf`: the CVE when present, a content hash otherwise. */
export function recordIdOf(entry: GazetteEntry): string {
    if (entry.cve) return entry.cve;
    return createHash('sha1').update(`${entry.seccion}|${entry.edicion}|${entry.descripcion}|${entry.pdfUrl ?? ''}`).digest('hex');
}

/** The legacy `contentHash` input fields; `cve`/`seccion`/`edicion`/`fecha` are identity/context, not content. */
export function contentParts(entry: GazetteEntry): unknown[] {
    return [entry.rama, entry.ministerio, entry.organismo, entry.descripcion, entry.pdfUrl];
}

/**
 * Dataset row with the legacy field names. Omitted on purpose (router-owned): `record_id`, `event_type`,
 * `scraped_at`, `is_new`. `source_url` is the publication's own PDF when it has one (a genuine
 * per-record deep link), the section URL otherwise.
 */
export function toSourceRecord(entry: GazetteEntry, sectionUrl: string): SourceRecord {
    const contentHash = fingerprintOf(contentParts(entry));
    return {
        recordId: recordIdOf(entry),
        fingerprint: contentHash,
        payload: { ...entry, source_url: entry.pdfUrl ?? sectionUrl, contentHash },
        watchText: [entry.ministerio, entry.organismo, entry.descripcion].filter((p): p is string => p !== null && p.trim() !== '').join(' '),
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const clDiarioOficialOptionsSchema = z
    .object({
        /** Sections of today's edition to read. The default section (normas_generales) is the one the legacy actor confirmed end to end. */
        sections: z.array(z.enum(SECTION_NAMES)).min(1).default(['normas_generales']),
    })
    .strict();
export type ClDiarioOficialOptions = z.infer<typeof clDiarioOficialOptionsSchema>;

export const clDiarioOficialConnector: Connector<ClDiarioOficialOptions> = {
    id: DIARIO_OFICIAL_SOURCE_ID,
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'diario-oficial-cl-monitor',
    description:
        'Chile Diario Oficial (electronic edition): laws, decrees, resolutions and notices published TODAY in the selected sections (normas generales, particulares, judiciales, avisos destacados, empresas y cooperativas, marcas y patentes, minería), with issuing ministry / agency, description and the official PDF link. Open site, no credentials, no proxy; requires plain (non-impersonating) HTTP.',
    status: 'active',
    optionsSchema: clDiarioOficialOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ClDiarioOficialOptions, run: RunParams): Promise<SourceRecord[]> {
        const edition = resolveEdition(ctx.now());
        ctx.log.info(`[${DIARIO_OFICIAL_SOURCE_ID}] edition resolved: ${edition.edicion} (${edition.fecha})`);

        const records: SourceRecord[] = [];
        const failures: string[] = [];

        for (const seccion of [...new Set(options.sections)]) {
            if (records.length >= run.maxItemsPerSource) break;
            const url = buildSectionUrl(seccion);

            let html: string;
            try {
                html = await ctx.http.getText(url);
            } catch (error) {
                failures.push(`${seccion}: request failed (${errorMessage(error)})`);
                ctx.log.error(`[${DIARIO_OFICIAL_SOURCE_ID}] section "${seccion}" failed after retries: ${errorMessage(error)}`);
                continue;
            }

            const result = parseTable(cheerio.load(html), { seccion, edicion: edition.edicion, fecha: edition.fecha });
            const kind = classifySectionPage(html, result);
            if (kind === 'bot-check') {
                failures.push(`${seccion}: the site served its JavaScript bot-check stub instead of the edition page`);
                ctx.log.error(`[${DIARIO_OFICIAL_SOURCE_ID}] section "${seccion}": bot-check stub served (bobcmn); not attempting to get past it.`);
                continue;
            }
            if (kind === 'unrecognised') {
                failures.push(`${seccion}: HTTP 200 page with no recognised markup (no title3/title4/title5 headings, no "nothing published" notice) - possible site redesign`);
                ctx.log.warning(`[${DIARIO_OFICIAL_SOURCE_ID}] section "${seccion}": page shows none of the markup this parser recognises; treated as a failed section, not as an empty one.`);
                continue;
            }
            if (kind === 'quiet-day') {
                ctx.log.info(`[${DIARIO_OFICIAL_SOURCE_ID}] section "${seccion}": nothing published today.`);
                continue;
            }

            ctx.log.info(`[${DIARIO_OFICIAL_SOURCE_ID}] section "${seccion}": ${result.entries.length} publications found.`);
            for (const entry of result.entries) {
                if (records.length >= run.maxItemsPerSource) break;
                records.push(toSourceRecord(entry, url));
            }
        }

        if (records.length === 0 && failures.length > 0) {
            throw new SourceFetchError(`Diario Oficial: no section could be read - ${failures.join('; ')}.`, DIARIO_OFICIAL_SOURCE_ID);
        }
        if (failures.length > 0) {
            ctx.log.warning(`[${DIARIO_OFICIAL_SOURCE_ID}] ${failures.length} section(s) failed and were skipped: ${failures.join('; ')}.`);
        }
        return records;
    },
};
