/**
 * sec_enforcement connector tests. No network. The RSS items come from `regtech-b.secFixtures.ts`, which holds
 * byte-exact items copied from LIVE captures of SEC's feeds (2026-10-21). The few SYNTHETIC inputs are labelled.
 */
import { describe, expect, it } from 'vitest';

import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { FatalConfigError, SourceFetchError } from '../lib/types.js';
import {
    cleanFeedText,
    parseRfc822Date,
    parseSecRss,
    SEC_DEFAULT_USER_AGENT,
    secEnforcementConnector,
    secEnforcementOptionsSchema,
    splitRespondents,
    toSecRecord,
} from '../global-regtech-compliance-feed/connectors/secEnforcement.js';
import {
    buildAdminRss,
    buildLitigationRss,
    createStubHttp,
    httpError,
    makeCtx,
    must,
    ROUTER_OWNED_KEYS,
    SEC_ADMIN_URL,
    SEC_LITIGATION_URL,
    syntheticLitigationItem,
} from './regtech-b.helpers.js';
import { LIVE_LITIGATION_ITEMS } from './regtech-b.secFixtures.js';

const RUN = { maxItemsPerSource: 500 };
const defaults = secEnforcementOptionsSchema.parse({});

describe('parseSecRss (live-captured litigation feed)', () => {
    const items = parseSecRss(buildLitigationRss(), 'litigation_releases');

    it('parses every item with the live shape', () => {
        expect(items.map((i) => i.releaseNumber)).toEqual(['LR-26676', 'LR-26675', 'LR-26673', 'LR-26654']);
        const first = must(items[0]);
        expect(first.releaseType).toBe('litigation_release');
        expect(first.sourceUrl).toBe('https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26676');
        expect(first.feedTitle).toBe('Siddhi Patel, as Administrator of the Estate of Chirayu Vijay Patel (Deceased)');
    });

    it('trims the trailing newline that SEC puts inside <link> and <title>', () => {
        for (const item of items) {
            expect(item.sourceUrl).not.toMatch(/\s/u);
            expect(item.feedTitle).toBe(item.feedTitle.trim());
        }
        // LR-26654's live <title> ends with "\n" and differs from its <description>.
        expect(must(items[3]).feedTitle).toBe('Cryptoaiml Ltd.; Cryptoaiml Capital Foundation; TSAI Pro Ltd.; TSAI Capital Foundation');
    });

    it('keeps the calendar date in the feed offset and the UTC instant separately', () => {
        const first = must(items[0]);
        expect(first.releaseDate).toBe('2026-10-20');
        expect(first.publishedAt).toBe('2026-10-20T18:55:51.000Z');
    });

    it('rejects a body that is not RSS (for example an HTML block page) instead of returning zero items', () => {
        expect(() => parseSecRss('<html><body>Request Rate Threshold Exceeded</body></html>', 'litigation_releases')).toThrow(/not an RSS document/u);
    });

    it('treats a valid RSS document with no items as an empty result, not an error', () => {
        const empty = buildLitigationRss([]);
        expect(parseSecRss(empty, 'litigation_releases')).toEqual([]);
    });

    it('decodes XML entities (SYNTHETIC input; the live window contained none)', () => {
        const xml = buildLitigationRss([syntheticLitigationItem({ number: 'LR-90001', title: 'Smith &amp; Jones LLC' })]);
        expect(must(parseSecRss(xml, 'litigation_releases')[0]).feedTitle).toBe('Smith & Jones LLC');
    });

    it('skips an item that has neither dc:creator nor a link it can derive a release number from', () => {
        const noId = '<item><title>Nameless</title><link>https://example.org/x</link><pubDate>Mon, 19 Oct 2026 09:00:00 -0400</pubDate></item>';
        expect(parseSecRss(buildLitigationRss([noId]), 'litigation_releases')).toEqual([]);
    });

    it('derives the release number from the link when dc:creator is missing (patterns seen live only)', () => {
        const lit = '<item><title>Derived Person</title><link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26000\n</link><pubDate>Mon, 19 Oct 2026 09:00:00 -0400</pubDate></item>';
        expect(must(parseSecRss(buildLitigationRss([lit]), 'litigation_releases')[0]).releaseNumber).toBe('LR-26000');
        const adm = '<item><title>Derived Admin</title><link>https://www.sec.gov/files/litigation/admin/2026/ia-7000.pdf\n</link><pubDate>Mon, 19 Oct 2026 09:00:00 -0400</pubDate></item>';
        expect(must(parseSecRss(buildAdminRss([adm]), 'administrative_proceedings')[0]).releaseNumber).toBe('IA-7000');
    });

    it('never emits an off-site link', () => {
        const offsite = '<item><title>Off Site</title><link>https://evil.example.org/lr-1</link><dc:creator>LR-1</dc:creator><pubDate>Mon, 19 Oct 2026 09:00:00 -0400</pubDate></item>';
        expect(must(parseSecRss(buildLitigationRss([offsite]), 'litigation_releases')[0]).sourceUrl).toBeNull();
        const insecure = '<item><title>Plain Http</title><link>http://www.sec.gov/lr-2</link><dc:creator>LR-2</dc:creator><pubDate>Mon, 19 Oct 2026 09:00:00 -0400</pubDate></item>';
        expect(must(parseSecRss(buildLitigationRss([insecure]), 'litigation_releases')[0]).sourceUrl).toBeNull();
    });
});

describe('parseSecRss (live-captured administrative-proceedings feed)', () => {
    const items = parseSecRss(buildAdminRss(), 'administrative_proceedings');

    it('parses PDF links and non-LR release numbers', () => {
        expect(items.map((i) => i.releaseNumber)).toEqual(['IA-7027', '34-106673', '34-106633', 'IA-7021', '34-106569']);
        const first = must(items[0]);
        expect(first.releaseType).toBe('administrative_proceeding');
        expect(first.sourceUrl).toBe('https://www.sec.gov/files/litigation/admin/2026/ia-7027.pdf');
        expect(first.releaseDate).toBe('2026-10-15');
    });
});

describe('parseRfc822Date', () => {
    it('handles numeric offsets, zone names and day roll-over (SYNTHETIC inputs to a pure function)', () => {
        expect(parseRfc822Date('Thu, 15 Oct 2026 22:30:00 -0400')).toEqual({ releaseDate: '2026-10-15', publishedAt: '2026-10-16T02:30:00.000Z' });
        expect(parseRfc822Date('Thu, 15 Oct 2026 08:00:00 GMT')).toEqual({ releaseDate: '2026-10-15', publishedAt: '2026-10-15T08:00:00.000Z' });
        expect(parseRfc822Date('15 Oct 2026 08:00 EST')).toEqual({ releaseDate: '2026-10-15', publishedAt: '2026-10-15T13:00:00.000Z' });
    });

    it('returns null, never a guess, for malformed or impossible dates', () => {
        expect(parseRfc822Date('garbage')).toBeNull();
        expect(parseRfc822Date('')).toBeNull();
        expect(parseRfc822Date(undefined)).toBeNull();
        expect(parseRfc822Date('31 Feb 2026 10:00:00 +0000')).toBeNull();
        expect(parseRfc822Date('15 Oct 2026 25:00:00 +0000')).toBeNull();
        expect(parseRfc822Date('15 Oct 2026 10:00:00 XYZ')).toBeNull();
    });
});

describe('splitRespondents (titles taken from the live feeds)', () => {
    const cases: Array<[string, string[]]> = [
        ['Nihat Cardak', ['Nihat Cardak']],
        ['Terrance P. Berland and David Michael Scalzo', ['Terrance P. Berland', 'David Michael Scalzo']],
        ['Trevon Brown, Craig Grant, and Michael Noble', ['Trevon Brown', 'Craig Grant', 'Michael Noble']],
        ['Matthew Brown and Matthew Brown Companies, LLC', ['Matthew Brown', 'Matthew Brown Companies, LLC']],
        ['CityVest Capital Inc., CV Manager LLC, and Alan P. Donenfeld', ['CityVest Capital Inc.', 'CV Manager LLC', 'Alan P. Donenfeld']],
        ['Carlos Lopez, CPA', ['Carlos Lopez, CPA']],
        ['Silver Star Properties REIT, Inc.', ['Silver Star Properties REIT, Inc.']],
        ['Thomas J. Moore, III', ['Thomas J. Moore, III']],
        ['J.P. Morgan Securities LLC And JPMorgan Chase Bank, N.A.', ['J.P. Morgan Securities LLC', 'JPMorgan Chase Bank, N.A.']],
        ['Raymond Lawrence Lent (Dba the Putney Financial Group and Registered Investment Advisors)', ['Raymond Lawrence Lent (Dba the Putney Financial Group and Registered Investment Advisors)']],
        [
            'Siddhi Patel, as Administrator of the Estate of Chirayu Vijay Patel (Deceased) ',
            ['Siddhi Patel, as Administrator of the Estate of Chirayu Vijay Patel (Deceased)'],
        ],
        ['David Reichman et al.', ['David Reichman']],
        [
            'Christopher Kenji Dinelli a/k/a Kenji Dinelli and Jacob David Frankel a/k/a Kobi Frankel',
            ['Christopher Kenji Dinelli a/k/a Kenji Dinelli', 'Jacob David Frankel a/k/a Kobi Frankel'],
        ],
        [
            'Timothy E. Alatorre, Rhonda D. Stevenson, and Above: Space Development Corporation f/k/a Orbital Assembly Corporation',
            ['Timothy E. Alatorre', 'Rhonda D. Stevenson', 'Above: Space Development Corporation f/k/a Orbital Assembly Corporation'],
        ],
        [
            'Cryptoaiml Ltd.; Cryptoaiml Capital Foundation; TSAI Pro Ltd.; TSAI Capital Foundation\n',
            ['Cryptoaiml Ltd.', 'Cryptoaiml Capital Foundation', 'TSAI Pro Ltd.', 'TSAI Capital Foundation'],
        ],
    ];
    it.each(cases)('splits %j', (title, expected) => {
        expect(splitRespondents(title)).toEqual(expected);
    });

    it('handles the nine-respondent semicolon list and drops the leading "and"', () => {
        const names = splitRespondents(
            'Francis Biller; Raymond Dove; Chester Alvarez; Troy Gran-Brooks; Justin Plaizier; Shredderz International Corp.; Edward Clarke; Lia Patricia Sepulveda Salazar; and Edward Lopez Giraldo',
        );
        expect(names).toHaveLength(9);
        expect(names[5]).toBe('Shredderz International Corp.');
        expect(names[8]).toBe('Edward Lopez Giraldo');
    });

    it('returns an empty list for an empty or whitespace-only title and de-duplicates repeats', () => {
        expect(splitRespondents('')).toEqual([]);
        expect(splitRespondents('   \n ')).toEqual([]);
        expect(splitRespondents('Acme Corp; ACME CORP; Bolt Ltd')).toEqual(['Acme Corp', 'Bolt Ltd']);
    });

    it('cleanFeedText collapses whitespace', () => {
        expect(cleanFeedText('  a \n  b\t c ')).toBe('a b c');
        expect(cleanFeedText(undefined)).toBe('');
    });
});

describe('toSecRecord', () => {
    const items = parseSecRss(buildLitigationRss(), 'litigation_releases');

    it('uses the SEC release number as the stable recordId and the whole cleaned title as watchText', () => {
        const record = toSecRecord(must(items[2]));
        expect(record.recordId).toBe('LR-26673');
        expect(record.watchText).toBe('Matthew Brown and Matthew Brown Companies, LLC');
        expect(record.payload).toMatchObject({
            release_type: 'litigation_release',
            release_number: 'LR-26673',
            release_date: '2026-10-13',
            primary_respondent: 'Matthew Brown',
            respondents: ['Matthew Brown', 'Matthew Brown Companies, LLC'],
            source_url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26673',
        });
    });

    it('never sets router-owned fields and never emits fields it did not extract', () => {
        const payload = toSecRecord(must(items[0])).payload;
        for (const key of ROUTER_OWNED_KEYS) expect(payload).not.toHaveProperty(key);
        for (const key of ['statutes_or_rules_cited', 'monetary_sanctions', 'sanction_status', 'linked_edgar_cik', 'summary_text', 'court_or_forum']) {
            expect(payload).not.toHaveProperty(key);
        }
    });

    it('has a stable recordId and fingerprint across parses and across item order', () => {
        const again = parseSecRss(buildLitigationRss(), 'litigation_releases').map(toSecRecord);
        expect(again.map((r) => r.recordId)).toEqual(items.map((i) => toSecRecord(i).recordId));
        expect(again.map((r) => r.fingerprint)).toEqual(items.map((i) => toSecRecord(i).fingerprint));

        const reversed = parseSecRss(buildLitigationRss([...LIVE_LITIGATION_ITEMS].reverse()), 'litigation_releases').map(toSecRecord);
        const idToFingerprint = (records: Array<{ recordId: string; fingerprint: string }>) => new Map(records.map((r) => [r.recordId, r.fingerprint]));
        expect(idToFingerprint(reversed)).toEqual(idToFingerprint(again));
    });

    it('changes the fingerprint (not the recordId) when a consumer-visible field changes', () => {
        const base = toSecRecord(must(items[1]));
        const retitled = toSecRecord({ ...must(items[1]), feedTitle: 'Terrance P. Berland, David Michael Scalzo and Acme LLC' });
        const redated = toSecRecord({ ...must(items[1]), publishedAt: '2026-10-21T10:00:00.000Z' });
        const relinked = toSecRecord({ ...must(items[1]), sourceUrl: 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26675-corrected' });
        for (const changed of [retitled, redated, relinked]) {
            expect(changed.recordId).toBe(base.recordId);
            expect(changed.fingerprint).not.toBe(base.fingerprint);
        }
        expect(toSecRecord(must(items[1])).fingerprint).toBe(base.fingerprint);
    });
});

describe('secEnforcementOptionsSchema', () => {
    it('defaults to both feeds and the legacy User-Agent', () => {
        expect(defaults.sources).toEqual(['litigation_releases', 'administrative_proceedings']);
        expect(defaults.userAgent).toBe(SEC_DEFAULT_USER_AGENT);
    });

    it('rejects unknown feeds, an empty source list and an unusable User-Agent', () => {
        expect(secEnforcementOptionsSchema.safeParse({ sources: ['edgar_filings'] }).success).toBe(false);
        expect(secEnforcementOptionsSchema.safeParse({ sources: [] }).success).toBe(false);
        expect(secEnforcementOptionsSchema.safeParse({ userAgent: 'x' }).success).toBe(false);
        expect(secEnforcementOptionsSchema.safeParse({ userAgent: 'Acme Compliance contact@acme.com\r\nX-Injected: 1' }).success).toBe(false);
        expect(secEnforcementOptionsSchema.safeParse({ userAgent: 'Acme Compliance Ünïcode contact@acme.com' }).success).toBe(false);
        expect(secEnforcementOptionsSchema.safeParse({ userAgent: 'Acme Compliance Monitoring contact@acme.com' }).success).toBe(true);
    });

    it('needs no credential: the engine accepts the source with no sourceOptions at all', () => {
        expect(secEnforcementConnector.requiredOptions).toBeUndefined();
        const input = EngineInputSchema.parse({ sources: ['sec_enforcement'] });
        expect(resolveSources({ slug: 'global-regtech-compliance-feed', connectors: [secEnforcementConnector] }, input)).toHaveLength(1);
    });

    it('fails preflight with the option path when an option is invalid', () => {
        const input = EngineInputSchema.parse({ sources: ['sec_enforcement'], sourceOptions: { sec_enforcement: { sources: ['nope'] } } });
        expect(() => resolveSources({ slug: 'global-regtech-compliance-feed', connectors: [secEnforcementConnector] }, input)).toThrow(FatalConfigError);
    });
});

describe('secEnforcementConnector.fetch', () => {
    function routes() {
        return { [SEC_LITIGATION_URL]: buildLitigationRss(), [SEC_ADMIN_URL]: buildAdminRss() };
    }

    it('merges both feeds newest-first and sends the configured User-Agent', async () => {
        const { http, calls } = createStubHttp(routes());
        const { ctx } = makeCtx(http);
        const options = secEnforcementOptionsSchema.parse({ userAgent: 'Acme Compliance Monitoring contact@acme.com' });
        const records = await secEnforcementConnector.fetch(ctx, options, RUN);

        expect(records.map((r) => r.recordId)).toEqual([
            'LR-26676',
            'LR-26675',
            'IA-7027',
            '34-106673',
            'LR-26673',
            '34-106633',
            'IA-7021',
            '34-106569',
            'LR-26654',
        ]);
        expect(calls.map((c) => c.url).sort()).toEqual([SEC_ADMIN_URL, SEC_LITIGATION_URL].sort());
        for (const call of calls) expect(call.init?.headers?.['user-agent']).toBe('Acme Compliance Monitoring contact@acme.com');
    });

    it('requests only the selected feed', async () => {
        const { http, calls } = createStubHttp(routes());
        const { ctx } = makeCtx(http);
        const records = await secEnforcementConnector.fetch(ctx, secEnforcementOptionsSchema.parse({ sources: ['administrative_proceedings'] }), RUN);
        expect(calls.map((c) => c.url)).toEqual([SEC_ADMIN_URL]);
        expect(records).toHaveLength(5);
        expect(records.every((r) => r.payload.release_type === 'administrative_proceeding')).toBe(true);
    });

    it('honours maxItemsPerSource across feeds, keeping the newest', async () => {
        const { http } = createStubHttp(routes());
        const { ctx } = makeCtx(http);
        const records = await secEnforcementConnector.fetch(ctx, defaults, { maxItemsPerSource: 3 });
        expect(records.map((r) => r.recordId)).toEqual(['LR-26676', 'LR-26675', 'IA-7027']);
    });

    it('keeps the healthy feed when the other one fails, and says so in the log', async () => {
        const { http } = createStubHttp({ ...routes(), [SEC_LITIGATION_URL]: httpError(SEC_LITIGATION_URL, 503, 'unavailable') });
        const { ctx, logs } = makeCtx(http);
        const records = await secEnforcementConnector.fetch(ctx, defaults, RUN);
        expect(records).toHaveLength(5);
        expect(logs.some((l) => l.level === 'warning' && l.message.includes('litigation_releases'))).toBe(true);
    });

    it('throws SourceFetchError carrying the source id when every feed fails', async () => {
        const { http } = createStubHttp({
            [SEC_LITIGATION_URL]: httpError(SEC_LITIGATION_URL, 403, 'Request Rate Threshold Exceeded'),
            [SEC_ADMIN_URL]: new Error('connect ETIMEDOUT'),
        });
        const { ctx } = makeCtx(http);
        const failure = await secEnforcementConnector.fetch(ctx, defaults, RUN).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).source).toBe('sec_enforcement');
        expect((failure as SourceFetchError).message).toMatch(/403/u);
    });

    it('treats a 200 HTML block page as a failure, not as an empty feed', async () => {
        const html = '<html><body>Your request has been blocked</body></html>';
        const { http } = createStubHttp({ [SEC_LITIGATION_URL]: html, [SEC_ADMIN_URL]: html });
        const { ctx } = makeCtx(http);
        await expect(secEnforcementConnector.fetch(ctx, defaults, RUN)).rejects.toBeInstanceOf(SourceFetchError);
    });

    it('ignores a legacy-style sourceOptions.watchlistNames: it is logged and changes nothing', async () => {
        const { http } = createStubHttp(routes());
        const { ctx, logs } = makeCtx(http);
        const options = secEnforcementOptionsSchema.parse({ watchlistNames: ['', ' ', 'a'] });
        const withLegacy = await secEnforcementConnector.fetch(ctx, options, RUN);
        const { http: http2 } = createStubHttp(routes());
        const without = await secEnforcementConnector.fetch(makeCtx(http2).ctx, defaults, RUN);
        expect(withLegacy).toEqual(without);
        expect(logs.some((l) => l.level === 'warning' && l.message.includes('0 accepted'))).toBe(true);
    });
});
