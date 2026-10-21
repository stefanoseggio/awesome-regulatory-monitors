/**
 * worldBankDebarred.ts - World Bank "Other Sanctions" connector.
 *
 * Absorbs the `worldBankDebarredFirms` sub-source of `actor-20-mdb-procurement-monitor`
 * (src/sources/worldBankDebarredFirms.ts + the debarment half of umsNormalizer.ts,
 * dateUtils.ts). The legacy actor's other sub-source (Procurement Notices) is a
 * tender feed, not a compliance-sanctions feed, and is not part of this connector.
 *
 * WHAT THIS CONNECTOR DOES AND DOES NOT COVER - read before relying on it
 * ----------------------------------------------------------------------------
 * The World Bank page renders TWO tables:
 *   Table 1 "Debarred & Cross-Debarred Firms and Individuals" - the main debarment
 *           register - is a Kendo UI grid whose rows come from an UNDOCUMENTED internal
 *           gateway (https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/
 *           ADOBE_EXPRNCE_MGR/FIRM/SANCTIONED_FIRM). It is absent from the plain-fetched
 *           HTML. The legacy actor's compliance doctrine - kept here - is that an
 *           undocumented internal API gateway is not a source, so Table 1 is NEVER
 *           queried. Do not "fix" this by pointing ctx.http at that gateway.
 *   Table 2 "Other Sanctions" (letters of reprimand, conditional non-debarment and similar)
 *           IS a plain static <table> in the fetched HTML and is this connector's entire
 *           scope.
 * Consequence: this connector does NOT list the World Bank's formally debarred firms.
 * A compliance team must not treat "no hit here" as "not debarred by the World Bank".
 *
 * DEFERRED, NOT PORTED (legacy src/sources/deferredSources.ts): ADB (Cloudflare
 * bot-detection on every path including robots.txt) and IDB (CKAN API is real but its
 * robots.txt disallows /api/, /datastore/dump/, /file/download/, /dataset/download/).
 * Neither is exposed by this connector.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy, 2026-09-07 / 2026-09-19): page renders Table 2 with real <b>
 * header text "Name of Firm & Address", "Date of Imposition of Sanction", "Sanction
 * Imposed", "Grounds". www.worldbank.org robots.txt: `User-agent: * / Allow: /` and
 * does not disallow the debarred-firms path. The firm-name cell holds the name (+ a
 * trailing "*<digits>" footnote marker) in its first <p>; address lines are later <p>
 * siblings and are deliberately excluded.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy):
 *   GET https://www.worldbank.org/en/projects-operations/procurement/debarred-firms
 *     -> HTTP/2 200 text/html;charset=utf-8, 100,539 bytes, exactly ONE static <table>
 *        (the "Other Sanctions" table, header row matching all four patterns below)
 *        with four data rows (OAO Armada *12, PT. Bumirejo *13, TPF GETINSA EUROESTUDIOS
 *        S.L. *59, IQVIA Consulting and Information Services India *69), i.e. unchanged
 *        in shape from the legacy fixture; the page still contains `kendoGrid` and the
 *        `apigwext.worldbank.org` gateway reference for Table 1.
 *   GET https://www.worldbank.org/robots.txt -> 200; no rule mentions procurement,
 *        projects-operations, debarred or sanction.
 *   End to end: the connector, driven through lib/http.ts createHttpClient (Node's global
 *   fetch, honest User-Agent) against the live page, returned the four rows with the ids
 *   `wb-sanction-oao-armada-ongoing` (the id the legacy README documents) and three more.
 *   Caveat: in this sandbox the egress proxy rewrote the sanction-document hrefs into
 *   `mcas-proxyweb.mcas.ms/certificate-checker` wrapper URLs, so the
 *   document URLs seen live here are an artefact of that proxy, not of the World Bank.
 *   The href handling is therefore verified against the legacy fixture (clean absolute
 *   worldbank.org URLs), not against the proxied live page.
 * ============================================================================
 */
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { capLength, trimEdgeChar } from '../../lib/safe_text.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const WORLD_BANK_DEBARRED_FIRMS_URL = 'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms';

/** Static fallback reference (the World Bank's own PDF summary of the debarment regime), independent of the page's live table markup. */
export const NOTES_ON_DEBARRED_FIRMS_FALLBACK_URL =
    'https://thedocs.worldbank.org/en/doc/387181466627871302-0290022021/original/WorldBankNotesonDebarredFirmsandIndividuals.pdf';

export const WORLD_BANK_JURISDICTION = 'WB';

const SANCTION_ID_PREFIX = 'wb-sanction-';

// Table 2 is located by matching its header row's text against these patterns
// (semantic, content-anchored - not a fabricated CSS class, since the page defines
// none for this hand-authored table).
const OTHER_SANCTIONS_HEADER_PATTERNS: RegExp[] = [/name of firm/i, /date of imposition/i, /sanction imposed/i, /grounds/i];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorldBankOtherSanctionRaw {
    firmNameRaw: string;
    dateOfImpositionRaw: string;
    sanctionImposedText: string | null;
    sanctionDocumentUrl: string | null;
    groundsRaw: string | null;
}

export interface DebarredFirmsExtractionResult {
    records: WorldBankOtherSanctionRaw[];
    degraded: boolean;
    degradedReason: string | null;
}

// ---------------------------------------------------------------------------
// Date + slug helpers (port of legacy dateUtils.ts / umsNormalizer.ts)
// ---------------------------------------------------------------------------

const MONTH_FULL: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};

/**
 * The "Date of Imposition of Sanction" column is free text: sometimes a status word
 * ("Ongoing"), sometimes a single long-form date, sometimes a "Month D, YYYY - Month
 * D, YYYY" range, and - confirmed in the live fixture - occasionally contains the
 * source's own typo (e.g. "Feberuary"). This deliberately only recognises
 * correctly-spelled full month names and returns null otherwise, rather than guessing
 * at a misspelling - a null effective_date_iso with the raw text preserved verbatim in
 * status_or_estado is more honest than a silently "corrected" guess. For a range the
 * FIRST date (the imposition date) is used.
 */
export function parseWorldBankSanctionDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    // A table cell holding a date: bounded so the pattern below is quadratic on at most 256 characters.
    const match = capLength(value, 256).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!match) return null;
    const [, monthName, dd, yyyy] = match;
    if (monthName === undefined || dd === undefined || yyyy === undefined) return null;
    const month = MONTH_FULL[monthName.toLowerCase()];
    if (month === undefined) return null;
    return new Date(Date.UTC(Number(yyyy), month, Number(dd)));
}

function toIsoOrNull(date: Date | null): string | null {
    return date ? date.toISOString() : null;
}

export function slugify(value: string): string {
    const dashed = value
        .toLowerCase()
        .normalize('NFKD')
        // Strip combining diacritical marks (U+0300-U+036F) left behind by NFKD, e.g. "é" -> "e".
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-');
    // Linear edge trim instead of /^-+|-+$/ (quadratic on a long run of dashes).
    return trimEdgeChar(dashed, '-').slice(0, 80);
}

// ---------------------------------------------------------------------------
// Table 2 parser (port of legacy src/sources/worldBankDebarredFirms.ts)
// ---------------------------------------------------------------------------

/** True when a table's first row carries all four "Other Sanctions" header labels. */
export function isOtherSanctionsHeader(headerRowText: string): boolean {
    const text = headerRowText.replace(/\s+/g, ' ');
    return OTHER_SANCTIONS_HEADER_PATTERNS.every((pattern) => pattern.test(text));
}

/**
 * Pure parser - no network I/O. A missing table or a table with zero data rows is an
 * extraction-integrity failure (`degraded: true`), never "no sanctions currently exist".
 */
export function parseOtherSanctionsHtml(html: string): DebarredFirmsExtractionResult {
    const $ = cheerio.load(html);
    const tableElement = $('table')
        .toArray()
        .find((candidate) => isOtherSanctionsHeader($(candidate).find('tr').first().text()));
    const table = tableElement ? $(tableElement) : null;

    if (!table) {
        return {
            records: [],
            degraded: true,
            degradedReason:
                'Table 2 ("Other Sanctions") header row was not found in the fetched HTML - the page structure may have changed. Never interpreted as "no sanctions currently exist".',
        };
    }

    const rows = table.find('tr').toArray().slice(1); // skip the header row itself
    const records: WorldBankOtherSanctionRaw[] = [];

    for (const row of rows) {
        const cells = $(row).find('td').toArray();
        const [nameCell, dateCell, sanctionCell, groundsCell] = cells;
        if (cells.length < 4 || !nameCell || !dateCell || !sanctionCell || !groundsCell) continue;

        // The "Name of Firm & Address" cell sometimes holds more than just the firm name: a
        // first <p> with the name (+ a trailing "*<digits>" footnote marker), followed by one
        // or more further <p> siblings carrying the firm's address (confirmed live, e.g.
        // "TPF GETINSA EUROESTUDIOS S.L. *59" then separate <p>s for street/city/country). A
        // plain `.text()` over the whole cell concatenates all of that - address included -
        // onto the name, and in the live (minified) markup those <p>s are adjacent with no
        // whitespace between them at all, so the address would run directly onto the footnote
        // marker and silently break the "*<digits>" footnote-stripping regex. The firm name and
        // its footnote only ever live in the cell's first <p>, so anchoring extraction to that
        // first <p> sidesteps the concatenation entirely.
        const firstParagraph = $(nameCell).find('p').first();
        const firmNameRaw = (firstParagraph.length > 0 ? firstParagraph : $(nameCell)).text().replace(/\s+/g, ' ').trim();
        if (!firmNameRaw) continue;

        const dateOfImpositionRaw = $(dateCell).text().replace(/\s+/g, ' ').trim();
        const $sanction = $(sanctionCell);
        const sanctionImposedText = $sanction.text().replace(/\s+/g, ' ').trim() || null;
        const sanctionDocumentUrl = $sanction.find('a').first().attr('href') ?? null;
        const groundsRaw = $(groundsCell).text().replace(/\s+/g, ' ').trim() || null;

        records.push({ firmNameRaw, dateOfImpositionRaw, sanctionImposedText, sanctionDocumentUrl, groundsRaw });
    }

    if (records.length === 0) {
        return {
            records: [],
            degraded: true,
            degradedReason:
                'Table 2 header row matched but zero data rows were extracted from it - treated as an extraction-integrity failure (the table markup likely changed shape), never silently reported as "no debarred firms/sanctions exist".',
        };
    }

    return { records, degraded: false, degradedReason: null };
}

// ---------------------------------------------------------------------------
// Normalisation (port of legacy normalizeWorldBankOtherSanction)
// ---------------------------------------------------------------------------

export interface NormalizedSanction {
    cleanedName: string;
    /** Footnote number from a trailing "*<digits>" marker, as the legacy `reference_number`. */
    referenceNumber: string | null;
    payload: Record<string, unknown>;
}

/**
 * Keeps the legacy actor's dataset vocabulary (the 18-field Unified Master Schema) minus
 * the three fields the router owns (record_id, is_new, scraped_at); `event_type` is kept
 * because the legacy value was the constant 'SANCTION'. `grounds` is added: the legacy
 * parser always captured the "Grounds" column but its UMS row dropped it; it is the
 * reason for the sanction and a compliance consumer needs it.
 */
export function normalizeOtherSanction(raw: WorldBankOtherSanctionRaw): NormalizedSanction {
    // The firm-name cell sometimes carries a trailing footnote marker (e.g. "OAO Armada
    // *12"). Keep the raw cell text as entity_identifier_native and derive a cleaned
    // display name by stripping a trailing "*<digits>" marker.
    const cleanedName = raw.firmNameRaw.replace(/\*\d+\s*$/, '').trim() || raw.firmNameRaw;
    const referenceMatch = raw.firmNameRaw.match(/\*(\d+)\s*$/);
    const referenceNumber = referenceMatch?.[1] ?? null;

    return {
        cleanedName,
        referenceNumber,
        payload: {
            event_type: 'SANCTION',
            source_url: WORLD_BANK_DEBARRED_FIRMS_URL,
            recipient_or_defendant_name: cleanedName,
            entity_identifier_native: raw.firmNameRaw,
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: toIsoOrNull(parseWorldBankSanctionDate(raw.dateOfImpositionRaw)),
            publish_date_iso: null,
            category_or_type: raw.sanctionImposedText,
            // The source column genuinely mixes statuses ("Ongoing") and date ranges in one
            // cell - kept verbatim rather than force-split into a field it doesn't cleanly map to.
            status_or_estado: raw.dateOfImpositionRaw || null,
            awarding_or_regulating_agency: 'World Bank',
            jurisdiction: WORLD_BANK_JURISDICTION,
            source_document_url: raw.sanctionDocumentUrl,
            reference_number: referenceNumber,
            grounds: raw.groundsRaw,
        },
    };
}

/**
 * Legacy id scheme `wb-sanction-<slug(name)>-<slug(date text)>`. One addition: a name
 * with no ASCII letters or digits (all-Cyrillic or all-CJK, for example) slugifies to the empty string
 * and every such firm sharing a date would collide, so the slug falls back to a short
 * hash of the cleaned name. NOTE (inherited from the legacy design, not fixable without a
 * verified stable key): the id embeds the free-text date column, so the World Bank
 * correcting that cell (e.g. the live "Feberuary" typo) re-identifies the row once.
 */
export function sanctionRecordId(cleanedName: string, dateOfImpositionRaw: string): string {
    const nameSlug = slugify(cleanedName) || `n${fingerprintOf([cleanedName]).slice(0, 10)}`;
    return `${SANCTION_ID_PREFIX}${nameSlug}-${slugify(dateOfImpositionRaw)}`;
}

/** Makes ids unique within one fetch: the 2nd and later rows with an identical id get a `-2`, `-3` suffix in page order (the router would otherwise silently drop them). */
export function disambiguateIds(ids: readonly string[]): string[] {
    const seen = new Map<string, number>();
    return ids.map((id) => {
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        return n === 1 ? id : `${id}-${n}`;
    });
}

export function toSourceRecords(rows: readonly WorldBankOtherSanctionRaw[]): SourceRecord[] {
    const normalized = rows.map((raw) => ({ raw, norm: normalizeOtherSanction(raw) }));
    const ids = disambiguateIds(normalized.map(({ raw, norm }) => sanctionRecordId(norm.cleanedName, raw.dateOfImpositionRaw)));
    return normalized.map(({ raw, norm }, index) => ({
        recordId: ids[index] ?? '',
        // Every consumer-visible column of the row.
        fingerprint: fingerprintOf([
            norm.cleanedName,
            raw.firmNameRaw,
            raw.dateOfImpositionRaw,
            raw.sanctionImposedText,
            raw.sanctionDocumentUrl,
            raw.groundsRaw,
        ]),
        payload: norm.payload,
        watchText: norm.cleanedName,
    }));
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/** The legacy sub-source had no options of its own (countryFilter / noticeTypeFilter / dateRange belonged to Procurement Notices). Unknown keys are rejected so a copied-over legacy option fails loudly in preflight. */
export const worldBankDebarredOptionsSchema = z.object({}).strict();
export type WorldBankDebarredOptions = z.infer<typeof worldBankDebarredOptionsSchema>;

export const worldBankDebarredConnector: Connector<WorldBankDebarredOptions> = {
    id: 'world_bank_debarred',
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'actor-20-mdb-procurement-monitor',
    description:
        'World Bank "Other Sanctions" table (Table 2 of the debarred-firms page: letters of reprimand, conditional non-debarment and similar). Does NOT include the main debarment register (Table 1), which is only available from an undocumented gateway and is out of scope. Open static HTML; no credentials.',
    status: 'active',
    optionsSchema: worldBankDebarredOptionsSchema,

    async fetch(ctx: ConnectorContext, _options: WorldBankDebarredOptions, run: RunParams): Promise<SourceRecord[]> {
        let html: string;
        try {
            html = await ctx.http.getText(WORLD_BANK_DEBARRED_FIRMS_URL);
        } catch (error) {
            throw new SourceFetchError(
                `World Bank debarred-firms page download failed: ${error instanceof Error ? error.message : String(error)}`,
                'world_bank_debarred',
            );
        }

        const extraction = parseOtherSanctionsHtml(html);
        if (extraction.degraded) {
            // The legacy actor pushed (and billed) a "degraded" placeholder row here. A
            // billable result row that says "extraction failed" is worse than an isolated
            // source error, so the connector fails the source instead.
            throw new SourceFetchError(
                `World Bank Other Sanctions extraction degraded: ${extraction.degradedReason ?? 'unknown extraction failure'} Fallback reference: ${NOTES_ON_DEBARRED_FIRMS_FALLBACK_URL}`,
                'world_bank_debarred',
            );
        }

        const records = toSourceRecords(extraction.records).slice(0, run.maxItemsPerSource);
        ctx.log.info(`[world_bank_debarred] ${extraction.records.length} Other Sanctions row(s) parsed; ${records.length} returned.`);
        return records;
    },
};
