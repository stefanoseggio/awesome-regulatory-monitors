/**
 * arSantaFe.ts - Province of Santa Fe (Argentina) "Gestiones de Compra" connector.
 *
 * Absorbs the legacy actor `santafe-compras-monitor` (src/fetchGestiones.ts, lookups.ts, urls.ts,
 * normalize.ts, parsers/listing.ts, parsers/detail.ts, the filter part of input.ts). Ported:
 * URL building, request logic, parsing, normalisation, record id, fingerprint. NOT ported (router
 * concerns): state.ts, the delta early-stop / watermark / baseline / recheck / status-sweep logic,
 * event types, Actor.pushData / charging, and the deprecated `dateRange` preset (the legacy README
 * marks it deprecated in favour of `openingFrom` / `openingTo`, which ARE ported).
 *
 * WHAT A RECORD IS
 * ----------------------------------------------------------------------------
 * One purchasing process (`idGestion`) of the provincial register. Listing rows come from the site's
 * own read-only JSON endpoint; with `fetchDetail` (default true, as in the legacy actor) one public
 * detail page per record adds rubros, documents, deadlines, contact and the amendment fingerprint.
 *
 *   recordId     `idGestion` (numeric string, allocated at creation, unique across estados).
 *   fingerprint  every consumer-visible listing field INCLUDING `estado` (so AP -> ET -> CO moves
 *                surface as an update; this is the master-engine equivalent of the legacy
 *                STATUS_CHANGE event) + the legacy detail `contentHash` (so an added circular,
 *                acta or amended deadline surfaces as an update; the legacy UPDATED event).
 *                The time-relative derived fields (`daysUntilOpening`, `isOpeningInFuture`,
 *                `daysSincePublished`, `daysUntilDeadline`) are in the payload but deliberately NOT in
 *                the fingerprint: they change every day, which would re-emit every record daily.
 *   watchText    buyer (`comprador`, falling back to the detail's "Organismo licitante") + object
 *                (`objeto`, the process title), space-joined.
 *
 * Detail-fetch policy: a detail request that FAILS (network / 5xx after the shared client's retries)
 * drops that record from this run's output instead of emitting a half-enriched row. The router only
 * marks emitted records as seen, so the record is picked up again next run - the legacy behaviour
 * ("an error detail leaves the record unseen so the next run retries it"). A detail page that does
 * not exist yet ("La gestión no existe o no está publicada aún") is NOT an error: the record is
 * emitted with `detailError: "UNPUBLISHED"`, exactly as the legacy actor does. If every detail
 * request of a run fails, the source fails (SourceFetchError) rather than returning nothing quietly.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md, 2026-09-08): `site/AppAjax.php?a=consultas.getContrataciones` is the
 * JSON endpoint the site's own search page calls. Every parameter below (`estado`, `anio`, `objeto`,
 * `tipoGestion` as ONE letter code, `tipoModalidad`, `comprador`/`solicitante` as
 * idOrganismoLey12510, `idEspecie`, `idFamilia`, `nroGestion`, `nroExpediente`, `sort`+`dir`,
 * `start`+`limit`) was live-verified with result counts. No User-Agent, cookie, proxy or JS is
 * needed (a bare request got HTTP 200); `robots.txt` -> 404; Apache with HSTS/CSP only, no WAF. The
 * detail page `gestion.php?idGestion=N` is public; `&contar=1` is NEVER requested (it increments the
 * site's view counter). Data licence per the site: CC BY-SA 2.5 AR (kept in `data_source`).
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy, honest
 * defaults, no impersonation):
 *   GET https://www.santafe.gov.ar/gestionesdecompras/site/AppAjax.php?a=consultas.getContrataciones
 *       &estado=AP&sort=idGestion&dir=DESC&start=0&limit=3
 *     -> HTTP 200 application/json; charset=utf-8, 1,872 bytes; `{"success":true,"errors":{"reason":""},
 *        "data":[3 rows],"type":1,"totalRecords":"98","extraData":{"apTotal":"98","etTotal":"2437",
 *        "coTotal":"29170"}}`; row keys exactly the legacy list (anioGestion, comprador,
 *        fechaHoraApertura, fechaHoraAperturaFija, idGestion, idOrganismoGestion, numeroAño,
 *        numeroExpediente, numeroGestion, objeto, objetoCompleto, tipoGestion, tipoModalidad,
 *        valorPliego); `estado=ET` and `estado=CO` rows additionally carry `destinos` (as documented).
 *   GET .../gestion.php?idGestion=139530 -> 200 text/html, 9,080 bytes, `<h3>CONTRATACIÓN DIRECTA Nº
 *        29/2026</h3>`, `div.col-12.mb-4` blocks with `<b>Label:</b><span>` pairs, a
 *        `<h4>Documentos</h4>` block with `./../descargar.php?...` links - the shape the parser expects.
 *   GET .../AppAjax.php?a=shared.getOrganismosLey -> 200 JSON `{"success":true,...,"data":[{
 *        "idOrganismoLey12510":"27","nombre":"ADMINISTRACIÓN PROVINCIAL DE IMPUESTOS"},...]}`.
 *   The captured responses are the `santafe.live-2026-10-21.*` fixtures used by the tests.
 *   End to end: this connector, driven through lib/http.ts `createHttpClient` (Node's global fetch, honest
 *   User-Agent) against the live portal, returned 4 AP records with detail (79 payload keys; idGestion 139530
 *   with its pliego document and "$ 58.500.000,00" monto) and 3 ET records for `objeto=medicamentos`.
 * ============================================================================
 */
import { createHash } from 'node:crypto';

import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { describeSanitization, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';
import { errorMessage } from '../support/portalHttp.js';

export const SANTAFE_SOURCE_ID = 'ar_santafe';

// ---------------------------------------------------------------------------
// Types (legacy types.ts)
// ---------------------------------------------------------------------------

export type EstadoCode = 'AP' | 'ET' | 'CO';
export type SortBy = 'newest' | 'openingSoonest' | 'openingLatest' | 'mostViewed';

/** One row of AppAjax.php?a=consultas.getContrataciones (keys verified live 2026-09-08 and 2026-10-21). */
export interface ListingItem {
    idGestion: string;
    tipoGestion: string;
    /** DD-MM-YYYY */
    fechaHoraApertura: string;
    /** YYYY-MM-DD HH:mm:ss, Argentina time */
    fechaHoraAperturaFija: string;
    /** "18-2026" */
    numeroAño?: string;
    numeroGestion: string;
    anioGestion: string;
    valorPliego: string;
    objeto: string;
    objetoCompleto?: string;
    idOrganismoGestion: string;
    comprador: string;
    tipoModalidad: string;
    numeroExpediente: string;
    /** Present on ET/CO rows only. */
    destinos?: string;
}

export interface ListingFilters {
    anio: number | null;
    objeto: string | null;
    /** Letter codes from shared.getTipoEstatico (L, P, T, ...); one query per code, [] = all types. */
    tipoGestion: string[];
    tipoModalidad: string | null;
    /** idOrganismoLey12510 of the organismo licitante (buyer). */
    comprador: string | null;
    /** idOrganismoLey12510 of the organismo comitente (requesting body). */
    solicitante: string | null;
    /** idEspecie (rubro). */
    idEspecie: string | null;
    /** idFamilia (subrubro) - only meaningful together with idEspecie. */
    idFamilia: string | null;
    nroGestion: string | null;
    nroExpediente: string | null;
    sortBy: SortBy;
}

/** One concrete server-side query = one estado (x one tipoGestion code when several are selected). */
export interface ListingQuery {
    estado: EstadoCode;
    tipoGestion: string | null;
    filters: ListingFilters;
}

export interface GestionDocument {
    tipo: string;
    nombre: string;
    url: string;
}

/** The v1 `detail` object - kept verbatim on every record for backwards compatibility. */
export interface GestionDetail {
    fields: Record<string, string>;
    rubros: string[];
    documentos: GestionDocument[];
}

export type DocumentKind =
    | 'pliego'
    | 'circular'
    | 'llamado'
    | 'acta_apertura'
    | 'nomina_oferentes'
    | 'cuadro_comparativo'
    | 'informe_comision'
    | 'preadjudicacion'
    | 'adjudicacion'
    | 'orden_provision'
    | 'documento_provision'
    | 'planimetria'
    | 'otros';

export interface DocumentRecord {
    kind: DocumentKind;
    tipo: string;
    nombre: string;
    url: string;
    /** The site's own attachment id (from descargar.php?id=...). */
    id: string | null;
}

export interface RubroRecord {
    rubro: string | null;
    subrubro: string | null;
    raw: string;
}

export interface ExpedienteRecord {
    label: string;
    code: string;
    url: string | null;
}

export const DATA_SOURCE_ATTRIBUTION =
    'Gestiones de Compra - Gobierno de la Provincia de Santa Fe (santafe.gov.ar/gestionesdecompras), CC BY-SA 2.5 AR';

// ---------------------------------------------------------------------------
// URLs (legacy urls.ts)
// ---------------------------------------------------------------------------

export const BASE_URL = 'https://www.santafe.gov.ar';
export const SITE_ROOT = `${BASE_URL}/gestionesdecompras/site/`;
const APP_AJAX = '/gestionesdecompras/site/AppAjax.php';

export const ESTADOS: EstadoCode[] = ['AP', 'ET', 'CO'];

export const ESTADO_LABELS: Record<EstadoCode, string> = {
    AP: 'PARA APERTURA',
    ET: 'EN TRÁMITE',
    CO: 'CONCLUIDA',
};

// shared.getTipoEstatico&tipo=TipoGestion&combo=true, captured 2026-09-08 (legacy).
export const TIPO_GESTION: Record<string, string> = {
    B: 'CONCURSO PÚBLICO',
    V: 'CONCURSO PRIVADO',
    C: 'CONCURSO DE PRECIOS',
    T: 'CONTRATACIÓN DIRECTA',
    I: 'CONCURSOS DE PROYECTOS INTEGRALES',
    D: 'GESTION DIRECTA',
    A: 'LICITACIÓN ACELERADA',
    L: 'LICITACIÓN PÚBLICA',
    P: 'LICITACIÓN PRIVADA',
    S: 'SUBASTA O REMATE PÚBLICO',
    X: 'PROCEDIMIENTO COMPETITIVO AGIL',
    Y: 'ENTES PORTUARIOS - CONTRATACIONES',
    O: 'OTROS',
};

// shared.getTipoModalidad&combo=true, captured 2026-09-08 (legacy).
export const TIPO_MODALIDAD: Record<string, string> = {
    '1': 'Sin Modalidad',
    '2': 'Convenio Marco',
    '3': 'Contratación Unificada',
    '4': 'Orden de Compra Abierta',
    '5': 'Subasta Inversa',
    '6': 'Llave en Mano',
    '7': 'Consumo Convenio Marco',
    '9999': 'Por Defecto',
};

const SORT_PARAMS: Record<SortBy, { sort: string; dir: 'ASC' | 'DESC' }> = {
    newest: { sort: 'idGestion', dir: 'DESC' },
    openingSoonest: { sort: 'fechaHoraApertura', dir: 'ASC' },
    openingLatest: { sort: 'fechaHoraApertura', dir: 'DESC' },
    mostViewed: { sort: 'consultada', dir: 'DESC' },
};

/**
 * Builds the read-only JSON listing URL the site's own search page calls.
 * Every parameter was live-verified 2026-09-08 with result counts (see legacy AGENTS.md):
 * `estado`, `anio`, `objeto`, `tipoGestion` (ONE letter code - comma-joined values are ignored),
 * `tipoModalidad`, `comprador` and `solicitante` (idOrganismoLey12510), `idEspecie`, `idFamilia`
 * (the site's own sub-rubro select is misnamed `form-select` and does nothing; the backend honours
 * `idFamilia`), `nroGestion`, `nroExpediente`, `sort`+`dir`, `start`+`limit`.
 */
export function listingPath(query: ListingQuery, start: number, limit: number): string {
    const { filters } = query;
    const params = new URLSearchParams();
    params.set('a', 'consultas.getContrataciones');
    params.set('estado', query.estado);
    if (filters.anio !== null) params.set('anio', String(filters.anio));
    if (filters.objeto) params.set('objeto', filters.objeto);
    if (query.tipoGestion) params.set('tipoGestion', query.tipoGestion);
    if (filters.tipoModalidad) params.set('tipoModalidad', filters.tipoModalidad);
    if (filters.comprador) params.set('comprador', filters.comprador);
    if (filters.solicitante) params.set('solicitante', filters.solicitante);
    if (filters.idEspecie) params.set('idEspecie', filters.idEspecie);
    if (filters.idFamilia) params.set('idFamilia', filters.idFamilia);
    if (filters.nroGestion) params.set('nroGestion', filters.nroGestion);
    if (filters.nroExpediente) params.set('nroExpediente', filters.nroExpediente);
    const { sort, dir } = SORT_PARAMS[filters.sortBy];
    params.set('sort', sort);
    params.set('dir', dir);
    params.set('start', String(start));
    params.set('limit', String(limit));
    return `${APP_AJAX}?${params.toString()}`;
}

/** The public detail page. Never append `&contar=1` - that variant increments the site's view counter. */
export function detailPath(idGestion: string): string {
    return `/gestionesdecompras/site/gestion.php?idGestion=${encodeURIComponent(idGestion)}`;
}

export function detailUrl(idGestion: string): string {
    return `${BASE_URL}${detailPath(idGestion)}`;
}

/** Print-ready PDF of the whole record (application/pdf, ~30 KB). */
export function printPdfUrl(idGestion: string): string {
    return `${SITE_ROOT}output.php?a=gestiones.ver&idGestion=${encodeURIComponent(idGestion)}&print=1`;
}

/** Documents-only view of the record. */
export function documentsUrl(idGestion: string): string {
    return `${SITE_ROOT}gestion.php?idGestion=${encodeURIComponent(idGestion)}&solodocs=1`;
}

// The site's own "Ofertar" button target (base_exp_url in site/index.php, 2026-08-28 build) for
// electronic procedures on gestionvirtual (legacy urls.ts).
const BID_BASE_URL = 'https://gestionvirtual.santafe.gob.ar/#/bandeja_proveedores/create/form/680a87a12a055d2295ea39a0';

export function bidUrl(numeroExpediente: string): string {
    return `${BID_BASE_URL}?expedienteCode=${encodeURIComponent(numeroExpediente)}`;
}

/** Resolve a document href from the detail page (./../descargar.php?...) to an absolute URL. */
export function absoluteDocumentUrl(href: string): string {
    return new URL(href, SITE_ROOT).toString();
}

export const COMBO_PATHS = {
    organismos: `${APP_AJAX}?a=shared.getOrganismosLey`,
    rubros: `${APP_AJAX}?a=shared.getEspeciesPrincipales`,
    subrubros: (idEspecie: string): string => `${APP_AJAX}?a=shared.getFamiliasByEspecie&idEspecie=${encodeURIComponent(idEspecie)}`,
};

// ---------------------------------------------------------------------------
// Normalisation (legacy normalize.ts) - every function is total: invalid input yields null.
// ---------------------------------------------------------------------------

// The register is operated from Santa Fe, Argentina. Argentina has used a fixed UTC-3 offset
// (America/Argentina/Cordoba) with no daylight saving since 2009, so a constant offset is exact.
// Verified live (legacy, 2026-09-08): detail pages published "07-09-2026 13:00 Hs." were visible at
// 06:45 UTC on 08-09, consistent with UTC-3.
export const SITE_UTC_OFFSET_MINUTES = -3 * 60;

/** Calendar date (YYYY-MM-DD) of an instant as seen from Santa Fe. */
export function siteCalendarDate(instant: Date): string {
    return new Date(instant.getTime() + SITE_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Santa Fe wall-clock -> UTC instant. */
export function siteLocalToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - SITE_UTC_OFFSET_MINUTES * 60_000);
}

function validYmd(y: number, m: number, d: number): boolean {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    return true;
}

/**
 * The listing's `fechaHoraAperturaFija` ("2026-09-04 09:30:00", Santa Fe time) -> UTC ISO instant.
 * Rows with the epoch placeholder "1969-12-31" (seen live on a few very old CO rows) yield null.
 */
export function parseSiteDateTime(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [y = 0, m = 0, d = 0, hh = 0, mm = 0, ss = 0] = match.slice(1).map((v) => Number(v ?? 0));
    if (!validYmd(y, m, d)) return null;
    return siteLocalToUtc(y, m, d, hh, mm, ss).toISOString();
}

/**
 * The detail page's "DD-MM-YYYY HH:mm Hs." stamps (Fecha de Publicación, Fecha y hora límite de
 * presentación de ofertas, Fecha y hora de apertura de ofertas - the latter often followed by
 * " - <note>") -> UTC ISO instant. A bare "DD-MM-YYYY" degrades to local midnight.
 */
export function parseSiteDetailDateTime(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = value.trim().match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (!match) return null;
    const d = Number(match[1]);
    const m = Number(match[2]);
    const y = Number(match[3]);
    if (!validYmd(y, m, d)) return null;
    const hh = match[4] === undefined ? 0 : Number(match[4]);
    const mm = match[5] === undefined ? 0 : Number(match[5]);
    if (hh > 23 || mm > 59) return null;
    return siteLocalToUtc(y, m, d, hh, mm).toISOString();
}

/** Calendar date (Santa Fe) of a UTC ISO instant. */
export function isoToSiteDate(iso: string | null): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? siteCalendarDate(new Date(t)) : null;
}

/** Signed whole days from `fromIso` (YYYY-MM-DD) to `toIso`; negative when `toIso` is in the past. */
export function daysBetween(fromIso: string | null, toIso: string | null): number | null {
    if (!fromIso || !toIso) return null;
    const a = Date.parse(`${fromIso}T00:00:00Z`);
    const b = Date.parse(`${toIso}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86_400_000);
}

export interface Money {
    amount: number;
    currency: 'ARS' | 'USD';
}

/**
 * Argentine money strings: "$  207.302.040,00" (ARS), "U$S 60.000,00" (USD), "$ 8209,50 (PESOS ...)",
 * "$  0 -", "$  480.-", "$  7.00". The thousands separator is "." and the decimal separator "," -
 * except that a bare "7.00" / "480.-" style (two digits after a single dot, no comma) is a decimal.
 * Text-only values ("NO APLICA", "SIN COSTO") yield null.
 */
export function parseMoney(value: string | null | undefined): Money | null {
    if (!value) return null;
    const v = value.replace(/\s+/g, ' ').trim();
    let currency: Money['currency'] | null = null;
    if (/U\$S|USD|D[OÓ]LARES/i.test(v)) currency = 'USD';
    else if (/\$|PESOS|ARS/i.test(v)) currency = 'ARS';
    if (!currency) return null;
    const numMatch = v.replace(/^[^\d]*/, '').match(/^(\d[\d.]*)(?:,(\d{1,2}))?/);
    if (!numMatch) return null;
    let intPart = numMatch[1] ?? '';
    let decPart = numMatch[2] ?? '';
    if (!decPart) {
        // "7.00" / "480.-": a single dot followed by 1-2 digits at the end is a decimal point
        const dotDecimal = intPart.match(/^(\d+)\.(\d{1,2})$/);
        if (dotDecimal) {
            intPart = dotDecimal[1] ?? '';
            decPart = dotDecimal[2] ?? '';
        }
    }
    const amount = Number(`${intPart.replace(/\./g, '')}.${decPart || '0'}`);
    return Number.isFinite(amount) ? { amount, currency } : null;
}

/**
 * "Valor del pliego" is free text on this register. Returns true when the text says the bid
 * documents are free / not applicable, false when a price is quoted, null when the field is empty or
 * undecidable.
 */
export function valorPliegoIsFree(value: string | null | undefined): boolean | null {
    if (!value) return null;
    const v = value.trim().toUpperCase();
    if (v === '' || v === '-' || v === '--') return null;
    const money = parseMoney(v);
    if (money && money.amount > 0) return false;
    if (money && money.amount === 0) return true;
    if (/NO APLICA|NO CORRESPONDE|SIN CARGO|SIN COSTO|SIN VALOR|S\/V|GRATUIT|NO TIENE COSTO/.test(v)) return true;
    return null;
}

/** Strip accents/case for tolerant matching of Spanish labels and names. */
export function fold(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Electronic procedures are handled on gestionvirtual.santafe.gob.ar; the site itself decides whether
// to show an "Ofertar" button with this exact pattern (copied by the legacy actor from
// modules/consultas/js/index.js, 2026-08-28 build).
const ELECTRONIC_EXPEDIENTE = /^[A-Za-z]{1,6}-\d{1,4}-\d{1,8}-APPSF-[A-Za-z]{1,2}(#[A-Za-z]{1,6})*/;

export function isElectronicExpediente(value: string | null | undefined): boolean {
    return !!value && ELECTRONIC_EXPEDIENTE.test(value.trim());
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Argentine phone fragments: "+54 9 342 45196329", "(0342) 450-6600", "342-4910056", "342 5083261"
const PHONE_RE = /(?:\+54[\s-]*)?(?:9[\s-]*)?\(?0?\d{2,4}\)?[\s-]*\d{3,4}[\s-]?\d{3,5}/g;

export function extractEmails(value: string | null | undefined): string[] {
    if (!value) return [];
    return [...new Set((value.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

export function extractPhones(value: string | null | undefined): string[] {
    if (!value) return [];
    const withoutEmails = value.replace(EMAIL_RE, ' ');
    return [...new Set((withoutEmails.match(PHONE_RE) ?? []).map((p) => p.replace(/\s+/g, ' ').trim()))].filter(
        (p) => p.replace(/\D/g, '').length >= 8,
    );
}

/** The register renders "-" / "--" for an absent value. */
export function blankToNull(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const v = value.replace(/\s+/g, ' ').trim();
    return v === '' || v === '-' || v === '--' ? null : v;
}

/** SHA-1 of a canonical JSON serialisation - the legacy per-record `contentHash`. */
export function contentFingerprint(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Listing parser (legacy parsers/listing.ts)
// ---------------------------------------------------------------------------

export interface ListingPage {
    /**
     * false when the body is not the JSON the site's own search page gets back (maintenance HTML, an
     * empty 500 body, a shape change). A page past the end is still a listing page (success:true, data:[]).
     */
    isListingPage: boolean;
    items: ListingItem[];
    /** `totalRecords` = rows matching the filter set in THIS estado. */
    totalRecords: number | null;
    /** `extraData` = counts for all three estados under the current filter set. */
    totals: Record<EstadoCode, number> | null;
    /** The API's own `errors.reason`, for diagnostics. */
    reason: string | null;
}

interface RawListing {
    success?: unknown;
    errors?: { reason?: unknown };
    data?: unknown;
    totalRecords?: unknown;
    extraData?: { apTotal?: unknown; etTotal?: unknown; coTotal?: unknown } | string;
}

function toCount(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse and validate a `consultas.getContrataciones` response. Live-verified shape (2026-09-08 and
 * again 2026-10-21): `{success:true, errors:{reason:""}, data:[...], type:"1"|1, totalRecords:"78",
 * extraData:{apTotal:"78", etTotal:"2214", coTotal:"28921"}}`; every row carries a numeric-string
 * `idGestion`.
 */
export function parseListingResponse(body: string): ListingPage {
    const notListing: ListingPage = { isListingPage: false, items: [], totalRecords: null, totals: null, reason: null };
    let raw: RawListing;
    try {
        raw = JSON.parse(body) as RawListing;
    } catch {
        return notListing;
    }
    if (!raw || typeof raw !== 'object') return notListing;
    const reason = typeof raw.errors?.reason === 'string' && raw.errors.reason ? raw.errors.reason : null;
    if (raw.success !== true || !Array.isArray(raw.data)) return { ...notListing, reason };
    const extra = raw.extraData;
    if (!extra || typeof extra !== 'object') return { ...notListing, reason };
    const totals = {
        AP: toCount(extra.apTotal),
        ET: toCount(extra.etTotal),
        CO: toCount(extra.coTotal),
    };
    if (totals.AP === null || totals.ET === null || totals.CO === null) return { ...notListing, reason };

    const items: ListingItem[] = [];
    for (const row of raw.data as unknown[]) {
        if (!row || typeof row !== 'object') return { ...notListing, reason };
        const item = row as Record<string, unknown>;
        if (typeof item.idGestion !== 'string' || !/^\d+$/.test(item.idGestion)) return { ...notListing, reason };
        items.push(item as unknown as ListingItem);
    }
    return {
        isListingPage: true,
        items,
        totalRecords: toCount(raw.totalRecords),
        totals: totals as Record<EstadoCode, number>,
        reason,
    };
}

// ---------------------------------------------------------------------------
// Detail parser (legacy parsers/detail.ts)
// ---------------------------------------------------------------------------

export interface ParsedDetail {
    /** false for "La gestión no existe o no está publicada aún" (HTTP 200, no data blocks). */
    exists: boolean;
    /** "<h3>LICITACIÓN PÚBLICA Nº 18/2026</h3>" split into its parts. */
    title: string | null;
    tipoGestionName: string | null;
    numeroGestion: string | null;
    anioGestion: string | null;
    /** The v1 shape, kept verbatim on every record. */
    legacy: GestionDetail;
    estadoLabel: string | null;
    estadoStage: string | null;
    estadoCode: EstadoCode | null;
    publishedAtLocal: string | null;
    modalidad: string | null;
    alcance: string | null;
    objeto: string | null;
    descripcion: string | null;
    rubros: RubroRecord[];
    organismoComitente: string[];
    organismoLicitante: string | null;
    submissionPlace: string | null;
    submissionDeadlineLocal: string | null;
    openingPlace: string | null;
    openingAtLocal: string | null;
    openingNote: string | null;
    deliveryPlaceAndDate: string | null;
    contactInfo: string | null;
    valorPliego: string | null;
    montoOriginalText: string | null;
    expedientes: ExpedienteRecord[];
    /** Free-form "IMPORTANTE" style blocks some buyers add (no proper label). */
    notes: string[];
    documents: DocumentRecord[];
}

// Live-verified vocabulary of <h5> document headers (legacy, 120-page sample, 2026-09-08):
// Pliego 94, Otros 49, Orden de Provisión 47, Cuadro Comparativo de Precios 43, Acta de Apertura 35,
// Informe de Preadjudicación 32, Norma Legal de Adjudicación 29, Llamado a Licitación 10, Circulares
// 4, Informe de Comisión 3, Documento de Provisión 2, Nómina de Oferentes 1, Planimetría 1.
const DOCUMENT_KINDS: Array<[RegExp, DocumentKind]> = [
    [/^PLIEGO/, 'pliego'],
    [/CIRCULAR/, 'circular'],
    [/LLAMADO/, 'llamado'],
    [/ACTA DE APERTURA/, 'acta_apertura'],
    [/NOMINA DE OFERENTES/, 'nomina_oferentes'],
    [/CUADRO COMPARATIVO/, 'cuadro_comparativo'],
    [/INFORME DE COMISION/, 'informe_comision'],
    [/PREADJUDICACION/, 'preadjudicacion'],
    [/ADJUDICACION/, 'adjudicacion'],
    [/ORDEN DE PROVISION/, 'orden_provision'],
    [/DOCUMENTO DE PROVISION/, 'documento_provision'],
    [/PLANIMETRIA/, 'planimetria'],
];

export function documentKind(tipo: string): DocumentKind {
    const folded = fold(tipo);
    for (const [pattern, kind] of DOCUMENT_KINDS) if (pattern.test(folded)) return kind;
    return 'otros';
}

function collapse(text: string): string {
    // Some buyers paste rich text with zero-width spaces / NBSPs into the page.
    return text
        .replace(/​|‌|‍|﻿/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Look a label up tolerant of accents/case ("Fecha de Publicación" == "FECHA DE PUBLICACION"). */
function field(fields: Record<string, string>, label: string): string | null {
    const wanted = fold(label);
    for (const [key, value] of Object.entries(fields)) if (fold(key) === wanted) return blankToNull(value);
    return null;
}

export function estadoCodeFromLabel(label: string | null): EstadoCode | null {
    if (!label) return null;
    const folded = fold(label);
    if (folded.startsWith('PARA APERTURA')) return 'AP';
    if (folded.startsWith('EN TRAMITE')) return 'ET';
    if (folded.startsWith('CONCLUIDA')) return 'CO';
    return null;
}

/** "EN TRÁMITE  - Análisis de ofertas - Control de documentación" -> the part after the first " - ". */
function estadoStageOf(label: string | null): string | null {
    if (!label) return null;
    const idx = label.indexOf(' - ');
    return idx === -1 ? null : blankToNull(label.slice(idx + 3));
}

/** "04-09-2026 09:30 Hs. -  (*** NUEVA FECHA ***)" -> { when: "04-09-2026 09:30 Hs.", note: "(*** NUEVA FECHA ***)" } */
function splitDateAndNote(value: string | null): { when: string | null; note: string | null } {
    if (!value) return { when: null, note: null };
    const idx = value.indexOf(' - ');
    if (idx === -1) {
        const trimmed = value.replace(/\s*-\s*$/, '');
        return { when: blankToNull(trimmed), note: null };
    }
    return { when: blankToNull(value.slice(0, idx)), note: blankToNull(value.slice(idx + 3)) };
}

/** "LICITACIÓN PÚBLICA Nº 18/2026" -> parts. */
function parseTitle(title: string | null): { tipo: string | null; numero: string | null; anio: string | null } {
    if (!title) return { tipo: null, numero: null, anio: null };
    const match = title.match(/^(.*?)\s+N[º°o.]*\s*(\S+?)\/(\d{4})\s*$/i);
    if (!match) return { tipo: title, numero: null, anio: null };
    return { tipo: collapse(match[1] ?? '') || null, numero: match[2] ?? null, anio: match[3] ?? null };
}

/** "MICROBIOLOGIA HNZN - " -> "MICROBIOLOGIA HNZN"; "ANEXO ... - 31-08-2026" is kept whole. */
export function splitTrailingDash(value: string | null): string | null {
    if (!value) return null;
    // Linear scan instead of /(\s*-\s*)+$/, which backtracks exponentially on a long run of "- " pairs.
    let end = value.length;
    while (end > 0 && (value[end - 1] === '-' || /\s/u.test(value[end - 1] ?? ''))) end -= 1;
    return blankToNull(value.slice(end).includes('-') ? value.slice(0, end) : value);
}

/**
 * The detail page is a flat sequence of `<div class="col-12 mb-4">` blocks (live-verified legacy
 * 2026-09-08 on AP/ET/CO pages, and again 2026-10-21 on idGestion 139530): most are
 * `<b>Label:</b><span>Value</span>`; Rubros / Subrubros, Organismo comitente and Expedientes use one
 * or more `<div>` for multiple values (Expedientes wraps the code in a link to the expedientes-web
 * tracker); the Documentos block is `<h4>Documentos</h4>` + `<h5>Tipo</h5>` headers each followed by
 * `<div><a href title>Nombre</a></div>` links; a few buyers append free-form blocks with a malformed
 * `<b>IMPORTANTE<b>` label - those become `notes`. A nonexistent/unpublished id renders HTTP 200 with
 * the sentence "La gestión no existe o no está publicada aún" and no blocks at all.
 */
export function parseDetailPage($: CheerioAPI): ParsedDetail {
    const fields: Record<string, string> = {};
    let rubrosRaw: string[] = [];
    const documentos: GestionDocument[] = [];
    const documents: DocumentRecord[] = [];
    const expedientes: ExpedienteRecord[] = [];
    const organismoComitente: string[] = [];
    const notes: string[] = [];

    const content = $('.content').first();
    const contentText = collapse(content.text());
    const title = blankToNull(content.find('h3').first().text());
    const marker =
        content.find('h4').filter((_i, el) => fold($(el).text()).includes('DATOS DE LA GESTION')).length > 0 || title !== null;
    const exists = marker && !fold(contentText).includes('NO EXISTE O NO EST');

    $('div.col-12.mb-4').each((_i, el) => {
        const $block = $(el);

        if ($block.children('h4').filter((_j, h4) => fold($(h4).text()) === 'DOCUMENTOS').length > 0) {
            let currentTipo = '';
            $block.children().each((_k, child) => {
                const $child = $(child);
                if (child.tagName === 'h5') {
                    currentTipo = collapse($child.text());
                    return;
                }
                if (child.tagName === 'div') {
                    const $a = $child.find('a').first();
                    if ($a.length === 0) return;
                    const href = $a.attr('href');
                    if (!href) return;
                    const nombre = collapse($a.attr('title') ?? $a.text());
                    const url = absoluteDocumentUrl(href);
                    documentos.push({ tipo: currentTipo, nombre, url });
                    let id: string | null = null;
                    try {
                        id = new URL(url).searchParams.get('id');
                    } catch {
                        id = null;
                    }
                    documents.push({ kind: documentKind(currentTipo), tipo: currentTipo, nombre, url, id });
                }
            });
            return;
        }

        const $label = $block.children('b').first();
        if ($label.length === 0) return;
        // Free-form blocks: `<b> IMPORTANTE <b> <span>...` (nested/unclosed <b>) or a label without a colon.
        const rawLabel = collapse($label.clone().children().remove().end().text());
        if ($label.find('b, span, div').length > 0 || !rawLabel.endsWith(':')) {
            const note = collapse($block.text());
            if (note) notes.push(note);
            return;
        }
        const label = rawLabel.replace(/:$/, '').trim();
        if (!label) return;

        const $span = $block.children('span').first();
        if ($span.length > 0) {
            fields[label] = collapse($span.text());
            return;
        }

        const $divs = $block.children('div');
        const values = $divs
            .map((_j, div) => collapse($(div).text()))
            .get()
            .filter(Boolean);
        if (values.length === 0) return;
        fields[label] = values.join('; ');

        const foldedLabel = fold(label);
        if (foldedLabel.startsWith('RUBROS')) rubrosRaw = values;
        else if (foldedLabel.startsWith('ORGANISMO COMITENTE')) organismoComitente.push(...values);
        else if (foldedLabel.startsWith('EXPEDIENTE')) {
            $divs.each((_j, div) => {
                const $div = $(div);
                const text = collapse($div.text());
                if (!text) return;
                const $a = $div.find('a').first();
                const colon = text.indexOf(':');
                const labelPart = colon === -1 ? 'EXPEDIENTE' : collapse(text.slice(0, colon));
                const code = $a.length > 0 ? collapse($a.text()) : collapse(colon === -1 ? text : text.slice(colon + 1));
                if (!code) return;
                expedientes.push({ label: labelPart, code, url: $a.attr('href') ?? null });
            });
        }
    });

    const estadoLabel = field(fields, 'Estado');
    const opening = splitDateAndNote(field(fields, 'Fecha y hora de apertura de ofertas'));
    const titleParts = parseTitle(title);

    return {
        exists,
        title,
        tipoGestionName: titleParts.tipo,
        numeroGestion: titleParts.numero,
        anioGestion: titleParts.anio,
        legacy: { fields, rubros: rubrosRaw, documentos },
        estadoLabel,
        estadoStage: estadoStageOf(estadoLabel),
        estadoCode: estadoCodeFromLabel(estadoLabel),
        publishedAtLocal: field(fields, 'Fecha de Publicación'),
        modalidad: field(fields, 'Modalidad'),
        alcance: field(fields, 'Alcance'),
        objeto: field(fields, 'Objeto de la gestión'),
        descripcion: field(fields, 'Descripción'),
        rubros: rubrosRaw.map((raw) => {
            const idx = raw.indexOf(' / ');
            return idx === -1
                ? { rubro: raw, subrubro: null, raw }
                : { rubro: raw.slice(0, idx).trim() || null, subrubro: raw.slice(idx + 3).trim() || null, raw };
        }),
        organismoComitente,
        organismoLicitante: field(fields, 'Organismo licitante'),
        submissionPlace: field(fields, 'Lugar de presentación de ofertas'),
        submissionDeadlineLocal: field(fields, 'Fecha y hora límite de presentación de ofertas'),
        openingPlace: field(fields, 'Lugar de apertura de ofertas'),
        openingAtLocal: opening.when,
        openingNote: opening.note,
        deliveryPlaceAndDate: splitTrailingDash(field(fields, 'Lugar y fecha de entrega')),
        contactInfo: field(fields, 'Contacto para información'),
        valorPliego: field(fields, 'Valor del pliego'),
        montoOriginalText: field(fields, 'Monto Original'),
        expedientes,
        notes,
        documents,
    };
}

// ---------------------------------------------------------------------------
// Lookups (legacy lookups.ts): translate a human name into the id the listing API filters on.
// ---------------------------------------------------------------------------

export interface LookupEntry {
    id: string;
    name: string;
}

/** An option the operator supplied cannot be applied (unknown / ambiguous name). Never an upstream failure. */
export class OptionResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OptionResolutionError';
    }
}

/**
 * Resolve an input value to an id: a numeric string is taken as the id itself; anything else is
 * matched against the list by name, accent- and case-insensitively - an exact match wins, otherwise a
 * unique substring match; ambiguity or no match is an error that lists the options.
 */
export function resolveByName(field: string, value: string, entries: readonly LookupEntry[]): LookupEntry {
    const needle = fold(value);
    if (/^\d+$/.test(needle)) {
        const known = entries.find((e) => e.id === needle);
        return { id: needle, name: known?.name ?? needle };
    }
    const exact = entries.filter((e) => fold(e.name) === needle);
    if (exact.length === 1 && exact[0]) return exact[0];
    const partial = entries.filter((e) => fold(e.name).includes(needle));
    if (partial.length === 1 && partial[0]) return partial[0];
    if (partial.length === 0) {
        throw new OptionResolutionError(`${field} "${value}" matches none of the ${entries.length} names the site lists`);
    }
    const options = partial
        .slice(0, 8)
        .map((e) => `${e.name} (${e.id})`)
        .join('; ');
    throw new OptionResolutionError(`${field} "${value}" is ambiguous - ${partial.length} names match. Use the id or a longer name: ${options}`);
}

interface ComboResponse {
    success?: unknown;
    data?: unknown;
}

async function fetchCombo(ctx: ConnectorContext, path: string, idKey: string, nameKey: string, what: string): Promise<LookupEntry[]> {
    const body = await ctx.http.getText(`${BASE_URL}${path}`, { headers: { accept: 'application/json' } });
    let raw: ComboResponse;
    try {
        raw = JSON.parse(body) as ComboResponse;
    } catch {
        throw new Error(`The ${what} list endpoint did not return JSON (site changed or under maintenance): ${path}`);
    }
    if (raw.success !== true || !Array.isArray(raw.data)) {
        throw new Error(`The ${what} list endpoint returned an unexpected shape: ${path}`);
    }
    const entries: LookupEntry[] = [];
    for (const row of raw.data as Array<Record<string, unknown> | null>) {
        const id = row?.[idKey];
        const name = row?.[nameKey];
        if (typeof id === 'string' && typeof name === 'string') entries.push({ id, name: name.trim() });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Options (legacy input.ts, filter part)
// ---------------------------------------------------------------------------

const SORTS = ['newest', 'openingSoonest', 'openingLatest', 'mostViewed'] as const;

function emptyToUndefined(value: unknown): unknown {
    return typeof value === 'string' && value.trim() === '' ? undefined : value === null ? undefined : value;
}

const optionalText = z.preprocess(emptyToUndefined, z.string().trim().optional());

/**
 * Accepts the Apify datepicker's absolute ("2026-07-01") and relative forms, plus "today" / "now". A
 * relative window counts BACK from today's calendar date in Santa Fe by default ("7 days", "2
 * weeks", "3 months", "1 year"); prefix it with "+" or "in " to count FORWARD ("+30 days" = thirty
 * days from today), which is how "opening in the next month" is expressed for `openingTo`. Returns
 * YYYY-MM-DD. Throws a plain Error on an invalid value.
 */
export function resolveDate(value: string, now: Date, field: string): string {
    const v = value.trim();
    if (/^(today|now)$/i.test(v)) return siteCalendarDate(now);
    const absolute = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (absolute) {
        const m = Number(absolute[2]);
        const d = Number(absolute[3]);
        if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`${field} "${v}" is not a valid date`);
        return v;
    }
    const relative = v.match(/^(?:(\+|-|in\s+)\s*)?(\d+)\s*(day|week|month|year)s?(?:\s+ago)?$/i);
    if (!relative) {
        throw new Error(`${field} must be YYYY-MM-DD, "today", or a relative window like "7 days" (back) or "+30 days" (forward) - got "${v}"`);
    }
    const sign = relative[1] && relative[1].trim() !== '-' ? 1 : -1;
    const amount = Number(relative[2]) * sign;
    const unit = (relative[3] ?? '').toLowerCase();
    const [y = 0, m = 1, d = 1] = siteCalendarDate(now).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (unit === 'day') date.setUTCDate(date.getUTCDate() + amount);
    else if (unit === 'week') date.setUTCDate(date.getUTCDate() + amount * 7);
    else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
    else date.setUTCFullYear(date.getUTCFullYear() + amount);
    return date.toISOString().slice(0, 10);
}

const REFERENCE_DATE = new Date('2026-01-01T12:00:00Z');

function dateOption(field: string) {
    return optionalText.superRefine((value, issueCtx) => {
        if (typeof value !== 'string') return;
        try {
            resolveDate(value, REFERENCE_DATE, field);
        } catch (error) {
            issueCtx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage(error) });
        }
    });
}

export const arSantaFeOptionsSchema = z
    .object({
        /** Which registers to read: AP = PARA APERTURA (open for bids), ET = EN TRÁMITE, CO = CONCLUIDA. */
        estados: z.array(z.enum(['AP', 'ET', 'CO'])).min(1).default(['AP']),
        anio: z.preprocess(emptyToUndefined, z.coerce.number().int().min(2000).max(2100).optional()),
        /** Server-side phrase filter on the process object. Read through sanitizeKeywordList (min 2 chars, no blank/punctuation-only). */
        objeto: optionalText,
        /** One-letter codes from TIPO_GESTION (L, P, T, ...). One server query per code. */
        tipoGestion: z
            .array(z.string())
            .default([])
            .transform((codes, issueCtx) => {
                const out: string[] = [];
                for (const raw of codes) {
                    const code = raw.trim().toUpperCase();
                    if (code === '') continue;
                    if (!TIPO_GESTION[code]) {
                        issueCtx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: `unknown tipoGestion code "${raw}" - valid codes: ${Object.entries(TIPO_GESTION)
                                .map(([k, v]) => `${k} (${v})`)
                                .join(', ')}`,
                        });
                        return z.NEVER;
                    }
                    if (!out.includes(code)) out.push(code);
                }
                return out.sort();
            }),
        tipoModalidad: optionalText.refine((v) => v === undefined || (typeof v === 'string' && TIPO_MODALIDAD[v] !== undefined), {
            message: `tipoModalidad must be one of ${Object.entries(TIPO_MODALIDAD)
                .map(([k, v]) => `${k} (${v})`)
                .join(', ')}`,
        }),
        /** Buyer (organismo licitante): an idOrganismoLey12510 or a name (resolved through the site's own combo list). */
        comprador: optionalText,
        /** Requesting body (organismo comitente): id or name. */
        solicitante: optionalText,
        /** Rubro: idEspecie or name. */
        rubro: optionalText,
        /** Sub-rubro: idFamilia or name; needs `rubro`. */
        subrubro: optionalText,
        nroGestion: optionalText,
        nroExpediente: optionalText,
        sortBy: z.enum(SORTS).default('newest'),
        /** Client-side opening-date window (Santa Fe calendar, both inclusive): YYYY-MM-DD, "today" or "7 days" / "+30 days". */
        openingFrom: dateOption('openingFrom'),
        openingTo: dateOption('openingTo'),
        /** Fetch one detail page per record (rubros, documents, deadlines, contact, amendment fingerprint). */
        fetchDetail: z.boolean().default(true),
        maxConcurrency: z.number().int().min(1).max(10).default(5),
    })
    .strict()
    .superRefine((options, issueCtx) => {
        if (options.subrubro !== undefined && options.rubro === undefined) {
            issueCtx.addIssue({ code: z.ZodIssueCode.custom, path: ['subrubro'], message: 'subrubro needs a rubro (the site filters sub-rubros within one rubro)' });
        }
    });
export type ArSantaFeOptions = z.infer<typeof arSantaFeOptionsSchema>;

// ---------------------------------------------------------------------------
// Walk (legacy fetchGestiones.ts walkListing, without the delta logic)
// ---------------------------------------------------------------------------

// The API honours `limit` up to at least 5,000 (legacy live 2026-09-08: 2,000 rows in ~3 s, 5,000 in
// ~5 s). 2,000 keeps the whole open register (AP ~80-100, ET ~2,200-2,400) within one or two requests.
export const PAGE_SIZE = 2000;
const PAGE_CAP = 200; // 400,000 rows - a runaway guard, never reached in practice
const NOT_A_LISTING_RETRIES = 2;

export interface Candidate {
    item: ListingItem;
    estado: EstadoCode;
    openingAt: string | null;
}

async function loadListingPage(ctx: ConnectorContext, query: ListingQuery, start: number, limit: number): Promise<ListingPage> {
    const path = listingPath(query, start, limit);
    for (let attempt = 0; ; attempt += 1) {
        let body: string;
        try {
            body = await ctx.http.getText(`${BASE_URL}${path}`, {
                timeoutMs: 60_000,
                headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
            });
        } catch (error) {
            throw new SourceFetchError(`santafe.gov.ar listing request failed for estado=${query.estado} start=${start}: ${errorMessage(error)}`, SANTAFE_SOURCE_ID);
        }
        const parsed = parseListingResponse(body);
        if (parsed.isListingPage) return parsed;
        if (attempt >= NOT_A_LISTING_RETRIES) {
            throw new SourceFetchError(
                `santafe.gov.ar returned something that is not a Gestiones de Compra listing for estado=${query.estado} start=${start}${parsed.reason ? ` (site says: "${parsed.reason}")` : ''} - blocked, under maintenance, or the API changed. Aborting instead of reporting "nothing new". URL: ${path}`,
                SANTAFE_SOURCE_ID,
            );
        }
        ctx.log.warning(`[${SANTAFE_SOURCE_ID}] estado=${query.estado} start=${start} did not look like a listing response - retrying (${attempt + 1}/${NOT_A_LISTING_RETRIES}).`);
    }
}

export interface WalkParams {
    queries: ListingQuery[];
    maxItems: number;
    openingFrom: string | null;
    openingTo: string | null;
}

/** Walk every query (one per estado x tipoGestion) and collect up to `maxItems` rows that pass the opening window. */
export async function walkListing(ctx: ConnectorContext, params: WalkParams): Promise<Candidate[]> {
    const { queries, maxItems, openingFrom, openingTo } = params;
    const candidates: Candidate[] = [];
    const walkedIds = new Set<string>();
    const windowSet = openingFrom !== null || openingTo !== null;
    let pagesWalked = 0;

    for (const query of queries) {
        const { estado } = query;
        let start = 0;
        for (;;) {
            if (candidates.length >= maxItems) return candidates;
            // Only as many rows as are still needed (the API accepts any limit up to PAGE_SIZE and beyond).
            const limit = Math.min(PAGE_SIZE, Math.max(50, maxItems - candidates.length));
            const listing = await loadListingPage(ctx, query, start, limit);
            pagesWalked += 1;
            if (listing.items.length === 0) {
                ctx.log.info(`[${SANTAFE_SOURCE_ID}] estado=${estado}${query.tipoGestion ? ` tipo=${query.tipoGestion}` : ''} start=${start}: no rows - end of list.`);
                break;
            }
            for (const item of listing.items) {
                if (walkedIds.has(item.idGestion)) continue; // duplicate across pages/queries
                walkedIds.add(item.idGestion);
                const openingAt = parseSiteDateTime(item.fechaHoraAperturaFija);
                const openingDate = isoToSiteDate(openingAt);
                const outsideWindow =
                    windowSet &&
                    (openingDate === null || (openingFrom !== null && openingDate < openingFrom) || (openingTo !== null && openingDate > openingTo));
                if (outsideWindow) continue;
                if (candidates.length >= maxItems) return candidates;
                candidates.push({ item, estado, openingAt });
            }
            const totalNote = listing.totalRecords !== null ? ` of ${listing.totalRecords}` : '';
            ctx.log.info(`[${SANTAFE_SOURCE_ID}] estado=${estado} start=${start}: ${listing.items.length} rows${totalNote}, ${candidates.length} kept so far.`);
            start += listing.items.length;
            if (listing.totalRecords !== null && start >= listing.totalRecords) break;
            if (pagesWalked >= PAGE_CAP) {
                ctx.log.warning(`[${SANTAFE_SOURCE_ID}] page cap (${PAGE_CAP}) reached - stopping the walk.`);
                return candidates;
            }
        }
    }
    return candidates;
}

// ---------------------------------------------------------------------------
// Detail fetch (legacy fetchDetailFor / mapWithConcurrency)
// ---------------------------------------------------------------------------

export type DetailResult = { status: 'ok'; detail: ParsedDetail } | { status: 'unpublished' } | { status: 'error'; message: string };

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight, preserving input order in the
 * result. Errors propagate after in-flight calls settle.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    let firstError: unknown = null;
    let failed = false;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length && !failed) {
            const index = next;
            next += 1;
            try {
                results[index] = await fn(items[index] as T, index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    });
    await Promise.all(workers);
    if (failed) throw firstError;
    return results;
}

/**
 * Fetch and parse one detail page. A nonexistent / not-yet-published id (HTTP 200 with "La gestión
 * no existe o no está publicada aún", or a 404/410) is 'unpublished'; a network/5xx failure after
 * the shared client's retries is 'error' - the record is then left out of this run so the next run
 * retries it.
 */
export async function fetchDetailFor(ctx: ConnectorContext, idGestion: string): Promise<DetailResult> {
    try {
        let html: string;
        try {
            html = await ctx.http.getText(detailUrl(idGestion), { timeoutMs: 30_000 });
        } catch (error) {
            if (error instanceof HttpStatusError && (error.status === 404 || error.status === 410)) return { status: 'unpublished' };
            throw error;
        }
        const detail = parseDetailPage(cheerio.load(html));
        if (!detail.exists) return { status: 'unpublished' };
        return { status: 'ok', detail };
    } catch (error) {
        const message = errorMessage(error);
        ctx.log.warning(`[${SANTAFE_SOURCE_ID}] detail fetch failed for idGestion=${idGestion}: ${message}`);
        return { status: 'error', message };
    }
}

/** The part of a detail page that, when it changes, means the process was amended (legacy `contentHash`). */
export function detailFingerprint(detail: ParsedDetail): string {
    return contentFingerprint({
        estado: detail.estadoLabel,
        published: detail.publishedAtLocal,
        deadline: detail.submissionDeadlineLocal,
        opening: detail.openingAtLocal,
        openingNote: detail.openingNote,
        openingPlace: detail.openingPlace,
        submissionPlace: detail.submissionPlace,
        delivery: detail.deliveryPlaceAndDate,
        monto: detail.montoOriginalText,
        valorPliego: detail.valorPliego,
        objeto: detail.objeto,
        descripcion: detail.descripcion,
        modalidad: detail.modalidad,
        alcance: detail.alcance,
        rubros: detail.rubros.map((r) => r.raw),
        comitente: detail.organismoComitente,
        licitante: detail.organismoLicitante,
        contacto: detail.contactInfo,
        expedientes: detail.expedientes.map((e) => e.code),
        notes: detail.notes,
        documents: detail.documents.map((d) => `${d.kind}|${d.id ?? ''}|${d.nombre}`),
    });
}

function tipoGestionCode(name: string | null): string | null {
    if (!name) return null;
    const folded = fold(name);
    for (const [code, label] of Object.entries(TIPO_GESTION)) if (fold(label) === folded) return code;
    return null;
}

// ---------------------------------------------------------------------------
// Normalised record (legacy buildRecord, minus the router-owned envelope)
// ---------------------------------------------------------------------------

/**
 * Builds the dataset row using the legacy `GestionRecord` field names. Omitted on purpose (the router
 * owns them): `record_id`, `event_type`, `scraped_at`, `is_new`, and the state-dependent
 * `previousEstado`.
 */
export function buildPayload(candidate: Candidate, detailResult: DetailResult | null, now: Date): Record<string, unknown> {
    const { item, estado } = candidate;
    const idGestion = item.idGestion;
    const detail = detailResult?.status === 'ok' ? detailResult.detail : null;
    const todayIso = siteCalendarDate(now);

    const tipoGestion = item.tipoGestion ?? detail?.tipoGestionName ?? null;
    const numeroGestion = item.numeroGestion ?? detail?.numeroGestion ?? null;
    const anioGestion = item.anioGestion ?? detail?.anioGestion ?? null;
    const openingAt = candidate.openingAt ?? parseSiteDetailDateTime(detail?.openingAtLocal);
    const openingDate = isoToSiteDate(openingAt);
    const numeroExpediente = item.numeroExpediente || detail?.expedientes[0]?.code || null;
    const electronic = isElectronicExpediente(numeroExpediente);
    const valorPliegoText = item.valorPliego ?? detail?.valorPliego ?? null;
    const valorPliegoMoney = parseMoney(valorPliegoText);
    const monto = parseMoney(detail?.montoOriginalText);
    const publishedAt = parseSiteDetailDateTime(detail?.publishedAtLocal);
    const publishedDate = isoToSiteDate(publishedAt);
    const submissionDeadline = parseSiteDetailDateTime(detail?.submissionDeadlineLocal);
    const kinds = new Set((detail?.documents ?? []).map((d) => d.kind));
    const numeroAnio = item['numeroAño'] ?? (numeroGestion && anioGestion ? `${numeroGestion}-${anioGestion}` : null);

    let detailError: string | null = null;
    if (detailResult?.status === 'unpublished') detailError = 'UNPUBLISHED';
    else if (detailResult?.status === 'error') detailError = detailResult.message;

    return {
        // ---- Fields that existed in the legacy v1 output (names unchanged) ----
        idGestion,
        estado,
        tipoGestion,
        numeroGestion,
        anioGestion,
        fechaHoraApertura: item.fechaHoraApertura ?? null,
        objeto: item.objeto ?? detail?.objeto ?? null,
        comprador: item.comprador ?? detail?.organismoLicitante ?? null,
        valorPliego: valorPliegoText,
        numeroExpediente: item.numeroExpediente ?? numeroExpediente,
        detail: detail?.legacy ?? null,

        source_url: detailUrl(idGestion),
        data_source: DATA_SOURCE_ATTRIBUTION,

        // ---- Identity & listing twins ----
        idGestionNumber: Number(idGestion),
        numeroAnio,
        tipoGestionCode: tipoGestionCode(tipoGestion),
        tipoModalidad: item.tipoModalidad ?? detail?.modalidad ?? null,
        idOrganismoGestion: item.idOrganismoGestion ?? null,
        objetoCompleto: item.objetoCompleto ?? null,
        destinos: item.destinos ?? null,
        fechaHoraAperturaFija: item.fechaHoraAperturaFija ?? null,
        openingAt,
        openingDate,
        daysUntilOpening: daysBetween(todayIso, openingDate),
        isOpeningInFuture: openingAt === null ? null : openingAt > now.toISOString(),
        valorPliegoAmount: valorPliegoMoney?.amount ?? null,
        valorPliegoCurrency: valorPliegoMoney?.currency ?? null,
        valorPliegoIsFree: valorPliegoIsFree(valorPliegoText),
        isElectronic: electronic,
        bidUrl: electronic && numeroExpediente ? bidUrl(numeroExpediente) : null,
        printPdfUrl: printPdfUrl(idGestion),
        documentsUrl: documentsUrl(idGestion),

        // ---- Detail page (null / [] / false when fetchDetail=false or the page was unavailable) ----
        detailFetched: detail !== null,
        detailError,
        estadoLabel: detail?.estadoLabel ?? null,
        estadoStage: detail?.estadoStage ?? null,
        estadoFromDetail: detail?.estadoCode ?? null,
        publishedAtLocal: detail?.publishedAtLocal ?? null,
        publishedAt,
        publishedDate,
        daysSincePublished: daysBetween(publishedDate, todayIso),
        modalidad: detail?.modalidad ?? null,
        alcance: detail?.alcance ?? null,
        descripcion: detail?.descripcion ?? null,
        rubros: detail?.rubros ?? [],
        rubroNames: [...new Set((detail?.rubros ?? []).map((r) => r.rubro).filter((r): r is string => r !== null))],
        subrubroNames: [...new Set((detail?.rubros ?? []).map((r) => r.subrubro).filter((r): r is string => r !== null))],
        organismoComitente: detail?.organismoComitente ?? [],
        organismoLicitante: detail?.organismoLicitante ?? null,
        submissionPlace: detail?.submissionPlace ?? null,
        submissionDeadlineLocal: detail?.submissionDeadlineLocal ?? null,
        submissionDeadline,
        daysUntilDeadline: daysBetween(todayIso, isoToSiteDate(submissionDeadline)),
        openingPlace: detail?.openingPlace ?? null,
        openingAtDetailLocal: detail?.openingAtLocal ?? null,
        openingNote: detail?.openingNote ?? null,
        deliveryPlaceAndDate: detail?.deliveryPlaceAndDate ?? null,
        contactInfo: detail?.contactInfo ?? null,
        contactEmails: extractEmails(`${detail?.contactInfo ?? ''} ${detail?.submissionPlace ?? ''}`),
        contactPhones: extractPhones(detail?.contactInfo),
        valorPliegoDetail: detail?.valorPliego ?? null,
        montoOriginalText: detail?.montoOriginalText ?? null,
        montoOriginalAmount: monto?.amount ?? null,
        montoOriginalCurrency: monto?.currency ?? null,
        expedientes: detail?.expedientes ?? [],
        expediente: detail?.expedientes[0]?.code ?? null,
        expedienteUrl: detail?.expedientes[0]?.url ?? null,
        notes: detail?.notes ?? [],
        documents: detail?.documents ?? [],
        documentCount: detail?.documents.length ?? 0,
        documentKinds: [...kinds],
        hasPliego: kinds.has('pliego'),
        hasCircular: kinds.has('circular'),
        hasActaApertura: kinds.has('acta_apertura'),
        hasPreadjudicacion: kinds.has('preadjudicacion'),
        hasAdjudicacion: kinds.has('adjudicacion'),
        hasOrdenProvision: kinds.has('orden_provision'),
        hasCuadroComparativo: kinds.has('cuadro_comparativo'),
        contentHash: detail ? detailFingerprint(detail) : null,
    };
}

/** Turns one candidate (+ its detail result) into the router's SourceRecord. */
/** PPE event for a listing-only (no detail page) record; priced in pricing/event_catalog.ts. */
export const TENDER_SUMMARY_EVENT = 'tender-summary';

export function toSourceRecord(candidate: Candidate, detailResult: DetailResult | null, now: Date): SourceRecord {
    const payload = buildPayload(candidate, detailResult, now);
    const { item } = candidate;
    const detail = detailResult?.status === 'ok' ? detailResult.detail : null;
    return {
        recordId: item.idGestion,
        // Every consumer-visible, non-time-relative field. `estado` is in on purpose (AP -> ET -> CO is a change).
        fingerprint: fingerprintOf([
            candidate.estado,
            item.tipoGestion,
            item.numeroGestion,
            item.anioGestion,
            item.fechaHoraAperturaFija,
            item.valorPliego,
            item.objeto,
            item.objetoCompleto,
            item.comprador,
            item.tipoModalidad,
            item.numeroExpediente,
            item.destinos,
            payload.contentHash,
        ]),
        payload,
        watchText: [item.comprador ?? detail?.organismoLicitante ?? '', item.objeto ?? detail?.objeto ?? ''].filter((p) => p.trim() !== '').join(' '),
        // Legacy pricing: `result` for a record built from the full detail page, `result-summary` for a listing-only one.
        billingEvent: payload.detailFetched === true ? undefined : TENDER_SUMMARY_EVENT,
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/** Reads a search-phrase option through the keyword guard: blank / 1-char / punctuation-only means "no phrase filter requested". */
function searchPhrase(ctx: ConnectorContext, field: string, value: string | undefined): string | null {
    if (value === undefined) return null;
    const list = sanitizeKeywordList([value]);
    if (list.rejected.length > 0) ctx.log.warning(`[${SANTAFE_SOURCE_ID}] ${describeSanitization(list, field)} The filter was not applied.`);
    return list.keywords[0] ?? null;
}

async function resolveFilters(ctx: ConnectorContext, options: ArSantaFeOptions): Promise<ListingFilters> {
    const lookups = new Map<string, Promise<LookupEntry[]>>();
    const cached = (key: string, load: () => Promise<LookupEntry[]>): Promise<LookupEntry[]> => {
        let p = lookups.get(key);
        if (!p) {
            p = load();
            lookups.set(key, p);
        }
        return p;
    };
    const resolveOrganismo = async (field: string, value: string | undefined): Promise<string | null> => {
        if (value === undefined) return null;
        if (/^\d+$/.test(value.trim())) return value.trim();
        const entries = await cached('organismos', () => fetchCombo(ctx, COMBO_PATHS.organismos, 'idOrganismoLey12510', 'nombre', 'organismo'));
        const resolved = resolveByName(field, value, entries);
        ctx.log.info(`[${SANTAFE_SOURCE_ID}] ${field} "${value}" resolved to organismo ${resolved.id} (${resolved.name}).`);
        return resolved.id;
    };

    const comprador = await resolveOrganismo('comprador', options.comprador);
    const solicitante = await resolveOrganismo('solicitante', options.solicitante);
    let idEspecie: string | null = null;
    let idFamilia: string | null = null;
    if (options.rubro !== undefined) {
        if (/^\d+$/.test(options.rubro.trim())) idEspecie = options.rubro.trim();
        else {
            const entries = await cached('rubros', () => fetchCombo(ctx, COMBO_PATHS.rubros, 'idEspecie', 'nombre', 'rubro'));
            idEspecie = resolveByName('rubro', options.rubro, entries).id;
        }
    }
    if (options.subrubro !== undefined && idEspecie !== null) {
        if (/^\d+$/.test(options.subrubro.trim())) idFamilia = options.subrubro.trim();
        else {
            const especie = idEspecie;
            const entries = await cached(`subrubros:${especie}`, () => fetchCombo(ctx, COMBO_PATHS.subrubros(especie), 'idFamilia', 'nombre', 'subrubro'));
            idFamilia = resolveByName('subrubro', options.subrubro, entries).id;
        }
    }

    return {
        anio: options.anio ?? null,
        objeto: searchPhrase(ctx, 'objeto', options.objeto),
        tipoGestion: options.tipoGestion,
        tipoModalidad: options.tipoModalidad ?? null,
        comprador,
        solicitante,
        idEspecie,
        idFamilia,
        nroGestion: options.nroGestion ?? null,
        nroExpediente: options.nroExpediente ?? null,
        sortBy: options.sortBy,
    };
}

export const arSantaFeConnector: Connector<ArSantaFeOptions> = {
    id: SANTAFE_SOURCE_ID,
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'santafe-compras-monitor',
    description:
        'Province of Santa Fe (Argentina) Gestiones de Compra: public tenders / purchasing processes from the register\'s own JSON listing (AP open for bids, ET in progress, CO concluded) plus the public detail page (rubros, documents, deadlines, contact). Open data (CC BY-SA 2.5 AR), no credentials, no proxy.',
    status: 'active',
    optionsSchema: arSantaFeOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ArSantaFeOptions, run: RunParams): Promise<SourceRecord[]> {
        let filters: ListingFilters;
        try {
            filters = await resolveFilters(ctx, options);
        } catch (error) {
            if (error instanceof OptionResolutionError) {
                throw new SourceFetchError(`Invalid sourceOptions for ${SANTAFE_SOURCE_ID}: ${error.message}`, SANTAFE_SOURCE_ID);
            }
            throw new SourceFetchError(`santafe.gov.ar lookup request failed: ${errorMessage(error)}`, SANTAFE_SOURCE_ID);
        }

        const now = ctx.now();
        const queries: ListingQuery[] = [];
        for (const estado of [...new Set(options.estados)]) {
            for (const tipo of filters.tipoGestion.length > 0 ? filters.tipoGestion : [null]) queries.push({ estado, tipoGestion: tipo, filters });
        }
        const openingFrom = options.openingFrom !== undefined ? resolveDate(options.openingFrom, now, 'openingFrom') : null;
        const openingTo = options.openingTo !== undefined ? resolveDate(options.openingTo, now, 'openingTo') : null;
        if (openingFrom !== null && openingTo !== null && openingFrom > openingTo) {
            throw new SourceFetchError(`Invalid sourceOptions for ${SANTAFE_SOURCE_ID}: openingFrom is after openingTo`, SANTAFE_SOURCE_ID);
        }

        const candidates = await walkListing(ctx, { queries, maxItems: run.maxItemsPerSource, openingFrom, openingTo });

        if (!options.fetchDetail) return candidates.map((c) => toSourceRecord(c, null, now));

        const details = await mapWithConcurrency(candidates, options.maxConcurrency, async (c) => fetchDetailFor(ctx, c.item.idGestion));
        const records: SourceRecord[] = [];
        let failed = 0;
        candidates.forEach((candidate, index) => {
            const detail = details[index] ?? null;
            if (detail?.status === 'error') {
                failed += 1;
                return;
            }
            records.push(toSourceRecord(candidate, detail, now));
        });
        if (failed > 0) {
            if (records.length === 0) {
                throw new SourceFetchError(`All ${failed} detail request(s) failed; refusing to return an empty result for a source that listed ${candidates.length} record(s).`, SANTAFE_SOURCE_ID);
            }
            ctx.log.warning(`[${SANTAFE_SOURCE_ID}] ${failed} record(s) left out because their detail request failed; they are retried next run.`);
        }
        return records;
    },
};
