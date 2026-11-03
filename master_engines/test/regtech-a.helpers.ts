/**
 * Shared test plumbing for the regtech-a connectors (ofac, world_bank_debarred, uk_modern_slavery).
 * Not a test file (vitest only collects *.test.ts). No network: every connector test injects a stub
 * `ctx.http` that serves fixtures, and the end-to-end tests drive the REAL router (`runEngine`) with
 * in-memory sinks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, RunSummary } from '../lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Reads a fixture from test/fixtures/regtech-a/. */
export function fixture(name: string): string {
    return readFileSync(join(here, 'fixtures', 'regtech-a', name), 'utf-8');
}

export type Route = string | Error | (() => string | Promise<string>);

export interface StubContext {
    ctx: ConnectorContext;
    /** Every URL requested through ctx.http, in order. */
    calls: string[];
    /** Per-request init objects, parallel to `calls`. */
    inits: Array<unknown>;
    logs: { info: string[]; warning: string[]; error: string[]; debug: string[] };
}

/**
 * A ConnectorContext whose http serves `routes` (exact URL -> body | Error | thunk). An unrouted URL
 * throws, so a connector that reaches for an endpoint the test did not declare fails loudly.
 */
export function makeCtx(routes: Record<string, Route>, now = '2026-10-21T00:00:00Z'): StubContext {
    const calls: string[] = [];
    const inits: unknown[] = [];
    const logs: StubContext['logs'] = { info: [], warning: [], error: [], debug: [] };
    const ctx: ConnectorContext = {
        http: {
            async getText(url, init) {
                calls.push(url);
                inits.push(init);
                const route = routes[url];
                if (route === undefined) throw new Error(`unrouted URL in test: ${url}`);
                if (route instanceof Error) throw route;
                return typeof route === 'function' ? route() : route;
            },
            async getJson() {
                throw new Error('connectors under test must not call getJson');
            },
        },
        log: {
            info: (m) => logs.info.push(m),
            warning: (m) => logs.warning.push(m),
            error: (m) => logs.error.push(m),
            debug: (m) => logs.debug.push(m),
        },
        now: () => new Date(now),
    };
    return { ctx, calls, inits, logs };
}

/** Rewrites an SDN.XML excerpt's declared `<Record_Count>` (the excerpts keep the live feed's full count). */
export function withRecordCount(xml: string, count: number): string {
    return xml.replace(/<Record_Count>\d+<\/Record_Count>/, `<Record_Count>${count}</Record_Count>`);
}

export interface EndToEnd {
    rows: Array<Record<string, unknown>>;
    summary: RunSummary;
    billing: FakeBilling;
    store: InMemoryDeltaStore;
}

/**
 * Runs `connector` through the real router (preflight, fetch isolation, delta, watchlist guard, billing)
 * with an in-memory sink. Pass the same `store` to simulate a second scheduled run.
 */
export async function runThroughRouter(
    connector: Connector<any>,
    input: Record<string, unknown>,
    stub: StubContext,
    store: InMemoryDeltaStore = new InMemoryDeltaStore(),
    prices: Record<string, number> = { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 },
): Promise<EndToEnd> {
    const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors: [connector] };
    const billing = new FakeBilling(true, prices);
    const rows: Array<Record<string, unknown>> = [];
    const sinks: RunSinks = {
        async emit(row) {
            const charged = await billing.charge(RESULT_EVENT, 1);
            if (charged.chargedCount < 1) return { emitted: false, limitReached: true };
            rows.push(row);
            return { emitted: true, limitReached: charged.eventChargeLimitReached };
        },
        billing,
        store,
        async saveSummary() {},
    };
    const summary = await runEngine(engine, input, { sinks, ctx: stub.ctx, clock: () => new Date('2026-10-21T00:00:00Z') });
    return { rows, summary, billing, store };
}

/** Keys the router owns; no connector payload may set them. */
export const ROUTER_OWNED_KEYS = [
    'engine',
    'source',
    'record_id',
    'delta_status',
    'is_new',
    'is_watchlist_match',
    'matched_watchlist_keyword',
    'scraped_at',
] as const;
