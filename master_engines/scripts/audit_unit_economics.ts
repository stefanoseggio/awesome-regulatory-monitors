/**
 * Unit economics of one run per engine, as exact arithmetic on the committed pricing. Prints deterministic Markdown:
 *
 *   npx tsx scripts/audit_unit_economics.ts [--compute-rates=0.20,0.25,0.30,0.40]
 *
 * For a run that delivers R rows at one event price p (the marketplace keeps `apifyMarginPercentage` of event revenue,
 * read from the committed payload):
 *
 *   net revenue            = (1 - margin) x (start price x start events + R x p)
 *   compute cost per hour  = memory GB x c        (c = the plan's price per GB-hour of compute: an INPUT, never assumed)
 *   break-even run time    = net revenue / (memory GB x c)
 *
 * A run that lasts longer than its break-even time loses money. The compute rates default to a sensitivity range and
 * MUST be replaced by the account's real rate; nothing here is a measured run time or a measured price of compute.
 * All money is integer micro-USD (BigInt) and the margin is an integer number of parts per million.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectExposure, type EngineExposure, formatUsd } from './audit_pricing_exposure.js';

const MICRO = 1_000_000n;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_COMPUTE_RATES = ['0.20', '0.25', '0.30', '0.40'] as const;
export const ROW_COUNTS = [0n, 10n, 100n, 1000n] as const;

/** Exact decimal literal in USD -> micro-USD. */
export function usdToMicro(literal: string): bigint {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(literal);
    if (!m) throw new Error(`"${literal}" is not a plain USD decimal with at most 6 decimals.`);
    return BigInt(m[1] ?? '0') * MICRO + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

/** `0.2` -> 200000n parts per million, from the raw JSON number text. */
export function marginToPpm(value: number): bigint {
    const ppm = Math.round(value * 1_000_000);
    if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) throw new Error(`apifyMarginPercentage ${value} is outside 0..1.`);
    return BigInt(ppm);
}

/** Net revenue per run in micro-USD (rounded half up). */
export function netRevenueMicro(startMicro: bigint, startEvents: bigint, rows: bigint, eventMicro: bigint, marginPpm: bigint): bigint {
    const gross = startMicro * startEvents + rows * eventMicro;
    return (gross * (1_000_000n - marginPpm) + 500_000n) / 1_000_000n;
}

/** Seconds a run may last before the compute it burns costs more than its net revenue; rounded down. */
export function breakEvenSeconds(netMicro: bigint, memoryMbytes: number, rateMicroPerGbHour: bigint): bigint {
    const costMicroPerHour = (BigInt(memoryMbytes) * rateMicroPerGbHour) / 1024n;
    if (costMicroPerHour === 0n) throw new Error('The compute rate must be greater than zero.');
    return (netMicro * 3600n) / costMicroPerHour;
}

export interface EconomicsScenario {
    label: string;
    rows: bigint;
    eventMicro: bigint;
}

export function scenariosFor(e: EngineExposure): EconomicsScenario[] {
    const rowEvents = e.events.filter((event) => event.name !== 'apify-actor-start' && event.name !== 'watchlist-hit');
    const cheapest = rowEvents.reduce((a, b) => (b.priceMicro < a.priceMicro ? b : a));
    const dearest = rowEvents.reduce((a, b) => (b.priceMicro > a.priceMicro ? b : a));
    const out: EconomicsScenario[] = [];
    for (const rows of ROW_COUNTS) {
        if (rows === 0n) {
            out.push({ label: 'empty run', rows, eventMicro: 0n });
            continue;
        }
        out.push({ label: `${rows} rows at ${cheapest.name} (${formatUsd(cheapest.priceMicro)})`, rows, eventMicro: cheapest.priceMicro });
        if (dearest.name !== cheapest.name) out.push({ label: `${rows} rows at ${dearest.name} (${formatUsd(dearest.priceMicro)})`, rows, eventMicro: dearest.priceMicro });
    }
    return out;
}

export async function renderEconomics(root: string, rates: readonly string[]): Promise<string> {
    const report = await collectExposure(root);
    const lines: string[] = [];
    lines.push('# Unit economics per run', '');
    lines.push('Break-even run time = net revenue / (memory GB x compute rate per GB-hour). Net revenue = (1 - marketplace margin) x (start events x start price + rows x event price), watchlist hits excluded (they are the operator-stated, upside-only event).');
    lines.push(`Compute rates are a SENSITIVITY INPUT (USD per GB-hour): ${rates.join(', ')}. Replace them with the account's plan rate; no run time here is measured.`, '');
    for (const e of report) {
        const payload = JSON.parse(await readFile(join(root, 'pricing', 'payloads', `${e.slug}.put.json`), 'utf8')) as { pricingInfos: Array<{ apifyMarginPercentage: number }> };
        const margin = marginToPpm(payload.pricingInfos[0]?.apifyMarginPercentage ?? Number.NaN);
        lines.push(`## ${e.slug}`, '');
        lines.push(`Memory ${e.memoryMbytes} MB, ${e.startEvents} start event(s) at ${formatUsd(e.startPriceMicro)}, marketplace margin ${Number(margin) / 10_000} percent.`, '');
        lines.push(`| Scenario | Net revenue (USD) | ${rates.map((r) => `Break-even at ${r}/GB-h`).join(' | ')} |`);
        lines.push(`| --- | ---: | ${rates.map(() => '---:').join(' | ')} |`);
        for (const scenario of scenariosFor(e)) {
            const net = netRevenueMicro(e.startPriceMicro, e.startEvents, scenario.rows, scenario.eventMicro, margin);
            const cells = rates.map((r) => `${breakEvenSeconds(net, e.memoryMbytes, usdToMicro(r))} s`);
            lines.push(`| ${scenario.label} | ${formatUsd(net)} | ${cells.join(' | ')} |`);
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
    const flag = process.argv.find((arg) => arg.startsWith('--compute-rates='));
    const rates = flag ? flag.slice('--compute-rates='.length).split(',') : [...DEFAULT_COMPUTE_RATES];
    process.stdout.write(await renderEconomics(ROOT, rates));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
