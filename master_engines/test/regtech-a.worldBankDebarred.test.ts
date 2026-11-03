/**
 * world_bank_debarred connector tests.
 *
 * Fixtures (test/fixtures/regtech-a/, no network), both COPIED VERBATIM from the legacy actor
 * (actor-20-mdb-procurement-monitor/test/fixtures):
 *   - worldBankOtherSanctions.html: the real "Other Sanctions" table markup captured live on 2026-09-07
 *     (page chrome trimmed; the <table> itself verbatim, including the source's own "Feberuary" typo).
 *   - worldBankOtherSanctionsMissing.html: SYNTHETIC page with no Other Sanctions table (the legacy
 *     authors say so in the file); it stands in for a page redesign.
 * Inline HTML snippets below are SYNTHETIC too and are labelled where used.
 */
import { describe, expect, it } from 'vitest';

import {
    disambiguateIds,
    isOtherSanctionsHeader,
    NOTES_ON_DEBARRED_FIRMS_FALLBACK_URL,
    normalizeOtherSanction,
    parseOtherSanctionsHtml,
    parseWorldBankSanctionDate,
    sanctionRecordId,
    slugify,
    toSourceRecords,
    WORLD_BANK_DEBARRED_FIRMS_URL,
    worldBankDebarredConnector,
    worldBankDebarredOptionsSchema,
} from '../global-regtech-compliance-feed/connectors/worldBankDebarred.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter } from './regtech-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const html = fixture('worldBankOtherSanctions.html');
const routes = { [WORLD_BANK_DEBARRED_FIRMS_URL]: html };

/** SYNTHETIC page: a header-matching table with `rows` data rows, each a 4-tuple of cell HTML. */
function syntheticPage(rows: Array<[string, string, string, string]>): string {
    const header = ['Name of Firm &amp; Address', 'Date of Imposition of Sanction', 'Sanction Imposed', 'Grounds'].map((h) => `<td><p><b>${h}</b></p></td>`).join('');
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<html><body><table><tbody><tr>${header}</tr>${body}</tbody></table></body></html>`;
}

function fetchRecords(page: string = html, run: RunParams = RUN) {
    const stub = makeCtx({ [WORLD_BANK_DEBARRED_FIRMS_URL]: page });
    return { stub, result: worldBankDebarredConnector.fetch(stub.ctx, worldBankDebarredConnector.optionsSchema.parse({}), run) };
}

describe('parseOtherSanctionsHtml (legacy fixture, verbatim)', () => {
    const result = parseOtherSanctionsHtml(html);

    it('extracts all 4 rows of the real table', () => {
        expect(result.degraded).toBe(false);
        expect(result.degradedReason).toBeNull();
        expect(result.records).toHaveLength(4);
    });

    it('reads name (first <p> only, address excluded), date text, sanction + document link, grounds', () => {
        const [armada, bumirejo, tpf, iqvia] = result.records;
        expect(armada).toEqual({
            firmNameRaw: 'OAO Armada *12',
            dateOfImpositionRaw: 'Ongoing',
            sanctionImposedText: 'Letter of reprimand',
            sanctionDocumentUrl:
                'https://www.worldbank.org/content/dam/documents/sanctions/sanctions-board/2025/sep/Sanctions%20Board%20Decision%20No.%2065%20-%20Letter%20of%20Reprimand.pdf',
            groundsRaw: 'Sanctions Procedures, Section 9.04(a)',
        });
        expect(bumirejo?.firmNameRaw).toBe('PT. Bumirejo *13');
        // The address <p>s ("Ramon de Aguinaga, 8", "Madrid, 28028", "Spain") must not leak into the name.
        expect(tpf?.firmNameRaw).toBe('TPF GETINSA EUROESTUDIOS S.L. *59');
        expect(tpf?.dateOfImpositionRaw).toBe('Feberuary 29, 2024 - November 28, 2027'); // the source's own typo, kept verbatim
        expect(tpf?.sanctionDocumentUrl).toBeNull();
        expect(tpf?.groundsRaw).toBe('Corrupt and Collusive Practices');
        expect(iqvia?.firmNameRaw).toBe('IQVIA Consulting and Information Services India *69');
        expect(iqvia?.sanctionImposedText).toBe('Conditional Non-debarmen'); // the source's truncation, kept verbatim
    });

    it('reports an extraction-integrity failure (never "zero sanctions") when the header row is not found', () => {
        const missing = parseOtherSanctionsHtml(fixture('worldBankOtherSanctionsMissing.html'));
        expect(missing.degraded).toBe(true);
        expect(missing.records).toHaveLength(0);
        expect(missing.degradedReason).toMatch(/header row was not found/i);
    });

    it('reports an extraction-integrity failure when the page has no table at all', () => {
        const none = parseOtherSanctionsHtml('<html><body><p>no tables here</p></body></html>');
        expect(none.degraded).toBe(true);
        expect(none.records).toHaveLength(0);
    });

    it('reports an extraction-integrity failure when the header matches but no data rows parse (SYNTHETIC)', () => {
        const headerOnly = parseOtherSanctionsHtml(syntheticPage([]));
        expect(headerOnly.degraded).toBe(true);
        expect(headerOnly.degradedReason).toMatch(/zero data rows/i);
    });

    it('skips rows with fewer than four cells or an empty name, and identifies the table by header text, not position (SYNTHETIC)', () => {
        const page = `<table><tr><td>unrelated</td></tr></table>${syntheticPage([
            ['<p><b>Real Firm *1</b></p>', 'Ongoing', 'Reprimand', 'Fraud'],
            ['<p></p>', 'Ongoing', 'Reprimand', 'Fraud'],
        ]).replace('<html><body>', '').replace('</body></html>', '')}`;
        const parsed = parseOtherSanctionsHtml(`<html><body>${page}<table><tr><td>short row table</td></tr></table></body></html>`);
        expect(parsed.degraded).toBe(false);
        expect(parsed.records.map((r) => r.firmNameRaw)).toEqual(['Real Firm *1']);
    });

    it('isOtherSanctionsHeader needs all four labels', () => {
        expect(isOtherSanctionsHeader('Name of Firm & Address Date of Imposition of Sanction Sanction Imposed Grounds')).toBe(true);
        expect(isOtherSanctionsHeader('Name of Firm & Address Date of Imposition of Sanction Sanction Imposed')).toBe(false);
    });
});

describe('normalisation', () => {
    const [armada, , tpf, iqvia] = parseOtherSanctionsHtml(html).records;

    it('keeps the legacy UMS vocabulary for an ongoing reprimand (no date -> null effective date, raw text in status)', () => {
        const { payload, cleanedName, referenceNumber } = normalizeOtherSanction(armada!);
        expect(cleanedName).toBe('OAO Armada');
        expect(referenceNumber).toBe('12');
        expect(payload).toEqual({
            event_type: 'SANCTION',
            source_url: WORLD_BANK_DEBARRED_FIRMS_URL,
            recipient_or_defendant_name: 'OAO Armada',
            entity_identifier_native: 'OAO Armada *12',
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: null,
            publish_date_iso: null,
            category_or_type: 'Letter of reprimand',
            status_or_estado: 'Ongoing',
            awarding_or_regulating_agency: 'World Bank',
            jurisdiction: 'WB',
            source_document_url: armada?.sanctionDocumentUrl,
            reference_number: '12',
            grounds: 'Sanctions Procedures, Section 9.04(a)',
        });
    });

    it('does not guess at the misspelled month "Feberuary" (null date, raw text preserved)', () => {
        const { payload } = normalizeOtherSanction(tpf!);
        expect(payload.effective_date_iso).toBeNull();
        expect(payload.status_or_estado).toBe('Feberuary 29, 2024 - November 28, 2027');
    });

    it('but parses the first date of a correctly spelled range, with an en dash', () => {
        const { payload } = normalizeOtherSanction(iqvia!);
        expect(payload.effective_date_iso).toBe('2025-06-17T00:00:00.000Z');
        expect(payload.reference_number).toBe('69');
    });

    it('parseWorldBankSanctionDate handles single dates, ranges, status words and garbage', () => {
        expect(parseWorldBankSanctionDate('March 3, 2021')?.toISOString()).toBe('2021-03-03T00:00:00.000Z');
        expect(parseWorldBankSanctionDate('January 5 2022 - January 4, 2025')?.toISOString()).toBe('2022-01-05T00:00:00.000Z');
        expect(parseWorldBankSanctionDate('Ongoing')).toBeNull();
        expect(parseWorldBankSanctionDate('Feberuary 29, 2024')).toBeNull();
        expect(parseWorldBankSanctionDate('')).toBeNull();
        expect(parseWorldBankSanctionDate(null)).toBeNull();
    });
});

describe('record ids', () => {
    const rows = parseOtherSanctionsHtml(html).records;

    it('matches the legacy id scheme (the legacy README documents "wb-sanction-oao-armada-ongoing")', () => {
        const records = toSourceRecords(rows);
        expect(records.map((r) => r.recordId)).toEqual([
            'wb-sanction-oao-armada-ongoing',
            'wb-sanction-pt-bumirejo-ongoing',
            'wb-sanction-tpf-getinsa-euroestudios-s-l-feberuary-29-2024-november-28-2027',
            'wb-sanction-iqvia-consulting-and-information-services-india-june-17-2025-december-16-2026',
        ]);
    });

    it('is stable across repeated parses of the same bytes', () => {
        const a = toSourceRecords(parseOtherSanctionsHtml(html).records).map((r) => [r.recordId, r.fingerprint]);
        const b = toSourceRecords(parseOtherSanctionsHtml(html).records).map((r) => [r.recordId, r.fingerprint]);
        expect(b).toEqual(a);
    });

    it('a firm name with no ASCII letters/digits gets a hash slug instead of colliding with every other such firm', () => {
        const a = sanctionRecordId('Компания Альфа', 'Ongoing');
        const b = sanctionRecordId('Компания Бета', 'Ongoing');
        expect(a).toMatch(/^wb-sanction-n[0-9a-f]{10}-ongoing$/);
        expect(b).toMatch(/^wb-sanction-n[0-9a-f]{10}-ongoing$/);
        expect(a).not.toBe(b);
        expect(sanctionRecordId('Компания Альфа', 'Ongoing')).toBe(a);
    });

    it('identical ids within one fetch are disambiguated in page order so the router cannot drop one', () => {
        expect(disambiguateIds(['a', 'b', 'a', 'a', 'b'])).toEqual(['a', 'b', 'a-2', 'a-3', 'b-2']);
        const twin = parseOtherSanctionsHtml(
            syntheticPage([
                ['<p><b>Twin Co *1</b></p>', 'Ongoing', 'Reprimand', 'Fraud'],
                ['<p><b>Twin Co *2</b></p>', 'Ongoing', 'Reprimand', 'Collusion'],
            ]),
        ).records;
        expect(toSourceRecords(twin).map((r) => r.recordId)).toEqual(['wb-sanction-twin-co-ongoing', 'wb-sanction-twin-co-ongoing-2']);
    });

    it('slugify strips diacritics and caps the length', () => {
        expect(slugify('Société Générale Ünïcode')).toBe('societe-generale-unicode');
        expect(slugify('x'.repeat(200))).toHaveLength(80);
    });
});

describe('fingerprints', () => {
    const base: [string, string, string, string] = ['<p><b>Acme Ltd *7</b></p>', 'Ongoing', '<a href="https://example.test/a.pdf">Letter of reprimand</a>', 'Fraud'];
    const fingerprintOfRow = (row: [string, string, string, string]) => toSourceRecords(parseOtherSanctionsHtml(syntheticPage([row])).records)[0]?.fingerprint;

    it('is identical for identical rows and changes when any consumer-visible column changes (SYNTHETIC rows)', () => {
        const original = fingerprintOfRow(base);
        expect(fingerprintOfRow([...base])).toBe(original);
        expect(fingerprintOfRow([base[0], 'January 5, 2026', base[2], base[3]])).not.toBe(original); // date
        expect(fingerprintOfRow([base[0], base[1], base[2].replace('Letter of reprimand', 'Debarment'), base[3]])).not.toBe(original); // sanction
        expect(fingerprintOfRow([base[0], base[1], base[2].replace('a.pdf', 'b.pdf'), base[3]])).not.toBe(original); // document url
        expect(fingerprintOfRow([base[0], base[1], base[2], 'Corruption'])).not.toBe(original); // grounds
        expect(fingerprintOfRow(['<p><b>Acme Ltd *8</b></p>', base[1], base[2], base[3]])).not.toBe(original); // footnote
    });

    it('is insensitive to insignificant whitespace in the markup', () => {
        const spaced: [string, string, string, string] = [' <p> <b>Acme   Ltd  *7</b> </p> ', '  Ongoing\n', base[2], ' Fraud '];
        expect(fingerprintOfRow(spaced)).toBe(fingerprintOfRow(base));
    });
});

describe('worldBankDebarredConnector.fetch', () => {
    it('is an active connector whose description states what it does NOT cover', () => {
        expect(worldBankDebarredConnector.id).toBe('world_bank_debarred');
        expect(worldBankDebarredConnector.engine).toBe('global-regtech-compliance-feed');
        expect(worldBankDebarredConnector.legacyActor).toBe('actor-20-mdb-procurement-monitor');
        expect(worldBankDebarredConnector.status).toBe('active');
        expect(worldBankDebarredConnector.requiredOptions).toBeUndefined(); // open static page, no credential
        expect(worldBankDebarredConnector.description).toMatch(/Other Sanctions/);
        expect(worldBankDebarredConnector.description).toMatch(/does NOT include the main debarment register/i);
    });

    it('returns one record per Other Sanctions row with watch text = the cleaned firm name', async () => {
        const { stub, result } = fetchRecords();
        const records = await result;
        expect(stub.calls).toEqual([WORLD_BANK_DEBARRED_FIRMS_URL]); // exactly one request, the documented page
        expect(records).toHaveLength(4);
        expect(records.map((r) => r.watchText)).toEqual([
            'OAO Armada',
            'PT. Bumirejo',
            'TPF GETINSA EUROESTUDIOS S.L.',
            'IQVIA Consulting and Information Services India',
        ]);
        expect(records[2]?.payload).toMatchObject({ jurisdiction: 'WB', category_or_type: 'Conditional Non-debarment', grounds: 'Corrupt and Collusive Practices' });
    });

    it('never sets a key the router owns', async () => {
        for (const record of await fetchRecords().result) {
            for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
        }
    });

    it('honours maxItemsPerSource', async () => {
        const two = await fetchRecords(html, { maxItemsPerSource: 2 }).result;
        expect(two.map((r) => r.recordId)).toEqual(['wb-sanction-oao-armada-ongoing', 'wb-sanction-pt-bumirejo-ongoing']);
        expect(await fetchRecords(html, { maxItemsPerSource: 1 }).result).toHaveLength(1);
    });

    describe('failure paths (SourceFetchError, isolated by the router)', () => {
        it('a download failure is a SourceFetchError tagged with the source', async () => {
            const stub = makeCtx({ [WORLD_BANK_DEBARRED_FIRMS_URL]: new Error('HTTP 503') });
            const error = await worldBankDebarredConnector.fetch(stub.ctx, {}, RUN).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(SourceFetchError);
            expect((error as SourceFetchError).source).toBe('world_bank_debarred');
            expect((error as SourceFetchError).message).toMatch(/download failed: HTTP 503/);
        });

        it('a page without the table is a SourceFetchError that points at the fallback PDF - not an empty result, not a billable placeholder row', async () => {
            const { result } = fetchRecords(fixture('worldBankOtherSanctionsMissing.html'));
            await expect(result).rejects.toBeInstanceOf(SourceFetchError);
            await expect(fetchRecords(fixture('worldBankOtherSanctionsMissing.html')).result).rejects.toThrow(NOTES_ON_DEBARRED_FIRMS_FALLBACK_URL);
            await expect(fetchRecords('<html><body>Service unavailable</body></html>').result).rejects.toThrow(/extraction degraded/);
        });
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-regtech-compliance-feed' as const, connectors: [worldBankDebarredConnector] };
    const resolve = (sourceOptions: Record<string, Record<string, unknown>>) =>
        resolveSources(engine, EngineInputSchema.parse({ sources: ['world_bank_debarred'], sourceOptions }));

    it('accepts no options and an empty options object', () => {
        expect(() => resolve({})).not.toThrow();
        expect(() => resolve({ world_bank_debarred: {} })).not.toThrow();
        expect(worldBankDebarredOptionsSchema.safeParse({}).success).toBe(true);
    });

    it.each([[{ countryFilter: ['KE'] }], [{ noticeTypeFilter: ['x'] }], [{ dateRange: '7d' }], [{ anything: 1 }]])(
        'rejects %j: options of the legacy Procurement Notices sub-source (or typos) fail loudly instead of being ignored',
        (options) => {
            expect(() => resolve({ world_bank_debarred: options })).toThrow(FatalConfigError);
            expect(() => resolve({ world_bank_debarred: options })).toThrow(/Unrecognized key/);
        },
    );

    it('has no BYOK credential, so there is no "missing credential" preflight failure to exercise', () => {
        expect(worldBankDebarredConnector.requiredOptions).toBeUndefined();
    });
});

describe('world_bank_debarred through the real router', () => {
    it('emits the four rows with envelope fields and bills a watchlist hit only for the matching firm', async () => {
        const { rows, billing, summary } = await runThroughRouter(
            worldBankDebarredConnector,
            { sources: ['world_bank_debarred'], watchlistNames: ['iqvia'] },
            makeCtx(routes),
        );
        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ engine: 'global-regtech-compliance-feed', source: 'world_bank_debarred', record_id: 'wb-sanction-oao-armada-ongoing', delta_status: 'first_seen' });
        expect(rows.filter((r) => r.is_watchlist_match).map((r) => r.recipient_or_defendant_name)).toEqual(['IQVIA Consulting and Information Services India']);
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
        expect(billing.totalFor(RESULT_EVENT)).toBe(4);
        expect(summary.sources[0]).toMatchObject({ fetched: 4, emitted: 4, watchlistHits: 1 });
    });

    it('the ghost-billing inputs produce no match and no watchlist-hit charge', async () => {
        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const { rows, billing } = await runThroughRouter(worldBankDebarredConnector, { sources: ['world_bank_debarred'], watchlistNames }, makeCtx(routes));
            expect(rows).toHaveLength(4);
            expect(rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('delta memory: an identical second run emits nothing; a changed Grounds cell emits exactly that row as updated', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(worldBankDebarredConnector, { sources: ['world_bank_debarred'] }, makeCtx(routes), store);
        const again = await runThroughRouter(worldBankDebarredConnector, { sources: ['world_bank_debarred'] }, makeCtx(routes), store);
        expect(again.rows).toHaveLength(0);

        const edited = html.replace('Fraudulent Practices', 'Fraudulent and Collusive Practices');
        expect(edited).not.toBe(html);
        const third = await runThroughRouter(worldBankDebarredConnector, { sources: ['world_bank_debarred'] }, makeCtx({ [WORLD_BANK_DEBARRED_FIRMS_URL]: edited }), store);
        expect(third.rows.map((r) => [r.recipient_or_defendant_name, r.delta_status, r.grounds])).toEqual([
            ['IQVIA Consulting and Information Services India', 'updated', 'Fraudulent and Collusive Practices'],
        ]);
    });

    it('a degraded page fails only this source and leaves delta memory untouched', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(worldBankDebarredConnector, { sources: ['world_bank_debarred'] }, makeCtx(routes), store);
        const before = store.peek();
        const broken = await runThroughRouter(
            worldBankDebarredConnector,
            { sources: ['world_bank_debarred'] },
            makeCtx({ [WORLD_BANK_DEBARRED_FIRMS_URL]: fixture('worldBankOtherSanctionsMissing.html') }),
            store,
        );
        expect(broken.rows).toHaveLength(0);
        expect(broken.summary.sources[0]?.error).toMatch(/extraction degraded/);
        expect(store.peek()).toEqual(before);
    });
});
