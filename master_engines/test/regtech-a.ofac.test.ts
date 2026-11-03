/**
 * ofac connector tests.
 *
 * Fixtures (all under test/fixtures/regtech-a/, no network):
 *   - sdn_sample.xml, un_consolidated_sample.xml: COPIED VERBATIM from the legacy actor
 *     (actor-19-maritime-sanctions-monitor/test/fixtures); real excerpts of the live feeds of 2026-09-07.
 *   - sdn_live_2026-10-21_excerpt.xml: real entries cut from the live SDN.XML downloaded in this port session.
 *   - Inline `syntheticSdn(...)` documents are SYNTHETIC (hand-built, structurally identical to the real
 *     feed). They exist only for cases no real entry can cover today - e.g. a vessel whose IMO is named by
 *     a UN record (independently verified: the live OFAC and UN lists share no IMO number right now).
 */
import { describe, expect, it } from 'vitest';

import {
    assertCompleteSdnFeed,
    buildUnImoIndex,
    extractAllLinkedTo,
    lookupUnMatches,
    matchesNameFilter,
    matchesProgramFilter,
    OFAC_DETAILS_BASE_URL,
    OFAC_SDN_XML_URL,
    ofacConnector,
    ofacOptionsSchema,
    parseSdnXml,
    toSourceRecord,
    UN_CONSOLIDATED_XML_URL,
    watchTextOf,
} from '../global-regtech-compliance-feed/connectors/ofac.js';
import { sanitizeKeywordList } from '../lib/_guards.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter, withRecordCount } from './regtech-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 500 };
const legacySdn = withRecordCount(fixture('sdn_sample.xml'), 4);
const liveExcerpt = withRecordCount(fixture('sdn_live_2026-10-21_excerpt.xml'), 5);
const unSample = fixture('un_consolidated_sample.xml');

/** SYNTHETIC SDN.XML: `vessels` become <sdnEntry> blocks shaped exactly like the real feed, with a consistent Record_Count. */
function syntheticSdn(
    vessels: Array<{ uid: string; name: string; programs: string[]; imo?: string; owner?: string; flag?: string }>,
    publishDate = '09/04/2026',
): string {
    const entries = vessels
        .map(
            (v) => `  <sdnEntry>
    <uid>${v.uid}</uid>
    <lastName>${v.name}</lastName>
    <sdnType>Vessel</sdnType>
    <programList>${v.programs.map((p) => `<program>${p}</program>`).join('')}</programList>
${v.imo ? `    <idList><id><uid>9${v.uid}</uid><idType>Vessel Registration Identification</idType><idNumber>IMO ${v.imo}</idNumber></id></idList>\n` : ''}    <vesselInfo>${v.flag ? `<vesselFlag>${v.flag}</vesselFlag>` : ''}${v.owner ? `<vesselOwner>${v.owner}</vesselOwner>` : ''}</vesselInfo>
  </sdnEntry>`,
        )
        .join('\n');
    return `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>${publishDate}</Publish_Date><Record_Count>${vessels.length}</Record_Count></publshInformation>
${entries}
</sdnList>`;
}

function fetchWith(sdnXml: string, options: Record<string, unknown> = {}, run: RunParams = RUN, unXml: string = unSample) {
    const stub = makeCtx({ [OFAC_SDN_XML_URL]: sdnXml, [UN_CONSOLIDATED_XML_URL]: unXml });
    const parsed = ofacConnector.optionsSchema.parse(options);
    return { stub, result: ofacConnector.fetch(stub.ctx, parsed, run) };
}

describe('parseSdnXml (legacy fixture, verbatim)', () => {
    const feed = parseSdnXml(fixture('sdn_sample.xml'));

    it('keeps only sdnType=Vessel entries and reports the structural counters', () => {
        expect(feed.totalEntryCount).toBe(4); // uid 36 is an Entity and is filtered out
        expect(feed.entries.map((e) => e.uid)).toEqual(['4238', '4243', '15036']);
        expect(feed.declaredRecordCount).toBe(19329); // the excerpt kept the live feed's full count
        expect(feed.publishDateRaw).toBe('09/04/2026');
    });

    it('parses a vessel with no idList at all (MAR AZUL)', () => {
        const mar = feed.entries.find((e) => e.uid === '4238');
        expect(mar).toMatchObject({
            vesselName: 'MAR AZUL',
            programs: ['CUBA'],
            imoNumber: null,
            mmsi: null,
            otherIds: [],
            callSign: 'CL2192',
            vesselType: 'Tug',
            vesselFlag: 'Cuba',
            vesselOwner: 'Samir de Navegacion S.A.',
            grossRegisteredTonnage: '212',
            tonnage: null,
        });
    });

    it('extracts the IMO from "IMO 7406784" and keeps both f.k.a. names (EBANO)', () => {
        const ebano = feed.entries.find((e) => e.uid === '4243');
        expect(ebano?.imoNumber).toBe('7406784');
        expect(ebano?.akaNames).toEqual([
            { type: 'f.k.a.', category: 'weak', name: 'ANA I' },
            { type: 'f.k.a.', category: 'weak', name: 'SAND SWAN' },
        ]);
        expect(ebano?.tonnage).toBe('2595');
    });

    it('splits identifiers: IMO, MMSI and everything else into otherIds; reads "Linked To" (ARTAVIL)', () => {
        const artavil = feed.entries.find((e) => e.uid === '15036');
        expect(artavil).toMatchObject({
            imoNumber: '9187629',
            mmsi: '572469210',
            linkedTo: 'NATIONAL IRANIAN TANKER COMPANY',
            vesselFlag: 'Iran',
            programs: ['IRAN'],
        });
        expect(artavil?.otherIds).toEqual([
            { idType: 'Former Vessel Flag', idNumber: 'Malta' },
            { idType: 'Additional Sanctions Information -', idNumber: 'Subject to Secondary Sanctions' },
        ]);
    });
});

describe('parseSdnXml (live excerpt of 2026-10-21)', () => {
    const feed = parseSdnXml(fixture('sdn_live_2026-10-21_excerpt.xml'));

    it('filters the Entity and keeps the four vessels in document order', () => {
        expect(feed.totalEntryCount).toBe(5);
        expect(feed.entries.map((e) => e.uid)).toEqual(['15055', '17104', '15904', '4238']);
        expect(feed.publishDateRaw).toBe('10/15/2026');
        expect(feed.declaredRecordCount).toBe(19457);
    });

    it('reads every program of a multi-program vessel and only the first "Linked To" into linkedTo (legacy semantics)', () => {
        const happiness = feed.entries.find((e) => e.uid === '15055');
        expect(happiness?.programs).toEqual(['IRAN', 'SDGT']);
        expect(happiness?.linkedTo).toBe('NATIONAL IRANIAN TANKER COMPANY');
        expect(happiness?.imoNumber).toBe('9212905');
        expect(happiness?.mmsi).toBe('256875000');
        expect(happiness?.akaNames.map((a) => a.name)).toEqual(['HENGAM', 'LOYAL', 'TULAR', 'HAPPINESS']);
        expect(happiness?.otherIds.filter((i) => i.idType === 'Former Vessel Flag').map((i) => i.idNumber)).toEqual(['Malta', 'Tuvalu', 'Tanzania', 'Panama']);
    });

    it('does NOT promote a bare 7-digit "Vessel Registration Identification" to an IMO (legacy behaviour kept)', () => {
        const ryong = feed.entries.find((e) => e.uid === '17104');
        expect(ryong?.imoNumber).toBeNull();
        expect(ryong?.otherIds).toContainEqual({ idType: 'Vessel Registration Identification', idNumber: '8606173' });
    });
});

describe('extractAllLinkedTo / watchTextOf', () => {
    it('returns every "Linked To" clause, in order, de-duplicated', () => {
        const remarks = '(Linked To: NATIONAL IRANIAN TANKER COMPANY; Linked To: HOKOUL SAL OFFSHORE)';
        expect(extractAllLinkedTo(remarks)).toEqual(['NATIONAL IRANIAN TANKER COMPANY', 'HOKOUL SAL OFFSHORE']);
        expect(extractAllLinkedTo('Linked To: A; Linked To: A')).toEqual(['A']);
        expect(extractAllLinkedTo(null)).toEqual([]);
        expect(extractAllLinkedTo('no clause here')).toEqual([]);
    });

    it('watch text is the vessel, its former names, its owner and all linked companies', () => {
        const feed = parseSdnXml(fixture('sdn_live_2026-10-21_excerpt.xml'));
        const happiness = feed.entries.find((e) => e.uid === '15055');
        const dino = feed.entries.find((e) => e.uid === '15904');
        expect(happiness && watchTextOf(happiness)).toBe(
            'HAPPINESS I | HENGAM | LOYAL | TULAR | HAPPINESS | NATIONAL IRANIAN TANKER COMPANY | HOKOUL SAL OFFSHORE',
        );
        expect(dino && watchTextOf(dino)).toContain('NITC');
    });
});

describe('assertCompleteSdnFeed (completeness guard)', () => {
    it('refuses a real excerpt whose declared Record_Count is far above the entries present', () => {
        expect(() => assertCompleteSdnFeed(parseSdnXml(fixture('sdn_sample.xml')))).toThrow(SourceFetchError);
        expect(() => assertCompleteSdnFeed(parseSdnXml(fixture('sdn_sample.xml')))).toThrow(/truncated.*19329.*only 4/);
    });

    it('refuses a 200 response that is not an SDN feed at all (bot-check page) instead of reporting "no vessels"', () => {
        const html = '<html><body>Access Denied - please verify you are not a robot</body></html>';
        expect(() => assertCompleteSdnFeed(parseSdnXml(html))).toThrow(/no <Record_Count>/);
    });

    it('accepts a consistent document, including a genuinely empty one (Record_Count 0, zero entries)', () => {
        expect(() => assertCompleteSdnFeed(parseSdnXml(legacySdn))).not.toThrow();
        const empty = `<?xml version="1.0" standalone="yes"?><sdnList xmlns="x"><publshInformation><Publish_Date>09/18/2026</Publish_Date><Record_Count>0</Record_Count></publshInformation></sdnList>`;
        expect(() => assertCompleteSdnFeed(parseSdnXml(empty))).not.toThrow();
    });
});

describe('UN Consolidated List IMO index', () => {
    it('indexes the IMO sentences of the real excerpt, per record', () => {
        const index = buildUnImoIndex(unSample);
        expect([...index.keys()].sort()).toEqual(['1790183', '5342883']);
        expect(index.get('1790183')).toEqual([
            { dataId: '6908046', name: 'OCEAN MARITIME MANAGEMENT COMPANY, LIMITED (OMM)', referenceNumber: 'KPe.020', listedOn: '2014-07-28' },
        ]);
        expect(index.get('5342883')?.[0]?.dataId).toBe('6908516');
    });

    it('lookupUnMatches returns [] (never null) for no IMO or an unknown IMO', () => {
        const index = buildUnImoIndex(unSample);
        expect(lookupUnMatches(null, index)).toEqual([]);
        expect(lookupUnMatches('9999999', index)).toEqual([]);
    });

    it('lists a UN record once even when its text mentions the same IMO twice (SYNTHETIC UN record)', () => {
        const xml = `<CONSOLIDATED_LIST><ENTITIES><ENTITY><DATAID>1</DATAID><FIRST_NAME>X</FIRST_NAME><COMMENTS1>IMO Number: 1234567. Vessel IMO number: 1234567.</COMMENTS1></ENTITY></ENTITIES></CONSOLIDATED_LIST>`;
        expect(buildUnImoIndex(xml).get('1234567')).toHaveLength(1);
    });
});

describe('keyword filters', () => {
    it('match case-insensitively on substrings', () => {
        expect(matchesProgramFilter(['RUSSIA-EO14024', 'SDGT'], sanitizeKeywordList(['russia']))).toBe(true);
        expect(matchesProgramFilter(['IRAN'], sanitizeKeywordList(['CUBA']))).toBe(false);
        expect(matchesNameFilter('ARTAVIL', sanitizeKeywordList(['tav']))).toBe(true);
    });

    it('an empty sanitised list means no filtering, never "match nothing"', () => {
        expect(matchesProgramFilter(['IRAN'], sanitizeKeywordList(['']))).toBe(true);
        expect(matchesNameFilter('ARTAVIL', sanitizeKeywordList(undefined))).toBe(true);
    });
});

describe('ofacConnector.fetch', () => {
    it('is an active connector of the regtech engine with no credential requirement', () => {
        expect(ofacConnector.id).toBe('ofac');
        expect(ofacConnector.engine).toBe('global-regtech-compliance-feed');
        expect(ofacConnector.legacyActor).toBe('actor-19-maritime-sanctions-monitor');
        expect(ofacConnector.status).toBe('active');
        expect(ofacConnector.requiredOptions).toBeUndefined(); // both feeds are open; there is no BYOK credential
    });

    it('turns the real legacy excerpt into records with the legacy field vocabulary and record ids', async () => {
        const { result } = fetchWith(legacySdn);
        const records = await result;
        expect(records.map((r) => r.recordId)).toEqual(['OFAC-SDN-4238', 'OFAC-SDN-4243', 'OFAC-SDN-15036']);

        const artavil = records.find((r) => r.recordId === 'OFAC-SDN-15036');
        expect(artavil?.payload).toMatchObject({
            uid: '15036',
            vesselName: 'ARTAVIL',
            sdnType: 'Vessel',
            programs: ['IRAN'],
            imoNumber: '9187629',
            mmsi: '572469210',
            vesselFlag: 'Iran',
            tonnage: '99144',
            grossRegisteredTonnage: '56068',
            linkedTo: 'NATIONAL IRANIAN TANKER COMPANY',
            crossReferencedInUnConsolidatedList: false,
            unConsolidatedListMatches: [],
            listPublishDateRaw: '09/04/2026',
            source_url: `${OFAC_DETAILS_BASE_URL}?id=15036`,
        });
        expect(artavil?.watchText).toBe('ARTAVIL | ABADAN | ALPHA | NATIONAL IRANIAN TANKER COMPANY');
    });

    it('never sets a key the router owns', async () => {
        for (const record of await fetchWith(legacySdn).result) {
            for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
        }
    });

    it('downloads the SDN feed and (by default) the UN list, with a timeout above the shared 30 s default', async () => {
        const { stub, result } = fetchWith(legacySdn);
        await result;
        expect(stub.calls).toEqual([OFAC_SDN_XML_URL, UN_CONSOLIDATED_XML_URL]);
        const timeouts = stub.inits.map((i) => (i as { timeoutMs?: number }).timeoutMs ?? 0);
        expect(timeouts.every((t) => t > 30_000)).toBe(true);
    });

    it('skips the UN download entirely when enrichWithUnConsolidatedList is false', async () => {
        const { stub, result } = fetchWith(legacySdn, { enrichWithUnConsolidatedList: false });
        await result;
        expect(stub.calls).toEqual([OFAC_SDN_XML_URL]);
    });

    describe('recordId stability and fingerprint change detection', () => {
        it('same upstream bytes -> identical ids and fingerprints on every run', async () => {
            const a = await fetchWith(legacySdn).result;
            const b = await fetchWith(legacySdn).result;
            expect(b.map((r) => [r.recordId, r.fingerprint])).toEqual(a.map((r) => [r.recordId, r.fingerprint]));
        });

        it('changes the fingerprint of exactly the vessel whose consumer-visible field changed', async () => {
            const before = await fetchWith(legacySdn).result;
            const edited = legacySdn.replace('<vesselFlag>Iran</vesselFlag>', '<vesselFlag>Panama</vesselFlag>');
            expect(edited).not.toBe(legacySdn);
            const after = await fetchWith(edited).result;
            const changed = after.filter((r, i) => r.fingerprint !== before[i]?.fingerprint).map((r) => r.recordId);
            expect(changed).toEqual(['OFAC-SDN-15036']);
            expect(after.map((r) => r.recordId)).toEqual(before.map((r) => r.recordId)); // id is unaffected
        });

        it('a newly added sanctions program changes the fingerprint; merely re-ordering programs does not', async () => {
            const original = syntheticSdn([{ uid: '1', name: 'ALPHA ONE', programs: ['IRAN', 'SDGT'], imo: '1111111' }]);
            const added = syntheticSdn([{ uid: '1', name: 'ALPHA ONE', programs: ['IRAN', 'SDGT', 'RUSSIA-EO14024'], imo: '1111111' }]);
            const reordered = syntheticSdn([{ uid: '1', name: 'ALPHA ONE', programs: ['SDGT', 'IRAN'], imo: '1111111' }]);
            const [fpOriginal] = (await fetchWith(original).result).map((r) => r.fingerprint);
            const [fpAdded] = (await fetchWith(added).result).map((r) => r.fingerprint);
            const [fpReordered] = (await fetchWith(reordered).result).map((r) => r.fingerprint);
            expect(fpAdded).not.toBe(fpOriginal);
            expect(fpReordered).toBe(fpOriginal);
        });

        it('a new list publish date alone does not re-fingerprint any vessel (feed-level value)', async () => {
            const a = await fetchWith(syntheticSdn([{ uid: '1', name: 'ALPHA ONE', programs: ['IRAN'] }], '09/04/2026')).result;
            const b = await fetchWith(syntheticSdn([{ uid: '1', name: 'ALPHA ONE', programs: ['IRAN'] }], '10/15/2026')).result;
            expect(b[0]?.fingerprint).toBe(a[0]?.fingerprint);
            expect(b[0]?.payload.listPublishDateRaw).toBe('10/15/2026'); // but the payload reflects it
        });
    });

    describe('UN cross-reference', () => {
        // SYNTHETIC vessel: IMO 5342883 is named by the real UN excerpt record 6908516.
        const sdn = syntheticSdn([
            { uid: '900', name: 'CHONG CHON GANG LOOKALIKE', programs: ['DPRK'], imo: '5342883' },
            { uid: '901', name: 'UNRELATED', programs: ['IRAN'], imo: '7777777' },
            { uid: '902', name: 'NO IMO AT ALL', programs: ['IRAN'] },
        ]);

        it('flags the vessel whose IMO the UN record names, and only that vessel', async () => {
            const records = await fetchWith(sdn).result;
            const byId = new Map(records.map((r) => [r.recordId, r.payload]));
            expect(byId.get('OFAC-SDN-900')).toMatchObject({
                crossReferencedInUnConsolidatedList: true,
                unConsolidatedListMatches: [{ dataId: '6908516', name: 'CHONGCHONGANG SHIPPING COMPANY', referenceNumber: 'KPe.022', listedOn: '2016-03-02' }],
            });
            expect(byId.get('OFAC-SDN-901')?.crossReferencedInUnConsolidatedList).toBe(false);
            expect(byId.get('OFAC-SDN-902')?.crossReferencedInUnConsolidatedList).toBe(false);
        });

        it('a UN match is consumer-visible, so enabling the cross-reference re-fingerprints the matched vessel only', async () => {
            const withUn = await fetchWith(sdn).result;
            const withoutUn = await fetchWith(sdn, { enrichWithUnConsolidatedList: false }).result;
            const changed = withUn.filter((r, i) => r.fingerprint !== withoutUn[i]?.fingerprint).map((r) => r.recordId);
            expect(changed).toEqual(['OFAC-SDN-900']);
        });
    });

    describe('filters', () => {
        it('programFilter selects by case-insensitive program substring', async () => {
            const records = await fetchWith(legacySdn, { programFilter: ['iran'] }).result;
            expect(records.map((r) => r.recordId)).toEqual(['OFAC-SDN-15036']);
        });

        it('programFilter accepts a pasted comma-separated string, never iterating it per character', async () => {
            const records = await fetchWith(legacySdn, { programFilter: 'IRAN, CUBA' }).result;
            expect(records).toHaveLength(3);
            const one = await fetchWith(legacySdn, { programFilter: 'CUBA' }).result;
            expect(one.map((r) => r.recordId)).toEqual(['OFAC-SDN-4238', 'OFAC-SDN-4243']);
        });

        it('vesselNameContains filters on the listed name, case-insensitively', async () => {
            const records = await fetchWith(legacySdn, { vesselNameContains: 'ebano' }).result;
            expect(records.map((r) => r.recordId)).toEqual(['OFAC-SDN-4243']);
        });

        it('vesselNameContains is not split on commas (a name may contain one)', async () => {
            const sdn = syntheticSdn([
                { uid: '1', name: 'ACME, LTD SHIPPER', programs: ['IRAN'] },
                { uid: '2', name: 'ACME SOLO', programs: ['IRAN'] },
            ]);
            const records = await fetchWith(sdn, { vesselNameContains: 'acme, ltd' }).result;
            expect(records.map((r) => r.recordId)).toEqual(['OFAC-SDN-1']);
        });

        it.each([[['']], [[' ']], [['a']], [['--']], [''], [[]]])(
            'a blank / too-short / punctuation-only programFilter (%j) filters NOTHING and is never a match-everything accident',
            async (programFilter) => {
                const { stub, result } = fetchWith(legacySdn, { programFilter });
                const records = await result;
                expect(records).toHaveLength(3);
                const suppliedSomething = Array.isArray(programFilter) ? programFilter.length > 0 : programFilter !== undefined;
                if (suppliedSomething && programFilter !== '') {
                    expect(stub.logs.warning.some((w) => w.includes('programFilter') && w.includes('NO programFilter filtering'))).toBe(true);
                }
            },
        );

        it('a blank vesselNameContains filters nothing and warns', async () => {
            const { stub, result } = fetchWith(legacySdn, { vesselNameContains: '   ' });
            expect(await result).toHaveLength(3);
            expect(stub.logs.warning.some((w) => w.includes('vesselNameContains'))).toBe(true);
        });
    });

    describe('maxItemsPerSource', () => {
        it('stops after the cap, in document order, counting only vessels that passed the filters', async () => {
            const two = await fetchWith(legacySdn, {}, { maxItemsPerSource: 2 }).result;
            expect(two.map((r) => r.recordId)).toEqual(['OFAC-SDN-4238', 'OFAC-SDN-4243']);
            const one = await fetchWith(legacySdn, { programFilter: ['iran'] }, { maxItemsPerSource: 1 }).result;
            expect(one.map((r) => r.recordId)).toEqual(['OFAC-SDN-15036']);
        });
    });

    describe('failure paths (SourceFetchError, isolated by the router)', () => {
        it('an SDN download failure becomes a SourceFetchError tagged with the source', async () => {
            const stub = makeCtx({ [OFAC_SDN_XML_URL]: new Error('HTTP 503 for the feed') });
            const error = await ofacConnector.fetch(stub.ctx, ofacConnector.optionsSchema.parse({}), RUN).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(SourceFetchError);
            expect((error as SourceFetchError).source).toBe('ofac');
            expect((error as SourceFetchError).message).toMatch(/OFAC SDN\.XML download failed: HTTP 503/);
        });

        it('a UN download failure fails the source rather than silently reporting "not cross-referenced"', async () => {
            const stub = makeCtx({ [OFAC_SDN_XML_URL]: legacySdn, [UN_CONSOLIDATED_XML_URL]: new Error('connection reset') });
            await expect(ofacConnector.fetch(stub.ctx, ofacConnector.optionsSchema.parse({}), RUN)).rejects.toThrow(/UN Consolidated List download failed: connection reset/);
            // ...and the operator can opt out of the enrichment instead.
            const optOut = makeCtx({ [OFAC_SDN_XML_URL]: legacySdn });
            await expect(ofacConnector.fetch(optOut.ctx, ofacConnector.optionsSchema.parse({ enrichWithUnConsolidatedList: false }), RUN)).resolves.toHaveLength(3);
        });

        it('a truncated or non-SDN 200 response is a SourceFetchError, not an empty result', async () => {
            const truncated = makeCtx({ [OFAC_SDN_XML_URL]: fixture('sdn_sample.xml') });
            await expect(ofacConnector.fetch(truncated.ctx, ofacConnector.optionsSchema.parse({ enrichWithUnConsolidatedList: false }), RUN)).rejects.toBeInstanceOf(SourceFetchError);
            const botPage = makeCtx({ [OFAC_SDN_XML_URL]: '<html>Access Denied</html>' });
            await expect(ofacConnector.fetch(botPage.ctx, ofacConnector.optionsSchema.parse({ enrichWithUnConsolidatedList: false }), RUN)).rejects.toThrow(/not a genuine SDN feed/);
        });
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-regtech-compliance-feed' as const, connectors: [ofacConnector] };
    const resolve = (sourceOptions: Record<string, Record<string, unknown>>) => resolveSources(engine, EngineInputSchema.parse({ sources: ['ofac'], sourceOptions }));

    it('applies the defaults', () => {
        const [resolved] = resolve({});
        expect(resolved?.options).toEqual({ enrichWithUnConsolidatedList: true });
    });

    it('accepts documented options', () => {
        expect(() => resolve({ ofac: { programFilter: ['IRAN'], vesselNameContains: 'x', enrichWithUnConsolidatedList: false } })).not.toThrow();
    });

    it.each([
        [{ programFilter: 5 }, /programFilter/],
        [{ programFilter: [1, 2] }, /programFilter/],
        [{ vesselNameContains: ['a'] }, /vesselNameContains/],
        [{ enrichWithUnConsolidatedList: 'yes' }, /enrichWithUnConsolidatedList/],
        [{ maxItems: 10 }, /Unrecognized key/], // a legacy-actor option: must fail loudly, not be ignored
    ])('rejects invalid options %j before any network call', (options, message) => {
        expect(() => resolve({ ofac: options })).toThrow(FatalConfigError);
        expect(() => resolve({ ofac: options })).toThrow(message);
    });

    it('has no BYOK credential, so there is no "missing credential" preflight failure to exercise', () => {
        expect(ofacOptionsSchema.safeParse({}).success).toBe(true);
        expect(() => resolve({})).not.toThrow();
    });
});

describe('ofac through the real router', () => {
    const sdn = syntheticSdn([
        { uid: '1', name: 'ALPHA ONE', programs: ['IRAN'], imo: '1111111', owner: 'ACME SHIPPING LLC' },
        { uid: '2', name: 'BRAVO TWO', programs: ['CUBA'], imo: '2222222' },
    ]);
    const routes = { [OFAC_SDN_XML_URL]: sdn, [UN_CONSOLIDATED_XML_URL]: unSample };

    it('emits records with router envelope fields and bills one watchlist hit per matching vessel', async () => {
        const stub = makeCtx(routes);
        const { rows, billing, summary } = await runThroughRouter(ofacConnector, { sources: ['ofac'], watchlistNames: ['acme shipping'] }, stub);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ engine: 'global-regtech-compliance-feed', source: 'ofac', record_id: 'OFAC-SDN-1', delta_status: 'first_seen', is_new: true });
        expect(rows.map((r) => r.is_watchlist_match)).toEqual([true, false]);
        expect(rows[0]?.matched_watchlist_keyword).toBe('acme shipping');
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
        expect(billing.totalFor(RESULT_EVENT)).toBe(2);
        expect(summary.sources[0]).toMatchObject({ source: 'ofac', fetched: 2, emitted: 2, watchlistHits: 1 });
    });

    it('the ghost-billing inputs ([""], [" "], "") produce no match and no watchlist-hit charge', async () => {
        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const { rows, billing } = await runThroughRouter(ofacConnector, { sources: ['ofac'], watchlistNames }, makeCtx(routes));
            expect(rows).toHaveLength(2);
            expect(rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('delta memory: a second identical run emits nothing under onlyChanged; an edit emits exactly that vessel as "updated"', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(ofacConnector, { sources: ['ofac'] }, makeCtx(routes), store);

        const again = await runThroughRouter(ofacConnector, { sources: ['ofac'] }, makeCtx(routes), store);
        expect(again.rows).toHaveLength(0);
        expect(again.summary.sources[0]).toMatchObject({ fetched: 2, unchanged: 2, emitted: 0 });

        const edited = syntheticSdn([
            { uid: '1', name: 'ALPHA ONE', programs: ['IRAN'], imo: '1111111', owner: 'ACME SHIPPING LLC', flag: 'Panama' },
            { uid: '2', name: 'BRAVO TWO', programs: ['CUBA'], imo: '2222222' },
        ]);
        const third = await runThroughRouter(ofacConnector, { sources: ['ofac'] }, makeCtx({ ...routes, [OFAC_SDN_XML_URL]: edited }), store);
        expect(third.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['OFAC-SDN-1', 'updated']]);
    });

    it('a failing OFAC source is isolated: the run still completes and reports the error', async () => {
        const stub = makeCtx({ [OFAC_SDN_XML_URL]: new Error('HTTP 500') });
        const { rows, summary } = await runThroughRouter(ofacConnector, { sources: ['ofac'] }, stub);
        expect(rows).toHaveLength(0);
        expect(summary.sources[0]?.error).toMatch(/OFAC SDN\.XML download failed/);
    });

    it('toSourceRecord exposes a stable record for a hand-built entry (unit)', () => {
        const record = toSourceRecord(
            {
                uid: '7',
                vesselName: 'X',
                sdnType: 'Vessel',
                programs: ['IRAN'],
                remarks: null,
                linkedTo: null,
                akaNames: [],
                imoNumber: null,
                mmsi: null,
                otherIds: [],
                callSign: null,
                vesselType: null,
                vesselFlag: null,
                tonnage: null,
                grossRegisteredTonnage: null,
                vesselOwner: null,
                listPublishDateRaw: '01/01/2026',
            },
            [],
        );
        expect(record.recordId).toBe('OFAC-SDN-7');
        expect(record.watchText).toBe('X');
    });
});
