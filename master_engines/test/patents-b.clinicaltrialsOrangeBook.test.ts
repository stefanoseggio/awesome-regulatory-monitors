/**
 * clinicaltrials_orange_book connector tests.
 *
 * Fixtures (test/fixtures/patents-b/, no network) are REAL upstream responses captured on 2026-10-21, each the answer to the
 * exact URL this connector's own builders produce (see patents-b.helpers.ts). The legacy actor
 * (actor-24-clinical-trials-delta-engine) is README-only, so there is no legacy test directory to copy fixtures from; the
 * live captures are the fixtures. Hand-built values are labelled SYNTHETIC where used.
 */
import { describe, expect, it } from 'vitest';

import {
    buildClinicalTrialsQueries,
    buildClinicalTrialsUrl,
    buildOrangeBookSearches,
    buildOrangeBookUrl,
    canonicalJson,
    chunkExpressions,
    CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID,
    clinicaltrialsOrangeBookConnector,
    clinicaltrialsOrangeBookOptionsSchema,
    fetchClinicalTrials,
    fetchOrangeBook,
    isOpenFdaNoMatches,
    isoFromCompactDate,
    MAX_EXPRESSION_CHARS,
    MAX_QUERIES_PER_SUB_SOURCE,
    normalizeClinicalTrial,
    normalizeOrangeBookProduct,
    openFdaAuthHeaders,
    orangeBookProductUrl,
    orangeBookQueryClause,
    orangeBookRecordId,
    parseClinicalTrialsPage,
    parseOrangeBookPage,
    quotePhrase,
    resolveSingleTerm,
    resolveTerms,
} from '../global-corporate-patent-intelligence/connectors/clinicaltrialsOrangeBook.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import {
    createEngineHarness,
    createStubHttp,
    fixture,
    fixtureJson,
    httpError,
    logsAt,
    makeCtx,
    must,
    ROUTER_OWNED_KEYS,
} from './patents-b.helpers.js';

const SOURCE_ID = CLINICALTRIALS_ORANGE_BOOK_SOURCE_ID;
const run = (maxItemsPerSource: number): RunParams => ({ maxItemsPerSource });
const parseOptions = (input: unknown = {}) => clinicaltrialsOrangeBookOptionsSchema.parse(input);

// ---- ClinicalTrials.gov captured requests ----------------------------------------------------------------------
const PFIZER_QUERY = must(buildClinicalTrialsQueries({ sponsors: ['Pfizer'], keywords: [] })[0]);
const CT_PAGE1_URL = buildClinicalTrialsUrl(PFIZER_QUERY, 3);
const CT_PAGE1 = fixtureJson('ct_page1.json');
const CT_PAGE2_URL = buildClinicalTrialsUrl(PFIZER_QUERY, 3, CT_PAGE1.nextPageToken);
const RITLECITINIB_URL = buildClinicalTrialsUrl(
    must(buildClinicalTrialsQueries({ sponsors: [], keywords: ['ritlecitinib'], updatedFrom: '2026-10-01' })[0]),
    3,
);

// ---- Orange Book captured requests -----------------------------------------------------------------------------
const obUrl = (search: string | undefined, limit: number, skip = 0) => buildOrangeBookUrl(search, limit, skip);
const LETAIRIS_URL = obUrl(buildOrangeBookSearches({ query: '22081', sponsors: [], keywords: [] })[0], 10);
const TECHNEGAS_URL = obUrl(buildOrangeBookSearches({ query: '022335', sponsors: [], keywords: [] })[0], 10);
const VIOCIN_URL = obUrl(buildOrangeBookSearches({ query: '061086', sponsors: [], keywords: [] })[0], 10);
const SAXAGLIPTIN_URL = obUrl(buildOrangeBookSearches({ query: 'saxagliptin', sponsors: [], keywords: [] })[0], 4);
const NEWEST_P1_URL = obUrl(undefined, 2, 0);
const NEWEST_P2_URL = obUrl(undefined, 2, 2);
const GILEAD_URL = obUrl(buildOrangeBookSearches({ sponsors: ['Gilead'], keywords: [] })[0], 3);
const NOMATCH_URL = obUrl(buildOrangeBookSearches({ sponsors: [], keywords: ['zzznopexyz'] })[0], 3);

const CT_STUDY_FIELDS =
    'NCTId%2CBriefTitle%2COverallStatus%2CLastUpdatePostDate%2CStatusVerifiedDate%2CLeadSponsorName%2CCollaborator%2CCondition%2CPhase%2CInterventionName';

describe('options schema', () => {
    it('defaults to ClinicalTrials.gov only, 100 pages, no key', () => {
        const options = parseOptions();
        expect(options.subSources).toEqual(['clinicaltrials']);
        expect(options.maxPages).toBe(100);
        expect(options.fdaApiKey).toBeUndefined();
        expect(options.sponsors).toBeUndefined();
        expect(options.keywords).toBeUndefined();
    });

    it('accepts the legacy `orangebook` spelling, normalises case/whitespace and de-duplicates', () => {
        expect(parseOptions({ subSources: [' OrangeBook ', 'orange_book', 'ClinicalTrials'] }).subSources).toEqual(['orange_book', 'clinicaltrials']);
    });

    it('rejects an unknown sub-source with a message naming the allowed values', () => {
        const result = clinicaltrialsOrangeBookOptionsSchema.safeParse({ subSources: ['orange_book_flatfile'] });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.success ? '' : result.error.issues)).toMatch(/clinicaltrials.*orange_book/);
    });

    it('rejects an empty sub-source list and unknown option keys (typos must not be silently ignored)', () => {
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ subSources: [] }).success).toBe(false);
        const typo = clinicaltrialsOrangeBookOptionsSchema.safeParse({ keyword: ['pfizer'] });
        expect(typo.success).toBe(false);
        // The legacy delivery knobs are router concerns now, and say so by being unknown here.
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ onlyChanged: true }).success).toBe(false);
    });

    it('validates the OPTIONAL BYOK openFDA key: blank / null are absent, a malformed key is rejected', () => {
        expect(parseOptions({ fdaApiKey: '' }).fdaApiKey).toBeUndefined();
        expect(parseOptions({ fdaApiKey: null }).fdaApiKey).toBeUndefined();
        expect(parseOptions({ fdaApiKey: '  abcdefgh12345678  ' }).fdaApiKey).toBe('abcdefgh12345678');
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ fdaApiKey: 'short' }).success).toBe(false);
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ fdaApiKey: 'has space inside key' }).success).toBe(false);
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ fdaApiKey: 'colon:inside-key-123' }).success).toBe(false);
    });

    it('bounds maxPages and updatedWithin', () => {
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ maxPages: 0 }).success).toBe(false);
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ maxPages: 101 }).success).toBe(false);
        expect(clinicaltrialsOrangeBookOptionsSchema.safeParse({ updatedWithin: '2w' }).success).toBe(false);
        expect(parseOptions({ updatedWithin: '7d', maxPages: null }).maxPages).toBe(100);
    });

    it('requires NO credential (fdaApiKey only raises the caller\'s own rate ceiling), and preflight accepts a bare selection', () => {
        expect(clinicaltrialsOrangeBookConnector.requiredOptions).toBeUndefined();
        expect(clinicaltrialsOrangeBookConnector.status).toBe('active');
        const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [clinicaltrialsOrangeBookConnector] };
        const input = EngineInputSchema.parse({ sources: [SOURCE_ID] });
        expect(resolveSources(engine, input)).toHaveLength(1);
    });

    it('reports an invalid slice at preflight, naming the source (FatalConfigError before any network call)', () => {
        const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [clinicaltrialsOrangeBookConnector] };
        const input = EngineInputSchema.parse({ sources: [SOURCE_ID], sourceOptions: { [SOURCE_ID]: { subSources: ['nope'] } } });
        expect(() => resolveSources(engine, input)).toThrow(FatalConfigError);
        expect(() => resolveSources(engine, input)).toThrow(/Invalid options for "clinicaltrials_orange_book"/);
    });

    it('is registered for the patent engine under the repository name of the legacy actor', () => {
        expect(clinicaltrialsOrangeBookConnector.engine).toBe('global-corporate-patent-intelligence');
        expect(clinicaltrialsOrangeBookConnector.legacyActor).toBe('actor-24-clinical-trials-delta-engine');
        expect(clinicaltrialsOrangeBookConnector.id).toBe('clinicaltrials_orange_book');
        expect(clinicaltrialsOrangeBookConnector.maxSeenIds).toBeGreaterThanOrEqual(10_000);
    });
});

describe('keyword guard (the second victim of the ghost-billing bug)', () => {
    it("['', ' ', 'a'] leaves NO keyword: no sponsor / term filter, and a warning says so", () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        expect(resolveTerms(ctx, 'sponsors', ['', ' ', 'a'])).toEqual([]);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/sponsors: 0 accepted, 3 rejected/);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/NO sponsors filtering is applied/);
        expect(buildClinicalTrialsQueries({ sponsors: [], keywords: [] })).toEqual([[]]);
        expect(buildOrangeBookSearches({ sponsors: [], keywords: [] })).toEqual([undefined]);
    });

    it("['  Pfizer  '] is normalised to 'Pfizer' (and a bare string is split on separators, never iterated per character)", () => {
        const { ctx } = makeCtx(createStubHttp({}).http);
        expect(resolveTerms(ctx, 'sponsors', ['  Pfizer  '])).toEqual(['Pfizer']);
        expect(resolveTerms(ctx, 'sponsors', 'Pfizer, Novartis ;  Roche\nGilead')).toEqual(['Pfizer', 'Novartis', 'Roche', 'Gilead']);
        expect(resolveTerms(ctx, 'sponsors', 'a')).toEqual([]);
        expect(resolveTerms(ctx, 'sponsors', '')).toEqual([]);
        expect(resolveTerms(ctx, 'sponsors', ['Pfizer', 'PFIZER', 'pfizer '])).toEqual(['Pfizer']);
    });

    it('a malformed container or non-string entries produce no keyword, never a throw', () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        expect(resolveTerms(ctx, 'keywords', 5)).toEqual([]);
        expect(resolveTerms(ctx, 'keywords', { a: 1 })).toEqual([]);
        expect(resolveTerms(ctx, 'keywords', [5, null, {}, ['x']])).toEqual([]);
        expect(resolveTerms(ctx, 'keywords', undefined)).toEqual([]);
        expect(resolveTerms(ctx, 'keywords', null)).toEqual([]);
        // undefined / null mean "not provided": no warning for them.
        expect(logsAt(logs, 'warning')).toHaveLength(3);
    });

    it('quote characters cannot survive into a phrase, and a keyword that is only quotes is dropped', () => {
        const { ctx, logs } = makeCtx(createStubHttp({}).http);
        // '"' and '""' are rejected by the guard itself; '"a"' passes it (3 characters) but is ONE character once the quotes go.
        expect(resolveTerms(ctx, 'sponsors', ['"', '""', '"a"', 'O"Brien', 'back\\slash'])).toEqual(['O Brien', 'back slash']);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/1 keyword\(s\) were empty after removing quote characters/);
        expect(quotePhrase('say "hi" \\ now')).toBe('"say hi now"');
    });

    it('single free-text filters (condition, orangeBookQuery) go through the same guard but keep an internal comma', () => {
        const { ctx } = makeCtx(createStubHttp({}).http);
        expect(resolveSingleTerm(ctx, 'condition', '  diabetes  ', false)).toBe('diabetes');
        expect(resolveSingleTerm(ctx, 'condition', 'Hypertension, Pulmonary', false)).toBe('Hypertension, Pulmonary');
        expect(resolveSingleTerm(ctx, 'condition', ' ', false)).toBeUndefined();
        expect(resolveSingleTerm(ctx, 'condition', 'a', false)).toBeUndefined();
        expect(resolveSingleTerm(ctx, 'condition', 7, false)).toBeUndefined();
        expect(resolveSingleTerm(ctx, 'condition', undefined, false)).toBeUndefined();
        expect(resolveSingleTerm(ctx, 'orangeBookQuery', 'x" OR products.brand_name:"y', true)).toBe('x OR products.brand_name: y');
    });

    it("connector.fetch with sponsors/keywords ['', ' ', 'a'] sends NO query.spons / query.term / search - on either sub-source", async () => {
        // Route-level replay of real captures: the point is the REQUEST the connector builds, not the response.
        const { http, calls } = createStubHttp({}, (url) => (url.startsWith('https://clinicaltrials.gov/') ? CT_PAGE1 : fixtureJson('ob_newest_p1.json')));
        const { ctx, logs } = makeCtx(http);
        const options = parseOptions({
            subSources: ['clinicaltrials', 'orange_book'],
            sponsors: ['', ' ', 'a'],
            keywords: ['', ' ', 'a'],
            condition: ' ',
            orangeBookQuery: 'a',
        });
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, options, run(6));
        // Exactly the requests of a run that supplied no filter at all.
        expect(calls.map((c) => c.url)).toEqual([buildClinicalTrialsUrl([], 3), obUrl(undefined, 3)]);
        for (const call of calls) expect(call.url).not.toMatch(/query\.spons|query\.term|query\.cond|search=/);
        expect(records.length).toBeGreaterThan(0);
        const warnings = logsAt(logs, 'warning').join('\n');
        for (const field of ['sponsors', 'keywords', 'condition', 'orangeBookQuery']) {
            expect(warnings).toContain(`NO ${field} filtering is applied`);
        }
    });

    it("sponsors ['  Pfizer  '] reach ClinicalTrials.gov as query.spons=\"Pfizer\" (the captured request)", async () => {
        const { http, calls } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ sponsors: ['  Pfizer  '] }), run(3));
        expect(calls.map((c) => c.url)).toEqual([CT_PAGE1_URL]);
        expect(CT_PAGE1_URL).toBe(
            `https://clinicaltrials.gov/api/v2/studies?query.spons=%22Pfizer%22&sort=LastUpdatePostDate%3Adesc&fields=${CT_STUDY_FIELDS}&pageSize=3&format=json`,
        );
        expect(records.map((r) => r.recordId)).toEqual(['NCT07475806', 'NCT07792941', 'NCT03672773']);
    });

    it('the keyword-less Orange Book walk is the plain newest-approvals query (no `search` clause at all)', () => {
        expect(NEWEST_P1_URL).toBe('https://api.fda.gov/drug/orangebook.json?sort=approval_date%3Adesc&limit=2');
        expect(NEWEST_P2_URL).toBe('https://api.fda.gov/drug/orangebook.json?sort=approval_date%3Adesc&limit=2&skip=2');
    });
});

describe('ClinicalTrials.gov parsing and normalisation (live captures)', () => {
    const page1 = parseClinicalTrialsPage(CT_PAGE1);
    const page2 = parseClinicalTrialsPage(fixtureJson('ct_page2.json'));
    const ritle = parseClinicalTrialsPage(fixtureJson('ct_kw_updated.json'));

    it('reads the legacy protocolSection.* paths for every study of a page', () => {
        expect(page1.studies).toHaveLength(3);
        expect(page1.skipped).toBe(0);
        expect(page1.nextPageToken).toBe(CT_PAGE1.nextPageToken);
        expect(page1.studies[0]).toEqual({
            nctId: 'NCT07475806',
            briefTitle: 'A Study to Find Out if Enfortumab Vedotin Given With Pembrolizumab Helps People With Muscle-invasive Bladder Cancer Keep Their Bladder',
            overallStatus: 'RECRUITING',
            lastUpdatePostDate: '2026-10-20',
            statusVerifiedDate: '2026-10',
            leadSponsor: 'Astellas Pharma Global Development, Inc.',
            collaborators: ['Pfizer'],
            conditions: ['Muscle-invasive Bladder Cancer'],
            phases: ['PHASE2'],
            interventions: ['Enfortumab Vedotin', 'Pembrolizumab'],
        });
        expect(page1.studies[2]?.collaborators).toEqual(['Translational Research in Oncology', 'Pfizer']);
        expect(page2.studies.map((s) => s.overallStatus)).toEqual(['ACTIVE_NOT_RECRUITING', 'RECRUITING', 'WITHDRAWN']);
    });

    it('treats a study with no `phases` key (observational) as an empty list, not a failure', () => {
        const observational = must(ritle.studies[2]);
        expect(observational.nctId).toBe('NCT07821216');
        expect(observational.phases).toEqual([]);
        expect(observational.collaborators).toEqual([]);
    });

    it('maps to the legacy dataset vocabulary and never sets a router-owned key', () => {
        const record = normalizeClinicalTrial(must(page1.studies[0]));
        expect(record.recordId).toBe('NCT07475806');
        expect(Object.keys(record.payload)).toEqual([
            'data_source',
            'source_url',
            'nct_id',
            'brief_title',
            'overall_status',
            'last_update_post_date',
            'status_verified_date',
            'lead_sponsor',
            'collaborators',
            'conditions',
            'phases',
            'interventions',
        ]);
        expect(record.payload.data_source).toBe('clinicaltrials-gov');
        expect(record.payload.source_url).toBe('https://clinicaltrials.gov/study/NCT07475806');
        expect(record.payload.nct_id).toBe('NCT07475806');
        for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
    });

    it('watchText = lead sponsor + collaborators + intervention (drug) names', () => {
        expect(normalizeClinicalTrial(must(page1.studies[0])).watchText).toBe('Astellas Pharma Global Development, Inc. | Pfizer | Enfortumab Vedotin | Pembrolizumab');
        expect(normalizeClinicalTrial(must(page1.studies[1])).watchText).toBe('Pfizer | tilrekimig and rHuPH20');
    });

    it('recordId is the NCT number and is stable across re-parsing and across runs', () => {
        const again = parseClinicalTrialsPage(JSON.parse(JSON.stringify(CT_PAGE1)));
        for (const [index, study] of page1.studies.entries()) {
            const a = normalizeClinicalTrial(study);
            const b = normalizeClinicalTrial(must(again.studies[index]));
            expect(a.recordId).toMatch(/^NCT\d{8}$/);
            expect(b.recordId).toBe(a.recordId);
            expect(b.fingerprint).toBe(a.fingerprint);
        }
    });

    it('fingerprint changes iff a consumer-visible field changes', () => {
        const base = must(page1.studies[0]);
        const baseFp = normalizeClinicalTrial(base).fingerprint;
        const variants = {
            overallStatus: { ...base, overallStatus: 'COMPLETED' },
            lastUpdate: { ...base, lastUpdatePostDate: '2026-10-21' },
            verified: { ...base, statusVerifiedDate: '2026-09' },
            title: { ...base, briefTitle: `${base.briefTitle} (amended)` },
            sponsor: { ...base, leadSponsor: 'Someone Else' },
            collaborators: { ...base, collaborators: [...base.collaborators, 'Merck'] },
            conditions: { ...base, conditions: [...base.conditions, 'Bladder Neoplasms'] },
            phases: { ...base, phases: ['PHASE2', 'PHASE3'] },
            interventions: { ...base, interventions: ['Enfortumab Vedotin'] },
        };
        for (const [name, variant] of Object.entries(variants)) {
            expect(normalizeClinicalTrial(variant).fingerprint, name).not.toBe(baseFp);
        }
        expect(normalizeClinicalTrial({ ...base }).fingerprint).toBe(baseFp);
        // Different studies never share a fingerprint.
        expect(new Set(page1.studies.map((s) => normalizeClinicalTrial(s).fingerprint)).size).toBe(3);
    });

    it('whitespace-only differences in the source text are not a change (SYNTHETIC mutation of a live capture)', () => {
        const mutated = JSON.parse(JSON.stringify(CT_PAGE1));
        mutated.studies[0].protocolSection.identificationModule.briefTitle = `  ${CT_PAGE1.studies[0].protocolSection.identificationModule.briefTitle.replace(/ /gu, '  ')}  `;
        const a = normalizeClinicalTrial(must(parseClinicalTrialsPage(CT_PAGE1).studies[0]));
        const b = normalizeClinicalTrial(must(parseClinicalTrialsPage(mutated).studies[0]));
        expect(b.fingerprint).toBe(a.fingerprint);
        expect(b.payload.brief_title).toBe(a.payload.brief_title);
    });

    it('skips a study without a usable NCT id (counted) and rejects a body that is not a studies page (SYNTHETIC bodies)', () => {
        const parsed = parseClinicalTrialsPage({
            studies: [{ protocolSection: { identificationModule: { nctId: 'not-an-nct', briefTitle: 'x' } } }, {}, ...CT_PAGE1.studies],
        });
        expect(parsed.skipped).toBe(2);
        expect(parsed.studies).toHaveLength(3);
        expect(() => parseClinicalTrialsPage({ error: 'nope' })).toThrow(/no "studies" array/);
        expect(() => parseClinicalTrialsPage('<html>')).toThrow(/no "studies" array/);
        expect(parseClinicalTrialsPage({ studies: [] })).toEqual({ studies: [], nextPageToken: null, skipped: 0 });
    });
});

describe('ClinicalTrials.gov query building', () => {
    it('quotes every sponsor / keyword and ORs them inside one expression', () => {
        const [query] = buildClinicalTrialsQueries({ sponsors: ['Pfizer', 'Eli Lilly and Company'], keywords: [] });
        expect(query).toEqual([['query.spons', '"Pfizer" OR "Eli Lilly and Company"']]);
    });

    it('treats sponsors and keywords as alternatives, and applies condition + updatedFrom to every series', () => {
        const queries = buildClinicalTrialsQueries({ condition: 'diabetes', sponsors: ['Pfizer'], keywords: ['metformin'], updatedFrom: '2026-10-14' });
        expect(queries).toEqual([
            [
                ['query.cond', 'diabetes'],
                ['query.spons', '"Pfizer"'],
                ['filter.advanced', 'AREA[LastUpdatePostDate]RANGE[2026-10-14,MAX]'],
            ],
            [
                ['query.cond', 'diabetes'],
                ['query.term', '"metformin"'],
                ['filter.advanced', 'AREA[LastUpdatePostDate]RANGE[2026-10-14,MAX]'],
            ],
        ]);
    });

    it('updatedWithin is resolved against ctx.now() (the injected clock)', async () => {
        const url = buildClinicalTrialsUrl(
            must(buildClinicalTrialsQueries({ sponsors: [], keywords: [], updatedFrom: '2026-10-14' })[0]),
            1,
        );
        const { http, calls } = createStubHttp({ [url]: { studies: [] } });
        const { ctx } = makeCtx(http); // FIXED_NOW = 2026-10-21T12:00Z -> 7d ago = 2026-10-14
        await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ updatedWithin: '7d' }), run(1));
        expect(calls[0]?.url).toBe(url);
        expect(url).toContain('filter.advanced=AREA%5BLastUpdatePostDate%5DRANGE%5B2026-10-14%2CMAX%5D');
    });

    it('splits a long list into several OR-chunks, each within the character budget, losing no term', () => {
        const terms = Array.from({ length: 80 }, (_, i) => `Sponsor Number ${i} Pharmaceuticals`);
        const chunks = chunkExpressions(terms.map(quotePhrase));
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_EXPRESSION_CHARS);
        expect(chunks.join(' OR ').split(' OR ')).toEqual(terms.map(quotePhrase));
    });

    it('fails the sub-source (not the process) when a list needs more than the query budget', async () => {
        const sponsors = Array.from({ length: 700 }, (_, i) => `Sponsor Number ${String(i).padStart(4, '0')} Pharmaceutical Holdings International Group Limited`);
        const { http, calls } = createStubHttp({});
        const { ctx } = makeCtx(http);
        // The guard keeps at most MAX_KEYWORDS=500 of the 700; 500 names of ~70 characters need ~28 chunks of 1500 characters, above the limit of 20.
        await expect(clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ sponsors }), run(10))).rejects.toThrow(
            new RegExp(`limit is ${MAX_QUERIES_PER_SUB_SOURCE}`),
        );
        expect(calls).toHaveLength(0);
    });
});

describe('ClinicalTrials.gov fetching', () => {
    it('walks pages with nextPageToken and stops at maxItems (captured pages 1 and 2)', async () => {
        const { http, calls } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1, [CT_PAGE2_URL]: fixtureJson('ct_page2.json') });
        const { ctx } = makeCtx(http);
        const studies = await fetchClinicalTrials(ctx, { maxItems: 6, queries: [PFIZER_QUERY], maxPages: 10, pageSize: 3 });
        expect(studies.map((s) => s.nctId)).toEqual(['NCT07475806', 'NCT07792941', 'NCT03672773', 'NCT04801589', 'NCT07629440', 'NCT04824937']);
        expect(calls.map((c) => c.url)).toEqual([CT_PAGE1_URL, CT_PAGE2_URL]);
        expect(CT_PAGE2_URL).toContain(`pageToken=${CT_PAGE1.nextPageToken}`);
    });

    it('honours maxItemsPerSource: stops paging once reached and asks for no more than is needed', async () => {
        const { http, calls } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ sponsors: ['Pfizer'] }), run(3));
        expect(records).toHaveLength(3);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toContain('pageSize=3');

        const one = createStubHttp({}, () => ({ ...CT_PAGE1, studies: CT_PAGE1.studies.slice(0, 1) }));
        const { ctx: ctx1 } = makeCtx(one.http);
        const capped = await clinicaltrialsOrangeBookConnector.fetch(ctx1, parseOptions({}), run(1));
        expect(capped).toHaveLength(1);
        expect(one.calls).toHaveLength(1);
        expect(one.calls[0]?.url).toContain('pageSize=1');
    });

    it('maxPages bounds the walk even when a nextPageToken is still on offer', async () => {
        const { http, calls } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1, [CT_PAGE2_URL]: fixtureJson('ct_page2.json') });
        const { ctx } = makeCtx(http);
        const studies = await fetchClinicalTrials(ctx, { maxItems: 100, queries: [PFIZER_QUERY], maxPages: 1, pageSize: 3 });
        expect(studies).toHaveLength(3);
        expect(calls).toHaveLength(1);
    });

    it('stops on an empty page that still offers a token (no infinite loop; SYNTHETIC page)', async () => {
        const { http, calls } = createStubHttp({}, () => ({ studies: [], nextPageToken: 'looping-token' }));
        const { ctx } = makeCtx(http);
        const studies = await fetchClinicalTrials(ctx, { maxItems: 50, queries: [[]], maxPages: 100 });
        expect(studies).toEqual([]);
        expect(calls).toHaveLength(1);
    });

    it('unions several query series, de-duplicates by NCT id and returns the most recently updated first', async () => {
        const sponsorQuery = must(buildClinicalTrialsQueries({ sponsors: ['Pfizer'], keywords: [] })[0]);
        const keywordQuery = must(buildClinicalTrialsQueries({ sponsors: [], keywords: ['ritlecitinib'] })[0]);
        const { http } = createStubHttp({
            [buildClinicalTrialsUrl(sponsorQuery, 6)]: CT_PAGE1,
            [buildClinicalTrialsUrl(keywordQuery, 6)]: fixtureJson('ct_kw_updated.json'),
        });
        const { ctx } = makeCtx(http);
        const studies = await fetchClinicalTrials(ctx, { maxItems: 6, queries: [sponsorQuery, keywordQuery], maxPages: 1 });
        expect(studies).toHaveLength(6);
        const dates = studies.map((s) => s.lastUpdatePostDate ?? '');
        expect([...dates].sort().reverse()).toEqual(dates);
        expect(new Set(studies.map((s) => s.nctId)).size).toBe(6);
    });

    it('surfaces an upstream HTTP failure as a SourceFetchError naming the source', async () => {
        const { http } = createStubHttp({ [CT_PAGE1_URL]: httpError(CT_PAGE1_URL, 503, 'upstream unavailable') });
        const { ctx, logs } = makeCtx(http);
        const failure = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ sponsors: ['Pfizer'] }), run(3)).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).source).toBe(SOURCE_ID);
        expect((failure as SourceFetchError).message).toMatch(/All selected sub-sources failed: clinicaltrials: HTTP 503/);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/clinicaltrials failed/);
    });

    it('a malformed 200 body (not a studies page) is a failure, never "zero trials"', async () => {
        const { http } = createStubHttp({}, () => ({ message: 'maintenance window' }));
        const { ctx } = makeCtx(http);
        await expect(clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({}), run(5))).rejects.toThrow(/no "studies" array/);
    });

    it('an unfiltered run is a legal request (newest updates first, no query.* at all)', () => {
        expect(buildClinicalTrialsUrl([], 100)).toBe(
            `https://clinicaltrials.gov/api/v2/studies?sort=LastUpdatePostDate%3Adesc&fields=${CT_STUDY_FIELDS}&pageSize=100&format=json`,
        );
    });
});

describe('Orange Book parsing and normalisation (live openFDA captures)', () => {
    const letairis = parseOrangeBookPage(fixtureJson('ob_letairis.json'));
    const technegas = parseOrangeBookPage(fixtureJson('ob_technegas.json'));
    const viocin = parseOrangeBookPage(fixtureJson('ob_viocin.json'));
    const saxagliptin = parseOrangeBookPage(fixtureJson('ob_saxagliptin.json'));
    const gilead = parseOrangeBookPage(fixtureJson('ob_gilead_kw.json'));

    it('reads one product per result with its patents and exclusivity (LETAIRIS, NDA 022081)', () => {
        expect(letairis.total).toBe(2);
        expect(letairis.resultCount).toBe(2);
        expect(letairis.products.map(orangeBookRecordId)).toEqual(['OB-N022081-001', 'OB-N022081-002']);
        const first = must(letairis.products[0]);
        expect(first.patents.map((p) => p.patent_number)).toEqual(['8377933', '9474752', '9549926']);
        expect(first.exclusivity).toEqual([]);
        expect(first.teCodes).toEqual(['AB']);
        expect(first.approvalDate).toBe('20070615');
        expect(first.referenceListedDrug).toBe(true);
        expect(first.referenceStandard).toBe(false);
        expect(must(letairis.products[1]).referenceStandard).toBe(true);
    });

    it('maps to the legacy Orange Book vocabulary (application_number, product_number, trade_name, ingredient, te_code, patent_data)', () => {
        const record = normalizeOrangeBookProduct(must(letairis.products[0]));
        expect(record.recordId).toBe('OB-N022081-001');
        expect(record.payload).toMatchObject({
            data_source: 'openfda-orangebook',
            application_type: 'N',
            application_number: '022081',
            product_number: '001',
            trade_name: 'LETAIRIS',
            ingredient: 'AMBRISENTAN',
            strength: '5MG',
            applicant: 'GILEAD',
            applicant_full_name: 'GILEAD SCIENCES INC',
            dosage_form: 'TABLET',
            route: 'ORAL',
            te_code: 'AB',
            marketing_status: 'HUMAN PRESCRIPTION DRUG',
            reference_listed_drug: true,
            reference_standard: false,
            approval_date: '2007-06-15',
            approved_prior_to_1982: false,
            patent_numbers: ['8377933', '9474752', '9549926'],
            latest_patent_expiry: '2031-10-14',
            exclusivity_codes: [],
            latest_exclusivity_expiry: null,
        });
        expect(record.payload.patent_data).toEqual({
            patents: [
                { expiration_date: '20271211', patent_number: '8377933', patent_submission_date: '20151023', patent_use_code: 'U-1754' },
                { expiration_date: '20271211', patent_number: '9474752', patent_submission_date: '20161123', patent_use_code: 'U-1754' },
                { expiration_date: '20311014', patent_number: '9549926', patent_submission_date: '20170216', patent_use_code: 'U-1965' },
            ],
            exclusivity: [],
        });
        for (const key of ROUTER_OWNED_KEYS) expect(record.payload).not.toHaveProperty(key);
    });

    it('carries exclusivity and boolean patent flags (TECHNEGAS KIT; BIXLENVO)', () => {
        const technegasRecord = normalizeOrangeBookProduct(must(technegas.products[0]));
        expect(technegasRecord.payload).toMatchObject({
            trade_name: 'TECHNEGAS KIT',
            te_code: null,
            patent_numbers: ['7722856'],
            latest_patent_expiry: '2031-02-24',
            exclusivity_codes: ['NP'],
            latest_exclusivity_expiry: '2026-09-29',
        });
        const bixlenvo = normalizeOrangeBookProduct(must(gilead.products[0]));
        expect(bixlenvo.payload.latest_patent_expiry).toBe('2038-08-16');
        expect(bixlenvo.payload.exclusivity_codes).toEqual(['NCE', 'NP']);
        const flagged = (bixlenvo.payload.patent_data as { patents: Array<Record<string, unknown>> }).patents.find((p) => p.patent_number === '10071985');
        expect(flagged).toMatchObject({ drug_substance_flag: true, drug_product_flag: true });
        // A "*PED" pediatric-extension patent number is kept verbatim (TYBOST).
        expect(normalizeOrangeBookProduct(must(gilead.products[2])).payload.patent_numbers).toContain('10039718*PED');
    });

    it('a pre-1982 product has no approval date and says so (VIOCIN SULFATE)', () => {
        const record = normalizeOrangeBookProduct(must(viocin.products[0]));
        expect(record.recordId).toBe('OB-A061086-002');
        expect(record.payload).toMatchObject({ approval_date: null, approved_prior_to_1982: true, te_code: null, marketing_status: 'DISCONTINUED' });
        expect(record.payload.patent_data).toEqual({ patents: [], exclusivity: [] });
        expect(record.payload.latest_patent_expiry).toBeNull();
    });

    it('joins several active ingredients (DAPAGLIFLOZIN + SAXAGLIPTIN HYDROCHLORIDE)', () => {
        const record = normalizeOrangeBookProduct(must(saxagliptin.products[0]));
        expect(record.payload.ingredient).toBe('DAPAGLIFLOZIN; SAXAGLIPTIN HYDROCHLORIDE');
        expect(record.payload.strength).toBe('10MG; EQ 5MG BASE');
    });

    it('watchText = applicant (short + full) + trade name + ingredient names', () => {
        expect(normalizeOrangeBookProduct(must(letairis.products[0])).watchText).toBe('GILEAD | GILEAD SCIENCES INC | LETAIRIS | AMBRISENTAN');
        expect(normalizeOrangeBookProduct(must(gilead.products[2])).watchText).toBe('GILEAD SCIENCES INC | TYBOST | COBICISTAT');
    });

    it('recordId is stable: type + application + product, identical across re-parses', () => {
        const again = parseOrangeBookPage(fixtureJson('ob_letairis.json'));
        expect(again.products.map(orangeBookRecordId)).toEqual(letairis.products.map(orangeBookRecordId));
        expect(normalizeOrangeBookProduct(must(again.products[0])).fingerprint).toBe(normalizeOrangeBookProduct(must(letairis.products[0])).fingerprint);
        // An NDA and an ANDA that share a number could never collide.
        expect(orangeBookRecordId({ applicationType: 'N', applicationNumber: '019915', productNumber: '004' })).not.toBe(
            orangeBookRecordId({ applicationType: 'A', applicationNumber: '019915', productNumber: '004' }),
        );
    });

    it('fingerprint ignores key order and array order of patent_data (recursive canonicalisation), but detects every real change', () => {
        const raw = fixtureJson('ob_gilead_kw.json');
        const base = normalizeOrangeBookProduct(must(parseOrangeBookPage(raw).products[0])).fingerprint;

        // SYNTHETIC re-ordering of a live capture: reverse every nested array and every object's key order.
        const reorder = (value: unknown): unknown => {
            if (Array.isArray(value)) return [...value].reverse().map(reorder);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reorder(v)]));
            }
            return value;
        };
        const reordered = reorder(raw) as { results: unknown[] };
        reordered.results = [...(reordered.results as unknown[])].reverse();
        const reorderedProducts = parseOrangeBookPage(reordered).products;
        const sameProduct = must(reorderedProducts.find((p) => orangeBookRecordId(p) === 'OB-N221104-001'));
        expect(normalizeOrangeBookProduct(sameProduct).fingerprint).toBe(base);

        // SYNTHETIC mutations: each is one real, consumer-visible change.
        const mutate = (edit: (result: any) => void): string => {
            const copy = JSON.parse(JSON.stringify(raw));
            edit(copy.results[0]);
            return normalizeOrangeBookProduct(must(parseOrangeBookPage(copy).products[0])).fingerprint;
        };
        const changed = [
            mutate((r) => (r.patents[0].expiration_date = '20380101')),
            mutate((r) => r.patents.push({ patent_number: '12345678', expiration_date: '20400101' })),
            mutate((r) => r.patents.pop()),
            mutate((r) => (r.exclusivity[0].exclusivity_expiration_date = '20301222')),
            mutate((r) => r.exclusivity.pop()),
            mutate((r) => (r.products[0].marketing_status = 'DISCONTINUED')),
            mutate((r) => (r.products[0].therapeutic_equivalence_codes = ['AB'])),
            mutate((r) => (r.patents[0].patent_delist_flag = true)),
        ];
        expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
    });

    it('canonicalJson sorts keys at every nesting level (a top-level-only sort would not)', () => {
        expect(canonicalJson({ b: { z: 1, a: [{ d: 1, c: 2 }] }, a: null })).toBe('{"a":null,"b":{"a":[{"c":2,"d":1}],"z":1}}');
        expect(canonicalJson({ x: 1, y: undefined })).toBe('{"x":1}');
    });

    it('isoFromCompactDate only accepts YYYYMMDD', () => {
        expect(isoFromCompactDate('20310224')).toBe('2031-02-24');
        expect(isoFromCompactDate('2031-02-24')).toBeNull();
        expect(isoFromCompactDate(undefined)).toBeNull();
        expect(isoFromCompactDate('Feb 24, 2031')).toBeNull();
    });

    it('rejects a body that is not an Orange Book page, and counts unusable results (SYNTHETIC bodies)', () => {
        expect(() => parseOrangeBookPage({ error: { code: 'NOT_FOUND' } })).toThrow(/no "results" array/);
        const parsed = parseOrangeBookPage({
            meta: { results: { total: 4 } },
            results: [{ product_number: '001', products: [] }, { products: [{ application_number: '1', application_type: 'N' }] }, 'junk', ...fixtureJson('ob_technegas.json').results],
        });
        expect(parsed.skipped).toBe(3);
        expect(parsed.products).toHaveLength(1);
        expect(parsed.resultCount).toBe(4);
    });

    it('orangeBookProductUrl is the openFDA query that returns exactly that product', () => {
        expect(orangeBookProductUrl({ applicationNumber: '022081', productNumber: '001' })).toBe(
            'https://api.fda.gov/drug/orangebook.json?search=products.application_number%3A%22022081%22%20AND%20product_number%3A%22001%22',
        );
    });
});

describe('Orange Book query building', () => {
    it('pads an application number to six digits and treats anything else as an ingredient name', () => {
        expect(orangeBookQueryClause('22081')).toBe('products.application_number:"022081"');
        expect(orangeBookQueryClause('022081')).toBe('products.application_number:"022081"');
        expect(orangeBookQueryClause('metformin')).toBe('products.active_ingredients.name:"metformin"');
        expect(orangeBookQueryClause('1234567')).toBe('products.active_ingredients.name:"1234567"');
    });

    it('sponsors match the applicant fields, keywords match brand and ingredient; the two are alternatives', () => {
        expect(buildOrangeBookSearches({ sponsors: ['Gilead', 'Pfizer'], keywords: ['ambrisentan'] })).toEqual([
            'products.application_name:"Gilead" OR products.application_full_name:"Gilead" OR products.application_name:"Pfizer" OR products.application_full_name:"Pfizer"',
            'products.brand_name:"ambrisentan" OR products.active_ingredients.name:"ambrisentan"',
        ]);
    });

    it('orangeBookQuery narrows every alternative with AND (verified live: parentheses and AND work)', () => {
        expect(buildOrangeBookSearches({ query: 'metformin', sponsors: ['Merck'], keywords: [] })).toEqual([
            'products.active_ingredients.name:"metformin" AND (products.application_name:"Merck" OR products.application_full_name:"Merck")',
        ]);
        expect(buildOrangeBookSearches({ query: '22081', sponsors: [], keywords: [] })).toEqual(['products.application_number:"022081"']);
    });

    it('a quote-injection attempt stays inside ONE inert phrase', () => {
        const { ctx } = makeCtx(createStubHttp({}).http);
        const query = resolveSingleTerm(ctx, 'orangeBookQuery', 'x" OR products.brand_name:"y', true);
        const [search] = buildOrangeBookSearches({ query, sponsors: [], keywords: [] });
        expect(search).toBe('products.active_ingredients.name:"x OR products.brand_name: y"');
        expect((search ?? '').match(/"/gu)).toHaveLength(2);
    });

    it('builds the captured request URLs exactly', () => {
        expect(LETAIRIS_URL).toBe('https://api.fda.gov/drug/orangebook.json?search=products.application_number%3A%22022081%22&sort=approval_date%3Adesc&limit=10');
        expect(GILEAD_URL).toBe(
            'https://api.fda.gov/drug/orangebook.json?search=products.application_name%3A%22Gilead%22%20OR%20products.application_full_name%3A%22Gilead%22&sort=approval_date%3Adesc&limit=3',
        );
    });

    it('sends the BYOK key as an HTTP Basic header only - never in a URL', async () => {
        expect(openFdaAuthHeaders(undefined)).toBeUndefined();
        expect(openFdaAuthHeaders('abcdefgh12345678')).toEqual({ authorization: `Basic ${Buffer.from('abcdefgh12345678:').toString('base64')}` });
        const { http, calls } = createStubHttp({ [LETAIRIS_URL]: fixtureJson('ob_letairis.json') });
        const { ctx } = makeCtx(http);
        await clinicaltrialsOrangeBookConnector.fetch(
            ctx,
            parseOptions({ subSources: ['orange_book'], orangeBookQuery: '22081', fdaApiKey: 'abcdefgh12345678' }),
            run(10),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).not.toContain('abcdefgh12345678');
        expect(calls[0]?.init?.headers?.authorization).toBe(`Basic ${Buffer.from('abcdefgh12345678:').toString('base64')}`);
    });

    it('sends no auth header when no key is configured', async () => {
        const { http, calls } = createStubHttp({ [LETAIRIS_URL]: fixtureJson('ob_letairis.json') });
        const { ctx } = makeCtx(http);
        await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], orangeBookQuery: '22081' }), run(10));
        expect(calls[0]?.init?.headers).toBeUndefined();
    });
});

describe('Orange Book fetching', () => {
    it('fetches a product by application number through the connector (captured request) and normalises it', async () => {
        const { http, calls } = createStubHttp({ [LETAIRIS_URL]: fixtureJson('ob_letairis.json') });
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], orangeBookQuery: ' 22081 ' }), run(10));
        expect(calls.map((c) => c.url)).toEqual([LETAIRIS_URL]);
        expect(records.map((r) => r.recordId)).toEqual(['OB-N022081-001', 'OB-N022081-002']);
    });

    it('fetches by ingredient and by applicant (captured requests)', async () => {
        const { http } = createStubHttp({ [SAXAGLIPTIN_URL]: fixtureJson('ob_saxagliptin.json'), [GILEAD_URL]: fixtureJson('ob_gilead_kw.json') });
        const { ctx } = makeCtx(http);
        const byIngredient = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], orangeBookQuery: 'saxagliptin' }), run(4));
        expect(byIngredient).toHaveLength(4);
        const bySponsor = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], sponsors: ['  Gilead '] }), run(3));
        expect(bySponsor.map((r) => r.payload.trade_name)).toEqual(['BIXLENVO', 'BIXLENVO SUNLENCA STARTER PACK (COPACKAGED)', 'TYBOST']);
    });

    it('pages with `skip` and stops at maxItems (captured newest-approval pages)', async () => {
        const { http, calls } = createStubHttp({ [NEWEST_P1_URL]: fixtureJson('ob_newest_p1.json'), [NEWEST_P2_URL]: fixtureJson('ob_newest_p2.json') });
        const { ctx } = makeCtx(http);
        const products = await fetchOrangeBook(ctx, { maxItems: 4, searches: [undefined], pageLimit: 2 });
        expect(products.map(orangeBookRecordId)).toEqual(['OB-A218248-001', 'OB-A219599-001', 'OB-A219599-002', 'OB-A219737-001']);
        expect(calls.map((c) => c.url)).toEqual([NEWEST_P1_URL, NEWEST_P2_URL]);
    });

    it('honours maxItemsPerSource: asks openFDA for exactly what is left and stops', async () => {
        const url = obUrl(undefined, 2);
        const { http, calls } = createStubHttp({ [url]: fixtureJson('ob_newest_p1.json') });
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'] }), run(2));
        expect(records).toHaveLength(2);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(url);
    });

    it('treats openFDA\'s 404 NOT_FOUND as an EMPTY result (captured error body), but any other 404 as a failure', async () => {
        const notFound = httpError(NOMATCH_URL, 404, fixture('ob_nomatch.json'));
        expect(isOpenFdaNoMatches(notFound)).toBe(true);
        expect(isOpenFdaNoMatches(httpError(NOMATCH_URL, 404, '<html>Not Found</html>'))).toBe(false);
        expect(isOpenFdaNoMatches(httpError(NOMATCH_URL, 500, fixture('ob_nomatch.json')))).toBe(false);
        expect(isOpenFdaNoMatches(new Error('boom'))).toBe(false);

        const { http } = createStubHttp({ [NOMATCH_URL]: notFound });
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], keywords: ['zzznopexyz'] }), run(3));
        expect(records).toEqual([]);

        const broken = createStubHttp({ [NOMATCH_URL]: httpError(NOMATCH_URL, 404, '<html>Not Found</html>') });
        const { ctx: brokenCtx } = makeCtx(broken.http);
        await expect(
            clinicaltrialsOrangeBookConnector.fetch(brokenCtx, parseOptions({ subSources: ['orange_book'], keywords: ['zzznopexyz'] }), run(3)),
        ).rejects.toBeInstanceOf(SourceFetchError);
    });

    it('surfaces an openFDA failure (rate limit after the shared client\'s retries) as a SourceFetchError', async () => {
        const { http } = createStubHttp({ [LETAIRIS_URL]: httpError(LETAIRIS_URL, 429, '{"error":{"code":"OVER_RATE_LIMIT"}}') });
        const { ctx } = makeCtx(http);
        const failure = await clinicaltrialsOrangeBookConnector
            .fetch(ctx, parseOptions({ subSources: ['orange_book'], orangeBookQuery: '22081' }), run(10))
            .catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).message).toMatch(/orange_book: HTTP 429/);
    });

    it('rejects a 200 body that is not an Orange Book page rather than reporting zero products', async () => {
        const { http } = createStubHttp({}, () => ({ meta: {}, nothing: true }));
        const { ctx } = makeCtx(http);
        await expect(clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'] }), run(5))).rejects.toThrow(/no "results" array/);
    });
});

describe('both sub-sources in one run', () => {
    // Route-level replay: real captured bodies are served for ANY clinicaltrials.gov / api.fda.gov URL, because these tests are about
    // budget sharing, merging and failure isolation, not about query semantics (those are pinned above).
    const replay = (url: string) => (url.startsWith('https://clinicaltrials.gov/') ? CT_PAGE1 : url.startsWith('https://api.fda.gov/') ? fixtureJson('ob_gilead_kw.json') : undefined);

    it('shares maxItemsPerSource evenly and returns both kinds of record, ids never colliding', async () => {
        const { http, calls } = createStubHttp({}, replay);
        const { ctx } = makeCtx(http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['clinicaltrials', 'orange_book'] }), run(6));
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url).toContain('pageSize=3');
        expect(calls[1]?.url).toContain('limit=3');
        expect(records.map((r) => r.payload.data_source)).toEqual([
            'clinicaltrials-gov',
            'clinicaltrials-gov',
            'clinicaltrials-gov',
            'openfda-orangebook',
            'openfda-orangebook',
            'openfda-orangebook',
        ]);
        expect(new Set(records.map((r) => r.recordId)).size).toBe(6);
    });

    it('hands an unused share forward and skips a sub-source with no share left', async () => {
        const one = createStubHttp({}, (url) => (url.startsWith('https://clinicaltrials.gov/') ? { studies: CT_PAGE1.studies.slice(0, 1) } : fixtureJson('ob_gilead_kw.json')));
        const { ctx } = makeCtx(one.http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['clinicaltrials', 'orange_book'] }), run(4));
        expect(records).toHaveLength(4); // 1 trial + 3 products: CT's unused share of 2 went to the Orange Book
        expect(one.calls[1]?.url).toContain('limit=3');

        const tiny = createStubHttp({}, replay);
        const { ctx: tinyCtx, logs } = makeCtx(tiny.http);
        const tinyRecords = await clinicaltrialsOrangeBookConnector.fetch(tinyCtx, parseOptions({ subSources: ['clinicaltrials', 'orange_book'] }), run(1));
        expect(tinyRecords).toHaveLength(1);
        expect(tiny.calls).toHaveLength(1);
        expect(logsAt(logs, 'info').join('\n')).toMatch(/orange_book: no share left/);
    });

    it('a failing sub-source does not discard the healthy one (warning logged); both failing is a SourceFetchError', async () => {
        const partial = createStubHttp({}, (url) => (url.startsWith('https://clinicaltrials.gov/') ? httpError(url, 500, 'ct down') : fixtureJson('ob_gilead_kw.json')));
        const { ctx, logs } = makeCtx(partial.http);
        const records = await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['clinicaltrials', 'orange_book'] }), run(6));
        expect(records.every((r) => r.payload.data_source === 'openfda-orangebook')).toBe(true);
        expect(records.length).toBeGreaterThan(0);
        expect(logsAt(logs, 'warning').join('\n')).toMatch(/clinicaltrials failed - HTTP 500/);

        const both = createStubHttp({}, (url) => httpError(url, 500, 'down'));
        const { ctx: bothCtx } = makeCtx(both.http);
        await expect(
            clinicaltrialsOrangeBookConnector.fetch(bothCtx, parseOptions({ subSources: ['clinicaltrials', 'orange_book'] }), run(6)),
        ).rejects.toThrow(/All selected sub-sources failed: clinicaltrials: HTTP 500.*\| orange_book: HTTP 500/);
    });

    it('options that only apply to the other sub-source are ignored with an info line, not an error', async () => {
        const { http } = createStubHttp({}, replay);
        const { ctx, logs } = makeCtx(http);
        await clinicaltrialsOrangeBookConnector.fetch(ctx, parseOptions({ subSources: ['orange_book'], condition: 'diabetes', updatedWithin: '7d' }), run(3));
        expect(logsAt(logs, 'info').join('\n')).toMatch(/condition \/ updatedWithin apply to ClinicalTrials.gov only/);
        const ct = makeCtx(createStubHttp({}, replay).http);
        await clinicaltrialsOrangeBookConnector.fetch(ct.ctx, parseOptions({ subSources: ['clinicaltrials'], orangeBookQuery: 'metformin' }), run(3));
        expect(logsAt(ct.logs, 'info').join('\n')).toMatch(/orangeBookQuery applies to the Orange Book only/);
    });
});

describe('through the router (billing and delta, FakeBilling + InMemoryDeltaStore)', () => {
    const baseInput = {
        sources: [SOURCE_ID],
        sourceOptions: { [SOURCE_ID]: { subSources: ['clinicaltrials'], sponsors: ['Pfizer'] } },
        maxItemsPerSource: 3,
    };

    it("watchlistNames ['', ' ', 'a'] bills ZERO watchlist-hit events and flags no row (every trial here would match 'a')", async () => {
        const { http } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
        const harness = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        const summary = await harness.run({ ...baseInput, watchlistNames: ['', ' ', 'a'] });
        expect(harness.rows).toHaveLength(3);
        expect(harness.rows.every((row) => row.is_watchlist_match === false && row.matched_watchlist_keyword === null)).toBe(true);
        expect(harness.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        expect(harness.billing.totalFor(RESULT_EVENT)).toBe(3);
        expect(summary.watchlist).toMatchObject({ accepted: 0, rejected: 3, hitsCharged: 0 });
    });

    it("watchlistNames [''] and a bare empty string are equally harmless", async () => {
        for (const watchlistNames of [[''], '', 'a', [' ', '\t']]) {
            const { http } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
            const harness = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
            await harness.run({ ...baseInput, watchlistNames });
            expect(harness.billing.totalFor(WATCHLIST_HIT_EVENT), JSON.stringify(watchlistNames)).toBe(0);
        }
    });

    it("watchlistNames ['  Pfizer  '] matches lead sponsor OR collaborator and bills exactly one hit per flagged row", async () => {
        const { http } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
        const harness = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        const summary = await harness.run({ ...baseInput, watchlistNames: ['  Pfizer  '] });
        expect(harness.rows.map((r) => r.matched_watchlist_keyword)).toEqual(['Pfizer', 'Pfizer', 'Pfizer']);
        expect(harness.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(3);
        expect(summary.watchlist.hitsCharged).toBe(3);

        const lead = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http: createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 }).http });
        await lead.run({ ...baseInput, watchlistNames: ['Astellas'] });
        expect(lead.rows.map((r) => r.is_watchlist_match)).toEqual([true, false, false]);
        expect(lead.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
    });

    it('a drug-name watch term matches through the intervention names', async () => {
        const { http } = createStubHttp({ [CT_PAGE1_URL]: CT_PAGE1 });
        const harness = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        await harness.run({ ...baseInput, watchlistNames: ['talazoparib'] });
        expect(harness.rows.map((r) => r.is_watchlist_match)).toEqual([false, false, true]);
    });

    it('delta memory: first run first_seen, repeat run emits nothing, a status change comes back as `updated` (SYNTHETIC status edit of a live capture)', async () => {
        const store = new InMemoryDeltaStore();
        let body: unknown = CT_PAGE1;
        const { http } = createStubHttp({ [CT_PAGE1_URL]: () => body as Record<string, unknown> });

        const first = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http, store });
        await first.run(baseInput);
        expect(first.rows.map((r) => r.delta_status)).toEqual(['first_seen', 'first_seen', 'first_seen']);
        expect(first.rows.map((r) => r.source)).toEqual([SOURCE_ID, SOURCE_ID, SOURCE_ID]);
        expect(first.rows.map((r) => r.record_id)).toEqual(['NCT07475806', 'NCT07792941', 'NCT03672773']);
        expect(first.rows[0]?.engine).toBe('global-corporate-patent-intelligence');

        const second = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http, store });
        await second.run(baseInput);
        expect(second.rows).toHaveLength(0);

        const edited = JSON.parse(JSON.stringify(CT_PAGE1));
        edited.studies[1].protocolSection.statusModule.overallStatus = 'COMPLETED';
        body = edited;
        const third = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http, store });
        await third.run(baseInput);
        expect(third.rows).toHaveLength(1);
        expect(third.rows[0]).toMatchObject({ record_id: 'NCT07792941', delta_status: 'updated', is_new: false, overall_status: 'COMPLETED' });
    });

    it('Orange Book rows flow through the router with watchlist matching on applicant and ingredient', async () => {
        const { http } = createStubHttp({ [LETAIRIS_URL]: fixtureJson('ob_letairis.json') });
        const input = {
            sources: [SOURCE_ID],
            sourceOptions: { [SOURCE_ID]: { subSources: ['orange_book'], orangeBookQuery: '22081' } },
            maxItemsPerSource: 10,
        };
        const hit = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        await hit.run({ ...input, watchlistNames: ['ambrisentan'] });
        expect(hit.rows).toHaveLength(2);
        expect(hit.rows.map((r) => r.record_id)).toEqual(['OB-N022081-001', 'OB-N022081-002']);
        expect(hit.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(2);

        const blank = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        await blank.run({ ...input, watchlistNames: ['', ' ', 'a'] });
        expect(blank.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        expect(blank.billing.totalFor(RESULT_EVENT)).toBe(2);
    });

    it('a failing connector never reaches billing: the run summary records the error and nothing is emitted', async () => {
        const { http } = createStubHttp({ [CT_PAGE1_URL]: httpError(CT_PAGE1_URL, 502, 'bad gateway') });
        const harness = createEngineHarness({ connectors: [clinicaltrialsOrangeBookConnector], http });
        const summary = await harness.run({ ...baseInput, watchlistNames: ['Pfizer'] });
        expect(harness.rows).toHaveLength(0);
        expect(summary.sources[0]?.error).toMatch(/All selected sub-sources failed/);
        expect(harness.billing.calls).toHaveLength(0);
    });
});
