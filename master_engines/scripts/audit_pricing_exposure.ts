/**
 * Independent pricing-exposure audit. Prints deterministic Markdown tables to stdout:
 *
 *   npx tsx scripts/audit_pricing_exposure.ts
 *
 * Inputs (all read as plain committed files except the two registries, which are the thing being audited):
 *   - pricing/payloads/<engine>.put.json     prices (raw decimal literals, so no float ever enters the arithmetic);
 *   - <engine>/.actor/actor.json             pinned memory, hence the number of start events per run;
 *   - <engine>/.actor/input_schema.json      default per-run watchlist-hit caps;
 *   - pricing/event_catalog.ts               price basis (legacy-readme / provisional / operator-stated) only;
 *   - the engine registries                  which active source bills which event.
 *
 * Every amount is an integer number of micro-USD (BigInt) and is rendered as USD with exactly 6 decimals.
 * It never calls pricing/build_put_payloads.ts or scripts/actor_files.ts. It exits non-zero when the committed
 * payload disagrees with the catalog or the registries, because an exposure table built on drifted prices is worthless.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import type { EngineDefinition } from '../lib/router_core.js';
import type { Connector } from '../lib/types.js';
import { ALL_PRICING, type EnginePricing, type PriceBasis, RECORD_LEVEL_EVENTS } from '../pricing/event_catalog.js';

const MICRO_PER_USD = 1_000_000n;
const START_EVENT = 'apify-actor-start';
const HIT_EVENT = 'watchlist-hit';
/** Rows of the reference run, and the checkpoint window the delivery journal replaced. */
export const REFERENCE_ROWS = 1000n;
export const OLD_CHECKPOINT_WINDOW = 25n;
const MB_PER_GB = 1024n;

const ENGINES: readonly EngineDefinition[] = [regtechEngine, tendersEngine, patentsEngine];

export interface EventExposure {
    name: string;
    priceMicro: bigint;
    basis: PriceBasis | 'platform';
    sources: string[];
    billedWhen: string;
}

export interface EngineExposure {
    slug: string;
    memoryMbytes: number;
    startEvents: bigint;
    startPriceMicro: bigint;
    emptyRunMicro: bigint;
    events: EventExposure[];
    dearestEvent: EventExposure;
    hitMicro: bigint;
    rowWorstMicro: bigint;
    run1000UncappedMicro: bigint;
    hitCap: bigint;
    spendCapMicro: bigint;
    effectiveHits: bigint;
    run1000CappedMicro: bigint;
    killDoubleBillMicro: bigint;
    oldWindowDoubleBillMicro: bigint;
    committedFloorMicro: bigint;
    matchedRowBudgetMicro: bigint;
}

/** Exact decimal literal -> micro-USD. Rejects exponent notation, signs and more than 6 decimals. */
export function decimalToMicro(literal: string): bigint {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(literal);
    if (!m) throw new Error(`Price literal "${literal}" is not a plain decimal with at most 6 decimals.`);
    return BigInt(m[1] ?? '0') * MICRO_PER_USD + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

export function formatUsd(micro: bigint): string {
    const negative = micro < 0n;
    const abs = negative ? -micro : micro;
    return `${negative ? '-' : ''}${abs / MICRO_PER_USD}.${(abs % MICRO_PER_USD).toString().padStart(6, '0')}`;
}

/** `Math.round(x * 1e6)` for an already parsed JSON number (used only for the two input_schema caps). */
function numberToMicro(value: number): bigint {
    return BigInt(Math.round(value * 1e6));
}

/** Own copy of the delta-class fallback: first_seen -> new, updated -> updated ?? new, unchanged -> snapshot ?? updated ?? new. */
function billedEvents(connector: Connector<any>): string[] {
    const b = connector.billing;
    const base = b?.newEvent ?? 'result';
    const updated = b?.updatedEvent ?? base;
    const unchanged = b?.snapshotEvent ?? b?.updatedEvent ?? base;
    return [...new Set([base, updated, unchanged])];
}

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8'));
}

/** Every `"eventPriceUsd": <literal>` of a payload, in file order, as raw text. */
function priceLiterals(text: string): string[] {
    return [...text.matchAll(/"eventPriceUsd":\s*([^,\s}]+)/gu)].map((m) => m[1] ?? '');
}

interface PayloadEvent {
    eventTitle: string;
    isPrimaryEvent?: boolean;
}

interface PayloadFacts {
    prices: Map<string, bigint>;
    floorMicro: bigint;
}

async function readPayload(root: string, slug: string): Promise<PayloadFacts> {
    const path = join(root, 'pricing', 'payloads', `${slug}.put.json`);
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as { pricingInfos: Array<{ pricingPerEvent: { actorChargeEvents: Record<string, PayloadEvent> } }> };
    const record = parsed.pricingInfos[0];
    if (!record || parsed.pricingInfos.length !== 1) throw new Error(`${slug}: the payload must hold exactly one pricing record.`);
    const names = Object.keys(record.pricingPerEvent.actorChargeEvents);
    const literals = priceLiterals(text);
    if (names.length !== literals.length) throw new Error(`${slug}: ${names.length} events but ${literals.length} price literals.`);
    const floorLiteral = /"minimalMaxTotalChargeUsd":\s*([^,\s}]+)/u.exec(text)?.[1];
    if (floorLiteral === undefined) throw new Error(`${slug}: minimalMaxTotalChargeUsd is missing.`);
    return { prices: new Map(names.map((name, i) => [name, decimalToMicro(literals[i] ?? '')])), floorMicro: decimalToMicro(floorLiteral) };
}

async function readMemoryMbytes(root: string, slug: string): Promise<number> {
    const actor = (await readJson(join(root, slug, '.actor', 'actor.json'))) as { minMemoryMbytes?: unknown; maxMemoryMbytes?: unknown };
    if (typeof actor.minMemoryMbytes !== 'number' || actor.minMemoryMbytes !== actor.maxMemoryMbytes) {
        throw new Error(`${slug}: actor.json must pin the memory (minMemoryMbytes === maxMemoryMbytes).`);
    }
    return actor.minMemoryMbytes;
}

async function readDefaultHitCaps(root: string, slug: string): Promise<{ hits: bigint; spendMicro: bigint }> {
    const schema = (await readJson(join(root, slug, '.actor', 'input_schema.json'))) as { properties: Record<string, { default?: unknown }> };
    const hits = schema.properties.maxWatchlistHitsPerRun?.default;
    const spend = schema.properties.maxWatchlistSpendUsd?.default;
    if (typeof hits !== 'number' || !Number.isInteger(hits) || typeof spend !== 'number') throw new Error(`${slug}: the watchlist-hit cap defaults are missing from input_schema.json.`);
    return { hits: BigInt(hits), spendMicro: numberToMicro(spend) };
}

/** Ids of the active connectors of `slug` whose source file sets `billingEvent: <something that resolves to event>`. */
async function recordLevelSources(root: string, engine: EngineDefinition, event: string): Promise<string[]> {
    const dir = join(root, engine.slug, 'connectors');
    const activeIds = new Set(engine.connectors.filter((c) => c.status === 'active').map((c) => c.id));
    const found: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort()) {
        const text = await readFile(join(dir, file), 'utf8');
        if (!text.includes('billingEvent:') || !text.includes(`'${event}'`)) continue;
        const declared = /^ {4}id: (?:'([a-z0-9_]+)'|([A-Z][A-Z0-9_]*)),/mu.exec(text);
        const id = declared?.[1] ?? (declared?.[2] === undefined ? undefined : new RegExp(`const ${declared[2]} = '([a-z0-9_]+)'`, 'u').exec(text)?.[1]);
        if (id !== undefined && activeIds.has(id)) found.push(id);
    }
    return found;
}

function catalogFor(slug: string): EnginePricing {
    const pricing = ALL_PRICING.find((p) => p.engine === slug);
    if (!pricing) throw new Error(`No catalog for ${slug}.`);
    return pricing;
}

export async function collectEngineExposure(root: string, engine: EngineDefinition): Promise<EngineExposure> {
    const slug = engine.slug;
    const catalog = catalogFor(slug);
    const { prices: payloadPrices, floorMicro: committedFloorMicro } = await readPayload(root, slug);
    const memoryMbytes = await readMemoryMbytes(root, slug);
    const caps = await readDefaultHitCaps(root, slug);

    const startPriceMicro = payloadPrices.get(START_EVENT);
    const hitMicro = payloadPrices.get(HIT_EVENT);
    if (startPriceMicro === undefined || hitMicro === undefined) throw new Error(`${slug}: ${START_EVENT} and ${HIT_EVENT} must both be priced.`);

    // Payload vs catalog: the committed artifact must carry exactly the catalog's prices.
    for (const event of catalog.events) {
        const committed = payloadPrices.get(event.name);
        const expected = BigInt(Math.round(event.priceUsd * 1e6));
        if (committed !== expected) throw new Error(`${slug}: ${event.name} is ${committed === undefined ? 'missing' : formatUsd(committed)} in the payload but ${formatUsd(expected)} in the catalog.`);
    }
    if (payloadPrices.size !== catalog.events.length + 1) throw new Error(`${slug}: the payload prices ${payloadPrices.size} events, the catalog ${catalog.events.length} plus the start event.`);

    // Which active source bills which event (own derivation from the registry).
    const sourcesByEvent = new Map<string, string[]>();
    for (const connector of engine.connectors.filter((c) => c.status === 'active')) {
        for (const event of billedEvents(connector)) sourcesByEvent.set(event, [...(sourcesByEvent.get(event) ?? []), connector.id]);
    }
    const recordLevel = new Map<string, string[]>();
    for (const event of RECORD_LEVEL_EVENTS[slug]) {
        const sources = await recordLevelSources(root, engine, event);
        recordLevel.set(event, sources);
        for (const id of sources) if (!(sourcesByEvent.get(event) ?? []).includes(id)) sourcesByEvent.set(event, [...(sourcesByEvent.get(event) ?? []), id]);
    }
    if (sourcesByEvent.has('result')) throw new Error(`${slug}: a connector falls back to the unpriced "result" event (rows would be free).`);

    const events: EventExposure[] = [
        { name: START_EVENT, priceMicro: startPriceMicro, basis: 'platform', sources: [], billedWhen: 'every run, once per GB of memory' },
    ];
    for (const event of catalog.events) {
        const priceMicro = payloadPrices.get(event.name) ?? 0n;
        if (event.name === HIT_EVENT) {
            events.push({ name: event.name, priceMicro, basis: event.basis, sources: [], billedWhen: 'any delivered row whose text matches a watchlist keyword (after the journal write)' });
            continue;
        }
        const sources = sourcesByEvent.get(event.name) ?? [];
        if (sources.length === 0) throw new Error(`${slug}: event ${event.name} is priced but no active source bills it.`);
        const recordOnly = recordLevel.has(event.name) && !engine.connectors.some((c) => c.status === 'active' && billedEvents(c).includes(event.name));
        events.push({
            name: event.name,
            priceMicro,
            basis: event.basis,
            sources: [...sources],
            billedWhen: recordOnly ? 'record-level override: row delivered from the listing without a detail fetch' : 'delivered row, by delta class',
        });
    }

    const rowEvents = events.filter((e) => e.name !== START_EVENT && e.name !== HIT_EVENT);
    const dearestEvent = rowEvents.reduce((best, e) => (e.priceMicro > best.priceMicro ? e : best));
    const startEvents = ((BigInt(memoryMbytes) + MB_PER_GB - 1n) / MB_PER_GB) || 1n;
    const emptyRunMicro = startPriceMicro * startEvents;
    const rowWorstMicro = dearestEvent.priceMicro + hitMicro;
    const run1000UncappedMicro = emptyRunMicro + REFERENCE_ROWS * rowWorstMicro;
    const spendBoundHits = caps.spendMicro / hitMicro;
    const effectiveHits = [REFERENCE_ROWS, caps.hits, spendBoundHits].reduce((a, b) => (b < a ? b : a));
    const run1000CappedMicro = emptyRunMicro + REFERENCE_ROWS * dearestEvent.priceMicro + effectiveHits * hitMicro;

    return {
        slug,
        memoryMbytes,
        startEvents,
        startPriceMicro,
        emptyRunMicro,
        events,
        dearestEvent,
        hitMicro,
        rowWorstMicro,
        run1000UncappedMicro,
        hitCap: caps.hits,
        spendCapMicro: caps.spendMicro,
        effectiveHits,
        run1000CappedMicro,
        // With the delivery journal a kill can repeat only the ROW in flight: the watchlist-hit is charged after the journal write.
        killDoubleBillMicro: dearestEvent.priceMicro,
        // Before the journal the hit was charged before the checkpoint, so a kill repeated rows AND their hits.
        oldWindowDoubleBillMicro: OLD_CHECKPOINT_WINDOW * rowWorstMicro,
        committedFloorMicro,
        matchedRowBudgetMicro: emptyRunMicro + rowWorstMicro,
    };
}

export async function collectExposure(root: string): Promise<EngineExposure[]> {
    const out: EngineExposure[] = [];
    for (const engine of ENGINES) out.push(await collectEngineExposure(root, engine));
    return out;
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

export function renderReport(report: readonly EngineExposure[]): string {
    const lines: string[] = [];
    lines.push('# Pricing exposure audit', '');
    lines.push(
        'Prices come from the committed `pricing/payloads/*.put.json` literals, memory from `.actor/actor.json`, default hit caps from `.actor/input_schema.json`. All arithmetic is integer micro-USD; amounts are shown as USD with 6 decimals.',
        '',
    );

    for (const e of report) {
        lines.push(`## ${e.slug}`, '');
        lines.push(`Memory ${e.memoryMbytes} MB (pinned) = ${e.startEvents} start event(s) per run.`, '');
        lines.push(row(['Event', 'Price (USD)', 'Basis', 'Billed by']), row(['---', '---:', '---', '---']));
        for (const ev of e.events) {
            const who = ev.sources.length > 0 ? `${ev.sources.join(', ')} (${ev.billedWhen})` : ev.billedWhen;
            lines.push(row([`\`${ev.name}\``, formatUsd(ev.priceMicro), ev.basis, who]));
        }
        lines.push('');
        lines.push(row(['Figure', 'USD', 'Derivation']), row(['---', '---:', '---']));
        lines.push(row(['Start cost of an empty run', formatUsd(e.emptyRunMicro), `${formatUsd(e.startPriceMicro)} x ${e.startEvents} GB`]));
        lines.push(row(['Dearest source event', formatUsd(e.dearestEvent.priceMicro), `\`${e.dearestEvent.name}\` (${e.dearestEvent.sources.join(', ')})`]));
        lines.push(row(['Worst-case cost of one delivered row', formatUsd(e.rowWorstMicro), `${formatUsd(e.dearestEvent.priceMicro)} + watchlist-hit ${formatUsd(e.hitMicro)}`]));
        lines.push(
            row([
                `Worst-case ${REFERENCE_ROWS}-row run, every row a hit (no caps)`,
                formatUsd(e.run1000UncappedMicro),
                `${formatUsd(e.emptyRunMicro)} + ${REFERENCE_ROWS} x ${formatUsd(e.rowWorstMicro)}`,
            ]),
        );
        lines.push(
            row([
                `Worst-case ${REFERENCE_ROWS}-row run under the default hit caps`,
                formatUsd(e.run1000CappedMicro),
                `${formatUsd(e.emptyRunMicro)} + ${REFERENCE_ROWS} x ${formatUsd(e.dearestEvent.priceMicro)} + ${e.effectiveHits} hits x ${formatUsd(e.hitMicro)} (caps: ${e.hitCap} hits, ${formatUsd(e.spendCapMicro)} spend)`,
            ]),
        );
        lines.push(row(['Worst-case double bill from ONE hard kill (delivery journal)', formatUsd(e.killDoubleBillMicro), 'one row in flight: the dearest row event only (the hit is charged after the journal write, so a kill cannot repeat it)']));
        lines.push(row([`Same kill with the old ${OLD_CHECKPOINT_WINDOW}-row checkpoint window`, formatUsd(e.oldWindowDoubleBillMicro), `${OLD_CHECKPOINT_WINDOW} x ${formatUsd(e.rowWorstMicro)} (row + hit)`]));
        lines.push(row(['Committed minimalMaxTotalChargeUsd', formatUsd(e.committedFloorMicro), 'pricing/payloads put.json']));
        lines.push(row(['Budget for the start events plus one matched row', formatUsd(e.matchedRowBudgetMicro), `${formatUsd(e.emptyRunMicro)} + ${formatUsd(e.rowWorstMicro)}`]));
        lines.push('');
    }

    lines.push('## Summary', '');
    lines.push(
        row(['Engine', 'Empty run', 'One row (worst)', `${REFERENCE_ROWS} rows (no caps)`, `${REFERENCE_ROWS} rows (default caps)`, 'One kill (journal)', `One kill (old ${OLD_CHECKPOINT_WINDOW}-row window)`]),
        row(['---', '---:', '---:', '---:', '---:', '---:', '---:']),
    );
    for (const e of report) {
        lines.push(row([e.slug, formatUsd(e.emptyRunMicro), formatUsd(e.rowWorstMicro), formatUsd(e.run1000UncappedMicro), formatUsd(e.run1000CappedMicro), formatUsd(e.killDoubleBillMicro), formatUsd(e.oldWindowDoubleBillMicro)]));
    }
    lines.push('');

    const basisCount = (engine: string, basis: PriceBasis): number => catalogFor(engine).events.filter((ev) => ev.basis === basis).length;
    lines.push('## Price basis', '');
    lines.push(row(['Engine', 'legacy-readme', 'provisional', 'operator-stated']), row(['---', '---:', '---:', '---:']));
    const totals: Record<PriceBasis, number> = { 'legacy-readme': 0, provisional: 0, 'operator-stated': 0 };
    for (const e of report) {
        const counts = { 'legacy-readme': basisCount(e.slug, 'legacy-readme'), provisional: basisCount(e.slug, 'provisional'), 'operator-stated': basisCount(e.slug, 'operator-stated') };
        for (const key of Object.keys(totals) as PriceBasis[]) totals[key] += counts[key];
        lines.push(row([e.slug, String(counts['legacy-readme']), String(counts.provisional), String(counts['operator-stated'])]));
    }
    lines.push(row(['**all engines**', String(totals['legacy-readme']), String(totals.provisional), String(totals['operator-stated'])]), '');

    lines.push('## Notes', '');
    lines.push(`- The one-kill figure is exact, not a bound: the router charges a watchlist-hit only after the row is journaled, so a kill can repeat only the row event in flight (the hit it would have triggered was never charged; the repeated run charges it once). The one-kill figure assumes the dearest source event.`);
    lines.push(`- Start events: memory above ${MB_PER_GB} MB is charged once per started GB, as documented by Apify; the Actor memory is pinned so the figure is exact.`);
    lines.push('- The platform per-run charge limit (maxTotalChargeUsd) set by the caller caps every run-level figure above.');
    lines.push('');
    return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    try {
        process.stdout.write(renderReport(await collectExposure(root)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
