/**
 * Writes the two data files the programmatic-distribution layer (distribution/) is built on, straight from the
 * TypeScript registries, the pricing catalog and the TypeScript watchlist guard, so the TypeScript code stays the single
 * source of truth and the Python package never hand-copies a source id, a price or a limit:
 *
 *   distribution/python/src/regulatory_engines/data/engines.json    engine registry, held reasons, credential fields, events, limits, and what the
 *                                                                   Python port cannot read from its own Unicode tables: the guard's constants and the
 *                                                                   code point ranges the guard removes (Default_Ignorable_Code_Point, Bidi_Control, C0/C1)
 *   distribution/python/tests/fixtures/guard_parity.json            inputs + the TypeScript guard's output for each, for the Python port and the n8n Code node
 *
 *   npx tsx scripts/generate_distribution_data.ts           write both files
 *   npx tsx scripts/generate_distribution_data.ts --check   exit 1 when a committed file differs from what would be written
 *
 * The builders are exported and free of side effects: test/distribution_sync.test.ts imports them and compares the
 * result with the committed files. Nothing is written unless this file is the entry point.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { z } from 'zod';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import {
    describeSanitization,
    findKeywordMatch,
    MAX_BARE_STRING_UNITS,
    MAX_CANDIDATES,
    MAX_COMBINING_RUN,
    MAX_HAYSTACK_UNITS,
    MAX_KEYWORD_LENGTH,
    MAX_KEYWORDS,
    MAX_NORMALISE_PASSES,
    MAX_RAW_KEYWORD_UNITS,
    MAX_TOTAL_RAW_UNITS,
    MIN_KEYWORD_LENGTH,
    normaliseKeyword,
    sanitizeKeywordList,
} from '../lib/_guards.js';
import { DEFAULT_HIT_BILLER_OPTIONS, START_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { billingEventFor, type EngineDefinition, EngineInputSchema } from '../lib/router_core.js';
import { NAMESPACE_PATTERN } from '../lib/state.js';
import { DELTA_MODES, type RecordClass } from '../lib/types.js';
import { ALL_PRICING, type EnginePricing } from '../pricing/event_catalog.js';
import { ENGINE_META } from './actor_files.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Output files, relative to the `master_engines` package root. */
export const ENGINES_JSON_PATH = 'distribution/python/src/regulatory_engines/data/engines.json';
export const GUARD_PARITY_JSON_PATH = 'distribution/python/tests/fixtures/guard_parity.json';

/** Fixed seed of the parity corpus: the committed file only changes when the guard or this corpus changes. */
export const PARITY_SEED = 20261021;

const ENGINES: readonly EngineDefinition[] = [regtechEngine, tendersEngine, patentsEngine];

/**
 * What lib/_guards.ts removes from a keyword, written the same way (property escapes plus the C0/C1 controls). `INVISIBLE` there is not exported, so this is a
 * copy of that pattern; test/distribution_sync.test.ts proves the copy is exact by running the real guard on every code point, so a change to the guard's
 * pattern fails that test instead of silently leaving the Python port behind.
 */
const REMOVED_BY_THE_GUARD = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;

/** An inclusive range of code points. */
export type CodePointRange = readonly [first: number, last: number];

let removedRangesCache: readonly CodePointRange[] | undefined;
let whiteSpaceRangesCache: readonly CodePointRange[] | undefined;

/** The code points (surrogates left out) for which `test` holds, as inclusive ranges merged over adjacent code points. */
function rangesWhere(test: (character: string) => boolean): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let first = -1;
    for (let codePoint = 0; codePoint <= 0x110000; codePoint += 1) {
        const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
        const hit = codePoint <= 0x10ffff && !surrogate && test(String.fromCodePoint(codePoint));
        if (hit && first < 0) first = codePoint;
        if (!hit && first >= 0) {
            ranges.push([first, codePoint - 1]);
            first = -1;
        }
    }
    return ranges;
}

/**
 * Every code point the guard removes, as inclusive ranges merged over adjacent code points. The surrogates are left out: a lone surrogate is rejected
 * before cleaning, and Python holds it as a code point of its own. 19 ranges (4,239 code points) on Unicode 16.0, the version of Node 22.
 * The Python regular expression is built from these ranges, so Python never consults `unicodedata` for what is invisible.
 */
export function computeRemovedRanges(): CodePointRange[] {
    removedRangesCache ??= rangesWhere((character) => REMOVED_BY_THE_GUARD.test(character));
    return removedRangesCache.map(([first, last]) => [first, last]);
}

/**
 * The Unicode White_Space characters, which cut a long haystack (`/\p{White_Space}/u` in the guard): 25 code points in 10 ranges. The property is not in
 * Python's `unicodedata` and differs from both JavaScript's `\s` (it has U+0085 and not U+FEFF) and `str.isspace`, so the port reads it from engines.json.
 */
const WHITE_SPACE_OF_THE_GUARD = /\p{White_Space}/u;
export function computeWhiteSpaceRanges(): CodePointRange[] {
    whiteSpaceRangesCache ??= rangesWhere((character) => WHITE_SPACE_OF_THE_GUARD.test(character));
    return whiteSpaceRangesCache.map(([first, last]) => [first, last]);
}

/** `engines.json` is derived from the registries, the pricing catalog and the guard; the Python package validates against it. */
export function buildEnginesData(): Record<string, unknown> {
    const maxItems = (EngineInputSchema.shape.maxItemsPerSource as z.ZodDefault<z.ZodNumber>).removeDefault();
    if (maxItems.minValue === null || maxItems.maxValue === null) throw new Error('maxItemsPerSource must have a minimum and a maximum in EngineInputSchema.');

    const engines: Record<string, unknown> = {};
    for (const engine of ENGINES) {
        const pricing = ALL_PRICING.find((candidate: EnginePricing) => candidate.engine === engine.slug);
        const meta = ENGINE_META[engine.slug];
        if (!pricing || !meta) throw new Error(`No pricing or metadata for ${engine.slug}.`);
        const hit = pricing.events.find((event) => event.name === WATCHLIST_HIT_EVENT);
        if (!hit) throw new Error(`${engine.slug} has no ${WATCHLIST_HIT_EVENT} event.`);
        const classes: readonly RecordClass[] = ['first_seen', 'updated', 'unchanged'];
        engines[engine.slug] = {
            slug: engine.slug,
            title: meta.title,
            description: meta.description,
            memoryMbytes: pricing.memoryMbytes,
            startEvent: START_EVENT,
            startPriceUsd: pricing.startPriceUsd,
            credentialFields: Object.fromEntries(Object.entries(engine.credentialFields ?? {}).map(([field, target]) => [field, { source: target.source, option: target.option }])),
            sources: engine.connectors.map((connector) => ({
                id: connector.id,
                status: connector.status,
                description: connector.description,
                heldReason: connector.status === 'held' ? (connector.heldReason ?? null) : null,
                requiredOptions: [...(connector.requiredOptions ?? [])],
                billing: connector.status === 'active' ? Object.fromEntries(classes.map((cls) => [cls, billingEventFor(connector, cls)])) : null,
            })),
            events: pricing.events.map((event) => ({ name: event.name, title: event.title, priceUsd: event.priceUsd, basis: event.basis })),
            recordLevelEvents: [...(engine.extraBillingEvents ?? [])],
            watchlistHit: { event: hit.name, priceUsd: hit.priceUsd },
        };
    }
    return {
        schemaVersion: 1,
        generatedBy: 'scripts/generate_distribution_data.ts',
        limits: {
            deltaModes: [...DELTA_MODES],
            defaultDeltaMode: EngineInputSchema.shape.deltaMode.parse(undefined),
            maxItemsPerSource: { min: maxItems.minValue, max: maxItems.maxValue, default: EngineInputSchema.shape.maxItemsPerSource.parse(undefined) },
            stateNamespacePattern: NAMESPACE_PATTERN.source,
            watchlist: {
                minKeywordLength: MIN_KEYWORD_LENGTH,
                maxKeywordLength: MAX_KEYWORD_LENGTH,
                maxKeywords: MAX_KEYWORDS,
                maxRawKeywordUnits: MAX_RAW_KEYWORD_UNITS,
                maxCandidates: MAX_CANDIDATES,
                maxBareStringUnits: MAX_BARE_STRING_UNITS,
                maxHaystackUnits: MAX_HAYSTACK_UNITS,
                maxNormalisePasses: MAX_NORMALISE_PASSES,
                maxCombiningRun: MAX_COMBINING_RUN,
                maxTotalRawUnits: MAX_TOTAL_RAW_UNITS,
                removedRanges: computeRemovedRanges(),
                whiteSpaceRanges: computeWhiteSpaceRanges(),
            },
            defaultMaxWatchlistHitsPerRun: DEFAULT_HIT_BILLER_OPTIONS.maxHitsPerRun,
            defaultMaxWatchlistSpendUsd: DEFAULT_HIT_BILLER_OPTIONS.maxHitSpendUsd,
        },
        engines,
    };
}

/** mulberry32: a tiny seeded generator, so the corpus is reproducible and nothing depends on the clock or Math.random. */
function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Building blocks of the seeded corpus: everything the guard has a rule for, plus plain words. */
const WORDS = ['Acme', 'Corp', 'Pfizer', 'Banco', 'Santander', 'Novartis', 'OFAC', 'vessel', 'Global', 'Holdings', 'AG', 'plc', 'S.A.', 'Ltd', 'GmbH', 'Siemens', 'Bayer', 'Tesla', 'Huawei', 'Rosneft'];
const DIGITS = ['0', '1', '7', '42', '2026', '007'];
const PUNCTUATION = ['-', '.', '(', ')', '&', "'", '"', '/', '_', '!', '#', '--', '..', '()'];
// The pools below are written as escapes on purpose (an editor must not be able to damage or hide them). WHITESPACE: tab, vertical tab, form feed, NEL, line and paragraph
// separators, no-break, Ogham, em, narrow no-break, medium mathematical and ideographic spaces. INVISIBLE_CHARS: C0 and C1 controls, soft hyphen, combining grapheme joiner, Arabic letter
// mark, Hangul fillers (halfwidth and fullwidth too), Khmer inherent vowels, Mongolian selectors, zero-width and direction marks, bidi embeddings and isolates, word joiner and invisible
// operators, two unassigned default-ignorable code points, variation selectors (and their supplement), BOM, interlinear annotation, a Duployan and a musical format control, tag characters.
// UNICODE_LETTERS: accented and special-casing letters (sharp s, dotted capital I, dotless i, sigma forms), compatibility characters that NFKC rewrites (Ohm, Kelvin and Angstrom signs,
// ligatures, Roman numeral, superscript, circled digit, fullwidth and halfwidth forms, square katakana, digraphs, numero sign, vulgar fraction), CJK, Cyrillic, Arabic and Thai text,
// Arabic-Indic digits, astral mathematical letters and digits, a combining mark and a Georgian capital. COMPOSING: base letters, combining marks and Hangul jamo, which an invisible
// character keeps apart until it is removed. EMOJI_AND_SURROGATES: astral emoji (one with a skin-tone modifier) and lone surrogate halves.
// Every code point above is assigned in Unicode 14 (the oldest Unicode that a supported Python ships), except the default-ignorable ones, which the port reads from engines.json.
const WHITESPACE = [' ', '  ', '\t', '\n', '\r\n', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029', '\u00a0', '\u1680', '\u2003', '\u202f', '\u205f', '\u3000'];
const INVISIBLE_CHARS = [
    '\u0000', '\u0001', '\u001f', '\u007f', '\u0080', '\u009f', '\u00ad', '\u034f', '\u061c', '\u115f', '\u1160', '\u17b4', '\u17b5', '\u180b', '\u180e', '\u200b', '\u200c', '\u200d',
    '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2060', '\u2061', '\u2062', '\u2065', '\u2066', '\u2069', '\u206f', '\u3164', '\ufe00', '\ufe0f', '\ufeff',
    '\uffa0', '\ufff0', '\ufff9', '\u{1bca0}', '\u{1d173}', '\u{e0001}', '\u{e0067}', '\u{e007f}', '\u{e0100}', '\u{e0fff}',
];
const UNICODE_LETTERS = ['\u00e9', '\u00df', '\u00f1', '\u00d8', '\u0130', '\u0131', '\u03a3', '\u03c3', '\u03c2', '\u03a9', '\u2126', '\u212a', '\u212b', '\ufb01', '\ufb03', '\u216b', '\u00b2', '\u2460', '\uff21', '\uff71', '\u3300', '\u01c6', '\u01c4', '\u01c8', '\u0149', '\u01f0', '\u1e9e', '\u2116', '\u00bd', '\u6f22\u5b57', '\u041f\u0440\u0438\u0432\u0435\u0442', '\u0645\u0631\u062d\u0628\u0627', '\u0661\u0662\u0663', '\u{1d400}', '\u{1d7cf}', '\u{20bb7}', 'e\u0301', '\u0e01', '\u1c90'];
const COMPOSING = ['a', 'e', 'A', 'E', '\u0301', '\u0308', '\u0323', '\u0300', '\u0345', '\u1100', '\u1112', '\u1161', '\u1175', '\u11a8', '\u11ab', '\uff9e', '\u3099', '\uff45'];
const MARK_POOL = ['\u0301', '\u0308', '\u0323', '\u0300', '\u0345', '\u0316', '\u0483', '\u0903', '\u20dd', '\u0488', '\u093c', '\u3099', '\u0951', '\u0e31'];
const EMOJI_AND_SURROGATES = ['\u{1f600}', '\u{1f44d}\u{1f3fd}', '\ud800', '\udc00', '\ud83d'];

/** One random token: a word, digits, punctuation, whitespace, an invisible, a non-ASCII character, a composing sequence part or an emoji or surrogate. */
function randomAtom(rng: () => number): string {
    const pick = (pool: readonly string[]): string => pool[Math.floor(rng() * pool.length)] ?? '';
    const roll = rng();
    if (roll < 0.26) return pick(WORDS);
    if (roll < 0.33) return pick(DIGITS);
    if (roll < 0.42) return pick(PUNCTUATION);
    if (roll < 0.52) return pick(WHITESPACE);
    if (roll < 0.7) return pick(INVISIBLE_CHARS);
    if (roll < 0.8) return pick(UNICODE_LETTERS);
    if (roll < 0.91) return pick(COMPOSING);
    return pick(EMOJI_AND_SURROGATES);
}

function randomText(rng: () => number, maxAtoms: number): string {
    const count = Math.floor(rng() * (maxAtoms + 1));
    let text = '';
    for (let i = 0; i < count; i += 1) text += randomAtom(rng);
    return text;
}

function flipCase(text: string): string {
    return [...text].map((ch, index) => (index % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join('');
}

/** The one-unit invisibles of the pool: padding of a chosen length. */
const PADDING_CHARS = INVISIBLE_CHARS.filter((ch) => ch.length === 1);

/** A random watchlist-shaped value: mostly arrays of strings, sometimes a bare string, a malformed container, or an entry whose length is within a few units of the raw cap. */
function randomWatchlistInput(rng: () => number): unknown {
    const roll = rng();
    if (roll < 0.14) {
        const separators = [',', ';', '\n', '\r', ', ', ' ; ', ',,', ''];
        const parts = Array.from({ length: Math.floor(rng() * 6) + 1 }, () => randomText(rng, 4));
        let text = '';
        for (const part of parts) text += part + (separators[Math.floor(rng() * separators.length)] ?? ',');
        return text;
    }
    if (roll < 0.2) {
        const malformed: unknown[] = [42, 0, 1.5, true, false, { a: 1 }, {}, { watchlist: ['Acme'] }, 1e21];
        return malformed[Math.floor(rng() * malformed.length)];
    }
    if (roll < 0.22) {
        // Invisible padding of 4090 to 4101 units around a short word: some entries are within the raw cap (and cleaned), some are one unit over it.
        const word = ['ab', 'Acme', 'x', '\u00e9'][Math.floor(rng() * 4)] ?? 'ab';
        const filler = PADDING_CHARS[Math.floor(rng() * PADDING_CHARS.length)] ?? '\u200b';
        const padding = filler.repeat(MAX_RAW_KEYWORD_UNITS - 6 + Math.floor(rng() * 12) - word.length);
        const entry = rng() < 0.5 ? `${padding}${word}` : `${word}${padding}`;
        return rng() < 0.5 ? [entry] : ['Acme Corp', entry, randomText(rng, 3)];
    }
    if (roll < 0.25) {
        // A run of 13 to 18 combining marks (the limit is 16), sometimes kept apart by zero-width spaces that cleaning removes, so that the run only appears on the second pass.
        const marks = Array.from({ length: 13 + Math.floor(rng() * 6) }, () => MARK_POOL[Math.floor(rng() * MARK_POOL.length)] ?? '\u0301').join(rng() < 0.25 ? '\u200b' : '');
        const base = ['a', 'b', 'Acme', 'x', '\u00e9', '\u{1d400}'][Math.floor(rng() * 6)] ?? 'a';
        const entry = `${base}${marks}${rng() < 0.3 ? '\u200b' : ''}${rng() < 0.3 ? 'me' : ''}`;
        return rng() < 0.5 ? [entry] : ['Acme Corp', entry, randomText(rng, 3)];
    }
    const length = Math.floor(rng() * 8) + 1;
    const items: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
        const kind = rng();
        if (kind < 0.07) items.push([randomText(rng, 3)]);
        else if (kind < 0.12) items.push(Math.floor(rng() * 1000) / (rng() < 0.5 ? 1 : 100));
        else if (kind < 0.15) items.push(null);
        else if (kind < 0.18) items.push(rng() < 0.5);
        else if (kind < 0.21) items.push({ keyword: randomText(rng, 3) });
        else if (kind < 0.3 && items.length > 0 && typeof items[items.length - 1] === 'string') items.push(flipCase(items[items.length - 1] as string));
        else items.push(randomText(rng, 5));
    }
    return items;
}

interface NamedCase {
    name: string;
    input: unknown;
}

/**
 * Code points next to a removed range that are NOT assigned in Unicode 14.0: the corpus must not contain a character whose NFKC, case or category an older Python
 * (3.11 ships Unicode 14.0) could see differently, so these neighbours are left out (the removed code points themselves are fine: the port reads them from engines.json).
 */
const NEIGHBOURS_UNASSIGNED_IN_UNICODE_14 = new Set<number>([0xfefe, 0xff00, 0xffef, 0x1bca4, 0xdffff, 0xe1000]);

/** The code points the guard removes, one string each, and the ends, middles and neighbours of its ranges: inputs for the corpus (the expected values always come from running the guard). */
function removedCodePointInputs(): { every: string[]; ends: string[]; middles: string[]; neighbours: string[] } {
    const ranges = computeRemovedRanges();
    const text = (codePoint: number): string => String.fromCodePoint(codePoint);
    return {
        every: ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_unused, offset) => text(first + offset))),
        ends: ranges.flatMap(([first, last]) => (first === last ? [text(first)] : [text(first), text(last)])),
        middles: ranges.filter(([first, last]) => last - first >= 2).map(([first, last]) => text(Math.floor((first + last) / 2))),
        neighbours: ranges.flatMap(([first, last]) => [first - 1, last + 1]).filter((codePoint) => codePoint >= 0 && !NEIGHBOURS_UNASSIGNED_IN_UNICODE_14.has(codePoint)).map(text),
    };
}

const NAMED_SANITIZE_CASES = (): NamedCase[] => {
    const repeat = (text: string, times: number): string => text.repeat(times);
    const numbered = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `kw${String(index).padStart(4, '0')}`);
    const removed = removedCodePointInputs();
    const raw = MAX_RAW_KEYWORD_UNITS;
    const MARKS_17 = '\u0301\u0308\u0323\u0300\u0345\u0316\u0483\u0903\u20dd\u0488\u093c\u3099\u0951\u0952\u0e31\u0e47\u0e48';
    return [
        // the five inputs of the ghost-billing root cause, and their close relatives
        { name: 'ghost: empty string element', input: [''] },
        { name: 'ghost: blank element', input: [' '] },
        { name: 'ghost: bare empty string', input: '' },
        { name: 'ghost: bare one-letter string', input: 'a' },
        { name: 'ghost: one-letter element', input: ['a'] },
        { name: 'ghost: bare blank string', input: '   ' },
        { name: 'ghost: mixed junk', input: ['', ' ', 'a', '--', '()', '\t\n'] },
        { name: 'ghost: empty array', input: [] },
        { name: 'ghost: null', input: null },
        // malformed containers and non-string elements
        { name: 'container: number', input: 42 },
        { name: 'container: zero', input: 0 },
        { name: 'container: boolean true', input: true },
        { name: 'container: boolean false', input: false },
        { name: 'container: object', input: { a: 1 } },
        { name: 'container: empty object', input: {} },
        { name: 'container: array in array', input: [['Acme', 'Corp']] },
        { name: 'elements: null, numbers, booleans', input: [null, 1, 2.5, true, false] },
        { name: 'elements: every JSON type next to a string', input: [0, -1, 1.5, 1e300, true, false, null, [], {}, ['a'], { a: 1 }, [[['deep']]], 'Acme Corp'] },
        { name: 'elements: empty nested containers', input: [[], [[]], {}, { a: {} }] },
        { name: 'elements: a non-string is rejected before its content is looked at', input: [['\ud800'], { k: '\ud800' }, '\ud800', ['Acme Corp']] },
        { name: 'elements: objects and nested arrays', input: [{ b: 1, 2: 2, 1: 3, a: [1, { c: null }] }, ['x', ['y']], {}] },
        { name: 'elements: numbers are previewed as [number], whatever their digits', input: [1e21, 1e-7, 0.000001, 123456789012345680000, 1.5, 100, 12345.6789, -3, -0.5] },
        { name: 'elements: a long object is previewed as the constant tag [object]', input: [{ description: 'x'.repeat(120), tags: ['alpha', 'beta', 'gamma'] }] },
        { name: 'elements: an object with control characters is previewed as [object]', input: [{ k: 'a\b\f\n\r\t\u0001\u001f\u007f' }] },
        { name: 'elements: an object with an astral character is previewed as [object]', input: [{ k: `${'x'.repeat(50)}\u{1f600}tail` }] },
        { name: 'elements: an object with unicode, quotes and a lone surrogate is previewed as [object]', input: [{ 'k"ey': 'line\nbreak \u2028 \u007f "quoted" \\ back', emoji: '\u{1f600}', lone: '\ud800' }] },
        // separators of a bare string
        { name: 'string: comma, semicolon, newline, CRLF separated', input: 'Acme Corp,Beta Ltd;Gamma\nDelta\r\nEpsilon' },
        { name: 'string: only separators', input: ',,;;\n\r' },
        { name: 'string: single letters are dropped', input: 'a,b,c' },
        { name: 'string: duplicates differing by case', input: 'Acme,ACME;acme' },
        { name: 'string: spaces are not separators', input: 'Acme Corp Beta Ltd' },
        { name: 'string: tab inside a keyword becomes a space', input: 'Acme\tCorp' },
        { name: 'string: fullwidth comma and semicolon are not separators', input: 'Acme\uff0cCorp\uff1bBeta' },
        // normalisation
        { name: 'normalise: surrounding and inner whitespace runs', input: ['  Acme   Corp  '] },
        { name: 'normalise: zero-width space fuses a word', input: ['Ac\u200bme'] },
        { name: 'normalise: zero-width only', input: ['\u200b\u200b'] },
        { name: 'normalise: zero-width around one letter', input: ['\u200ba\u200b'] },
        { name: 'normalise: tab between words', input: ['Acme\tCorp'] },
        { name: 'normalise: NEL and LS and PS between words', input: ['Acme\u0085Corp', 'Beta\u2028Ltd', 'Gamma\u2029Inc'] },
        { name: 'normalise: bidi override', input: ['Acme\u202eCorp', '\u202e\u202c'] },
        { name: 'normalise: BOM and soft hyphen', input: ['\ufeffAcme', 'Ac\u00adme'] },
        { name: 'normalise: NBSP and ideographic space', input: ['Acme\u00a0Corp', 'Beta\u3000Ltd'] },
        { name: 'normalise: C0 and C1 controls', input: ['Ac\u0000me', 'Be\u0085ta', 'Ga\u009fmma', 'De\u007flta'] },
        { name: 'normalise: fullwidth letters', input: ['\uff21\uff23\uff2d\uff25'] },
        { name: 'normalise: ligatures and Roman numerals', input: ['\ufb01nance', '\u216b', '\ufb03ce'] },
        { name: 'normalise: Kelvin, Ohm and Angstrom signs', input: ['\u212a', '\u2126m', '\u212bngstrom'] },
        { name: 'normalise: compatibility digits count as digits', input: ['\u00b2\u00b2', '\u2460\u2461', '\u0663\u0663', '\u00bd'] },
        { name: 'normalise: NFKC of numero sign', input: ['\u2116'] },
        { name: 'normalise: combining mark', input: ['e\u0301', 'Cafe\u0301'] },
        { name: 'normalise: astral math letters', input: ['\u{1d400}', '\u{1d400}\u{1d401}'] },
        { name: 'normalise: emoji only has no letter or digit', input: ['\u{1f600}\u{1f600}', '\u{1f600}a'] },
        { name: 'normalise: CJK and Cyrillic and Arabic', input: ['\u6f22\u5b57', '\u041f\u0440\u0438\u0432\u0435\u0442', '\u0645\u0631\u062d\u0628\u0627'] },
        // defect class 1: a lone surrogate is rejected as invalid_unicode before any cleaning
        { name: 'unicode: lone high surrogate alone', input: ['\ud800'] },
        { name: 'unicode: lone low surrogate alone', input: ['\udc00'] },
        { name: 'unicode: lone high surrogate at the start', input: ['\ud800Acme'] },
        { name: 'unicode: lone high surrogate in the middle', input: ['Ac\ud800me'] },
        { name: 'unicode: lone high surrogate at the end', input: ['Acme\ud800'] },
        { name: 'unicode: lone low surrogate at the start', input: ['\udc00Acme'] },
        { name: 'unicode: lone low surrogate in the middle', input: ['Ac\udc00me'] },
        { name: 'unicode: lone low surrogate at the end', input: ['Acme\udc00'] },
        { name: 'unicode: two high surrogates in a row', input: ['Ac\ud83d\ud83dme'] },
        { name: 'unicode: two low surrogates in a row', input: ['Ac\ude00\ude00me'] },
        { name: 'unicode: a low surrogate before a high one is two lone surrogates', input: ['Ac\ude00\ud83dme'] },
        { name: 'unicode: a well-formed pair is not a lone surrogate', input: ['Ac\u{1f600}me', 'Beta\u{1f600}', '\u{20bb7}\u{20bb7}'] },
        { name: 'unicode: halves split by an invisible character are two lone surrogates, not an emoji', input: ['\ud83d\u200b\ude00', 'Acme\ud83d\u200b\ude00'] },
        { name: 'unicode: a lone surrogate between zero-width characters', input: ['\u200b\ud800\u200b'] },
        { name: 'unicode: a lone surrogate is checked before the keyword would be too short', input: ['\ud800a', 'a\udc00'] },
        { name: 'unicode: a lone surrogate among valid keywords rejects only that entry', input: ['Acme', 'Be\ud800ta', 'Gamma'] },
        { name: 'unicode: lone surrogates and non-strings are told apart', input: [1, '\ud800', null, '\udc00'] },
        { name: 'unicode: bare string, one piece has a lone surrogate', input: 'Acme,Be\ud800ta;Gamma' },
        { name: 'unicode: bare string that is one lone surrogate', input: '\ud800' },
        { name: 'unicode: lone surrogate at the raw cap is invalid_unicode, one unit over it is too_long', input: [`${repeat('a', raw - 1)}\ud800`, `${repeat('a', raw)}\ud800`] },
        { name: 'unicode: a keyword that is long once cleaned and has a lone surrogate', input: [`${repeat('a', 300)}\ud800`] },
        // defect class 2: a raw keyword longer than 4096 UTF-16 units is too_long before any Unicode work
        { name: 'raw cap: 4096 units around a keyword are cleaned, 4097 are too_long', input: [`${repeat('\u200b', raw - 2)}ab`, `${repeat('\u200b', raw - 1)}cd`] },
        { name: 'raw cap: tag characters count two units each (4096 accepted, 4097 too_long)', input: [`${repeat('\u{e0020}', raw / 2 - 1)}ab`, `${repeat('\u{e0020}', raw / 2 - 1)}cde`] },
        { name: 'raw cap: 4096 and 4097 letters are too_long either way', input: [repeat('a', raw), repeat('a', raw + 1)] },
        { name: 'raw cap: a run of combining marks is rejected before it is normalised', input: [`a${repeat('\u0301', raw + 100)}`, `a${repeat('\u0301', 100)}`] },
        { name: 'raw cap: invisible padding is too_long, not empty', input: [repeat('\u200b', raw + 50)] },
        { name: 'raw cap: the cap is per entry, not for the list', input: [`${repeat('\u200b', raw - 2)}ab`, `${repeat('\u200b', raw - 2)}cd`] },
        { name: 'raw cap: one long piece of a bare string', input: `Acme,${repeat('b', raw + 50)},Beta Ltd` },
        { name: 'raw cap: a long entry next to non-strings', input: [`${repeat('\u200b', raw)}ab`, 7, { k: 'v' }, 'Acme'] },
        // defect class 3: every Default_Ignorable_Code_Point and Bidi_Control character, and the C0 and C1 controls, are removed
        { name: 'invisible: a letter plus every removed code point is a one-letter keyword', input: removed.every.map((ch) => `a${ch}`) },
        { name: 'invisible: the first and last code point of every removed range inside a word', input: removed.ends.map((ch, index) => `Key${index}${ch}End`) },
        { name: 'invisible: the middle of every long removed range inside a word', input: removed.middles.map((ch, index) => `Mid${index}${ch}End`) },
        { name: 'invisible: the code point before and after every removed range is kept (or is whitespace)', input: removed.neighbours.map((ch, index) => `Next${index}${ch}End`) },
        { name: 'invisible: Hangul fillers only', input: ['\u115f', '\u1160', '\u115f\u1160', '\u3164', '\uffa0', '\u3164\uffa0\u115f\u1160'] },
        { name: 'invisible: Hangul fillers inside and next to a letter', input: ['Ac\u3164me', 'Be\uffa0ta', 'a\u3164', '\u115fb', 'Ga\u1160mma'] },
        { name: 'invisible: Arabic letter mark', input: ['Ac\u061cme', '\u061c', '\u061ca', 'a\u061c\u061c'] },
        { name: 'invisible: tag characters', input: ['Acme\u{e0001}\u{e0067}\u{e0062}\u{e007f}', '\u{e0001}\u{e007f}', 'a\u{e0020}', '\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}'] },
        { name: 'invisible: variation selectors', input: ['Acme\ufe0f', '\ufe00\ufe0f', 'a\ufe0e', '\u{e0100}\u{e01ef}', 'Ac\u{e0100}me', 'Beta\ufe0e\ufe0f'] },
        { name: 'invisible: Mongolian free variation selectors and vowel separator', input: ['Ac\u180bme', '\u180e\u180d', 'ab\u180f', 'x\u180c'] },
        { name: 'invisible: combining grapheme joiner', input: ['a\u034fb', '\u034f', 'ab\u034f\u034f'] },
        { name: 'invisible: Khmer inherent vowels', input: ['a\u17b4b', '\u17b5', '\u17b4\u17b5'] },
        { name: 'invisible: invisible operators, interlinear annotation and format controls', input: ['a\u2062b', 'x\u2063y', '\ufff9ab\ufffb', '\u{1bca0}ab', '\u{1d173}ab\u{1d17a}', 'c\u2061d\u2064e'] },
        { name: 'invisible: unassigned default-ignorable code points', input: ['a\u2065b', 'a\u{e0000}b', 'a\u{e0fff}b', 'a\ufff0b', 'a\u{e0080}b', 'a\u{e01f0}b'] },
        { name: 'invisible: every bidi control', input: ['a\u061cb', 'c\u200ed', 'e\u200ff', 'g\u202ah', 'i\u202bj', 'k\u202cl', 'm\u202dn', 'o\u202ep', 'q\u2066r', 's\u2067t', 'u\u2068v', 'w\u2069x'] },
        { name: 'invisible: a removed character is not whitespace, so it fuses words while a tab separates them', input: ['Acme\u061cCorp', 'Acme\tCorp', 'Acme\u3164Corp', 'Acme\u00a0Corp'] },
        { name: 'invisible: only removed characters', input: ['\u061c\u200b', '\u{e0001}\u{e007f}\ufe0f', '\u0000\u007f\u0080\u009f', '\u034f\u17b4\u180b\ufeff\ufff0'] },
        // defect class 4: cleaning runs to a fixed point (NFKC first, removal after, so one pass is not idempotent)
        { name: 'fixpoint: e, zero-width space, combining acute settles to one character and is too_short', input: ['e\u200b\u0301'] },
        { name: 'fixpoint: the same with an upper-case letter and a combining grave', input: ['E\u200b\u0300', 'Acme'] },
        { name: 'fixpoint: two combining marks after a base letter', input: ['a\u200b\u0301\u0301', 'Acme'] },
        { name: 'fixpoint: decomposed Hangul syllable held apart by zero-width spaces', input: ['\u1112\u200b\u1161\u200b\u11ab', 'Acme'] },
        { name: 'fixpoint: composition exposed by a Hangul filler', input: ['e\u3164\u0301', 'e\u115f\u0301', 'Acme'] },
        { name: 'fixpoint: composition exposed by a variation selector or a tag character', input: ['e\ufe0f\u0301', 'e\u{e0067}\u0301', 'Acme'] },
        { name: 'fixpoint: composition exposed by an Arabic letter mark and a combining grapheme joiner', input: ['a\u061c\u0308', 'o\u034f\u0308', 'Acme'] },
        { name: 'fixpoint: fullwidth letter, zero-width space, combining mark', input: ['\uff45\u200b\u0301', '\uff41\u200b\u0301\u0301', 'Acme'] },
        { name: 'fixpoint: Hangul jamo through a Mongolian selector', input: ['\u1112\u180b\u1161\u180d\u11ab', 'Acme'] },
        { name: 'fixpoint: a keyword that is already settled is kept', input: ['Cafe\u0301 Paris', 'Cafe\u200b\u0301 Paris'] },
        { name: 'fixpoint: the settled spelling and the unsettled one are duplicates', input: ['Caf\u00e9', 'Cafe\u200b\u0301', 'CAFE\u200b\u0301'] },
        // case-insensitive de-duplication
        { name: 'dedupe: ASCII case', input: ['Acme', 'ACME', 'acme'] },
        { name: 'dedupe: after NFKC', input: ['\uff21\uff23\uff2d\uff25', 'ACME'] },
        { name: 'dedupe: after removing invisible characters', input: ['Acme', 'Ac\u061cme', 'AC\u3164ME', 'a\u200bcme'] },
        { name: 'dedupe: Turkish dotted I does not equal i', input: ['\u0130stanbul', 'istanbul', 'ISTANBUL'] },
        { name: 'dedupe: final sigma', input: ['\u03a3\u0391\u03a3', '\u03c3\u03b1\u03c2', '\u03c3\u03b1\u03c3'] },
        { name: 'dedupe: sharp s is not SS', input: ['Stra\u00dfe', 'STRASSE', 'strasse'] },
        { name: 'dedupe: first spelling wins', input: ['bAnCo', 'Banco', 'BANCO'] },
        // length bounds, counted in code points after normalisation
        { name: 'length: one character', input: ['x'] },
        { name: 'length: two characters', input: ['xy'] },
        { name: 'length: one astral letter', input: ['\u{1d400}'] },
        { name: 'length: 199 characters', input: [repeat('a', 199)] },
        { name: 'length: 200 characters', input: [repeat('a', 200)] },
        { name: 'length: 201 characters', input: [repeat('a', 201)] },
        { name: 'length: 200 code points of astral emoji plus a letter', input: [`${repeat('\u{1f600}', 199)}a`] },
        { name: 'length: 201 code points of astral emoji plus a letter (preview splits a surrogate pair)', input: [`${repeat('\u{1f600}', 200)}a`] },
        { name: 'length: measured after NFKC expansion', input: [repeat('\ufb03', 70)] },
        { name: 'length: 200 after NFKC expansion', input: [`${repeat('\ufb03', 66)}ab`] },
        { name: 'length: padded with invisible characters', input: [`${repeat('\u200b', 300)}ab`] },
        { name: 'length: padded with tag characters and variation selectors', input: [`${repeat('\u{e0100}', 300)}ab`, `ab${repeat('\ufe0f', 300)}`] },
        { name: 'length: long rejected string is previewed truncated', input: [repeat('Lorem ipsum ', 40)] },
        { name: 'order: over 200 characters without a letter is too_long, exactly 200 is no_letter_or_digit, one is too_short', input: [repeat('-', 201), repeat('-', 200), '-'] },
        // letter-or-digit rule
        { name: 'punctuation only', input: ['--', '..', '()', '__', '//', '#!', '"\''] },
        { name: 'punctuation with a digit', input: ['-1-', '(7)'] },
        // list size
        { name: 'size: 500 unique keywords', input: numbered(500) },
        { name: 'size: 501 unique keywords', input: numbered(501) },
        { name: 'size: a duplicate after the limit is a duplicate, a new one is over_limit', input: [...numbered(500), 'kw0000', 'zzz-new'] },
        { name: 'size: 600 keywords as one comma separated string', input: numbered(600).join(',') },
        // defect class 5: at most 5000 entries are inspected, the rest is one over_limit marker; a bare string is cut at 200000 units first
        { name: 'candidates: exactly 5000 entries are all inspected (no marker)', input: [...Array.from({ length: MAX_CANDIDATES - 1 }, () => 'a'), 'Acme Corp'] },
        {
            name: 'candidates: the 5000th entry is inspected, the 5001st and later are one over_limit marker',
            input: [...Array.from({ length: MAX_CANDIDATES - 2 }, () => 'a'), 'Acme Corp', { k: 1 }, 'Beta Corp', 7],
        },
        {
            name: 'string: a bare string of exactly 200000 units is read whole, even when it ends in an astral character',
            input: `${repeat(' ', MAX_BARE_STRING_UNITS - 18)},Alpha Corp,Beta\u{1f600}`,
        },
        {
            name: 'string: 200012 units, the window ends in the high half of an astral character: the half and the last piece are dropped',
            input: `${repeat(' ', MAX_BARE_STRING_UNITS - 17)},Alpha Corp,Beta\u{1f600},Gamma Corp`,
        },
        // MAX_COMBINING_RUN: a text with more than 16 consecutive combining marks (\p{M}) is empty, checked on every cleaning pass BEFORE normalising
        { name: 'marks: 16 consecutive combining marks are fine, 17 make the keyword empty', input: [`ab${repeat('\u0301', 16)}`, `cd${repeat('\u0323', 16)}`, `ab${repeat('\u0301', 17)}`, `cd${repeat('\u0323', 17)}`, 'Acme'] },
        { name: 'marks: 15, 16 and 17 marks in the middle of a word', input: [`Ac${repeat('\u0301', 15)}me`, `Ac${repeat('\u0308', 16)}me`, `Ac${repeat('\u0300', 17)}me`] },
        {
            name: 'marks: 17 different marks (Mn, Mc and Me) count together, 16 do not',
            input: [`ab${MARKS_17}`, `ab${MARKS_17.slice(0, -1)}`, `cd${repeat('\u0903', 17)}`, `cd${repeat('\u20dd', 17)}`, `cd${repeat('\u0903', 16)}`],
        },
        { name: 'marks: marks kept apart by letters never form a run', input: [`${'a\u0301'.repeat(40)}`, `a${repeat('\u0301', 10)}b${repeat('\u0301', 10)}`] },
        { name: 'marks: removal exposes a run on the second pass (the base does not compose with the first mark)', input: [`cb${'\u0301\u200b'.repeat(17)}`, `cb${'\u0301\u200b'.repeat(16)}`, 'Acme'] },
        { name: 'marks: removal exposes a run on the second pass (the base composes with the first mark, so 16 remain)', input: [`ba${'\u0301\u200b'.repeat(17)}`, `ba${'\u0301\u200b'.repeat(18)}`, 'Acme'] },
        { name: 'marks: variation selectors and the combining grapheme joiner are marks, so the run check sees them before they are removed', input: [`ab${repeat('\ufe0f', 17)}`, `ab${repeat('\ufe0f', 16)}`, `Acme${repeat('\u034f', 17)}`, `Acme${repeat('\u034f', 16)}`, `${repeat('\u{e0100}', 17)}ab`, `${repeat('\u{e0100}', 16)}ab`] },
        { name: 'marks: invisible characters that are not marks are removed, whatever their number', input: [`${repeat('\u200b', 17)}ab`, `${repeat('\u200b', 40)}cd`, `ef${repeat('\u2060', 17)}gh`] },
        { name: 'marks: marks that NFKC produces (halfwidth voiced sound marks) are seen on the next pass', input: [`ab${repeat('\uff9e', 17)}`, `ab${repeat('\uff9e', 16)}`, `cd${repeat('\uff9f', 17)}`] },
        { name: 'marks: the descending-class attack shape (NFKC must reorder it) is empty at once', input: [`ab${repeat('\u0345', 1365)}${repeat('\u0300', 1365)}${repeat('\u0316', 1364)}`, `cd${repeat('\u0345', 6)}${repeat('\u0300', 5)}${repeat('\u0316', 5)}`] },
        { name: 'marks: runs after an astral base and between astral letters', input: [`\u{1d400}${repeat('\u0301', 17)}`, `x\u{1d400}${repeat('\u0301', 16)}`, `\u{20bb7}${repeat('\u0308', 17)}y`] },
        { name: 'marks: a long run is empty_after_normalisation, not too_long, when the keyword is within the raw cap', input: [`ab${repeat('\u0301', 4000)}`, `ab${repeat('\u0301', 4094)}`] },
        // MAX_BARE_STRING_UNITS: a longer bare string is cut, the last piece (which the cut may have truncated) is dropped and reported
        {
            name: 'string: 200001 units, the cut falls inside the last piece, which is dropped',
            input: `${repeat(' ', MAX_BARE_STRING_UNITS - 21)},Alpha Corp,Pfizer Inc`,
        },
        { name: 'string: 200001 units with no separator in the window: nothing is left but the marker', input: repeat('a', MAX_BARE_STRING_UNITS + 1) },
        // preview(): a value longer than 60 units is cut at 57 units without ending in half of a surrogate pair
        {
            name: 'preview: an astral character straddling unit 57 is dropped whole, one ending on unit 57 is kept, short values are not cut',
            input: [`${repeat('-', 56)}\u{1f600}${repeat('-', 5)}`, `${repeat('-', 55)}\u{1f600}${repeat('-', 6)}`, `${repeat('-', 57)}\u{1f600}`, `${repeat('-', 58)}\u{1f600}`, `${repeat('-', 59)}\u{1f600}`, `${repeat('-', 56)}\u{1f600}\u{1f600}\u{1f600}`],
        },
        { name: 'preview: a lone high surrogate on unit 57 is dropped as well', input: [`${repeat('-', 56)}\ud83d${repeat('-', 5)}`, `${repeat('a', 56)}\udc00${repeat('a', 5)}`] },
        { name: 'preview: objects are never serialised, so nothing is cut inside a surrogate pair', input: [{ k: `${repeat('x', 49)}\u{1f600}${repeat('y', 10)}` }, { k: `${repeat('x', 50)}\u{1f600}${repeat('y', 10)}` }] },
        // MAX_TOTAL_RAW_UNITS: the strings of one list that proceed to Unicode work (4096 units or fewer) may add up to 200000 units; later entries are not inspected
        {
            name: 'total: strings adding up to exactly 200000 units are all inspected, a one-unit entry after them is not (one marker)',
            input: ['Acme', ...Array.from({ length: 48 }, () => repeat('a', raw)), repeat('b', MAX_TOTAL_RAW_UNITS - 4 - 48 * raw), 'Z'],
        },
        { name: 'total: 49 entries of 4092 units, the 49th crosses the budget', input: Array.from({ length: 49 }, (_unused, index) => repeat(String.fromCharCode(97 + (index % 26)), raw - 4)) },
        {
            name: 'total: entries that are not strings add nothing, nothing after the crossing entry is inspected (not even a later non-string)',
            input: [null, 1, { k: 1 }, repeat('c', raw + 904), ...Array.from({ length: 48 }, () => repeat('a', raw)), [1, 2], repeat('d', MAX_TOTAL_RAW_UNITS - 48 * raw), 7, 'Acme', 'Beta Corp', null],
        },
        // at least two letters or numbers: one alphanumeric character padded with punctuation is the one-letter needle in disguise
        { name: 'alnum: one letter or digit padded with punctuation is single_letter_or_digit', input: ['c.', 'd.', 'a.', '(a)', 'a |', '-0', '.0', '1)', 'A-', '(1)', '..a'] },
        { name: 'alnum: two letters or digits are enough, wherever the punctuation sits', input: ['BP', 'GE', '3M', 'a.b', 'a-1', '(ab)', '1.2', 'S.A.'] },
        { name: 'alnum: a pasted company list drops the legal-form fragments and keeps the names', input: 'Smith, J.\nBrown, A.; Acme Corp' },
        { name: 'alnum: no letter or digit at all stays no_letter_or_digit, and the order of the checks is length first', input: ['--', '..', '()', '-'.repeat(201), '!!!!'] },
        { name: 'alnum: a letter plus a combining mark is one alphanumeric character', input: ['q\u0307', 'a\u0345', 'a\u0345\u0345', 'ab\u0345'] },
        // one visible glyph that NFKC expands is one character, not a two-character keyword
        { name: 'glyph: one expanding compatibility character is too_short', input: ['\u2473', '\u2116', '\ufb01', '\u2474', '\u249c', '\u2488', '\ufdfa', '\u00bd', '\u2460'] },
        { name: 'glyph: two expanding characters are two characters', input: ['\u2473\u2473', '\u2116\u2116', '\ufb01\ufb01', '\u2460\u2461'] },
        { name: 'glyph: one expanding glyph padded with punctuation is still one character (too_short); typed words and two glyphs are kept', input: ['\u2473.', '\u2116.', '\ufb01.', '(\u2473)', '\u2116-', '\u3392,', 'no.', 'S.A.', 'a.b', '\u2116\u2116', '\u2473\u2473.', '\u2116 x', 'AT&T'] },
        { name: 'glyph: a visible character plus an invisible one is still one character', input: ['\u2473\u200b', '\u200b\u2116', '\ufb01\u00ad'] },
        // the NFKC expansion cap: a text that grows to more than 4x its length plus 16 units is empty
        { name: 'expansion: the Arabic ligature U+FDFA at several lengths', input: [repeat('\ufdfa', 2), repeat('\ufdfa', 3), repeat('\ufdfa', 11), repeat('\ufdfa', 12), repeat('\ufdfa', 40), `${repeat('\ufdfa', 3)}abcd`, `${'\ufdfa'}${repeat('a', 30)}`] },
        // preview(): a string is cut at 57 units and its control, invisible and lone surrogate characters become U+FFFD; anything else is a constant tag
        { name: 'preview: control characters, escape sequences and bidi controls in a rejected string become U+FFFD', input: ['\u001b[31mred', '\u202eevil\u0000', 'x\u0007y', '\u0085\u2028', '\u200b\u200b'] },
        { name: 'preview: the line and paragraph separators in a rejected string become U+FFFD too', input: ['\u2028\u2029', 'a\u2028--', '--\u2029', 'x\u0085--'] },
        { name: 'preview: a lone surrogate inside a rejected string becomes U+FFFD', input: ['\ud800\u001b[31m\nFAKE', 'ab\udc00', '\ud83d'] },
        { name: 'preview: a long rejected string with controls is cut at 57 units, then cleaned', input: [`\u001b${repeat('x', 100)}`, `${repeat('-', 55)}\u0000\u0001\u0002${repeat('-', 20)}`] },
        { name: 'preview: nested and wide values are constant tags', input: [[], [[[[[[[[[[1]]]]]]]]]], { a: { b: { c: {} } } }, Array.from({ length: 300 }, (_unused, index) => [index]), 12345, 0.5, true, false, null] },
        { name: 'preview: a deeply nested array is a constant tag', input: [Array.from({ length: 200 }).reduce<unknown>((inner) => [inner], [])] },
    ];
};

const NAMED_NORMALISE_CASES = (): NamedCase[] => {
    const removed = removedCodePointInputs();
    const repeat = (text: string, times: number): string => text.repeat(times);
    const label = (ch: string): string => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
    return [
        { name: 'e, zero-width space, combining acute is one character', input: 'e\u200b\u0301' },
        { name: 'a, zero-width space, two combining acutes', input: 'a\u200b\u0301\u0301' },
        { name: 'decomposed Hangul syllable held apart by zero-width spaces', input: '\u1112\u200b\u1161\u200b\u11ab' },
        { name: 'composition exposed by a Hangul filler', input: 'e\u3164\u0301' },
        { name: 'composition exposed by a tag character', input: 'e\u{e0067}\u0301' },
        { name: 'already composed text is unchanged', input: 'caf\u00e9 \u00e9\u0301' },
        { name: 'halves of an emoji kept apart by an invisible character meet when it is removed', input: '\ud83d\u200b\ude00' },
        { name: 'a lone surrogate survives cleaning', input: 'a\ud800b' },
        { name: 'invisible padding of 5000 units around two letters (no cap at this level)', input: `a${repeat('\u200b', 5000)}b` },
        { name: 'nothing but removed characters', input: '\u061c\u200b\u{e0001}\ufe0f\u3164\u115f\u034f' },
        { name: 'whitespace controls are spaces, invisibles are nothing', input: ' \tAcme\u2028\u200bCorp\u0085 ' },
        ...removed.ends.map((ch) => ({ name: `${label(ch)} between two letters: an end of a removed range`, input: `a${ch}b` })),
        ...removed.middles.map((ch) => ({ name: `${label(ch)} between two letters: the middle of a removed range`, input: `a${ch}b` })),
        ...removed.neighbours.map((ch) => ({ name: `${label(ch)} between two letters: next to a removed range, not removed`, input: `a${ch}b` })),
    ];
};

interface MatchCase {
    name: string;
    haystack: unknown;
    keywords: unknown;
}

const NAMED_MATCH_CASES = (): MatchCase[] => {
    const unitsMax = MAX_HAYSTACK_UNITS;
    /** A haystack of filler letters in which `keyword` starts at UTF-16 unit `offset`. */
    const at = (offset: number, keyword = 'Acme'): string => `${'z'.repeat(offset)}${keyword}`;
    const hiddenInside: Array<[string, string]> = [
        ['Arabic letter mark', '\u061c'],
        ['Hangul filler', '\u3164'],
        ['halfwidth Hangul filler', '\uffa0'],
        ['Hangul choseong filler', '\u115f'],
        ['tag character', '\u{e0067}'],
        ['variation selector', '\ufe0f'],
        ['variation selector supplement', '\u{e0100}'],
        ['combining grapheme joiner', '\u034f'],
        ['Mongolian free variation selector', '\u180b'],
        ['Khmer inherent vowel', '\u17b4'],
        ['invisible times', '\u2062'],
        ['unassigned default-ignorable', '\u2065'],
        ['zero-width non-joiner', '\u200c'],
        ['musical format control', '\u{1d173}'],
    ];
    return [
        { name: 'plain substring', haystack: 'Acme Corporation Ltd', keywords: ['acme'] },
        { name: 'case-insensitive', haystack: 'ACME CORP', keywords: ['Acme Corp'] },
        { name: 'no keyword', haystack: 'Acme Corp', keywords: [] },
        { name: 'empty haystack', haystack: '', keywords: ['Acme'] },
        { name: 'non-string haystack: null', haystack: null, keywords: ['Acme'] },
        { name: 'non-string haystack: number', haystack: 42, keywords: ['42'] },
        { name: 'non-string haystack: array', haystack: ['Acme'], keywords: ['Acme'] },
        { name: 'blank watchlist never matches', haystack: 'anything at all', keywords: ['', ' ', 'a'] },
        { name: 'bare empty string never matches', haystack: 'anything at all', keywords: '' },
        { name: 'first keyword in list order wins', haystack: 'Beta and Acme', keywords: ['Acme', 'Beta'] },
        { name: 'fullwidth haystack', haystack: '\uff21\uff23\uff2d\uff25 Corp', keywords: ['acme'] },
        { name: 'zero-width inside the haystack', haystack: 'Ac\u200bme Corp', keywords: ['acme'] },
        { name: 'tab in the haystack', haystack: 'Acme\tCorp', keywords: ['acme corp'] },
        { name: 'dotted capital I', haystack: '\u0130STANBUL Holdings', keywords: ['istanbul'] },
        { name: 'final sigma in the haystack', haystack: '\u03a3\u0391\u03a3 SA', keywords: ['\u03c3\u03b1\u03c2'] },
        { name: 'sharp s', haystack: 'Stra\u00dfe 1', keywords: ['strasse'] },
        { name: 'astral letters', haystack: '\u{1d400}\u{1d401} Holdings', keywords: ['ab'] },
        { name: 'keyword spelling of the list is returned, not the haystack spelling', haystack: 'BANCO SANTANDER', keywords: ['Banco Santander'] },
        // a keyword with a lone surrogate is invalid_unicode, so it can no longer match half of an astral character
        { name: 'a needle ending in a lone high surrogate is rejected and matches nothing', haystack: 'xa\u{1f600}y', keywords: ['a\ud83d'] },
        { name: 'a needle starting with a lone low surrogate is rejected and matches nothing', haystack: 'x\u{1f600}by', keywords: ['\ude00b'] },
        { name: 'a lone half as the whole keyword is rejected and matches nothing', haystack: 'x\u{1f600}y', keywords: ['\ud83d', '\ude00'] },
        { name: 'a lone surrogate in the haystack stays in the text', haystack: 'Ac\ud800me Corp', keywords: ['acme'] },
        { name: 'a lone surrogate beside the keyword does not hide it', haystack: '\ud83dAcme\ude00', keywords: ['acme'] },
        { name: 'halves kept apart by an invisible character meet when it is removed', haystack: 'x\ud83d\u200b\ude00y', keywords: ['xy', 'Beta'] },
        // matching cleans the haystack to a fixed point, like a keyword
        { name: 'fixpoint: a haystack that needs two cleaning passes matches the composed keyword', haystack: 'Cafe\u200b\u0301 Paris', keywords: ['caf\u00e9'] },
        { name: 'fixpoint: a keyword that needed two passes matches the composed haystack', haystack: 'Le caf\u00e9', keywords: ['Cafe\u200b\u0301'] },
        { name: 'fixpoint: both spellings meet', haystack: 'Cafe\u200b\u0301', keywords: ['Cafe\u200b\u0301'] },
        ...hiddenInside.map(([label, ch]) => ({ name: `invisible in the haystack: ${label}`, haystack: `Ac${ch}me Corp`, keywords: ['acme'] })),
        ...hiddenInside.map(([label, ch]) => ({ name: `invisible in the keyword: ${label}`, haystack: 'Acme Corp', keywords: [`Ac${ch}me`] })),
        { name: 'a keyword made of Hangul fillers only matches nothing', haystack: 'anything \u3164 at all', keywords: ['\u3164\u3164', '\u115f\u1160'] },
        // the haystack: up to 8192 units it is searched whole; a longer one only up to the last Unicode White_Space character inside the window, and not at all when the window has none
        { name: 'cut: a haystack of exactly 8192 units is searched whole', haystack: at(unitsMax - 4), keywords: ['Acme'] },
        { name: 'cut: the keyword starts at unit 8000 and the haystack is shorter than the window', haystack: at(unitsMax - 192), keywords: ['Acme'] },
        { name: 'cut: 8193 units without whitespace are not searched at all (the keyword ends on the last unit)', haystack: at(unitsMax - 3), keywords: ['Acme'] },
        { name: 'cut: 9004 units without whitespace are not searched at all (the keyword is at the start)', haystack: `Acme${'z'.repeat(unitsMax + 800)}`, keywords: ['Acme'] },
        { name: 'cut: whitespace beyond the window does not help', haystack: `${'z'.repeat(unitsMax + 800)} Acme`, keywords: ['Acme'] },
        { name: 'cut: whitespace on unit 8192, the first unit past the window: the whole window is searched', haystack: `${at(unitsMax - 4)} Corp`, keywords: ['Acme'] },
        { name: 'cut: whitespace on unit 8191: the keyword before it is found', haystack: `${'z'.repeat(unitsMax - 5)}Acme X${'z'.repeat(20)}`, keywords: ['Acme'] },
        { name: 'cut: the last whitespace inside the window is before the keyword: it is not found', haystack: `${'z'.repeat(unitsMax - 6)} Acme${'z'.repeat(20)}`, keywords: ['Acme'] },
        { name: 'cut: the searched text ends at the LAST whitespace inside the window (a word before it is found)', haystack: `Acme Beta ${'y'.repeat(unitsMax + 8)}`, keywords: ['Beta'] },
        { name: 'cut: the searched text ends at the LAST whitespace inside the window (a word after it is not)', haystack: `Acme Beta ${'y'.repeat(unitsMax + 8)}`, keywords: ['yyyy'] },
        { name: 'cut: an early keyword is found when the only whitespace in the window is early', haystack: `Acme Corp ${'z'.repeat(9000)} Beta`, keywords: ['Beta', 'Acme'] },
        { name: 'cut: 8192 zero-width spaces are not whitespace and use up the whole window', haystack: `${'\u200b'.repeat(unitsMax)}Acme`, keywords: ['Acme'] },
        { name: 'cut: invisible characters count as units and are not cut points', haystack: `Ac${'\u200b'.repeat(unitsMax - 2)}me`, keywords: ['Acme'] },
        { name: 'cut: a keyword split by thousands of invisible characters inside the window is found', haystack: `Ac${'\u200b'.repeat(4000)}me`, keywords: ['Acme'] },
        { name: 'cut: an astral character straddling unit 8192 and no whitespace', haystack: `${'z'.repeat(unitsMax - 1)}\u{1f600}Acme`, keywords: ['zzz', 'Acme'] },
        { name: 'cut: astral characters count two units each (the haystack is exactly 8192 units)', haystack: `${'z'.repeat(unitsMax - 4 - 200)}${'\u{1f600}'.repeat(100)}Acme`, keywords: ['Acme'] },
        { name: 'cut: astral characters count two units each (8193 units and no whitespace)', haystack: `${'z'.repeat(unitsMax - 4 - 200 + 1)}${'\u{1f600}'.repeat(100)}Acme`, keywords: ['Acme'] },
        { name: 'cut: astral characters before the cut count two units each', haystack: `${'z\u{1f600}'.repeat(2730)} Acme${'z'.repeat(25)}`, keywords: ['Acme', 'z\u{1f600}z'] },
        { name: 'cut: a combining accent just beyond the window no longer creates a hit for the unaccented word', haystack: `${'z'.repeat(unitsMax - 5)} cafe\u0301 Paris`, keywords: ['cafe'] },
        { name: 'cut: the accented word inside the window is the accented word', haystack: `${'z'.repeat(unitsMax - 20)} cafe\u0301 Paris${'z'.repeat(30)}`, keywords: ['cafe', 'caf\u00e9'] },
        ...[
            ['tab', '\t'],
            ['line feed', '\n'],
            ['carriage return', '\r'],
            ['NEL', '\u0085'],
            ['no-break space', '\u00a0'],
            ['Ogham space mark', '\u1680'],
            ['em space', '\u2003'],
            ['line separator', '\u2028'],
            ['paragraph separator', '\u2029'],
            ['narrow no-break space', '\u202f'],
            ['medium mathematical space', '\u205f'],
            ['ideographic space', '\u3000'],
            ['zero-width space', '\u200b'],
            ['BOM', '\ufeff'],
            ['Mongolian vowel separator', '\u180e'],
            ['word joiner', '\u2060'],
            ['soft hyphen', '\u00ad'],
        ].map(([label, ch]) => ({ name: `cut: ${label} as the only whitespace in a long haystack`, haystack: `Acme${ch}${'z'.repeat(unitsMax - 2)}`, keywords: ['Acme'] })),
        // MAX_COMBINING_RUN: a haystack run of 17 or more consecutive combining marks is cut to its first 16 marks (a KEYWORD with such a run is rejected)
        { name: 'marks: 16 marks in a haystack are fine and the keyword before them is found', haystack: `Acme Corp b${'\u0301'.repeat(16)}`, keywords: ['Acme'] },
        { name: 'marks: 17 marks in the haystack are cut to 16, so the keyword before them is still found', haystack: `Acme Corp b${'\u0301'.repeat(17)}`, keywords: ['Acme'] },
        { name: 'marks: 17 marks kept apart by zero-width spaces are a run once cleaning removes them; it is cut, the keyword is found', haystack: `Acme Corp b${'\u0301\u200b'.repeat(17)}`, keywords: ['Acme'] },
        { name: 'marks: 16 marks kept apart by zero-width spaces are not', haystack: `Acme Corp b${'\u0301\u200b'.repeat(16)}`, keywords: ['Acme'] },
        { name: 'marks: a run beyond the cut is never seen, so the keyword before the cut is found', haystack: `${'z'.repeat(unitsMax - 12)} Acme b${'\u0301'.repeat(17)}`, keywords: ['Acme'] },
        { name: 'marks: a run inside the searched text is cut to 16 marks; the words around it are still searched', haystack: `${'z'.repeat(unitsMax - 40)} b${'\u0301'.repeat(17)} Corp Acme${'z'.repeat(40)}`, keywords: ['zzzz'] },
        { name: 'marks: the descending-class attack shape in a haystack is cut to its first 16 marks at once, the keyword before it is found', haystack: `Acme ${'\u0345'.repeat(1365)}${'\u0300'.repeat(1365)}${'\u0316'.repeat(1364)}`, keywords: ['Acme'] },
        { name: 'marks: marks between letters never form a run', haystack: `Acme ${'a\u0301'.repeat(50)}`, keywords: ['Acme'] },
        // the keyword list is read up to 5000 entries, and accepted up to 500
        { name: 'candidates: a keyword at entry 5000 is read', haystack: 'Beta Corp', keywords: [...Array.from({ length: MAX_CANDIDATES - 1 }, () => 'a'), 'Beta Corp'] },
        { name: 'candidates: a keyword at entry 5001 is never read', haystack: 'Beta Corp', keywords: [...Array.from({ length: MAX_CANDIDATES }, () => 'a'), 'Beta Corp'] },
        { name: 'size: the 500th keyword matches', haystack: 'Zeta Corp', keywords: [...Array.from({ length: MAX_KEYWORDS - 1 }, (_unused, index) => `kw${String(index).padStart(4, '0')}`), 'Zeta Corp'] },
        { name: 'size: the 501st keyword never matches', haystack: 'Zeta Corp', keywords: [...Array.from({ length: MAX_KEYWORDS }, (_unused, index) => `kw${String(index).padStart(4, '0')}`), 'Zeta Corp'] },
        { name: 'raw cap: a keyword over 4096 units never matches, even when its cleaned form would', haystack: 'Acme Corp', keywords: [`${'\u200b'.repeat(MAX_RAW_KEYWORD_UNITS)}acme`] },
        // one hostile field must not hide a watchlisted name in another: a run of marks is cut, not fatal
        { name: 'marks: 17 Thai marks after a word do not hide the name before them', haystack: `Pfizer Inc x${'\u0e31'.repeat(17)}`, keywords: ['Pfizer'] },
        { name: 'marks: a run at the start does not hide the name after it', haystack: `${'\u0e31'.repeat(17)} | Pfizer Inc`, keywords: ['Pfizer'] },
        { name: 'marks: 9 marks, a zero-width space and 9 more marks make one run of 18 that is cut', haystack: `Pfizer Inc x${'\u0e31'.repeat(9)}\u200b${'\u0e31'.repeat(9)}`, keywords: ['Pfizer'] },
        { name: 'marks: marks glued to the last letter compose with it, so the unaccented keyword is not in the text', haystack: `acme${'\u200b'.repeat(3)}${'\u0301'.repeat(9)}\u200b${'\u0301'.repeat(9)}`, keywords: ['acme'] },
        { name: 'marks: marks after a space are cut and the keyword before the space is found', haystack: `acme ${'\u200b'.repeat(3)}${'\u0301'.repeat(9)}\u200b${'\u0301'.repeat(9)}`, keywords: ['acme'] },
        { name: 'marks: cutting a run cannot invent a hit: the accent stays on the letter', haystack: `cafe${'\u0301'.repeat(30)}`, keywords: ['cafe'] },
        { name: 'marks: runs separated by a letter are separate runs', haystack: `acme ${`x${'\u0301'.repeat(16)}`.repeat(50)}`, keywords: ['acme'] },
        // the one-letter needle in disguise never matches, whatever the text
        { name: 'alnum: single-alphanumeric keywords are rejected, so they never match', haystack: 'Pfizer Inc. | Acme Ltd. | S.A. 2024-01-02', keywords: ['c.', 'd.', 'a |', '-0', '(a)', '1)'] },
        { name: 'alnum: a pasted list with legal-form fragments matches only the names', haystack: 'Banco Santander S.A.', keywords: ['Smith', 'J.', 'A.'] },
        { name: 'glyph: one expanding character is not a keyword, so it never matches its expansion', haystack: 'Annual report 2020', keywords: ['\u2473', '\u2116'] },
        { name: 'glyph: two expanding characters are a keyword that matches their expansion', haystack: 'Annual report 2020', keywords: ['\u2473\u2473'] },
        // the NFKC expansion cap applies to a haystack too
        { name: 'expansion: a field of U+FDFA ligatures is cut out, the keyword after it is found', haystack: `${'\ufdfa'.repeat(8000)} acme`, keywords: ['acme'] },
        { name: 'expansion: a short haystack with a ligature inside the 4x allowance is searched', haystack: `${'\ufdfa'.repeat(3)} acme corp`, keywords: ['acme'] },
        { name: 'expansion: a field past the allowance is cut out, the keyword next to it is found', haystack: `${'\ufdfa'.repeat(8)} acme corp`, keywords: ['acme'] },
        { name: 'expansion: a window of ligatures with the name beyond the 8192-unit cut is not searched', haystack: `${'\ufdfa'.repeat(8188)} acme`, keywords: ['acme'] },
        { name: 'expansion: a name between two fields of ligatures', haystack: `${'\ufdfa'.repeat(100)} | Acme Holdings | ${'\ufdfa'.repeat(100)}`, keywords: ['Acme Holdings'] },
        { name: 'expansion: nothing matches across a cut-out ligature (spaced keyword)', haystack: 'Acme\ufdfaHoldings', keywords: ['Acme Holdings'] },
        { name: 'expansion: nothing matches across a cut-out ligature (fused keyword)', haystack: `Acme${'\ufdfa'.repeat(50)}Holdings`, keywords: ['AcmeHoldings'] },
        { name: 'expansion: the other characters that expand more than 4x (U+FDFB, square units) are cut out as well', haystack: `Acme Holdings Ltd ${'\ufdfb'.repeat(30)}${'\u3316'.repeat(30)}${'\u33af'.repeat(30)}`, keywords: ['Acme Holdings'] },
    ];
};

function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function buildGuardParityData(): Record<string, unknown> {
    const rng = createRng(PARITY_SEED);

    // Every input is read back from its own JSON text before the guard runs on it, so the expected value is for exactly what the committed file holds
    // (undefined, NaN, an array hole or a -0 would otherwise differ between the value built here and the value the other languages read).
    const sanitizeInputs: NamedCase[] = NAMED_SANITIZE_CASES();
    for (let index = 0; index < 320; index += 1) sanitizeInputs.push({ name: `seeded ${String(index).padStart(3, '0')}`, input: randomWatchlistInput(rng) });
    const sanitize = sanitizeInputs.map(({ name, input: built }) => {
        const input = roundTrip(built);
        const list = sanitizeKeywordList(input);
        return {
            name,
            input,
            expected: { keywords: list.keywords, needles: list.needles, rejected: list.rejected.map((r) => ({ value: r.value, reason: r.reason })), malformedContainer: list.malformedContainer },
            description: describeSanitization(list),
        };
    });

    const normalise = [
        ...NAMED_NORMALISE_CASES(),
        ...Array.from({ length: 240 }, (_unused, index) => ({ name: `seeded ${String(index).padStart(3, '0')}`, input: randomText(rng, 10) })),
    ].map(({ name, input }) => ({ name, input, expected: normaliseKeyword(input as string) }));

    const matchInputs: MatchCase[] = NAMED_MATCH_CASES();
    for (let index = 0; index < 160; index += 1) {
        const keywords = Array.from({ length: Math.floor(rng() * 4) + 1 }, () => randomText(rng, 3));
        const pieces = [randomText(rng, 4), keywords[Math.floor(rng() * keywords.length)] ?? '', randomText(rng, 4)];
        let haystack = rng() < 0.85 ? pieces.map((piece) => (rng() < 0.3 ? piece.toUpperCase() : piece)).join(rng() < 0.5 ? ' ' : '') : randomText(rng, 6);
        if (rng() < 0.08) {
            // A haystack around the 8192 unit window, made of words and whitespace, with the keyword near the cut.
            let filler = '';
            const target = MAX_HAYSTACK_UNITS - 40 + Math.floor(rng() * 80);
            while (filler.length < target) filler += `${WORDS[Math.floor(rng() * WORDS.length)] ?? 'x'}${rng() < 0.12 ? (WHITESPACE[Math.floor(rng() * WHITESPACE.length)] ?? ' ') : rng() < 0.9 ? ' ' : ''}`;
            haystack = rng() < 0.5 ? `${filler}${haystack}` : `${haystack}${filler}${haystack}`;
        }
        matchInputs.push({ name: `seeded ${String(index).padStart(3, '0')}`, haystack, keywords });
    }
    const match = matchInputs.map(({ name, haystack: builtHaystack, keywords: builtKeywords }) => {
        const haystack = roundTrip(builtHaystack);
        const keywords = roundTrip(builtKeywords);
        return { name, haystack, keywords, expected: findKeywordMatch(haystack, sanitizeKeywordList(keywords)) };
    });

    return {
        schemaVersion: 1,
        generatedBy: 'scripts/generate_distribution_data.ts',
        seed: PARITY_SEED,
        sanitize,
        normalise,
        match,
    };
}

/** Writes every non-ASCII character as a four-digit Unicode escape (an astral character as two surrogate escapes), leaving ASCII untouched. */
function escapeNonAscii(text: string): string {
    // No `u` flag on purpose: the pattern then walks UTF-16 code units, so an astral character becomes two escapes.
    return text.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Two-space JSON, pure ASCII. The corpus is full of invisible, bidi and lone-surrogate characters that would be
 * unreviewable (and easy to damage in an editor) if written raw; escaping them keeps the committed file byte-stable.
 */
export function renderJson(value: unknown): string {
    return `${escapeNonAscii(JSON.stringify(value, null, 2))}\n`;
}

/** Like {@link renderJson}, but every element of a top-level array sits on one line, so one corpus case is one diff line. */
export function renderCaseJson(data: Record<string, unknown>): string {
    const keys = Object.keys(data);
    const lines: string[] = ['{'];
    keys.forEach((key, index) => {
        const value = data[key];
        const comma = index < keys.length - 1 ? ',' : '';
        if (Array.isArray(value)) {
            lines.push(`  ${JSON.stringify(key)}: [`);
            value.forEach((item, position) => lines.push(`    ${JSON.stringify(item)}${position < value.length - 1 ? ',' : ''}`));
            lines.push(`  ]${comma}`);
        } else {
            lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
        }
    });
    lines.push('}');
    return `${escapeNonAscii(lines.join('\n'))}\n`;
}

export interface GeneratedFile {
    path: string;
    content: string;
}

export function buildDistributionFiles(): GeneratedFile[] {
    return [
        { path: ENGINES_JSON_PATH, content: renderJson(buildEnginesData()) },
        { path: GUARD_PARITY_JSON_PATH, content: renderCaseJson(buildGuardParityData()) },
    ];
}

async function main(): Promise<void> {
    const check = process.argv.includes('--check');
    let drifted = 0;
    for (const file of buildDistributionFiles()) {
        const absolute = join(ROOT, file.path);
        if (check) {
            const current = await readFile(absolute, 'utf8').catch(() => undefined);
            if (current !== file.content) {
                drifted += 1;
                console.error(`${file.path}: differs from the generator output (run: npx tsx scripts/generate_distribution_data.ts)`);
            } else {
                console.log(`${file.path}: up to date`);
            }
            continue;
        }
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.content);
        console.log(`${file.path}: wrote ${file.content.length} characters`);
    }
    if (drifted > 0) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
