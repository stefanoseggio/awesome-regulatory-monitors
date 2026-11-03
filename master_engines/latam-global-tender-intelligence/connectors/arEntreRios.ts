/**
 * arEntreRios.ts - Province of Entre Ríos (Argentina) Unidad Central de Contrataciones connector.
 *
 * Absorbs the legacy actor `entrerios-compras-monitor` (src/fetchTenders.ts, decode.ts, constants.ts,
 * parsers/table.ts, types.ts). Ported: the POST request, the Windows-1252 decoding, parsing,
 * normalisation (including the corrupted "En proceso de Evaluación" label), record id, fingerprint.
 * NOT ported (router concerns): state.ts, delta.ts (NEW_LISTING / STATUS_CHANGE / CLOSED), main.ts,
 * Actor.pushData / charging, and the legacy `dateRange` input: the source publishes NO per-record
 * date, so the legacy actor shipped it as a documented no-op that only logged a warning. Shipping a
 * filter that cannot filter is worse than rejecting it, so `dateRange` is not an option here (the
 * strict options schema rejects it in preflight).
 *
 * WHAT A RECORD IS
 * ----------------------------------------------------------------------------
 * One row of `#tabla-resultados` (procedimiento, objeto, destino, organismo, estado). One POST returns
 * the entire matching slice, server-rendered, no pagination (the unfiltered backlog was 5,505 rows on
 * 2026-09-04).
 *
 *   recordId     sha1 of `procedimiento|objeto|destino|organismo`, exactly the legacy `record_id`
 *                (40 hex chars), so ids stay joinable with datasets produced by the legacy actor. The
 *                site publishes no native id. KNOWN, ACCEPTED RISK (legacy AGENTS.md "Delta engine
 *                v2"): the id is a hash of FREE TEXT, so a silent upstream correction of any of those
 *                four fields yields a different id, which the router sees as a new `first_seen`
 *                record while the old id simply stops appearing. The legacy actor additionally
 *                reported a false CLOSED for the old id; the router has no CLOSED, so only the
 *                "looks new" half remains. The estado is deliberately NOT part of the id.
 *   fingerprint  fingerprintOf([id, estado]) - the four id fields ARE the identity, so `estado` is the
 *                only field that can change for a given id (the legacy STATUS_CHANGE).
 *   watchText    buyer (`organismo`) + object (`objeto`), space-joined.
 *   Duplicates   the source itself lists ~22 byte-identical row pairs (legacy, verified live); they
 *                collide on the id by design and the first one wins.
 *
 * ENCODING - why this connector FAILS CLOSED without raw bytes
 * ----------------------------------------------------------------------------
 * The response declares `Content-Type: text/html; charset=UTF-8` but its real bytes are Windows-1252
 * (legacy decode.ts; re-verified live 2026-10-21, see below). `ctx.http.getText` decodes UTF-8, which
 * replaces every accented byte with U+FFFD irreversibly - and because the record id hashes those very
 * fields, a lossy decode would also mint wrong ids. So the page is requested through the optional
 * `getRaw` capability (../support/portalHttp.ts) and decoded as windows-1252; when `ctx.http` does not
 * implement it the source throws SourceFetchError BEFORE making any request instead of emitting
 * corrupted text. (Matching lib change request: "HttpClient.getRaw".)
 *
 * Response sanity: a 200 response that is neither a results table nor the portal's own explicit
 * "No hay información con ese criterio" notice (a bot-check page, a dropped session, a markup change)
 * fails the source rather than reading as "0 tenders".
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md, 2026-09-04): plain PHP + PHPSESSID cookie, no ViewState; the search form
 * is `method="post" action=""`; a GET with the same names returns 200 and the empty state (the backend
 * never reads GET params) so the fields MUST be POSTed as application/x-www-form-urlencoded; blank
 * `estado` returns the union of all four statuses (5,505 rows = 2,042 + 2,840 + 623 + 0); the table has
 * 5 columns when `estado` is blank and 4 (no ESTADO column) when an estado is applied; no proxy needed;
 * `robots.txt` does not disallow /contrataciones/. Filter codes: estado 1 Próxima Apertura, 2 En proceso
 * de Evaluación, 3 Realizada, 4 Fracasada; tipoLicitacion 1 Privada, 2 Pública, 3 Solicitud de
 * Cotización, 4 Contratación Directa; organismo 1,3..9 (see the options schema).
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy):
 *   POST https://www.entrerios.gov.ar/contrataciones/licitaciones.php
 *        body: tipo_licitacion=&anio=&estado=4&palabra=&cmb_organismo=8&buscar=Buscar
 *     -> HTTP/2 200, `content-type: text/html; charset=UTF-8`, 12,000 bytes; `#tabla-resultados` with a
 *        4-column thead (PROCEDIMIENTO DE CONTRATACI&Oacute;N / OBJETO / DESTINO / ORGANISMO) and 2 rows
 *        ("Licitación Privada 18/2024" and "Licitación Privada 22/2024", Ministerio de Salud); the raw
 *        bytes contain 0xF3, 0xED, 0xFA, 0x93, 0x94 (Windows-1252) next to the corrupted-estado
 *        sequence EF BF BD inside the page's own JS string. Captured as the `entrerios.live-2026-10-21.*`
 *        fixture (byte-exact).
 *   End to end (through a scratch raw-capable client implementing the proposed `getRaw` over Node's fetch; the
 *   shipped lib/http.ts has none): an UNFILTERED POST returned 5,505 table rows = 5,483 unique record ids + exactly
 *   22 byte-identical duplicate pairs collapsed - the same 5,505 / 22 figures the legacy AGENTS.md reports for
 *   2026-09-04; `estado=3, organismo=8` returned the 17 rows of the legacy fixture. Through the shipped text-only
 *   lib/http.ts client the source fails closed with SourceFetchError, as designed.
 * ============================================================================
 */
import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';
import { z } from 'zod';

import { describeSanitization, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';
import { errorMessage, fetchDecoded } from '../support/portalHttp.js';

export const ENTRERIOS_SOURCE_ID = 'ar_entrerios';

/**
 * The search form's POST target. Also reused as `source_url` on every record: the site publishes NO
 * per-tender detail page or link anywhere in `#tabla-resultados` (zero `<a href>` inside the table -
 * verified live by the legacy actor), so there is no real deep link to give a consumer. This shared
 * listing URL is the closest honest answer; it is NOT a unique per-record URL.
 */
export const TARGET_URL = 'https://www.entrerios.gov.ar/contrataciones/licitaciones.php';

/** Raw filter values as accepted by the site's own POST form. */
export type EstadoCode = '' | '1' | '2' | '3' | '4';

export interface ParsedTenderRow {
    /** Stable id derived from the 4 content fields (the site has no native row id). Excludes `estado`. */
    record_id: string;
    /** Raw "Procedimiento de Contratación" cell, e.g. "Solicitud De Cotizacion 54/2025". */
    procedimiento: string;
    /** Trailing year extracted from `procedimiento` (last `/NNNN` segment), or null. */
    anioProcedimiento: string | null;
    objeto: string;
    destino: string;
    organismo: string;
    /** Normalised status label. */
    estado: string;
}

// ---------------------------------------------------------------------------
// Parser (legacy parsers/table.ts)
// ---------------------------------------------------------------------------

/**
 * The site's search form renders the results table in two different shapes depending on whether an
 * `estado` filter was applied (verified live by the legacy actor and again 2026-10-21):
 *   - `estado` blank (unfiltered): 5 columns - Procedimiento, Objeto, Destino, ESTADO, Organismo.
 *   - `estado` set to a specific code: 4 columns - Procedimiento, Objeto, Destino, Organismo.
 */
const FIVE_COLUMN_LAYOUT = 5;

/** Canonical status labels for the site's 4-value `estado` enum, keyed by the POST form's codes. */
const ESTADO_LABELS_BY_CODE: Record<Exclude<EstadoCode, ''>, string> = {
    '1': 'Próxima Apertura',
    '2': 'En proceso de Evaluación',
    '3': 'Realizada',
    '4': 'Fracasada',
};

/**
 * Normalizes a raw ESTADO cell. The site's database has a permanent encoding corruption for one of its
 * 4 status labels: EVERY row (2840/2840 in the legacy full pull) whose status is "En proceso de
 * Evaluación" stores the accented "o" as the Unicode replacement character re-encoded as raw UTF-8
 * bytes (EF BF BD) inside a Windows-1252 document; decoding those 3 bytes as Windows-1252 yields the
 * 3-character garbage "ï¿½". This is upstream data loss, not a decoding bug here. The known-corrupted
 * spelling is mapped back to the correct label (a closed 4-value enum verified exhaustively, not a
 * guess over free text). "Próxima Apertura" was NOT seen in real row data (0 rows in that status at
 * both capture dates), so its regex tolerates a clean or corrupted accented "o" defensively.
 */
export function normalizeEstadoText(raw: string): string {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (/^Realizada$/i.test(text)) return 'Realizada';
    if (/^Fracasada$/i.test(text)) return 'Fracasada';
    if (/^En proceso de Evaluaci.{1,3}n$/i.test(text)) return 'En proceso de Evaluación';
    if (/^Pr.{1,3}xima[s]? Apertura[s]?$/i.test(text)) return 'Próxima Apertura';
    return text;
}

/**
 * Extracts the trailing year from a `procedimiento` string, e.g. "Solicitud De Cotizacion 54/2025" ->
 * "2025". Legacy-verified against 5505 rows: 5504 end in `/<digits>`; the one exception
 * ("Solicitud De Cotizacion 303/0") is a real upstream data-entry error - whatever digits are there
 * are passed through rather than validated as a year.
 */
export function extractAnioProcedimiento(procedimiento: string): string | null {
    const match = procedimiento.match(/\/(\d{1,4})\s*$/);
    return match ? (match[1] ?? null) : null;
}

/** sha1 of the four free-text fields - byte-for-byte the legacy `stableId` (see the header for the accepted risk). */
export function stableId(procedimiento: string, objeto: string, destino: string, organismo: string): string {
    return createHash('sha1').update(`${procedimiento}|${objeto}|${destino}|${organismo}`).digest('hex');
}

/**
 * Parses the `#tabla-resultados` results table out of an already-decoded HTML string (never pass raw
 * bytes). `appliedEstadoFilter` is the `estado` the POST was made with; it fills in `estado` when the
 * response is in the 4-column shape.
 */
export function parseTenders(html: string, appliedEstadoFilter: EstadoCode): ParsedTenderRow[] {
    return parseRows(cheerio.load(html), appliedEstadoFilter);
}

function parseRows($: cheerio.CheerioAPI, appliedEstadoFilter: EstadoCode): ParsedTenderRow[] {
    const rows = $('#tabla-resultados tbody tr').toArray();
    const records: ParsedTenderRow[] = [];

    for (const row of rows) {
        const cellTexts = $(row)
            .find('td')
            .toArray()
            .map((td) => $(td).text().replace(/\s+/g, ' ').trim());

        if (cellTexts.length < 4) continue; // defensive: skip any malformed row rather than crash the run

        let procedimiento: string;
        let objeto: string;
        let destino: string;
        let organismo: string;
        let estadoRaw: string;

        if (cellTexts.length >= FIVE_COLUMN_LAYOUT) {
            [procedimiento = '', objeto = '', destino = '', estadoRaw = '', organismo = ''] = cellTexts;
        } else {
            [procedimiento = '', objeto = '', destino = '', organismo = ''] = cellTexts;
            estadoRaw = appliedEstadoFilter ? ESTADO_LABELS_BY_CODE[appliedEstadoFilter] : '';
        }

        records.push({
            record_id: stableId(procedimiento, objeto, destino, organismo),
            procedimiento,
            anioProcedimiento: extractAnioProcedimiento(procedimiento),
            objeto,
            destino,
            organismo,
            estado: normalizeEstadoText(estadoRaw),
        });
    }

    return records;
}

/** The portal's own explicit empty-state sentence (HTML-entity encoded in the source). */
const NO_RESULTS_NOTICE = /No hay informaci(?:&oacute;|ó|.{1,3})n con ese criterio/i;

/**
 * What a 200 response looks like: a results table (`table#tabla-resultados`), or the explicit "No hay
 * información con ese criterio" notice of a genuine empty result (real capture: no table at all in that
 * case). Anything else is a bot-check / dropped session / markup change and must not read as "0 tenders".
 */
export function classifyResponse(html: string): 'table' | 'no-results' | 'unrecognised' {
    return classifyDocument(cheerio.load(html), html);
}

function classifyDocument($: cheerio.CheerioAPI, html: string): 'table' | 'no-results' | 'unrecognised' {
    if ($('table#tabla-resultados').length > 0) return 'table';
    if (NO_RESULTS_NOTICE.test(html)) return 'no-results';
    return 'unrecognised';
}

/** Classifies and (for a results table) parses a response with a single DOM load - the unfiltered backlog is ~3 MB. */
export function parseResponse(html: string, appliedEstadoFilter: EstadoCode): { kind: 'table' | 'no-results' | 'unrecognised'; rows: ParsedTenderRow[] } {
    const $ = cheerio.load(html);
    const kind = classifyDocument($, html);
    return { kind, rows: kind === 'table' ? parseRows($, appliedEstadoFilter) : [] };
}

// ---------------------------------------------------------------------------
// Request (legacy fetchTenders.ts)
// ---------------------------------------------------------------------------

export const arEntreRiosOptionsSchema = z
    .object({
        /** '' = all four statuses in one request (default). 1 Próxima Apertura, 2 En proceso de Evaluación, 3 Realizada, 4 Fracasada. */
        estado: z.enum(['', '1', '2', '3', '4']).default(''),
        /** '' = all types. 1 Licitación Privada, 2 Licitación Pública, 3 Solicitud de Cotización, 4 Contratación Directa. */
        tipoLicitacion: z.enum(['', '1', '2', '3', '4']).default(''),
        /** '' = all organisms. 1 Unidad Central de Contrataciones, 3 Min. Desarrollo Social, 4 Consejo General de Educación, 5 ATER, 6 UADER, 7 Poder Judicial, 8 Min. Salud, 9 Vialidad. */
        organismo: z.enum(['', '1', '3', '4', '5', '6', '7', '8', '9']).default(''),
        /** Year, e.g. "2025"; '' = all years (the register goes back to at least 2004; the site's own filter also lists "0"). */
        anio: z
            .string()
            .trim()
            .regex(/^(\d{1,4})?$/, 'anio must be 1-4 digits or empty')
            .default(''),
        /** Free-text keyword (the site's "Palabra" box). Read through sanitizeKeywordList (min 2 chars, no blank/punctuation-only). */
        palabra: z.string().default(''),
    })
    .strict();
export type ArEntreRiosOptions = z.infer<typeof arEntreRiosOptionsSchema>;

/** Reads the free-text keyword through the keyword guard: blank / 1-char / punctuation-only means "no keyword filter requested". */
function keyword(ctx: ConnectorContext, value: string): string {
    if (value.trim() === '') return '';
    const list = sanitizeKeywordList([value]);
    if (list.rejected.length > 0) ctx.log.warning(`[${ENTRERIOS_SOURCE_ID}] ${describeSanitization(list, 'palabra')} The keyword filter was not applied.`);
    return list.keywords[0] ?? '';
}

/** The exact form body of the site's own search POST. */
export function buildFormBody(options: ArEntreRiosOptions, palabra: string): string {
    return new URLSearchParams({
        tipo_licitacion: options.tipoLicitacion,
        anio: options.anio,
        estado: options.estado,
        palabra,
        cmb_organismo: options.organismo,
        buscar: 'Buscar',
    }).toString();
}

export function toSourceRecord(row: ParsedTenderRow): SourceRecord {
    const { record_id: recordId, ...fields } = row;
    return {
        recordId,
        // The four id fields are the identity, so `estado` is the only field that can differ for one id.
        fingerprint: fingerprintOf([recordId, row.estado]),
        payload: { ...fields, source_url: TARGET_URL },
        watchText: [row.organismo, row.objeto].filter((p) => p.trim() !== '').join(' '),
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const arEntreRiosConnector: Connector<ArEntreRiosOptions> = {
    id: ENTRERIOS_SOURCE_ID,
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'entrerios-compras-monitor',
    description:
        'Province of Entre Ríos (Argentina) Unidad Central de Contrataciones: licitaciones, solicitudes de cotización and contrataciones directas (procedimiento, objeto, destino, organismo, estado) from one server-rendered POST. No credentials, no proxy. Needs an HttpClient with raw-byte access because the portal serves Windows-1252 bytes labelled UTF-8.',
    status: 'active',
    optionsSchema: arEntreRiosOptionsSchema,

    async fetch(ctx: ConnectorContext, options: ArEntreRiosOptions, run: RunParams): Promise<SourceRecord[]> {
        const palabra = keyword(ctx, options.palabra);
        const body = buildFormBody(options, palabra);
        ctx.log.info(`[${ENTRERIOS_SOURCE_ID}] POST ${TARGET_URL} (${body})`);

        let html: string;
        try {
            html = await fetchDecoded(ctx, TARGET_URL, {
                charset: 'windows-1252',
                onMissingRaw: 'fail',
                sourceId: ENTRERIOS_SOURCE_ID,
                init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 60_000 },
            });
        } catch (error) {
            if (error instanceof SourceFetchError) throw error;
            throw new SourceFetchError(`entrerios.gov.ar search request failed: ${errorMessage(error)}`, ENTRERIOS_SOURCE_ID);
        }

        const { kind, rows } = parseResponse(html, options.estado);
        if (kind === 'unrecognised') {
            throw new SourceFetchError(
                'entrerios.gov.ar returned a response that is neither a results table nor the portal\'s "No hay información con ese criterio" notice - blocked, session dropped or markup changed. Refusing to report "0 tenders".',
                ENTRERIOS_SOURCE_ID,
            );
        }

        const seen = new Set<string>();
        const unique = rows.filter((row) => (seen.has(row.record_id) ? false : (seen.add(row.record_id), true)));
        if (unique.length < rows.length) ctx.log.info(`[${ENTRERIOS_SOURCE_ID}] ${rows.length - unique.length} byte-identical duplicate row(s) listed by the source were collapsed.`);
        ctx.log.info(`[${ENTRERIOS_SOURCE_ID}] ${unique.length} licitaciones parsed for the applied filter.`);
        return unique.slice(0, run.maxItemsPerSource).map(toSourceRecord);
    },
};
