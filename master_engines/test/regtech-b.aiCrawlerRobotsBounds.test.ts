/**
 * Wall-clock bounds of the robots.txt rule matcher under hostile rules (audit finding F-01, 2026-10-30).
 *
 * The matcher used to turn each rule into a regular expression with one `.*` per `*`. A rule made of thousands of consecutive wildcards then cost time that grew with the
 * square of their number: a single rule of 2,047 wildcards needs about 100 ms against the one-character path `/`, and a hostile file of 260 such rules evaluated for the 18
 * tracked bots needed more than 250 s. The tests that existed (900 pairs of `*a`, 2,000 pairs of `a*`) take about 5 ms with the regular-expression form, so reverting the
 * fix passed all 117 tests of the three ai_crawler files. The cases below are the shape that hurt, with a time bound that the iterative matcher meets by two orders of
 * magnitude. Measured with the regular-expression form put back (2026-11-02, Windows, Node 24): the FILE-LEVEL cases fail by a factor of 400 (20 rules x 18 bots took
 * 21.3 s against the 50 ms bound), so they are the ones that catch the regression decisively; the single-rule cases against `/` fail only narrowly (the first took 58.7 ms,
 * the others stayed under the bound), so on a faster machine they can pass with the old form and are kept as the per-rule bound of the iterative matcher, not as the detector.
 *
 * Time is measured as the BEST of several runs, so that a busy machine delaying one run cannot fail the test; the bound is 50 ms as asked for the event loop.
 */
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TRACKED_BOTS, ROBOTS_MAX_CHARS, evaluateBotPermission, parseRobotsTxt, pathMatches } from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';

const BOUND_MS = 50;
const RUNS = 5;

function bestOfMs(fn: () => unknown, runs = RUNS): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i += 1) {
        const started = performance.now();
        fn();
        best = Math.min(best, performance.now() - started);
    }
    return best;
}

describe('robots.txt matching: hostile rules finish within the event-loop bound', () => {
    const rules: Array<[string, string]> = [
        ['2,047 consecutive wildcards, then x', `${'*'.repeat(2047)}x`],
        ['2,048 consecutive wildcards (the rule length limit)', '*'.repeat(2048)],
        ['a slash and 2,000 consecutive wildcards, then x', `/${'*'.repeat(2000)}x`],
        ['1,000 pairs "/*", then x and the end anchor', `${'/*'.repeat(1000)}x$`],
        ['1,023 pairs "*a", then b', `${'*a'.repeat(1023)}b`],
        ['wildcards between every character of a long literal', `/${Array.from({ length: 600 }, () => 'ab*').join('')}$`],
    ];
    // The path the Actor checks is always the site root (`evaluateBotPermission(parsed, token, path = '/')`). The cases against `/` are the ones that fail first, and finish,
    // when the regular-expression form comes back (about 100 ms for the first rule). They run FIRST.
    for (const [ruleLabel, rule] of rules) {
        it(`${ruleLabel} against the site root /: best of ${RUNS} runs under ${BOUND_MS} ms`, () => {
            const ms = bestOfMs(() => pathMatches(rule, '/'));
            expect(ms, `${ms.toFixed(2)} ms`).toBeLessThan(BOUND_MS);
        });
    }

    // Longer paths are not checked by the Actor today; they bound the matcher itself (pattern length x path length, 2,048 x 2,000 steps at worst). The regular-expression form does
    // not finish on these inputs at all (a run of consecutive wildcards against a long subject has astronomically many splits), so these cases come AFTER the ones above.
    const longPaths: Array<[string, string]> = [
        ['a 2,000-character path of a', `/${'a'.repeat(1999)}`],
        ['a 2,000-character path of /a segments', '/a'.repeat(1000)],
    ];
    for (const [ruleLabel, rule] of rules) {
        for (const [pathLabel, path] of longPaths) {
            it(`${ruleLabel} against ${pathLabel}: best of ${RUNS} runs under ${BOUND_MS} ms`, () => {
                const ms = bestOfMs(() => pathMatches(rule, path));
                expect(ms, `${ms.toFixed(2)} ms`).toBeLessThan(BOUND_MS);
            });
        }
    }

    it('a rule over the 2,048-character limit is refused at once and never matches', () => {
        expect(bestOfMs(() => pathMatches(`${'*'.repeat(20000)}x`, '/'))).toBeLessThan(BOUND_MS);
        expect(pathMatches(`${'*'.repeat(20000)}x`, '/x')).toBe(false);
    });

    it('a hostile file (20 rules of 2,047 consecutive wildcards) evaluated for every tracked bot finishes within the bound', () => {
        const file = `User-agent: *\n${Array.from({ length: 20 }, () => `Disallow: ${'*'.repeat(2047)}x\n`).join('')}`;
        const parsed = parseRobotsTxt(file);
        const bots = [...DEFAULT_TRACKED_BOTS];
        expect(bots.length).toBeGreaterThanOrEqual(10);
        const ms = bestOfMs(() => bots.map((bot) => evaluateBotPermission(parsed, bot, '/')), 3);
        expect(ms, `${ms.toFixed(2)} ms for ${bots.length} bots x 20 rules`).toBeLessThan(BOUND_MS);
        // and the answer is still right: no rule matches "/" (every rule needs an x), so the bots are not restricted by this file
        for (const bot of bots) expect(evaluateBotPermission(parsed, bot, '/').directive).toBe('not_specified');
    });

    it('the largest accepted file (about 512 KiB of 2,047-wildcard rules) is parsed and evaluated within the bound', () => {
        const line = `Disallow: ${'*'.repeat(2037)}x\n`;
        const count = Math.floor(ROBOTS_MAX_CHARS / line.length) - 1;
        const file = `User-agent: *\n${line.repeat(count)}`;
        expect(file.length).toBeLessThanOrEqual(ROBOTS_MAX_CHARS);
        const parsedMs = bestOfMs(() => parseRobotsTxt(file), 3);
        expect(parsedMs, `parse ${file.length} characters: ${parsedMs.toFixed(2)} ms`).toBeLessThan(BOUND_MS);
        const parsed = parseRobotsTxt(file);
        const evaluateMs = bestOfMs(() => evaluateBotPermission(parsed, 'GPTBot', '/'), 3);
        expect(evaluateMs, `${count} rules, one bot: ${evaluateMs.toFixed(2)} ms`).toBeLessThan(BOUND_MS);
    });

    it('text beyond the cap costs nothing: 4 times the cap is parsed within the bound', () => {
        const file = `User-agent: *\n${'Disallow: /x\n'.repeat(Math.ceil((ROBOTS_MAX_CHARS * 4) / 13))}`;
        expect(bestOfMs(() => parseRobotsTxt(file), 3)).toBeLessThan(BOUND_MS);
    });
});
