/**
 * Keeps the programmatic-distribution layer (distribution/) tied to the TypeScript code it is derived from.
 *
 *   - the committed engines.json and guard_parity.json equal what scripts/generate_distribution_data.ts writes NOW, so the
 *     Python package cannot drift from the registries, the pricing catalog or the guard;
 *   - the code point ranges in engines.json are exactly what the real guard removes: the guard is run on every one of the 1,112,064
 *     non-surrogate code points, and the generator's copy of the removal pattern and the n8n Code node's copy are compared with the guard's own;
 *   - the parity corpus is what the TypeScript guard returns, names a case for every defect class the guard was rewritten for, and every accepted
 *     keyword list in it is a fixed point of the guard (which is why neither the Python client nor the n8n template cleans a list a second time);
 *   - every n8n template is structurally valid. The templates are validated STATICALLY only: nothing here imports them
 *     into n8n or runs them against the Apify platform. What is checked is what a file can prove about itself (valid JSON,
 *     unique names, a connected graph, one trigger, a bounded loop, a positive spending cap, no token), plus the template's
 *     Code node is executed against the same guard corpus the Python port is held to.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

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
import { ALL_PRICING } from '../pricing/event_catalog.js';
import {
    buildDistributionFiles,
    buildEnginesData,
    buildGuardParityData,
    computeRemovedRanges,
    computeWhiteSpaceRanges,
    ENGINES_JSON_PATH,
    GUARD_PARITY_JSON_PATH,
    renderCaseJson,
    renderJson,
} from '../scripts/generate_distribution_data.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (relative: string): string => readFileSync(`${ROOT}${relative}`, 'utf8');
const ENGINES = [regtechEngine, tendersEngine, patentsEngine];

interface EnginesFile {
    schemaVersion: number;
    limits: {
        deltaModes: string[];
        defaultDeltaMode: string;
        maxItemsPerSource: { min: number; max: number; default: number };
        stateNamespacePattern: string;
        watchlist: {
            minKeywordLength: number;
            maxKeywordLength: number;
            maxKeywords: number;
            maxRawKeywordUnits: number;
            maxCandidates: number;
            maxBareStringUnits: number;
            maxHaystackUnits: number;
            maxNormalisePasses: number;
            maxCombiningRun: number;
            maxTotalRawUnits: number;
            removedRanges: Array<[number, number]>;
            whiteSpaceRanges: Array<[number, number]>;
        };
        defaultMaxWatchlistHitsPerRun: number;
        defaultMaxWatchlistSpendUsd: number;
    };
    engines: Record<
        string,
        {
            slug: string;
            memoryMbytes: number;
            startPriceUsd: number;
            credentialFields: Record<string, { source: string; option: string }>;
            sources: Array<{ id: string; status: string; heldReason: string | null; requiredOptions: string[]; billing: Record<string, string> | null }>;
            events: Array<{ name: string; priceUsd: number }>;
            recordLevelEvents: string[];
            watchlistHit: { event: string; priceUsd: number };
        }
    >;
}

interface ParityCase {
    name: string;
    input: unknown;
    expected: { keywords: string[]; needles: string[]; rejected: Array<{ value: string; reason: string }>; malformedContainer: boolean };
    description: string;
}

describe('distribution data files', () => {
    it('engines.json is exactly what the generator writes now', () => {
        expect(read(ENGINES_JSON_PATH)).toBe(renderJson(buildEnginesData()));
    });

    it('guard_parity.json is exactly what the generator writes now', () => {
        expect(read(GUARD_PARITY_JSON_PATH)).toBe(renderCaseJson(buildGuardParityData()));
    });

    it('the generator is deterministic', () => {
        expect(buildDistributionFiles()).toEqual(buildDistributionFiles());
    });

    it('both committed files are pure ASCII and parse as JSON', () => {
        for (const path of [ENGINES_JSON_PATH, GUARD_PARITY_JSON_PATH]) {
            const text = read(path);
            expect(/[^\u0000-\u007f]/u.test(text), path).toBe(false);
            expect(() => JSON.parse(text), path).not.toThrow();
        }
    });

    it('importing the generator does not write anything (only running it as the entry point does)', async () => {
        const before = [ENGINES_JSON_PATH, GUARD_PARITY_JSON_PATH].map((path) => statSync(`${ROOT}${path}`).mtimeMs);
        const specifier = '../scripts/generate_distribution_data.js?fresh-import'; // a variable keeps tsc from resolving the query string
        await import(specifier);
        const after = [ENGINES_JSON_PATH, GUARD_PARITY_JSON_PATH].map((path) => statSync(`${ROOT}${path}`).mtimeMs);
        expect(after).toEqual(before);
    });

    describe('engines.json against the registries', () => {
        const data = JSON.parse(read(ENGINES_JSON_PATH)) as EnginesFile;

        it('lists the three engines with every registered source, in registry order', () => {
            expect(Object.keys(data.engines)).toEqual(ENGINES.map((engine) => engine.slug));
            for (const engine of ENGINES) {
                const entry = data.engines[engine.slug];
                expect(entry?.sources.map((source) => [source.id, source.status])).toEqual(engine.connectors.map((connector) => [connector.id, connector.status]));
            }
        });

        it('carries every held reason verbatim and no billing for a held source', () => {
            let held = 0;
            for (const engine of ENGINES) {
                for (const connector of engine.connectors.filter((c) => c.status === 'held')) {
                    const source = data.engines[engine.slug]?.sources.find((s) => s.id === connector.id);
                    expect(source?.heldReason, connector.id).toBe(connector.heldReason);
                    expect(source?.heldReason?.length ?? 0, connector.id).toBeGreaterThan(20);
                    expect(source?.billing, connector.id).toBeNull();
                    held += 1;
                }
            }
            expect(held).toBe(10);
        });

        it('has 19 active sources whose billing events exist in the engine catalog', () => {
            let active = 0;
            for (const pricing of ALL_PRICING) {
                const entry = data.engines[pricing.engine];
                const names = new Set(pricing.events.map((event) => event.name));
                for (const source of entry?.sources.filter((s) => s.status === 'active') ?? []) {
                    active += 1;
                    expect(Object.keys(source.billing ?? {}), source.id).toEqual(['first_seen', 'updated', 'unchanged']);
                    for (const event of Object.values(source.billing ?? {})) expect(names.has(event), `${source.id}: ${event}`).toBe(true);
                }
                for (const event of entry?.recordLevelEvents ?? []) expect(names.has(event)).toBe(true);
            }
            expect(active).toBe(19);
        });

        it('copies prices, memory and the start price from the pricing catalog', () => {
            for (const pricing of ALL_PRICING) {
                const entry = data.engines[pricing.engine];
                expect(entry?.memoryMbytes).toBe(pricing.memoryMbytes);
                expect(entry?.startPriceUsd).toBe(pricing.startPriceUsd);
                expect(entry?.events.map((event) => [event.name, event.priceUsd])).toEqual(pricing.events.map((event) => [event.name, event.priceUsd]));
                expect(entry?.watchlistHit).toEqual({ event: 'watchlist-hit', priceUsd: 0.15 });
            }
        });

        it('copies the credential fields and the mandatory options from the registries', () => {
            for (const engine of ENGINES) {
                const entry = data.engines[engine.slug];
                expect(entry?.credentialFields).toEqual(engine.credentialFields);
                for (const connector of engine.connectors) {
                    expect(entry?.sources.find((s) => s.id === connector.id)?.requiredOptions, connector.id).toEqual([...(connector.requiredOptions ?? [])]);
                }
            }
        });

        it('agrees with the committed .actor/input_schema.json of every engine', () => {
            for (const engine of ENGINES) {
                const schema = JSON.parse(read(`${engine.slug}/.actor/input_schema.json`)) as { properties: Record<string, any> };
                const entry = data.engines[engine.slug];
                expect(schema.properties.sources.items.enum).toEqual(entry?.sources.filter((s) => s.status === 'active').map((s) => s.id));
                expect(schema.properties.deltaMode.enum).toEqual(data.limits.deltaModes);
                expect(schema.properties.deltaMode.default).toBe(data.limits.defaultDeltaMode);
                expect(schema.properties.maxItemsPerSource).toMatchObject({ minimum: data.limits.maxItemsPerSource.min, maximum: data.limits.maxItemsPerSource.max, default: data.limits.maxItemsPerSource.default });
                expect(schema.properties.maxWatchlistHitsPerRun.default).toBe(data.limits.defaultMaxWatchlistHitsPerRun);
                expect(schema.properties.maxWatchlistSpendUsd.default).toBe(data.limits.defaultMaxWatchlistSpendUsd);
                for (const field of Object.keys(entry?.credentialFields ?? {})) expect(schema.properties[field], field).toMatchObject({ isSecret: true });
            }
        });

        it('records the guard limits, the removed code point and White_Space ranges and the namespace rule the Python package validates against', () => {
            expect(data.schemaVersion).toBe(1);
            expect(data.limits.watchlist).toEqual({
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
            });
            expect(data.limits.stateNamespacePattern).toBe('^[a-z0-9-]{1,40}$');
        });

        it('removedRanges is sorted, disjoint, free of surrogates, and exactly what the real guard removes, for every code point', () => {
            const { removedRanges } = data.limits.watchlist;
            let previousLast = -2;
            for (const [first, last] of removedRanges) {
                expect(first, `[${first}, ${last}] must not touch the range before it`).toBeGreaterThan(previousLast + 1);
                expect(last).toBeGreaterThanOrEqual(first);
                expect(last).toBeLessThanOrEqual(0x10ffff);
                expect(first <= 0xdfff && last >= 0xd800, `[${first}, ${last}] must not contain surrogates`).toBe(false);
                previousLast = last;
            }
            const inRanges = new Uint8Array(0x110000);
            for (const [first, last] of removedRanges) inRanges.fill(1, first, last + 1);
            // Tab, line feed, vertical tab, form feed, carriage return and NEL are in the ranges (C0/C1 controls) but become a space BEFORE the removal runs;
            // line and paragraph separator are not in the ranges and become a space too. Every other code point in the ranges vanishes; no other one does.
            const spaced = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
            const wrong: string[] = [];
            for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
                if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
                const cleaned = normaliseKeyword(`a${String.fromCodePoint(codePoint)}b`);
                const expected = spaced.has(codePoint) ? 'a b' : inRanges[codePoint] === 1 ? 'ab' : undefined;
                const right = expected === undefined ? cleaned !== 'ab' : cleaned === expected;
                if (!right) wrong.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
            }
            expect(wrong).toEqual([]);
        });

        it('whiteSpaceRanges is exactly the Unicode White_Space set: each character cuts a long haystack, the 63 thousand others in the BMP do not, and the pattern is the guard\'s own', () => {
            const { whiteSpaceRanges } = ENGINES_DATA.limits.watchlist;
            expect(whiteSpaceRanges).toEqual(computeWhiteSpaceRanges());
            const members = whiteSpaceRanges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_unused, offset) => first + offset));
            expect(members).toHaveLength(25);
            const inTable = new Set(members);
            const list = sanitizeKeywordList(['yy']);
            // A member is the first unit past a 2 unit prefix of a haystack longer than the window: the prefix is searched, so the keyword in it is found.
            for (const member of members) {
                expect(findKeywordMatch(`yy${String.fromCharCode(member)}${'z'.repeat(MAX_HAYSTACK_UNITS)}`, list), `U+${member.toString(16)}`).toBe('yy');
            }
            // Every other BMP code point, shuffled (so that no run of marks sits in one block), in blocks that fill the window behind a one-whitespace prefix:
            // if one of them were whitespace the searched text would reach the keyword placed after the sentinel.
            const others: number[] = [];
            for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) if (!(codePoint >= 0xd800 && codePoint <= 0xdfff) && !inTable.has(codePoint)) others.push(codePoint);
            let state = 20261021;
            for (let index = others.length - 1; index > 0; index -= 1) {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                const swap = state % (index + 1);
                [others[index], others[swap]] = [others[swap] as number, others[index] as number];
            }
            const block = MAX_HAYSTACK_UNITS - 6;
            let blocks = 0;
            for (let start = 0; start < others.length; start += block) {
                const chunk = others.slice(start, start + block);
                const text = `${String.fromCharCode(...chunk)}${'q'.repeat(block - chunk.length)}`;
                expect(/\p{M}{17}/u.test(text), 'a run of marks would hide a hit').toBe(false);
                const haystack = `xx yy${text}${'z'.repeat(8)}`;
                expect(haystack.length).toBeGreaterThan(MAX_HAYSTACK_UNITS);
                expect(findKeywordMatch(haystack, list), `block ${blocks}`).toBeNull();
                blocks += 1;
            }
            expect(blocks).toBe(Math.ceil(others.length / block));
            // The generator's pattern is the guard's own.
            const literal = (text: string, name: string): string => (new RegExp(`const ${name} = (/.+/[a-z]*);`, 'u').exec(text) as RegExpExecArray)[1] as string;
            expect(literal(read('scripts/generate_distribution_data.ts'), 'WHITE_SPACE_OF_THE_GUARD')).toBe(literal(read('lib/_guards.ts'), 'WHITE_SPACE_UNIT'));
        });

        it('has the same guard constants in the Python port source', () => {
            const python = read('distribution/python/src/regulatory_engines/_guards.py');
            const constants = { MIN_KEYWORD_LENGTH, MAX_KEYWORD_LENGTH, MAX_KEYWORDS, MAX_RAW_KEYWORD_UNITS, MAX_CANDIDATES, MAX_BARE_STRING_UNITS, MAX_HAYSTACK_UNITS, MAX_NORMALISE_PASSES, MAX_COMBINING_RUN, MAX_TOTAL_RAW_UNITS };
            for (const [name, value] of Object.entries(constants)) expect(python, name).toContain(`${name} = ${value}\n`);
        });
    });

    describe('guard_parity.json against the TypeScript guard', () => {
        const corpus = JSON.parse(read(GUARD_PARITY_JSON_PATH)) as {
            seed: number;
            sanitize: ParityCase[];
            normalise: Array<{ name: string; input: string; expected: string }>;
            match: Array<{ name: string; haystack: unknown; keywords: unknown; expected: string | null }>;
        };
        const sanitizeCase = (name: string): ParityCase => {
            const found = corpus.sanitize.find((entry) => entry.name === name);
            expect(found, name).toBeDefined();
            return found as ParityCase;
        };
        const matchCase = (name: string): (typeof corpus.match)[number] => {
            const found = corpus.match.find((entry) => entry.name === name);
            expect(found, name).toBeDefined();
            return found as (typeof corpus.match)[number];
        };
        const reasonCounts = (entry: ParityCase): Record<string, number> => {
            const counts: Record<string, number> = {};
            for (const item of entry.expected.rejected) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
            return counts;
        };

        it('holds at least 400 sanitiser inputs, named hostile cases plus a seeded corpus', () => {
            expect(corpus.sanitize.length).toBeGreaterThanOrEqual(400);
            expect(corpus.sanitize.filter((c) => c.name.startsWith('seeded')).length).toBeGreaterThanOrEqual(300);
            expect(corpus.sanitize.filter((c) => !c.name.startsWith('seeded')).length).toBeGreaterThanOrEqual(100);
            expect(corpus.normalise.length).toBeGreaterThanOrEqual(300);
            expect(corpus.match.length).toBeGreaterThanOrEqual(200);
            expect(corpus.seed).toBe(20261021);
        });

        it('every expected value is what the TypeScript guard returns for the input', () => {
            for (const entry of corpus.sanitize) {
                const list = sanitizeKeywordList(entry.input);
                expect(
                    { keywords: list.keywords, needles: list.needles, rejected: list.rejected, malformedContainer: list.malformedContainer },
                    entry.name,
                ).toEqual(entry.expected);
                expect(describeSanitization(list), entry.name).toBe(entry.description);
            }
            for (const entry of corpus.normalise) expect(normaliseKeyword(entry.input), entry.name).toBe(entry.expected);
            for (const entry of corpus.match) expect(findKeywordMatch(entry.haystack, sanitizeKeywordList(entry.keywords)), entry.name).toBe(entry.expected);
        });

        it('names the five ghost-billing inputs', () => {
            const inputs = corpus.sanitize.filter((c) => c.name.startsWith('ghost:')).map((c) => JSON.stringify(c.input));
            for (const expected of ['[""]', '[" "]', '""', '"a"', '["a"]']) expect(inputs).toContain(expected);
        });

        it('exercises every rejection reason of the guard, both container outcomes, and accepted and rejected matches', () => {
            const reasons = new Set(corpus.sanitize.flatMap((c) => c.expected.rejected.map((r) => r.reason)));
            expect([...reasons].sort()).toEqual(['duplicate', 'empty_after_normalisation', 'invalid_unicode', 'no_letter_or_digit', 'not_a_string', 'over_limit', 'too_long', 'too_short']);
            expect(new Set(corpus.sanitize.map((c) => c.expected.malformedContainer))).toEqual(new Set([true, false]));
            expect(corpus.match.filter((c) => c.expected !== null).length).toBeGreaterThanOrEqual(80);
            expect(corpus.match.filter((c) => c.expected === null).length).toBeGreaterThanOrEqual(80);
        });

        it('names a case for every one of the five defect classes the guard was rewritten for', () => {
            const count = (prefix: string): number => corpus.sanitize.filter((c) => c.name.startsWith(prefix)).length;
            expect(count('unicode:'), 'lone surrogates').toBeGreaterThanOrEqual(15);
            expect(count('raw cap:'), 'the 4096 unit cap').toBeGreaterThanOrEqual(7);
            expect(count('invisible:'), 'default-ignorable and bidi characters').toBeGreaterThanOrEqual(15);
            expect(count('fixpoint:'), 'cleaning to a fixed point').toBeGreaterThanOrEqual(9);
            expect(count('candidates:') + count('string:'), 'the candidate and bare-string caps').toBeGreaterThanOrEqual(8);
            expect(count('marks:'), 'the 16 mark run').toBeGreaterThanOrEqual(12);
            expect(count('total:'), 'the 200000 unit budget').toBeGreaterThanOrEqual(3);
            expect(count('preview:'), 'the 57 unit previews').toBeGreaterThanOrEqual(3);
            for (const name of [
                'invisible: Hangul fillers only',
                'invisible: Arabic letter mark',
                'invisible: tag characters',
                'invisible: variation selectors',
                'invisible: Mongolian free variation selectors and vowel separator',
                'invisible: combining grapheme joiner',
                'invisible: Khmer inherent vowels',
                'fixpoint: e, zero-width space, combining acute settles to one character and is too_short',
            ]) {
                sanitizeCase(name);
            }
            expect(corpus.normalise.filter((c) => c.name.includes('between two letters')).length, 'every range boundary').toBeGreaterThanOrEqual(40);
        });

        it('pins what its boundary cases test: the 4096 unit cap, the 5000 candidate cap, the 200000 unit budget and cut, the 16 mark run, the 8192 unit window', () => {
            const zw = '\u200b';
            const marker = (text: string) => ({ value: text, reason: 'over_limit' });
            const rawCap = sanitizeCase('raw cap: 4096 units around a keyword are cleaned, 4097 are too_long');
            expect((rawCap.input as string[]).map((text) => text.length)).toEqual([MAX_RAW_KEYWORD_UNITS, MAX_RAW_KEYWORD_UNITS + 1]);
            expect(rawCap.expected.keywords).toEqual(['ab']);
            expect(rawCap.expected.rejected.map((r) => r.reason)).toEqual(['too_long']);
            expect(rawCap.input).toEqual([`${zw.repeat(MAX_RAW_KEYWORD_UNITS - 2)}ab`, `${zw.repeat(MAX_RAW_KEYWORD_UNITS - 1)}cd`]);

            const tags = sanitizeCase('raw cap: tag characters count two units each (4096 accepted, 4097 too_long)');
            expect((tags.input as string[]).map((text) => text.length)).toEqual([MAX_RAW_KEYWORD_UNITS, MAX_RAW_KEYWORD_UNITS + 1]);
            expect(tags.expected.keywords).toEqual(['ab']);
            expect(tags.expected.rejected.map((r) => r.reason)).toEqual(['too_long']);

            const surrogate = sanitizeCase('unicode: lone surrogate at the raw cap is invalid_unicode, one unit over it is too_long');
            expect(surrogate.expected.rejected.map((r) => r.reason)).toEqual(['invalid_unicode', 'too_long']);

            const exactly = sanitizeCase('candidates: exactly 5000 entries are all inspected (no marker)');
            expect((exactly.input as unknown[]).length).toBe(MAX_CANDIDATES);
            expect(exactly.expected.keywords).toEqual(['Acme Corp']);
            expect(reasonCounts(exactly)).toEqual({ too_short: MAX_CANDIDATES - 1 });

            const beyond = sanitizeCase('candidates: the 5000th entry is inspected, the 5001st and later are one over_limit marker');
            expect((beyond.input as unknown[]).length).toBe(MAX_CANDIDATES + 2);
            expect(beyond.expected.keywords).toEqual(['Acme Corp']);
            expect(beyond.expected.rejected.at(-1)).toEqual(marker('(2 further entries not inspected)'));
            expect(reasonCounts(beyond)).toEqual({ too_short: MAX_CANDIDATES - 2, not_a_string: 1, over_limit: 1 });

            // MAX_TOTAL_RAW_UNITS: strings of 4096 units or fewer add up to at most 200000; longer ones cost nothing
            const exact = sanitizeCase('total: strings adding up to exactly 200000 units are all inspected, a one-unit entry after them is not (one marker)');
            const exactInput = exact.input as string[];
            expect(exactInput.slice(0, -1).reduce((sum, text) => sum + text.length, 0)).toBe(MAX_TOTAL_RAW_UNITS);
            expect(exactInput.at(-1)).toBe('Z');
            expect(exact.expected.keywords).toEqual(['Acme']);
            expect(reasonCounts(exact)).toEqual({ too_long: 49, over_limit: 1 });
            expect(exact.expected.rejected.at(-1)).toEqual(marker('(1 further entries not inspected)'));
            const crossing = sanitizeCase('total: 49 entries of 4092 units, the 49th crosses the budget');
            expect((crossing.input as string[]).map((text) => text.length)).toEqual(Array.from({ length: 49 }, () => MAX_RAW_KEYWORD_UNITS - 4));
            expect(reasonCounts(crossing)).toEqual({ too_long: 48, over_limit: 1 });
            expect(crossing.expected.rejected.at(-1)).toEqual(marker('(1 further entries not inspected)'));
            const mixed = sanitizeCase('total: entries that are not strings add nothing, nothing after the crossing entry is inspected (not even a later non-string)');
            const mixedInput = mixed.input as unknown[];
            expect(mixedInput.length).toBe(4 + 48 + 1 + 1 + 1 + 3 + 0);
            const counted = mixedInput.slice(0, -3).filter((entry): entry is string => typeof entry === 'string' && entry.length <= MAX_RAW_KEYWORD_UNITS);
            expect(counted.reduce((sum, text) => sum + text.length, 0), 'the entries inspected add up to exactly the budget; the 5000 unit string is not among them').toBe(MAX_TOTAL_RAW_UNITS);
            expect(reasonCounts(mixed)).toEqual({ not_a_string: 5, too_long: 50, over_limit: 1 });
            expect(mixed.expected.rejected.at(-1)).toEqual(marker('(3 further entries not inspected)'));

            // the bare string: exactly 200000 units is read whole; longer is cut, the last piece dropped, and a marker follows
            const cutMarker = `(bare string cut at ${MAX_BARE_STRING_UNITS} units; its last entry was dropped)`;
            const whole = sanitizeCase('string: a bare string of exactly 200000 units is read whole, even when it ends in an astral character');
            expect((whole.input as string).length).toBe(MAX_BARE_STRING_UNITS);
            expect(whole.expected.keywords).toEqual(['Alpha Corp', 'Beta\u{1f600}']);
            expect(reasonCounts(whole), 'nothing is dropped and there is no marker').toEqual({ too_long: 1 });
            const straddle = sanitizeCase('string: 200012 units, the window ends in the high half of an astral character: the half and the last piece are dropped');
            expect((straddle.input as string).length).toBe(MAX_BARE_STRING_UNITS + 12);
            const straddleUnit = (straddle.input as string).charCodeAt(MAX_BARE_STRING_UNITS - 1);
            expect(straddleUnit >= 0xd800 && straddleUnit <= 0xdbff, 'a high surrogate sits on the last unit that would be kept').toBe(true);
            expect(straddle.expected.keywords).toEqual(['Alpha Corp']);
            expect(straddle.expected.rejected.map((r) => r.reason)).toEqual(['too_long', 'over_limit']);
            expect(straddle.expected.rejected.at(-1)).toEqual(marker(cutMarker));
            const pfizer = sanitizeCase('string: 200001 units, the cut falls inside the last piece, which is dropped');
            expect((pfizer.input as string).length).toBe(MAX_BARE_STRING_UNITS + 1);
            expect((pfizer.input as string).endsWith('Pfizer Inc')).toBe(true);
            expect(pfizer.expected.keywords, 'the truncated "Pfizer In" is not accepted').toEqual(['Alpha Corp']);
            expect(pfizer.expected.rejected.at(-1)).toEqual(marker(cutMarker));
            const bare = sanitizeCase('string: 200001 units with no separator in the window: nothing is left but the marker');
            expect((bare.input as string).length).toBe(MAX_BARE_STRING_UNITS + 1);
            expect(bare.expected.keywords).toEqual([]);
            expect(bare.expected.rejected).toEqual([marker(cutMarker)]);
            expect(bare.description).toBe('watchlistNames: 0 accepted, 1 rejected (over_limit=1).');

            // MAX_COMBINING_RUN
            const run = sanitizeCase('marks: 16 consecutive combining marks are fine, 17 make the keyword empty');
            expect(run.expected.keywords).toHaveLength(3);
            expect(run.expected.rejected.map((r) => r.reason)).toEqual(['empty_after_normalisation', 'empty_after_normalisation']);
            const apart = sanitizeCase('marks: removal exposes a run on the second pass (the base does not compose with the first mark)');
            expect(apart.expected.keywords).toHaveLength(2);
            expect(apart.expected.rejected.map((r) => r.reason)).toEqual(['empty_after_normalisation']);
            const composed = sanitizeCase('marks: removal exposes a run on the second pass (the base composes with the first mark, so 16 remain)');
            expect(composed.expected.keywords).toHaveLength(2);
            expect(composed.expected.keywords[0]?.length, 'a with its acute composed, then 16 marks').toBe(17);
            expect(composed.expected.rejected.map((r) => r.reason)).toEqual(['empty_after_normalisation']);
            const attack = sanitizeCase('marks: the descending-class attack shape (NFKC must reorder it) is empty at once');
            expect((attack.input as string[])[0]?.length).toBe(MAX_RAW_KEYWORD_UNITS);
            expect(attack.expected.rejected.map((r) => r.reason)).toEqual(['empty_after_normalisation']);
            expect(attack.expected.keywords).toHaveLength(1);

            const every = sanitizeCase('invisible: a letter plus every removed code point is a one-letter keyword');
            const removedCount = ENGINES_DATA.limits.watchlist.removedRanges.reduce((sum, [first, last]) => sum + last - first + 1, 0);
            expect((every.input as string[]).length).toBe(removedCount);
            expect(every.expected.keywords).toEqual([]);
            expect(reasonCounts(every)).toEqual({ too_short: removedCount });

            // the haystack: whole up to 8192 units, otherwise up to the last whitespace inside the window, otherwise not at all
            const found = 'Acme';
            const expectations: Array<[string, string | null]> = [
                ['cut: a haystack of exactly 8192 units is searched whole', found],
                ['cut: the keyword starts at unit 8000 and the haystack is shorter than the window', found],
                ['cut: 8193 units without whitespace are not searched at all (the keyword ends on the last unit)', null],
                ['cut: 9004 units without whitespace are not searched at all (the keyword is at the start)', null],
                ['cut: whitespace beyond the window does not help', null],
                ['cut: whitespace on unit 8192, the first unit past the window: the whole window is searched', found],
                ['cut: whitespace on unit 8191: the keyword before it is found', found],
                ['cut: the last whitespace inside the window is before the keyword: it is not found', null],
                ['cut: the searched text ends at the LAST whitespace inside the window (a word before it is found)', 'Beta'],
                ['cut: the searched text ends at the LAST whitespace inside the window (a word after it is not)', null],
                ['cut: an early keyword is found when the only whitespace in the window is early', found],
                ['cut: 8192 zero-width spaces are not whitespace and use up the whole window', null],
                ['cut: invisible characters count as units and are not cut points', null],
                ['cut: a keyword split by thousands of invisible characters inside the window is found', found],
                ['cut: an astral character straddling unit 8192 and no whitespace', null],
                ['cut: astral characters count two units each (the haystack is exactly 8192 units)', found],
                ['cut: astral characters count two units each (8193 units and no whitespace)', null],
                ['cut: astral characters before the cut count two units each', 'z\u{1f600}'],
                ['cut: a combining accent just beyond the window no longer creates a hit for the unaccented word', null],
                ['cut: the accented word inside the window is the accented word', 'caf\u00e9'],
                ['marks: 16 marks in a haystack are fine and the keyword before them is found', found],
                ['marks: 17 marks anywhere in the haystack make the whole haystack unsearchable, even the keyword before them', null],
                ['marks: 17 marks kept apart by zero-width spaces are a run once cleaning removes them', null],
                ['marks: 16 marks kept apart by zero-width spaces are not', found],
                ['marks: a run beyond the cut is never seen, so the keyword before the cut is found', found],
                ['marks: a run inside the searched text, before the last whitespace of the window, hides the haystack', null],
                ['marks: the descending-class attack shape in a haystack is unsearchable at once', null],
                ['marks: marks between letters never form a run', found],
            ];
            for (const [name, expected] of expectations) expect(matchCase(name).expected, name).toBe(expected);
            const haystackOf = (name: string): string => matchCase(name).haystack as string;
            expect(haystackOf('cut: a haystack of exactly 8192 units is searched whole').length).toBe(MAX_HAYSTACK_UNITS);
            expect(haystackOf('cut: the keyword starts at unit 8000 and the haystack is shorter than the window').indexOf('Acme')).toBe(8000);
            expect(haystackOf('cut: 8193 units without whitespace are not searched at all (the keyword ends on the last unit)')).toHaveLength(MAX_HAYSTACK_UNITS + 1);
            expect(haystackOf('cut: whitespace on unit 8192, the first unit past the window: the whole window is searched').charAt(MAX_HAYSTACK_UNITS)).toBe(' ');
            expect(haystackOf('cut: whitespace on unit 8192, the first unit past the window: the whole window is searched').indexOf('Acme') + 4).toBe(MAX_HAYSTACK_UNITS);
            const eightyOne = haystackOf('cut: whitespace on unit 8191: the keyword before it is found');
            expect(eightyOne.charAt(MAX_HAYSTACK_UNITS - 1)).toBe(' ');
            expect(eightyOne.indexOf('Acme') + 4).toBe(MAX_HAYSTACK_UNITS - 1);
            const before = haystackOf('cut: the last whitespace inside the window is before the keyword: it is not found');
            expect(before.slice(0, MAX_HAYSTACK_UNITS + 1).lastIndexOf(' ')).toBeLessThan(before.indexOf('Acme'));
            expect(before.indexOf('Acme') + 4).toBeLessThanOrEqual(MAX_HAYSTACK_UNITS);
            const accent = haystackOf('cut: a combining accent just beyond the window no longer creates a hit for the unaccented word');
            expect(accent.charAt(MAX_HAYSTACK_UNITS), 'the accent is the first unit past the window').toBe('\u0301');
            expect(accent.slice(0, MAX_HAYSTACK_UNITS).endsWith('cafe')).toBe(true);
            expect(haystackOf('marks: a run beyond the cut is never seen, so the keyword before the cut is found').length).toBeGreaterThan(MAX_HAYSTACK_UNITS);
            const kinds = corpus.match.filter((entry) => entry.name.endsWith('as the only whitespace in a long haystack'));
            expect(kinds.length).toBeGreaterThanOrEqual(15);
            for (const entry of kinds) {
                const character = (entry.haystack as string).charAt(4);
                expect(entry.expected, entry.name).toBe(/\p{White_Space}/u.test(character) ? 'Acme' : null);
            }
            expect(kinds.filter((entry) => entry.expected !== null).length).toBeGreaterThanOrEqual(10);
            expect(kinds.filter((entry) => entry.expected === null).length).toBeGreaterThanOrEqual(4);

            // the previews: a value over 60 units is cut at 57 without ending in half of a pair
            const previews = sanitizeCase('preview: an astral character straddling unit 57 is dropped whole, one ending on unit 57 is kept, short values are not cut');
            const shown = previews.expected.rejected.map((r) => r.value);
            expect(shown[0]).toBe(`${'-'.repeat(56)}...`);
            expect(shown[1]).toBe(`${'-'.repeat(55)}\u{1f600}...`);
            expect(shown[2]).toBe(`${'-'.repeat(57)}\u{1f600}`);
            expect(shown[3]).toBe(`${'-'.repeat(58)}\u{1f600}`);
            expect(shown[4]).toBe(`${'-'.repeat(57)}...`);
            expect(shown[5]).toBe(`${'-'.repeat(56)}...`);
        });

        it('every accepted keyword list is a fixed point of the guard: sanitising it again accepts all of it and rejects nothing', () => {
            for (const entry of corpus.sanitize) {
                const again = sanitizeKeywordList(entry.expected.keywords);
                expect({ keywords: again.keywords, needles: again.needles, rejected: again.rejected }, entry.name).toEqual({ keywords: entry.expected.keywords, needles: entry.expected.needles, rejected: [] });
            }
            for (const entry of corpus.normalise) expect(normaliseKeyword(entry.expected), entry.name).toBe(entry.expected);
        });

        it('cleaning is idempotent on 6000 seeded hostile strings, so sanitising twice equals sanitising once and no second pass is needed', () => {
            const pieces = [
                'a', 'e', 'o', 'A', 'Acme', '7', ' ', '\t', '\u00a0', '\u3000', '-', '\u0301', '\u0308', '\u0323', '\u0345', '\u200b', '\u200c', '\u200d', '\u00ad', '\u2060', '\ufeff', '\u061c', '\u034f',
                '\u115f', '\u1160', '\u3164', '\uffa0', '\u17b4', '\u180b', '\u180e', '\ufe0f', '\ufe00', '\u{e0100}', '\u{e0067}', '\u{e0001}', '\u202e', '\u2066', '\u1112', '\u1161', '\u11ab', '\u1100',
                '\uff21', '\uff45', '\uff9e', '\u3099', '\ufb03', '\u2126', '\u212a', '\u{1f600}', '\u{1d400}', '\ud800', '\udc00', '\ud83d', '\ude00', '\u0000', '\u0085', '\u2028', '\u2065', '\ufff0',
            ];
            let state = 20261021;
            const next = (): number => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state / 4294967296;
            };
            const failures: string[] = [];
            for (let index = 0; index < 6000; index += 1) {
                const texts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => Array.from({ length: Math.floor(next() * 9) }, () => pieces[Math.floor(next() * pieces.length)] ?? '').join(''));
                for (const text of texts) {
                    const once = normaliseKeyword(text);
                    if (normaliseKeyword(once) !== once) failures.push(`normalise: ${JSON.stringify(text)}`);
                }
                const first = sanitizeKeywordList(texts);
                const again = sanitizeKeywordList(first.keywords);
                if (JSON.stringify([again.keywords, again.needles, again.rejected]) !== JSON.stringify([first.keywords, first.needles, []])) failures.push(`sanitize: ${JSON.stringify(texts)}`);
            }
            expect(failures.slice(0, 5)).toEqual([]);
        });
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// n8n templates
// ---------------------------------------------------------------------------------------------------------------------

interface N8nNode {
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    position: [number, number];
    parameters: Record<string, any>;
    credentials?: Record<string, { id: string | null; name: string }>;
}
interface N8nWorkflow {
    name: string;
    nodes: N8nNode[];
    connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
    active: boolean;
    settings: Record<string, unknown>;
}

/** The node types and versions the templates were written against (all long-standing n8n core nodes). */
const NODE_VERSIONS: Record<string, number> = {
    'n8n-nodes-base.scheduleTrigger': 1.2,
    'n8n-nodes-base.code': 2,
    'n8n-nodes-base.httpRequest': 4.2,
    'n8n-nodes-base.wait': 1.1,
    'n8n-nodes-base.if': 2,
    'n8n-nodes-base.filter': 2,
    'n8n-nodes-base.noOp': 1,
};

const N8N_DIR = 'distribution/n8n/';
const TEMPLATE_FILES = readdirSync(`${ROOT}${N8N_DIR}`)
    .filter((file) => file.endsWith('.workflow.json'))
    .sort();
const ENGINES_DATA = JSON.parse(read(ENGINES_JSON_PATH)) as EnginesFile;

function load(file: string): N8nWorkflow {
    return JSON.parse(read(`${N8N_DIR}${file}`)) as N8nWorkflow;
}

function byName(workflow: N8nWorkflow, name: string): N8nNode {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`No node named "${name}"`);
    return node;
}

function edges(workflow: N8nWorkflow): Array<{ from: string; output: number; to: string }> {
    const out: Array<{ from: string; output: number; to: string }> = [];
    for (const [from, outputs] of Object.entries(workflow.connections)) {
        outputs.main.forEach((targets, output) => targets.forEach((target) => out.push({ from, output, to: target.node })));
    }
    return out;
}

function reachable(workflow: N8nWorkflow, start: string, without?: string): Set<string> {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.pop() as string;
        if (seen.has(current) || current === without) continue;
        seen.add(current);
        for (const edge of edges(workflow)) if (edge.from === current) queue.push(edge.to);
    }
    return seen;
}

function hasCycle(workflow: N8nWorkflow, without: string): boolean {
    const remaining = workflow.nodes.map((node) => node.name).filter((name) => name !== without);
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string): boolean => {
        if (state.get(name) === 'visiting') return true;
        if (state.get(name) === 'done') return false;
        state.set(name, 'visiting');
        for (const edge of edges(workflow)) if (edge.from === name && edge.to !== without && visit(edge.to)) return true;
        state.set(name, 'done');
        return false;
    };
    return remaining.some(visit);
}

function* strings(value: unknown): Generator<string> {
    if (typeof value === 'string') {
        yield value;
    } else if (Array.isArray(value)) {
        for (const item of value) yield* strings(item);
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            yield key;
            yield* strings(item);
        }
    }
}

/** Long runs of base64-alphabet characters that mix digits, upper and lower case: what an API key or token looks like (a path or a slug does not). */
function secretLikeRuns(text: string): string[] {
    const runs = text.match(/[A-Za-z0-9+/_-]{40,}={0,2}/gu) ?? [];
    return runs.filter((run) => /[0-9]/u.test(run) && /[a-z]/u.test(run) && /[A-Z]/u.test(run));
}

/** Runs the template's Code node in an isolated context with the one n8n global it uses, `$input`. */
async function runCodeNode(workflow: N8nWorkflow, incoming: Record<string, unknown>, edit: (code: string) => string = (code) => code): Promise<any> {
    const code = edit(byName(workflow, 'Build run input').parameters.jsCode as string);
    const context = vm.createContext({ $input: { first: () => ({ json: incoming }) } });
    const run = vm.runInContext(`(async function () {\n${code}\n})`, context) as () => Promise<unknown>;
    return JSON.parse(JSON.stringify(await run()));
}

/** Evaluates an n8n expression ("={{ ... }}", or text with {{ ... }} parts) with the variables the templates use. */
function evaluateExpression(expression: string, variables: { $json?: unknown; $runIndex?: number }): unknown {
    expect(expression.startsWith('='), `${expression} must be an expression`).toBe(true);
    const body = expression.slice(1);
    const context = vm.createContext({ ...variables });
    const single = /^\{\{([\s\S]*)\}\}$/u.exec(body);
    if (single && (body.match(/\{\{/gu) ?? []).length === 1) return vm.runInContext(`(${(single[1] as string).trim()})`, context);
    return body.replace(/\{\{([\s\S]*?)\}\}/gu, (_match, inner: string) => String(vm.runInContext(`(${inner.trim()})`, context)));
}

/** The watchlist guard section of the template's Code node, evaluated on its own in an isolated context: the two functions it defines, results as plain JSON. */
function loadGuard(workflow: N8nWorkflow): { normaliseKeyword: (text: string) => string; sanitizeKeywordList: (input: unknown) => { keywords: string[]; rejected: Record<string, number>; malformedContainer: boolean } } {
    const code = byName(workflow, 'Build run input').parameters.jsCode as string;
    const section = code.slice(code.indexOf('// --- watchlist guard'), code.indexOf('// --- end watchlist guard ---'));
    const functions = vm.runInNewContext(`${section}\n({ normaliseKeyword, sanitizeKeywordList });`) as { normaliseKeyword: (text: string) => string; sanitizeKeywordList: (input: unknown) => unknown };
    return {
        normaliseKeyword: functions.normaliseKeyword,
        sanitizeKeywordList: (input) => JSON.parse(JSON.stringify(functions.sanitizeKeywordList(input))),
    };
}

/** `code` with the first match of `from` replaced; the edit must change the template. */
function replaceOnce(code: string, from: string | RegExp, to: string): string {
    const next = code.replace(from, to);
    expect(next, `the edit ${String(from)} must change the template`).not.toBe(code);
    return next;
}

describe('n8n templates', () => {
    it('there is one workflow file per engine, named after its Actor slug', () => {
        expect(TEMPLATE_FILES).toEqual(ENGINES.map((engine) => `${engine.slug}.workflow.json`).sort());
    });

    describe.each(TEMPLATE_FILES)('%s', (file) => {
        const slug = file.replace('.workflow.json', '');
        const workflow = load(file);
        const engine = ENGINES_DATA.engines[slug];

        it('is valid JSON with the shape n8n imports, inactive, and pure ASCII', () => {
            expect(/[^\u0000-\u007f]/u.test(read(`${N8N_DIR}${file}`))).toBe(false);
            expect(typeof workflow.name).toBe('string');
            expect(Array.isArray(workflow.nodes)).toBe(true);
            expect(typeof workflow.connections).toBe('object');
            expect(workflow.active).toBe(false);
            expect(engine, `${slug} must be a registered engine`).toBeDefined();
        });

        it('has unique node names and ids, and only the vetted node types at their versions', () => {
            const names = workflow.nodes.map((node) => node.name);
            expect(new Set(names).size).toBe(names.length);
            expect(new Set(workflow.nodes.map((node) => node.id)).size).toBe(workflow.nodes.length);
            for (const node of workflow.nodes) {
                expect(typeof node.id).toBe('string');
                expect(node.id.length).toBeGreaterThan(0);
                expect(NODE_VERSIONS[node.type], `${node.name}: ${node.type}`).toBe(node.typeVersion);
                expect(node.position).toHaveLength(2);
                expect(node.position.every((coordinate) => Number.isFinite(coordinate))).toBe(true);
                expect(typeof node.parameters).toBe('object');
            }
        });

        it('has exactly one trigger, the Schedule Trigger, with nothing leading into it', () => {
            const triggers = workflow.nodes.filter((node) => /trigger|webhook/iu.test(node.type));
            expect(triggers.map((node) => node.type)).toEqual(['n8n-nodes-base.scheduleTrigger']);
            const trigger = triggers[0] as N8nNode;
            expect(edges(workflow).filter((edge) => edge.to === trigger.name)).toEqual([]);
            expect(Array.isArray(trigger.parameters.rule?.interval)).toBe(true);
        });

        it('schedules one interval entry n8n can read: the days field, a positive step and an hour of the day', () => {
            const intervals = byName(workflow, 'Schedule Trigger').parameters.rule.interval as Array<Record<string, unknown>>;
            expect(intervals).toHaveLength(1);
            const [entry] = intervals as [Record<string, unknown>];
            expect(entry.field).toBe('days');
            expect(Number.isInteger(entry.daysInterval) && (entry.daysInterval as number) >= 1).toBe(true);
            expect(Number.isInteger(entry.triggerAtHour) && (entry.triggerAtHour as number) >= 0 && (entry.triggerAtHour as number) <= 23).toBe(true);
            if (entry.triggerAtMinute !== undefined) expect(Number.isInteger(entry.triggerAtMinute) && (entry.triggerAtMinute as number) >= 0 && (entry.triggerAtMinute as number) <= 59).toBe(true);
            expect(Object.keys(entry).sort()).toEqual(['daysInterval', 'field', 'triggerAtHour']);
        });

        it('connects only existing nodes, in the order trigger, code, start, wait, poll, if, items, filter, no-op', () => {
            const names = new Set(workflow.nodes.map((node) => node.name));
            for (const [from, outputs] of Object.entries(workflow.connections)) {
                expect(names.has(from), `connection source ${from}`).toBe(true);
                expect(Object.keys(outputs)).toEqual(['main']);
                for (const targets of outputs.main) {
                    for (const target of targets) {
                        expect(names.has(target.node), `connection target ${target.node}`).toBe(true);
                        expect(target.type).toBe('main');
                        expect(target.index).toBe(0);
                    }
                }
            }
            const chain = (from: string, output = 0): string[] => edges(workflow).filter((edge) => edge.from === from && edge.output === output).map((edge) => edge.to);
            expect(chain('Schedule Trigger')).toEqual(['Build run input']);
            expect(chain('Build run input')).toEqual(['Start Apify run']);
            expect(chain('Start Apify run')).toEqual(['Wait before polling']);
            expect(chain('Wait before polling')).toEqual(['Get run status']);
            expect(chain('Get run status')).toEqual(['Run still going?']);
            expect(chain('Get dataset items')).toEqual(['Keep watchlist matches']);
            expect(chain('Keep watchlist matches')).toEqual(['Deliver matches downstream']);
            expect(chain('Deliver matches downstream')).toEqual([]);
            expect(byName(workflow, 'Deliver matches downstream').type).toBe('n8n-nodes-base.noOp');
            expect(byName(workflow, 'Start Apify run').type).toBe('n8n-nodes-base.httpRequest');
            expect(byName(workflow, 'Get dataset items').type).toBe('n8n-nodes-base.httpRequest');
            expect(byName(workflow, 'Keep watchlist matches').type).toBe('n8n-nodes-base.filter');
        });

        it('reaches every node from the trigger and ends every path at "Deliver matches downstream"', () => {
            const fromTrigger = reachable(workflow, 'Schedule Trigger');
            expect([...fromTrigger].sort()).toEqual(workflow.nodes.map((node) => node.name).sort());
            const sinks = workflow.nodes.map((node) => node.name).filter((name) => !edges(workflow).some((edge) => edge.from === name));
            expect(sinks).toEqual(['Deliver matches downstream']);
        });

        it('bounds the loop: a fixed Wait interval, an IF whose false branch exits, and a poll counter', () => {
            const wait = byName(workflow, 'Wait before polling');
            expect(wait.parameters.resume).toBe('timeInterval');
            expect(Number.isInteger(wait.parameters.amount) && wait.parameters.amount > 0).toBe(true);
            expect(['seconds', 'minutes', 'hours']).toContain(wait.parameters.unit);
            expect(wait.parameters.amount * { seconds: 1, minutes: 60, hours: 3600 }[wait.parameters.unit as 'seconds' | 'minutes' | 'hours'], 'never polls faster than every 10 seconds').toBeGreaterThanOrEqual(10);

            const trueBranch = edges(workflow).filter((edge) => edge.from === 'Run still going?' && edge.output === 0).map((edge) => edge.to);
            const falseBranch = edges(workflow).filter((edge) => edge.from === 'Run still going?' && edge.output === 1).map((edge) => edge.to);
            expect(trueBranch).toEqual(['Wait before polling']);
            expect(falseBranch).toEqual(['Get dataset items']);
            const afterExit = reachable(workflow, 'Get dataset items');
            expect(afterExit.has('Wait before polling')).toBe(false);
            expect(afterExit.has('Run still going?')).toBe(false);
            expect(afterExit.has('Deliver matches downstream')).toBe(true);
            expect(hasCycle(workflow, 'Wait before polling'), 'every cycle must pass through the Wait node').toBe(false);
            expect(reachable(workflow, 'Wait before polling').has('Run still going?')).toBe(true);

            const conditions = byName(workflow, 'Run still going?').parameters.conditions.conditions as Array<{ leftValue: string; rightValue: string; operator: { type: string; operation: string } }>;
            expect(conditions).toHaveLength(1);
            const [condition] = conditions as [(typeof conditions)[number]];
            expect(condition.leftValue).toContain("!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes($json.data.status)");
            const polls = /\$runIndex < (\d+)/u.exec(condition.leftValue);
            expect(polls, 'the IF must cap the number of polls').not.toBeNull();
            const maxPolls = Number(polls?.[1]);
            expect(maxPolls).toBeGreaterThan(0);
            const unitSeconds = { seconds: 1, minutes: 60, hours: 3600 }[wait.parameters.unit as 'seconds' | 'minutes' | 'hours'];
            expect(maxPolls * wait.parameters.amount * unitSeconds, 'the longest wait stays within two hours').toBeLessThanOrEqual(7200);
            expect(condition.operator).toEqual({ type: 'string', operation: 'equals' });
            expect(condition.rightValue).toBe('poll');
        });

        it('polls while the run has no final status and leaves the loop at the poll cap, evaluated as n8n would', () => {
            const condition = (byName(workflow, 'Run still going?').parameters.conditions.conditions as Array<{ leftValue: string; rightValue: string }>)[0] as { leftValue: string; rightValue: string };
            const maxPolls = Number(/\$runIndex < (\d+)/u.exec(condition.leftValue)?.[1]);
            const answer = (status: unknown, runIndex: number): unknown => evaluateExpression(condition.leftValue, { $json: { data: { status } }, $runIndex: runIndex });
            for (const status of ['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']) {
                expect(answer(status, 0), `${status} on the first poll`).toBe(condition.rightValue);
                expect(answer(status, maxPolls - 1), `${status} on the last allowed poll`).toBe(condition.rightValue);
                expect(answer(status, maxPolls), `${status} once the cap is reached`).not.toBe(condition.rightValue);
            }
            for (const status of ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']) {
                expect(answer(status, 0), `${status} is final`).not.toBe(condition.rightValue);
                expect(answer(status, maxPolls - 1), `${status} is final on every poll`).not.toBe(condition.rightValue);
            }
        });

        it('starts the run with a POST to this engine\'s Actor and a positive maxTotalChargeUsd query parameter', () => {
            const start = byName(workflow, 'Start Apify run');
            expect(start.parameters.method).toBe('POST');
            expect(start.parameters.url).toMatch(new RegExp(`^https://api\\.apify\\.com/v2/acts/[A-Za-z0-9_.-]+~${slug}/runs$`, 'u'));
            expect(start.parameters.sendQuery).toBe(true);
            const caps = (start.parameters.queryParameters.parameters as Array<{ name: string; value: string }>).filter((parameter) => parameter.name === 'maxTotalChargeUsd');
            expect(caps).toHaveLength(1);
            const cap = Number((caps[0] as { value: string }).value);
            expect(Number.isFinite(cap) && cap > 0).toBe(true);
            expect((caps[0] as { value: string }).value).toMatch(/^\d+(\.\d+)?$/u);
            expect(cap, 'the cap a template ships with is a modest default the operator raises on purpose').toBeLessThanOrEqual(10);
            expect(start.parameters.queryParameters.parameters).toHaveLength(1);
            expect(start.parameters.sendBody).toBe(true);
            expect(start.parameters.specifyBody).toBe('json');
            expect(start.parameters.jsonBody).toBe('={{ JSON.stringify($json.input) }}');
        });

        it('never retries the run start (a retried POST could start a second billable run)', () => {
            const start = byName(workflow, 'Start Apify run') as N8nNode & { retryOnFail?: boolean; maxTries?: number };
            expect(start.retryOnFail ?? false).toBe(false);
            expect(start.maxTries).toBeUndefined();
        });

        it('does not let a failed run start pass silently: no continue-on-fail, no empty output on error', () => {
            const start = byName(workflow, 'Start Apify run') as N8nNode & Record<string, unknown>;
            expect([undefined, 'stopWorkflow']).toContain(start.onError);
            expect(start.continueOnFail ?? false).toBe(false);
            expect(start.alwaysOutputData ?? false).toBe(false);
            expect(start.waitBetweenTries).toBeUndefined();
        });

        it('builds the request URLs and the body from the previous item, evaluated as n8n would', () => {
            const item = { data: { id: 'RUN123', defaultDatasetId: 'DATASET456' }, input: { sources: ['ofac'], maxItemsPerSource: 5 } };
            expect(evaluateExpression(byName(workflow, 'Get run status').parameters.url, { $json: item })).toBe('https://api.apify.com/v2/actor-runs/RUN123');
            expect(evaluateExpression(byName(workflow, 'Get dataset items').parameters.url, { $json: item })).toBe('https://api.apify.com/v2/datasets/DATASET456/items');
            expect(evaluateExpression(byName(workflow, 'Start Apify run').parameters.jsonBody, { $json: item })).toBe('{"sources":["ofac"],"maxItemsPerSource":5}');
            const query = byName(workflow, 'Get dataset items').parameters.queryParameters.parameters as Array<{ name: string; value: string }>;
            expect(query, 'the dataset is read as JSON items, one n8n item per row').toEqual([{ name: 'format', value: 'json' }]);
        });

        it('reaches the run and the dataset through api.apify.com with the run and dataset ids of the previous node', () => {
            expect(byName(workflow, 'Get run status').parameters).toMatchObject({ method: 'GET', url: '=https://api.apify.com/v2/actor-runs/{{ $json.data.id }}' });
            expect(byName(workflow, 'Get dataset items').parameters).toMatchObject({ method: 'GET', url: '=https://api.apify.com/v2/datasets/{{ $json.data.defaultDatasetId }}/items' });
            for (const node of workflow.nodes.filter((candidate) => candidate.type === 'n8n-nodes-base.httpRequest')) {
                expect(String(node.parameters.url).replace(/^=/u, '')).toMatch(/^https:\/\/api\.apify\.com\/v2\//u);
            }
        });

        it('authenticates every HTTP node through a Header Auth credential referenced by name only', () => {
            const httpNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest');
            expect(httpNodes.map((node) => node.name)).toEqual(['Start Apify run', 'Get run status', 'Get dataset items']);
            for (const node of httpNodes) {
                expect(node.parameters.authentication, node.name).toBe('genericCredentialType');
                expect(node.parameters.genericAuthType, node.name).toBe('httpHeaderAuth');
                expect(node.credentials, node.name).toEqual({ httpHeaderAuth: { id: null, name: 'Apify API token' } });
                expect(node.parameters.sendHeaders, `${node.name} must not carry an inline header`).toBeUndefined();
                expect(node.parameters.headerParameters, node.name).toBeUndefined();
            }
            for (const node of workflow.nodes.filter((candidate) => candidate.type !== 'n8n-nodes-base.httpRequest')) expect(node.credentials, node.name).toBeUndefined();
        });

        it('filters on is_watchlist_match being true', () => {
            const filter = byName(workflow, 'Keep watchlist matches').parameters.conditions.conditions as Array<{ leftValue: string; rightValue: string }>;
            expect(filter).toHaveLength(1);
            expect(filter[0]?.leftValue).toBe('={{ String($json.is_watchlist_match === true) }}');
            expect(filter[0]?.rightValue).toBe('true');
        });

        it('keeps the rows whose is_watchlist_match is the boolean true and drops every other row, evaluated as n8n would', () => {
            const [condition] = byName(workflow, 'Keep watchlist matches').parameters.conditions.conditions as [{ leftValue: string; rightValue: string; operator: { type: string; operation: string } }];
            expect(condition.operator, 'an equality test: any other operation would invert or widen the filter').toEqual({ type: 'string', operation: 'equals' });
            const keeps = (row: Record<string, unknown>): boolean => evaluateExpression(condition.leftValue, { $json: row }) === condition.rightValue;
            expect(keeps({ is_watchlist_match: true, source: 'ofac' })).toBe(true);
            for (const row of [{ is_watchlist_match: false }, {}, { is_watchlist_match: 'true' }, { is_watchlist_match: 1 }, { is_watchlist_match: null }, { matched_watchlist_keyword: 'Acme' }]) {
                expect(keeps(row), JSON.stringify(row)).toBe(false);
            }
        });

        it('contains nothing that looks like a token, a key or a bearer header', () => {
            const all = [...strings(workflow)];
            expect(all.length).toBeGreaterThan(50);
            for (const text of all) {
                expect(text, 'an Apify token prefix').not.toMatch(/apify_api_/iu);
                expect(text, 'a bearer header value').not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/u);
                expect(secretLikeRuns(text), 'a long mixed-case base64-looking run').toEqual([]);
                expect(text, 'a long hex run').not.toMatch(/[0-9a-f]{32,}/iu);
                expect(text, 'a PEM block').not.toMatch(/-----BEGIN/u);
            }
        });

        it('has a Code node whose embedded registry lists equal engines.json', async () => {
            const code = byName(workflow, 'Build run input').parameters.jsCode as string;
            const literal = (name: string): unknown => {
                const match = new RegExp(`const ${name} = (.*);\\n`, 'u').exec(code);
                expect(match, name).not.toBeNull();
                return vm.runInNewContext(`(${(match as RegExpExecArray)[1]})`);
            };
            const sources = engine?.sources ?? [];
            expect(literal('ACTIVE_SOURCES')).toEqual(sources.filter((s) => s.status === 'active').map((s) => s.id));
            expect(literal('HELD_SOURCES')).toEqual(sources.filter((s) => s.status === 'held').map((s) => s.id));
            expect(literal('REQUIRED_OPTIONS')).toEqual(Object.fromEntries(sources.filter((s) => s.requiredOptions.length > 0).map((s) => [s.id, s.requiredOptions])));
            const credentialNames = new Set<string>();
            for (const entry of Object.values(ENGINES_DATA.engines)) for (const [field, target] of Object.entries(entry.credentialFields)) [field, target.option].forEach((name) => credentialNames.add(name.toLowerCase()));
            expect(literal('CREDENTIAL_NAMES')).toEqual([...credentialNames].sort());
            expect(literal('DELTA_MODES')).toEqual(ENGINES_DATA.limits.deltaModes);
        });

        it('has a Code node that builds a valid run input from its default configuration', async () => {
            const result = await runCodeNode(workflow, {});
            const input = result[0].json.input as Record<string, any>;
            const active = new Set((engine?.sources ?? []).filter((s) => s.status === 'active').map((s) => s.id));
            expect(input.sources.length).toBeGreaterThan(0);
            for (const source of input.sources) expect(active.has(source), source).toBe(true);
            expect(ENGINES_DATA.limits.deltaModes).toContain(input.deltaMode);
            expect(input.maxItemsPerSource).toBeGreaterThanOrEqual(ENGINES_DATA.limits.maxItemsPerSource.min);
            expect(input.maxItemsPerSource).toBeLessThanOrEqual(ENGINES_DATA.limits.maxItemsPerSource.max);
            expect(input.stateNamespace).toMatch(new RegExp(ENGINES_DATA.limits.stateNamespacePattern, 'u'));
            expect(Object.keys(input).sort()).toEqual(['deltaMode', 'maxItemsPerSource', 'sources', 'stateNamespace', 'watchlistNames']);
            expect(Object.keys(input).filter((key) => /key|secret|token/iu.test(key))).toEqual([]);
        });

        it('has a Code node that refuses held, unknown and credential-needing sources and credentials in sourceOptions', async () => {
            const held = (engine?.sources ?? []).find((s) => s.status === 'held');
            const needsCredential = (engine?.sources ?? []).find((s) => s.requiredOptions.length > 0);
            const withSources = (ids: string[]) => (code: string) => replaceOnce(code, /sources: \[[^\]]*\],/u, `sources: [${ids.map((id) => `'${id}'`).join(', ')}],`);
            if (held) await expect(runCodeNode(workflow, {}, withSources([held.id]))).rejects.toThrow(/is held/u);
            await expect(runCodeNode(workflow, {}, withSources(['no_such_source']))).rejects.toThrow(/unknown source/u);
            await expect(runCodeNode(workflow, {}, withSources([]))).rejects.toThrow(/non-empty list/u);
            if (needsCredential) await expect(runCodeNode(workflow, {}, withSources([needsCredential.id]))).rejects.toThrow(new RegExp(`requires ${needsCredential.requiredOptions[0]}`, 'u'));
            const first = (engine?.sources ?? []).find((s) => s.status === 'active' && s.requiredOptions.length === 0)?.id as string;
            const withOptions = (options: string) => (code: string) => replaceOnce(replaceOnce(code, /sources: \[[^\]]*\],/u, `sources: ['${first}'],`), 'sourceOptions: {},', `sourceOptions: ${options},`);
            await expect(runCodeNode(workflow, {}, withOptions(`{ ${first}: { fdaApiKey: 'x' } }`))).rejects.toThrow(/must not contain a credential/u);
            await expect(runCodeNode(workflow, {}, withOptions(`{ ${first}: { nested: [{ USPTOODPAPIKEY: 'x' }] } }`))).rejects.toThrow(/must not contain a credential/u);
            await expect(runCodeNode(workflow, {}, withOptions(`{ some_other_source: { a: 1 } }`))).rejects.toThrow(/not a selected source/u);
            const accepted = await runCodeNode(workflow, {}, withOptions(`{ ${first.toUpperCase()}: { limit: 5 } }`));
            expect(accepted[0].json.input.sourceOptions).toEqual({ [first]: { limit: 5 } });
            const noSources = (code: string) => replaceOnce(code, /sources: \[[^\]]*\],/u, 'sources: [],');
            await expect(runCodeNode(workflow, {}, noSources)).rejects.toThrow(/Refused before any run started/u);
        });

        it('has a Code node that refuses bad delta modes, limits and namespaces', async () => {
            await expect(runCodeNode(workflow, {}, (code) => replaceOnce(code, "deltaMode: 'onlyChanged'", "deltaMode: 'sometimes'"))).rejects.toThrow(/deltaMode/u);
            for (const bad of ['0', '10001', '1.5', "'5'"]) await expect(runCodeNode(workflow, {}, (code) => replaceOnce(code, 'maxItemsPerSource: 100', `maxItemsPerSource: ${bad}`))).rejects.toThrow(/maxItemsPerSource/u);
            for (const bad of ["'Has Caps'", "'x'.repeat(41)", "'a_b'"]) await expect(runCodeNode(workflow, {}, (code) => replaceOnce(code, /stateNamespace: '[^']*'/u, `stateNamespace: ${bad}`))).rejects.toThrow(/stateNamespace/u);
        });

        it('has a guard whose normaliseKeyword equals the TypeScript guard on the whole normalise corpus', () => {
            const corpus = JSON.parse(read(GUARD_PARITY_JSON_PATH)) as { normalise: Array<{ name: string; input: string; expected: string }> };
            const guard = loadGuard(workflow);
            for (const entry of corpus.normalise) expect(guard.normaliseKeyword(entry.input), entry.name).toBe(entry.expected);
        });

        it('has a Code node that cleans the watchlist exactly like the TypeScript guard on the whole parity corpus', async () => {
            const corpus = JSON.parse(read(GUARD_PARITY_JSON_PATH)) as { sanitize: ParityCase[] };
            const supplied = (value: unknown): boolean => {
                if (value === undefined || value === null) return false;
                if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
                if (typeof value === 'object') return Object.keys(value).length > 0;
                return true;
            };
            let refused = 0;
            let cleaned = 0;
            let silent = 0;
            for (const entry of corpus.sanitize) {
                const reasons: Record<string, number> = {};
                for (const item of entry.expected.rejected) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
                if (entry.expected.keywords.length > 0) {
                    const result = await runCodeNode(workflow, { watchlistNames: entry.input });
                    expect(result[0].json.input.watchlistNames, entry.name).toEqual(entry.expected.keywords);
                    expect(result[0].json.watchlist.accepted, entry.name).toBe(entry.expected.keywords.length);
                    expect(result[0].json.watchlist.rejected, entry.name).toBe(entry.expected.rejected.length);
                    expect(result[0].json.watchlist.rejectedByReason, entry.name).toEqual(reasons);
                    cleaned += 1;
                } else if (supplied(entry.input)) {
                    const why = entry.expected.malformedContainer ? /unsupported value type/u : new RegExp(`${entry.expected.rejected.length} entries rejected`, 'u');
                    await expect(runCodeNode(workflow, { watchlistNames: entry.input }), entry.name).rejects.toThrow(why);
                    refused += 1;
                } else {
                    const result = await runCodeNode(workflow, { watchlistNames: entry.input });
                    expect(result[0].json.input.watchlistNames, entry.name).toBeUndefined();
                    silent += 1;
                }
            }
            expect(cleaned).toBeGreaterThan(200);
            expect(refused).toBeGreaterThan(40);
            expect(silent).toBeGreaterThan(3);
        });

        it('has a Code node that cleans to a fixed point: a keyword whose second cleaning pass changes it is judged as the settled text', async () => {
            // "e", ZERO WIDTH SPACE, COMBINING ACUTE: removing the space exposes a sequence NFKC composes to U+00E9, one code point, so it is too_short. The
            // guard repeats the cleaning until nothing changes, so that is decided at once and the engine's own pass over what is sent changes nothing.
            expect(sanitizeKeywordList(['e\u200b\u0301']).keywords).toEqual([]);
            expect(sanitizeKeywordList(['e\u200b\u0301']).rejected.map((item) => item.reason)).toEqual(['too_short']);
            await expect(runCodeNode(workflow, { watchlistNames: ['e\u200b\u0301'] })).rejects.toThrow(/refusing to run unfiltered/u);
            const result = await runCodeNode(workflow, { watchlistNames: ['e\u200b\u0301', 'a\u200b\u0301\u0301', 'Acme'] });
            const sent = result[0].json.input.watchlistNames as string[];
            expect(sent).toEqual(['\u00e1\u0301', 'Acme']);
            expect(sanitizeKeywordList(sent).keywords, 'what is sent is a fixed point of the guard').toEqual(sent);
            expect(sanitizeKeywordList(sent).rejected, 'and a second pass rejects nothing').toEqual([]);
            expect(result[0].json.watchlist).toEqual({ accepted: 2, rejected: 1, rejectedByReason: { too_short: 1 } });
        });

        it('has a Code node that gives up on a text that has not settled after 8 cleaning passes (7 changes and one pass that finds nothing is still fine)', async () => {
            // cleanOnce is edited to append an "x" until the text holds K of them: it settles after K changing passes plus one pass that changes nothing.
            const settlesAfter = (changes: number) => (code: string) =>
                replaceOnce(code, /return (text\.normalize\('NFKC'\)[^\n]*\.trim\(\));/u, `const base = $1;\n    return (base.match(/x/gu) ?? []).length < ${changes} ? base + 'x' : base;`);
            const seven = await runCodeNode(workflow, { watchlistNames: ['ab'] }, settlesAfter(MAX_NORMALISE_PASSES - 1));
            expect(seven[0].json.input.watchlistNames).toEqual(['abxxxxxxx']);
            await expect(runCodeNode(workflow, { watchlistNames: ['ab'] }, settlesAfter(MAX_NORMALISE_PASSES))).rejects.toThrow(/1 entries rejected/u);
            await expect(runCodeNode(workflow, { watchlistNames: ['ab', '\u200b', 'Acme'] }, settlesAfter(MAX_NORMALISE_PASSES))).rejects.toThrow(/3 entries rejected/u);
        });

        it('has a Code node that rejects a lone surrogate before any cleaning, as invalid_unicode', async () => {
            await expect(runCodeNode(workflow, { watchlistNames: ['Be\ud800ta'] })).rejects.toThrow(/1 entries rejected/u);
            const result = await runCodeNode(workflow, { watchlistNames: ['Acme', 'Be\ud800ta', '\ud83d\u200b\ude00', 'Gamma Inc', '\udc00'] });
            expect(result[0].json.input.watchlistNames).toEqual(['Acme', 'Gamma Inc']);
            expect(result[0].json.watchlist).toEqual({ accepted: 2, rejected: 3, rejectedByReason: { invalid_unicode: 3 } });
            // a well-formed pair is not a lone surrogate
            const pair = await runCodeNode(workflow, { watchlistNames: ['Ac\u{1f600}me', 'Beta\ud83d\ude00'] });
            expect(pair[0].json.input.watchlistNames).toEqual(['Ac\u{1f600}me', 'Beta\u{1f600}']);
        });

        it('has a Code node with the raw keyword cap, the candidate cap, the total budget and the bare-string cut of the TypeScript guard', async () => {
            const zw = '\u200b';
            const raw = await runCodeNode(workflow, { watchlistNames: [`${zw.repeat(MAX_RAW_KEYWORD_UNITS - 2)}ab`, `${zw.repeat(MAX_RAW_KEYWORD_UNITS - 1)}cd`] });
            expect(raw[0].json.input.watchlistNames).toEqual(['ab']);
            expect(raw[0].json.watchlist.rejectedByReason).toEqual({ too_long: 1 });

            const short = Array.from({ length: MAX_CANDIDATES - 1 }, () => 'a');
            const exactly = await runCodeNode(workflow, { watchlistNames: [...short, 'Acme Corp'] });
            expect(exactly[0].json.input.watchlistNames).toEqual(['Acme Corp']);
            expect(exactly[0].json.watchlist).toEqual({ accepted: 1, rejected: MAX_CANDIDATES - 1, rejectedByReason: { too_short: MAX_CANDIDATES - 1 } });
            const capped = await runCodeNode(workflow, { watchlistNames: [...short, 'Acme Corp', 'Beta Corp', 'Gamma Corp'] });
            expect(capped[0].json.input.watchlistNames).toEqual(['Acme Corp']);
            expect(capped[0].json.watchlist).toEqual({ accepted: 1, rejected: MAX_CANDIDATES, rejectedByReason: { too_short: MAX_CANDIDATES - 1, over_limit: 1 } });
            const beyondOnly = await runCodeNode(workflow, { watchlistNames: ['Acme Corp', ...Array.from({ length: MAX_CANDIDATES }, (_unused, index) => `kw${index}`)] });
            expect(beyondOnly[0].json.watchlist).toEqual({ accepted: 500, rejected: MAX_CANDIDATES - 500 + 1, rejectedByReason: { over_limit: MAX_CANDIDATES - 500 + 1 } });

            const bare = Array.from({ length: MAX_CANDIDATES + 2 }, (_unused, index) => (index < 3 ? `kw${index}` : 'a')).join(',');
            const pieces = await runCodeNode(workflow, { watchlistNames: bare });
            expect(pieces[0].json.input.watchlistNames).toEqual(['kw0', 'kw1', 'kw2']);
            expect(pieces[0].json.watchlist.rejectedByReason).toEqual({ too_short: MAX_CANDIDATES - 3, over_limit: 1 });

            // a bare string over 200000 units: cut, the last piece dropped (the cut may have truncated it), one marker after the others
            const spaces = ' '.repeat(MAX_BARE_STRING_UNITS - 17);
            const cut = await runCodeNode(workflow, { watchlistNames: `${spaces},Alpha Corp,Beta\u{1f600},Gamma Corp` });
            expect(cut[0].json.input.watchlistNames, 'the high half at the cut, its piece and what follows are gone').toEqual(['Alpha Corp']);
            expect(cut[0].json.watchlist).toEqual({ accepted: 1, rejected: 2, rejectedByReason: { too_long: 1, over_limit: 1 } });
            const pfizer = await runCodeNode(workflow, { watchlistNames: `${' '.repeat(MAX_BARE_STRING_UNITS - 21)},Alpha Corp,Pfizer Inc` });
            expect(pfizer[0].json.input.watchlistNames, '"Pfizer In" is not accepted as a keyword').toEqual(['Alpha Corp']);
            expect(pfizer[0].json.watchlist.rejectedByReason).toEqual({ too_long: 1, over_limit: 1 });
            await expect(runCodeNode(workflow, { watchlistNames: 'a'.repeat(MAX_BARE_STRING_UNITS + 1) })).rejects.toThrow(/1 entries rejected/u);
            const whole = await runCodeNode(workflow, { watchlistNames: `${' '.repeat(MAX_BARE_STRING_UNITS - 18)},Alpha Corp,Beta\u{1f600}` });
            expect(whole[0].json.input.watchlistNames).toEqual(['Alpha Corp', 'Beta\u{1f600}']);
            expect(whole[0].json.watchlist.rejectedByReason, 'exactly 200000 units: nothing dropped, no marker').toEqual({ too_long: 1 });
        });

        it('has a Code node with the total raw-unit budget: 200000 units of strings of 4096 units or fewer; longer strings and non-strings cost nothing', async () => {
            const letters = (length: number, letter = 'a') => letter.repeat(length);
            const exact = ['Acme', ...Array.from({ length: 48 }, () => letters(MAX_RAW_KEYWORD_UNITS)), letters(MAX_TOTAL_RAW_UNITS - 4 - 48 * MAX_RAW_KEYWORD_UNITS, 'b')];
            const at = await runCodeNode(workflow, { watchlistNames: exact });
            expect(at[0].json.input.watchlistNames).toEqual(['Acme']);
            expect(at[0].json.watchlist, 'exactly 200000 units: every entry is inspected').toEqual({ accepted: 1, rejected: 49, rejectedByReason: { too_long: 49 } });
            const over = await runCodeNode(workflow, { watchlistNames: [...exact, 'Z'] });
            expect(over[0].json.watchlist, 'one unit more: that entry is not inspected, one marker').toEqual({ accepted: 1, rejected: 50, rejectedByReason: { too_long: 49, over_limit: 1 } });
            await expect(runCodeNode(workflow, { watchlistNames: Array.from({ length: 49 }, () => letters(MAX_RAW_KEYWORD_UNITS - 4)) })).rejects.toThrow(/49 entries rejected/u);

            const big = letters(MAX_RAW_KEYWORD_UNITS + 1);
            const reads = await runCodeNode(workflow, { watchlistNames: [...Array.from({ length: MAX_CANDIDATES - 1 }, () => big), 'Acme Corp'] });
            expect(reads[0].json.input.watchlistNames, '4999 strings over the raw cap cost no budget, so the 5000th entry is read').toEqual(['Acme Corp']);
            expect(reads[0].json.watchlist).toEqual({ accepted: 1, rejected: MAX_CANDIDATES - 1, rejectedByReason: { too_long: MAX_CANDIDATES - 1 } });
            await expect(runCodeNode(workflow, { watchlistNames: [...Array.from({ length: MAX_CANDIDATES }, () => big), 'Acme Corp'] })).rejects.toThrow(/5001 entries rejected/u);

            const mixed = [null, 1, { k: 1 }, letters(5000, 'c'), ...Array.from({ length: 48 }, () => letters(MAX_RAW_KEYWORD_UNITS)), [1, 2], letters(MAX_TOTAL_RAW_UNITS - 48 * MAX_RAW_KEYWORD_UNITS, 'd'), 7, 'Acme', 'Beta Corp', null];
            await expect(runCodeNode(workflow, { watchlistNames: mixed })).rejects.toThrow(/56 entries rejected/u);
        });

        it('has a Code node that treats a text with more than 16 consecutive combining marks as empty, on every cleaning pass, before normalising it', async () => {
            const marks = (count: number, mark = '\u0301') => mark.repeat(count);
            const result = await runCodeNode(workflow, {
                watchlistNames: [`b${marks(16)}`, `b${marks(17)}`, `b${'\u0301\u200b'.repeat(17)}`, `a${'\u0301\u200b'.repeat(17)}`, `a${'\u0301\u200b'.repeat(18)}`, `ab${marks(17, '\uff9e')}`, 'Acme'],
            });
            expect(result[0].json.input.watchlistNames).toEqual([`b${marks(16)}`, `\u00e1${marks(16)}`, 'Acme']);
            expect(result[0].json.watchlist).toEqual({ accepted: 3, rejected: 4, rejectedByReason: { empty_after_normalisation: 4 } });
            // the descending-class attack: NFKC would reorder 4094 marks, which is quadratic (about 18 ms each); 48 of them (just under the 200000 unit budget) must cost milliseconds
            const attack = Array.from({ length: 48 }, (_unused, index) => `${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + (Math.floor(index / 26) % 26))}${marks(1365, '\u0345')}${marks(1365, '\u0300')}${marks(1364, '\u0316')}`);
            const started = performance.now();
            await expect(runCodeNode(workflow, { watchlistNames: attack })).rejects.toThrow(/48 entries rejected/u);
            expect(performance.now() - started, 'the attack list costs milliseconds, not seconds').toBeLessThan(400);
        });

        it('has a Code node that never crashes on a value it cannot read: a revoked Proxy disables the watchlist, it does not throw', async () => {
            const container = Proxy.revocable([], {});
            container.revoke();
            await expect(runCodeNode(workflow, { watchlistNames: container.proxy })).rejects.toThrow(/unsupported value type/u);
            const element = Proxy.revocable({}, {});
            element.revoke();
            const result = await runCodeNode(workflow, { watchlistNames: ['Acme Corp', element.proxy] });
            expect(result[0].json.input.watchlistNames).toEqual(['Acme Corp']);
            expect(result[0].json.watchlist).toEqual({ accepted: 1, rejected: 1, rejectedByReason: { not_a_string: 1 } });
        });

        it('has a Code node that falls back to its own CONFIG watchlist when the trigger item carries none', async () => {
            const result = await runCodeNode(workflow, { timestamp: 'x' });
            expect(result[0].json.input.watchlistNames).toEqual(['Acme Corp']);
            const noWatchlist = await runCodeNode(workflow, {}, (code) => replaceOnce(code, "watchlistNames: ['Acme Corp']", 'watchlistNames: []'));
            expect(noWatchlist[0].json.input.watchlistNames).toBeUndefined();
        });
    });

    it('the token heuristic itself flags what it should and spares paths and slugs', () => {
        expect(secretLikeRuns('apify_api_Zk3Jf9QwErTyUiOpAsDfGhJkLzXcVbNm12345')).toHaveLength(1);
        expect(secretLikeRuns('dGhpcy1pcy1hLWZha2UtYmFzZTY0LXNlY3JldC12YWx1ZS0xMjM0NTY3ODkw')).toHaveLength(1);
        expect(secretLikeRuns('distribution/python/src/regulatory_engines/data/engines')).toEqual([]);
        expect(secretLikeRuns('global-corporate-patent-intelligence')).toEqual([]);
    });

    it('the watchlist guard section of the Code node is identical in all three templates', () => {
        const sections = TEMPLATE_FILES.map((file) => {
            const code = byName(load(file), 'Build run input').parameters.jsCode as string;
            const start = code.indexOf('// --- watchlist guard');
            const end = code.indexOf('// --- end watchlist guard ---');
            expect(start).toBeGreaterThan(-1);
            expect(end).toBeGreaterThan(start);
            return code.slice(start, end);
        });
        expect(new Set(sections).size).toBe(1);
    });

    it('the Code node guard constants and regular expressions equal the TypeScript guard', () => {
        const guardSource = read('lib/_guards.ts');
        const generatorSource = read('scripts/generate_distribution_data.ts');
        const literal = (text: string, name: string): string => {
            const found = new RegExp(`const ${name} = (/.+/[a-z]*);`, 'u').exec(text);
            expect(found, name).not.toBeNull();
            return (found as RegExpExecArray)[1] as string;
        };
        // The generator's copy of the removal pattern has no g flag, so compare the character class alone.
        expect(literal(generatorSource, 'REMOVED_BY_THE_GUARD').replace(/\/u$/u, '/gu')).toBe(literal(guardSource, 'INVISIBLE'));
        const constants = { MIN_KEYWORD_LENGTH, MAX_KEYWORD_LENGTH, MAX_KEYWORDS, MAX_RAW_KEYWORD_UNITS, MAX_CANDIDATES, MAX_BARE_STRING_UNITS, MAX_NORMALISE_PASSES, MAX_TOTAL_RAW_UNITS };
        expect(literal(guardSource, 'COMBINING_RUN_TOO_LONG'), 'the pattern is MAX_COMBINING_RUN + 1 marks').toBe(`/\\p{M}{${MAX_COMBINING_RUN + 1}}/u`);
        for (const file of TEMPLATE_FILES) {
            const code = byName(load(file), 'Build run input').parameters.jsCode as string;
            for (const [name, value] of Object.entries(constants)) expect(code, `${file}: ${name}`).toContain(`const ${name} = ${value};`);
            for (const name of ['WHITESPACE_CONTROLS', 'INVISIBLE', 'WHITESPACE_RUN', 'LONE_SURROGATE', 'COMBINING_RUN_TOO_LONG', 'HAS_LETTER_OR_DIGIT', 'BARE_STRING_SEPARATORS']) {
                expect(literal(code, name), `${file}: ${name}`).toBe(literal(guardSource, name));
            }
        }
    });
});

describe('distribution documentation and packaging', () => {
    const readme = read('distribution/README.md');

    it('states plainly that the templates are validated statically only and that nothing ran against Apify', () => {
        expect(readme).toMatch(/statically validated only/iu);
        expect(readme).toMatch(/never been imported into n8n/iu);
        expect(readme).toMatch(/nothing here has been run against the Apify platform/iu);
        expect(readme).toMatch(/not yet published/iu);
    });

    it('documents install, the three entry points, the safety model and regeneration', () => {
        for (const heading of ['## Install', '## Quick start', '### Python SDK', '### LangChain', '### n8n', '## Safety model', '## What is NOT verified', '## Regenerating the data files']) {
            expect(readme, heading).toContain(heading);
        }
        expect(readme).toContain('npx tsx scripts/generate_distribution_data.ts');
        expect(readme).toContain('Apify API token');
        for (const file of TEMPLATE_FILES) expect(readme, file).toContain(file);
        for (const engine of ENGINES) expect(readme, engine.slug).toContain(engine.slug);
    });

    it('describes the polling loop, the shipped cap and the default sources of every template as they are', async () => {
        for (const file of TEMPLATE_FILES) {
            const workflow = load(file);
            const wait = byName(workflow, 'Wait before polling').parameters;
            const polls = /\$runIndex < (\d+)/u.exec(byName(workflow, 'Run still going?').parameters.conditions.conditions[0].leftValue as string)?.[1];
            const cap = (byName(workflow, 'Start Apify run').parameters.queryParameters.parameters as Array<{ name: string; value: string }>)[0]?.value;
            expect(readme, `${file}: the wait`).toContain(`waits a fixed ${wait.amount} ${wait.unit}`);
            expect(readme, `${file}: the poll cap`).toContain(`fewer than ${polls} polls`);
            expect(readme, `${file}: the shipped cap`).toContain(`ship with \`${cap}\``);
            const sources = (await runCodeNode(workflow, {}))[0].json.input.sources as string[];
            const row = readme.split('\n').find((line) => line.includes(`\`${file}\``) && line.includes('|'));
            expect(row, file).toBeDefined();
            for (const source of sources) expect(row, `${file}: default source ${source}`).toContain(`\`${source}\``);
        }
    });

    it('documents the guard as it is: every rejection reason, every cap, the removed characters and the Unicode version skew', () => {
        for (const reason of ['not_a_string', 'empty_after_normalisation', 'too_short', 'too_long', 'invalid_unicode', 'no_letter_or_digit', 'duplicate', 'over_limit']) {
            expect(readme, reason).toContain(`\`${reason}\``);
        }
        const caps = { 'raw keyword cap': MAX_RAW_KEYWORD_UNITS, 'candidate cap': MAX_CANDIDATES, 'bare-string cut': MAX_BARE_STRING_UNITS, 'haystack window': MAX_HAYSTACK_UNITS, 'cleaning passes': MAX_NORMALISE_PASSES, 'combining marks in a row': MAX_COMBINING_RUN, 'total raw units': MAX_TOTAL_RAW_UNITS };
        for (const [what, value] of Object.entries(caps)) expect(readme, what).toContain(`\`${value}\``);
        expect(readme).toContain('Default_Ignorable_Code_Point');
        expect(readme).toContain('Bidi_Control');
        expect(readme).toContain('White_Space');
        expect(readme, 'the dropped last piece of a cut bare string').toContain('its last entry was dropped');
        expect(readme).toMatch(/Unicode 16\.0/u);
        expect(readme, 'the guard is idempotent now; the old two-pass workaround is gone').not.toMatch(/not idempotent|settle_keyword_list|cleans until nothing changes/iu);
    });

    it('packages a src-layout, pip-installable regulatory-engines with the data file and a pinned apify-client range', () => {
        const pyproject = read('distribution/python/pyproject.toml');
        expect(pyproject).toMatch(/^name = "regulatory-engines"$/mu);
        expect(pyproject).toContain('packages = ["src/regulatory_engines"]');
        expect(pyproject).toMatch(/"apify-client>=3\.3,<4"/u);
        expect(pyproject).toMatch(/^langchain = \["langchain-core/mu);
        expect(statSync(`${ROOT}distribution/python/src/regulatory_engines/__init__.py`).isFile()).toBe(true);
        expect(statSync(`${ROOT}distribution/python/src/regulatory_engines/data/engines.json`).isFile()).toBe(true);
        expect(statSync(`${ROOT}distribution/python/src/regulatory_engines/py.typed`).isFile()).toBe(true);
    });

    it('ignores Python build artefacts', () => {
        const ignore = read('distribution/python/.gitignore').split('\n');
        for (const entry of ['__pycache__/', '*.egg-info/', 'build/', 'dist/', '.pytest_cache/', '.venv/']) expect(ignore).toContain(entry);
    });
});
