/**
 * The unit-economics script (scripts/audit_unit_economics.ts) is arithmetic that ends up in the audit report, so it is
 * checked against hand-derived values and against an independent re-computation with exact rational arithmetic.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { breakEvenSeconds, DEFAULT_COMPUTE_RATES, marginToPpm, netRevenueMicro, renderEconomics, scenariosFor, usdToMicro } from '../scripts/audit_unit_economics.js';
import { collectExposure } from '../scripts/audit_pricing_exposure.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('usdToMicro and marginToPpm', () => {
    it('parse exact decimals and nothing else', () => {
        expect(usdToMicro('0.005')).toBe(5_000n);
        expect(usdToMicro('0.25')).toBe(250_000n);
        expect(usdToMicro('1')).toBe(1_000_000n);
        expect(usdToMicro('0.000001')).toBe(1n);
        for (const bad of ['1e-3', '-1', '0.0000001', '', '.5', '1.', ' 1', 'NaN', '0x10']) expect(() => usdToMicro(bad), bad).toThrow();
    });

    it('turn the payload margin into integer parts per million and reject values outside 0..1', () => {
        expect(marginToPpm(0.2)).toBe(200_000n);
        expect(marginToPpm(0)).toBe(0n);
        expect(marginToPpm(1)).toBe(1_000_000n);
        expect(() => marginToPpm(1.5)).toThrow();
        expect(() => marginToPpm(-0.1)).toThrow();
        expect(() => marginToPpm(Number.NaN)).toThrow();
    });
});

describe('netRevenueMicro and breakEvenSeconds', () => {
    it('match the values derived by hand', () => {
        // empty regtech run: 2 start events at 0.005, 20 percent margin -> 0.008
        expect(netRevenueMicro(5_000n, 2n, 0n, 0n, 200_000n)).toBe(8_000n);
        // 1,000 rows at 0.0005 on top of one start event of 0.005, 20 percent margin -> 0.8 x 0.505 = 0.404
        expect(netRevenueMicro(5_000n, 1n, 1_000n, 500n, 200_000n)).toBe(404_000n);
        // 0.008 USD at 2 GB and 0.25 USD per GB-hour: 0.008 / 0.5 = 0.016 h = 57.6 s, rounded down
        expect(breakEvenSeconds(8_000n, 2048, 250_000n)).toBe(57n);
        // 1 GB at 0.36 USD per GB-hour costs 0.0001 USD per second: 0.004 USD lasts exactly 40 s
        expect(breakEvenSeconds(4_000n, 1024, 360_000n)).toBe(40n);
    });

    it('rejects a compute rate of zero instead of dividing by it', () => {
        expect(() => breakEvenSeconds(1_000n, 1024, 0n)).toThrow(/greater than zero/);
    });

    it('is monotone: a dearer compute rate never lengthens the break-even time, more rows never shorten it', () => {
        const rates = DEFAULT_COMPUTE_RATES.map((r) => usdToMicro(r));
        let previous = Number.POSITIVE_INFINITY;
        for (const rate of rates) {
            const seconds = Number(breakEvenSeconds(404_000n, 1024, rate));
            expect(seconds).toBeLessThanOrEqual(previous);
            previous = seconds;
        }
        expect(breakEvenSeconds(netRevenueMicro(5_000n, 1n, 100n, 500n, 200_000n), 1024, 250_000n)).toBeLessThan(breakEvenSeconds(netRevenueMicro(5_000n, 1n, 1_000n, 500n, 200_000n), 1024, 250_000n));
    });
});

describe('the report', () => {
    it('agrees with an independent rational re-computation for every engine, scenario and rate', async () => {
        const report = await collectExposure(ROOT);
        expect(report).toHaveLength(3);
        for (const e of report) {
            for (const scenario of scenariosFor(e)) {
                for (const rateText of DEFAULT_COMPUTE_RATES) {
                    // Exact rational: net = 4/5 x (start x events + rows x p) ; seconds = net / (GB x rate) x 3600, all in micro-USD
                    const grossMicro = e.startPriceMicro * e.startEvents + scenario.rows * scenario.eventMicro;
                    const netNumerator = grossMicro * 4n; // over 5
                    const rateMicro = usdToMicro(rateText);
                    const denominator = 5n * BigInt(e.memoryMbytes) * rateMicro; // GB = MB / 1024
                    const expectedSeconds = (netNumerator * 3600n * 1024n) / denominator;
                    const net = netRevenueMicro(e.startPriceMicro, e.startEvents, scenario.rows, scenario.eventMicro, 200_000n);
                    // net is rounded half up to a micro-USD, so allow one unit of difference in the derived seconds
                    const actual = breakEvenSeconds(net, e.memoryMbytes, rateMicro);
                    const difference = actual > expectedSeconds ? actual - expectedSeconds : expectedSeconds - actual;
                    expect(difference <= 1n, `${e.slug} ${scenario.label} at ${rateText}: ${actual} vs ${expectedSeconds}`).toBe(true);
                }
            }
        }
    });

    it('is deterministic, covers all three engines, and states that the compute rate is an input and not a measurement', async () => {
        const first = await renderEconomics(ROOT, DEFAULT_COMPUTE_RATES);
        const second = await renderEconomics(ROOT, DEFAULT_COMPUTE_RATES);
        expect(second).toBe(first);
        for (const slug of ['global-regtech-compliance-feed', 'latam-global-tender-intelligence', 'global-corporate-patent-intelligence']) expect(first).toContain(`## ${slug}`);
        expect(first).toContain('SENSITIVITY INPUT');
        expect(first).toContain('no run time here is measured');
        // the figure quoted in docs/apify_portfolio_refactor_strategy_2026.md section 12.4
        expect(first).toMatch(/\| empty run \| 0\.008000 \| 72 s \| 57 s \| 48 s \| 36 s \|/);
    });
});
