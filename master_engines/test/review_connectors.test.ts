/** Regression tests for the connector-level findings of the adversarial review. */
import { describe, expect, it } from 'vitest';

import { pathMatches } from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';
import { SEC_DEFAULT_USER_AGENT, secEnforcementOptionsSchema } from '../global-regtech-compliance-feed/connectors/secEnforcement.js';
import { stripWrappingQuotes } from '../global-regtech-compliance-feed/connectors/ukModernSlavery.js';
import { epoOppositionConnector } from '../global-corporate-patent-intelligence/connectors/epoOpposition.js';
import { usptoPtabConnector } from '../global-corporate-patent-intelligence/connectors/usptoPtab.js';
import { itLombardiaGrantsConnector } from '../latam-global-tender-intelligence/connectors/itLombardiaGrants.js';
import { splitTrailingDash } from '../latam-global-tender-intelligence/connectors/arSantaFe.js';
import { byokCredential } from '../lib/connector_helpers.js';

function timed<T>(fn: () => T): { value: T; ms: number } {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
}

describe('SEC-06: sec_enforcement will not impersonate a browser', () => {
    const parse = (userAgent: string) => secEnforcementOptionsSchema.safeParse({ userAgent });

    it.each([
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 contact@acme.com',
        'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 https://acme.com',
        'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 https://acme.com',
        'Mozilla/5.0 (Windows NT 10.0) Chrome/126 Edg/126 https://acme.com',
    ])('rejects a browser User-Agent: %s', (ua) => {
        expect(parse(ua).success).toBe(false);
    });

    it.each([SEC_DEFAULT_USER_AGENT, 'Acme Compliance Monitoring contact@acme.com', 'Mozilla/5.0 (compatible; AcmeBot/1.0; +https://acme.com/bot)'])('accepts an identified client: %s', (ua) => {
        expect(parse(ua).success).toBe(true);
    });

    it('requires a contact, as the SEC fair-access policy asks', () => {
        expect(parse('AcmeComplianceMonitor/1.0').success).toBe(false);
    });
});

describe('SEC-01: BYOK credentials are validated without echoing them', () => {
    const SECRET = 'LEAKME-SECRET-0123456789\nsecondline';

    it('byokCredential treats blank as absent, trims, and refuses control characters with a static message', () => {
        const schema = byokCredential('myKey');
        expect(schema.parse('')).toBeUndefined();
        expect(schema.parse('   ')).toBeUndefined();
        expect(schema.parse(undefined)).toBeUndefined();
        expect(schema.parse('  abc-123_XYZ  ')).toBe('abc-123_XYZ');
        for (const bad of [SECRET, 'has space', 'tab\tinside', 'x'.repeat(301), 'café']) {
            const result = schema.safeParse(bad);
            expect(result.success, JSON.stringify(bad)).toBe(false);
            expect(JSON.stringify(result)).not.toContain('LEAKME');
        }
    });

    it.each([
        ['it_lombardia_grants.socrataAppToken', () => itLombardiaGrantsConnector.optionsSchema.safeParse({ socrataAppToken: SECRET })],
        ['uspto_ptab.usptoOdpApiKey', () => usptoPtabConnector.optionsSchema.safeParse({ usptoOdpApiKey: SECRET })],
        ['epo_opposition.epoOpsConsumerKey', () => epoOppositionConnector.optionsSchema.safeParse({ epoOpsConsumerKey: SECRET, epoOpsConsumerSecret: 'ok-secret-123', epWatchlist: ['EP1234567'] })],
        ['epo_opposition.epoOpsConsumerSecret', () => epoOppositionConnector.optionsSchema.safeParse({ epoOpsConsumerKey: 'ok-key-123', epoOpsConsumerSecret: SECRET, epWatchlist: ['EP1234567'] })],
    ])('%s refuses a token with an embedded line break, without echoing it', (_name, run) => {
        const result = run();
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).not.toContain('LEAKME');
    });

    it('a well-formed credential is still accepted', () => {
        expect(itLombardiaGrantsConnector.optionsSchema.safeParse({ socrataAppToken: 'abcDEF123456' }).success).toBe(true);
        expect(usptoPtabConnector.optionsSchema.safeParse({ usptoOdpApiKey: 'k-test-123456' }).success).toBe(true);
    });
});

describe('SEC-07/09/10: no catastrophic or quadratic regexes on hostile upstream text', () => {
    it('splitTrailingDash keeps its meaning and is linear on a long run of "- " pairs', () => {
        expect(splitTrailingDash('MICROBIOLOGIA HNZN - ')).toBe('MICROBIOLOGIA HNZN');
        expect(splitTrailingDash('ANEXO ... - 31-08-2026')).toBe('ANEXO ... - 31-08-2026');
        expect(splitTrailingDash('abc -  - ')).toBe('abc');
        expect(splitTrailingDash('plain   ')).toBe('plain');
        expect(splitTrailingDash(null)).toBeNull();
        expect(splitTrailingDash(' - ')).toBeNull();
        const hostile = `${'- '.repeat(40_000)}x`;
        const { value, ms } = timed(() => splitTrailingDash(hostile));
        expect(value).toBe(hostile.trim());
        expect(ms).toBeLessThan(500);
    });

    it('stripWrappingQuotes keeps its meaning and is linear on a long run of quotes', () => {
        expect(stripWrappingQuotes('"K" LINE (EUROPE) LIMITED')).toBe('"K" LINE (EUROPE) LIMITED');
        expect(stripWrappingQuotes('"ACME LIMITED"')).toBe('ACME LIMITED');
        expect(stripWrappingQuotes('""ACME""')).toBe('ACME');
        expect(stripWrappingQuotes('ACME')).toBe('ACME');
        expect(stripWrappingQuotes('"unbalanced')).toBe('"unbalanced');
        expect(stripWrappingQuotes('""')).toBe('');
        const hostile = `${'"'.repeat(60_000)}a"b${'"'.repeat(60_000)}`;
        const { value, ms } = timed(() => stripWrappingQuotes(hostile));
        expect(value).toBe(hostile);
        expect(ms).toBeLessThan(500);
    });

    describe('pathMatches (RFC 9309) without a regular expression', () => {
        it.each([
            ['/', '/anything', true],
            ['/fish', '/fish', true],
            ['/fish', '/fish.html', true],
            ['/fish', '/Fish.asp', false],
            ['/fish*', '/fishheads/yummy.html', true],
            ['/*.php', '/index.php', true],
            ['/*.php', '/folder/filename.php?parameters', true],
            ['/*.php$', '/filename.php', true],
            ['/*.php$', '/filename.php?parameters', false],
            ['/fish*.php', '/fish.php', true],
            ['/fish*.php', '/Fish.PHP', false],
            ['/a*b*c', '/aXXbYYc', true],
            ['/a*b*c', '/aXXbYY', false],
            ['*/private', '/x/private', true],
            ['/private$', '/private', true],
            ['/private$', '/private/x', false],
            ['/a.b', '/aXb', false],
            ['/a+b', '/a+b', true],
            ['/(x)', '/(x)', true],
        ])('pathMatches(%j, %j) = %s', (pattern, path, expected) => {
            expect(pathMatches(pattern, path)).toBe(expected);
        });

        it('does not backtrack catastrophically on hundreds of wildcards', () => {
            const pattern = `/${'*a'.repeat(500)}b`;
            const { value, ms } = timed(() => pathMatches(pattern, 'a'.repeat(4000)));
            expect(value).toBe(false);
            expect(ms).toBeLessThan(1500);
        });

        it('still rejects empty, oversized and non-anchored patterns', () => {
            expect(pathMatches('', '/x')).toBe(false);
            expect(pathMatches('x', '/x')).toBe(false);
            expect(pathMatches(`/${'a'.repeat(3000)}`, '/a')).toBe(false);
        });
    });
});

describe('SEC-02: ClinicalTrials.gov Crawl-delay is honoured', () => {
    it('waits CT_CRAWL_DELAY_MS between consecutive requests, never before the first', async () => {
        const { CT_CRAWL_DELAY_MS, fetchClinicalTrials } = await import('../global-corporate-patent-intelligence/connectors/clinicaltrialsOrangeBook.js');
        const sleeps: number[] = [];
        let calls = 0;
        const studies = (ids: string[], next?: string) => ({ studies: ids.map((nctId) => ({ protocolSection: { identificationModule: { nctId } } })), ...(next ? { nextPageToken: next } : {}) });
        const pages = [studies(['NCT00000001', 'NCT00000002'], 't1'), studies(['NCT00000003', 'NCT00000004'], 't2'), studies(['NCT00000005'])];
        const ctx = {
            http: {
                async getText(): Promise<string> {
                    throw new Error('unused');
                },
                async getJson<T>(): Promise<T> {
                    return pages[calls++] as unknown as T;
                },
            },
            log: { info() {}, warning() {}, error() {}, debug() {} },
            now: () => new Date('2026-10-21T00:00:00Z'),
            sleep: async (ms: number) => {
                sleeps.push(ms);
            },
        };
        const result = await fetchClinicalTrials(ctx, { maxItems: 100, queries: [[]], maxPages: 10, pageSize: 2 });
        expect(result).toHaveLength(5);
        expect(calls).toBe(3);
        expect(sleeps).toEqual([CT_CRAWL_DELAY_MS, CT_CRAWL_DELAY_MS]);
    });
});
