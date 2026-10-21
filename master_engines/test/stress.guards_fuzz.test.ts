/**
 * stress.guards_fuzz.test.ts - adversarial fuzz of the watchlist keyword guard and of the "zero false
 * watchlist-hit charges" guarantee (docs/apify_portfolio_refactor_strategy_2026.md section 5, "ghost billing").
 *
 *   PART 1  named operator cases, each with the exact expected output.
 *   PART 2  seeded property tests (mulberry32) over hostile alphabets: P1..P8, including a differential check against
 *           an independent reference implementation written from the specification in docs section 5.3.
 *   PART 2c hand-written hostile corpus (more than 200 inputs) with expectations derived by hand from the specification.
 *   PART 2d exhaustive sweep of every code point U+0000..U+10FFFF against the reference.
 *   PART 3  end to end through runEngine with a stub connector, FakeBilling and InMemoryDeltaStore: poisoned
 *           watchlists must never be charged, valid watchlists are charged exactly once per matched row and never
 *           beyond the per-run hit cap or the per-run USD cap.
 *
 * Every random choice comes from a seeded generator; nothing here reads the clock or a platform random source, and
 * no test uses the network. A failing property reports the first counterexamples with every non-printable code
 * point escaped.
 *
 * DEFECT BLOCK: the properties P2e (strict invisible-character set), P2f (well-formed UTF-16) and P5 (idempotence)
 * and the minimal reproductions D1-D6 assert behaviour that lib/_guards.ts does not have today. They are written
 * strictly (never weakened) and stay red until the guard is fixed; the findings are listed in the run report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    describeSanitization,
    findKeywordMatch,
    type KeywordRejectionReason,
    matchesAnyKeyword,
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    MIN_KEYWORD_LENGTH,
    normaliseKeyword,
    type SanitizedKeywordList,
    sanitizeKeywordList,
} from '../lib/_guards.js';
import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type Connector, type ConnectorContext, type RunSummary, type SourceRecord } from '../lib/types.js';

// ---------------------------------------------------------------------------------------------------------------
// Seeded generator and text helpers
// ---------------------------------------------------------------------------------------------------------------

const SEED = 0x5eed2026;

/** mulberry32: a small, well-known 32-bit PRNG. Same seed, same sequence, on every machine. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Rng {
    float(): number;
    /** Integer in [0, n). */
    int(n: number): number;
    /** Integer in [lo, hi], both inclusive. */
    range(lo: number, hi: number): number;
    chance(p: number): boolean;
    pick<T>(items: readonly T[]): T;
}

function makeRng(seed: number): Rng {
    const next = mulberry32(seed);
    return {
        float: next,
        int: (n) => Math.floor(next() * n),
        range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        chance: (p) => next() < p,
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    };
}

function caseSeed(index: number, salt = 0): number {
    return (SEED ^ Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0;
}

/** Every character in the inclusive code point range, as a one-code-point string each. */
function cpRange(lo: number, hi: number = lo): string[] {
    return Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCodePoint(lo + i));
}

function codePoints(text: string): number {
    let n = 0;
    for (const _ of text) n += 1;
    return n;
}

/** Printable ASCII stays; every other code point is shown as \u{hex}. Truncated to `max` code points. */
function esc(text: string, max = 100): string {
    let out = '';
    let shown = 0;
    for (const ch of text) {
        if (shown >= max) {
            out += '...';
            break;
        }
        const code = ch.codePointAt(0) as number;
        out += code >= 0x20 && code < 0x7f ? ch : `\\u{${code.toString(16)}}`;
        shown += 1;
    }
    return out;
}

function render(value: unknown): string {
    if (typeof value === 'string') return `'${esc(value, 60)}'`;
    if (Array.isArray(value)) return `[${value.slice(0, 6).map(render).join(', ')}${value.length > 6 ? `, ...(${value.length} entries)` : ''}]`;
    try {
        return typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : String(value);
    } catch {
        return '<unprintable>';
    }
}

// Alphabets. Every class the operator named is present; `otherInvisible` adds the remaining Unicode
// Default_Ignorable_Code_Point members that are not in the module's removal list (Hangul fillers, Arabic letter mark,
// tag characters, ...), so the strict invisible-character property has something to find.
const LATIN = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const SCRIPTS = {
    latin: LATIN,
    latinExtended: [...'\u00e9\u00e8\u00f1\u00fc\u00f6\u00e5\u00f8\u00e7\u011f\u015f\u0131\u0130\u00df\u0153\u00e6\u00ff\u0141\u0142'],
    greek: [...cpRange(0x3b1, 0x3c9), ...cpRange(0x391, 0x3a9)],
    cyrillic: [...cpRange(0x430, 0x44f), ...cpRange(0x410, 0x42f)],
    hebrew: cpRange(0x5d0, 0x5ea),
    arabic: cpRange(0x627, 0x64a),
    devanagari: cpRange(0x915, 0x939),
    thai: cpRange(0xe01, 0xe2e),
    hiragana: cpRange(0x3041, 0x3093),
    katakana: cpRange(0x30a1, 0x30f6),
    cjk: cpRange(0x4e00, 0x4e50),
    hangul: cpRange(0xac00, 0xac50),
};
const ALPHABETS = {
    asciiPunctuation: [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
    whitespace: [...cpRange(0x09, 0x0d), ' ', '\u0085', '\u00a0', '\u1680', ...cpRange(0x2000, 0x200a), '\u2028', '\u2029', '\u202f', '\u205f', '\u3000'],
    controls: [...cpRange(0x00, 0x1f), ...cpRange(0x7f, 0x9f)],
    zeroWidth: ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u180e', '\u034f'],
    bidi: [...cpRange(0x200e, 0x200f), ...cpRange(0x202a, 0x202e), ...cpRange(0x2066, 0x2069)],
    otherInvisible: ['\u061c', '\u115f', '\u1160', '\u17b4', '\u180b', '\u180d', '\u3164', '\uffa0', '\u{e0001}', '\u{e0041}', '\u{e007f}', '\u{1d173}'],
    variationSelectors: [...cpRange(0xfe00, 0xfe0f), ...cpRange(0xe0100, 0xe01ef)],
    combining: [...cpRange(0x0300, 0x036f), ...cpRange(0x0483, 0x0489), ...cpRange(0x0591, 0x05bd), ...cpRange(0x1ab0, 0x1abd), ...cpRange(0x20d0, 0x20dc), ...cpRange(0xfe20, 0xfe2f)],
    loneSurrogates: ['\ud800', '\ud83d', '\udbff', '\udc00', '\ude00', '\udfff'],
    astral: ['\u{10000}', '\u{10400}', '\u{1d400}', '\u{1d4d0}', '\u{1d7d8}', '\u{1f1e6}', '\u{1f600}', '\u{1f4a9}', '\u{20000}', '\u{2a6d6}'],
    fullwidth: [...cpRange(0xff21, 0xff3a), ...cpRange(0xff41, 0xff5a), ...cpRange(0xff01, 0xff0f), ...cpRange(0xff66, 0xff9f)],
    digits: [...'0123456789', ...cpRange(0x660, 0x669), ...cpRange(0x6f0, 0x6f9), ...cpRange(0x966, 0x96f), ...cpRange(0x9e6, 0x9ef), ...cpRange(0xff10, 0xff19), ...cpRange(0x1d7ce, 0x1d7d7), '\u00b2', '\u00b3', '\u2460', '\u2167', '\u00bd'],
    compat: ['\ufb01', '\ufb03', '\u01c6', '\u3392', '\u2103', '\u3231', '\u0149', '\u1fb3', '\u2126', '\u212b', '\u1e9e', '\u00df', '\u0130', '\u0131', '\u03c2', '\u03a3'],
    letters: Object.values(SCRIPTS).flat(),
};
/** The zero-width and bidi characters the guard documents as removed (the spec set). */
const DOCUMENTED_ZERO_WIDTH = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad'];

type Pool = readonly string[];
type WeightedPools = ReadonlyArray<readonly [number, Pool]>;

/** Everything, including characters the guard does not strip (U+180E, U+034F, variation selectors, fillers, tags). */
const HOSTILE_POOLS: WeightedPools = [
    [10, ALPHABETS.asciiPunctuation],
    [10, ALPHABETS.whitespace],
    [6, ALPHABETS.controls],
    [6, ALPHABETS.zeroWidth],
    [5, ALPHABETS.bidi],
    [3, ALPHABETS.otherInvisible],
    [4, ALPHABETS.variationSelectors],
    [5, ALPHABETS.combining],
    [3, ALPHABETS.loneSurrogates],
    [6, ALPHABETS.astral],
    [6, ALPHABETS.fullwidth],
    [6, ALPHABETS.digits],
    [3, ALPHABETS.compat],
    [22, ALPHABETS.letters],
];

/**
 * Router-level text: only characters whose treatment is unambiguous under the written spec (docs 5.3), so the
 * end-to-end oracle does not depend on the grey zone that the property block probes separately.
 */
const SAFE_POOLS: WeightedPools = [
    [10, ALPHABETS.asciiPunctuation],
    [10, ALPHABETS.whitespace],
    [6, ALPHABETS.controls],
    [6, DOCUMENTED_ZERO_WIDTH],
    [5, ALPHABETS.bidi],
    [6, ALPHABETS.astral],
    [6, ALPHABETS.fullwidth],
    [6, ALPHABETS.digits],
    [22, ALPHABETS.letters],
];

const REMOVABLE_NOISE_POOLS: WeightedPools = [
    [3, DOCUMENTED_ZERO_WIDTH],
    [2, ALPHABETS.bidi],
];

function pickWeighted(rng: Rng, pools: WeightedPools): string {
    let total = 0;
    for (const [weight] of pools) total += weight;
    let roll = rng.float() * total;
    for (const [weight, pool] of pools) {
        roll -= weight;
        if (roll < 0) return rng.pick(pool);
    }
    return rng.pick((pools[pools.length - 1] as readonly [number, Pool])[1]);
}

function randomText(rng: Rng, pools: WeightedPools, maxLen: number): string {
    const roll = rng.float();
    const len = roll < 0.06 ? 0 : roll < 0.7 ? rng.range(1, Math.min(8, maxLen)) : rng.range(1, maxLen);
    let out = '';
    for (let i = 0; i < len; i += 1) out += pickWeighted(rng, pools);
    return out;
}

function randomRun(rng: Rng, pool: Pool, min: number, max: number): string {
    const len = rng.range(min, max);
    let out = '';
    for (let i = 0; i < len; i += 1) out += rng.pick(pool);
    return out;
}

/** Pools a "word" is built from: letters and digits of many scripts, heavily Latin. */
const WORD_POOLS: Pool[] = [
    LATIN,
    LATIN,
    LATIN,
    SCRIPTS.latinExtended,
    SCRIPTS.greek,
    SCRIPTS.cyrillic,
    SCRIPTS.hebrew,
    SCRIPTS.arabic,
    SCRIPTS.devanagari,
    SCRIPTS.thai,
    SCRIPTS.hiragana,
    SCRIPTS.katakana,
    SCRIPTS.cjk,
    SCRIPTS.hangul,
    ALPHABETS.digits,
    ALPHABETS.fullwidth,
    ALPHABETS.compat,
];
/** Word pools whose letters are not touched by NFKC expansion and carry no grey-zone behaviour (router-level keywords). */
const PLAIN_WORD_POOLS: Pool[] = [LATIN, LATIN, LATIN, SCRIPTS.greek, SCRIPTS.cyrillic, SCRIPTS.hebrew, SCRIPTS.cjk, [...'0123456789']];

function randomWord(rng: Rng, minLen: number, maxLen: number, pools: Pool[] = WORD_POOLS): string {
    const pool = rng.pick(pools);
    const len = rng.range(minLen, maxLen);
    let out = '';
    for (let i = 0; i < len; i += 1) out += rng.pick(pool);
    return out;
}

function randomPhrase(rng: Rng, pools: Pool[] = WORD_POOLS): string {
    const words = rng.range(1, 4);
    let out = randomWord(rng, 2, 9, pools);
    for (let i = 1; i < words; i += 1) out += `${rng.pick([' ', ' ', ' ', '-', ' & ', '. ', ' / '])}${randomWord(rng, 1, 9, pools)}`;
    return out;
}

function toFullwidth(text: string): string {
    return [...text]
        .map((ch) => {
            const c = ch.codePointAt(0) as number;
            if (c === 0x20) return '\u3000';
            return c >= 0x21 && c <= 0x7e ? String.fromCodePoint(c + 0xfee0) : ch;
        })
        .join('');
}

function swapCase(rng: Rng, text: string): string {
    return [...text].map((ch) => (rng.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase())).join('');
}

function insertNoise(rng: Rng, text: string, pools: WeightedPools, count: number): string {
    const chars = [...text];
    for (let i = 0; i < count; i += 1) chars.splice(rng.range(0, chars.length), 0, pickWeighted(rng, pools));
    return chars.join('');
}

/** Case changes, width changes, whitespace swaps, injected noise and padding: the usual ways a pasted name is mangled. */
function dress(rng: Rng, text: string, pools: WeightedPools): string {
    let out = text;
    const caseRoll = rng.float();
    if (caseRoll < 0.2) out = out.toUpperCase();
    else if (caseRoll < 0.4) out = out.toLowerCase();
    else if (caseRoll < 0.5) out = swapCase(rng, out);
    if (rng.chance(0.15)) out = toFullwidth(out);
    if (rng.chance(0.2)) out = out.replace(/ /gu, () => randomRun(rng, ALPHABETS.whitespace, 1, 4));
    if (rng.chance(0.25)) out = insertNoise(rng, out, pools, rng.range(1, 3));
    if (rng.chance(0.4)) out = `${randomText(rng, pools, 4)}${out}${randomText(rng, pools, 4)}`;
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Independent reference implementation of docs section 5.3 (written from the specification, not from _guards.ts)
// ---------------------------------------------------------------------------------------------------------------
//
//   1  must be a string
//   2  at most 4,096 UTF-16 units, checked before any Unicode work (normalisation is quadratic in the worst case)
//   3  well-formed Unicode: a lone surrogate is rejected as invalid_unicode
//   4  cleaned to a FIXED POINT of: NFKC, line breaks and tabs become a space, removal of the C0/C1 controls and of every
//      Default_Ignorable_Code_Point and Bidi_Control character, whitespace runs collapse to one space, ends trimmed;
//      a text that has not settled after 8 passes counts as empty; a text with a run of MORE than 16 consecutive
//      combining marks counts as empty for a keyword (NFKC reordering is quadratic in the length of a run) while a
//      haystack keeps the first 16 marks of such a run; a text that NFKC grows by more than 4x plus 16 units counts as empty
//   5  length >= 2 code points after cleaning, and at least 2 VISIBLE code points (neither invisible nor White_Space)
//      in the raw text: one glyph that NFKC expands is not a two-character keyword
//   6  at least TWO letters or numbers (none: no_letter_or_digit, exactly one: single_letter_or_digit)
//   7  length <= 200 code points
//   8  de-duplicated case-insensitively, first spelling wins
//   9  at most 500 accepted, the rest rejected as over_limit
//  10  at most 5,000 entries inspected, and the string entries of at most 4,096 units that are inspected add up to at most
//      200,000 UTF-16 units (a longer entry costs nothing: it is rejected at once); the remainder is reported as ONE over_limit entry
//   a bare string is cut to 200,000 units and split on LF, CR, comma and semicolon (ASCII only); when it WAS cut, the last
//   piece (possibly truncated) is dropped and one over_limit entry is appended after the 'further entries' one;
//   a non-array, non-string value is a malformed container. A rejected value is previewed: a string cut at 57 units with
//   control, invisible and lone surrogate characters replaced by U+FFFD, anything else as a constant tag such as [object].
//   A needle is only matched if it has at least 2 code points and 2 letters or numbers; at most 500 needles are read.
//   A haystack longer than 8,192 units is searched only up to
//   the last White_Space character inside the window (none: not searched), then cleaned.

const REF_MIN_CODE_POINTS = 2;
const REF_MAX_CODE_POINTS = 200;
const REF_MAX_ACCEPTED = 500;
const REF_MAX_RAW_UNITS = 4096;
const REF_MAX_CANDIDATES = 5000;
const REF_MAX_TOTAL_RAW_UNITS = 200_000;
const REF_MAX_BARE_UNITS = 200_000;
const REF_MAX_HAYSTACK_UNITS = 8192;
const REF_MAX_PASSES = 8;
const REF_MAX_COMBINING_RUN = 16;

/** Characters that become a space before removal: line breaks and tabs. */
const REF_LINE_BREAKS_AND_TABS = new Set<number>([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);

/** Unicode White_Space, written out as a table (self-checked against the property below). */
const REF_WHITESPACE = new Set<number>([0x20, 0xa0, 0x1680, 0x202f, 0x205f, 0x3000, ...cpRange(0x2000, 0x200a).map((ch) => ch.codePointAt(0) as number)]);

/**
 * The characters the spec removes, as code point ranges (inclusive): the C0 and C1 controls plus every
 * Default_Ignorable_Code_Point and Bidi_Control character of Unicode 16.0 (DerivedCoreProperties.txt). Typed out
 * here, not read from a regular expression, so the reference does not share lib/_guards.ts mechanism; a self-check
 * below ties the table to the platform's property data for every code point.
 */
const REF_REMOVED_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0000, 0x001f], // C0 controls
    [0x007f, 0x009f], // DEL and the C1 controls
    [0x00ad, 0x00ad], // soft hyphen
    [0x034f, 0x034f], // combining grapheme joiner
    [0x061c, 0x061c], // Arabic letter mark
    [0x115f, 0x1160], // Hangul choseong and jungseong fillers
    [0x17b4, 0x17b5], // Khmer inherent vowels
    [0x180b, 0x180f], // Mongolian free variation selectors and vowel separator
    [0x200b, 0x200f], // zero-width space, non-joiner, joiner, left-to-right and right-to-left marks
    [0x202a, 0x202e], // bidi embeddings and overrides
    [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated format controls
    [0x3164, 0x3164], // Hangul filler
    [0xfe00, 0xfe0f], // variation selectors 1-16
    [0xfeff, 0xfeff], // zero-width no-break space (byte order mark)
    [0xffa0, 0xffa0], // halfwidth Hangul filler
    [0xfff0, 0xfff8], // reserved default-ignorable
    [0x1bca0, 0x1bca3], // shorthand format controls
    [0x1d173, 0x1d17a], // musical symbol format controls
    [0xe0000, 0xe0fff], // tag characters and variation selectors supplement
];

function refIsRemoved(cp: number): boolean {
    for (const [lo, hi] of REF_REMOVED_RANGES) if (cp >= lo && cp <= hi) return true;
    return false;
}

function refIsSpaceLike(cp: number): boolean {
    return REF_LINE_BREAKS_AND_TABS.has(cp) || REF_WHITESPACE.has(cp);
}

const REF_MARK = /^\p{Mark}$/u;

/** True when the text holds MORE than REF_MAX_COMBINING_RUN consecutive combining marks (General_Category M). */
function refHasLongMarkRun(text: string): boolean {
    let run = 0;
    for (const ch of text) {
        if (REF_MARK.test(ch)) {
            run += 1;
            if (run > REF_MAX_COMBINING_RUN) return true;
        } else {
            run = 0;
        }
    }
    return false;
}

/** The text with every run of combining marks cut to its first REF_MAX_COMBINING_RUN marks. */
function refCutMarkRuns(text: string): string {
    let out = '';
    let run = 0;
    for (const ch of text) {
        if (REF_MARK.test(ch)) {
            run += 1;
            if (run > REF_MAX_COMBINING_RUN) continue;
        } else {
            run = 0;
        }
        out += ch;
    }
    return out;
}

/** One cleaning pass. `hostileRuns` says what a run of more than 16 combining marks does: empty the text, or cut the run. */
function refCleanOnce(input: string, hostileRuns: 'reject' | 'cut'): string {
    let raw = input;
    if (refHasLongMarkRun(raw)) {
        if (hostileRuns === 'reject') return '';
        raw = refCutMarkRuns(raw);
    }
    const nfkc = raw.normalize('NFKC');
    if (nfkc.length > raw.length * 4 + 16) return '';
    let out = '';
    let gap = false;
    for (const ch of nfkc) {
        const cp = ch.codePointAt(0) as number;
        // Printable ASCII other than the space is never whitespace and never removed: skip the table lookups.
        if (cp > 0x20 && cp < 0x7f) {
            if (gap && out.length > 0) out += ' ';
            gap = false;
            out += ch;
            continue;
        }
        if (refIsSpaceLike(cp)) {
            gap = true;
            continue;
        }
        if (refIsRemoved(cp)) continue;
        if (gap && out.length > 0) out += ' ';
        gap = false;
        out += ch;
    }
    return out;
}

/** Cleaning repeated until the text stops changing; a text that never settles is treated as empty. */
function refClean(raw: string, hostileRuns: 'reject' | 'cut' = 'reject'): string {
    let current = raw;
    for (let pass = 0; pass < REF_MAX_PASSES; pass += 1) {
        const next = refCleanOnce(current, hostileRuns);
        if (next === current) return next;
        current = next;
    }
    return '';
}

/** `text` cut to at most `max` UTF-16 units, never ending in half of a surrogate pair. */
function refCut(text: string, max: number): string {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The searched part of a haystack: whole if short, else up to the last White_Space character inside the 8,192-unit window, else nothing. */
function refCutHaystack(text: string): string {
    if (text.length <= REF_MAX_HAYSTACK_UNITS) return text;
    for (let end = REF_MAX_HAYSTACK_UNITS; end > 0; end -= 1) {
        if (refIsSpaceLike(text.charCodeAt(end))) return text.slice(0, end);
    }
    return '';
}

function refHasLoneSurrogate(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) i += 1;
            else return true;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return true;
        }
    }
    return false;
}

const REF_LETTER_OR_NUMBER = /[\p{Letter}\p{Number}]/u;

function refCountLettersOrNumbers(text: string): number {
    let n = 0;
    for (const ch of text) if (REF_LETTER_OR_NUMBER.test(ch)) n += 1;
    return n;
}

/** Code points that are neither removed (invisible) nor White_Space: the glyphs a reader sees. */
function refVisibleCodePoints(text: string): number {
    let n = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) as number;
        if (refIsRemoved(cp) || refIsSpaceLike(cp)) continue;
        n += 1;
    }
    return n;
}

function refSplit(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSeparator = false;
    for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
            if (!inSeparator) {
                parts.push(current);
                current = '';
                inSeparator = true;
            }
        } else {
            current += ch;
            inSeparator = false;
        }
    }
    parts.push(current);
    return parts;
}

interface RefResult {
    keywords: string[];
    needles: string[];
    reasons: KeywordRejectionReason[];
    malformed: boolean;
    /** Lower-cased spelling key -> first valid cleaned spelling in input order (ignores the 500 cap). */
    firstValid: Map<string, string>;
}

interface RefCandidates {
    items: unknown[];
    bareStringCut: boolean;
}

function refCandidates(input: unknown): RefCandidates | null {
    if (input === undefined || input === null) return { items: [], bareStringCut: false };
    if (Array.isArray(input)) return { items: Array.from(input as unknown[]), bareStringCut: false };
    if (typeof input === 'string') {
        const window = refCut(input, REF_MAX_BARE_UNITS);
        const items = refSplit(window);
        if (window.length < input.length) {
            items.pop();
            return { items, bareStringCut: true };
        }
        return { items, bareStringCut: false };
    }
    return null;
}

function refSanitize(input: unknown): RefResult {
    const out: RefResult = { keywords: [], needles: [], reasons: [], malformed: false, firstValid: new Map() };
    const found = refCandidates(input);
    if (found === null) {
        out.malformed = true;
        return out;
    }
    const candidates = found.items;
    const taken = new Set<string>();
    const limit = Math.min(candidates.length, REF_MAX_CANDIDATES);
    let inspected = 0;
    let totalRaw = 0;
    for (let index = 0; index < limit; index += 1) {
        const candidate = candidates[index];
        if (typeof candidate === 'string' && candidate.length <= REF_MAX_RAW_UNITS) {
            totalRaw += candidate.length;
            if (totalRaw > REF_MAX_TOTAL_RAW_UNITS) break;
        }
        inspected += 1;
        if (typeof candidate !== 'string') {
            out.reasons.push('not_a_string');
            continue;
        }
        if (candidate.length > REF_MAX_RAW_UNITS) {
            out.reasons.push('too_long');
            continue;
        }
        if (refHasLoneSurrogate(candidate)) {
            out.reasons.push('invalid_unicode');
            continue;
        }
        const cleaned = refClean(candidate);
        const points = codePoints(cleaned);
        if (points === 0) {
            out.reasons.push('empty_after_normalisation');
        } else if (points < REF_MIN_CODE_POINTS) {
            out.reasons.push('too_short');
        } else if (refVisibleCodePoints(candidate) < REF_MIN_CODE_POINTS) {
            out.reasons.push('too_short');
        } else if (refCountLettersOrNumbers(cleaned) === 0) {
            out.reasons.push('no_letter_or_digit');
        } else if (refCountLettersOrNumbers(cleaned) === 1) {
            out.reasons.push('single_letter_or_digit');
        } else if (points > REF_MAX_CODE_POINTS) {
            out.reasons.push('too_long');
        } else {
            const key = cleaned.toLowerCase();
            if (!out.firstValid.has(key)) out.firstValid.set(key, cleaned);
            if (taken.has(key)) {
                out.reasons.push('duplicate');
            } else if (out.keywords.length >= REF_MAX_ACCEPTED) {
                out.reasons.push('over_limit');
            } else {
                taken.add(key);
                out.keywords.push(cleaned);
                out.needles.push(key);
            }
        }
    }
    if (candidates.length > inspected) out.reasons.push('over_limit');
    if (found.bareStringCut) out.reasons.push('over_limit');
    return out;
}

function refFind(haystack: unknown, ref: RefResult): string | null {
    if (ref.needles.length === 0) return null;
    if (typeof haystack !== 'string') return null;
    const text = refClean(refCutHaystack(haystack), 'cut').toLowerCase();
    for (let i = 0; i < Math.min(ref.needles.length, REF_MAX_ACCEPTED); i += 1) {
        const needle = ref.needles[i] as string;
        if (codePoints(needle) < REF_MIN_CODE_POINTS || refCountLettersOrNumbers(needle) < 2) continue;
        if (text.includes(needle)) return ref.keywords[i] as string;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared assertions and bookkeeping
// ---------------------------------------------------------------------------------------------------------------

const OBJECT_PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype).sort();

/** A battery of haystacks that must never match an empty list, whatever their content or type. */
const HAYSTACK_BATTERY: unknown[] = [
    null,
    undefined,
    '',
    ' ',
    '\u200b',
    '\n',
    'a',
    'ab',
    'Acme Corp',
    'x'.repeat(100_000),
    ' '.repeat(100_000),
    '\u200b'.repeat(100_000),
    '--',
    '()',
    'ab,cd;ef\nzz',
    '\u{1f600}',
    '\ud800',
    0,
    1,
    Number.NaN,
    true,
    false,
    {},
    [],
    ['a'],
    () => 'a',
    Symbol('a'),
    10n,
    new String('abc'),
];

const STATS: Record<string, number> = {};
function bump(key: string, n = 1): void {
    STATS[key] = (STATS[key] ?? 0) + n;
}

class Violations {
    count = 0;
    readonly first: string[] = [];
    add(detail: () => string): void {
        this.count += 1;
        if (this.first.length < 3) this.first.push(detail());
    }
}

function expectNoViolations(v: Violations, title: string): void {
    expect(v.count, `${title}: ${v.count} violation(s). First counterexamples: ${v.first.join(' || ')}`).toBe(0);
}

afterAll(() => {
    console.info(`GUARDS_FUZZ_STATS ${JSON.stringify(STATS)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// PART 1 - named operator cases
// ---------------------------------------------------------------------------------------------------------------

type Rejection = { value: string; reason: KeywordRejectionReason };
/** The reference preview of a rejected STRING: cut at 57 units (never inside a pair) with '...', controls, invisible and lone surrogate characters replaced by U+FFFD. */
function refPreview(value: string): string {
    const clipped = value.length > 60 ? `${refCut(value, 57)}...` : value;
    let out = '';
    for (let i = 0; i < clipped.length; i += 1) {
        const unit = clipped.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff && clipped.charCodeAt(i + 1) >= 0xdc00 && clipped.charCodeAt(i + 1) <= 0xdfff) {
            const cp = clipped.codePointAt(i) as number;
            out += refIsRemoved(cp) ? '\ufffd' : clipped.slice(i, i + 2);
            i += 1;
        } else if (unit >= 0xd800 && unit <= 0xdfff) {
            out += '\ufffd';
        } else {
            out += refIsRemoved(unit) ? '\ufffd' : clipped[i];
        }
    }
    return out;
}

/** A rejection of the STRING entry `value`: its expected preview is computed by the reference. */
const R = (value: string, reason: KeywordRejectionReason): Rejection => ({ value: refPreview(value), reason });
/** A rejection of a NON-string entry: the preview is a constant tag. */
const RT = (tag: string, reason: KeywordRejectionReason = 'not_a_string'): Rejection => ({ value: tag, reason });

function expectNeverMatches(list: SanitizedKeywordList): void {
    for (const haystack of HAYSTACK_BATTERY) {
        expect(findKeywordMatch(haystack, list)).toBeNull();
        expect(matchesAnyKeyword(haystack, list)).toBe(false);
    }
}

/** The whole result object, exactly: keywords, needles, every rejection (value and reason, in order), container flag. */
function expectExact(input: unknown, expected: { keywords: string[]; rejected: Rejection[]; malformedContainer?: boolean }): void {
    const list = sanitizeKeywordList(input);
    expect(list).toEqual({
        keywords: expected.keywords,
        needles: expected.keywords.map((k) => k.toLowerCase()),
        rejected: expected.rejected,
        malformedContainer: expected.malformedContainer ?? false,
    });
    if (expected.keywords.length === 0) expectNeverMatches(list);
}

/** For inputs whose rejection `value` is a truncated preview: the exact keywords and the exact reason sequence. */
function expectReasons(input: unknown, keywords: string[], reasons: KeywordRejectionReason[]): void {
    const list = sanitizeKeywordList(input);
    expect(list.keywords).toEqual(keywords);
    expect(list.needles).toEqual(keywords.map((k) => k.toLowerCase()));
    expect(list.rejected.map((r) => r.reason)).toEqual(reasons);
    expect(list.malformedContainer).toBe(false);
    for (const r of list.rejected) expect(r.value.length).toBeLessThanOrEqual(60);
    if (keywords.length === 0) expectNeverMatches(list);
}

describe('PART 1 named cases: empty, blank and punctuation-only entries', () => {
    it('[""] yields no keyword and one empty_after_normalisation rejection', () => {
        expectExact([''], { keywords: [], rejected: [R('', 'empty_after_normalisation')] });
    });

    it('["", "   "] yields no keyword and two empty_after_normalisation rejections', () => {
        expectExact(['', '   '], { keywords: [], rejected: [R('', 'empty_after_normalisation'), R('   ', 'empty_after_normalisation')] });
    });

    it('["   "] yields no keyword and one empty_after_normalisation rejection', () => {
        expectExact(['   '], { keywords: [], rejected: [R('   ', 'empty_after_normalisation')] });
    });

    it('[" ", "\\t", "\\n"] yields no keyword and three empty_after_normalisation rejections', () => {
        expectExact([' ', '\t', '\n'], {
            keywords: [],
            rejected: [R(' ', 'empty_after_normalisation'), R('\t', 'empty_after_normalisation'), R('\n', 'empty_after_normalisation')],
        });
    });

    it('["--"] is rejected as no_letter_or_digit', () => {
        expectExact(['--'], { keywords: [], rejected: [R('--', 'no_letter_or_digit')] });
    });

    it('["..."] is rejected as no_letter_or_digit', () => {
        expectExact(['...'], { keywords: [], rejected: [R('...', 'no_letter_or_digit')] });
    });

    it('["()"] is rejected as no_letter_or_digit', () => {
        expectExact(['()'], { keywords: [], rejected: [R('()', 'no_letter_or_digit')] });
    });
});

describe('PART 1 named cases: non-string entries are rejected, never coerced', () => {
    it('[null] is rejected as not_a_string', () => {
        expectExact([null], { keywords: [], rejected: [RT('[null]')] });
    });

    it('[undefined] is rejected as not_a_string', () => {
        expectExact([undefined], { keywords: [], rejected: [RT('[undefined]')] });
    });

    it('[[]] is rejected as not_a_string', () => {
        expectExact([[]], { keywords: [], rejected: [RT('[array]')] });
    });

    it('[{}] is rejected as not_a_string', () => {
        expectExact([{}], { keywords: [], rejected: [RT('[object]')] });
    });

    it('[0] is rejected as not_a_string', () => {
        expectExact([0], { keywords: [], rejected: [RT('[number]')] });
    });

    it('[false] is rejected as not_a_string', () => {
        expectExact([false], { keywords: [], rejected: [RT('[boolean]')] });
    });
});

describe('PART 1 named cases: absent and bare-string containers', () => {
    it('null yields an empty result with no rejection and a well-formed container', () => {
        expectExact(null, { keywords: [], rejected: [] });
    });

    it('undefined yields an empty result with no rejection and a well-formed container', () => {
        expectExact(undefined, { keywords: [], rejected: [] });
    });

    it('"" (a bare empty string) yields no keyword, never an empty needle', () => {
        expectExact('', { keywords: [], rejected: [R('', 'empty_after_normalisation')] });
    });

    it('"   " (a bare blank string) yields no keyword', () => {
        expectExact('   ', { keywords: [], rejected: [R('   ', 'empty_after_normalisation')] });
    });

    it('"a" (a bare one-letter string) is rejected as too_short and is never iterated per character', () => {
        expectExact('a', { keywords: [], rejected: [R('a', 'too_short')] });
    });

    it('"ab" (a bare two-letter string) is ONE keyword, not two characters', () => {
        expectExact('ab', { keywords: ['ab'], rejected: [] });
    });

    it('"Acme, Beta;Gamma\\nDelta" is split on comma, semicolon and newline into four keywords', () => {
        expectExact('Acme, Beta;Gamma\nDelta', { keywords: ['Acme', 'Beta', 'Gamma', 'Delta'], rejected: [] });
    });

    it('a bare string with runs of separators, CRLF and a one-letter piece keeps only the valid keywords', () => {
        expectExact('Acme,,;;\r\n Beta , x', { keywords: ['Acme', 'Beta'], rejected: [R(' x', 'too_short')] });
    });

    it('an object, a number and a boolean container are malformed: zero keywords and malformedContainer true', () => {
        for (const container of [{ a: 1 }, 42, true, () => 'ab', Symbol('ab'), 10n, new String('ab')]) {
            expectExact(container, { keywords: [], rejected: [], malformedContainer: true });
        }
    });
});

describe('PART 1 named cases: single characters', () => {
    it('["a"] is rejected as too_short', () => {
        expectExact(['a'], { keywords: [], rejected: [R('a', 'too_short')] });
    });

    it('["x"] is rejected as too_short', () => {
        expectExact(['x'], { keywords: [], rejected: [R('x', 'too_short')] });
    });

    it('every single ASCII letter, digit and a letter of several scripts is rejected as too_short', () => {
        const singles = [...LATIN, ...'0123456789', '\u00e9', '\u00f1', '\u00df', '\u0130', '\u03a3', '\u03c3', '\u044f', '\u05d0', '\u0639', '\u4e2d', '\u3042', '\u30a2', '\ud55c'];
        for (const single of singles) expectExact([single], { keywords: [], rejected: [R(single, 'too_short')] });
    });

    it('a single astral-plane letter counts as ONE code point and is rejected as too_short', () => {
        expectExact(['\u{20000}'], { keywords: [], rejected: [R('\u{20000}', 'too_short')] });
        expectExact(['\u{10000}'], { keywords: [], rejected: [R('\u{10000}', 'too_short')] });
    });

    it('two astral-plane letters are accepted (two code points, four UTF-16 units)', () => {
        expectExact(['\u{20000}\u{20001}'], { keywords: ['\u{20000}\u{20001}'], rejected: [] });
    });
});

describe('PART 1 named cases: zero-width characters', () => {
    it('["\\u200b"] (one zero-width space) becomes empty and is rejected as empty_after_normalisation', () => {
        expectExact(['\u200b'], { keywords: [], rejected: [R('\u200b', 'empty_after_normalisation')] });
    });

    it('["\\u200b\\u200b\\u200b"] (three zero-width spaces) cannot pass as length 3', () => {
        expectExact(['\u200b\u200b\u200b'], { keywords: [], rejected: [R('\u200b\u200b\u200b', 'empty_after_normalisation')] });
    });

    it('["\\u2060\\ufeff"] (word joiner and BOM) becomes empty', () => {
        expectExact(['\u2060\ufeff'], { keywords: [], rejected: [R('\u2060\ufeff', 'empty_after_normalisation')] });
    });

    it('["\\u200b a \\u200b"] becomes the 1-code-point string "a" after cleaning and is rejected as too_short', () => {
        expectExact(['\u200b a \u200b'], { keywords: [], rejected: [R('\u200b a \u200b', 'too_short')] });
    });

    it('["ab\\u200bcd"] becomes "abcd" and is accepted', () => {
        expectExact(['ab\u200bcd'], { keywords: ['abcd'], rejected: [] });
    });

    it('every documented zero-width character is deleted in the middle of a word', () => {
        for (const zw of DOCUMENTED_ZERO_WIDTH) expectExact([`ab${zw}cd`], { keywords: ['abcd'], rejected: [] });
    });
});

describe('PART 1 named cases: bidi marks, variation selectors, combining marks, lone surrogates', () => {
    it('bidi marks only (LRM, RLM, embeddings, overrides, isolates) become empty and are rejected', () => {
        for (const marks of ['\u200e\u200f', '\u202a\u202b\u202c\u202d\u202e', '\u2066\u2067\u2068\u2069', '\u202e\u202c']) {
            expectExact([marks], { keywords: [], rejected: [R(marks, 'empty_after_normalisation')] });
        }
    });

    it('bidi marks around a word are deleted: ["\\u202eab\\u202c"] becomes "ab"', () => {
        expectExact(['\u202eab\u202c'], { keywords: ['ab'], rejected: [] });
        expectExact(['\u2066ab\u2069'], { keywords: ['ab'], rejected: [] });
    });

    it('one letter plus bidi marks is still one letter: rejected as too_short', () => {
        expectExact(['a\u200e'], { keywords: [], rejected: [R('a\u200e', 'too_short')] });
        expectExact(['\u2066x\u2069'], { keywords: [], rejected: [R('\u2066x\u2069', 'too_short')] });
    });

    it('variation selectors alone never become a keyword and never match', () => {
        const inputs: string[][] = [['\ufe0f'], ['\ufe0f\ufe0f'], ['\ufe0e', '\ufe0f'], ['\u{e0100}\u{e0101}'], ['\ufe00\ufe01\ufe02']];
        for (const input of inputs) {
            const list = sanitizeKeywordList(input);
            expect(list.keywords).toEqual([]);
            expect(list.needles).toEqual([]);
            expect(list.malformedContainer).toBe(false);
            expect(list.rejected).toHaveLength(input.length);
            for (const r of list.rejected) expect(['empty_after_normalisation', 'too_short', 'no_letter_or_digit']).toContain(r.reason);
            expectNeverMatches(list);
        }
    });

    it('combining-only strings are rejected: one mark is too_short, several marks have no letter or digit', () => {
        expectExact(['\u0301'], { keywords: [], rejected: [R('\u0301', 'too_short')] });
        expectExact(['\u0301\u0302\u0303'], { keywords: [], rejected: [R('\u0301\u0302\u0303', 'no_letter_or_digit')] });
        expectExact(['\u0301 \u0302'], { keywords: [], rejected: [R('\u0301 \u0302', 'no_letter_or_digit')] });
        expectExact(['\u20d0\u20d1'], { keywords: [], rejected: [R('\u20d0\u20d1', 'no_letter_or_digit')] });
    });

    it('a letter plus a combining mark composes under NFKC to one code point and is rejected as too_short', () => {
        expectExact(['a\u0301'], { keywords: [], rejected: [R('a\u0301', 'too_short')] });
        expectExact(['e\u0301'], { keywords: [], rejected: [R('e\u0301', 'too_short')] });
    });

    it('lone surrogates never become a keyword: every string that contains one is rejected as invalid_unicode', () => {
        expectExact(['\ud800'], { keywords: [], rejected: [R('\ud800', 'invalid_unicode')] });
        expectExact(['\udc00'], { keywords: [], rejected: [R('\udc00', 'invalid_unicode')] });
        expectExact(['\ud800\ud800'], { keywords: [], rejected: [R('\ud800\ud800', 'invalid_unicode')] });
        expectExact(['\udc00\ud800'], { keywords: [], rejected: [R('\udc00\ud800', 'invalid_unicode')] });
        expectExact(['ab\ud83d'], { keywords: [], rejected: [R('ab\ud83d', 'invalid_unicode')] });
        expectExact(['\ude00ab'], { keywords: [], rejected: [R('\ude00ab', 'invalid_unicode')] });
    });

    it('a valid surrogate pair is one code point: a single astral letter is too_short, a pair of emoji has no letter', () => {
        expectExact(['\u{10000}'], { keywords: [], rejected: [R('\u{10000}', 'too_short')] });
        expectExact(['\u{1f600}\u{1f600}'], { keywords: [], rejected: [R('\u{1f600}\u{1f600}', 'no_letter_or_digit')] });
    });
});

describe('PART 1 named cases: length limits', () => {
    it('a 201-code-point string is rejected as too_long, with a log-safe 60-character preview', () => {
        expectExact(['x'.repeat(201)], { keywords: [], rejected: [R(`${'x'.repeat(57)}...`, 'too_long')] });
    });

    it('a 200-code-point string is accepted (the boundary)', () => {
        expectExact(['x'.repeat(200)], { keywords: ['x'.repeat(200)], rejected: [] });
    });

    it('length is counted in code points: 201 astral letters are too_long, 200 astral letters are accepted', () => {
        expectReasons(['\u{20000}'.repeat(201)], [], ['too_long']);
        expectReasons(['\u{20000}'.repeat(200)], ['\u{20000}'.repeat(200)], []);
    });

    it('length is measured after normalisation: 200 letters padded with zero-width characters and spaces are accepted', () => {
        expectReasons([` \u200b${'x'.repeat(200)}\u200b `], ['x'.repeat(200)], []);
        expectReasons([`${'x'.repeat(100)} ${'x'.repeat(100)}`], [], ['too_long']);
    });
});

describe('PART 1 named cases: 501 entries and the 500 cap', () => {
    const keyword = (i: number): string => `keyword-${i}`;

    it('501 distinct valid entries: the first 500 are accepted in order, the 501st is rejected as over_limit', () => {
        const input = Array.from({ length: 501 }, (_, i) => keyword(i));
        const list = sanitizeKeywordList(input);
        expect(list.keywords).toEqual(input.slice(0, 500));
        expect(list.needles).toEqual(input.slice(0, 500));
        expect(list.rejected).toEqual([R('keyword-500', 'over_limit')]);
        expect(list.malformedContainer).toBe(false);
    });

    it('600 distinct valid entries: exactly 500 accepted, exactly 100 over_limit', () => {
        const input = Array.from({ length: 600 }, (_, i) => keyword(i));
        const list = sanitizeKeywordList(input);
        expect(list.keywords).toHaveLength(MAX_KEYWORDS);
        expect(list.rejected).toHaveLength(100);
        expect(list.rejected.every((r) => r.reason === 'over_limit')).toBe(true);
        expect(list.rejected.map((r) => r.value)).toEqual(input.slice(500));
    });

    it('501 empty entries: no keyword, 501 rejections', () => {
        const list = sanitizeKeywordList(Array.from({ length: 501 }, () => ''));
        expect(list.keywords).toEqual([]);
        expect(list.rejected).toHaveLength(501);
        expect(list.rejected.every((r) => r.reason === 'empty_after_normalisation')).toBe(true);
    });

    it('501 copies of the same keyword: one accepted, 500 duplicates (never over_limit)', () => {
        const list = sanitizeKeywordList(Array.from({ length: 501 }, () => 'ab'));
        expect(list.keywords).toEqual(['ab']);
        expect(list.rejected).toHaveLength(500);
        expect(list.rejected.every((r) => r.reason === 'duplicate')).toBe(true);
    });

    it('a duplicate of an accepted keyword is a duplicate, not over_limit, even when the list is already full', () => {
        const input = [...Array.from({ length: 500 }, (_, i) => keyword(i)), 'KEYWORD-3', 'keyword-500'];
        const list = sanitizeKeywordList(input);
        expect(list.rejected).toEqual([R('KEYWORD-3', 'duplicate'), R('keyword-500', 'over_limit')]);
    });

    it('the same 501 entries as a bare comma-separated string are capped the same way', () => {
        const list = sanitizeKeywordList(Array.from({ length: 501 }, (_, i) => keyword(i)).join(','));
        expect(list.keywords).toHaveLength(MAX_KEYWORDS);
        expect(list.rejected).toEqual([R('keyword-500', 'over_limit')]);
    });
});

describe('PART 1 named cases: mixed arrays, duplicates and prototype-polluting strings', () => {
    it('a mixed array of valid and invalid entries keeps the valid ones in order and explains every rejection', () => {
        const input: unknown[] = ['Acme', '', 'a', 'Globex Corp', null, 42, '--', 'acme', '  Initech  ', '\u200b', {}, 'ab\u200bcd', 'ACME'];
        expectExact(input, {
            keywords: ['Acme', 'Globex Corp', 'Initech', 'abcd'],
            rejected: [
                R('', 'empty_after_normalisation'),
                R('a', 'too_short'),
                RT('[null]'),
                RT('[number]'),
                R('--', 'no_letter_or_digit'),
                R('acme', 'duplicate'),
                R('\u200b', 'empty_after_normalisation'),
                RT('[object]'),
                R('ACME', 'duplicate'),
            ],
        });
    });

    it('case-insensitive duplicates keep the FIRST spelling, including after NFKC (fullwidth) and whitespace folding', () => {
        const fullwidth = '\uff21\uff23\uff2d\uff25\u3000\uff23\uff2f\uff32\uff30';
        expectExact(['Acme Corp', 'ACME CORP', 'acme corp', 'AcMe  CoRp', fullwidth], {
            keywords: ['Acme Corp'],
            rejected: [R('ACME CORP', 'duplicate'), R('acme corp', 'duplicate'), R('AcMe  CoRp', 'duplicate'), R(fullwidth, 'duplicate')],
        });
        expectExact(['ACME', 'acme', 'Acme'], { keywords: ['ACME'], rejected: [R('acme', 'duplicate'), R('Acme', 'duplicate')] });
        expectExact(['acme', 'ACME'], { keywords: ['acme'], rejected: [R('ACME', 'duplicate')] });
    });

    it('"__proto__", "constructor", "prototype" and the other Object.prototype names are ordinary keywords: no pollution, no false duplicate', () => {
        const names = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'];
        const list = sanitizeKeywordList(names);
        expect(list.keywords).toEqual(names);
        expect(list.needles).toEqual(names.map((n) => n.toLowerCase()));
        expect(list.rejected).toEqual([]);
        expect(Object.getPrototypeOf(list)).toBe(Object.prototype);
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_KEYS);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(findKeywordMatch('the __proto__ chain', list)).toBe('__proto__');
        expect(findKeywordMatch('A CONSTRUCTOR call', list)).toBe('constructor');
        expect(findKeywordMatch('nothing relevant here', list)).toBeNull();
    });

    it('prototype-name duplicates are detected as duplicates, case-insensitively', () => {
        expectExact(['__proto__', '__PROTO__', 'constructor', 'Constructor', 'CONSTRUCTOR'], {
            keywords: ['__proto__', 'constructor'],
            rejected: [R('__PROTO__', 'duplicate'), R('Constructor', 'duplicate'), R('CONSTRUCTOR', 'duplicate')],
        });
    });

    it('a bare string of prototype names is split like any other bare string', () => {
        expectExact('__proto__,constructor;toString\nhasOwnProperty', { keywords: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'], rejected: [] });
    });

    it('a JSON-parsed object carrying "__proto__" and "constructor" is a malformed container and pollutes nothing', () => {
        const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as unknown;
        expectExact(hostile, { keywords: [], rejected: [], malformedContainer: true });
        const asElement = sanitizeKeywordList([hostile]);
        expect(asElement.keywords).toEqual([]);
        expect(asElement.rejected.map((r) => r.reason)).toEqual(['not_a_string']);
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_KEYS);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('PART 1 constants and exported helpers', () => {
    it('the documented limits are 2, 200 and 500', () => {
        expect([MIN_KEYWORD_LENGTH, MAX_KEYWORD_LENGTH, MAX_KEYWORDS]).toEqual([2, 200, 500]);
    });

    it('normaliseKeyword matches the documented examples', () => {
        expect(normaliseKeyword('  Acme \t  Corp \n')).toBe('Acme Corp');
        expect(normaliseKeyword('\uff21\uff43\uff4d\uff45')).toBe('Acme');
        expect(normaliseKeyword('A\u200bcme')).toBe('Acme');
        expect(normaliseKeyword('a\nb')).toBe('a b');
        expect(normaliseKeyword('a\u001fb')).toBe('ab');
    });
});

// ---------------------------------------------------------------------------------------------------------------
// PART 2 - generated inputs
// ---------------------------------------------------------------------------------------------------------------

type CaseKind = 'array' | 'dupArray' | 'bareString' | 'scalar' | 'longString' | 'hugeArray';

interface FuzzCase {
    index: number;
    kind: CaseKind;
    input: unknown;
}

const CASE_PLAN: ReadonlyArray<readonly [CaseKind, number]> = [
    ['array', 11_000],
    ['dupArray', 2_000],
    ['bareString', 8_000],
    ['scalar', 3_000],
    ['longString', 200],
    ['hugeArray', 200],
];

const SEPARATORS = [',', ';', '\n', '\r\n', ', ', ' ; ', ',,', '\n\n', ' , ', ';\n'];

function nonString(rng: Rng): unknown {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const makers: Array<() => unknown> = [
        () => null,
        () => undefined,
        () => rng.pick([0, 1, -1, 3.14, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]),
        () => rng.chance(0.5),
        () => ({}),
        () => [],
        () => ['ab'],
        () => ({ a: 'ab' }),
        () => [['ab']],
        () => 12n,
        () => Symbol('ab'),
        () => () => 'ab',
        () => new Date(0),
        () => new String('ab'),
        () => ({ toString: () => 'ab' }),
        () => Object.create(null) as unknown,
        () => circular,
    ];
    return rng.pick(makers)();
}

function variantOf(rng: Rng, base: string): string {
    return dress(rng, base, HOSTILE_POOLS);
}

function genEntry(rng: Rng, seen: string[]): unknown {
    const roll = rng.float();
    let entry: unknown;
    if (roll < 0.3) entry = dress(rng, randomPhrase(rng), HOSTILE_POOLS);
    else if (roll < 0.4) entry = randomText(rng, HOSTILE_POOLS, 12);
    else if (roll < 0.46) entry = randomRun(rng, ALPHABETS.asciiPunctuation, 1, 8);
    else if (roll < 0.52) entry = randomText(rng, [[1, ALPHABETS.whitespace], [1, ALPHABETS.zeroWidth], [1, ALPHABETS.bidi], [1, ALPHABETS.controls]], 8);
    else if (roll < 0.58) entry = dress(rng, rng.pick(rng.pick(WORD_POOLS)), HOSTILE_POOLS);
    else if (roll < 0.62) entry = `${rng.pick(rng.pick(WORD_POOLS)).repeat(rng.range(197, 204))}`;
    else if (roll < 0.72 && seen.length > 0) entry = variantOf(rng, rng.pick(seen));
    else if (roll < 0.8) entry = nonString(rng);
    else if (roll < 0.86) entry = rng.pick(['', ' ', '  ', '\t', '\n', 'a', 'A', '-', '.']);
    else entry = randomWord(rng, 2, 12);
    if (typeof entry === 'string') seen.push(entry);
    return entry;
}

function genStringEntry(rng: Rng, seen: string[]): string {
    const entry = genEntry(rng, seen);
    return typeof entry === 'string' ? entry : randomWord(rng, 2, 8);
}

function genScalar(rng: Rng): unknown {
    const makers: Array<() => unknown> = [
        () => null,
        () => undefined,
        () => '',
        () => randomRun(rng, ALPHABETS.whitespace, 1, 6),
        () => rng.pick(['a', 'x', 'ab', 'Acme']),
        () => rng.pick([0, 1, -1, 3.14, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER]),
        () => rng.chance(0.5),
        () => ({}),
        () => ({ a: 1, b: 'ab' }),
        () => ({ watchlistNames: ['ab'] }),
        () => [['ab']],
        () => [[['ab']]],
        () => () => 'ab',
        () => Symbol('ab'),
        () => 10n,
        () => new Date(0),
        () => new Map([['ab', 'ab']]),
        () => new Set(['ab']),
        () => new String('ab'),
        () => new Uint8Array([97, 98]),
        () => JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
        () => new Array(rng.range(0, 6)) as unknown[],
        () => Object.create(null) as unknown,
    ];
    return rng.pick(makers)();
}

function genLongString(rng: Rng): string {
    const target = rng.range(2_000, 30_000);
    const kind = rng.int(6);
    if (kind === 0) {
        const unit = randomWord(rng, 3, 9);
        return unit.repeat(Math.ceil(target / unit.length));
    }
    const parts: string[] = [];
    let size = 0;
    const push = (piece: string): void => {
        parts.push(piece);
        size += piece.length;
    };
    while (size < target) {
        if (kind === 1) push(`${randomPhrase(rng)}${rng.pick(SEPARATORS)}`);
        else if (kind === 2) push(randomRun(rng, [...ALPHABETS.whitespace, ...DOCUMENTED_ZERO_WIDTH, ...ALPHABETS.bidi], 50, 400));
        else if (kind === 3) push(randomRun(rng, ALPHABETS.asciiPunctuation, 50, 400));
        else if (kind === 4) push(`${rng.pick(LATIN)}${rng.pick([',', ';', '\n'])}`);
        else push(randomText(rng, HOSTILE_POOLS, 40));
    }
    if (kind === 2 && rng.chance(0.5)) parts.splice(rng.range(0, parts.length), 0, ` ${randomWord(rng, 3, 8)} `);
    return parts.join('');
}

function genInput(kind: CaseKind, rng: Rng): unknown {
    const seen: string[] = [];
    switch (kind) {
        case 'array': {
            const len = rng.chance(0.15) ? 0 : rng.range(1, rng.chance(0.8) ? 8 : 40);
            return Array.from({ length: len }, () => genEntry(rng, seen));
        }
        case 'dupArray': {
            const base = Array.from({ length: rng.range(1, 6) }, () => randomPhrase(rng));
            const len = rng.range(6, 30);
            return Array.from({ length: len }, () => (rng.chance(0.85) ? variantOf(rng, rng.pick(base)) : genEntry(rng, seen)));
        }
        case 'bareString': {
            const pieces = Array.from({ length: rng.range(1, 15) }, () => genStringEntry(rng, seen));
            let out = rng.chance(0.2) ? rng.pick(SEPARATORS) : '';
            pieces.forEach((piece, i) => {
                out += piece;
                if (i < pieces.length - 1 || rng.chance(0.3)) out += rng.pick(SEPARATORS);
            });
            return out;
        }
        case 'scalar':
            return genScalar(rng);
        case 'longString':
            return genLongString(rng);
        case 'hugeArray': {
            const len = rng.range(501, 1_600);
            const distinct = rng.chance(0.7) ? len : rng.range(100, 600);
            return Array.from({ length: len }, () => (rng.chance(0.1) ? genEntry(rng, seen) : dress(rng, `kw-${rng.int(distinct)}-${rng.pick(LATIN)}${rng.pick(LATIN)}`, HOSTILE_POOLS)));
        }
    }
}

function buildCases(): FuzzCase[] {
    const cases: FuzzCase[] = [];
    let index = 0;
    for (const [kind, count] of CASE_PLAN) {
        for (let i = 0; i < count; i += 1) {
            cases.push({ index, kind, input: genInput(kind, makeRng(caseSeed(index))) });
            index += 1;
        }
    }
    return cases;
}

/** A haystack that contains `keyword` under the usual mangling (case, whitespace, removable noise) inside hostile text. */
function plant(rng: Rng, keyword: string): string {
    let text = keyword;
    const caseRoll = rng.float();
    if (caseRoll < 0.3) text = text.toUpperCase();
    else if (caseRoll < 0.6) text = text.toLowerCase();
    if (rng.chance(0.3)) text = text.replace(/ /gu, () => randomRun(rng, ALPHABETS.whitespace, 1, 3));
    if (rng.chance(0.3)) text = insertNoise(rng, text, REMOVABLE_NOISE_POOLS, rng.range(1, 3));
    return `${randomText(rng, HOSTILE_POOLS, 12)}${rng.chance(0.5) ? ' ' : ''}${text}${rng.chance(0.5) ? ' ' : ''}${randomText(rng, HOSTILE_POOLS, 12)}`;
}

const SPECIAL_HAYSTACKS: unknown[] = [null, undefined, '', ' ', '\u200b', 'a', 123, {}, [], true, 'x'.repeat(5_000), Symbol('a'), 10n, '\ud800', '\u2028'];

function genHaystacks(index: number, keywords: string[]): unknown[] {
    const rng = makeRng(caseSeed(index, 0xabcdef));
    const planted = keywords.length > 0 ? plant(rng, rng.pick(keywords)) : randomText(rng, HOSTILE_POOLS, 30);
    return [planted, randomText(rng, HOSTILE_POOLS, 30), SPECIAL_HAYSTACKS[index % SPECIAL_HAYSTACKS.length]];
}

interface CaseResult {
    fuzz: FuzzCase;
    prod: SanitizedKeywordList | undefined;
    threw: { error: unknown } | undefined;
    ref: RefResult;
    haystacks: unknown[];
}

let RUN: CaseResult[] | undefined;

function getRun(): CaseResult[] {
    if (RUN) return RUN;
    RUN = buildCases().map((fuzz) => {
        let prod: SanitizedKeywordList | undefined;
        let threw: { error: unknown } | undefined;
        try {
            prod = sanitizeKeywordList(fuzz.input);
        } catch (error) {
            threw = { error };
        }
        const ref = refSanitize(fuzz.input);
        return { fuzz, prod, threw, ref, haystacks: genHaystacks(fuzz.index, ref.keywords) };
    });
    return RUN;
}

function where(r: CaseResult): string {
    return `case #${r.fuzz.index} (${r.fuzz.kind}) input=${render(r.fuzz.input).slice(0, 100)}`;
}

const STRICT_INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
const ANY_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** With the `u` flag a surrogate PAIR is one astral code point; only an unpaired surrogate matches \p{Surrogate}. */
const LONE_SURROGATE = /\p{Surrogate}/u;

describe('PART 2 reference implementation self-checks', () => {
    beforeAll(() => {
        getRun();
    }, 120_000);

    it('the reference whitespace table equals the Unicode White_Space property over every code point', () => {
        const whiteSpace = /^\p{White_Space}$/u;
        for (let cp = 0; cp <= 0x10ffff; cp += 1) {
            const expected = whiteSpace.test(String.fromCodePoint(cp));
            const actual = REF_WHITESPACE.has(cp) || REF_LINE_BREAKS_AND_TABS.has(cp);
            if (expected !== actual) throw new Error(`reference whitespace table disagrees with White_Space at U+${cp.toString(16)}`);
        }
    });

    it('the reference removal table equals C0/C1 controls plus Default_Ignorable_Code_Point plus Bidi_Control over every code point', () => {
        const ignorable = /^[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]$/u;
        for (let cp = 0; cp <= 0x10ffff; cp += 1) {
            if (cp >= 0xd800 && cp <= 0xdfff) continue;
            const expected = cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || ignorable.test(String.fromCodePoint(cp));
            if (refIsRemoved(cp) !== expected) throw new Error(`reference removal table disagrees with the Unicode properties at U+${cp.toString(16)}`);
        }
    });

    it('the reference reproduces the worked examples of docs section 5.3', () => {
        expect(refClean('  Acme \t  Corp \n')).toBe('Acme Corp');
        expect(refClean('\uff21\uff43\uff4d\uff45')).toBe('Acme');
        expect(refClean('ab\u200bcd')).toBe('abcd');
        expect(refClean('\u200b a \u200b')).toBe('a');
        expect(refClean('a\nb')).toBe('a b');
        expect(refSanitize('Acme, Beta;Gamma\nDelta').keywords).toEqual(['Acme', 'Beta', 'Gamma', 'Delta']);
        expect(refSanitize(['', '   ', '--', 'a', null]).keywords).toEqual([]);
        expect(refSanitize(Array.from({ length: 501 }, (_, i) => `keyword-${i}`)).reasons).toEqual(['over_limit']);
    });

    it('the generated corpus holds at least 20,000 cases from a fixed seed', () => {
        const run = getRun();
        expect(run.length).toBeGreaterThanOrEqual(20_000);
        expect(run[15_000]?.fuzz.kind).toBe('bareString');
        expect(genInput('bareString', makeRng(caseSeed(15_000)))).toBe(run[15_000]?.fuzz.input);
        bump('generatedCases', run.length);
    });

    it('the corpus exercises every rejection reason, malformed containers, 500-capped lists, and both empty and non-empty accepted lists', () => {
        const run = getRun();
        const reasons = new Set<string>();
        let malformed = 0;
        let capped = 0;
        let nonEmpty = 0;
        let empty = 0;
        for (const r of run) {
            if (!r.prod) continue;
            for (const rejection of r.prod.rejected) reasons.add(rejection.reason);
            if (r.prod.malformedContainer) malformed += 1;
            if (r.prod.keywords.length === MAX_KEYWORDS) capped += 1;
            if (r.prod.keywords.length > 0) nonEmpty += 1;
            else empty += 1;
        }
        expect([...reasons].sort()).toEqual(['duplicate', 'empty_after_normalisation', 'invalid_unicode', 'no_letter_or_digit', 'not_a_string', 'over_limit', 'single_letter_or_digit', 'too_long', 'too_short']);
        expect(malformed).toBeGreaterThan(1_000);
        expect(capped).toBeGreaterThan(100);
        expect(nonEmpty).toBeGreaterThan(8_000);
        expect(empty).toBeGreaterThan(3_000);
        bump('coverage.malformedContainers', malformed);
        bump('coverage.cappedLists', capped);
        bump('coverage.nonEmptyAccepted', nonEmpty);
        bump('coverage.emptyAccepted', empty);
    });
});

describe('PART 2 property tests over hostile generated inputs', () => {
    beforeAll(() => {
        getRun();
    }, 120_000);

    it('P1 sanitizeKeywordList, findKeywordMatch and describeSanitization never throw on any generated input', () => {
        const v = new Violations();
        for (const r of getRun()) {
            bump('P1.cases');
            const threw = r.threw;
            if (threw) {
                v.add(() => `${where(r)} threw ${String(threw.error)}`);
                continue;
            }
            const prod = r.prod as SanitizedKeywordList;
            try {
                describeSanitization(prod);
                for (const haystack of r.haystacks) {
                    findKeywordMatch(haystack, prod);
                    bump('P1.haystacks');
                }
            } catch (error) {
                v.add(() => `${where(r)} follow-up call threw ${String(error)}`);
            }
        }
        expectNoViolations(v, 'P1');
    });

    it('P2a every accepted keyword is a string of 2..200 code points', () => {
        const v = new Violations();
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2a.keywords');
                const n = typeof k === 'string' ? codePoints(k) : -1;
                if (n < MIN_KEYWORD_LENGTH || n > MAX_KEYWORD_LENGTH) v.add(() => `${where(r)} accepted '${esc(String(k))}' with ${n} code points`);
            }
        }
        expectNoViolations(v, 'P2a');
    });

    it('P2b every accepted keyword contains at least one letter or number', () => {
        const v = new Violations();
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2b.keywords');
                if (!LETTER_OR_NUMBER.test(k)) v.add(() => `${where(r)} accepted '${esc(k)}'`);
            }
        }
        expectNoViolations(v, 'P2b');
    });

    it('P2c no accepted keyword contains a control character, a line or paragraph separator, or a documented zero-width or bidi character', () => {
        const v = new Violations();
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2c.keywords');
                if (ANY_CONTROL.test(k) || [...k].some((ch) => refIsRemoved(ch.codePointAt(0) as number))) v.add(() => `${where(r)} accepted '${esc(k)}'`);
            }
        }
        expectNoViolations(v, 'P2c');
    });

    it('P2d no accepted keyword has a leading or trailing space, a double space, or any whitespace other than a single U+0020', () => {
        const v = new Violations();
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2d.keywords');
                const stray = [...k].some((ch) => ch !== ' ' && /\p{White_Space}/u.test(ch));
                if (k !== k.trim() || k.startsWith(' ') || k.endsWith(' ') || k.includes('  ') || stray) v.add(() => `${where(r)} accepted '${esc(k)}'`);
            }
        }
        expectNoViolations(v, 'P2d');
    });

    it('P2e (strict) no accepted keyword contains an invisible character: Unicode Default_Ignorable_Code_Point or Bidi_Control', () => {
        const v = new Violations();
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2e.keywords');
                if (STRICT_INVISIBLE.test(k)) v.add(() => `${where(r)} accepted '${esc(k)}'`);
            }
        }
        bump('P2e.violations', v.count);
        expectNoViolations(v, 'P2e');
    });

    it('P2f (strict) no accepted keyword contains a lone surrogate: every keyword is well-formed UTF-16', () => {
        const v = new Violations();
        let violating = 0;
        for (const r of getRun()) {
            for (const k of r.prod?.keywords ?? []) {
                bump('P2f.keywords');
                if (LONE_SURROGATE.test(k)) {
                    violating += 1;
                    v.add(() => `${where(r)} accepted '${esc(k)}'`);
                }
            }
        }
        bump('P2f.violations', violating);
        expectNoViolations(v, 'P2f');
    });

    it('P3 accepted keywords are unique case-insensitively and the FIRST spelling is the one kept', () => {
        const v = new Violations();
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            bump('P3.cases');
            const keys = list.keywords.map((k) => k.toLowerCase());
            if (new Set(keys).size !== keys.length) v.add(() => `${where(r)} kept two spellings of one keyword: ${render(list.keywords)}`);
            if (JSON.stringify(list.needles) !== JSON.stringify(keys)) v.add(() => `${where(r)} needles are not the lower-cased keywords`);
            list.keywords.forEach((k) => {
                if (r.ref.firstValid.get(k.toLowerCase()) !== k) v.add(() => `${where(r)} kept '${esc(k)}' but the first valid spelling was '${esc(r.ref.firstValid.get(k.toLowerCase()) ?? '')}'`);
            });
        }
        expectNoViolations(v, 'P3');
    });

    it('P4 at most 500 keywords are accepted, and exactly min(500, distinct valid) are', () => {
        const v = new Violations();
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            bump('P4.cases');
            const expected = Math.min(MAX_KEYWORDS, r.ref.firstValid.size);
            if (list.keywords.length > MAX_KEYWORDS || list.needles.length !== list.keywords.length || list.keywords.length !== expected) {
                v.add(() => `${where(r)} accepted ${list.keywords.length} (needles ${list.needles.length}), expected ${expected}`);
            }
        }
        expectNoViolations(v, 'P4');
    });

    it('P5 (strict) sanitising the accepted list again returns it unchanged', () => {
        const v = new Violations();
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            bump('P5.cases');
            const again = sanitizeKeywordList(list.keywords);
            if (JSON.stringify(again.keywords) !== JSON.stringify(list.keywords) || JSON.stringify(again.needles) !== JSON.stringify(list.needles) || again.rejected.length !== 0) {
                v.add(() => `${where(r)} first pass ${render(list.keywords)} second pass ${render(again.keywords)} (${again.rejected.length} rejected)`);
            }
        }
        bump('P5.violations', v.count);
        expectNoViolations(v, 'P5');
    });

    it('P6 the accepted keywords appear in the order of the input candidates that produced them', () => {
        const v = new Violations();
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            bump('P6.cases');
            const candidates = refCandidates(r.fuzz.input)?.items ?? [];
            let next = 0;
            for (const candidate of candidates) {
                if (next < list.keywords.length && typeof candidate === 'string' && refClean(candidate) === list.keywords[next]) next += 1;
            }
            if (next !== list.keywords.length) v.add(() => `${where(r)} accepted ${render(list.keywords)} which is not an in-order subsequence of the input`);
        }
        expectNoViolations(v, 'P6');
    });

    it('P7a findKeywordMatch returns null for an empty list and ANY haystack (null, undefined, empty, huge, wrong type)', () => {
        const v = new Violations();
        const handBuilt: SanitizedKeywordList[] = [
            { keywords: [], needles: [], rejected: [], malformedContainer: false },
            { keywords: ['ab', 'cd'], needles: [], rejected: [], malformedContainer: false },
            { keywords: [], needles: [], rejected: [{ value: 'x', reason: 'too_short' }], malformedContainer: true },
        ];
        let checks = 0;
        for (const list of handBuilt) {
            for (const haystack of HAYSTACK_BATTERY) {
                bump('P7a.checks');
                checks += 1;
                if (findKeywordMatch(haystack, list) !== null) v.add(() => `hand-built empty list matched ${render(haystack)}`);
            }
        }
        for (const r of getRun()) {
            const list = r.prod;
            if (!list || list.keywords.length > 0) continue;
            for (const haystack of [...r.haystacks, ...HAYSTACK_BATTERY]) {
                bump('P7a.checks');
                checks += 1;
                if (findKeywordMatch(haystack, list) !== null || matchesAnyKeyword(haystack, list)) v.add(() => `${where(r)} matched ${render(haystack)}`);
            }
        }
        expectNoViolations(v, 'P7a');
        expect(checks).toBeGreaterThan(5_000);
    });

    it('P7c a hand-built list with empty, blank or one-character needles cannot match them, but its valid needle still matches', () => {
        const handBuilt: SanitizedKeywordList = { keywords: ['', ' ', 'a', 'Acme'], needles: ['', ' ', 'a', 'acme'], rejected: [], malformedContainer: false };
        for (const haystack of ['', ' ', 'a', 'banana', 'x y', '\u200b', 'Globex', 'a b a']) {
            expect(findKeywordMatch(haystack, handBuilt), render(haystack)).toBeNull();
            bump('P7c.checks');
        }
        expect(findKeywordMatch('ACME Corp', handBuilt)).toBe('Acme');
        const noNeedles: SanitizedKeywordList = { keywords: ['Acme'], needles: [], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('ACME Corp', noNeedles)).toBeNull();
    });

    it('P7b a returned keyword is in the accepted list and really occurs in the normalised, lower-cased haystack', () => {
        const v = new Violations();
        let matches = 0;
        let checks = 0;
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            for (const haystack of r.haystacks) {
                checks += 1;
                const found = findKeywordMatch(haystack, list);
                if (found === null) continue;
                matches += 1;
                const at = list.keywords.indexOf(found);
                const text = typeof haystack === 'string' ? refClean(haystack).toLowerCase() : '';
                if (at < 0 || typeof haystack !== 'string' || !text.includes(list.needles[at] as string)) {
                    v.add(() => `${where(r)} returned '${esc(found)}' for ${render(haystack)}`);
                }
            }
        }
        bump('P7b.checks', checks);
        bump('P7b.matches', matches);
        expectNoViolations(v, 'P7b');
        expect(matches).toBeGreaterThan(3_000);
    });

    it('P8 differential: sanitizeKeywordList agrees with the independent reference on keywords, needles, rejection reasons and container flag, for every case', () => {
        const v = new Violations();
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            bump('P8.sanitize.cases');
            const reasons = list.rejected.map((x) => x.reason);
            if (
                JSON.stringify(list.keywords) !== JSON.stringify(r.ref.keywords) ||
                JSON.stringify(list.needles) !== JSON.stringify(r.ref.needles) ||
                JSON.stringify(reasons) !== JSON.stringify(r.ref.reasons) ||
                list.malformedContainer !== r.ref.malformed
            ) {
                v.add(() => `${where(r)} production ${render(list.keywords)} / ${reasons.length} rejections, reference ${render(r.ref.keywords)} / ${r.ref.reasons.length} rejections`);
            }
        }
        expectNoViolations(v, 'P8 sanitize');
    });

    it('P8 differential: findKeywordMatch agrees with the reference matcher on every generated haystack, including all misses', () => {
        const v = new Violations();
        let hits = 0;
        for (const r of getRun()) {
            const list = r.prod;
            if (!list) continue;
            for (const haystack of r.haystacks) {
                bump('P8.find.checks');
                const actual = findKeywordMatch(haystack, list);
                const expected = refFind(haystack, r.ref);
                if (expected !== null) hits += 1;
                if (actual !== expected) v.add(() => `${where(r)} haystack ${render(haystack)}: production ${render(actual)}, reference ${render(expected)}`);
            }
        }
        bump('P8.find.referenceHits', hits);
        expectNoViolations(v, 'P8 find');
        expect(hits).toBeGreaterThan(3_000);
    });

    it('P2-P8 are not vacuous: the accepted lists and the haystacks the properties range over are large', () => {
        const run = getRun();
        const keywords = run.reduce((sum, r) => sum + (r.prod?.keywords.length ?? 0), 0);
        const haystacks = run.reduce((sum, r) => sum + r.haystacks.length, 0);
        expect(run.length).toBeGreaterThanOrEqual(20_000);
        expect(keywords).toBeGreaterThan(50_000);
        expect(haystacks).toBeGreaterThan(60_000);
    });
});

describe('PART 2 regression tests for the guard defects found by this suite (all fixed in lib/_guards.ts)', () => {
    it('D1 a single visible character plus a default-ignorable character must not pass the 2 code point minimum', () => {
        const inputs = ['a\ufe0f', 'a\u034f', 'a\u180e', 'a\u{e0041}', 'a\u061c', 'a\u115f', 'a\u17b4'];
        const accepted = inputs.filter((input) => sanitizeKeywordList([input]).keywords.length > 0).map((input) => esc(input));
        expect(accepted, 'inputs accepted although only ONE visible character survives').toEqual([]);
    });

    it('D2 a keyword made only of invisible letters (Hangul fillers) must be rejected', () => {
        const inputs = ['\u3164\u3164', '\u115f\u1160', '\uffa0\uffa0', '\u1160\u1160'];
        const accepted = inputs.filter((input) => sanitizeKeywordList([input]).keywords.some((k) => ![...k].some((ch) => LETTER_OR_NUMBER.test(ch) && !STRICT_INVISIBLE.test(ch)))).map((input) => esc(input));
        expect(accepted, 'inputs accepted although no visible letter or number survives').toEqual([]);
    });

    it('D3 normalisation is a fixpoint: a keyword accepted once is accepted unchanged when sanitised again', () => {
        const inputs = ['e\u200b\u0301', '\u1100\u200b\u1161', 'a\u200b\u0308\u200b\u0301'];
        const unstable = inputs
            .filter((input) => {
                const first = sanitizeKeywordList([input]).keywords;
                return JSON.stringify(sanitizeKeywordList(first).keywords) !== JSON.stringify(first);
            })
            .map((input) => esc(input));
        expect(unstable, 'inputs whose accepted keyword changes (or disappears) on a second pass').toEqual([]);
    });

    it('D4 an Arabic letter mark (a bidi control) is removed like the other bidi marks', () => {
        const list = sanitizeKeywordList(['\u061cab\u061c']);
        expect(list.keywords.map((k) => esc(k))).toEqual(['ab']);
        expect(findKeywordMatch('ac\u{61c}me', sanitizeKeywordList(['acme'])), 'a haystack with an Arabic letter mark inside the name is a hit once the mark is removed').toBe('acme');
    });

    it('D6 a lone surrogate inside a keyword must not let it match half of an emoji', () => {
        const accepted = sanitizeKeywordList(['ab\ud83d', '\ude00ab']);
        const hits = [findKeywordMatch('ab\u{1f600}', accepted), findKeywordMatch('\u{1f600}ab', accepted)].map((hit) => (hit === null ? null : esc(hit)));
        expect(hits, 'keywords ending or starting with a lone surrogate matched code-point-aligned text that does not contain them').toEqual([null, null]);
    });

    it('D5 sanitizeKeywordList never throws, even for an in-process value whose inspection throws (revoked or hostile Proxy)', () => {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const hostile = new Proxy({}, { get: () => { throw new Error('trap'); }, ownKeys: () => { throw new Error('trap'); } });
        expect(() => sanitizeKeywordList([revoked.proxy])).not.toThrow();
        expect(() => sanitizeKeywordList([hostile])).not.toThrow();
    });

    it('D5b a container that cannot be inspected disables the watchlist instead of throwing', () => {
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        const trap = new Proxy([], { get: () => { throw new Error('trap'); } });
        for (const container of [revoked.proxy, trap]) {
            const list = sanitizeKeywordList(container);
            expect(list.keywords).toEqual([]);
            expect(list.needles).toEqual([]);
            expect(list.malformedContainer).toBe(true);
            expectNeverMatches(list);
        }
    });

    it('D7 a keyword is bounded to 4,096 UTF-16 units BEFORE normalisation, exactly at the boundary', () => {
        expectExact([`ab${'\u200b'.repeat(4094)}`], { keywords: ['ab'], rejected: [] });
        const over = sanitizeKeywordList([`ab${'\u200b'.repeat(4095)}`]);
        expect(over.keywords).toEqual([]);
        expect(over.rejected.map((r) => r.reason)).toEqual(['too_long']);
    });

    it('D7b adversarial combining marks cannot burn CPU: String.prototype.normalize is quadratic (80,000 units take seconds), so the guard never feeds it more than 4,096 units per keyword or 8,192 per haystack', () => {
        const marks = `a${'\u0301\u0316'.repeat(40_000)}`;
        const started = performance.now();
        const list = sanitizeKeywordList([marks, marks, marks]);
        expect(list.keywords).toEqual([]);
        expect(list.rejected.map((r) => r.reason)).toEqual(['too_long', 'too_long', 'too_long']);
        const accepted = sanitizeKeywordList(['acme']);
        expect(findKeywordMatch(marks, accepted)).toBeNull();
        expect(findKeywordMatch(`${marks}${marks}${marks}`.repeat(4), accepted)).toBeNull();
        const bare = sanitizeKeywordList(marks.repeat(10));
        expect(bare.keywords).toEqual([]);
        expect(performance.now() - started, 'six hostile inputs of 80,000 to 3,840,000 units').toBeLessThan(1_000);
    });

    it('D7c only the first 8,192 units of a haystack are searched: a keyword inside is found, one beyond is not, and neither costs more than a few milliseconds', () => {
        const accepted = sanitizeKeywordList(['acme corp']);
        const filler = 'x '.repeat(4_000);
        expect(findKeywordMatch(`acme corp ${filler}${'y '.repeat(200_000)}`, accepted)).toBe('acme corp');
        expect(findKeywordMatch(`${filler}${filler}acme corp`, accepted), 'a keyword after 16,000 units is outside the searched window').toBeNull();
        expect(findKeywordMatch(`${'x'.repeat(8_190)}acme corp`, accepted)).toBeNull();
    });

    it('D8 at most 5,000 entries are inspected: a valid keyword at index 5,000 or later is never accepted, and the rest is ONE over_limit entry', () => {
        const entries = Array.from({ length: 5_000 }, (_, i) => `entry ${i}`);
        const list = sanitizeKeywordList([...entries, 'late keyword', 'later keyword']);
        expect(list.keywords).toHaveLength(500);
        expect(list.keywords).not.toContain('late keyword');
        expect(list.rejected).toHaveLength(4_500 + 1);
        expect(list.rejected.at(-1)).toEqual({ value: '(2 further entries not inspected)', reason: 'over_limit' });
        expect(findKeywordMatch('a late keyword here', list)).toBeNull();
    });

    it('D8b a bare string is cut to 200,000 units before it is split, so a 9 MB paste cannot create millions of entries', () => {
        const paste = 'ab,'.repeat(3_000_000);
        const started = performance.now();
        const list = sanitizeKeywordList(paste);
        expect(list.keywords).toEqual(['ab']);
        expect(list.rejected.length).toBeLessThanOrEqual(5_001);
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('D9 every string with a lone surrogate is rejected as invalid_unicode and a well-formed astral pair is accepted', () => {
        expectExact(['a\ud83db'], { keywords: [], rejected: [R('a\ud83db', 'invalid_unicode')] });
        expectExact(['a\ude00b'], { keywords: [], rejected: [R('a\ude00b', 'invalid_unicode')] });
        const pair = sanitizeKeywordList(['a\u{1f600}b']);
        expect(pair.keywords).toEqual(['a\u{1f600}b']);
        expect(findKeywordMatch('xx A\u{1f600}B yy', pair)).toBe('a\u{1f600}b');
    });

    it('D10 an invisible character can be neither the whole keyword nor the second code point of one', () => {
        for (const invisible of ['\u3164', '\u115f', '\u1160', '\uffa0', '\u061c', '\u034f', '\u17b4', '\u180e', '\u{e0041}', '\ufe0f', '\u2062', '\u{1d173}']) {
            expectExact([`${invisible}${invisible}`], { keywords: [], rejected: [R(`${invisible}${invisible}`, 'empty_after_normalisation')] });
            expectExact([`a${invisible}`], { keywords: [], rejected: [R(`a${invisible}`, 'too_short')] });
            expect(sanitizeKeywordList([`ab${invisible}cd`]).keywords, `ab${esc(invisible)}cd`).toEqual(['abcd']);
        }
    });

    it('D11 a run of more than 16 consecutive combining marks: a KEYWORD with one is rejected, a HAYSTACK keeps the first 16 marks of the run (one hostile field must not hide a whole record), exactly at the boundary', () => {
        const marks = (n: number): string => '\u0301'.repeat(n);
        expect(sanitizeKeywordList([`ab${marks(16)}`]).keywords).toEqual([`ab${marks(16)}`]);
        const over = sanitizeKeywordList([`ab${marks(17)}`]);
        expect(over.keywords).toEqual([]);
        expect(over.rejected.map((r) => r.reason)).toEqual(['empty_after_normalisation']);
        const acme = sanitizeKeywordList(['acme']);
        expect(findKeywordMatch(`acme ${marks(16)}`, acme)).toBe('acme');
        // the run is cut, the name beside it is still found, in either order and with the run in the middle
        expect(findKeywordMatch(`acme ${marks(17)}`, acme)).toBe('acme');
        expect(findKeywordMatch(`${marks(500)} acme`, acme)).toBe('acme');
        expect(findKeywordMatch(`ac${marks(40)}me acme`, acme)).toBe('acme');
        // two runs of 9 marks that only join once the invisible character between them is removed make one run of 18
        expect(findKeywordMatch(`acme ${'\u200b'.repeat(3)}${marks(9)}\u200b${marks(9)}`, acme)).toBe('acme');
        // glued to the last letter the marks compose with it ('e' + U+0301 is 'é'), so the keyword is not in the text
        expect(findKeywordMatch(`acme${'\u200b'.repeat(3)}${marks(9)}\u200b${marks(9)}`, acme)).toBeNull();
        // runs separated by a letter are separate runs
        expect(findKeywordMatch(`acme ${`x${marks(16)}`.repeat(50)}`, acme)).toBe('acme');
        // cutting a run cannot invent a hit: the accent stays on the letter, so 'cafe' is not in 'cafe' + marks
        expect(findKeywordMatch(`cafe${marks(30)}`, sanitizeKeywordList(['cafe']))).toBeNull();
    });

    it('D11b the quadratic-reordering attack costs milliseconds: 5,000 entries of two letters and 4,090 marks of descending combining class', () => {
        const run = (n: number): string => '\u0345'.repeat(Math.floor(n / 3)) + '\u0300'.repeat(Math.floor(n / 3)) + '\u0316'.repeat(n - 2 * Math.floor(n / 3));
        const entry = `ab${run(4090)}`;
        const started = performance.now();
        const list = sanitizeKeywordList(Array.from({ length: 5_000 }, () => entry));
        expect(list.keywords).toEqual([]);
        // 4,092 units each: 48 entries fit the 200,000-unit budget, the 49th crosses it and is not inspected
        expect(list.rejected.filter((r) => r.reason === 'empty_after_normalisation')).toHaveLength(48);
        expect(list.rejected.at(-1)).toEqual({ value: '(4952 further entries not inspected)', reason: 'over_limit' });
        // the densest shape the run cap still allows: a letter followed by 16 marks, repeated to the raw cap
        const group = `a${'\u0345'.repeat(6)}${'\u0300'.repeat(5)}${'\u0316'.repeat(5)}`;
        const dense = group.repeat(Math.floor(4_096 / group.length));
        sanitizeKeywordList(Array.from({ length: 5_000 }, () => dense));
        findKeywordMatch(group.repeat(480), sanitizeKeywordList(['acme']));
        expect(performance.now() - started, 'two hostile lists of 5,000 entries and one haystack').toBeLessThan(1_000);
    });

    it('D12 a bare string longer than 200,000 units is cut and its last piece, which the cut may have truncated, is dropped and reported', () => {
        const cutMarker = { value: '(bare string cut at 200000 units; its last entry was dropped)', reason: 'over_limit' };
        const truncated = sanitizeKeywordList(`${' '.repeat(199_990)},Pfizer Inc`);
        expect(truncated.keywords).toEqual([]);
        expect(truncated.rejected.at(-1)).toEqual(cutMarker);
        // pieces that end before the cut are kept; only the piece the cut ends in goes
        const kept = sanitizeKeywordList(`Pfizer Inc,Acme Corp,${','.repeat(199_975)},Globex Corp`);
        expect(kept.keywords).toEqual(['Pfizer Inc', 'Acme Corp']);
        expect(kept.rejected.at(-1)).toEqual(cutMarker);
        // exactly 200,000 units is not cut: nothing dropped, no marker
        const exact = sanitizeKeywordList(`Pfizer Inc,Acme Corp,${','.repeat(200_000 - 'Pfizer Inc,Acme Corp,'.length - 11)}Globex Corp`);
        expect(exact.keywords).toEqual(['Pfizer Inc', 'Acme Corp', 'Globex Corp']);
        expect(exact.rejected).toEqual([]);
        // a window that ends in the first half of a surrogate pair is still cut cleanly
        const pair = sanitizeKeywordList(`ab,${'x'.repeat(199_996)}\u{1f600}${'y'.repeat(10)}`);
        expect(pair.keywords).toEqual(['ab']);
        expect(pair.rejected.at(-1)).toEqual(cutMarker);
    });

    it('D13 a haystack longer than 8,192 units is searched only up to the last whitespace inside the window: no accent can be dropped at the cut', () => {
        const accepted = sanitizeKeywordList(['cafe']);
        // the full text cleans to "...café": a hit on "cafe" would be a false positive
        expect(findKeywordMatch(`${'z'.repeat(8_188)}cafe\u0301`, accepted)).toBeNull();
        expect(findKeywordMatch(`${'z'.repeat(8_188)}cafe\u0301 `, accepted)).toBeNull();
        // a window with no whitespace at all is not searched
        expect(findKeywordMatch(`cafe${'z'.repeat(9_000)}`, accepted)).toBeNull();
        // whitespace inside the window: the text before it is searched, the keyword is found
        expect(findKeywordMatch(`cafe ${'z'.repeat(9_000)}`, accepted)).toBe('cafe');
        // the cut falls on whitespace characters other than U+0020 too
        for (const space of ['\u00a0', '\u2028', '\u3000', '\t', '\n']) {
            expect(findKeywordMatch(`cafe${space}${'z'.repeat(9_000)}`, accepted), `cut at U+${space.codePointAt(0)?.toString(16)}`).toBe('cafe');
        }
        // U+FEFF and ZWSP are removed by cleaning, so they are NOT safe cut points
        expect(findKeywordMatch(`cafe\ufeff${'z'.repeat(9_000)}`, accepted)).toBeNull();
        expect(findKeywordMatch(`cafe\u200b${'z'.repeat(9_000)}`, accepted)).toBeNull();
        // exactly at the limit: a text of 8,192 units is searched whole; 8,193 is cut at the last whitespace
        expect(findKeywordMatch(`${'z'.repeat(8_192 - 5)} cafe`, accepted)).toBe('cafe');
        expect(findKeywordMatch(`${'z'.repeat(8_192 - 4)} cafe`, accepted)).toBeNull();
        expect(findKeywordMatch(`${'z'.repeat(8_192 - 5)} cafe `, accepted)).toBe('cafe');
    });

    it('D14 a rejected value is previewed at 57 units without ever ending in half of a surrogate pair', () => {
        const tooLong = `${'x'.repeat(56)}\u{1f600}${'y'.repeat(200)}`;
        const list = sanitizeKeywordList([tooLong]);
        const value = list.rejected[0]?.value ?? '';
        expect(value).toBe(`${'x'.repeat(56)}...`);
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)).toBe(false);
        const whole = sanitizeKeywordList([`${'x'.repeat(55)}\u{1f600}${'y'.repeat(200)}`]);
        expect(whole.rejected[0]?.value).toBe(`${'x'.repeat(55)}\u{1f600}...`);
    });

    it('D15 the string entries of a list may add up to 200,000 units: the entry that would cross the budget and everything after it is not inspected, reported once', () => {
        const entries = (count: number, units: number): string[] => Array.from({ length: count }, (_, i) => `${i}`.padEnd(units, 'x'));
        // exactly 200,000 units (100 entries of 2,000): all inspected, no marker
        const exact = sanitizeKeywordList(entries(100, 2_000));
        expect(exact.rejected).toHaveLength(100);
        expect(exact.rejected.every((r) => r.reason === 'too_long')).toBe(true);
        // one entry more crosses the budget: not inspected, one marker
        const over = sanitizeKeywordList(entries(101, 2_000));
        expect(over.rejected).toHaveLength(101);
        expect(over.rejected.at(-1)).toEqual({ value: '(1 further entries not inspected)', reason: 'over_limit' });
        // 4,092 units each: 48 fit, the 49th crosses
        const wide = sanitizeKeywordList(entries(49, 4_092));
        expect(wide.rejected.filter((r) => r.reason === 'too_long')).toHaveLength(48);
        expect(wide.rejected.at(-1)).toEqual({ value: '(1 further entries not inspected)', reason: 'over_limit' });
        // a valid keyword after the budget is spent is never accepted
        const late = sanitizeKeywordList([...entries(49, 4_092), 'late keyword']);
        expect(late.keywords).toEqual([]);
        expect(late.rejected.at(-1)).toEqual({ value: '(2 further entries not inspected)', reason: 'over_limit' });
    });

    it('D15b entries over the 4,096-unit raw cap cost no budget (they are rejected at once), and neither do non-string entries', () => {
        const huge = 'x'.repeat(4_097);
        const all = sanitizeKeywordList(Array.from({ length: 5_000 }, () => huge));
        expect(all.rejected).toHaveLength(5_000);
        expect(all.rejected.every((r) => r.reason === 'too_long')).toBe(true);
        const more = sanitizeKeywordList(Array.from({ length: 5_001 }, () => huge));
        expect(more.rejected.at(-1)).toEqual({ value: '(1 further entries not inspected)', reason: 'over_limit' });
        const mixed = sanitizeKeywordList([...Array.from({ length: 1_000 }, () => null), ...Array.from({ length: 1_000 }, () => 7), 'acme corp']);
        expect(mixed.keywords).toEqual(['acme corp']);
        expect(mixed.rejected).toHaveLength(2_000);
    });

    it('D15c a hostile list of 5,000 entries of 4,096 plain units costs at most a couple of hundred milliseconds', () => {
        const started = performance.now();
        const entry = 'caf\u00e9 '.repeat(800).slice(0, 4_096);
        sanitizeKeywordList(Array.from({ length: 5_000 }, () => entry));
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    // ---- guard review, third round (each test reproduces one finding of the independent adversarial review) ----

    it('D16 a deeply nested non-string entry costs constant time: 5,000 entries of 8,000-deep arrays are rejected as [array] without being serialised', () => {
        let deep: unknown[] = [];
        for (let i = 0; i < 8_000; i += 1) deep = [deep];
        const started = performance.now();
        const list = sanitizeKeywordList(Array.from({ length: 5_000 }, () => deep));
        expect(list.keywords).toEqual([]);
        expect(list.rejected).toHaveLength(5_000);
        expect(list.rejected.every((r) => r.reason === 'not_a_string' && r.value === '[array]')).toBe(true);
        const shared = new Array<number>(100_000).fill(1);
        sanitizeKeywordList(Array.from({ length: 5_000 }, () => shared));
        expect(performance.now() - started, 'JSON.stringify of these costs seconds and about 1 GB').toBeLessThan(500);
    });

    it('D17 one letter or digit padded with punctuation is the one-letter needle in disguise: "c." never matches "Pfizer Inc."', () => {
        for (const padded of ['c.', 'd.', 'a.', '(a)', 'a |', '-0', '.0', '1)', '\u2460']) {
            const list = sanitizeKeywordList([padded]);
            expect(list.keywords, padded).toEqual([]);
            expect(findKeywordMatch('Pfizer Inc. | Acme Ltd. | S.A. 2024-01-02', list), padded).toBeNull();
        }
        // the comma split of a pasted company list produces such pieces: they are dropped, the names survive
        const pasted = sanitizeKeywordList('Smith, J.\nBrown, A.; Acme Corp');
        expect(pasted.keywords).toEqual(['Smith', 'Brown', 'Acme Corp']);
        expect(pasted.rejected.map((r) => r.reason)).toEqual(['single_letter_or_digit', 'single_letter_or_digit']);
        expect(findKeywordMatch('Banco Santander S.A.', pasted)).toBeNull();
        // two letters or digits are enough, wherever the punctuation sits
        for (const kept of ['BP', 'GE', '3M', 'a.b', 'a-1', '(ab)']) expect(sanitizeKeywordList([kept]).keywords, kept).toEqual([kept]);
    });

    it('D18 one visible glyph that NFKC expands is one character, not a two-character keyword: the circled twenty and the numero sign are rejected', () => {
        for (const glyph of ['\u2473', '\u2116', '\ufb01', '\u33cc', '\u2474', '\u249c', '\u2488', '\ufdfa']) {
            const list = sanitizeKeywordList([glyph]);
            expect(list.keywords, glyph.codePointAt(0)?.toString(16)).toEqual([]);
            expect(list.rejected.map((r) => r.reason)).toEqual(['too_short']);
        }
        expect(findKeywordMatch('Annual report 2020', sanitizeKeywordList(['\u2473']))).toBeNull();
        // two glyphs that expand are two characters
        expect(sanitizeKeywordList(['\u2473\u2473']).keywords).toEqual(['2020']);
    });

    it('D19 the NFKC expansion cap and the mark-run cap keep a hostile list under a second: the worst compatibility character, at every shape', () => {
        const fdfa = '\ufdfa';
        const started = performance.now();
        const shapes = [
            Array.from({ length: 48 }, () => `${fdfa.repeat(4_092)}e\u200b\u0301`),
            Array.from({ length: 5_000 }, () => `${fdfa.repeat(39)}e\u200b\u0301`),
            Array.from({ length: 48 }, () => fdfa.repeat(4_096)),
        ];
        for (const list of shapes) {
            const result = sanitizeKeywordList(list);
            expect(result.keywords).toEqual([]);
            expect(result.rejected.every((r) => ['empty_after_normalisation', 'over_limit', 'too_long'].includes(r.reason))).toBe(true);
        }
        expect(performance.now() - started, 'three hostile lists at the raw caps').toBeLessThan(1_000);
        // a haystack of the same shape counts as empty rather than being cleaned three times over 73,000 characters
        const acme = sanitizeKeywordList(['acme']);
        expect(findKeywordMatch(`${fdfa.repeat(8_188)} acme`, acme)).toBeNull();
        expect(performance.now() - started).toBeLessThan(1_500);
    });

    it('D20 findKeywordMatch, matchesAnyKeyword and describeSanitization never throw, whatever list they are given', () => {
        const revoked = (() => {
            const { proxy, revoke } = Proxy.revocable({ needles: ['acme'], keywords: ['acme'] }, {});
            revoke();
            return proxy;
        })();
        const hostile: unknown[] = [
            undefined,
            null,
            0,
            'acme',
            [],
            {},
            { needles: null },
            { needles: 'acme' },
            { needles: [null], keywords: [] },
            { needles: [5, {}, Symbol('x')], keywords: [] },
            { needles: ['acme corp'], keywords: undefined },
            { needles: ['acme corp'], keywords: 'x' },
            revoked,
            { get needles(): string[] { throw new Error('boom'); } },
        ];
        for (const list of hostile) {
            expect(() => findKeywordMatch('Acme Corp', list as never)).not.toThrow();
            expect(() => matchesAnyKeyword('Acme Corp', list as never)).not.toThrow();
            expect(() => describeSanitization(list as never)).not.toThrow();
            expect(typeof describeSanitization(list as never)).toBe('string');
        }
        expect(findKeywordMatch('Acme Corp', undefined as never)).toBeNull();
        expect(findKeywordMatch('Acme Corp', revoked as never)).toBeNull();
        // a list without a keywords array is malformed: it matches nothing (fail closed) instead of throwing mid-match
        expect(findKeywordMatch('Acme Corp', { needles: ['acme corp'], keywords: undefined } as never)).toBeNull();
    });

    it('D21 a hand-built list gets the sanitiser floor again: punctuation, padded and one-alphanumeric needles never match, and only 500 needles are read', () => {
        const build = (needles: string[]): never => ({ keywords: needles, needles, rejected: [], malformedContainer: false }) as never;
        for (const needle of ['..', ' a', 'a ', 'a.', '-0', '()', '  ']) expect(findKeywordMatch('Wait.. a. -0 () a b', build([needle])), needle).toBeNull();
        expect(findKeywordMatch('Wait.. acme', build(['..', 'acme']))).toBe('acme');
        const many = Array.from({ length: 1_000 }, (_, i) => `zz${i}`);
        many[700] = 'acme';
        expect(findKeywordMatch('Acme Corp', build(many)), 'needle 701 is never read').toBeNull();
        many[400] = 'acme';
        expect(findKeywordMatch('Acme Corp', build(many))).toBe('acme');
        const started = performance.now();
        findKeywordMatch('Acme Corp', build(new Array<string>(100_000_000) as string[]));
        expect(performance.now() - started, 'a sparse array of 1e8 holes is not walked').toBeLessThan(200);
    });

    it('D22 one hostile field cannot hide a watchlisted name in another: a run of marks is cut, never makes the record empty', () => {
        const pfizer = sanitizeKeywordList(['Pfizer']);
        const run = '\u0e31'.repeat(17);
        expect(findKeywordMatch(`Pfizer Inc x${run}`, pfizer)).toBe('Pfizer');
        expect(findKeywordMatch(`${run} | Pfizer Inc`, pfizer)).toBe('Pfizer');
        expect(findKeywordMatch(`Pfizer Inc x${'\u0e31'.repeat(9)}\u200b${'\u0e31'.repeat(9)}`, pfizer)).toBe('Pfizer');
        expect(findKeywordMatch(`Pfizer Inc x${'\u0e31'.repeat(16)}`, pfizer)).toBe('Pfizer');
        // a haystack longer than the window is searched up to the last whitespace; a name in the cut part is not found
        expect(findKeywordMatch(`${'word '.repeat(1_700)}Pfizer`, pfizer)).toBeNull();
        expect(findKeywordMatch(`Pfizer ${'word '.repeat(1_700)}`, pfizer)).toBe('Pfizer');
        // the cut keeps exactly 16 marks: a keyword that ends in 16 marks (the most a keyword may hold) is found in a haystack whose run is longer, not in one whose run is shorter
        const sixteen = sanitizeKeywordList([`ab${'\u0301'.repeat(16)}`]);
        expect(sixteen.keywords).toHaveLength(1);
        expect(findKeywordMatch(`xx ab${'\u0301'.repeat(40)}`, sixteen)).not.toBeNull();
        expect(findKeywordMatch(`xx ab${'\u0301'.repeat(17)}`, sixteen)).not.toBeNull();
        expect(findKeywordMatch(`xx ab${'\u0301'.repeat(16)}`, sixteen)).not.toBeNull();
        expect(findKeywordMatch(`xx ab${'\u0301'.repeat(15)}`, sixteen)).toBeNull();
    });

    it('D23 a rejected value is a log-safe preview: control characters, escapes, bidi controls and lone surrogates never reach a log line', () => {
        const list = sanitizeKeywordList(['\ud800\u001b[31m\nFAKE', '\u202eevil\u0000', '\u001b[2Jx']);
        for (const r of list.rejected) {
            // eslint-disable-next-line no-control-regex
            expect(r.value, r.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\ud800-\udfff]/u);
            expect(r.value.length).toBeLessThanOrEqual(60);
        }
        expect(list.rejected[0]).toEqual({ value: '\ufffd\ufffd[31m\ufffdFAKE', reason: 'invalid_unicode' });
        const long = sanitizeKeywordList([`\u001b${'x'.repeat(100)}\ud83d`.repeat(40)]);
        expect(long.rejected).toHaveLength(1);
        expect(long.rejected[0]?.value.length).toBeLessThanOrEqual(60);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// PART 2c - hand-written hostile corpus
// ---------------------------------------------------------------------------------------------------------------
//
// Every expectation in this table was derived BY HAND from docs section 5.3 (NFKC; removal of every
// Default_Ignorable_Code_Point and Bidi_Control character and of the C0/C1 controls, repeated to a fixed point; length in
// code points after cleaning; at least two letters or digits); none of it is computed from lib/_guards.ts or from the
// reference above. Rows tagged `grey` sit where the written specification leaves a decision (noncharacters, separators
// outside ASCII, a visible character plus a combining enclosing keycap): they pin what the guard does, and each one needs
// a deliberate decision if it changes.

interface HostileRow {
    section: string;
    label: string;
    input: unknown;
    keywords: string[];
    reasons: KeywordRejectionReason[] | undefined;
    malformed: boolean;
    grey: string | undefined;
}

const HOSTILE_ROWS: HostileRow[] = [];
let hostileSection = '';
function section(name: string): void {
    hostileSection = name;
}
function addHostile(label: string, input: unknown, keywords: string[], reasons?: KeywordRejectionReason[], extra: { grey?: string; malformed?: boolean } = {}): void {
    HOSTILE_ROWS.push({ section: hostileSection, label, input, keywords, reasons, malformed: extra.malformed ?? false, grey: extra.grey });
}

section('Unicode tag characters');
addHostile('tags only (A,B)', ['\u{e0041}\u{e0042}'], [], ['empty_after_normalisation']);
addHostile('ab + tag A', ['ab\u{e0041}'], ['ab']);
addHostile('language tag + ab', ['\u{e0001}ab'], ['ab']);
addHostile('cancel tag alone', ['\u{e007f}'], [], ['empty_after_normalisation']);
addHostile('a + five tags + x', ['a\u{e0041}\u{e0042}\u{e0043}\u{e0044}\u{e0045}x'], ['ax']);
addHostile('England flag tag sequence', ['\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'], [], ['too_short']);
section('Noncharacters');
addHostile('ab + U+FFFF', ['ab\u{ffff}'], ['ab\u{ffff}']);
addHostile('FFFF FFFE only', ['\u{ffff}\u{fffe}'], [], ['no_letter_or_digit']);
addHostile('FDD0 FDEF only', ['\u{fdd0}\u{fdef}'], [], ['no_letter_or_digit']);
addHostile('1FFFE 10FFFF only', ['\u{1fffe}\u{10ffff}'], [], ['no_letter_or_digit']);
addHostile('a + U+FFFE: one letter and one noncharacter is one alphanumeric character', ['a\u{fffe}'], [], ['single_letter_or_digit']);
addHostile('ab + U+FFFE', ['ab\u{fffe}'], ['ab\u{fffe}'], undefined, { grey: 'a noncharacter is kept (neither invisible nor whitespace)' });
addHostile('U+10FFFF alone', ['\u{10ffff}'], [], ['too_short']);
section('Mongolian free variation selectors and vowel separator');
addHostile('mongolian FVS1-3 only', ['\u{180b}\u{180c}\u{180d}'], [], ['empty_after_normalisation']);
addHostile('a + FVS1', ['a\u{180b}'], [], ['too_short']);
addHostile('mongolian vowel separator x2', ['\u{180e}\u{180e}'], [], ['empty_after_normalisation']);
addHostile('ab + MVS + cd', ['ab\u{180e}cd'], ['abcd']);
addHostile('mongolian FVS4 x2', ['\u{180f}\u{180f}'], [], ['empty_after_normalisation']);
addHostile('mongolian letter A x2', ['\u{1820}\u{1820}'], ['\u{1820}\u{1820}']);
section('NFKC expansion and composition');
addHostile('fi ligature (one glyph is one character)', ['\u{fb01}'], [], ['too_short']);
addHostile('fi ligature, twice', ['\u{fb01}'.repeat(2)], ['fi'.repeat(2)]);
addHostile('ff ligature (one glyph is one character)', ['\u{fb00}'], [], ['too_short']);
addHostile('ff ligature, twice', ['\u{fb00}'.repeat(2)], ['ff'.repeat(2)]);
addHostile('ffi ligature (one glyph is one character)', ['\u{fb03}'], [], ['too_short']);
addHostile('ffi ligature, twice', ['\u{fb03}'.repeat(2)], ['ffi'.repeat(2)]);
addHostile('ffl ligature (one glyph is one character)', ['\u{fb04}'], [], ['too_short']);
addHostile('ffl ligature, twice', ['\u{fb04}'.repeat(2)], ['ffl'.repeat(2)]);
addHostile('long s t (one glyph is one character)', ['\u{fb05}'], [], ['too_short']);
addHostile('long s t, twice', ['\u{fb05}'.repeat(2)], ['st'.repeat(2)]);
addHostile('st ligature (one glyph is one character)', ['\u{fb06}'], [], ['too_short']);
addHostile('st ligature, twice', ['\u{fb06}'.repeat(2)], ['st'.repeat(2)]);
addHostile('IJ (one glyph is one character)', ['\u{132}'], [], ['too_short']);
addHostile('IJ, twice', ['\u{132}'.repeat(2)], ['IJ'.repeat(2)]);
addHostile('ij (one glyph is one character)', ['\u{133}'], [], ['too_short']);
addHostile('ij, twice', ['\u{133}'.repeat(2)], ['ij'.repeat(2)]);
addHostile('DZ caron capital (one glyph is one character)', ['\u{1c4}'], [], ['too_short']);
addHostile('DZ caron capital, twice', ['\u{1c4}'.repeat(2)], ['D\u{17d}'.repeat(2)]);
addHostile('dz caron small (one glyph is one character)', ['\u{1c6}'], [], ['too_short']);
addHostile('dz caron small, twice', ['\u{1c6}'.repeat(2)], ['d\u{17e}'.repeat(2)]);
addHostile('lj small (one glyph is one character)', ['\u{1c9}'], [], ['too_short']);
addHostile('lj small, twice', ['\u{1c9}'.repeat(2)], ['lj'.repeat(2)]);
addHostile('n preceded by apostrophe (one glyph is one character)', ['\u{149}'], [], ['too_short']);
addHostile('n preceded by apostrophe, twice', ['\u{149}'.repeat(2)], ['\u{2bc}n'.repeat(2)]);
addHostile('long s dot above', ['\u{1e9b}'], [], ['too_short']);
addHostile('arabic ligature allah (one glyph is one character)', ['\u{fdf2}'], [], ['too_short']);
addHostile('arabic ligature allah, twice', ['\u{fdf2}'.repeat(2)], ['\u{627}\u{644}\u{644}\u{647}'.repeat(2)]);
addHostile('arabic ligature salla (18 cp): one glyph is one character, whatever it expands to', ['\u{fdfa}'], [], ['too_short']);
addHostile('11 x FDFA grows 18x under NFKC: more than 4x plus 16 units, so the text counts as empty', ['\u{fdfa}'.repeat(11)], [], ['empty_after_normalisation']);
addHostile('12 x FDFA: the same', ['\u{fdfa}'.repeat(12)], [], ['empty_after_normalisation']);
addHostile('11 x FDFA + ab: still more than 4x plus 16', ['\u{fdfa}'.repeat(11) + 'ab'], [], ['empty_after_normalisation']);
addHostile('one FDFA among 30 letters grows 48/31 times: an ordinary text that happens to hold the ligature is fine', ['\u{fdfa}' + 'a'.repeat(30)], ['\u{635}\u{644}\u{649} \u{627}\u{644}\u{644}\u{647} \u{639}\u{644}\u{64a}\u{647} \u{648}\u{633}\u{644}\u{645}' + 'a'.repeat(30)]);
addHostile('FDFA + 4 letters is still dominated by the expansion', ['\u{fdfa}'.repeat(3) + 'abcd'], [], ['empty_after_normalisation']);
addHostile('square MHz (one glyph is one character)', ['\u{3392}'], [], ['too_short']);
addHostile('square MHz, twice', ['\u{3392}'.repeat(2)], ['MHz'.repeat(2)]);
addHostile('square gal (one glyph is one character)', ['\u{33ff}'], [], ['too_short']);
addHostile('square gal, twice', ['\u{33ff}'.repeat(2)], ['gal'.repeat(2)]);
addHostile('degree celsius (one glyph is one character)', ['\u{2103}'], [], ['too_short']);
addHostile('degree celsius, twice', ['\u{2103}'.repeat(2)], ['\u{b0}C'.repeat(2)]);
addHostile('telephone sign (one glyph is one character)', ['\u{2121}'], [], ['too_short']);
addHostile('telephone sign, twice', ['\u{2121}'.repeat(2)], ['TEL'.repeat(2)]);
addHostile('numero sign (one glyph is one character)', ['\u{2116}'], [], ['too_short']);
addHostile('numero sign, twice', ['\u{2116}'.repeat(2)], ['No'.repeat(2)]);
addHostile('trade mark sign (one glyph is one character)', ['\u{2122}'], [], ['too_short']);
addHostile('trade mark sign, twice', ['\u{2122}'.repeat(2)], ['TM'.repeat(2)]);
addHostile('vulgar half (one glyph is one character)', ['\u{bd}'], [], ['too_short']);
addHostile('vulgar half, twice', ['\u{bd}'.repeat(2)], ['1\u{2044}2'.repeat(2)]);
addHostile('vulgar third (one glyph is one character)', ['\u{2153}'], [], ['too_short']);
addHostile('vulgar third, twice', ['\u{2153}'.repeat(2)], ['1\u{2044}3'.repeat(2)]);
addHostile('partnership sign (one glyph is one character)', ['\u{3250}'], [], ['too_short']);
addHostile('partnership sign, twice', ['\u{3250}'.repeat(2)], ['PTE'.repeat(2)]);
addHostile('square ltd (one glyph is one character)', ['\u{32cf}'], [], ['too_short']);
addHostile('square ltd, twice', ['\u{32cf}'.repeat(2)], ['LTD'.repeat(2)]);
addHostile('digit zero full stop (one glyph is one character)', ['\u{1f100}'], [], ['too_short']);
addHostile('digit zero full stop, twice', ['\u{1f100}'.repeat(2)], ['0.'.repeat(2)]);
addHostile('parenthesized 1 (one glyph is one character)', ['\u{2474}'], [], ['too_short']);
addHostile('parenthesized 1, twice', ['\u{2474}'.repeat(2)], ['(1)'.repeat(2)]);
addHostile('digit one full stop (one glyph is one character)', ['\u{2488}'], [], ['too_short']);
addHostile('digit one full stop, twice', ['\u{2488}'.repeat(2)], ['1.'.repeat(2)]);
addHostile('circled 1', ['\u{2460}'], [], ['too_short']);
addHostile('circled 1 2', ['\u{2460}\u{2461}'], ['12']);
addHostile('circled 0', ['\u{24ea}'], [], ['too_short']);
addHostile('circled 8', ['\u{2467}'], [], ['too_short']);
addHostile('circled 20 (one glyph is one character)', ['\u{2473}'], [], ['too_short']);
addHostile('circled 20, twice', ['\u{2473}'.repeat(2)], ['20'.repeat(2)]);
addHostile('negative circled zero x2', ['\u{24ff}\u{24ff}'], ['\u{24ff}\u{24ff}']);
addHostile('roman I', ['\u{2160}'], [], ['too_short']);
addHostile('roman II (one glyph is one character)', ['\u{2161}'], [], ['too_short']);
addHostile('roman II, twice', ['\u{2161}'.repeat(2)], ['II'.repeat(2)]);
addHostile('roman VIII (one glyph is one character)', ['\u{2167}'], [], ['too_short']);
addHostile('roman VIII, twice', ['\u{2167}'.repeat(2)], ['VIII'.repeat(2)]);
addHostile('roman M', ['\u{216f}'], [], ['too_short']);
addHostile('small roman i', ['\u{2170}'], [], ['too_short']);
addHostile('small roman viii (one glyph is one character)', ['\u{2177}'], [], ['too_short']);
addHostile('small roman viii, twice', ['\u{2177}'.repeat(2)], ['viii'.repeat(2)]);
addHostile('superscript 2', ['\u{b2}'], [], ['too_short']);
addHostile('superscript 2 3', ['\u{b2}\u{b3}'], ['23']);
addHostile('superscript zero', ['\u{2070}'], [], ['too_short']);
addHostile('superscript 9 8', ['\u{2079}\u{2078}'], ['98']);
addHostile('subscript 2 3', ['\u{2082}\u{2083}'], ['23']);
addHostile('fullwidth 0 1', ['\u{ff10}\u{ff11}'], ['01']);
addHostile('fullwidth AB', ['\u{ff21}\u{ff22}'], ['AB']);
addHostile('fullwidth a', ['\u{ff41}'], [], ['too_short']);
addHostile('double-struck zero x2', ['\u{1d7d8}\u{1d7d8}'], ['00']);
addHostile('math bold A B', ['\u{1d400}\u{1d401}'], ['AB']);
addHostile('math bold A', ['\u{1d400}'], [], ['too_short']);
addHostile('feminine ordinal alone', ['\u{aa}'], [], ['too_short']);
addHostile('feminine + masculine ordinal', ['\u{aa}\u{ba}'], ['ao']);
addHostile('one dot leader x2', ['\u{2024}\u{2024}'], [], ['no_letter_or_digit']);
addHostile('two dot leader', ['\u{2025}'], [], ['too_short']);
addHostile('horizontal ellipsis', ['\u{2026}'], [], ['too_short']);
addHostile('vertical ellipsis form', ['\u{fe19}'], [], ['too_short']);
addHostile('ideographic full stops', ['\u{3002}\u{3002}'], [], ['no_letter_or_digit']);
addHostile('kangxi radical single', ['\u{2fd5}'], [], ['too_short']);
addHostile('kangxi radicals two', ['\u{2f00}\u{2f01}'], ['\u{4e00}\u{4e28}']);
addHostile('square apaato (one glyph is one character)', ['\u{3300}'], [], ['too_short']);
addHostile('square apaato, twice', ['\u{3300}'.repeat(2)], ['\u{30a2}\u{30d1}\u{30fc}\u{30c8}'.repeat(2)]);
addHostile('halfwidth ka + dakuten', ['\u{ff76}\u{ff9e}'], [], ['too_short']);
addHostile('halfwidth ka dakuten ka', ['\u{ff76}\u{ff9e}\u{ff76}'], ['\u{30ac}\u{30ab}']);
addHostile('jamo g + a', ['\u{1100}\u{1161}'], [], ['too_short']);
addHostile('jamo g a k', ['\u{1100}\u{1161}\u{11a8}'], [], ['too_short']);
addHostile('hangul syllable ga', ['\u{ac00}'], [], ['too_short']);
addHostile('hangul ga gak', ['\u{ac00}\u{ac01}'], ['\u{ac00}\u{ac01}']);
addHostile('e acute twice (decomposed)', ['e\u{301}e\u{301}'], ['\u{e9}\u{e9}']);
addHostile('q + dot above (no precomposed): one letter and one mark is one alphanumeric character', ['q\u{307}'], [], ['single_letter_or_digit']);
addHostile('q + dot above (no precomposed), twice', ['q\u{307}'.repeat(2)], ['q\u{307}'.repeat(2)]);
addHostile('a + ypogegrammeni: one letter and one mark is one alphanumeric character', ['a\u{345}'], [], ['single_letter_or_digit']);
addHostile('a + ypogegrammeni, twice', ['a\u{345}'.repeat(2)], ['a\u{345}'.repeat(2)]);
addHostile('A + ring above', ['A\u{30a}'], [], ['too_short']);
addHostile('angstrom sign', ['\u{212b}'], [], ['too_short']);
addHostile('ohm sign twice', ['\u{2126}\u{2126}'], ['\u{3a9}\u{3a9}']);
addHostile('kelvin sign', ['\u{212a}'], [], ['too_short']);
addHostile('capital sharp s', ['\u{1e9e}'], [], ['too_short']);
addHostile('capital sharp s twice', ['\u{1e9e}\u{1e9e}'], ['\u{1e9e}\u{1e9e}']);
addHostile('I dot above twice', ['\u{130}\u{130}'], ['\u{130}\u{130}']);
addHostile('I dot above', ['\u{130}'], [], ['too_short']);
section('Surrogates');
addHostile('U+10000, a valid surrogate pair', ['\u{10000}'], [], ['too_short']);
addHostile('ab + lone high', ['ab\u{d800}'], [], ['invalid_unicode']);
addHostile('lone high ab lone low', ['\u{d800}ab\u{dc00}'], [], ['invalid_unicode']);
addHostile('lone low + valid pair', ['\u{dc00}\u{20000}'], [], ['invalid_unicode']);
addHostile('valid pair + lone high', ['\u{20000}\u{d800}'], [], ['invalid_unicode']);
addHostile('low then high (reversed pair)', ['\u{dc00}\u{d800}ab'], [], ['invalid_unicode']);
addHostile('U+10FFFF, a valid surrogate pair', ['\u{10ffff}'], [], ['too_short']);
section('Controls');
addHostile('NUL', ['\u{0000}'], [], ['empty_after_normalisation']);
addHostile('two NUL', ['\u{0000}\u{0000}'], [], ['empty_after_normalisation']);
addHostile('NUL a', ['\u{0000}a'], [], ['too_short']);
addHostile('NUL ab', ['\u{0000}ab'], ['ab']);
addHostile('a NUL b', ['a\u{0000}b'], ['ab']);
addHostile('ANSI colour escape', ['\u{001b}[31mred\u{001b}[0m'], ['[31mred[0m']);
addHostile('CRLF inside', ['ab\r\ncd'], ['ab cd']);
addHostile('NEL inside', ['ab\u{0085}cd'], ['ab cd']);
addHostile('LS inside', ['ab\u{2028}cd'], ['ab cd']);
addHostile('PS inside', ['ab\u{2029}cd'], ['ab cd']);
addHostile('DEL x2', ['\u{007f}\u{007f}'], [], ['empty_after_normalisation']);
addHostile('C1 80 9f', ['\u{0080}\u{009f}'], [], ['empty_after_normalisation']);
addHostile('C1 90 ab', ['\u{0090}ab'], ['ab']);
addHostile('FS GS RS US between letters', ['a\u{001c}b\u{001d}c\u{001e}d\u{001f}e'], ['abcde'], undefined, { grey: 'FS GS RS US are C0 controls: removed, words fuse' });
section('Bidi');
addHostile('isolates + ab', ['\u{2066}\u{2067}\u{2068}\u{2069}ab'], ['ab']);
addHostile('embeddings + ab', ['\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}ab'], ['ab']);
addHostile('ab + LRM RLM', ['ab\u{200e}\u{200f}'], ['ab']);
addHostile('LRM alone', ['\u{200e}'], [], ['empty_after_normalisation']);
addHostile('deprecated format controls', ['\u{206a}\u{206b}\u{206c}\u{206d}\u{206e}\u{206f}'], [], ['empty_after_normalisation']);
addHostile('trojan-source style override', ['ac\u{202e}mc\u{202c}'], ['acmc']);
section('Whitespace');
for (const [name, ch] of [['tab', '\t'], ['LF', '\n'], ['VT', '\v'], ['FF', '\f'], ['CR', '\r'], ['NEL', '\u{0085}'], ['LS', '\u{2028}'], ['PS', '\u{2029}'], ['NBSP', '\u{a0}'], ['ogham', '\u{1680}'], ['en quad', '\u{2000}'], ['em quad', '\u{2001}'], ['en space', '\u{2002}'], ['em space', '\u{2003}'], ['three-per-em', '\u{2004}'], ['four-per-em', '\u{2005}'], ['six-per-em', '\u{2006}'], ['figure', '\u{2007}'], ['punctuation', '\u{2008}'], ['thin', '\u{2009}'], ['hair', '\u{200a}'], ['narrow nbsp', '\u{202f}'], ['medium math', '\u{205f}'], ['ideographic', '\u{3000}']] as const) {
    addHostile(`whitespace ${name} between letters`, [`a${ch}${ch}b`], ['a b']);
}
addHostile('braille blank between letters is NOT whitespace', ['a\u{2800}b'], ['a\u{2800}b']);
section('Zero width');
for (const [name, ch] of [['ZWSP', '\u{200b}'], ['ZWNJ', '\u{200c}'], ['ZWJ', '\u{200d}'], ['WJ', '\u{2060}'], ['BOM', '\u{feff}'], ['SHY', '\u{ad}'], ['func apply', '\u{2061}'], ['invisible times', '\u{2062}'], ['invisible sep', '\u{2063}'], ['invisible plus', '\u{2064}']] as const) {
    addHostile(`${name} between letters fuses`, [`a${ch}b`], ['ab']);
}
addHostile('all six zero-width only', ['\u{200b}\u{200c}\u{200d}\u{2060}\u{feff}\u{ad}'], [], ['empty_after_normalisation']);
addHostile('family emoji ZWJ sequence', ['\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}'], [], ['no_letter_or_digit']);
addHostile('heart VS16 (the selector is removed, one symbol is left)', ['\u{2764}\u{fe0f}'], [], ['too_short']);
addHostile('keycap 1 (digit + VS16 + enclosing keycap): one digit and one mark is one alphanumeric character', ['1\u{fe0f}\u{20e3}'], [], ['single_letter_or_digit']);
addHostile('keycap #', ['#\u{fe0f}\u{20e3}'], [], ['no_letter_or_digit']);
addHostile('flag US (regional indicators)', ['\u{1f1fa}\u{1f1f8}'], [], ['no_letter_or_digit']);
section('Length boundaries');
addHostile('200 a', ['a'.repeat(200)], ['a'.repeat(200)]);
addHostile('201 a', ['a'.repeat(201)], [], ['too_long']);
addHostile('a + 500 ZWSP + b', [`a${'\u{200b}'.repeat(500)}b`], ['ab']);
addHostile('200 astral', ['\u{20000}'.repeat(200)], ['\u{20000}'.repeat(200)]);
addHostile('201 astral', ['\u{20000}'.repeat(201)], [], ['too_long']);
addHostile('100 a, 100 spaces, 100 a collapses to 201', [`${'a'.repeat(100)}${' '.repeat(100)}${'a'.repeat(100)}`], [], ['too_long']);
addHostile('4000 spaces around ab (raw length 8,002 is over the 4,096 cap)', [`${' '.repeat(4000)}ab${' '.repeat(4000)}`], [], ['too_long']);
addHostile('2000 spaces around ab (raw length 4,002 is under the cap)', [`${' '.repeat(2000)}ab${' '.repeat(2000)}`], ['ab']);
addHostile('ab + 4,094 ZWSP is exactly 4,096 units', [`ab${'\u{200b}'.repeat(4094)}`], ['ab']);
addHostile('ab + 4,095 ZWSP is 4,097 units', [`ab${'\u{200b}'.repeat(4095)}`], [], ['too_long']);
addHostile('a + 1000 LF + b', [`a${'\n'.repeat(1000)}b`], ['a b']);
addHostile('100 x (a + grave) composes to 100 cp', ['a\u{300}'.repeat(100)], ['\u{e0}'.repeat(100)]);
addHostile('ab + 16 ypogegrammeni (the longest run of combining marks that is allowed)', [`ab${'\u{345}'.repeat(16)}`], [`ab${'\u{345}'.repeat(16)}`]);
addHostile('a + 16 ypogegrammeni is still one alphanumeric character', [`a${'\u{345}'.repeat(16)}`], [], ['single_letter_or_digit']);
addHostile('ab + 17 ypogegrammeni (one mark too many: the keyword counts as empty)', [`ab${'\u{345}'.repeat(17)}`], [], ['empty_after_normalisation']);
addHostile('three groups of a + 16 marks are separate runs', [`${`a${'\u{345}'.repeat(16)}`.repeat(3)}`], [`${`a${'\u{345}'.repeat(16)}`.repeat(3)}`]);
addHostile('a + 150 ypogegrammeni is a hostile run, not a too_long keyword', [`a${'\u{345}'.repeat(150)}`], [], ['empty_after_normalisation']);
addHostile('a + 250 ypogegrammeni is a hostile run, not a too_long keyword', [`a${'\u{345}'.repeat(250)}`], [], ['empty_after_normalisation']);
addHostile('ab + 17 marks separated by ZWSP: removal in pass 1 makes the run, and pass 2 refuses it', [`ab${'\u{345}\u{200b}'.repeat(17)}`], [], ['empty_after_normalisation']);
addHostile('ab + 16 marks separated by ZWSP: the run after removal is still allowed', [`ab${'\u{345}\u{200b}'.repeat(16)}`], [`ab${'\u{345}'.repeat(16)}`]);
section('Bare-string separators');
addHostile('bare ab,cd', 'ab,cd', ['ab', 'cd']);
addHostile('bare ab;cd', 'ab;cd', ['ab', 'cd']);
addHostile('bare ab LF cd', 'ab\ncd', ['ab', 'cd']);
addHostile('bare ab CR cd', 'ab\rcd', ['ab', 'cd']);
addHostile('bare ab CRLF cd', 'ab\r\ncd', ['ab', 'cd']);
addHostile('bare ab pipe cd is one keyword', 'ab|cd', ['ab|cd']);
addHostile('bare ab TAB cd is one keyword', 'ab\tcd', ['ab cd']);
addHostile('bare ab LS cd is one keyword (grey)', 'ab\u{2028}cd', ['ab cd'], undefined, { grey: 'U+2028 is a line separator but not a splitter' });
addHostile('bare ab NEL cd is one keyword (grey)', 'ab\u{0085}cd', ['ab cd'], undefined, { grey: 'U+0085 NEXT LINE is not a splitter' });
addHostile('bare fullwidth comma (grey)', 'ab\u{ff0c}cd', ['ab,cd'], undefined, { grey: 'splits before NFKC, so the comma ends up INSIDE one keyword' });
addHostile('bare fullwidth semicolon (grey)', 'ab\u{ff1b}cd', ['ab;cd'], undefined, { grey: 'same' });
addHostile('bare ideographic comma', 'ab\u{3001}cd', ['ab\u{3001}cd']);
addHostile('bare arabic comma', 'ab\u{60c}cd', ['ab\u{60c}cd']);
addHostile('bare arabic semicolon', 'ab\u{61b}cd', ['ab\u{61b}cd']);
addHostile('bare greek question mark (NFKC to semicolon, grey)', 'ab\u{37e}cd', ['ab;cd'], undefined, { grey: 'canonically equivalent to ; yet not a splitter' });
addHostile('bare lone comma', ',', [], ['empty_after_normalisation', 'empty_after_normalisation']);
addHostile('bare comma run', ',,,', [], ['empty_after_normalisation', 'empty_after_normalisation']);
addHostile('bare semicolon LF', ';\n', [], ['empty_after_normalisation', 'empty_after_normalisation']);
addHostile('bare a', 'a', [], ['too_short']);
addHostile('bare padded ab', ' ab ', ['ab']);
addHostile('bare JSON text', '[ "ab", "cd" ]', ['[ "ab"', '"cd" ]']);
section('Container shapes');
addHostile('nested array', [['ab']], [], ['not_a_string']);
addHostile('boxed String element', [new String('ab')], [], ['not_a_string']);
addHostile('Set container', new Set(['ab']), [], [], { malformed: true });
addHostile('Map container', new Map([['ab', 'ab']]), [], [], { malformed: true });
addHostile('array-like object', { 0: 'ab', length: 1 }, [], [], { malformed: true });
addHostile('array with extra own property', Object.assign(['ab'], { extra: 'cd' }), ['ab']);
addHostile('sparse array', [, 'ab'], ['ab'], ['not_a_string']);
addHostile('frozen array', Object.freeze(['ab', 'cd']), ['ab', 'cd']);
addHostile('Uint8Array container', new Uint8Array([97, 98]), [], [], { malformed: true });
addHostile('Buffer container', Buffer.from('ab'), [], [], { malformed: true });
addHostile('Array subclass', new (class extends Array<string> {})('ab', 'cd'), ['ab', 'cd']);
addHostile('Date container', new Date(0), [], [], { malformed: true });
addHostile('RegExp container', /ab/u, [], [], { malformed: true });
addHostile('Error container', new Error('ab'), [], [], { malformed: true });
addHostile('negative zero container', -0, [], [], { malformed: true });
addHostile('NaN container', Number.NaN, [], [], { malformed: true });
section('De-duplication');
addHostile('ss vs sharp s are not folded (grey)', ['STRASSE', 'Stra\u{df}e', 'strasse'], ['STRASSE', 'Stra\u{df}e'], ['duplicate'], { grey: 'case-insensitive per toLowerCase, not Unicode case folding' });
addHostile('fullwidth + ascii + mixed duplicate', ['\u{ff21}\u{ff22}', 'ab', 'Ab'], ['AB'], ['duplicate', 'duplicate']);
addHostile('fi ligature duplicates fi', ['\u{fb01}le', 'FILE', 'file'], ['file'], ['duplicate', 'duplicate']);
addHostile('kelvin duplicates k', ['\u{212a}elvin', 'kelvin'], ['Kelvin'], ['duplicate']);
addHostile('roman viii duplicates', ['\u{2167}\u{2167}', '\u{2177}\u{2177}', 'viiiviii'], ['VIIIVIII'], ['duplicate', 'duplicate']);
addHostile('dz caron case pair', ['\u{1c5}\u{1c5}', '\u{1c6}\u{1c6}'], ['D\u{17e}D\u{17e}'], ['duplicate']);

const HOSTILE_FINDS: Array<[string, string[], unknown, string | null, string?]> = [
    ['ZWSP inside haystack', ['acme'], 'A\u{200b}C\u{200b}M\u{200b}E Inc', 'acme'],
    ['fullwidth haystack', ['acme'], '\u{ff41}\u{ff43}\u{ff4d}\u{ff45}', 'acme'],
    ['NUL inside haystack', ['acme'], 'AC\u{0000}ME', 'acme'],
    ['soft hyphen inside haystack', ['acme'], 'Ac\u{ad}mE', 'acme'],
    ['LF inside haystack becomes a space', ['acme'], 'ac\nme', null],
    ['NBSP vs space', ['ac me'], 'AC\u{a0}ME', 'ac me'],
    ['double space vs single', ['ac me'], 'AC  \t ME', 'ac me'],
    ['VS16 inside haystack is removed', ['acme'], 'ac\u{fe0f}me', 'acme'],
    ['MVS inside haystack is removed', ['acme'], 'ac\u{180e}me', 'acme'],
    ['lone surrogate inside haystack', ['acme'], 'ac\u{d800}me', null],
    ['tag char inside haystack is removed', ['acme'], 'ac\u{e0041}me', 'acme'],
    ['Arabic letter mark inside haystack is removed', ['acme'], 'ac\u{61c}me', 'acme'],
    ['Hangul filler inside haystack is removed', ['acme'], 'ac\u{3164}me', 'acme'],
    ['combining grapheme joiner inside haystack is removed', ['acme'], 'ac\u{34f}me', 'acme'],
    ['fi ligature in haystack', ['file'], '\u{fb01}le', 'file'],
    ['haystack 1 char vs needle 2 char', ['ab'], 'a', null],
    ['needle is a suffix', ['ab'], 'xxab', 'ab'],
    ['needle straddles removed controls', ['abcd'], 'ab\u{0000}\u{0001}\u{0002}cd', 'abcd'],
    ['needle does not straddle a LF', ['ab cd'], 'ab\ncd', 'ab cd'],
    ['astral needle', ['\u{20000}\u{20001}'], 'x\u{20000}\u{20001}y', '\u{20000}\u{20001}'],
    ['astral needle vs half pair', ['\u{20000}\u{20001}'], '\u{20000}', null],
    ['empty list', [], 'anything at all', null],
    ['digits only needle', ['00'], 'invoice 100', '00'],
    ['I dot above lowercases to i + dot', ['\u{130}\u{130}'], '\u{130}\u{130}', '\u{130}\u{130}'],
    ['final sigma needle vs mid-word haystack (grey, missed hit)', ['\u{3a3}\u{391}\u{3a3}'], '\u{3c3}\u{3b1}\u{3c3}', null, 'sigma'],
    ['ss vs sharp s (grey, missed hit)', ['stra\u{df}e'], 'STRASSE', null, 'ss'],
    ['homoglyph cyrillic a (grey)', ['acme'], '\u{430}cme', null],
];

describe('PART 2c hand-written hostile corpus: sanitizeKeywordList, whole-object expectations', () => {
    const sections = [...new Set(HOSTILE_ROWS.map((row) => row.section))];

    it('the corpus holds at least 200 hand-written hostile inputs in at least 12 sections', () => {
        expect(HOSTILE_ROWS.length + HOSTILE_FINDS.length).toBeGreaterThanOrEqual(200);
        expect(sections.length).toBeGreaterThanOrEqual(12);
        // Fewer than before: the tag-character, Mongolian, surrogate and invisible-letter decisions are no longer open.
        expect(HOSTILE_ROWS.filter((row) => row.grey !== undefined).length).toBeGreaterThanOrEqual(8);
        bump('hostile.rows', HOSTILE_ROWS.length);
        bump('hostile.finds', HOSTILE_FINDS.length);
    });

    for (const name of sections) {
        it(`${name}`, () => {
            for (const row of HOSTILE_ROWS.filter((candidate) => candidate.section === name)) {
                const list = sanitizeKeywordList(row.input);
                expect(list.keywords, row.label).toEqual(row.keywords);
                expect(list.needles, `${row.label}: needles`).toEqual(row.keywords.map((keyword) => keyword.toLowerCase()));
                expect(list.malformedContainer, `${row.label}: malformedContainer`).toBe(row.malformed);
                if (row.reasons !== undefined) expect(list.rejected.map((rejection) => rejection.reason), `${row.label}: rejection reasons`).toEqual(row.reasons);
                if (row.keywords.length === 0) expectNeverMatches(list);
                // An accepted keyword always matches the text it came from (no silently dead keyword).
                if (row.keywords.length === 1) expect(findKeywordMatch(`x ${row.keywords[0] as string} y`, list), `${row.label}: matches itself`).toBe(row.keywords[0]);
            }
        });
    }
});

describe('PART 2c hand-written hostile corpus: findKeywordMatch on hostile haystacks', () => {
    it.each(HOSTILE_FINDS)('%s', (label, keywords, haystack, expected) => {
        expect(findKeywordMatch(haystack, sanitizeKeywordList(keywords)), label).toBe(expected);
    });

    it('a hand-built list whose needle is ONE astral code point (two UTF-16 units) cannot match: the length re-check counts code points', () => {
        const single: SanitizedKeywordList = { keywords: ['\u{20000}'], needles: ['\u{20000}'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('x\u{20000}y', single)).toBeNull();
        expect(findKeywordMatch('\u{20000}', single)).toBeNull();
        const pair: SanitizedKeywordList = { keywords: ['\u{20000}\u{20001}'], needles: ['\u{20000}\u{20001}'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('x\u{20000}\u{20001}y', pair)).toBe('\u{20000}\u{20001}');
    });

    it('a hand-built list that carries needles but no keywords still matches, and answers with the needle (the documented fallback)', () => {
        const needlesOnly: SanitizedKeywordList = { keywords: [], needles: ['acme'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('ACME Corp', needlesOnly)).toBe('acme');
        expect(findKeywordMatch('Globex', needlesOnly)).toBeNull();
        const shortKeywords: SanitizedKeywordList = { keywords: ['Acme Corporation'], needles: ['acme', 'globex'], rejected: [], malformedContainer: false };
        expect(findKeywordMatch('GLOBEX', shortKeywords)).toBe('globex');
        expect(findKeywordMatch('ACME', shortKeywords)).toBe('Acme Corporation');
    });
});

// ---------------------------------------------------------------------------------------------------------------
// PART 2d - exhaustive code point sweep
// ---------------------------------------------------------------------------------------------------------------
//
// The seeded properties sample the code point space; this block does not. Every one of the 1,114,112 code points (lone
// surrogates included) is put through the guard in the positions where a boundary mistake shows: alone, doubled, at both
// ends of a word and inside a word. A removal range that is one code point too short or too long, a whitespace class
// that misses a member, or a classification that changes at one code point cannot survive it.

describe('PART 2d exhaustive code point sweep: every code point U+0000 to U+10FFFF against the reference', () => {
    const ALL_CODE_POINTS = 0x110000;
    const ABCD = sanitizeKeywordList(['abcd']);
    const REF_ABCD = refSanitize(['abcd']);

    it('X1 normaliseKeyword equals the reference for every code point alone, doubled, at both ends of a word and inside it', () => {
        const v = new Violations();
        for (let cp = 0; cp < ALL_CODE_POINTS; cp += 1) {
            const ch = String.fromCodePoint(cp);
            for (const text of [ch, `${ch}${ch}`, `ab${ch}`, `${ch}ab`, `ab${ch}cd`, `ab${ch}${ch}cd`]) {
                const actual = normaliseKeyword(text);
                const expected = refClean(text);
                if (actual !== expected) v.add(() => `U+${cp.toString(16)} in '${esc(text)}': production '${esc(actual)}', reference '${esc(expected)}'`);
            }
        }
        bump('X1.codePoints', ALL_CODE_POINTS);
        expectNoViolations(v, 'X1');
    }, 180_000);

    it('X2 sanitizeKeywordList equals the reference (keywords, needles, rejection reasons) for every code point alone and doubled', () => {
        const v = new Violations();
        for (let cp = 0; cp < ALL_CODE_POINTS; cp += 1) {
            const ch = String.fromCodePoint(cp);
            for (const text of [ch, `${ch}${ch}`]) {
                const actual = sanitizeKeywordList([text]);
                const expected = refSanitize([text]);
                if (
                    JSON.stringify(actual.keywords) !== JSON.stringify(expected.keywords) ||
                    JSON.stringify(actual.needles) !== JSON.stringify(expected.needles) ||
                    JSON.stringify(actual.rejected.map((r) => r.reason)) !== JSON.stringify(expected.reasons)
                ) {
                    v.add(() => `U+${cp.toString(16)} in '${esc(text)}': production ${render(actual.keywords)} ${JSON.stringify(actual.rejected.map((r) => r.reason))}, reference ${render(expected.keywords)} ${JSON.stringify(expected.reasons)}`);
                }
            }
        }
        bump('X2.codePoints', ALL_CODE_POINTS);
        expectNoViolations(v, 'X2');
    }, 180_000);

    it('X3 findKeywordMatch equals the reference for every code point inside a haystack, and a keyword always matches the text it was made from', () => {
        const v = new Violations();
        for (let cp = 0; cp < ALL_CODE_POINTS; cp += 1) {
            const ch = String.fromCodePoint(cp);
            const haystack = `xx ab${ch}cd yy`;
            const actual = findKeywordMatch(haystack, ABCD);
            const expected = refFind(haystack, REF_ABCD);
            if (actual !== expected) v.add(() => `U+${cp.toString(16)} in '${esc(haystack)}': production ${render(actual)}, reference ${render(expected)}`);

            const word = `ab${ch}cd`;
            const own = sanitizeKeywordList([word]);
            if (own.keywords.length === 1 && findKeywordMatch(word, own) !== own.keywords[0]) v.add(() => `U+${cp.toString(16)}: accepted keyword '${esc(own.keywords[0] as string)}' does not match its own source text`);
        }
        bump('X3.codePoints', ALL_CODE_POINTS);
        expectNoViolations(v, 'X3');
    }, 180_000);

    it('X4 the sweep is not vacuous: removal, whitespace and rejection classes are all populated', () => {
        let removed = 0;
        let spaced = 0;
        let emptied = 0;
        for (let cp = 0; cp < 0x10000; cp += 1) {
            const ch = String.fromCodePoint(cp);
            const inside = normaliseKeyword(`ab${ch}cd`);
            if (inside === 'abcd') removed += 1;
            if (inside === 'ab cd') spaced += 1;
            if (normaliseKeyword(ch) === '') emptied += 1;
        }
        expect(removed).toBeGreaterThan(80);
        expect(spaced).toBeGreaterThan(20);
        expect(emptied).toBeGreaterThan(80);
        bump('X4.removedCodePoints', removed);
        bump('X4.spaceCodePoints', spaced);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// PART 3 - end to end through runEngine
// ---------------------------------------------------------------------------------------------------------------

const silentLog = { info() {}, warning() {}, error() {}, debug() {} };
const ctx: ConnectorContext = {
    http: {
        async getText() {
            throw new Error('network must not be used in guard fuzz tests');
        },
        async getJson() {
            throw new Error('network must not be used in guard fuzz tests');
        },
    },
    log: silentLog,
    now: () => new Date('2026-10-21T00:00:00Z'),
};
const clock = () => new Date('2026-10-21T00:00:00Z');

function stubEngine(records: SourceRecord[]): EngineDefinition {
    const connector: Connector<any> = {
        id: 'alpha',
        engine: 'global-regtech-compliance-feed',
        legacyActor: 'legacy-alpha',
        description: 'alpha',
        status: 'active',
        optionsSchema: z.object({ token: z.string().optional() }).passthrough(),
        async fetch() {
            return records;
        },
    };
    return { slug: 'global-regtech-compliance-feed', connectors: [connector] };
}

function makeRecords(texts: ReadonlyArray<string | undefined>): SourceRecord[] {
    return texts.map((text, i) => ({ recordId: `r${i}`, fingerprint: 'f', payload: { title: `t-${i}` }, watchText: text }));
}

interface Harness {
    sinks: RunSinks;
    rows: Array<Record<string, unknown>>;
    billing: FakeBilling;
    /** record_id of the row each charged watchlist-hit belongs to, in charge order. */
    hitRecordIds: string[];
    /** record_id of every row whose own charge reported that the platform budget is now exhausted. */
    limitRowIds: string[];
    summaries: RunSummary[];
}

function makeHarness(opts: { ppe?: boolean; prices?: Record<string, number>; budgetUsd?: number } = {}): Harness {
    const prices = opts.prices ?? { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 };
    const billing = new FakeBilling(opts.ppe ?? true, prices, opts.budgetUsd);
    const store = new InMemoryDeltaStore();
    const rows: Array<Record<string, unknown>> = [];
    const hitRecordIds: string[] = [];
    const limitRowIds: string[] = [];
    const summaries: RunSummary[] = [];
    let lastEmitted = '';
    const realCharge = billing.charge.bind(billing);
    billing.charge = async (eventName: string, count: number) => {
        const result = await realCharge(eventName, count);
        if (eventName === WATCHLIST_HIT_EVENT && result.chargedCount > 0) hitRecordIds.push(lastEmitted);
        return result;
    };
    const sinks: RunSinks = {
        async emit(row, eventName = RESULT_EVENT) {
            if (billing.isPayPerEvent()) {
                const r = await billing.charge(eventName, 1);
                if (r.chargedCount < 1) return { emitted: false, limitReached: true };
                rows.push(row);
                lastEmitted = String(row.record_id);
                if (r.eventChargeLimitReached) limitRowIds.push(lastEmitted);
                return { emitted: true, limitReached: r.eventChargeLimitReached };
            }
            rows.push(row);
            lastEmitted = String(row.record_id);
            return { emitted: true, limitReached: false };
        },
        billing,
        store,
        async saveSummary(s) {
            summaries.push(s);
        },
    };
    return { sinks, rows, billing, hitRecordIds, limitRowIds, summaries };
}

async function run(records: SourceRecord[], watchlistNames: unknown, h: Harness, extra: Record<string, unknown> = {}): Promise<RunSummary> {
    return runEngine(
        stubEngine(records),
        { sources: ['alpha'], watchlistNames, maxItemsPerSource: Math.max(500, records.length), ...extra },
        { sinks: h.sinks, ctx, clock },
    );
}

function hitCharges(h: Harness): number {
    return h.billing.calls.filter((c) => c.eventName === WATCHLIST_HIT_EVENT).reduce((sum, c) => sum + c.count, 0);
}

/** Every assertion that must hold for a watchlist that accepted nothing. */
function expectNoWatchlistEffect(h: Harness, summary: RunSummary, records: SourceRecord[], label: string): void {
    expect(hitCharges(h), `${label}: watchlist-hit charges`).toBe(0);
    expect(h.billing.totalFor(WATCHLIST_HIT_EVENT), label).toBe(0);
    expect(h.hitRecordIds, label).toEqual([]);
    expect(h.rows, `${label}: every record is still delivered`).toHaveLength(records.length);
    for (const row of h.rows) {
        expect(row.is_watchlist_match, `${label}: is_watchlist_match of ${String(row.record_id)}`).toBe(false);
        expect(row.matched_watchlist_keyword, `${label}: matched_watchlist_keyword of ${String(row.record_id)}`).toBeNull();
    }
    expect(summary.watchlist.hitsCharged, label).toBe(0);
    expect(summary.watchlist.accepted, label).toBe(0);
    expect(summary.sources[0]?.watchlistHits, label).toBe(0);
}

// -- poisoned watchlists -------------------------------------------------------------------------------------------

const POISON_SINGLE_POOLS: Pool[] = [LATIN, SCRIPTS.greek, SCRIPTS.cyrillic, SCRIPTS.cjk, [...'0123456789']];

function genPoisonEntry(rng: Rng): unknown {
    switch (rng.int(9)) {
        case 0:
            return '';
        case 1:
            return randomRun(rng, ALPHABETS.whitespace, 1, 8);
        case 2:
            return randomRun(rng, [...DOCUMENTED_ZERO_WIDTH, ...ALPHABETS.bidi, ...ALPHABETS.controls], 1, 10);
        case 3:
            return randomRun(rng, ALPHABETS.asciiPunctuation, 1, 30);
        case 4: {
            const single = rng.pick(rng.pick(POISON_SINGLE_POOLS));
            return `${randomRun(rng, [...ALPHABETS.whitespace, ...DOCUMENTED_ZERO_WIDTH, ...ALPHABETS.bidi], 0, 3)}${single}${randomRun(rng, [...ALPHABETS.whitespace, ...DOCUMENTED_ZERO_WIDTH, ...ALPHABETS.bidi], 0, 3)}`;
        }
        case 5:
            return rng.pick(rng.pick(POISON_SINGLE_POOLS)).repeat(rng.range(201, 260));
        case 6:
            return rng.pick(['\u{10000}', '\u{20000}', '\u{1d400}', '\uff41']);
        case 7:
            return `${rng.pick(['', ' ', '\u200b'])}${rng.pick([',', ';', '-', '.', '()', '[]', '//', '...'])}${rng.pick(['', ' ', '\u200b'])}`;
        default:
            return nonString(rng);
    }
}

function genPoisonWatchlist(rng: Rng): unknown {
    const roll = rng.float();
    if (roll < 0.6) return Array.from({ length: rng.range(1, 12) }, () => genPoisonEntry(rng));
    if (roll < 0.85) {
        const pieces = Array.from({ length: rng.range(1, 10) }, () => {
            const entry = genPoisonEntry(rng);
            return typeof entry === 'string' ? entry : '';
        });
        return pieces.join(rng.pick([',', ';', '\n', ', ', '\r\n', ' ; ']));
    }
    if (roll < 0.92) return rng.pick<unknown>([42, true, { a: 1 }, 3.14, () => 'ab', Symbol('ab'), 10n]);
    return rng.pick([null, undefined, '', '   ', []]);
}

/** Row texts built from the poison itself, so that an accidental "empty or one-letter needle matches" would show. */
function genPoisonRowTexts(rng: Rng, watchlist: unknown): Array<string | undefined> {
    const entries: string[] = [];
    const collect = (value: unknown): void => {
        if (typeof value === 'string') entries.push(value);
        else if (Array.isArray(value)) for (const v of value) collect(v);
    };
    collect(watchlist);
    const texts: Array<string | undefined> = ['', ' ', '\u200b', 'a', 'x', 'Acme Corp', '--', undefined, 'The quick brown fox, jumps; over\nthe lazy dog 0123456789'];
    const extra = rng.range(0, 10);
    for (let i = 0; i < extra; i += 1) {
        const roll = rng.float();
        if (roll < 0.35 && entries.length > 0) texts.push(`${randomText(rng, SAFE_POOLS, 6)}${rng.pick(entries)}${randomText(rng, SAFE_POOLS, 6)}`);
        else if (roll < 0.5 && entries.length > 0) texts.push(entries.join(' '));
        else if (roll < 0.6) texts.push(undefined);
        else texts.push(randomText(rng, SAFE_POOLS, 60));
    }
    return texts;
}

const POISON_SCENARIOS = 600;
const VALID_SCENARIOS = 600;
const BUDGET_SCENARIOS = 150;

// The operator's named poison inputs, run end to end as well.
const NAMED_POISON: Array<[string, unknown]> = [
    ['[""]', ['']],
    ['["", "   "]', ['', '   ']],
    ['["   "]', ['   ']],
    ['[" ", "\\t", "\\n"]', [' ', '\t', '\n']],
    ['["--"]', ['--']],
    ['["..."]', ['...']],
    ['["()"]', ['()']],
    ['[null]', [null]],
    ['[undefined]', [undefined]],
    ['[[]]', [[]]],
    ['[{}]', [{}]],
    ['[0]', [0]],
    ['[false]', [false]],
    ['null', null],
    ['undefined', undefined],
    ['""', ''],
    ['"   "', '   '],
    ['"a"', 'a'],
    ['["a"]', ['a']],
    ['["x"]', ['x']],
    ['["\\u200b"]', ['\u200b']],
    ['["\\u200b\\u200b\\u200b"]', ['\u200b\u200b\u200b']],
    ['["\\u2060\\ufeff"]', ['\u2060\ufeff']],
    ['["\\u200b a \\u200b"]', ['\u200b a \u200b']],
    ['bidi marks', ['\u202e\u202c', '\u200e\u200f', '\u2066\u2069']],
    ['lone surrogates', ['\ud800', '\udc00', '\ud800\ud800']],
    ['combining only', ['\u0301', '\u0301\u0302']],
    ['201 code points', ['x'.repeat(201)]],
    ['object container', { a: 1 }],
    ['number container', 42],
];

describe('PART 3 poisoned watchlists never bill, end to end through runEngine', () => {
    it.each(NAMED_POISON)('operator input %s: zero matches, zero watchlist-hit charges, every row flagged false', async (label, input) => {
        const records = makeRecords(['', ' ', '\u200b', 'a', 'x', 'Acme Corp', 'xylophone a-b', '--', undefined, 'ab', 'Globex x']);
        const h = makeHarness();
        const summary = await run(records, input, h);
        expectNoWatchlistEffect(h, summary, records, label);
    });

    it(`${POISON_SCENARIOS} seeded poisoned watchlists over hostile row text: zero watchlist-hit charges, zero matches, accepted 0`, async () => {
        let rowsChecked = 0;
        for (let i = 0; i < POISON_SCENARIOS; i += 1) {
            const rng = makeRng(caseSeed(i, 0x501));
            const watchlist = genPoisonWatchlist(rng);
            const texts = genPoisonRowTexts(rng, watchlist);
            const records = makeRecords(texts);
            const label = `poison scenario #${i} watchlist=${render(watchlist)}`;

            // The premise, established independently of the code under test: every entry is invalid after cleaning.
            expect(refSanitize(watchlist).keywords, `${label}: premise (reference accepts nothing)`).toEqual([]);

            const h = makeHarness();
            const summary = await run(records, watchlist, h);
            expectNoWatchlistEffect(h, summary, records, label);
            rowsChecked += records.length;
        }
        bump('router.poison.scenarios', POISON_SCENARIOS);
        bump('router.poison.rows', rowsChecked);
        expect(rowsChecked).toBeGreaterThan(6_000);
    }, 120_000);

    it('poisoned watchlists are also free in the other billing modes (unpriced watchlist-hit, not pay-per-event)', async () => {
        for (let i = 0; i < 100; i += 1) {
            const rng = makeRng(caseSeed(i, 0x502));
            const watchlist = genPoisonWatchlist(rng);
            const records = makeRecords(genPoisonRowTexts(rng, watchlist));
            for (const h of [makeHarness({ prices: { [RESULT_EVENT]: 0.002 } }), makeHarness({ ppe: false })]) {
                const summary = await run(records, watchlist, h);
                expectNoWatchlistEffect(h, summary, records, `mode scenario #${i}`);
                expect(summary.watchlist.hitsUnpriced).toBe(0);
                expect(summary.pricing.unpricedEvents, `mode scenario #${i}: a watchlist that accepted nothing needs no watchlist-hit price`).toEqual([]);
            }
        }
        bump('router.poison.modeScenarios', 100);
    }, 60_000);

    it('a valid keyword hidden among poison still works, and only for rows that really contain it', async () => {
        const records = makeRecords(['Acme Corp LLC', 'Globex', 'a', '', 'xylophone']);
        const h = makeHarness();
        const summary = await run(records, ['', 'a', '--', null, ' Acme  Corp ', '\u200b', 'x'], h);
        expect(h.rows.map((r) => r.is_watchlist_match)).toEqual([true, false, false, false, false]);
        expect(h.rows[0]?.matched_watchlist_keyword).toBe('Acme Corp');
        expect(hitCharges(h)).toBe(1);
        expect(h.hitRecordIds).toEqual(['r0']);
        expect(summary.watchlist).toMatchObject({ accepted: 1, rejected: 6, hitsCharged: 1 });
    });
});

// -- valid watchlists ----------------------------------------------------------------------------------------------

interface ValidScenario {
    watchlist: unknown;
    texts: Array<string | undefined>;
    mode: 'priced' | 'unpriced' | 'notPpe';
    priceMicro: number;
    capMicro: number;
    hitCap: number;
}

// 249, 493 and 1959 micro-USD are prices whose decimal form times 1,000,000 is a hair BELOW the integer (249 / 1e6 * 1e6 is
// 248.99999999999997): a cap that truncated instead of rounding would bill one hit too many or too few at exact multiples.
const PRICE_MICRO_CHOICES = [1, 249, 493, 1_000, 1_959, 50_000, 150_000, 333_333];
const HIT_CAP_CHOICES = [0, 1, 2, 3, 5, 10, 200];
const CAP_MULTIPLES = [0, 1, 2, 3, 5, 40];

function genValidKeyword(rng: Rng): string {
    return dress(rng, randomPhrase(rng, PLAIN_WORD_POOLS), SAFE_POOLS);
}

function genValidScenario(i: number): ValidScenario {
    const rng = makeRng(caseSeed(i, 0x701));
    const keywordCount = rng.range(1, 8);
    const entries: unknown[] = [];
    for (let k = 0; k < keywordCount; k += 1) {
        const keyword = genValidKeyword(rng);
        entries.push(keyword);
        if (rng.chance(0.4)) entries.push(genPoisonEntry(rng));
        if (rng.chance(0.2)) entries.push(dress(rng, keyword, SAFE_POOLS));
    }
    const shape = rng.float();
    const watchlist: unknown = shape < 0.7 ? entries : entries.filter((e) => typeof e === 'string').join(rng.pick([',', ';', '\n']));
    const oracle = refSanitize(watchlist);

    const texts: Array<string | undefined> = [];
    const rowCount = rng.range(6, 20);
    for (let r = 0; r < rowCount; r += 1) {
        const roll = rng.float();
        if (roll < 0.4 && oracle.keywords.length > 0) {
            let text = rng.pick(oracle.keywords);
            const caseRoll = rng.float();
            if (caseRoll < 0.3) text = text.toUpperCase();
            else if (caseRoll < 0.6) text = text.toLowerCase();
            if (rng.chance(0.3)) text = text.replace(/ /gu, () => randomRun(rng, ALPHABETS.whitespace, 1, 3));
            if (rng.chance(0.3)) text = insertNoise(rng, text, REMOVABLE_NOISE_POOLS, rng.range(1, 3));
            texts.push(`${randomText(rng, SAFE_POOLS, 10)} ${text} ${randomText(rng, SAFE_POOLS, 10)}`);
        } else if (roll < 0.75) texts.push(randomText(rng, SAFE_POOLS, 40));
        else if (roll < 0.85) texts.push(rng.pick(['', ' ', '\u200b', '\n\t']));
        else if (roll < 0.92) texts.push(undefined);
        else texts.push(rng.pick(['a', 'x', 'ab', 'Acme Corp', '--']));
    }

    const modeRoll = rng.float();
    const priceMicro = rng.pick(PRICE_MICRO_CHOICES);
    const capMicro = priceMicro * rng.pick(CAP_MULTIPLES) + (rng.chance(0.5) ? 0 : rng.int(priceMicro));
    return { watchlist, texts, mode: modeRoll < 0.8 ? 'priced' : modeRoll < 0.9 ? 'unpriced' : 'notPpe', priceMicro, capMicro, hitCap: rng.pick(HIT_CAP_CHOICES) };
}

/**
 * An independent model of what the router must do against a platform budget, written from the delivery rules rather than
 * from router_core.ts: charge the row's own event first (no budget, no row); a matched row is charged a hit only when its own
 * charge did not just exhaust the budget; a failed or exhausting hit charge stops the run; a row whose own charge exhausted
 * the budget is the last row. It bills through a separate FakeBilling with the same prices and budget, so it predicts the
 * delivered rows, the charged hits and the stop flag exactly.
 */
async function modelBudgetRun(texts: ReadonlyArray<string | undefined>, oracle: RefResult, prices: Record<string, number>, budgetUsd: number): Promise<{ delivered: string[]; hits: string[]; stopped: boolean; classified: number; deliveredMatches: number }> {
    const billing = new FakeBilling(true, prices, budgetUsd);
    const delivered: string[] = [];
    const hits: string[] = [];
    let deliveredMatches = 0;
    // `classified` counts the records the router looked at: every delivered row, plus the one whose own charge was refused.
    const result = (stopped: boolean, refused: boolean): { delivered: string[]; hits: string[]; stopped: boolean; classified: number; deliveredMatches: number } => ({
        delivered,
        hits,
        stopped,
        classified: delivered.length + (refused ? 1 : 0),
        deliveredMatches,
    });
    for (let index = 0; index < texts.length; index += 1) {
        const own = await billing.charge(RESULT_EVENT, 1);
        if (own.chargedCount < 1) return result(true, true);
        delivered.push(`r${index}`);
        if (refFind(texts[index], oracle) !== null) {
            deliveredMatches += 1;
            if (!own.eventChargeLimitReached) {
                const hit = await billing.charge(WATCHLIST_HIT_EVENT, 1);
                if (hit.chargedCount < 1) return result(true, false);
                hits.push(`r${index}`);
                if (hit.eventChargeLimitReached) return result(true, false);
            }
        }
        if (own.eventChargeLimitReached) return result(true, false);
    }
    return result(false, false);
}

/**
 * The price list a scenario bills against. An "unpriced" scenario rotates through every way a watchlist-hit can fail to be
 * a positive, finite, OWN price: absent, zero, negative, NaN, infinite, and inherited from a prototype (which the SDK would
 * read as a real price but a plain `in` or property read would too). None of them may ever be charged.
 */
const UNPRICED_VARIANTS = ['missing', 'zero', 'negative', 'nan', 'infinite', 'inherited'] as const;

function priceBookFor(s: ValidScenario, index: number): Record<string, number> {
    if (s.mode !== 'unpriced') return { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: s.priceMicro / 1_000_000 };
    switch (UNPRICED_VARIANTS[index % UNPRICED_VARIANTS.length]) {
        case 'missing':
            return { [RESULT_EVENT]: 0.002 };
        case 'zero':
            return { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0 };
        case 'negative':
            return { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: -0.05 };
        case 'nan':
            return { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: Number.NaN };
        case 'infinite':
            return { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: Number.POSITIVE_INFINITY };
        default:
            return Object.assign(Object.create({ [WATCHLIST_HIT_EVENT]: 0.05 }) as Record<string, number>, { [RESULT_EVENT]: 0.002 });
    }
}

describe('PART 3 valid watchlists are charged exactly once per matched row and never beyond the caps', () => {
    it(`${VALID_SCENARIOS} seeded valid watchlists: every charged hit is a row that really contains an accepted keyword; charges equal matched rows up to the hit and USD caps`, async () => {
        let scenariosWithMatch = 0;
        let matchedRows = 0;
        let charged = 0;
        let capBound = 0;
        let rowsChecked = 0;

        for (let i = 0; i < VALID_SCENARIOS; i += 1) {
            const s = genValidScenario(i);
            const oracle = refSanitize(s.watchlist);
            const label = `valid scenario #${i} (${s.mode}, price ${s.priceMicro}e-6, cap ${s.capMicro}e-6, hitCap ${s.hitCap}) watchlist=${render(s.watchlist)}`;
            const prices = priceBookFor(s, i);
            const h = makeHarness({ ppe: s.mode !== 'notPpe', prices });
            const records = makeRecords(s.texts);
            const summary = await run(records, s.watchlist, h, { maxWatchlistHitsPerRun: s.hitCap, maxWatchlistSpendUsd: s.capMicro / 1_000_000 });

            // Row by row: the flag and the keyword equal the independent oracle.
            expect(h.rows, label).toHaveLength(records.length);
            const matchedIds: string[] = [];
            h.rows.forEach((row, index) => {
                const expected = refFind(s.texts[index], oracle);
                expect(row.record_id, label).toBe(`r${index}`);
                expect(row.is_watchlist_match, `${label} row r${index}`).toBe(expected !== null);
                expect(row.matched_watchlist_keyword, `${label} row r${index}`).toBe(expected);
                if (expected !== null) matchedIds.push(`r${index}`);
            });

            // Charges: only priced pay-per-event runs charge, one per matched row, first matched rows first, within both caps.
            const capByUsd = Math.floor(s.capMicro / s.priceMicro);
            const expectedCharges = s.mode === 'priced' ? Math.min(matchedIds.length, s.hitCap, capByUsd) : 0;
            expect(summary.watchlist.hitsCharged, label).toBe(expectedCharges);
            expect(hitCharges(h), label).toBe(expectedCharges);
            expect(h.billing.totalFor(WATCHLIST_HIT_EVENT), label).toBe(expectedCharges);
            expect(h.hitRecordIds, label).toEqual(matchedIds.slice(0, expectedCharges));
            expect(new Set(h.hitRecordIds).size, `${label}: a row is never charged twice`).toBe(h.hitRecordIds.length);
            expect(h.hitRecordIds.length, `${label}: never more charges than matched rows`).toBeLessThanOrEqual(matchedIds.length);
            expect(h.hitRecordIds.length, `${label}: hit cap`).toBeLessThanOrEqual(s.hitCap);
            expect(h.hitRecordIds.length * s.priceMicro, `${label}: USD cap`).toBeLessThanOrEqual(s.capMicro);

            // Every charged hit is a row whose text really contains an accepted keyword.
            for (const id of h.hitRecordIds) {
                const text = s.texts[Number(id.slice(1))];
                const keyword = refFind(text, oracle);
                expect(keyword, `${label}: charged row ${id} has no accepted keyword`).not.toBeNull();
                const at = oracle.keywords.indexOf(keyword as string);
                expect(at, label).toBeGreaterThanOrEqual(0);
                expect(refClean(text as string).toLowerCase().includes(oracle.needles[at] as string), `${label}: row ${id}`).toBe(true);
            }

            // Summary and result billing.
            expect(summary.sources[0]?.watchlistHits, label).toBe(matchedIds.length);
            expect(summary.watchlist.accepted, label).toBe(oracle.keywords.length);
            expect(summary.watchlist.rejected, label).toBe(oracle.reasons.length);
            expect(summary.watchlist.hitsUnpriced, label).toBe(s.mode === 'unpriced' ? matchedIds.length : 0);
            expect(summary.pricing.unpricedEvents, `${label}: unpriced events`).toEqual(s.mode === 'unpriced' && oracle.keywords.length > 0 ? [WATCHLIST_HIT_EVENT] : []);
            if (s.mode === 'notPpe') expect(h.billing.calls, label).toEqual([]);
            else expect(h.billing.totalFor(RESULT_EVENT), label).toBe(records.length);

            rowsChecked += records.length;
            if (matchedIds.length > 0) scenariosWithMatch += 1;
            matchedRows += matchedIds.length;
            charged += expectedCharges;
            if (s.mode === 'priced' && matchedIds.length > expectedCharges) capBound += 1;
        }

        bump('router.valid.scenarios', VALID_SCENARIOS);
        bump('router.valid.rows', rowsChecked);
        bump('router.valid.matchedRows', matchedRows);
        bump('router.valid.charges', charged);
        bump('router.valid.capBoundScenarios', capBound);
        // Non-vacuity: matches and charges happen often, and the caps really bind in many scenarios.
        expect(scenariosWithMatch).toBeGreaterThan(400);
        expect(matchedRows).toBeGreaterThan(1_500);
        expect(charged).toBeGreaterThan(500);
        expect(capBound).toBeGreaterThan(50);
    }, 180_000);

    it(`${BUDGET_SCENARIOS} seeded runs that hit the platform budget: charges never exceed matched delivered rows and only delivered rows are charged`, async () => {
        let stopped = 0;
        let limitRows = 0;
        for (let i = 0; i < BUDGET_SCENARIOS; i += 1) {
            const s = genValidScenario(10_000 + i);
            const rng = makeRng(caseSeed(i, 0x801));
            const oracle = refSanitize(s.watchlist);
            // Three price patterns. With a cheap hit the budget can still afford a hit on the very row whose own charge
            // exhausted it, which the router must NOT spend (the SDK would overcharge by one to stop the run). The middling
            // pattern (a 0.03 hit against a 0.05 row) can leave too little for the next row; the dedicated test below pins
            // that refusal exactly.
            const pattern = i % 3;
            const prices = pattern === 1 ? { [RESULT_EVENT]: 0.05, [WATCHLIST_HIT_EVENT]: 0.002 } : pattern === 2 ? { [RESULT_EVENT]: 0.05, [WATCHLIST_HIT_EVENT]: 0.03 } : { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 };
            const budget =
                pattern === 1
                    ? rng.range(1, 12) * 0.05 + rng.range(0, 24) * 0.002 + 0.001
                    : pattern === 2
                      ? rng.range(1, 10) * 0.08 + rng.range(0, 7) * 0.01 + 0.001
                      : rng.range(1, 30) * 0.002 + rng.range(0, 3) * 0.05;
            const h = makeHarness({ prices, budgetUsd: budget });
            const records = makeRecords(s.texts);
            const summary = await run(records, s.watchlist, h, { maxWatchlistHitsPerRun: 1_000, maxWatchlistSpendUsd: 1_000 });
            const label = `budget scenario #${i} budget=${budget}`;
            if (summary.stoppedOnChargeLimit) stopped += 1;

            const deliveredMatches: string[] = [];
            h.rows.forEach((row, index) => {
                const expected = refFind(s.texts[index], oracle);
                expect(row.is_watchlist_match, `${label} row r${index}`).toBe(expected !== null);
                expect(row.matched_watchlist_keyword, `${label} row r${index}`).toBe(expected);
                if (expected !== null) deliveredMatches.push(`r${index}`);
            });
            expect(h.hitRecordIds.length, label).toBeLessThanOrEqual(deliveredMatches.length);
            for (const id of h.hitRecordIds) expect(deliveredMatches, `${label}: charged row ${id} was not a delivered match`).toContain(id);
            for (const id of h.limitRowIds) expect(h.hitRecordIds, `${label}: a hit was charged on row ${id}, whose own charge exhausted the budget`).not.toContain(id);
            if (summary.stoppedOnChargeLimit && h.limitRowIds.length > 0) limitRows += 1;
            expect(summary.watchlist.hitsCharged, label).toBe(hitCharges(h));

            // Exact behaviour, not just bounds: the independent model predicts every delivered row, every charged hit and the stop flag.
            const model = await modelBudgetRun(s.texts, oracle, prices, budget);
            expect(h.rows.map((row) => row.record_id), `${label}: delivered rows`).toEqual(model.delivered);
            expect(h.hitRecordIds, `${label}: charged hits`).toEqual(model.hits);
            expect(summary.stoppedOnChargeLimit, `${label}: stop flag`).toBe(model.stopped);
            expect(summary.totalEmitted, `${label}: totalEmitted`).toBe(model.delivered.length);
            expect(h.billing.totalFor(RESULT_EVENT), `${label}: result charges`).toBe(model.delivered.length);
            expect(summary.sources[0]?.firstSeen, `${label}: records classified (a stopped run must not look at further rows)`).toBe(model.classified);
            expect(summary.sources[0]?.emitted, `${label}: emitted`).toBe(model.delivered.length);
            expect(summary.sources[0]?.watchlistHits, `${label}: watchlistHits of delivered rows`).toBe(model.deliveredMatches);
        }
        bump('router.budget.scenarios', BUDGET_SCENARIOS);
        bump('router.budget.stoppedRuns', stopped);
        bump('router.budget.limitRows', limitRows);
        expect(stopped).toBeGreaterThan(20);
        expect(limitRows).toBeGreaterThan(10);
    }, 120_000);
});

describe('PART 3 a row whose own charge is refused outright stops the run before any later row is looked at', () => {
    it('with a 0.05 row and a 0.03 hit, a hit that leaves less than one row price makes the next row the refused one', async () => {
        const rowCount = 12;
        const texts = Array.from({ length: rowCount }, () => 'Acme Corp LLC');
        const oracle = refSanitize(['acme']);
        const prices = { [RESULT_EVENT]: 0.05, [WATCHLIST_HIT_EVENT]: 0.03 };
        let refusedWithRowsLeft = 0;
        for (const budget of [0.11, 0.12, 0.19, 0.2, 0.27, 0.28, 0.35, 0.36]) {
            const h = makeHarness({ prices, budgetUsd: budget });
            const summary = await run(makeRecords(texts), ['acme'], h, { maxWatchlistHitsPerRun: 1_000, maxWatchlistSpendUsd: 1_000 });
            const model = await modelBudgetRun(texts, oracle, prices, budget);
            const label = `budget ${budget}`;
            expect(h.rows.map((row) => row.record_id), `${label}: delivered`).toEqual(model.delivered);
            expect(h.hitRecordIds, `${label}: hits`).toEqual(model.hits);
            expect(summary.stoppedOnChargeLimit, label).toBe(true);
            // The refused row was classified (it is the record whose own charge failed); nothing after it was.
            expect(summary.sources[0]?.firstSeen, `${label}: classified rows`).toBe(model.delivered.length + 1);
            expect(model.classified, label).toBe(model.delivered.length + 1);
            expect(model.delivered.length, label).toBeLessThan(rowCount - 1);
            refusedWithRowsLeft += 1;
        }
        bump('router.refusedRow.scenarios', refusedWithRowsLeft);
    });
});

describe('PART 3 FakeBilling budget semantics (the double the budget scenarios stand on)', () => {
    it('charges only what the budget affords, reports the limit once another unit is unaffordable, and refuses beyond it', async () => {
        const stepwise = new FakeBilling(true, { unit: 0.05 }, 0.12);
        expect(await stepwise.charge('unit', 1)).toEqual({ chargedCount: 1, eventChargeLimitReached: false });
        expect(await stepwise.charge('unit', 1)).toEqual({ chargedCount: 1, eventChargeLimitReached: true });
        expect(await stepwise.charge('unit', 1)).toEqual({ chargedCount: 0, eventChargeLimitReached: true });
        expect(stepwise.totalFor('unit')).toBe(2);

        const bulk = new FakeBilling(true, { unit: 0.05 }, 0.12);
        expect(await bulk.charge('unit', 5)).toEqual({ chargedCount: 2, eventChargeLimitReached: true });
        expect(bulk.totalFor('unit')).toBe(2);

        const unpriced = new FakeBilling(true, {}, 0.01);
        expect(await unpriced.charge('anything', 3)).toEqual({ chargedCount: 3, eventChargeLimitReached: false });
    });
});

// -- explicit attacker scenarios -----------------------------------------------------------------------------------

describe('PART 3 attacker scenarios through runEngine', () => {
    const entityName = (i: number): string => `entity-${String(i).padStart(3, '0')}-corp`;

    it('a list of 600 valid keywords: only the first 500 are accepted, keywords 501-600 never match and are never charged', async () => {
        const watchlist = Array.from({ length: 600 }, (_, i) => entityName(i));
        const records = makeRecords(Array.from({ length: 600 }, (_, i) => `Filing by ${entityName(i).toUpperCase()} LLC`));
        const h = makeHarness();
        const summary = await run(records, watchlist, h, { maxWatchlistHitsPerRun: 100_000, maxWatchlistSpendUsd: 10_000 });

        expect(summary.watchlist).toMatchObject({ accepted: 500, rejected: 100, hitsCharged: 500 });
        expect(h.rows).toHaveLength(600);
        h.rows.forEach((row, i) => {
            expect(row.is_watchlist_match, `row ${i}`).toBe(i < 500);
            expect(row.matched_watchlist_keyword, `row ${i}`).toBe(i < 500 ? entityName(i) : null);
        });
        expect(hitCharges(h)).toBe(500);
        expect(h.hitRecordIds).toEqual(Array.from({ length: 500 }, (_, i) => `r${i}`));
        bump('router.attacker.keywords600', 1);
    });

    it('the same 600 keywords under the default per-run caps are charged at most 200 times', async () => {
        const watchlist = Array.from({ length: 600 }, (_, i) => entityName(i));
        const records = makeRecords(Array.from({ length: 600 }, (_, i) => `Filing by ${entityName(i)} LLC`));
        const h = makeHarness();
        const summary = await run(records, watchlist, h);
        expect(summary.watchlist.accepted).toBe(500);
        expect(summary.watchlist.hitsCharged).toBe(200);
        expect(hitCharges(h)).toBe(200);
        expect(h.rows.filter((r) => r.is_watchlist_match)).toHaveLength(500);
    });

    it('a 1 MB single-token string as the watchlist is cut, its only (truncated) piece is dropped and reported once: nothing accepted, nothing charged', async () => {
        const oneMegabyte = 'x'.repeat(1024 * 1024);
        const records = makeRecords(['xxxx', oneMegabyte, 'x', 'Acme Corp', '']);
        const h = makeHarness();
        const summary = await run(records, oneMegabyte, h);
        expectNoWatchlistEffect(h, summary, records, '1 MB single token');
        // The bare string is cut at 200,000 units; its only piece may be truncated, so it is dropped and reported once.
        expect(summary.watchlist.rejected).toBe(1);
        const list = sanitizeKeywordList(oneMegabyte);
        expect(list.rejected).toEqual([{ value: '(bare string cut at 200000 units; its last entry was dropped)', reason: 'over_limit' }]);
    });

    it('a 1 MB string of one-letter pieces ("a,a,a,...") yields nothing accepted and nothing charged', async () => {
        const flood = 'a,'.repeat(512 * 1024);
        const records = makeRecords(['a', 'aaaa', 'banana', 'Acme Corp']);
        const h = makeHarness();
        const summary = await run(records, flood, h);
        expectNoWatchlistEffect(h, summary, records, '1 MB single-letter flood');
        // 200,000 units are read (100,000 pieces), 5,000 are inspected, the rest is one over_limit entry, the cut another
        expect(summary.watchlist.rejected).toBe(5_002);
    });

    it('a 1 MB string of blanks, zero-width characters or punctuation yields nothing accepted and nothing charged', async () => {
        const records = makeRecords(['a', ' ', '\u200b', '--', 'Acme Corp']);
        for (const flood of [' '.repeat(1024 * 1024), '\u200b'.repeat(1024 * 1024), '\n'.repeat(1024 * 1024), '-'.repeat(1024 * 1024), '\u2060\ufeff\u200e'.repeat(350_000)]) {
            const h = makeHarness();
            const summary = await run(records, flood, h);
            expectNoWatchlistEffect(h, summary, records, `1 MB flood ${esc(flood, 6)}`);
        }
    });

    it('a 1 MB string of one repeated valid keyword is accepted once and charged once per matching row', async () => {
        const flood = 'ab,'.repeat(350_000);
        const records = makeRecords(['Cabin', 'zzz', 'AB']);
        const h = makeHarness();
        const summary = await run(records, flood, h);
        expect(summary.watchlist.accepted).toBe(1);
        // 4,999 duplicates among the 5,000 inspected pieces, plus one over_limit entry for the rest and one for the cut
        expect(summary.watchlist.rejected).toBe(5_001);
        expect(h.rows.map((r) => r.is_watchlist_match)).toEqual([true, false, true]);
        expect(hitCharges(h)).toBe(2);
    });

    it('a 1 MB string of distinct keywords is capped at 500 accepted', async () => {
        const flood = Array.from({ length: 120_000 }, (_, i) => `k${String(i).padStart(6, '0')}x`).join(',');
        expect(flood.length).toBeGreaterThan(1_000_000);
        const records = makeRecords(['k000007x', 'k000499x', 'k000500x', 'k119999x']);
        const h = makeHarness();
        const summary = await run(records, flood, h);
        expect(summary.watchlist.accepted).toBe(500);
        expect(h.rows.map((r) => r.is_watchlist_match)).toEqual([true, true, false, false]);
        expect(hitCharges(h)).toBe(2);
    });

    it('a 1 MB haystack is matched (or not) correctly, and an empty watchlist never matches it', async () => {
        // The keyword sits inside the first 8,192 units, the only part of a haystack that is searched.
        const big = `Acme Corp ${'filler '.repeat(150_000)}`;
        expect(big.length).toBeGreaterThan(1_000_000);
        const records = makeRecords([big, 'filler']);
        const withList = makeHarness();
        const matched = await run(records, ['acme corp'], withList);
        expect(withList.rows.map((r) => r.is_watchlist_match)).toEqual([true, false]);
        expect(matched.watchlist.hitsCharged).toBe(1);

        const without = makeHarness();
        const summary = await run(records, [''], without);
        expectNoWatchlistEffect(without, summary, records, '1 MB haystack, empty watchlist');
    });

    it('prototype-polluting strings as a watchlist: matched and charged like any keyword, nothing polluted', async () => {
        const records = makeRecords(['the constructor of x', 'a __proto__ chain', 'unrelated', 'toString']);
        const h = makeHarness();
        const summary = await run(records, ['__proto__', 'constructor', 'toString'], h);
        expect(h.rows.map((r) => r.matched_watchlist_keyword)).toEqual(['constructor', '__proto__', null, 'toString']);
        expect(summary.watchlist).toMatchObject({ accepted: 3, hitsCharged: 3 });
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_KEYS);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});
