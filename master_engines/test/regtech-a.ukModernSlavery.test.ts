/**
 * uk_modern_slavery connector tests.
 *
 * Fixture: test/fixtures/regtech-a/StatementSummaries2026_excerpt.csv - TEN REAL ROWS cut from the live
 * registry file downloaded in this port session (2026-10-21; the legacy actor kept no CSV fixture, its tests
 * mocked the HTTP layer). Same header (75 columns), BOM and CRLF as the live file; rows are byte-identical to the
 * source except that the personal-contact columns ApprovingPerson and EmailAddressNoURL are blanked. The rows were
 * chosen for the hazards the live file really contains: a comma inside OrganisationName ("A Group, Inc."), literal
 * quote characters in names (`"K" LINE (EUROPE) LIMITED`, `"Edelweiss Air Ltd."`), a bare-numeric OrganisationName
 * with the real name in ParentName (Odeon), two rows that collide under the legacy record id (ASTOMOS ENERGY
 * CORPORATION, two company numbers), embedded CRLF inside quoted cells, a Public-sector row, rows with
 * missing recommended topics, an ILO-indicator row and a fully compliant row.
 *
 * Contains public sector information licensed under the Open Government Licence v3.0 (UK Government, Modern Slavery
 * Statement Registry).
 *
 * `parseCsv` is additionally exercised with small SYNTHETIC strings (labelled): they are parser unit tests, not
 * upstream responses. The parser was also cross-checked against Python's csv module on the complete live 2020, 2024,
 * 2026 and 2027 files (identical SHA-256 over every cell); that run is a one-off, not part of this suite.
 */
import { describe, expect, it } from 'vitest';

import {
    buildRecordId,
    computeContentFingerprint,
    computeStatusFingerprint,
    csvUrl,
    CsvParseError,
    disambiguateRecordIds,
    isFullyCompliant,
    matchesFilters,
    missingDisclosures,
    normalizeStatement,
    parseCsv,
    parseStatementCsv,
    resolveYears,
    sortNewestFirst,
    stripWrappingQuotes,
    toSourceRecord,
    ukModernSlaveryConnector,
    ukModernSlaveryOptionsSchema,
    withoutQuoteCharacters,
} from '../global-regtech-compliance-feed/connectors/ukModernSlavery.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter } from './regtech-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 500 };
const csv2026 = fixture('StatementSummaries2026_excerpt.csv');
const URL_2026 = csvUrl('2026');

/** Always-quoting CSV writer for building edited copies of the real fixture (the parser under test reads them back). */
function serialiseCsv(records: string[][]): string {
    return `${records.map((r) => r.map((f) => `"${f.replace(/"/g, '""')}"`).join(',')).join('\r\n')}\r\n`;
}

/** Returns the fixture with one cell of one row (matched by raw OrganisationName and, optionally, CompanyNumber) replaced. */
function editCell(text: string, organisationName: string, column: string, value: string, companyNumber?: string): string {
    const records = parseCsv(text);
    const header = records[0] ?? [];
    const col = header.indexOf(column);
    const nameCol = header.indexOf('OrganisationName');
    const companyCol = header.indexOf('CompanyNumber');
    expect(col).toBeGreaterThanOrEqual(0);
    const row = records.slice(1).find((r) => r[nameCol] === organisationName && (companyNumber === undefined || r[companyCol] === companyNumber));
    expect(row).toBeDefined();
    if (row) row[col] = value;
    return serialiseCsv(records);
}

const fetchWith = (routes: Record<string, string | Error>, options: Record<string, unknown> = {}, run: RunParams = RUN, now?: string) => {
    const stub = makeCtx(routes, now);
    return { stub, result: ukModernSlaveryConnector.fetch(stub.ctx, ukModernSlaveryConnector.optionsSchema.parse(options), run) };
};

const NEWEST_FIRST = [
    '"K" LINE (EUROPE) LIMITED', // 17/09/2026
    'ABBEY CROSS TRADING LIMITED', // 07/09/2026
    'Vodafone Enterprise Global Limited', // 07/07/2026
    'ASTOMOS ENERGY CORPORATION', // 01/07/2026 (BR010206, file order first)
    'ASTOMOS ENERGY CORPORATION', // 01/07/2026 (FC028623)
    'Edelweiss Air Ltd.', // 26/06/2026
    'ODEON CINEMAS GROUP LIMITED', // 09/06/2026
    'A Group, Inc.', // 18/05/2026
    'ABC CENTRAL LIMITED', // 31/03/2026
    'ASPIRATIONS ACADEMIES TRUST', // 05/01/2026
];

describe('parseCsv (SYNTHETIC inputs)', () => {
    it('parses plain records with CRLF, LF and CR terminators', () => {
        expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
        expect(parseCsv('a,b\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
        expect(parseCsv('a,b\rc,d\r')).toEqual([['a', 'b'], ['c', 'd']]);
        expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]); // no trailing terminator
    });

    it('drops a leading UTF-8 BOM so the first header is not "\\uFEFFName"', () => {
        expect(parseCsv('﻿Name,Age\r\nAnn,3\r\n')[0]).toEqual(['Name', 'Age']);
    });

    it('keeps commas inside quoted fields', () => {
        expect(parseCsv('"Acme, Inc.",Ltd\r\n"a,b,c",""\r\n')).toEqual([['Acme, Inc.', 'Ltd'], ['a,b,c', '']]);
    });

    it('keeps CRLF, LF and CR inside quoted fields verbatim and does not end the record there', () => {
        expect(parseCsv('"line1\r\nline2",x\r\n"a\nb",y\r\n"c\rd",z\r\n')).toEqual([['line1\r\nline2', 'x'], ['a\nb', 'y'], ['c\rd', 'z']]);
    });

    it('unescapes doubled quotes and keeps edge quotes that are data', () => {
        expect(parseCsv('"say ""hi""",b\r\n"""quoted""",c\r\n')).toEqual([['say "hi"', 'b'], ['"quoted"', 'c']]);
        expect(parseCsv('"""K"" LINE",x')).toEqual([['"K" LINE', 'x']]);
    });

    it('treats a quote inside an UNQUOTED field as literal (relax_quotes)', () => {
        expect(parseCsv('He said "hi",b\r\n5" pipe,c\r\n')).toEqual([['He said "hi"', 'b'], ['5" pipe', 'c']]);
    });

    it('keeps a stray quote that ends a quoted field early as a literal and reads the rest unquoted (relax_quotes)', () => {
        expect(parseCsv('"abc"def,ghi\r\n')).toEqual([['abc"def', 'ghi']]);
    });

    it('skips completely empty lines but never trims whitespace', () => {
        expect(parseCsv('\r\n\r\na,b\r\n\r\n\n c , d \r\n\r\n')).toEqual([['a', 'b'], [' c ', ' d ']]);
    });

    it('handles empty fields: leading, middle, trailing, at end of input', () => {
        expect(parseCsv(',a,,b,\r\n')).toEqual([['', 'a', '', 'b', '']]);
        expect(parseCsv('a,b,')).toEqual([['a', 'b', '']]);
        expect(parseCsv('""\r\n')).toEqual([['']]);
        expect(parseCsv('a,"b"')).toEqual([['a', 'b']]);
    });

    it('returns no records for empty or whitespace-terminator-only input', () => {
        expect(parseCsv('')).toEqual([]);
        expect(parseCsv('\r\n\r\n')).toEqual([]);
        expect(parseCsv('﻿')).toEqual([]);
    });

    it('fails loudly on an unterminated quoted field instead of swallowing the rest of the file', () => {
        expect(() => parseCsv('a,b\r\n"never closed,x\r\nc,d\r\n')).toThrow(CsvParseError);
        expect(() => parseCsv('a,b\r\n"never closed,x\r\nc,d\r\n')).toThrow(/Unterminated quoted field in record 2/);
    });

    it('round-trips a large generated document with commas, quotes and newlines in quoted cells', () => {
        const rows: string[][] = [['id', 'name', 'notes']];
        for (let i = 0; i < 20_000; i += 1) rows.push([String(i), `Org, ${i} "Ltd"`, i % 7 === 0 ? `multi\r\nline ${i}` : `plain ${i}`]);
        const parsed = parseCsv(serialiseCsv(rows));
        expect(parsed).toHaveLength(rows.length);
        expect(parsed[12_345]).toEqual(rows[12_345]);
        expect(parsed[19_999]).toEqual(rows[19_999]);
    });
});

describe('parseStatementCsv (real fixture)', () => {
    const parsed = parseStatementCsv(csv2026);

    it('reads the 75-column header without the BOM and all ten rows, none malformed', () => {
        expect(parsed.header).toHaveLength(75);
        expect(parsed.header[0]).toBe('StatementYear');
        expect(parsed.rows).toHaveLength(10);
        expect(parsed.malformedRowCount).toBe(0);
    });

    it('keeps real quoted commas, literal quotes and embedded CRLF exactly as published', () => {
        const byName = (name: string) => parsed.rows.find((r) => r.OrganisationName === name);
        expect(byName('A Group, Inc.')?.CompanyNumber).toBe('');
        expect(byName('"K" LINE (EUROPE) LIMITED')?.CompanyNumber).toBe('05639474');
        expect(byName('"Edelweiss Air Ltd."')).toBeDefined();
        expect(byName('ABC CENTRAL LIMITED')?.Address).toBe('Pinder House\r\n249 Upper Third Street\r\nMilton Keynes\r\nEngland\r\nMK9 1DS');
        expect(byName('ABC CENTRAL LIMITED')?.OrganisationSectors).toContain('\r\n');
        expect(byName('ABC CENTRAL LIMITED')?.StatementSummaryURL).toMatch(/^https:\/\/modern-slavery-statement-registry\.service\.gov\.uk\/statement-summary\/[A-Za-z0-9]+\/2026$/);
    });

    it('blanked contact columns stay blank (the fixture carries no personal contact data)', () => {
        expect(parsed.rows.every((r) => r.ApprovingPerson === '' && r.EmailAddressNoURL === '')).toBe(true);
    });

    it('refuses a document that is not a statement-summary CSV (an HTML 200 page) instead of yielding zero rows', () => {
        expect(() => parseStatementCsv('<html><body>Service unavailable</body></html>')).toThrow(CsvParseError);
        expect(() => parseStatementCsv('<html><body>Service unavailable</body></html>')).toThrow(/missing column\(s\) StatementSummaryURL, OrganisationName/);
        expect(() => parseStatementCsv('')).toThrow(/empty/);
    });

    it('skips and counts a row whose field count differs from the header (never mis-aligns it) - SYNTHETIC extra line', () => {
        const withBadRow = parseStatementCsv(`${csv2026}short,row\r\n`);
        expect(withBadRow.rows).toHaveLength(10);
        expect(withBadRow.malformedRowCount).toBe(1);
    });
});

describe('stripWrappingQuotes', () => {
    it.each([
        ['"Edelweiss Air Ltd."', 'Edelweiss Air Ltd.'],
        ['""Doubled""', 'Doubled'],
        ['"K" LINE (EUROPE) LIMITED', '"K" LINE (EUROPE) LIMITED'], // starts with a quote but is not wrapped: untouched (the legacy normaliser mangled it to K" LINE (EUROPE) LIMITED)
        ['"K” LINE ENERGY SHIPPING (UK) LIMITED', '"K” LINE ENERGY SHIPPING (UK) LIMITED'],
        ['GDCC NEWCO ("G") LIMITED', 'GDCC NEWCO ("G") LIMITED'],
        ['"A" and "B"', '"A" and "B"'], // interior quotes: not a simple wrapper
        ['Plain Name', 'Plain Name'],
    ])('%j -> %j', (input, expected) => {
        expect(stripWrappingQuotes(input)).toBe(expected);
    });
});

describe('withoutQuoteCharacters', () => {
    it.each([
        ['"K" LINE (EUROPE) LIMITED', 'K LINE (EUROPE) LIMITED'],
        ['"K\u201D LINE ENERGY SHIPPING (UK) LIMITED', 'K LINE ENERGY SHIPPING (UK) LIMITED'], // typographic closing quote, as in the live file
        ['GDCC NEWCO ("G") LIMITED', 'GDCC NEWCO (G) LIMITED'],
        ['Plain Name Ltd', 'Plain Name Ltd'],
        ['Children\u2019s Trust', 'Children\u2019s Trust'], // an apostrophe is not a quote mark: untouched
    ])('%j -> %j', (input, expected) => {
        expect(withoutQuoteCharacters(input)).toBe(expected);
    });
});

describe('normalizeStatement (real rows)', () => {
    const normalized = parseStatementCsv(csv2026).rows.map(normalizeStatement);
    const named = (name: string, company?: string) => normalized.find((n) => n.organisationName === name && (company === undefined || n.companyNumber === company));

    it('keeps the `"K" LINE` names intact (the legacy normaliser stripped their leading quote) and unwraps `"Edelweiss Air Ltd."`', () => {
        expect(named('"K" LINE (EUROPE) LIMITED')).toBeDefined();
        expect(named('Edelweiss Air Ltd.')).toBeDefined();
        expect(normalized.some((n) => n.organisationName === 'K" LINE (EUROPE) LIMITED')).toBe(false);
    });

    it('takes the display name from ParentName when OrganisationName is a bare number (Odeon)', () => {
        const odeon = named('ODEON CINEMAS GROUP LIMITED');
        expect(odeon).toMatchObject({ parentName: 'ODEON CINEMAS GROUP LIMITED', groupSubmission: true, address: null });
        expect(odeon?.recordId).toMatch(/::10246724$/); // the id still uses the raw OrganisationName
    });

    it('joins the multi-line address with ", " and splits multi-value sectors', () => {
        const abc = named('ABC CENTRAL LIMITED');
        expect(abc?.address).toBe('Pinder House, 249 Upper Third Street, Milton Keynes, England, MK9 1DS');
        expect(abc?.organisationSectors).toEqual([
            'Financial, insurance and real estate activities',
            'Information technology and telecommunication',
            'Professional and administrative services and supplies, including legal, consulting and accounting services',
        ]);
    });

    it('derives booleans, missing disclosures and the ILO flag from the registry encoding', () => {
        const abc = named('ABC CENTRAL LIMITED');
        expect(abc && missingDisclosures(abc)).toEqual(['Organisational structure', 'Training', 'Goals']);
        expect(abc && isFullyCompliant(abc)).toBe(false);
        const abbey = named('ABBEY CROSS TRADING LIMITED');
        expect(abbey && missingDisclosures(abbey)).toEqual([]);
        expect(abbey && isFullyCompliant(abbey)).toBe(true);
        expect(named('Vodafone Enterprise Global Limited')?.iloIndicatorsInStatement).toBe(true);
        expect(abbey?.iloIndicatorsInStatement).toBe(false);
    });

    it('throws for a row with no StatementSummaryURL (no stable identifier)', () => {
        expect(() => normalizeStatement({ OrganisationName: 'X', StatementSummaryURL: '  ' })).toThrow(/missing StatementSummaryURL/);
    });
});

describe('record ids', () => {
    const rows = parseStatementCsv(csv2026).rows;
    const normalized = rows.map(normalizeStatement);
    const astomos = rows.filter((r) => r.OrganisationName === 'ASTOMOS ENERGY CORPORATION');

    it('are unique across the real rows', () => {
        expect(new Set(normalized.map((n) => n.recordId)).size).toBe(normalized.length);
    });

    it('proves the legacy key collides on real data and that the CompanyNumber suffix resolves it', () => {
        expect(astomos).toHaveLength(2);
        const legacy = (r: Record<string, string>) => `${r.StatementSummaryURL}::${r.OrganisationName}`;
        expect(legacy(astomos[0] ?? {})).toBe(legacy(astomos[1] ?? {})); // the router would silently drop one of them
        const ids = astomos.map((r) => buildRecordId(r.StatementSummaryURL ?? '', r));
        expect(ids[0]).not.toBe(ids[1]);
        expect(ids[0]).toMatch(/::ASTOMOS ENERGY CORPORATION::BR010206$/);
        expect(ids[1]).toMatch(/::ASTOMOS ENERGY CORPORATION::FC028623$/);
    });

    it('keeps the legacy `<url>::<name>` form for a row without a company number', () => {
        const aGroup = rows.find((r) => r.OrganisationName === 'A Group, Inc.');
        expect(buildRecordId(aGroup?.StatementSummaryURL ?? '', aGroup ?? {})).toBe(`${aGroup?.StatementSummaryURL}::A Group, Inc.`);
    });

    it('falls back through name -> parent -> company number -> composite of other columns without duplicating the key', () => {
        const url = 'https://example.test/s/1';
        expect(buildRecordId(url, { OrganisationName: '', ParentName: 'Parent Plc', CompanyNumber: '' })).toBe(`${url}::Parent Plc`);
        expect(buildRecordId(url, { OrganisationName: '', ParentName: 'Parent Plc', CompanyNumber: '123' })).toBe(`${url}::Parent Plc::123`);
        expect(buildRecordId(url, { OrganisationName: '', ParentName: '', CompanyNumber: '123' })).toBe(`${url}::123`);
        expect(buildRecordId(url, { DateApproved: '01/01/2026', StatementStartDate: '01/01/2025', StatementEndDate: '31/12/2025', Address: 'x', Turnover: 'y' })).toBe(
            `${url}::unknown-organisation::01/01/2026|01/01/2025|31/12/2025|x|y`,
        );
    });

    it('disambiguateRecordIds gives later identical ids a #n suffix in load order and leaves unique ids alone', () => {
        const [first] = normalized;
        expect(first).toBeDefined();
        if (!first) return;
        const out = disambiguateRecordIds([first, first, { ...first, recordId: 'other' }, first]);
        expect(out.map((s) => s.recordId)).toEqual([first.recordId, `${first.recordId}#2`, 'other', `${first.recordId}#3`]);
    });
});

describe('fingerprints', () => {
    const base = parseStatementCsv(csv2026).rows.map(normalizeStatement).find((n) => n.organisationName === 'ABBEY CROSS TRADING LIMITED');
    if (!base) throw new Error('fixture row missing');

    it('are deterministic', () => {
        expect(toSourceRecord(base).fingerprint).toBe(toSourceRecord({ ...base }).fingerprint);
        expect(computeContentFingerprint(base)).toBe(computeContentFingerprint({ ...base }));
    });

    it('change when a consumer-visible field changes (topic coverage, update date, turnover, sectors, URL)', () => {
        const original = toSourceRecord(base).fingerprint;
        const changed = [
            { ...base, includesGoals: false },
            { ...base, lastUpdated: '08/09/2026' },
            { ...base, turnover: 'Over £500 million' },
            { ...base, organisationSectors: [...base.organisationSectors, 'Other'] },
            { ...base, pdfUrl: 'https://example.test/new.pdf' },
            { ...base, iloIndicatorsInStatement: true },
        ];
        for (const edit of changed) expect(toSourceRecord(edit).fingerprint).not.toBe(original);
    });

    it('ignores the record id and the summary URL (they are the key), and the status fingerprint ignores everything but the topics + ILO flag', () => {
        expect(computeContentFingerprint({ ...base, recordId: 'x', statementSummaryUrl: 'y' })).toBe(computeContentFingerprint(base));
        expect(computeStatusFingerprint({ ...base, lastUpdated: '01/01/2027', turnover: null })).toBe(computeStatusFingerprint(base));
        expect(computeStatusFingerprint({ ...base, includesTraining: false })).not.toBe(computeStatusFingerprint(base));
        expect(computeStatusFingerprint({ ...base, iloIndicatorsInStatement: true })).not.toBe(computeStatusFingerprint(base));
    });

    it('is unchanged by whitespace-only differences in the raw cell (cells are trimmed on normalisation)', () => {
        const padded = editCell(csv2026, 'ABBEY CROSS TRADING LIMITED', 'Turnover', '  Under £36 million  ');
        const recA = parseStatementCsv(csv2026).rows.map(normalizeStatement).map(toSourceRecord);
        const recB = parseStatementCsv(padded).rows.map(normalizeStatement).map(toSourceRecord);
        expect(recB.map((r) => r.fingerprint)).toEqual(recA.map((r) => r.fingerprint));
    });
});

describe('filters, ordering and years', () => {
    const normalized = parseStatementCsv(csv2026).rows.map(normalizeStatement);
    const none = { sectorFilter: [] as never[], turnoverFilter: [] as never[], onlyMissingDisclosures: false };

    it('empty filters keep everything; sector / turnover / missing-disclosure filters narrow as in the legacy actor', () => {
        expect(normalized.filter((n) => matchesFilters(n, none))).toHaveLength(10);
        expect(normalized.filter((n) => matchesFilters(n, { ...none, sectorFilter: ['Public'] })).map((n) => n.organisationName)).toEqual(['ASPIRATIONS ACADEMIES TRUST']);
        expect(normalized.filter((n) => matchesFilters(n, { ...none, turnoverFilter: ['Under £36 million'] })).map((n) => n.organisationName)).toEqual(['ABBEY CROSS TRADING LIMITED']);
        const gaps = normalized.filter((n) => matchesFilters(n, { ...none, onlyMissingDisclosures: true }));
        expect(gaps.every((n) => !isFullyCompliant(n))).toBe(true);
        expect(gaps.map((n) => n.organisationName)).not.toContain('ABBEY CROSS TRADING LIMITED');
        expect(gaps.map((n) => n.organisationName)).toContain('ABC CENTRAL LIMITED');
    });

    it('sortNewestFirst orders by LastUpdated (DD/MM/YYYY), then PDFDate, then file order', () => {
        expect(sortNewestFirst(normalized).map((n) => n.organisationName)).toEqual(NEWEST_FIRST);
        const a = { ...(normalized[0] as (typeof normalized)[number]), recordId: 'a', lastUpdated: '01/02/2026', pdfDate: '2026-02-01T09:00:00' };
        const b = { ...a, recordId: 'b', pdfDate: '2026-02-01T17:00:00' };
        const c = { ...a, recordId: 'c', pdfDate: null };
        const d = { ...a, recordId: 'd', lastUpdated: null };
        expect(sortNewestFirst([c, a, d, b]).map((s) => s.recordId)).toEqual(['b', 'a', 'c', 'd']);
    });

    it('resolveYears defaults to the run clock\'s calendar year and de-duplicates', () => {
        expect(resolveYears(undefined, new Date('2026-10-21T00:00:00Z'))).toEqual(['2026']);
        expect(resolveYears([], new Date('2027-01-02T00:00:00Z'))).toEqual(['2027']);
        expect(resolveYears(['2025', '2026', '2025'], new Date('2026-10-21T00:00:00Z'))).toEqual(['2025', '2026']);
    });
});

describe('ukModernSlaveryConnector.fetch', () => {
    it('is an active connector of the regtech engine with no credential requirement', () => {
        expect(ukModernSlaveryConnector.id).toBe('uk_modern_slavery');
        expect(ukModernSlaveryConnector.engine).toBe('global-regtech-compliance-feed');
        expect(ukModernSlaveryConnector.legacyActor).toBe('uk-modern-slavery-statement-registry-monitor');
        expect(ukModernSlaveryConnector.status).toBe('active');
        expect(ukModernSlaveryConnector.requiredOptions).toBeUndefined(); // OGL bulk download, no credential
    });

    it('builds the documented per-year URL and requests only the default (current-clock) year', async () => {
        const { stub, result } = fetchWith({ [URL_2026]: csv2026 });
        await result;
        expect(stub.calls).toEqual(['https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries2026.csv']);
        expect((stub.inits[0] as { timeoutMs?: number }).timeoutMs).toBeGreaterThan(30_000);

        const next = fetchWith({ [csvUrl('2027')]: csv2026 }, {}, RUN, '2027-02-01T00:00:00Z');
        await next.result;
        expect(next.stub.calls).toEqual([csvUrl('2027')]);
    });

    it('returns every real row, newest-updated first, with unique ids', async () => {
        const records = await fetchWith({ [URL_2026]: csv2026 }).result;
        expect(records.map((r) => r.payload.organisation_name)).toEqual(NEWEST_FIRST.map((n) => (n === '"Edelweiss Air Ltd."' ? 'Edelweiss Air Ltd.' : n)));
        expect(new Set(records.map((r) => r.recordId)).size).toBe(10);
    });

    it('uses the legacy dataset field names and never sets a key the router owns', async () => {
        const [first] = await fetchWith({ [URL_2026]: csv2026 }).result;
        expect(Object.keys(first?.payload ?? {}).sort()).toEqual(
            [
                '@type',
                'organisation_name',
                'company_number',
                'address',
                'parent_name',
                'group_submission',
                'sector_type',
                'organisation_sectors',
                'turnover',
                'statement_url',
                'statement_summary_url',
                'pdf_url',
                'statement_year',
                'statement_start_date',
                'statement_end_date',
                'date_approved',
                'last_updated',
                'pdf_date',
                'includes_org_structure',
                'includes_policies',
                'includes_risk_assessment',
                'includes_due_diligence',
                'includes_training',
                'includes_goals',
                'missing_disclosures',
                'is_fully_compliant',
                'ilo_indicators_in_statement',
                'status_fingerprint',
                'content_fingerprint',
            ].sort(),
        );
        for (const key of ROUTER_OWNED_KEYS) expect(first?.payload).not.toHaveProperty(key);
        expect(first?.payload).toMatchObject({ '@type': 'schema:Organization', statement_year: '2026', last_updated: '17/09/2026', sector_type: 'Private' });
    });

    it('watch text is the submitting organisation plus its parent for group submissions', async () => {
        const records = await fetchWith({ [URL_2026]: csv2026 }).result;
        const text = (name: string) => records.find((r) => r.payload.organisation_name === name)?.watchText;
        expect(text('"K" LINE (EUROPE) LIMITED')).toBe(
            '"K" LINE (EUROPE) LIMITED | "K" LINE BULK SHIPPING (UK) LIMITED | K LINE (EUROPE) LIMITED | K LINE BULK SHIPPING (UK) LIMITED',
        );
        expect(text('ODEON CINEMAS GROUP LIMITED')).toBe('ODEON CINEMAS GROUP LIMITED'); // name and parent are the same string
        expect(text('A Group, Inc.')).toBe('A Group, Inc.');
    });

    it('keeps both ASTOMOS rows (the legacy id would have collapsed them)', async () => {
        const records = await fetchWith({ [URL_2026]: csv2026 }).result;
        const astomos = records.filter((r) => r.payload.organisation_name === 'ASTOMOS ENERGY CORPORATION');
        expect(astomos.map((r) => r.payload.company_number).sort()).toEqual(['BR010206', 'FC028623']);
    });

    describe('recordId stability and fingerprint change detection', () => {
        it('same upstream bytes -> same ids and fingerprints', async () => {
            const a = await fetchWith({ [URL_2026]: csv2026 }).result;
            const b = await fetchWith({ [URL_2026]: csv2026 }).result;
            expect(b.map((r) => [r.recordId, r.fingerprint])).toEqual(a.map((r) => [r.recordId, r.fingerprint]));
        });

        it('a changed cell re-fingerprints only that row and keeps every id', async () => {
            const before = await fetchWith({ [URL_2026]: csv2026 }).result;
            const edited = editCell(csv2026, 'ABBEY CROSS TRADING LIMITED', 'StatementIncludesGoals', 'No');
            const after = await fetchWith({ [URL_2026]: edited }).result;
            expect(after.map((r) => r.recordId)).toEqual(before.map((r) => r.recordId));
            const changed = after.filter((r, i) => r.fingerprint !== before[i]?.fingerprint).map((r) => r.payload.organisation_name);
            expect(changed).toEqual(['ABBEY CROSS TRADING LIMITED']);
            expect(after.find((r) => r.payload.organisation_name === 'ABBEY CROSS TRADING LIMITED')?.payload).toMatchObject({
                is_fully_compliant: false,
                missing_disclosures: ['Goals'],
            });
        });

        it("a row's id does not depend on which other rows survive the filters or the cap", async () => {
            const all = await fetchWith({ [URL_2026]: csv2026 }).result;
            const filtered = await fetchWith({ [URL_2026]: csv2026 }, { sectorFilter: ['Private'], turnoverFilter: ['Over £500 million'] }).result;
            const allIds = new Set(all.map((r) => r.recordId));
            expect(filtered.length).toBeGreaterThan(0);
            expect(filtered.every((r) => allIds.has(r.recordId))).toBe(true);
        });
    });

    describe('options', () => {
        it('sectorFilter / turnoverFilter / onlyMissingDisclosures narrow the result', async () => {
            const routes = { [URL_2026]: csv2026 };
            expect((await fetchWith(routes, { sectorFilter: ['Public'] }).result).map((r) => r.payload.organisation_name)).toEqual(['ASPIRATIONS ACADEMIES TRUST']);
            expect((await fetchWith(routes, { turnoverFilter: ['Under £36 million'] }).result).map((r) => r.payload.organisation_name)).toEqual(['ABBEY CROSS TRADING LIMITED']);
            const gaps = await fetchWith(routes, { onlyMissingDisclosures: true }).result;
            expect(gaps.length).toBeGreaterThan(0);
            expect(gaps.every((r) => r.payload.is_fully_compliant === false)).toBe(true);
        });

        it('empty filter arrays mean "no filter"', async () => {
            const records = await fetchWith({ [URL_2026]: csv2026 }, { sectorFilter: [], turnoverFilter: [] }).result;
            expect(records).toHaveLength(10);
        });

        it('accepts the year as a number or a string, and several years at once (ids stay unique across years)', async () => {
            const routes = { [csvUrl('2025')]: csv2026, [URL_2026]: csv2026 };
            const { stub, result } = fetchWith(routes, { years: [2025, '2026'] });
            const records = await result;
            expect(stub.calls).toEqual([csvUrl('2025'), URL_2026]);
            // The same bytes served for both years duplicate every id: the second copy must be kept under a #2 suffix.
            expect(records).toHaveLength(20);
            expect(new Set(records.map((r) => r.recordId)).size).toBe(20);
            expect(records.filter((r) => r.recordId.endsWith('#2'))).toHaveLength(10);
        });
    });

    describe('maxItemsPerSource', () => {
        it('keeps the most recently updated statements when it caps (the file itself is unsorted)', async () => {
            const three = await fetchWith({ [URL_2026]: csv2026 }, {}, { maxItemsPerSource: 3 }).result;
            expect(three.map((r) => r.payload.organisation_name)).toEqual(['"K" LINE (EUROPE) LIMITED', 'ABBEY CROSS TRADING LIMITED', 'Vodafone Enterprise Global Limited']);
            expect(await fetchWith({ [URL_2026]: csv2026 }, {}, { maxItemsPerSource: 1 }).result).toHaveLength(1);
        });

        it('applies the cap after the filters', async () => {
            const one = await fetchWith({ [URL_2026]: csv2026 }, { turnoverFilter: ['Over £500 million'] }, { maxItemsPerSource: 1 }).result;
            expect(one.map((r) => r.payload.organisation_name)).toEqual(['Vodafone Enterprise Global Limited']);
        });
    });

    describe('failure paths (SourceFetchError, isolated by the router)', () => {
        it('a year that is not published yet (404) is skipped with a warning while other years still load', async () => {
            const { stub, result } = fetchWith({ [csvUrl('2028')]: new HttpStatusError(csvUrl('2028'), 404, 'OutOfRangeInput'), [URL_2026]: csv2026 }, { years: ['2028', '2026'] });
            expect(await result).toHaveLength(10);
            expect(stub.logs.warning.join('\n')).toMatch(/year 2028 skipped: no published file for this year yet \(404\)/);
        });

        it('a transient failure of one year does not discard the others', async () => {
            const { stub, result } = fetchWith({ [csvUrl('2025')]: new Error('socket hang up'), [URL_2026]: csv2026 }, { years: ['2025', '2026'] });
            expect(await result).toHaveLength(10);
            expect(stub.logs.warning.join('\n')).toMatch(/year 2025 skipped: socket hang up/);
        });

        it('when NO requested year can be loaded the source fails, listing every reason (never a silent empty result)', async () => {
            const routes = { [csvUrl('2028')]: new HttpStatusError(csvUrl('2028'), 404, ''), [URL_2026]: new Error('HTTP 503') };
            const error = await fetchWith(routes, { years: ['2028', '2026'] }).result.catch((e: unknown) => e);
            expect(error).toBeInstanceOf(SourceFetchError);
            expect((error as SourceFetchError).source).toBe('uk_modern_slavery');
            expect((error as SourceFetchError).message).toMatch(/2028: no published file.*2026: HTTP 503/);
        });

        it('a 200 response that is not the CSV (an HTML error page) fails the source', async () => {
            await expect(fetchWith({ [URL_2026]: '<html><body>Service unavailable</body></html>' }).result).rejects.toThrow(/No registry year could be loaded.*missing column/);
        });

        it('a file with more than 1% structurally broken rows is treated as a format change, not partially delivered', async () => {
            const header = (parseCsv(csv2026)[0] ?? []).join(',');
            const broken = `${header}\r\n${Array.from({ length: 5 }, (_, i) => `short,${i}`).join('\r\n')}\r\n`;
            await expect(fetchWith({ [URL_2026]: broken }).result).rejects.toThrow(/structurally broken/);
        });

        it('isolated broken rows are skipped with a warning while the rest is delivered', async () => {
            const [header = [], ...dataRows] = parseCsv(csv2026);
            const urlColumn = header.indexOf('StatementSummaryURL');
            // 110 rows with unique ids (the real rows repeated 11 times under distinct summary URLs) + 1 broken line = 0.9% broken.
            const many = Array.from({ length: 11 }, (_, copy) => dataRows.map((row) => row.map((cell, c) => (c === urlColumn ? `${cell}?copy=${copy}` : cell)))).flat();
            const text = `${serialiseCsv([header, ...many])}short,row\r\n`;
            const { stub, result } = fetchWith({ [URL_2026]: text });
            expect(await result).toHaveLength(110);
            expect(stub.logs.warning.join('\n')).toMatch(/1 of 111 row\(s\) skipped/);
        });
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-regtech-compliance-feed' as const, connectors: [ukModernSlaveryConnector] };
    const resolve = (sourceOptions: Record<string, Record<string, unknown>>) =>
        resolveSources(engine, EngineInputSchema.parse({ sources: ['uk_modern_slavery'], sourceOptions }));

    it('applies the defaults (no years: resolved from the run clock at fetch time)', () => {
        const [resolved] = resolve({});
        expect(resolved?.options).toEqual({ sectorFilter: [], turnoverFilter: [], onlyMissingDisclosures: false });
    });

    it('accepts documented options, including a numeric year', () => {
        const [resolved] = resolve({ uk_modern_slavery: { years: [2026, '2025'], sectorFilter: ['Private'], turnoverFilter: ['Over £500 million'], onlyMissingDisclosures: true } });
        expect(resolved?.options).toMatchObject({ years: ['2026', '2025'], sectorFilter: ['Private'], onlyMissingDisclosures: true });
    });

    it.each([
        [{ years: ['1999'] }, /years/],
        [{ years: ['26'] }, /years/],
        [{ years: Array.from({ length: 11 }, (_, i) => String(2020 + i)) }, /years/],
        [{ sectorFilter: ['Charity'] }, /sectorFilter/],
        [{ turnoverFilter: ['Over 1 million'] }, /turnoverFilter/],
        [{ onlyMissingDisclosures: 'yes' }, /onlyMissingDisclosures/],
        [{ maxItems: 5 }, /Unrecognized key/],
        [{ webhookUrl: 'https://example.test/hook' }, /Unrecognized key/], // legacy notifier option: out of scope, must fail loudly
        [{ resetState: true }, /Unrecognized key/],
    ])('rejects invalid options %j before any network call', (options, message) => {
        expect(() => resolve({ uk_modern_slavery: options })).toThrow(FatalConfigError);
        expect(() => resolve({ uk_modern_slavery: options })).toThrow(message);
    });

    it('has no BYOK credential, so there is no "missing credential" preflight failure to exercise', () => {
        expect(ukModernSlaveryOptionsSchema.safeParse({}).success).toBe(true);
    });
});

describe('uk_modern_slavery through the real router', () => {
    const routes = { [URL_2026]: csv2026 };

    it('emits envelope fields and bills one hit for "K Line", which matches `"K" LINE (EUROPE) LIMITED` through its quote-free spelling', async () => {
        const { rows, billing, summary } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'], watchlistNames: ['K Line'] }, makeCtx(routes));
        expect(rows).toHaveLength(10);
        expect(rows[0]).toMatchObject({
            engine: 'global-regtech-compliance-feed',
            source: 'uk_modern_slavery',
            delta_status: 'first_seen',
            is_new: true,
            organisation_name: '"K" LINE (EUROPE) LIMITED',
            is_watchlist_match: true,
            matched_watchlist_keyword: 'K Line',
        });
        expect(rows.filter((r) => r.is_watchlist_match)).toHaveLength(1);
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
        expect(summary.watchlist.accepted).toBe(1);
    });

    it('the exact registered spelling, quotes included, also matches', async () => {
        const { rows } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'], watchlistNames: ['"K" LINE (EUROPE)'] }, makeCtx(routes));
        expect(rows.filter((r) => r.is_watchlist_match).map((r) => r.organisation_name)).toEqual(['"K" LINE (EUROPE) LIMITED']);
    });

    it('bills one hit per matching row for a keyword that is present in the data (both ASTOMOS rows, not one)', async () => {
        const { rows, billing, summary } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'], watchlistNames: ['astomos energy'] }, makeCtx(routes));
        expect(rows.filter((r) => r.is_watchlist_match).map((r) => r.company_number).sort()).toEqual(['BR010206', 'FC028623']);
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(2);
        expect(billing.totalFor(RESULT_EVENT)).toBe(10);
        expect(summary.sources[0]).toMatchObject({ fetched: 10, emitted: 10, watchlistHits: 2 });
    });

    it('matches a watchlist entry against the parent of a group submission', async () => {
        const { rows } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'], watchlistNames: ['christie group'] }, makeCtx(routes));
        expect(rows.filter((r) => r.is_watchlist_match).map((r) => r.organisation_name)).toEqual(['ABC CENTRAL LIMITED']);
    });

    it('the ghost-billing inputs ([""], [" "], "", ["a"]) produce no match and no watchlist-hit charge', async () => {
        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const { rows, billing } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'], watchlistNames }, makeCtx(routes));
            expect(rows).toHaveLength(10);
            expect(rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('delta memory: an identical second run emits nothing; an edited row comes back as exactly one "updated" row', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'] }, makeCtx(routes), store);
        const again = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'] }, makeCtx(routes), store);
        expect(again.rows).toHaveLength(0);
        expect(again.summary.sources[0]).toMatchObject({ fetched: 10, unchanged: 10 });

        const edited = editCell(csv2026, 'ABC CENTRAL LIMITED', 'StatementIncludesPolicies', 'No');
        const third = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'] }, makeCtx({ [URL_2026]: edited }), store);
        expect(third.rows.map((r) => [r.organisation_name, r.delta_status])).toEqual([['ABC CENTRAL LIMITED', 'updated']]);
        expect(third.rows[0]?.missing_disclosures).toEqual(['Organisational structure', 'Policies', 'Training', 'Goals']);
    });

    it('a failing download is isolated: the run completes and reports the error', async () => {
        const { rows, summary } = await runThroughRouter(ukModernSlaveryConnector, { sources: ['uk_modern_slavery'] }, makeCtx({ [URL_2026]: new Error('HTTP 500') }));
        expect(rows).toHaveLength(0);
        expect(summary.sources[0]?.error).toMatch(/No registry year could be loaded/);
    });
});
