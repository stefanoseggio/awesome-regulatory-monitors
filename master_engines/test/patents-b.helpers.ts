/**
 * Shared harness for the patents-b connector tests (clinicaltrials_orange_book, sg_acra). Not a test file (vitest
 * only collects *.test.ts). No test here touches the network: `ctx.http` is a stub that serves fixtures, and every
 * error it throws is the REAL `HttpStatusError` from lib/http.ts so the connectors are exercised against the exact
 * error shape production produces.
 *
 * FIXTURES (test/fixtures/patents-b/) are REAL upstream responses captured on 2026-10-21, one file per request, each
 * the response to the exact URL the connector's own URL builder produces (the builders are exported so a test can
 * route to them). Nothing in that directory is invented or trimmed: ct_* are ClinicalTrials.gov v2 pages
 * (`query.spons="Pfizer"` pageSize=3 and its nextPageToken page; `query.term="ritlecitinib"` since 2026-10-01),
 * ob_* are openFDA Orange Book pages, acra_* are data.gov.sg datastore_search pages of shard W. Anything a test
 * builds by hand is labelled SYNTHETIC at the point of use.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeBilling } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, HttpClient, HttpRequestInit, Logger, RunSummary } from '../lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXED_NOW = new Date('2026-10-21T12:00:00.000Z');

/** Reads a fixture from test/fixtures/patents-b/. */
export function fixture(name: string): string {
    return readFileSync(join(here, 'fixtures', 'patents-b', name), 'utf-8');
}

export function fixtureJson<T = any>(name: string): T {
    return JSON.parse(fixture(name)) as T;
}

export interface LogEntry {
    level: 'info' | 'warning' | 'error' | 'debug';
    message: string;
}

export function createRecordingLogger(): { log: Logger; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const push = (level: LogEntry['level']) => (message: string) => {
        entries.push({ level, message });
    };
    return { log: { info: push('info'), warning: push('warning'), error: push('error'), debug: push('debug') }, entries };
}

export type StubBody = string | Record<string, unknown> | unknown[] | Error;
export type StubRoute = StubBody | ((url: string, init: HttpRequestInit | undefined) => StubBody | Promise<StubBody>);

export interface StubCall {
    url: string;
    init: HttpRequestInit | undefined;
}

/**
 * Exact-URL routes, optionally with a `fallback` for URLs a test wants to serve by pattern. An unrouted URL throws, so
 * a connector can never silently reach for an endpoint or a query the test did not plan.
 */
export function createStubHttp(
    routes: Record<string, StubRoute>,
    fallback?: (url: string, init: HttpRequestInit | undefined) => StubBody | undefined | Promise<StubBody | undefined>,
): { http: HttpClient; calls: StubCall[] } {
    const calls: StubCall[] = [];
    async function resolve(url: string, init: HttpRequestInit | undefined): Promise<StubBody> {
        calls.push({ url, init });
        let route: StubRoute | undefined = routes[url];
        if (route === undefined && fallback) route = await fallback(url, init);
        if (route === undefined) throw new Error(`StubHttp: no route for ${url}`);
        const body = typeof route === 'function' ? await route(url, init) : route;
        if (body instanceof Error) throw body;
        return body;
    }
    const http: HttpClient = {
        async getText(url, init) {
            const body = await resolve(url, init);
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
        async getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T> {
            const body = await resolve(url, init);
            return (typeof body === 'string' ? JSON.parse(body) : body) as T;
        },
    };
    return { http, calls };
}

export function httpError(url: string, status: number, body = ''): HttpStatusError {
    return new HttpStatusError(url, status, body);
}

export function makeCtx(http: HttpClient, now: Date = FIXED_NOW): { ctx: ConnectorContext; logs: LogEntry[] } {
    const { log, entries } = createRecordingLogger();
    return { ctx: { http, log, now: () => now, sleep: async () => undefined }, logs: entries };
}

/** Messages of the log entries at `level`. */
export function logsAt(logs: readonly LogEntry[], level: LogEntry['level']): string[] {
    return logs.filter((entry) => entry.level === level).map((entry) => entry.message);
}

/** Narrowing helper for `noUncheckedIndexedAccess`: fails the test loudly instead of using a non-null assertion. */
export function must<T>(value: T | undefined | null, what = 'value'): T {
    if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
    return value;
}

/** Router-owned keys that a connector payload must never set. */
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

export interface EngineHarness {
    rows: Record<string, unknown>[];
    billing: FakeBilling;
    store: InMemoryDeltaStore;
    summaries: RunSummary[];
    run(input: unknown): Promise<RunSummary>;
}

/**
 * Router harness for the patent engine: every emitted row is recorded AND billed as a `result` event through the same
 * FakeBilling that records `watchlist-hit` charges, so a test can assert exactly what a real run would have invoiced.
 */
export function createEngineHarness(options: {
    connectors: ReadonlyArray<Connector<any>>;
    http: HttpClient;
    prices?: Record<string, number>;
    store?: InMemoryDeltaStore;
}): EngineHarness {
    const rows: Record<string, unknown>[] = [];
    const summaries: RunSummary[] = [];
    const billing = new FakeBilling(true, options.prices ?? { result: 0.05, 'watchlist-hit': 0.15 });
    const store = options.store ?? new InMemoryDeltaStore();
    const sinks: RunSinks = {
        async emit(row) {
            rows.push(row);
            const charged = await billing.charge('result', 1);
            return { emitted: charged.chargedCount > 0, limitReached: charged.eventChargeLimitReached };
        },
        billing,
        store,
        async saveSummary(summary) {
            summaries.push(summary);
        },
    };
    const engine: EngineDefinition = { slug: 'global-corporate-patent-intelligence', connectors: options.connectors };
    const { ctx } = makeCtx(options.http);
    return {
        rows,
        billing,
        store,
        summaries,
        run: (input) => runEngine(engine, input, { sinks, ctx, clock: () => FIXED_NOW }),
    };
}
