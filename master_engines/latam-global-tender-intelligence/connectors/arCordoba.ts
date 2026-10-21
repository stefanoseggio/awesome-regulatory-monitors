/**
 * arCordoba.ts - Province of Córdoba (Argentina) "Compras Públicas" licitaciones connector.
 *
 * Absorbs the legacy actor `cordoba-compras-monitor` (src/fetchTenders.ts, dateFilter.ts, fingerprint.ts,
 * types.ts, parsers/form.ts, parsers/pagination.ts, parsers/table.ts). Ported: the stateful ASP.NET
 * postback walk, the form/pager/grid parsers, normalisation, record id, fingerprint and the `dateRange`
 * window. NOT ported (router concerns): state.ts, deltaEngine.ts (NEW_LISTING / STATUS_CHANGE / UPDATED /
 * UNCHANGED / CLOSED), main.ts, Actor.pushData / charging. NOT ported (compliance): the Residential +
 * Argentina Apify Proxy fallback of the legacy main.ts - see "ACCESS CONSTRAINT" below.
 *
 * WHAT A RECORD IS
 * ----------------------------------------------------------------------------
 * One active licitación (`nroCotizacion`, e.g. "2026/000091") of
 * `webecommerce.cba.gov.ar/VistaPublica/ConsultaPublicaCotizacion.aspx?TIPO_CONSULTA_PUBLICA=LI`: contract
 * type, administrative service, jurisdiction, publication / closing dates, estado, prórroga flag, the
 * per-item reference budget and the contact phone - everything inline in the listing grid.
 *
 *   recordId     `nroCotizacion` verbatim (the legacy `record_id`).
 *   fingerprint  `estado` + every field that can change while a tender stays active (dates, prórroga,
 *                line items, contact phone, type / service / jurisdiction) - the master-engine equivalent
 *                of the legacy STATUS_CHANGE + UPDATED events. `contentHash` in the payload is the legacy
 *                field name; its value is computed with the shared helper (same inputs, not the same digest).
 *   watchText    buyer (`servicioAdministrativo`, plus `jurisdiccion` when different) + contract type
 *                (`tipoContratacion`) + the first line item's description.
 *   CLOSED       the legacy actor emitted CLOSED for a previously-active tender absent from a COMPLETE
 *                walk; the router has no such concept (it never reports absence), so it is not ported.
 *
 * THE SESSION CHAIN, AND WHY PAGINATION NEEDS `getRaw`
 * ----------------------------------------------------------------------------
 * The grid is a genuinely stateful sequential postback chain: each page's POST must carry the exact
 * `ASP.NET_SessionId` cookie and `__VIEWSTATE` the PREVIOUS response returned (legacy AGENTS.md). The
 * shared HttpClient port only returns response BODIES, so the cookie cannot be read through
 * `getText`. The connector therefore uses the optional `getRaw` capability (../support/portalHttp.ts,
 * lib change request "HttpClient.getRaw") for the cookie-threaded walk. Without it:
 *   - page 1 is still fetched with `getText` (a plain GET needs no cookie) and returned when it already
 *     satisfies `maxItemsPerSource` or is the last page;
 *   - if more pages are needed, the source FAILS (SourceFetchError) instead of returning a silently
 *     truncated census. The unverified alternative of POSTing without the cookie is deliberately not tried.
 *
 * CERTIFICATE CHAIN (certs/cordoba-sectigo-chain.pem in the legacy repo)
 * ----------------------------------------------------------------------------
 * That file is a PUBLIC CA bundle of exactly two X.509 certificates, no private key: "Sectigo Public
 * Server Authentication CA OV R36" (the intermediate) and "Sectigo Public Server Authentication Root R46".
 * The portal's server sends only its leaf certificate (legacy AGENTS.md "Real bug #6", found with
 * `openssl s_client -showcerts`), so a Node-native TLS stack on Linux fails with "unable to verify the
 * first certificate" unless the intermediate is added to the trust store (the legacy Dockerfile did that
 * with NODE_EXTRA_CA_CERTS; its later `impit` transport completed the chain on its own, but the shared
 * lib/http.ts is Node's global `fetch`). The bundle (two PUBLIC Sectigo CA certificates, no private key) ships in
 * `latam-global-tender-intelligence/certs/cordoba-sectigo-chain.pem` and the engine's Dockerfile points
 * `NODE_EXTRA_CA_CERTS` at it, which ADDS to - never replaces - Node's trust store. A caller can still supply a PEM
 * through `sourceOptions.ar_cordoba.extraCaPem`: validated to contain CERTIFICATE blocks and nothing else (a PRIVATE
 * KEY block, or any stray content, is rejected in preflight), never logged, and forwarded as the `tlsExtraCaPem`
 * request hint. The default client cannot honour that hint per request (it logs a warning), so the process-level
 * NODE_EXTRA_CA_CERTS variable is the supported mechanism.
 *
 * ACCESS CONSTRAINT (read before enabling in the cloud)
 * ----------------------------------------------------------------------------
 * The legacy docs record that `webecommerce.cba.gov.ar` blocks non-residential, non-Argentine traffic at
 * the TCP level (every request from Apify's cloud timed out at connect, 2026-09-04) and that the legacy
 * actor worked around it with a paid Residential + `AR` Apify Proxy. `lib/http.ts` has no proxy support
 * and this connector deliberately carries no routing-around-a-block logic: from a network the portal
 * refuses, the source fails with a SourceFetchError that says so. It works from an Argentine network
 * path (the legacy docs also record plain reachability from a local development machine).
 *
 * `dateRange` filters on `fechaInicio` AFTER the capped walk (legacy behaviour; with it set the source may
 * return fewer than `maxItemsPerSource` records).
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md, 2026-09-04 .. 2026-09-19): `TIPO_CONSULTA_PUBLICA=LI` is the only working
 * query (CD / CP / SU / CO return HTTP 500); the grid is `#gv > tbody > tr` with 9 cells (Nro Cotización,
 * Tipo Contratación, Servicio Administrativo, Jurisdicción, Fecha Inicio, Fecha Finalización, Estado,
 * Prórroga, Acciones) and the Acciones cell embeds a hidden per-item popup table
 * (`gv_btnItems_N_gv`) and the contact phone in `<img id*="btnTelContacto" title=...>`; the pager is an
 * 11-slot sliding window (`paglbN` links, the active slot is `paglblN`, `paglbS` = next block);
 * the postback must replicate a browser form submit (every non-button input, every select's chosen
 * option, ONLY checked checkboxes/radios, plus __EVENTTARGET/__EVENTARGUMENT); the live listing grew from
 * 93 to 125+ rows during the build, so rows shift between page requests and duplicates are dropped by id;
 * the listing order is NOT a stable function of any date or of the number (so no early stop). Argentina
 * is a fixed UTC-3 (no DST since 2009).
 *
 * Re-verification attempt in THIS port session (2026-10-21): `curl` through the sandbox egress proxy to
 * https://webecommerce.cba.gov.ar/VistaPublica/ConsultaPublicaCotizacion.aspx?TIPO_CONSULTA_PUBLICA=LI
 * failed with "Connection reset by peer" (the proxy logged `ws_closed_mid_exchange ... 517 B sent, 39 B
 * received` after 13 s), which is consistent with the legacy-documented network-level block of
 * non-Argentine traffic. Running this connector through lib/http.ts `createHttpClient` produced the same
 * failure ("fetch failed") and the SourceFetchError described above. NOT live-verified in this session: the
 * parsers are verified against the legacy repo's real captures of 2026-09-04 (trimmed, see the test header).
 * ============================================================================
 */
import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';
import {
    argentinaLocalToUtc,
    cookiePairFromSetCookies,
    decodePortalBytes,
    errorMessage,
    hasRawHttp,
    type RawRequestInit,
} from '../support/portalHttp.js';

export const CORDOBA_SOURCE_ID = 'ar_cordoba';

/**
 * Also the `source_url` of every record: this portal has no stable per-record deep link (every "Ver
 * Detalles" / "Preguntas" control is an ASP.NET postback tied to the session / ViewState), so every record
 * points at the general listing page. The legacy README discloses the same limitation.
 */
export const BASE_URL = 'https://webecommerce.cba.gov.ar/VistaPublica/ConsultaPublicaCotizacion.aspx?TIPO_CONSULTA_PUBLICA=LI';

// The pager only ever renders an 11-slot window (paglb1..paglb11) - real data on the legacy audit date
// ended at page 8 - so this cap is a safety backstop against a future data-volume regression, not the
// expected stopping condition ("no more page link" or "0 rows" are hit naturally before it).
const MAX_PAGES_SAFETY_CAP = 60;

const SESSION_COOKIE = 'ASP.NET_SessionId';

// ---------------------------------------------------------------------------
// Types (legacy types.ts)
// ---------------------------------------------------------------------------

export type DateRangePreset = '24h' | '7d' | '30d';
export type FormFields = Record<string, string>;

export interface TenderItem {
    renglon: string;
    cantidad: string;
    precioReferencia: string;
    presupuestoOficial: string;
}

export interface TenderRow {
    nroCotizacion: string;
    tipoContratacion: string;
    servicioAdministrativo: string;
    jurisdiccion: string;
    fechaInicio: string;
    fechaFinalizacion: string;
    estado: string;
    prorroga: boolean;
    items: TenderItem[];
    telefonoContacto: string | null;
}

// ---------------------------------------------------------------------------
// Parsers (legacy parsers/form.ts, pagination.ts, table.ts)
// ---------------------------------------------------------------------------

/**
 * Replicates exactly what a real browser submits when this ASP.NET WebForms page posts back: every
 * non-button input's current value, every select's selected option, and ONLY checkboxes/radios that are
 * actually `checked`. Verified live by the legacy actor (2026-09-04): sending every checkbox's declared
 * `value=` regardless of checked state silently corrupts the server-side filter state - the response
 * comes back 200 with no error, but the page never actually advances.
 */
export function extractFormFields($: CheerioAPI): FormFields {
    const fields: FormFields = {};

    $('input').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return;
        const type = ($el.attr('type') ?? 'text').toLowerCase();

        if (type === 'checkbox' || type === 'radio') {
            if ($el.attr('checked') === undefined) return;
            fields[name] = $el.attr('value') ?? 'on';
            return;
        }
        if (type === 'submit' || type === 'image' || type === 'button' || type === 'reset') return;

        fields[name] = $el.attr('value') ?? '';
    });

    $('select').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return;
        const selected = $el.find('option[selected]').first();
        const chosen = selected.length > 0 ? selected : $el.find('option').first();
        fields[name] = chosen.attr('value') ?? '';
    });

    $('textarea').each((_i, el) => {
        const $el = $(el);
        const name = $el.attr('name');
        if (!name) return;
        fields[name] = $el.text();
    });

    return fields;
}

export function buildPostbackPayload($: CheerioAPI, eventTarget: string): FormFields {
    return {
        ...extractFormFields($),
        __EVENTTARGET: eventTarget,
        __EVENTARGUMENT: '',
    };
}

/**
 * The results grid's own pager renders each numbered slot as either a clickable postback link
 * (id="paglbN") or, for whichever page is currently active, a plain non-link label whose id literally
 * shifts with the current page (id="paglbl1" on page 1, "paglbl2" on page 2, ...). A SEPARATE pager,
 * differently prefixed (id="PopUpRubroProvNoMasterSoloPadres_paglbN"), belongs to an unrelated
 * category-filter popup and must never be confused with this one; cheerio's #id selector is an exact
 * match, so `#paglb${n}` only ever matches the bare grid pager.
 */
export function getCurrentPage($: CheerioAPI): number | null {
    let found: number | null = null;
    $('[id]').each((_i, el) => {
        const id = $(el).attr('id') ?? '';
        const m = /^paglbl(\d+)$/.exec(id);
        if (m) found = Number(m[1]);
    });
    return found;
}

export function hasPageLink($: CheerioAPI, page: number): boolean {
    return $(`#paglb${page}`).length > 0;
}

/**
 * The pager only ever renders an 11-slot sliding WINDOW of page numbers (1..11, then 2..12, then 3..13,
 * ...) - beyond the current window's last slot there is no direct numbered link, only a "siguiente
 * bloque" control (id="paglbS") that both advances one page AND slides the window forward (legacy live
 * 2026-09-04: clicking paglbS from page 11 landed on page 12 with window 2-12). It must be used whenever
 * the direct link for currentPage+1 isn't present.
 */
export function hasNextBlockLink($: CheerioAPI): boolean {
    return $('#paglbS').length > 0;
}

const NRO_COTIZACION_RE = /^\d{4}\/\d+$/;

/**
 * Main results grid, id="gv". Each data row (class="Renglon" or "RenglonAlternativo") has 9 direct <td>
 * children matching the header; the Acciones cell embeds a hidden popup table (id="gv_btnItems_{N}_gv")
 * with per-item description / quantity / budget, and a contact phone in an <img title="..."> - both
 * extracted here with no extra request. cheerio (like a real browser) auto-inserts a <tbody> wrapping bare
 * <tr> elements, so the grid's top-level rows are #gv > tbody > tr, not direct children of #gv itself.
 */
export function parseGrid($: CheerioAPI): TenderRow[] {
    const rows: TenderRow[] = [];

    $('#gv > tbody > tr').each((_i, el) => {
        const $row = $(el);
        const cells = $row.children('td');
        if (cells.length < 9) return;

        const nroCotizacion = cells.eq(0).text().trim();
        if (!NRO_COTIZACION_RE.test(nroCotizacion)) return;

        const accionesCell = cells.eq(8);

        const items: TenderItem[] = [];
        accionesCell.find('table.Grid tr').each((_j, itemEl) => {
            const $itemRow = $(itemEl);
            const itemCells = $itemRow.find('> td');
            if (itemCells.length < 4) return; // skip the header row (<th>)
            items.push({
                renglon: itemCells.eq(0).text().trim(),
                cantidad: itemCells.eq(1).text().trim(),
                precioReferencia: itemCells.eq(2).text().trim(),
                presupuestoOficial: itemCells.eq(3).text().trim(),
            });
        });

        const telefonoContacto = accionesCell.find('img[id*="btnTelContacto"]').attr('title')?.trim() || null;

        rows.push({
            nroCotizacion,
            tipoContratacion: cells.eq(1).text().trim(),
            servicioAdministrativo: cells.eq(2).text().trim(),
            jurisdiccion: cells.eq(3).text().trim(),
            fechaInicio: cells.eq(4).text().trim(),
            fechaFinalizacion: cells.eq(5).text().trim(),
            estado: cells.eq(6).text().trim(),
            prorroga: cells.eq(7).text().trim().toUpperCase() === 'SI',
            items,
            telefonoContacto,
        });
    });

    return rows;
}

/**
 * A 0-row parseGrid() result is ambiguous on its own: the genuine "0 active tenders" case still renders
 * #gv with just its header row (legacy fixture page_no_results.html), so #gv being MISSING ENTIRELY - a
 * bot-check interstitial, a session-expired redirect, an unrelated site-structure change, all of which
 * can still come back HTTP 200 - is a structurally distinct and far more suspicious signal.
 */
export function hasResultsGrid($: CheerioAPI): boolean {
    return $('#gv').length > 0;
}

// ---------------------------------------------------------------------------
// Date window (legacy dateFilter.ts)
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<DateRangePreset, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * `fechaInicio` (Publication Date) renders as DD/MM/YYYY HH:mm:ss, Argentina local time (fixed UTC-3, no
 * DST since 2009, so the conversion to a UTC instant is exact). This is the record's own declared date
 * field, not independent proof of when it first appeared - the listing's SORT ORDER is a separate,
 * unreliable thing (legacy AGENTS.md).
 */
export function parseFechaInicio(value: string | null | undefined): Date | null {
    if (!value) return null;
    const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const [, dd = '', mm = '', yyyy = '', hh = '', min = '', ss = ''] = match;
    return argentinaLocalToUtc(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min), Number(ss));
}

export function isWithinDateRange(date: Date | null, preset: DateRangePreset | undefined, now: Date): boolean {
    if (!preset) return true;
    if (!date) return false;
    return now.getTime() - date.getTime() <= WINDOW_MS[preset];
}

// ---------------------------------------------------------------------------
// Record (legacy fingerprint.ts, minus the router-owned envelope)
// ---------------------------------------------------------------------------

/**
 * The legacy `contentHash` inputs: every field that can change while a tender stays `nroCotizacion`-identical
 * (dates, prórroga, items, contact phone, type / service / jurisdiction). `estado` is added for the router
 * fingerprint, as a status transition is a change the router must surface.
 */
function contentParts(row: TenderRow): unknown[] {
    return [row.tipoContratacion, row.servicioAdministrativo, row.jurisdiccion, row.fechaInicio, row.fechaFinalizacion, row.prorroga, row.items, row.telefonoContacto];
}

/**
 * Dataset row with the legacy field names. Omitted on purpose (router-owned): `record_id`, `event_type`,
 * `scraped_at`, `is_new`, and the state-dependent `previousEstado`.
 */
export function toSourceRecord(row: TenderRow): SourceRecord {
    const contentHash = fingerprintOf(contentParts(row));
    const buyer = [row.servicioAdministrativo, row.jurisdiccion.toLowerCase() === row.servicioAdministrativo.toLowerCase() ? '' : row.jurisdiccion];
    return {
        recordId: row.nroCotizacion,
        fingerprint: fingerprintOf([row.estado, contentHash]),
        payload: { ...row, source_url: BASE_URL, contentHash },
        watchText: [...buyer, row.tipoContratacion, row.items[0]?.renglon ?? ''].filter((p) => p.trim() !== '').join(' '),
    };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const MAX_PEM_LENGTH = 65_536;
const MAX_PEM_CERTIFICATES = 10;
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

/**
 * Returns why `pem` is not an acceptable extra-CA bundle, or null when it is. Only PUBLIC certificate blocks
 * are accepted: any PRIVATE KEY material, encrypted key, or other content outside the blocks is refused, so a
 * caller can never push a key through this option by mistake.
 */
export function certificateOnlyPemProblem(pem: string): string | null {
    if (pem.length > MAX_PEM_LENGTH) return `is larger than ${MAX_PEM_LENGTH} characters`;
    if (/-----BEGIN (?!CERTIFICATE-----)/.test(pem) || /PRIVATE KEY-----/.test(pem)) {
        return 'contains private-key material or a non-certificate PEM block; only public "CERTIFICATE" blocks are accepted';
    }
    const blocks = [...pem.matchAll(CERTIFICATE_BLOCK)];
    if (blocks.length === 0) return 'contains no "-----BEGIN CERTIFICATE-----" block';
    if (blocks.length > MAX_PEM_CERTIFICATES) return `contains more than ${MAX_PEM_CERTIFICATES} certificates`;
    for (const block of blocks) {
        const body = (block[1] ?? '').replace(/\s+/g, '');
        if (body.length < 64 || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return 'contains a certificate block whose body is not valid base64';
    }
    if (pem.replace(CERTIFICATE_BLOCK, '').trim() !== '') return 'contains content outside the certificate blocks';
    return null;
}

export const arCordobaOptionsSchema = z
    .object({
        /** Keep only tenders whose `fechaInicio` falls in the last 24h / 7d / 30d (applied after the capped walk). */
        dateRange: z.enum(['24h', '7d', '30d']).optional(),
        /**
         * Optional PEM bundle of PUBLIC CA certificates to ADD to the trust store for this source (the portal sends an
         * incomplete chain; the legacy repo ships the missing Sectigo intermediate + root in certs/). CERTIFICATE blocks
         * only; never a private key. Not a credential, never logged.
         */
        extraCaPem: z
            .string()
            .optional()
            .superRefine((value, issueCtx) => {
                if (value === undefined || value.trim() === '') return;
                const problem = certificateOnlyPemProblem(value);
                if (problem) issueCtx.addIssue({ code: z.ZodIssueCode.custom, message: `extraCaPem ${problem}` });
            })
            .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.replace(/\r\n/g, '\n').trim())),
    })
    .strict();
export type ArCordobaOptions = z.infer<typeof arCordobaOptionsSchema>;

// ---------------------------------------------------------------------------
// Walk (legacy fetchTenders.ts)
// ---------------------------------------------------------------------------

interface PortalPage {
    html: string;
    /** The `ASP.NET_SessionId=...` pair to replay, or null when none could be read. */
    cookie: string | null;
}

/** One request of the chain. Uses `getRaw` when available (cookie + bytes), `getText` otherwise (body only). */
async function request(ctx: ConnectorContext, init: { method: 'GET' | 'POST'; body?: string; cookie: string | null }, extraCaPem: string | undefined): Promise<PortalPage> {
    const headers: Record<string, string> = {};
    if (init.method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    if (init.cookie) headers.cookie = init.cookie;
    const requestInit: RawRequestInit = { method: init.method, headers, timeoutMs: 60_000 };
    if (init.body !== undefined) requestInit.body = init.body;
    if (extraCaPem !== undefined) requestInit.tlsExtraCaPem = extraCaPem;

    if (hasRawHttp(ctx.http)) {
        const response = await ctx.http.getRaw(BASE_URL, requestInit);
        return { html: decodePortalBytes(response.body, 'utf-8'), cookie: cookiePairFromSetCookies(response.setCookies, SESSION_COOKIE) ?? init.cookie };
    }
    return { html: await ctx.http.getText(BASE_URL, requestInit), cookie: null };
}

/**
 * Walks the grid: GET page 1, then POST `paglbN` (or `paglbS` past the 11-slot window edge) with the
 * previous response's form fields and session cookie, until there is no further page link, a page has no
 * rows, the pager stops advancing, `maxItems` is reached or the safety cap is hit. Rows are de-duplicated by
 * `nroCotizacion` (live data drift can shift rows between page requests).
 */
export async function walkGrid(ctx: ConnectorContext, maxItems: number, extraCaPem: string | undefined): Promise<TenderRow[]> {
    const results: TenderRow[] = [];
    const seenIds = new Set<string>();
    const pushUnique = (rows: TenderRow[]): void => {
        for (const row of rows) {
            if (results.length >= maxItems) return;
            if (seenIds.has(row.nroCotizacion)) continue;
            seenIds.add(row.nroCotizacion);
            results.push(row);
        }
    };

    let page: PortalPage;
    try {
        page = await request(ctx, { method: 'GET', cookie: null }, extraCaPem);
    } catch (error) {
        throw new SourceFetchError(
            `webecommerce.cba.gov.ar request failed: ${errorMessage(error)}. The legacy docs record that this portal blocks non-residential, non-Argentine traffic at the TCP level (connect timeouts) and that a TLS chain it sends incompletely needs the intermediate certificate (sourceOptions.ar_cordoba.extraCaPem or NODE_EXTRA_CA_CERTS); this connector does not route around either.`,
            CORDOBA_SOURCE_ID,
        );
    }
    let $ = cheerio.load(page.html);
    if (!hasResultsGrid($)) {
        // Not "0 tenders": a genuine empty day still renders #gv with its header row.
        throw new SourceFetchError(
            'The initial response does not contain the results grid (#gv) - bot-check page, expired session, redirect or a structural change of the site; not "0 tenders".',
            CORDOBA_SOURCE_ID,
        );
    }
    const firstPageRows = parseGrid($);
    pushUnique(firstPageRows);
    ctx.log.info(`[${CORDOBA_SOURCE_ID}] page 1: ${firstPageRows.length} licitaciones`);

    let currentPage = getCurrentPage($) ?? 1;

    for (let i = 0; i < MAX_PAGES_SAFETY_CAP && results.length < maxItems; i += 1) {
        const nextPage = currentPage + 1;
        let eventTarget: string;
        if (hasPageLink($, nextPage)) {
            eventTarget = `paglb${nextPage}`;
        } else if (hasNextBlockLink($)) {
            // past the current 11-slot window's edge - "siguiente bloque" both advances a page and slides the window forward.
            eventTarget = 'paglbS';
        } else {
            ctx.log.info(`[${CORDOBA_SOURCE_ID}] no link to page ${nextPage} nor next block - end of results.`);
            break;
        }

        if (!hasRawHttp(ctx.http)) {
            throw new SourceFetchError(
                `ar_cordoba needs HttpClient.getRaw to carry the ${SESSION_COOKIE} cookie from page ${currentPage} to the next postback, and ctx.http does not implement it. ` +
                    `Page 1 returned ${results.length} record(s) but the portal has more; returning them as if they were the whole census would be a silent truncation, so the source is not returned. ` +
                    'Requires the lib change request "HttpClient.getRaw".',
                CORDOBA_SOURCE_ID,
            );
        }

        const body = new URLSearchParams(buildPostbackPayload($, eventTarget)).toString();
        let response: PortalPage;
        try {
            response = await request(ctx, { method: 'POST', body, cookie: page.cookie }, extraCaPem);
        } catch (error) {
            ctx.log.warning(`[${CORDOBA_SOURCE_ID}] request for page ${nextPage} failed after retries: ${errorMessage(error)}. Returning what was collected.`);
            break;
        }
        page = response;
        $ = cheerio.load(page.html);

        const rows = parseGrid($);
        if (rows.length === 0) {
            ctx.log.info(`[${CORDOBA_SOURCE_ID}] page ${nextPage}: 0 rows - end of results.`);
            break;
        }
        pushUnique(rows);
        ctx.log.info(`[${CORDOBA_SOURCE_ID}] page ${nextPage}: ${rows.length} licitaciones`);

        const newPage = getCurrentPage($);
        if (newPage === null || newPage === currentPage) {
            ctx.log.warning(`[${CORDOBA_SOURCE_ID}] the pager did not advance from page ${currentPage} - end of results.`);
            break;
        }
        currentPage = newPage;
    }

    return results;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const arCordobaConnector: Connector<ArCordobaOptions> = {
    id: CORDOBA_SOURCE_ID,
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'cordoba-compras-monitor',
    description:
        'Province of Córdoba (Argentina) active licitaciones from the Compras Públicas portal (contract type, administrative service, jurisdiction, publication / closing dates, estado, prórroga, per-item reference budget, contact phone). Stateful ASP.NET postback walk. Requires egress from an Argentine network (the portal blocks non-residential, non-Argentine traffic at the TCP level per the legacy docs), an HttpClient with getRaw for pagination, and possibly the intermediate CA via extraCaPem. No credentials.',
    status: 'active',
    optionsSchema: arCordobaOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ArCordobaOptions, run: RunParams): Promise<SourceRecord[]> {
        if (options.extraCaPem !== undefined) {
            ctx.log.info(`[${CORDOBA_SOURCE_ID}] extra CA bundle supplied (${(options.extraCaPem.match(CERTIFICATE_BLOCK) ?? []).length} certificate(s)); forwarded as the tlsExtraCaPem request hint.`);
        }
        const rows = await walkGrid(ctx, run.maxItemsPerSource, options.extraCaPem);
        ctx.log.info(`[${CORDOBA_SOURCE_ID}] ${rows.length} licitaciones fetched${rows.length >= run.maxItemsPerSource ? ' (maxItemsPerSource reached - not necessarily the whole census)' : ''}.`);

        const now = ctx.now();
        const range = options.dateRange;
        const kept = range ? rows.filter((r) => isWithinDateRange(parseFechaInicio(r.fechaInicio), range, now)) : rows;
        if (range) ctx.log.info(`[${CORDOBA_SOURCE_ID}] dateRange=${range}: ${kept.length} of ${rows.length} licitaciones pass.`);
        return kept.map(toSourceRecord);
    },
};
