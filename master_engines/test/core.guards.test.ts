import { describe, expect, it } from 'vitest';

import {
    clampInteger,
    describeSanitization,
    findKeywordMatch,
    matchesAnyKeyword,
    MAX_KEYWORDS,
    normaliseKeyword,
    sanitizeKeywordList,
} from '../lib/_guards.js';

describe('sanitizeKeywordList - the ghost-billing inputs', () => {
    const poison: Array<[string, unknown]> = [
        ['empty-string element', ['']],
        ['whitespace-only element', ['   ']],
        ['tab/newline-only element', ['\t\n']],
        ['bare empty string', ''],
        ['bare blank string', '   '],
        ['single char string', 'a'],
        ['single char element', ['a']],
        ['punctuation only', ['--']],
        ['punctuation only (brackets)', ['()', '..', '//']],
        ['zero-width only', ['​​']],
        ['zero-width + one char', ['​a​']],
        ['bidi controls only', ['‮‬']],
        ['null element', [null]],
        ['number element', [42]],
        ['object element', [{}]],
        ['number container', 42],
        ['object container', { a: 1 }],
        ['boolean container', true],
        ['undefined', undefined],
        ['null', null],
        ['empty array', []],
    ];

    it.each(poison)('%s yields zero keywords', (_label, input) => {
        const list = sanitizeKeywordList(input);
        expect(list.keywords).toEqual([]);
        expect(list.needles).toEqual([]);
    });

    it.each(poison)('%s can never match any haystack', (_label, input) => {
        const list = sanitizeKeywordList(input);
        for (const haystack of ['Acme Corp', 'a', '', 'x'.repeat(1000), 'ÉCOLE', '12345']) {
            expect(findKeywordMatch(haystack, list)).toBeNull();
            expect(matchesAnyKeyword(haystack, list)).toBe(false);
        }
    });

    it('a bare string is split on separators, never iterated per character', () => {
        const list = sanitizeKeywordList('Acme Corp, Globex\nInitech; x');
        expect(list.keywords).toEqual(['Acme Corp', 'Globex', 'Initech']);
        expect(list.rejected.map((r) => r.reason)).toEqual(['too_short']);
    });

    it('flags a malformed container', () => {
        expect(sanitizeKeywordList(42).malformedContainer).toBe(true);
        expect(sanitizeKeywordList({ a: 1 }).malformedContainer).toBe(true);
        expect(sanitizeKeywordList(['ok']).malformedContainer).toBe(false);
    });
});

describe('sanitizeKeywordList - normalisation and limits', () => {
    it('strips, collapses whitespace and applies NFKC', () => {
        expect(normaliseKeyword('  Acme \t  Corp \n')).toBe('Acme Corp');
        expect(normaliseKeyword('Ａｃｍｅ')).toBe('Acme');
        expect(normaliseKeyword('A​cme')).toBe('Acme');
    });

    it('accepts exactly 2 characters and rejects 1', () => {
        expect(sanitizeKeywordList(['ab']).keywords).toEqual(['ab']);
        expect(sanitizeKeywordList(['a']).rejected[0]?.reason).toBe('too_short');
        expect(sanitizeKeywordList(['​a']).rejected[0]?.reason).toBe('too_short');
    });

    it('measures length after normalisation, not before', () => {
        expect(sanitizeKeywordList([' a ']).keywords).toEqual([]);
        expect(sanitizeKeywordList(['  ab  ']).keywords).toEqual(['ab']);
    });

    it('requires a letter or digit', () => {
        expect(sanitizeKeywordList(['--']).rejected[0]?.reason).toBe('no_letter_or_digit');
        expect(sanitizeKeywordList(['A-']).keywords).toEqual(['A-']);
        expect(sanitizeKeywordList(['42']).keywords).toEqual(['42']);
        expect(sanitizeKeywordList(['中文']).keywords).toEqual(['中文']);
    });

    it('de-duplicates case-insensitively keeping the first spelling', () => {
        const list = sanitizeKeywordList(['Acme Corp', 'ACME CORP', ' acme  corp ']);
        expect(list.keywords).toEqual(['Acme Corp']);
        expect(list.rejected.map((r) => r.reason)).toEqual(['duplicate', 'duplicate']);
    });

    it('rejects over-long keywords', () => {
        const list = sanitizeKeywordList(['x'.repeat(201), 'x'.repeat(200)]);
        expect(list.keywords).toHaveLength(1);
        expect(list.rejected[0]?.reason).toBe('too_long');
    });

    it(`caps the list at ${MAX_KEYWORDS}`, () => {
        const many = Array.from({ length: MAX_KEYWORDS + 25 }, (_, i) => `keyword-${i}`);
        const list = sanitizeKeywordList(many);
        expect(list.keywords).toHaveLength(MAX_KEYWORDS);
        expect(list.rejected.filter((r) => r.reason === 'over_limit')).toHaveLength(25);
    });

    it('truncates rejected values so logs stay bounded', () => {
        const list = sanitizeKeywordList(['​'.repeat(500)]);
        expect(list.rejected[0]?.value.length).toBeLessThanOrEqual(60);
    });

    it('never throws on hostile input', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => sanitizeKeywordList([circular, Symbol('x') as unknown, 10n as unknown])).not.toThrow();
    });
});

describe('findKeywordMatch', () => {
    const list = sanitizeKeywordList(['Acme Corp', 'Globex']);

    it('matches case-insensitively as a substring', () => {
        expect(findKeywordMatch('ACME CORP., a Delaware corporation', list)).toBe('Acme Corp');
        expect(findKeywordMatch('the globex group', list)).toBe('Globex');
    });

    it('returns the first listed keyword that matches', () => {
        expect(findKeywordMatch('Globex and Acme Corp', list)).toBe('Acme Corp');
    });

    it('normalises the haystack the same way as the keywords', () => {
        expect(findKeywordMatch('Acme  Corp', list)).toBe('Acme Corp');
        expect(findKeywordMatch('A​cme Corp', list)).toBe('Acme Corp');
    });

    it('returns null for missing or non-string haystacks', () => {
        expect(findKeywordMatch(undefined, list)).toBeNull();
        expect(findKeywordMatch(null, list)).toBeNull();
        expect(findKeywordMatch(123, list)).toBeNull();
        expect(findKeywordMatch('', list)).toBeNull();
        expect(findKeywordMatch('​', list)).toBeNull();
    });

    it('cannot be bypassed by a hand-built list containing an empty or 1-char needle', () => {
        const handBuilt = { keywords: ['', 'a'], needles: ['', 'a'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('Acme Corp', handBuilt)).toBeNull();
        const withValid = { keywords: ['', 'Acme'], needles: ['', 'acme'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('Acme Corp', withValid)).toBe('Acme');
    });
});

describe('describeSanitization / clampInteger', () => {
    it('summarises rejections by reason', () => {
        const text = describeSanitization(sanitizeKeywordList(['', 'a', 'ok', 'OK']));
        expect(text).toContain('1 accepted');
        expect(text).toContain('3 rejected');
        expect(text).toContain('empty_after_normalisation=1');
        expect(text).toContain('too_short=1');
        expect(text).toContain('duplicate=1');
    });

    it('describes an unsupported container', () => {
        expect(describeSanitization(sanitizeKeywordList(7), 'keywords')).toContain('watchlist disabled');
    });

    it('clamps and falls back', () => {
        expect(clampInteger(5, 1, 10, 3)).toBe(5);
        expect(clampInteger(50, 1, 10, 3)).toBe(10);
        expect(clampInteger(-5, 1, 10, 3)).toBe(1);
        expect(clampInteger('7', 1, 10, 3)).toBe(7);
        expect(clampInteger('abc', 1, 10, 3)).toBe(3);
        expect(clampInteger(Number.NaN, 1, 10, 3)).toBe(3);
        expect(clampInteger(Number.POSITIVE_INFINITY, 1, 10, 3)).toBe(3);
        expect(clampInteger(4.9, 1, 10, 3)).toBe(4);
    });
});
