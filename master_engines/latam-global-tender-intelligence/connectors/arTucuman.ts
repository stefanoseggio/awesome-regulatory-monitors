/**
 * arTucuman.ts - Province of Tucumán (Argentina) public tenders connector.
 *
 * Absorbs the legacy actor `tucuman-compras-monitor` (src/fetchListing.ts, envelope.ts, dateFilter.ts,
 * fingerprint.ts, types.ts, parsers/listing.ts). Ported: URL building, paging, parsing,
 * normalisation, record id, fingerprint and the `dateRange` window. NOT ported (router concerns):
 * state.ts, delta.ts (event types NEW_LISTING / STATUS_CHANGE / UPDATED / UNCHANGED), main.ts,
 * Actor.pushData / charging.
 *
 * WHAT A RECORD IS
 * ----------------------------------------------------------------------------
 * One tender (`idCompra`) of `comprasbys.tucuman.gob.ar/ver_llamados_compras_avanzado.php`, across its
 * three `estado_compra` registers (1 = apertura próxima, 2 = en adjudicación, 3 = adjudicada). The
 * whole record - card fields, the modal's montos / lugar / informes, the full multi-renglón breakdown
 * and the pliego PDF link - is inline in the listing page; there is no usable per-tender detail page
 * (legacy AGENTS.md: `detalle_llamado.php` is commented out of the live HTML).
 *
 *   recordId     `idCompra` (the numeric suffix of the tender's own `div#myModal{idCompra}`).
 *   fingerprint  every consumer-visible field, INCLUDING `estadoCompra` (so 1 -> 2 -> 3 transitions
 *                surface as an update; the master-engine equivalent of the legacy STATUS_CHANGE), plus
 *                the legacy `contentHash` input fields (montos, dates, renglones, pliego link ...).
 *   watchText    buyer (`reparticion`) + first line item description (`primerRenglon`), space-joined.
 *
 * Walk policy: every selected estado is paged until `maxItemsPerSource` records were collected, the
 * page returns no tender, or `ceil(num_total / 5)` pages were read. A page that cannot be fetched
 * (after the shared client's retries) stops THAT estado and the walk continues with the next one - the
 * legacy behaviour - but if nothing at all could be fetched the source fails (SourceFetchError). A page
 * whose structure no longer matches (tender modals vs. cards) is NEVER guessed: the source fails.
 * `dateRange` filters on `fechaAperturaSobres` AFTER the capped walk, as the legacy actor does (so with
 * `dateRange` set the source may return fewer than `maxItemsPerSource` records); for estado 1 that
 * date is a scheduled FUTURE date and never falls into the backward-looking window (by design).
 *
 * Encoding: the portal serves `text/html;charset=ISO-8859-1` and the legacy actor decodes the raw
 * bytes explicitly. The only raw (non-entity) high bytes found live are inside dead HTML comments, so
 * field data decodes identically either way; with a raw-capable `ctx.http` (see
 * ../support/portalHttp.ts) the page is decoded as ISO-8859-1 exactly like the legacy actor, otherwise
 * `getText` (UTF-8) is used and a warning is logged if U+FFFD appears OUTSIDE comments.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md, 2026-09-04 / 2026-09-06): plain 200 OK from a plain datacenter IP, no
 * proxy, nginx/1.20.1, `X-Powered-By: PHP/4.4.2-1build1`, `charset=ISO-8859-1`, GET-querystring
 * pagination `?n=1&pagina_actual=N&estado_compra=N`, 5 tenders per page (the last page of a series
 * returns the true remainder), `num_total` hidden input always present and correct even past the end,
 * estado counts 1 = 31, 2 = 3707, 3 = 313 at audit time. The listing card prints only "Renglón 1";
 * the full breakdown lives in each tender's own Bootstrap modal. `Reparticion:` is the one label
 * confirmed to start every tender's card, so it is the group boundary (the site's HTML is malformed
 * enough that table nesting cannot be trusted). Estado 3 uses the past-tense label "Se abrio sobres el
 * dia" instead of "Apertura de sobres:", hence the `/sobres/i` pattern.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy):
 *   GET https://comprasbys.tucuman.gob.ar/ver_llamados_compras_avanzado.php?n=1&pagina_actual=1&estado_compra=1
 *     -> HTTP 200, `Content-Type: text/html; charset=ISO-8859-1`, 91,897 bytes, hidden
 *        `<input name="num_total" type="hidden" value=27>` (27 tenders in estado 1 today, 6 pages),
 *        tender modals present; the 15 raw non-ASCII bytes of the page all sit inside HTML comments
 *        (`<!-- http://172.16.0.33/obras_publicas/ <0xF3 or 0xC3 0xB3> http://rig.tucuman.gov.ar/... -->`).
 * ============================================================================
 */
import type { Cheerio, CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';
import { argentinaLocalToUtc, errorMessage, fetchDecoded } from '../support/portalHttp.js';

export const TUCUMAN_SOURCE_ID = 'ar_tucuman';

export const TUCUMAN_BASE_URL = 'https://comprasbys.tucuman.gob.ar/ver_llamados_compras_avanzado.php';

// Verified live (legacy 2026-09-04): every page fetched (estado 1, 2 and 3, first/middle/last pages)
// returned exactly 5 tenders, except the genuinely-last page of each estado's results, which returned
// the true remainder (e.g. 31 total -> 6 full pages + 1).
export const TUCUMAN_PAGE_SIZE = 5;

/** `estado_compra` query param on the portal: 1 = upcoming opening, 2 = in adjudication, 3 = awarded. */
export type EstadoCompra = '1' | '2' | '3';
export const ESTADOS_COMPRA: readonly EstadoCompra[] = ['1', '2', '3'];

export const ESTADO_LABELS: Record<EstadoCompra, string> = {
    '1': 'Apertura proxima',
    '2': 'En proceso de adjudicacion',
    '3': 'Adjudicada',
};

export type DateRange = '24h' | '7d' | '30d';

// ---------------------------------------------------------------------------
// Types (legacy types.ts)
// ---------------------------------------------------------------------------

/** One line item ("renglon") from a tender's full breakdown table, as published inside its detail modal. */
export interface RenglonDetalle {
    renglon: string;
    descripcion: string;
}

/** Fields scraped from a tender's listing "card" (the div.table / fondo_gris block). */
export interface ListingCardFields {
    idCompra: string;
    reparticion: string;
    tipoCompra: string;
    valorPliego: string;
    numeroExpediente: string;
    rubro: string;
    primerRenglon: string;
    fechaAperturaSobres: string | null;
    fechaAdjudicacion: string | null;
}

/** Fields scraped from a tender's own Bootstrap modal (`#myModal{idCompra}`), inline in the same listing HTML. */
export interface ModalDetailFields {
    numeroConvocatoria: string | null;
    autorizadoPor: string | null;
    presupuestoOficial: string | null;
    garantiaOfertaExigida: string | null;
    lugarApertura: string | null;
    informesAdquisicionPliegos: string | null;
    objetoLibre: string | null;
    renglones: RenglonDetalle[];
    pliegoPdfUrl: string | null;
}

export interface ParsedTender extends ListingCardFields, ModalDetailFields {}

export interface ParsedListingPage {
    numTotal: number;
    items: ParsedTender[];
}

// ---------------------------------------------------------------------------
// Parser (legacy parsers/listing.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = Cheerio<any>;

function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function textOrNull($el: Sel): string | null {
    const text = normalize($el.text());
    return text.length > 0 ? text : null;
}

/**
 * Groups the page's flat, repeated `<div class="column" id="fondo_gris">Label</div>
 * <div class="column">Value</div>` pairs into one map per tender. `id="fondo_gris"` labels are NOT
 * nested one distinct `<div class="table">` per tender in a way DOM-order grouping can trust (the
 * site's HTML is malformed enough that cheerio's forgiving parser does not reproduce the visual
 * nesting - verified live by the legacy actor) - "Reparticion:" is the one label confirmed, across
 * every sample fetched, to always be the first field of a new tender, so it is used as the group
 * boundary instead.
 */
function groupCardFields($: CheerioAPI): Array<Map<string, string>> {
    const groups: Array<Map<string, string>> = [];
    let current: Map<string, string> | null = null;

    $('[id="fondo_gris"]').each((_i, el) => {
        const $label = $(el);
        const label = normalize($label.text());
        const $value = $label.next();
        const value = normalize($value.text());

        if (/^Repartici/i.test(label)) {
            current = new Map();
            groups.push(current);
        }
        if (!current) return; // malformed page before the first Reparticion - defensively skip
        // A tender can only show one "Renglon N X" preview on the card in every sample seen, but if the
        // site ever prints more than one, keep the first rather than overwrite it.
        const group: Map<string, string> = current;
        if (!group.has(label)) group.set(label, value);
    });

    return groups;
}

function pickField(fields: Map<string, string>, pattern: RegExp): string {
    for (const [label, value] of fields) {
        if (pattern.test(label)) return value;
    }
    return '';
}

function pickFieldOrNull(fields: Map<string, string>, pattern: RegExp): string | null {
    const value = pickField(fields, pattern);
    return value.length > 0 ? value : null;
}

function parseKvTable($modal: Sel, $: CheerioAPI): Map<string, string> {
    const kv = new Map<string, string>();
    $modal.find('table[width="400"] tr').each((_i, tr) => {
        const tds = $(tr).find('td');
        if (tds.length !== 2) return; // 1-td rows are section headers (Montos, Informes, ...) - skip
        const label = normalize($(tds[0]).text());
        const value = normalize($(tds[1]).text());
        if (label.length > 0) kv.set(label, value);
    });
    return kv;
}

function parseRenglones($modal: Sel, $: CheerioAPI): RenglonDetalle[] {
    const renglones: RenglonDetalle[] = [];
    const rows = $modal.find('table[border="1"] tr');
    rows.each((i, tr) => {
        if (i === 0) return; // header row: RENGLON / DESCRIPCION
        const tds = $(tr).find('td');
        if (tds.length !== 2) return;
        const renglon = normalize($(tds[0]).text());
        const descripcion = normalize($(tds[1]).text());
        if (renglon.length > 0) renglones.push({ renglon, descripcion });
    });
    return renglones;
}

function parseModalDetail($: CheerioAPI, $modal: Sel, pageUrl: string): ModalDetailFields {
    const kv = parseKvTable($modal, $);

    const numeroConvocatoria = textOrNull($modal.find('p[style*="background-color:#CCCCCC"]').first());
    const objetoLibre = textOrNull($modal.find('p[align="justify"]').first());

    const pdfHref = $modal.find('a[href*="a_pdf"]').first().attr('href');
    const pliegoPdfUrl = pdfHref ? new URL(pdfHref, pageUrl).href : null;

    return {
        numeroConvocatoria,
        autorizadoPor: pickFieldOrNull(kv, /^Por:/i),
        presupuestoOficial: pickFieldOrNull(kv, /^Presupuesto oficial/i),
        garantiaOfertaExigida: pickFieldOrNull(kv, /^Garant.a de oferta/i),
        lugarApertura: pickFieldOrNull(kv, /^Lugar/i),
        informesAdquisicionPliegos: pickFieldOrNull(kv, /^Adquisici.n de pliegos/i),
        objetoLibre,
        renglones: parseRenglones($modal, $),
        pliegoPdfUrl,
    };
}

/** Thrown when the page's tender modals and tender cards cannot be paired 1:1 (the site's markup changed). */
export class TucumanStructureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TucumanStructureError';
    }
}

/**
 * Parses one listing page (`ver_llamados_compras_avanzado.php?estado_compra=N&pagina_actual=N`).
 * Everything a tender has to offer - including the full multi-renglón breakdown and the pliego PDF
 * link - is already inline in this one response, in the tender's own Bootstrap modal
 * (`#myModal{idCompra}`). No separate detail request is needed or exists usably.
 */
export function parseListingPage(html: string, pageUrl: string): ParsedListingPage {
    const $ = cheerio.load(html);

    const numTotalRaw = $('input[name="num_total"]').attr('value');
    const numTotal = numTotalRaw ? parseInt(numTotalRaw, 10) : 0;

    const modals = $('div.modal[id^="myModal"]').toArray();
    const cardGroups = groupCardFields($);

    if (modals.length !== cardGroups.length) {
        throw new TucumanStructureError(
            `Listing page structure mismatch: found ${modals.length} tender modal(s) but ${cardGroups.length} ` +
                `tender card(s) - the site's HTML shape may have changed. Refusing to guess the pairing. URL: ${pageUrl}`,
        );
    }

    const items: ParsedTender[] = modals.map((modalEl, i) => {
        const idCompra = ($(modalEl).attr('id') ?? '').replace('myModal', '');
        const fields = cardGroups[i] ?? new Map<string, string>();
        const modalDetail = parseModalDetail($, $(modalEl), pageUrl);

        return {
            idCompra,
            reparticion: pickField(fields, /^Repartici/i),
            tipoCompra: pickField(fields, /^Tipo de compra/i),
            valorPliego: pickField(fields, /^Valor del pliego/i),
            numeroExpediente: pickField(fields, /de expediente/i),
            rubro: pickField(fields, /^Rubro/i),
            primerRenglon: pickField(fields, /^Rengl/i),
            fechaAperturaSobres: pickFieldOrNull(fields, /sobres/i),
            fechaAdjudicacion: pickFieldOrNull(fields, /adjudicaci.n:/i),
            ...modalDetail,
        };
    });

    return { numTotal: Number.isFinite(numTotal) ? numTotal : 0, items };
}

// ---------------------------------------------------------------------------
// Date window (legacy dateFilter.ts)
// ---------------------------------------------------------------------------

const RANGE_MS: Record<DateRange, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
};

// The portal renders its own dates as "DD/MM/YYYY, HH:MM:SS" (fechaAperturaSobres, e.g.
// "10/09/2026, 12:30:00") or occasionally date-only "DD/MM/YYYY" (fechaAdjudicacion, e.g.
// "08/11/2023") - verified by the legacy actor against real fixtures and a live fetch on 2026-09-06.
const DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})(?:,\s*(\d{2}):(\d{2}):(\d{2}))?$/;

/**
 * Parses one of the portal's own date strings into a Date, or returns null for anything that doesn't
 * match (null/empty input, or an unexpected shape) - callers treat null as "cannot verify the date
 * window, so exclude rather than guess", never throw. The string is always Tucumán wall-clock time
 * (fixed UTC-3, no DST since 2009), converted to the correct UTC instant via a constant offset, NOT
 * via the runtime's local timezone.
 */
export function parseSourceDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const match = DATE_PATTERN.exec(value.trim());
    if (!match) return null;

    const [, dd = '', mm = '', yyyy = '', hh = '00', min = '00', ss = '00'] = match;
    const date = argentinaLocalToUtc(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min), Number(ss));
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * True when `date` falls within the last `range` (a backward-looking window ending at `now`, e.g.
 * "24h" = (now - 24h, now]). A future `date` is NEVER within range - upcoming tenders' fechaAperturaSobres
 * is a scheduled FUTURE date, so this filter has no matches for estado 1 by design, not by bug.
 */
export function isWithinDateRange(date: Date, range: DateRange, now: Date): boolean {
    const ageMs = now.getTime() - date.getTime();
    return ageMs >= 0 && ageMs <= RANGE_MS[range];
}

// ---------------------------------------------------------------------------
// Record (legacy fingerprint.ts / envelope.ts, minus the router-owned envelope)
// ---------------------------------------------------------------------------

export interface TenderRecordInput extends ParsedTender {
    estadoCompra: EstadoCompra;
    listingPageUrl: string;
}

export function buildListingUrl(estado: EstadoCompra, pagina: number): string {
    return `${TUCUMAN_BASE_URL}?n=1&pagina_actual=${pagina}&estado_compra=${estado}`;
}

/**
 * The legacy `contentHash` (sha1 over everything that can change while a tender stays in the same
 * estado) is recomputed with the shared helper; `estadoCompra` is added for the router fingerprint.
 */
function contentParts(tender: ParsedTender): unknown[] {
    return [
        tender.reparticion,
        tender.tipoCompra,
        tender.valorPliego,
        tender.numeroExpediente,
        tender.rubro,
        tender.primerRenglon,
        tender.fechaAperturaSobres,
        tender.fechaAdjudicacion,
        tender.numeroConvocatoria,
        tender.autorizadoPor,
        tender.presupuestoOficial,
        tender.garantiaOfertaExigida,
        tender.lugarApertura,
        tender.informesAdquisicionPliegos,
        tender.objetoLibre,
        tender.renglones,
        tender.pliegoPdfUrl,
    ];
}

/**
 * Dataset row with the legacy field names. Omitted on purpose (router-owned): `record_id`,
 * `event_type`, `scraped_at`, `is_new`; and the state-dependent `previousEstado`. The legacy
 * `listingPageUrl` / `scrapedAt` were already folded into `source_url` / `scraped_at` by the legacy envelope.
 */
export function toSourceRecord(tender: TenderRecordInput): SourceRecord {
    const contentHash = fingerprintOf(contentParts(tender));
    const { listingPageUrl, ...rest } = tender;
    return {
        recordId: tender.idCompra,
        fingerprint: fingerprintOf([tender.estadoCompra, contentHash]),
        payload: {
            ...rest,
            estadoCompraLabel: ESTADO_LABELS[tender.estadoCompra],
            contentHash,
            // No live per-tender page exists: the closest working pointer is the listing page plus the modal's own DOM id.
            source_url: `${listingPageUrl}#myModal${tender.idCompra}`,
        },
        watchText: [tender.reparticion, tender.primerRenglon].filter((p) => p.trim() !== '').join(' '),
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const arTucumanOptionsSchema = z
    .object({
        /** 1 = apertura próxima, 2 = en adjudicación, 3 = adjudicadas. */
        estados: z.array(z.enum(['1', '2', '3'])).min(1).default(['1']),
        /** Keep only tenders whose fechaAperturaSobres falls in the last 24h / 7d / 30d (applied after the capped walk). */
        dateRange: z.enum(['24h', '7d', '30d']).optional(),
    })
    .strict();
export type ArTucumanOptions = z.infer<typeof arTucumanOptionsSchema>;

async function fetchPage(ctx: ConnectorContext, url: string): Promise<string> {
    // ISO-8859-1 when the client can hand over raw bytes; otherwise UTF-8 `getText` (lossless for the field data, see header).
    return fetchDecoded(ctx, url, { charset: 'iso-8859-1', onMissingRaw: 'utf8-fallback', sourceId: TUCUMAN_SOURCE_ID });
}

export const arTucumanConnector: Connector<ArTucumanOptions> = {
    id: TUCUMAN_SOURCE_ID,
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'tucuman-compras-monitor',
    description:
        'Province of Tucumán (Argentina) public tenders (licitaciones públicas / privadas, concursos de precios, contrataciones directas) across apertura próxima, en adjudicación and adjudicadas, with full renglón breakdown, montos and pliego PDF link. Open server-rendered portal, no credentials, no proxy.',
    status: 'active',
    optionsSchema: arTucumanOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ArTucumanOptions, run: RunParams): Promise<SourceRecord[]> {
        const collected: TenderRecordInput[] = [];
        let failedSeries = 0;
        let lastFailure = '';

        for (const estado of [...new Set(options.estados)]) {
            if (collected.length >= run.maxItemsPerSource) break;

            let totalPages = 1;
            for (let pagina = 1; pagina <= totalPages; pagina += 1) {
                if (collected.length >= run.maxItemsPerSource) break;

                const url = buildListingUrl(estado, pagina);
                let parsed: ParsedListingPage;
                try {
                    parsed = parseListingPage(await fetchPage(ctx, url), url);
                } catch (error) {
                    if (error instanceof TucumanStructureError) throw new SourceFetchError(error.message, TUCUMAN_SOURCE_ID);
                    failedSeries += 1;
                    lastFailure = errorMessage(error);
                    ctx.log.warning(`[${TUCUMAN_SOURCE_ID}] estado=${estado} pagina=${pagina}: request failed after retries (${lastFailure}) - stopping this series.`);
                    break;
                }

                if (pagina === 1) {
                    totalPages = Math.max(1, Math.ceil(parsed.numTotal / TUCUMAN_PAGE_SIZE));
                    ctx.log.info(`[${TUCUMAN_SOURCE_ID}] estado=${estado}: num_total=${parsed.numTotal} (${totalPages} pages of ${TUCUMAN_PAGE_SIZE}).`);
                }
                if (parsed.items.length === 0) {
                    ctx.log.info(`[${TUCUMAN_SOURCE_ID}] estado=${estado} pagina=${pagina}: 0 tenders - stopping this series.`);
                    break;
                }
                for (const item of parsed.items) {
                    if (collected.length >= run.maxItemsPerSource) break;
                    collected.push({ ...item, estadoCompra: estado, listingPageUrl: url });
                }
            }
        }

        if (collected.length === 0 && failedSeries > 0) {
            throw new SourceFetchError(`Tucumán listing could not be fetched (${failedSeries} failed request series; last error: ${lastFailure}).`, TUCUMAN_SOURCE_ID);
        }

        const now = ctx.now();
        const range = options.dateRange;
        const kept = range
            ? collected.filter((t) => {
                  const date = parseSourceDate(t.fechaAperturaSobres);
                  return date !== null && isWithinDateRange(date, range, now);
              })
            : collected;
        if (range) ctx.log.info(`[${TUCUMAN_SOURCE_ID}] dateRange=${range}: ${kept.length} of ${collected.length} tenders pass.`);

        // A tender id can in principle be listed twice if the register shifts between two page reads; first occurrence wins.
        const seen = new Set<string>();
        const unique = kept.filter((t) => (seen.has(t.idCompra) ? false : (seen.add(t.idCompra), true)));
        return unique.map(toSourceRecord);
    },
};
