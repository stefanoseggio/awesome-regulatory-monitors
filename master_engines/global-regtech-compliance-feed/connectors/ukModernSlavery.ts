/**
 * ukModernSlavery.ts - UK Modern Slavery Statement Registry connector.
 *
 * Absorbs `uk-modern-slavery-statement-registry-monitor`: URL building (csvSource.ts),
 * CSV parsing, row normalisation + record id + fingerprints (deltaEngine.ts) and the
 * option filters (routes.ts matchesFilters). NOT ported, because the router owns them:
 * the delta engine's classification, per-year content-md5 cache, baseline bookkeeping,
 * `event_id`/`event_type`, notifier webhooks, Actor.pushData/charge.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original (legacy AGENTS.md section 0, 2026-09-16): there is NO API. The registry
 * (modern-slavery-statement-registry.service.gov.uk) publishes one full CSV per registry
 * year, on a downloads subdomain backed by Azure Blob Storage:
 *   https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries{YEAR}.csv
 * No authentication, licensed for reuse under the Open Government Licence v3.0, regenerated
 * nightly. It is an official bulk file: nothing to bypass.
 *
 * Re-verified in THIS port session (2026-10-21, curl through the sandbox egress proxy;
 * every number below was computed with an independent oracle, Python's csv module):
 *   StatementSummaries2026.csv -> HTTP/2 200 application/octet-stream, 16,068,687 bytes,
 *     last-modified 2026-10-21; UTF-8 BOM; 75 columns; 11,324 data rows; 0 rows with an
 *     inconsistent column count; every line ends CRLF and 11,069 rows contain embedded
 *     CRLF inside quoted fields (OrganisationSectors, Policies, Address and others); 159 rows
 *     have a comma inside OrganisationName and 9 have literal quote characters in it.
 *   2020 (8,479 rows), 2024 (13,048), 2027 (120): identical 75-column header, same
 *     encoding. Year 2028 -> HTTP 404 (XML <Error> BlobNotFound body), i.e. a not-yet-published year.
 *   The downloads host serves no robots.txt (a request for it returns an HTTP 400 OutOfRangeInput XML error).
 *   LastUpdated is DD/MM/YYYY (date only, never blank/odd in any of the four files);
 *   PDFDate is ISO-8601 datetime. The file is NOT sorted by either.
 *   In the 2026 file the five turnover brackets and the two sector types are exactly the option enums below.
 * End to end: the connector, driven through lib/http.ts createHttpClient (Node's global fetch,
 * honest User-Agent) against the live 2026 file, loaded 11,324 rows and returned the newest
 * updated statements. Run over local copies of the 2020, 2024, 2026 and 2027 files together, it
 * produced 32,971 records with 32,971 distinct ids (= 11,324 + 8,479 + 13,048 + 120 rows).
 * Findings that changed the port (kept explicit because they are load-bearing):
 *   1. The legacy record id `<StatementSummaryURL>::<OrganisationName>` COLLIDES on
 *      real data: 5 rows of 2026, 7 of 2020 and 8 of 2024 share it - two registrations of
 *      the same legal name with different company numbers under one group statement (e.g.
 *      ASTOMOS ENERGY CORPORATION, CompanyNumber BR010206 and FC028623). The router
 *      de-duplicates by recordId, so one of each pair would silently vanish. The
 *      CompanyNumber is the distinguishing column; appending it removes every collision
 *      in all four files (verified), and a residual collision gets an ordinal suffix.
 *   2. csv-parse is not a dependency of the master engines, so a small RFC 4180 parser
 *      is implemented here ({@link parseCsv}) with the legacy options' semantics
 *      (columns, skip_empty_lines, bom, relax_quotes). It was cross-checked against
 *      Python's csv module on the complete live 2020, 2024, 2026 and 2027 files
 *      (identical SHA-256 over every record and cell).
 * ============================================================================
 *
 * CAP-BEFORE-DELTA: the router applies `maxItemsPerSource` to what a connector returns,
 * before delta classification, and the connector has no view of state. A 10k-row snapshot
 * in file order (which is unsorted) would therefore pin the cap on an arbitrary, fixed
 * slice and never reach new statements further down. The connector returns rows newest
 * first (LastUpdated, then PDFDate) so a capped run keeps the most recently updated
 * statements. Delta memory also keeps only 5,000 ids per source (state.ts), so running
 * with maxItemsPerSource above that cannot be tracked reliably.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

/**
 * The registry's real, official, per-year bulk CSV download (see LIVE SOURCE VERIFICATION).
 */
export const UK_MSR_DOWNLOAD_BASE = 'https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads';

export function csvUrl(year: string): string {
    return `${UK_MSR_DOWNLOAD_BASE}/StatementSummaries${year}.csv`;
}

/** 16 MB per year over a slow link; the shared client's 30 s default is too tight. */
const CSV_TIMEOUT_MS = 120_000;
/** More than this share of structurally broken rows means the file format changed, not that one row is odd. */
const MAX_MALFORMED_ROW_RATIO = 0.01;
/** Columns without which a document is not a statement-summary file at all. */
const REQUIRED_COLUMNS = ['StatementSummaryURL', 'OrganisationName'] as const;

// ---------------------------------------------------------------------------
// RFC 4180 CSV parser
// ---------------------------------------------------------------------------

export class CsvParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CsvParseError';
    }
}

const CH_COMMA = 44;
const CH_QUOTE = 34;
const CH_LF = 10;
const CH_CR = 13;

/**
 * Parses CSV text into records of fields.
 *  - a leading UTF-8 BOM is dropped (csv-parse `bom: true`);
 *  - fields are separated by commas; records end at CRLF, LF or CR **outside quotes**;
 *  - a field that starts with a quote is quoted: commas, CR and LF inside it are data,
 *    and a doubled quote is one literal quote;
 *  - completely empty lines are skipped (csv-parse `skip_empty_lines`);
 *  - a quote inside an UNQUOTED field is literal, and a stray quote that closes a quoted
 *    field early (e.g. `"abc"def,`) is kept literally with the rest of the field read
 *    unquoted (csv-parse `relax_quotes`);
 *  - an unterminated quoted field is a hard error: it would otherwise swallow the rest of
 *    the file into one cell and report a tiny, "successful" result.
 * Whitespace is never trimmed. Pure.
 */
export function parseCsv(input: string): string[][] {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const n = text.length;
    const records: string[][] = [];
    let pos = 0;

    const readUnquoted = (): string => {
        const start = pos;
        while (pos < n) {
            const c = text.charCodeAt(pos);
            if (c === CH_COMMA || c === CH_LF || c === CH_CR) break;
            pos += 1;
        }
        return text.slice(start, pos);
    };

    while (pos < n) {
        // Skip empty lines between records.
        const first = text.charCodeAt(pos);
        if (first === CH_LF) {
            pos += 1;
            continue;
        }
        if (first === CH_CR) {
            pos += text.charCodeAt(pos + 1) === CH_LF ? 2 : 1;
            continue;
        }

        const record: string[] = [];
        for (;;) {
            let value: string;
            if (text.charCodeAt(pos) === CH_QUOTE) {
                pos += 1;
                let buffer = '';
                let segmentStart = pos;
                for (;;) {
                    if (pos >= n) throw new CsvParseError(`Unterminated quoted field in record ${records.length + 1} (end of input reached inside quotes).`);
                    if (text.charCodeAt(pos) !== CH_QUOTE) {
                        pos += 1;
                        continue;
                    }
                    const next = text.charCodeAt(pos + 1);
                    if (next === CH_QUOTE) {
                        // Escaped quote: keep one, skip the other.
                        buffer += text.slice(segmentStart, pos + 1);
                        pos += 2;
                        segmentStart = pos;
                        continue;
                    }
                    if (pos + 1 >= n || next === CH_COMMA || next === CH_LF || next === CH_CR) {
                        // Closing quote.
                        buffer += text.slice(segmentStart, pos);
                        pos += 1;
                        break;
                    }
                    // Stray quote inside a quoted field: literal, then the rest of the field is unquoted.
                    buffer += text.slice(segmentStart, pos + 1);
                    pos += 1;
                    buffer += readUnquoted();
                    break;
                }
                value = buffer;
            } else {
                value = readUnquoted();
            }
            record.push(value);

            if (pos >= n) break;
            const delimiter = text.charCodeAt(pos);
            if (delimiter === CH_COMMA) {
                pos += 1;
                if (pos >= n) {
                    // "a,b," at end of input: the final field is empty.
                    record.push('');
                    break;
                }
                continue;
            }
            // LF, CR or CRLF ends the record.
            pos += delimiter === CH_CR && text.charCodeAt(pos + 1) === CH_LF ? 2 : 1;
            break;
        }
        records.push(record);
    }
    return records;
}

export type RawStatementRow = Record<string, string>;

export interface ParsedStatementCsv {
    header: string[];
    rows: RawStatementRow[];
    /** Data rows skipped because their field count differs from the header's. */
    malformedRowCount: number;
}

/** CSV text -> header-keyed rows (csv-parse `columns: true`). Rows with the wrong field count are skipped and counted, never mis-aligned. */
export function parseStatementCsv(text: string): ParsedStatementCsv {
    const records = parseCsv(text);
    const header = records[0];
    if (!header) throw new CsvParseError('The CSV document is empty.');
    const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length > 0) {
        throw new CsvParseError(
            `The document is not a registry statement-summary CSV: missing column(s) ${missing.join(', ')} (header starts with: ${header.slice(0, 5).join(' | ').slice(0, 120)}).`,
        );
    }

    const rows: RawStatementRow[] = [];
    let malformedRowCount = 0;
    for (let i = 1; i < records.length; i += 1) {
        const fields = records[i];
        if (!fields || fields.length !== header.length) {
            malformedRowCount += 1;
            continue;
        }
        const row: RawStatementRow = {};
        for (let c = 0; c < header.length; c += 1) {
            const name = header[c];
            if (name !== undefined) row[name] = fields[c] ?? '';
        }
        rows.push(row);
    }
    return { header, rows, malformedRowCount };
}

// ---------------------------------------------------------------------------
// Normalisation (port of legacy deltaEngine.ts)
// ---------------------------------------------------------------------------

/** The six government-recommended topics a statement can cover - confirmed against the registry's own CSV columns. */
export const RECOMMENDED_TOPICS = ['Organisational structure', 'Policies', 'Risk assessment', 'Due diligence', 'Training', 'Goals'] as const;
export type RecommendedTopic = (typeof RECOMMENDED_TOPICS)[number];

export interface NormalizedStatement {
    recordId: string;
    organisationName: string | null;
    companyNumber: string | null;
    address: string | null;
    parentName: string | null;
    groupSubmission: boolean;
    sectorType: string | null;
    organisationSectors: string[];
    turnover: string | null;
    statementUrl: string | null;
    statementSummaryUrl: string;
    pdfUrl: string | null;
    statementYear: string;
    statementStartDate: string | null;
    statementEndDate: string | null;
    dateApproved: string | null;
    lastUpdated: string | null;
    pdfDate: string | null;
    includesOrgStructure: boolean;
    includesPolicies: boolean;
    includesRiskAssessment: boolean;
    includesDueDiligence: boolean;
    includesTraining: boolean;
    includesGoals: boolean;
    iloIndicatorsInStatement: boolean;
}

/** Splits a real CRLF/LF-joined multi-value CSV field into a clean array, dropping blank entries. */
function splitMultiValue(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/\r\n|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Registry booleans are encoded as the literal string 'Yes' or an empty string / 'No'. */
function toBoolean(raw: string | undefined): boolean {
    return (raw ?? '').trim().toLowerCase() === 'yes';
}

function toNullableString(raw: string | undefined): string | null {
    const trimmed = (raw ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Removes quote characters that WRAP a whole name (a real 2026 row is `"Edelweiss Air Ltd."`, quotes
 * included, as data). Only a name that both starts and ends with a quote and has no other quote inside
 * is unwrapped. The legacy `.replace(/^"+|"+$/g, '')` stripped edge quotes unconditionally, which
 * mangled real registered names that merely START with a quote - `"K" LINE (EUROPE) LIMITED` became
 * `K" LINE (EUROPE) LIMITED`, a string that is not the registered name (8 of the 9 quoted names in the
 * live 2026 file are "K" LINE companies).
 */
export function stripWrappingQuotes(name: string): string {
    // Linear scan instead of /^"+([^"]*)"+$/, which is quadratic on a long run of quote characters.
    let start = 0;
    let end = name.length;
    while (start < end && name[start] === '"') start += 1;
    while (end > start && name[end - 1] === '"') end -= 1;
    const inner = name.slice(start, end);
    if (inner === '' && name.length >= 2 && /^"+$/u.test(name)) return '';
    return start > 0 && end < name.length && !inner.includes('"') ? inner.trim() : name;
}

/**
 * `OrganisationName` is not always a name - confirmed live (10 of 11,324 rows in 2026), where it
 * holds a bare numeric reference while the real name sits in `ParentName`.
 */
function resolveDisplayName(organisationName: string | undefined, parentName: string | undefined): string | null {
    const cleaned = stripWrappingQuotes((organisationName ?? '').trim());
    const isBareNumeric = /^\d+$/.test(cleaned);
    if (cleaned.length > 0 && !isBareNumeric) return cleaned;
    return toNullableString(parentName);
}

/**
 * `StatementSummaryURL` alone is NOT unique: a group statement names several organisations that all
 * share one URL (one row each). The legacy key added the raw organisation identifier of the row.
 * That key still collides on live data (see the header), so the CompanyNumber is appended when it
 * is present and not already the key. Rows with no name, parent or company number fall back to the
 * legacy composite of other per-row columns.
 */
export function buildRecordId(statementSummaryUrl: string, row: RawStatementRow): string {
    const name = (row.OrganisationName ?? '').trim();
    const parent = (row.ParentName ?? '').trim();
    const company = (row.CompanyNumber ?? '').trim();
    const primaryOrgKey = name || parent || company;
    if (primaryOrgKey) {
        const base = `${statementSummaryUrl}::${primaryOrgKey}`;
        return company && company !== primaryOrgKey ? `${base}::${company}` : base;
    }

    const fallbackKey = [row.DateApproved, row.StatementStartDate, row.StatementEndDate, row.Address, row.Turnover]
        .map((value) => (value ?? '').trim())
        .join('|');
    return `${statementSummaryUrl}::unknown-organisation::${fallbackKey}`;
}

/** Throws for a row without a StatementSummaryURL (no stable identifier); the connector skips and counts such rows. */
export function normalizeStatement(row: RawStatementRow): NormalizedStatement {
    const statementSummaryUrl = toNullableString(row.StatementSummaryURL);
    if (!statementSummaryUrl) {
        throw new Error('Registry row is missing StatementSummaryURL - cannot track this record as it has no stable identifier.');
    }

    return {
        recordId: buildRecordId(statementSummaryUrl, row),
        organisationName: resolveDisplayName(row.OrganisationName, row.ParentName),
        companyNumber: toNullableString(row.CompanyNumber),
        address: splitMultiValue(row.Address).join(', ') || null,
        parentName: toNullableString(row.ParentName),
        groupSubmission: toBoolean(row.GroupSubmission),
        sectorType: toNullableString(row.SectorType),
        organisationSectors: splitMultiValue(row.OrganisationSectors),
        turnover: toNullableString(row.Turnover),
        statementUrl: toNullableString(row.StatementURL),
        statementSummaryUrl,
        pdfUrl: toNullableString(row.PDFURL),
        statementYear: (row.StatementYear ?? '').trim(),
        statementStartDate: toNullableString(row.StatementStartDate),
        statementEndDate: toNullableString(row.StatementEndDate),
        dateApproved: toNullableString(row.DateApproved),
        lastUpdated: toNullableString(row.LastUpdated),
        pdfDate: toNullableString(row.PDFDate),
        includesOrgStructure: toBoolean(row.StatementIncludesOrgStructure),
        includesPolicies: toBoolean(row.StatementIncludesPolicies),
        // The registry's own column name really is "...RisksAssessment".
        includesRiskAssessment: toBoolean(row.StatementIncludesRisksAssessment),
        includesDueDiligence: toBoolean(row.StatementIncludesDueDiligence),
        includesTraining: toBoolean(row.StatementIncludesTraining),
        includesGoals: toBoolean(row.StatementIncludesGoals),
        // A non-empty ILOIndicatorsInStatement means the organisation declared finding ILO
        // forced-labour indicators; the alternative, NoILOIndicatorsInStatement='Yes', is a "none found" declaration.
        iloIndicatorsInStatement: (row.ILOIndicatorsInStatement ?? '').trim().length > 0,
    };
}

export function missingDisclosures(statement: NormalizedStatement): RecommendedTopic[] {
    const coverage: Record<RecommendedTopic, boolean> = {
        'Organisational structure': statement.includesOrgStructure,
        Policies: statement.includesPolicies,
        'Risk assessment': statement.includesRiskAssessment,
        'Due diligence': statement.includesDueDiligence,
        Training: statement.includesTraining,
        Goals: statement.includesGoals,
    };
    return RECOMMENDED_TOPICS.filter((topic) => !coverage[topic]);
}

export function isFullyCompliant(statement: NormalizedStatement): boolean {
    return missingDisclosures(statement).length === 0;
}

// ---------------------------------------------------------------------------
// Fingerprints (port of legacy computeContentFingerprint / computeStatusFingerprint)
// ---------------------------------------------------------------------------

/** Recursive key-sort canonicalisation. */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => [key, canonicalize(val)] as const);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/** Excludes `recordId` (the key itself) and `statementSummaryUrl` (part of the key). */
export function computeContentFingerprint(statement: NormalizedStatement): string {
    const { recordId: _recordId, statementSummaryUrl: _statementSummaryUrl, ...rest } = statement;
    return sha256(JSON.stringify(canonicalize(rest)));
}

/** The compliance-status subset a buyer escalates on: the six topics and the ILO declaration. */
export function computeStatusFingerprint(statement: NormalizedStatement): string {
    return sha256(
        JSON.stringify(
            canonicalize({
                includesOrgStructure: statement.includesOrgStructure,
                includesPolicies: statement.includesPolicies,
                includesRiskAssessment: statement.includesRiskAssessment,
                includesDueDiligence: statement.includesDueDiligence,
                includesTraining: statement.includesTraining,
                includesGoals: statement.includesGoals,
                iloIndicatorsInStatement: statement.iloIndicatorsInStatement,
            }),
        ),
    );
}

// ---------------------------------------------------------------------------
// Options, filters, ordering
// ---------------------------------------------------------------------------

export const SECTOR_TYPES = ['Private', 'Public'] as const;
export const TURNOVER_BRACKETS = [
    'Under £36 million',
    '£36 million to £60 million',
    '£60 million to £100 million',
    '£100 million to £500 million',
    'Over £500 million',
] as const;

const registryYearSchema = z.preprocess(
    (value) => (typeof value === 'number' ? String(value) : value),
    z.string().regex(/^20[2-9]\d$/, 'must be a four-digit registry year such as "2026" (the registry publishes from 2020)'),
);

/**
 * `sectorFilter` and `turnoverFilter` are closed vocabularies matched by exact equality, not free-text
 * substring needles, so the empty-needle hazard that `sanitizeKeywordList` guards against cannot occur;
 * an empty array means "no filter", as in the legacy actor. Organisation-name watching is the router's
 * `watchlistNames` (matched against this connector's `watchText`), not a connector option.
 */
export const ukModernSlaveryOptionsSchema = z
    .object({
        /** Registry years to fetch (one ~8-18 MB CSV each). Default: the current calendar year (from the run clock). */
        years: z.array(registryYearSchema).max(10).optional(),
        sectorFilter: z.array(z.enum(SECTOR_TYPES)).default([]),
        turnoverFilter: z.array(z.enum(TURNOVER_BRACKETS)).default([]),
        /** Return only statements that do not cover all six recommended topics. */
        onlyMissingDisclosures: z.boolean().default(false),
    })
    .strict();
export type UkModernSlaveryOptions = z.infer<typeof ukModernSlaveryOptionsSchema>;

export function resolveYears(requested: readonly string[] | undefined, now: Date): string[] {
    const list = requested && requested.length > 0 ? requested : [String(now.getUTCFullYear())];
    return [...new Set(list)];
}

export function matchesFilters(statement: NormalizedStatement, options: Pick<UkModernSlaveryOptions, 'sectorFilter' | 'turnoverFilter' | 'onlyMissingDisclosures'>): boolean {
    if (options.sectorFilter.length > 0) {
        if (!statement.sectorType || !(options.sectorFilter as readonly string[]).includes(statement.sectorType)) return false;
    }
    if (options.turnoverFilter.length > 0) {
        if (!statement.turnover || !(options.turnoverFilter as readonly string[]).includes(statement.turnover)) return false;
    }
    if (options.onlyMissingDisclosures && isFullyCompliant(statement)) return false;
    return true;
}

/** `DD/MM/YYYY` -> `YYYYMMDD` as a number (0 when absent or not in that shape). */
function lastUpdatedKey(value: string | null): number {
    const match = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return 0;
    return Number(`${match[3]}${match[2]}${match[1]}`);
}

/** Newest first by LastUpdated, then PDFDate (ISO, so lexicographic order is chronological), then original order. */
export function sortNewestFirst(statements: readonly NormalizedStatement[]): NormalizedStatement[] {
    return statements
        .map((statement, index) => ({ statement, index, day: lastUpdatedKey(statement.lastUpdated), pdf: statement.pdfDate ?? '' }))
        .sort((a, b) => {
            if (a.day !== b.day) return b.day - a.day;
            if (a.pdf !== b.pdf) return a.pdf < b.pdf ? 1 : -1;
            return a.index - b.index;
        })
        .map((entry) => entry.statement);
}

/** Gives the 2nd and later statements with an identical record id a `#2`, `#3` suffix in load order, so none is dropped by the router. */
export function disambiguateRecordIds(statements: readonly NormalizedStatement[]): NormalizedStatement[] {
    const seen = new Map<string, number>();
    return statements.map((statement) => {
        const n = (seen.get(statement.recordId) ?? 0) + 1;
        seen.set(statement.recordId, n);
        return n === 1 ? statement : { ...statement, recordId: `${statement.recordId}#${n}` };
    });
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

/** Double-quote characters (straight and typographic) that appear inside registered names. */
const QUOTE_CHARACTERS = /["\u201C\u201D\u201E\u201F]/g;

/**
 * A name as a compliance analyst would type it into a watchlist: without the quote characters some
 * registered names carry (`"K" LINE (EUROPE) LIMITED` -> `K LINE (EUROPE) LIMITED`). The substring
 * guard normalises case, Unicode form and whitespace but not punctuation, so without this alias the
 * watchlist entry "K Line" could not match 8 real 2026 rows.
 */
export function withoutQuoteCharacters(name: string): string {
    return name.replace(QUOTE_CHARACTERS, '').replace(/\s+/g, ' ').trim();
}

export function toSourceRecord(statement: NormalizedStatement): SourceRecord {
    const contentFingerprint = computeContentFingerprint(statement);
    const missing = missingDisclosures(statement);
    const names = [statement.organisationName, statement.parentName].filter((n): n is string => n !== null);
    const aliases = names.map(withoutQuoteCharacters).filter((alias) => alias.length > 0 && !names.includes(alias));
    return {
        recordId: statement.recordId,
        // Derived from the hash of every normalised field except the key, so it changes iff a consumer-visible field did.
        fingerprint: fingerprintOf([contentFingerprint]),
        // The submitting organisation and, for group submissions, its parent - as published, plus the quote-free
        // spelling when the published name contains quote characters.
        watchText: [...new Set([...names, ...aliases])].join(' | ') || undefined,
        payload: {
            // The legacy dataset's own field names (minus event_id / event_type / is_new / scraped_at / record_id,
            // which depend on delta state or are owned by the router).
            '@type': 'schema:Organization',
            organisation_name: statement.organisationName,
            company_number: statement.companyNumber,
            address: statement.address,
            parent_name: statement.parentName,
            group_submission: statement.groupSubmission,
            sector_type: statement.sectorType,
            organisation_sectors: statement.organisationSectors,
            turnover: statement.turnover,
            statement_url: statement.statementUrl,
            statement_summary_url: statement.statementSummaryUrl,
            pdf_url: statement.pdfUrl,
            statement_year: statement.statementYear,
            statement_start_date: statement.statementStartDate,
            statement_end_date: statement.statementEndDate,
            date_approved: statement.dateApproved,
            last_updated: statement.lastUpdated,
            pdf_date: statement.pdfDate,
            includes_org_structure: statement.includesOrgStructure,
            includes_policies: statement.includesPolicies,
            includes_risk_assessment: statement.includesRiskAssessment,
            includes_due_diligence: statement.includesDueDiligence,
            includes_training: statement.includesTraining,
            includes_goals: statement.includesGoals,
            missing_disclosures: missing,
            is_fully_compliant: missing.length === 0,
            ilo_indicators_in_statement: statement.iloIndicatorsInStatement,
            status_fingerprint: computeStatusFingerprint(statement),
            content_fingerprint: contentFingerprint,
        },
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const ukModernSlaveryConnector: Connector<UkModernSlaveryOptions> = {
    id: 'uk_modern_slavery',
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'uk-modern-slavery-statement-registry-monitor',
    description:
        'UK Modern Slavery Statement Registry: the registry\'s official per-year bulk CSV (Open Government Licence v3.0), one record per submitting organisation per statement, newest-updated first. Open download; no credentials.',
    status: 'active',
    // One registry year alone is 11k-13k rows, above the engine-wide default memory of 5000 ids; below that, ids would be
    // evicted and re-emitted as first_seen on every run.
    maxSeenIds: 40_000,
    optionsSchema: ukModernSlaveryOptionsSchema,

    async fetch(ctx: ConnectorContext, options: UkModernSlaveryOptions, run: RunParams): Promise<SourceRecord[]> {
        const years = resolveYears(options.years, ctx.now());
        const loaded: NormalizedStatement[] = [];
        const failures: string[] = [];
        let yearsLoaded = 0;

        for (const year of years) {
            const url = csvUrl(year);
            let text: string;
            try {
                text = await ctx.http.getText(url, { timeoutMs: CSV_TIMEOUT_MS });
            } catch (error) {
                const reason = error instanceof HttpStatusError && error.status === 404 ? 'no published file for this year yet (404)' : describeError(error);
                ctx.log.warning(`[uk_modern_slavery] registry year ${year} skipped: ${reason}`);
                failures.push(`${year}: ${reason}`);
                continue;
            }

            let parsed: ParsedStatementCsv;
            try {
                parsed = parseStatementCsv(text);
            } catch (error) {
                ctx.log.warning(`[uk_modern_slavery] registry year ${year} skipped: ${describeError(error)}`);
                failures.push(`${year}: ${describeError(error)}`);
                continue;
            }
            const totalRows = parsed.rows.length + parsed.malformedRowCount;
            if (parsed.malformedRowCount > 0) {
                ctx.log.warning(`[uk_modern_slavery] registry year ${year}: ${parsed.malformedRowCount} of ${totalRows} row(s) skipped (field count differs from the header).`);
            }
            if (parsed.malformedRowCount > totalRows * MAX_MALFORMED_ROW_RATIO) {
                failures.push(`${year}: ${parsed.malformedRowCount} of ${totalRows} rows are structurally broken (> ${MAX_MALFORMED_ROW_RATIO * 100}%), the file format has likely changed`);
                continue;
            }

            let unidentifiable = 0;
            for (const row of parsed.rows) {
                try {
                    loaded.push(normalizeStatement(row));
                } catch {
                    unidentifiable += 1;
                }
            }
            if (unidentifiable > 0) {
                ctx.log.warning(`[uk_modern_slavery] registry year ${year}: ${unidentifiable} row(s) skipped (no StatementSummaryURL, so no stable identifier).`);
            }
            yearsLoaded += 1;
        }

        if (yearsLoaded === 0) {
            throw new SourceFetchError(`No registry year could be loaded (${failures.join('; ')}).`, 'uk_modern_slavery');
        }

        // Ids are made unique over the whole load (file order) BEFORE filtering/sorting/capping, so a row's id
        // never depends on which other rows survive this run's options.
        const statements = disambiguateRecordIds(loaded).filter((statement) => matchesFilters(statement, options));
        const records = sortNewestFirst(statements).slice(0, run.maxItemsPerSource).map(toSourceRecord);

        ctx.log.info(
            `[uk_modern_slavery] ${yearsLoaded}/${years.length} registry year(s) loaded, ${loaded.length} statement row(s), ${statements.length} after filters; returning the ${records.length} most recently updated.`,
        );
        return records;
    },
};
