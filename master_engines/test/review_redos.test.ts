/**
 * ReDoS hardening, proven two ways for every site a static analysis (recheck) flagged as polynomial:
 *
 *   1. EQUIVALENCE  - each rewrite returns exactly what the regular expression it replaced returned, over thousands of
 *                     seeded random inputs built from the tokens that make those expressions interesting;
 *   2. TIMING       - each site finishes quickly on adversarial input of 100 KB to 2 MB that drives the old expression
 *                     into its worst case.
 *
 * The timing ceilings are generous (CI machines vary) but orders of magnitude below what a quadratic scan of the
 * same input costs: at 1 MB a quadratic pass is on the order of 10^12 steps.
 */
import { describe, expect, it } from 'vitest';

import { LEGAL_FORM_PATTERNS, findAuraBootstrapConfig, normalizeEnglishText } from '../global-corporate-patent-intelligence/connectors/aeRegisters.js';
import { buildUnImoIndex } from '../global-regtech-compliance-feed/connectors/ofac.js';
import { SEC_DEFAULT_USER_AGENT, secEnforcementOptionsSchema, splitRespondents } from '../global-regtech-compliance-feed/connectors/secEnforcement.js';
import { parseWorldBankSanctionDate, slugify } from '../global-regtech-compliance-feed/connectors/worldBankDebarred.js';
import { certificateOnlyPemProblem } from '../latam-global-tender-intelligence/connectors/arCordoba.js';
import { extractEmails, extractPhones, MAX_CONTACT_TEXT, MAX_TITLE_PARSE_LENGTH, parseTitle, resolveDate, splitTrailingDash } from '../latam-global-tender-intelligence/connectors/arSantaFe.js';
import { redactUrl } from '../lib/http.js';
import { capLength, findPemBlocks, redactQueryString, removePemBlocks, stripHtmlComments, stripTrailingDash, trimEdgeChar } from '../lib/safe_text.js';

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomFrom(tokens: readonly string[], seed: number, count: number, maxTokens: number): string[] {
    const rand = mulberry32(seed);
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
        const n = Math.floor(rand() * (maxTokens + 1));
        let s = '';
        for (let j = 0; j < n; j += 1) s += tokens[Math.floor(rand() * tokens.length)];
        out.push(s);
    }
    return out;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
}

const CEILING_MS = 1000;

describe('equivalence: linear helpers return what the replaced regular expressions returned', () => {
    it('stripHtmlComments === replace(/<!--[\\s\\S]*?-->/g, "")', () => {
        const tokens = ['<!--', '-->', '<!-->', '--', '->', '>', '<', '!', 'a', ' ', '\n', '<!---->'];
        for (const input of randomFrom(tokens, 1, 4000, 14)) {
            expect(stripHtmlComments(input), JSON.stringify(input)).toBe(input.replace(/<!--[\s\S]*?-->/g, ''));
        }
    });

    it('trimEdgeChar(x, "-") === replace(/^-+|-+$/g, "")', () => {
        for (const input of randomFrom(['-', '--', 'a', 'b-c', ' ', '\n'], 2, 4000, 12)) {
            expect(trimEdgeChar(input, '-'), JSON.stringify(input)).toBe(input.replace(/^-+|-+$/g, ''));
        }
    });

    it('stripTrailingDash === replace(/\\s*-\\s*$/, "")', () => {
        for (const input of randomFrom(['a', ' ', '-', '\t', '\n', '--', ' - ', '\u00a0'], 3, 6000, 12)) {
            expect(stripTrailingDash(input), JSON.stringify(input)).toBe(input.replace(/\s*-\s*$/, ''));
        }
    });

    it('findPemBlocks / removePemBlocks === matchAll / replace of the CERTIFICATE block regex', () => {
        const regex = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
        const tokens = ['-----BEGIN CERTIFICATE-----', '-----END CERTIFICATE-----', '-----BEGIN PRIVATE KEY-----', 'abc', 'QUJD', '\n', ' ', '-----'];
        for (const input of randomFrom(tokens, 4, 4000, 10)) {
            expect(findPemBlocks(input, 'CERTIFICATE').map((b) => b.body), JSON.stringify(input)).toEqual([...input.matchAll(regex)].map((m) => m[1]));
            expect(removePemBlocks(input, 'CERTIFICATE'), JSON.stringify(input)).toBe(input.replace(regex, ''));
        }
    });

    it('findAuraBootstrapConfig === the original lazy regular expression', () => {
        const regex = /\/s\/sfsites\/l\/(%7B[^"'\s]+?%7D)\/bootstrap\.js/;
        const tokens = ['/s/sfsites/l/', '%7B', '%7D', '/bootstrap.js', '%7D/bootstrap.js', '/s/sfsites/l/%7B', 'x', 'ab', '"', "'", ' ', '\n', '%7Bx%7D', '/'];
        for (const input of randomFrom(tokens, 5, 8000, 12)) {
            expect(findAuraBootstrapConfig(input), JSON.stringify(input)).toBe(regex.exec(input)?.[1] ?? null);
        }
    });

    it('redactQueryString masks the same parameters as the old fallback on realistic URLs', () => {
        const isSecret = (name: string): boolean => /key|token|secret|passw|auth|sig|credential|session|jwt|bearer/i.test(name);
        const old = (url: string): string => url.replace(/#.*$/u, '').replace(/([?&][^=&]*(?:key|token|secret|passw|auth|sig|credential|session|jwt|bearer)[^=&]*=)[^&]*/gi, '$1***');
        for (const url of [
            'not a url?token=abc&x=1',
            'host/path?api_key=SECRET&page=2#frag',
            'a?b=c',
            'a',
            'a?',
            'a?x',
            '::bad::?Signature=zzz&q=ok',
            'x?session=1&jwt=2&bearer=3&keep=4',
            'x?password=p&PASSWD=q&Auth=r',
            'x?a=1&&b=2',
        ]) {
            expect(redactQueryString(url, isSecret), url).toBe(old(url));
        }
    });

    it('legal-form patterns: the literal-space forms equal the original \\s forms on whitespace-collapsed names', () => {
        const original = LEGAL_FORM_PATTERNS.map(([p, canonical]) => [new RegExp(p.source.replace(/ \?/g, '\\s*').replace(/ /g, '\\s+'), p.flags), canonical] as const);
        const tokens = ['FZ', 'F.Z.', 'LLC', 'L.L.C.', 'PJSC', 'P.J.S.C', 'PSC', 'Sole', 'Establishment', 'Proprietorship', 'Est.', 'Ltd', 'Limited', 'Acme', '(', ')', '-', '.', ' ', ' ', ' '];
        const apply = (patterns: ReadonlyArray<readonly [RegExp, string]>, text: string): string => patterns.reduce((acc, [p, c]) => acc.replace(p, c), text);
        for (const raw of randomFrom(tokens, 6, 5000, 12)) {
            const collapsed = raw.replace(/\s+/g, ' ').trim();
            expect(apply(LEGAL_FORM_PATTERNS, collapsed), JSON.stringify(collapsed)).toBe(apply(original, collapsed));
        }
    });

    it('SEC respondent splitting: literal-space patterns equal the original \\s forms on collapsed titles', () => {
        const tokens = ['A', 'B', 'and', 'AND', ',', ';', ' ', ' ', ' ', 'et al.', 'et al', '(', ')', 'Inc.', 'III'];
        for (const raw of randomFrom(tokens, 7, 6000, 14)) {
            const t = raw.replace(/\s+/g, ' ').trim();
            expect(t.replace(/ et al\.?$/iu, ''), JSON.stringify(t)).toBe(t.replace(/\s+et\s+al\.?$/iu, ''));
            expect(t.split(/ and /iu), JSON.stringify(t)).toEqual(t.split(/\s+and\s+/iu));
            expect(t.split(/ ?, ?/u), JSON.stringify(t)).toEqual(t.split(/\s*,\s*/u));
            expect(t.replace(/^and /iu, ''), JSON.stringify(t)).toBe(t.replace(/^and\s+/iu, ''));
        }
    });

    it('keeps the behaviour the connectors documented (spot checks)', () => {
        expect(splitRespondents('John Smith and Jane Doe')).toEqual(['John Smith', 'Jane Doe']);
        expect(splitRespondents('A, B, and C')).toEqual(['A', 'B', 'C']);
        expect(splitRespondents('David Reichman et al.')).toEqual(['David Reichman']);
        expect(normalizeEnglishText('ACME ( L.L.C. ) trading')).toBe('ACME LLC trading');
        expect(normalizeEnglishText('Gulf   Trading  F.Z.-L.L.C')).toBe('Gulf Trading FZ-LLC');
        expect(splitTrailingDash('MICROBIOLOGIA HNZN - ')).toBe('MICROBIOLOGIA HNZN');
        expect(slugify('  --Café  Müller & Söhne--  ')).toBe('cafe-muller-sohne');
    });
});

describe('timing: adversarial input is handled in linear time', () => {
    it('stripHtmlComments on 1 MB of unterminated comment openers', () => {
        const { value, ms } = timed(() => stripHtmlComments('<!--'.repeat(250_000)));
        expect(value.length).toBe(1_000_000);
        expect(ms).toBeLessThan(CEILING_MS);
    });

    it('trimEdgeChar / stripTrailingDash / slugify on 2 MB runs of their trigger characters', () => {
        expect(timed(() => trimEdgeChar(`-${'-'.repeat(2_000_000)}-`, '-')).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => stripTrailingDash(`${'\t'.repeat(2_000_000)}--`)).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => stripTrailingDash(`x${' '.repeat(2_000_000)}`)).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => slugify('-'.repeat(2_000_000))).ms).toBeLessThan(CEILING_MS);
    });

    it('findAuraBootstrapConfig on 1.6 MB of repeated bootstrap prefixes without a suffix', () => {
        const { value, ms } = timed(() => findAuraBootstrapConfig('/s/sfsites/l/%7Bi'.repeat(100_000)));
        expect(value).toBeNull();
        expect(ms).toBeLessThan(CEILING_MS);
    });

    it('findAuraBootstrapConfig still finds the config in a large page', () => {
        const page = `${'<div>x</div>'.repeat(50_000)}<script src="/s/sfsites/l/%7B%22fwuid%22%3A%22abc%22%7D/bootstrap.js"></script>`;
        const { value, ms } = timed(() => findAuraBootstrapConfig(page));
        expect(value).toBe('%7B%22fwuid%22%3A%22abc%22%7D');
        expect(ms).toBeLessThan(CEILING_MS);
    });

    it('findPemBlocks / removePemBlocks / the PEM validator on repeated BEGIN markers', () => {
        const hostile = '-----BEGIN CERTIFICATE-----'.repeat(2_000);
        expect(timed(() => findPemBlocks(hostile, 'CERTIFICATE')).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => removePemBlocks(hostile, 'CERTIFICATE')).ms).toBeLessThan(CEILING_MS);
        const { value, ms } = timed(() => certificateOnlyPemProblem(hostile));
        expect(value).toMatch(/no "-----BEGIN CERTIFICATE-----" block|content outside/);
        expect(ms).toBeLessThan(CEILING_MS);
    });

    it('legal-form normalisation on a 1 MB name made of whitespace and of "F." repeats', () => {
        expect(timed(() => normalizeEnglishText(`FZ\t${'\t'.repeat(1_000_000)}x`)).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => normalizeEnglishText('F. '.repeat(300_000))).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => normalizeEnglishText('( '.repeat(300_000))).ms).toBeLessThan(CEILING_MS);
    });

    it('SEC respondent splitting on 1 MB of whitespace, commas and "and"', () => {
        expect(timed(() => splitRespondents(`${'\t'.repeat(1_000_000)} and x`)).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => splitRespondents(', '.repeat(300_000))).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => splitRespondents(' and '.repeat(150_000))).ms).toBeLessThan(CEILING_MS);
    });

    it('SEC userAgent option: a 1 MB value is rejected quickly', () => {
        const { value, ms } = timed(() => secEnforcementOptionsSchema.safeParse({ userAgent: 't'.repeat(1_000_000) }));
        expect(value.success).toBe(false);
        expect(ms).toBeLessThan(CEILING_MS);
        expect(secEnforcementOptionsSchema.safeParse({ userAgent: SEC_DEFAULT_USER_AGENT }).success).toBe(true);
    });

    it('World Bank sanction date and slug on 1 MB inputs', () => {
        expect(timed(() => parseWorldBankSanctionDate('A'.repeat(1_000_000))).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => parseWorldBankSanctionDate(`${'A '.repeat(500_000)}12 2026`)).ms).toBeLessThan(CEILING_MS);
        expect(parseWorldBankSanctionDate('February 12, 2026')).toEqual(new Date(Date.UTC(2026, 1, 12)));
    });

    it('Santa Fe contact extraction, title parsing and relative dates on hostile input', () => {
        expect(timed(() => extractEmails('.'.repeat(1_000_000))).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => extractPhones('.'.repeat(1_000_000))).ms).toBeLessThan(CEILING_MS);
        expect(timed(() => parseTitle(`${'\t'.repeat(1_000_000)}\nN${'.'.repeat(1_000_000)}0\nN//0000`)).ms).toBeLessThan(CEILING_MS);
        const hostile = timed(() => {
            try {
                resolveDate(`in${' '.repeat(1_000_000)}x`, new Date('2026-10-21T00:00:00Z'), 'openingFrom');
            } catch (error) {
                return (error as Error).message;
            }
            return '';
        });
        expect(hostile.ms).toBeLessThan(CEILING_MS);
        // The rejection must not echo a megabyte of the caller's input back into logs and run summaries.
        expect(hostile.value.length).toBeGreaterThan(0);
        expect(hostile.value.length).toBeLessThan(400);
    });

    it('Santa Fe bounds: only the first MAX_CONTACT_TEXT characters of a contact field are scanned, long titles are not parsed', () => {
        expect(extractEmails(`${' '.repeat(MAX_CONTACT_TEXT)}late@example.org`)).toEqual([]);
        expect(extractEmails('soon@example.org')).toEqual(['soon@example.org']);
        const long = `LICITACION PUBLICA N 18/2026${' '.repeat(MAX_TITLE_PARSE_LENGTH)}`;
        expect(parseTitle(long)).toEqual({ tipo: long, numero: null, anio: null });
        expect(parseTitle('LICITACIÓN PÚBLICA Nº 18/2026')).toEqual({ tipo: 'LICITACIÓN PÚBLICA', numero: '18', anio: '2026' });
        expect(() => resolveDate(`${' '.repeat(80)}7 days`, new Date('2026-10-21T00:00:00Z'), 'openingFrom')).not.toThrow();
        expect(resolveDate('7 days', new Date('2026-10-21T12:00:00Z'), 'openingFrom')).toMatch(/^2026-10-1\d$/);
    });

    it('redactUrl fallback on a 1 MB unparseable string full of "?" and "KEY"', () => {
        const hostile = `${'?'.repeat(100_000)}${'KEY'.repeat(300_000)}`;
        const { value, ms } = timed(() => redactUrl(hostile));
        expect(value.length).toBeLessThanOrEqual(hostile.length);
        expect(ms).toBeLessThan(CEILING_MS);
        expect(redactUrl('not a url?token=abc&x=1')).toBe('not a url?token=***&x=1');
    });

    it('capLength bounds without copying short inputs', () => {
        const s = 'abc';
        expect(capLength(s, 10)).toBe(s);
        expect(capLength('abcdef', 3)).toBe('abc');
    });

    it('OFAC IMO pattern (bounded repetition) on 2 MB of repeated "IMO" in a UN comment', () => {
        const xml = `<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>X</FIRST_NAME><COMMENTS1>${'IMO'.repeat(700_000)} IMO Number: 1234567.</COMMENTS1></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;
        const { value, ms } = timed(() => buildUnImoIndex(xml));
        expect(value.get('1234567')?.[0]?.dataId).toBe('1');
        expect(ms).toBeLessThan(5000);
    });
});

describe('bounded patterns: worst case at the enforced cap is small', () => {
    it('parseTitle (cubic pattern) at MAX_TITLE_PARSE_LENGTH', () => {
        const worst = `${'\t'.repeat(60)}\nN${'.'.repeat(60)}0\nN//0000`.slice(0, MAX_TITLE_PARSE_LENGTH);
        const { ms } = timed(() => {
            for (let i = 0; i < 200; i += 1) parseTitle(worst);
        });
        expect(ms).toBeLessThan(CEILING_MS);
    });

    it('extractEmails (quadratic pattern) at MAX_CONTACT_TEXT, repeated like a full listing page', () => {
        const worst = '.'.repeat(MAX_CONTACT_TEXT);
        const { ms } = timed(() => {
            for (let i = 0; i < 2000; i += 1) extractEmails(worst);
        });
        expect(ms).toBeLessThan(CEILING_MS * 4);
    });

    it('relative dates, World Bank dates and the userAgent contact marker at their caps', () => {
        const now = new Date('2026-10-21T00:00:00Z');
        const { ms } = timed(() => {
            for (let i = 0; i < 2000; i += 1) {
                try {
                    resolveDate(`in${' '.repeat(62)}x`, now, 'openingFrom');
                } catch {
                    // expected: not a valid window
                }
                parseWorldBankSanctionDate(`${'A '.repeat(128)}`);
                secEnforcementOptionsSchema.safeParse({ userAgent: 't'.repeat(200) });
            }
        });
        expect(ms).toBeLessThan(CEILING_MS * 4);
    });
});
