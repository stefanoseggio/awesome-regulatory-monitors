/**
 * Shared test plumbing for the tenders-b connectors (eu_ted, us_florida, au_grantconnect, world_bank_notices,
 * it_lombardia_grants). Not a test file (vitest only collects *.test.ts). No network: every connector test injects a
 * stub `ctx.http`, and the end-to-end tests drive the REAL router (`runEngine`) with in-memory sinks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, HttpRequestInit, RunSummary } from '../lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Reads a fixture from test/fixtures/tenders-b/. */
export function fixture(name: string): string {
    return readFileSync(join(here, 'fixtures', 'tenders-b', name), 'utf-8');
}

export function jsonFixture<T = unknown>(name: string): T {
    return JSON.parse(fixture(name)) as T;
}

export interface RecordedRequest {
    method: string;
    url: string;
    /** The parsed JSON request body for a POST, `undefined` for a GET. */
    body: unknown;
    /** Header names lower-cased. */
    headers: Record<string, string>;
    via: 'getJson' | 'getText';
}

/** What a responder may return: a value (served as the response), an Error (thrown), or a promise of either. */
export type Responder = (request: RecordedRequest) => unknown;

export interface StubContext {
    ctx: ConnectorContext;
    requests: RecordedRequest[];
    logs: { info: string[]; warning: string[]; error: string[]; debug: string[] };
}

function toRequest(via: RecordedRequest['via'], url: string, init: HttpRequestInit | undefined): RecordedRequest {
    let body: unknown;
    if (typeof init?.body === 'string') {
        try {
            body = JSON.parse(init.body);
        } catch {
            body = init.body;
        }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
    return { method: init?.method ?? 'GET', url, body, headers, via };
}

/**
 * A ConnectorContext whose http is served by `responder`. A responder that reaches for an endpoint the test did not
 * declare should return an Error, so a connector that wanders off fails loudly.
 */
export function makeCtx(responder: Responder, now = '2026-10-21T00:00:00Z'): StubContext {
    const requests: RecordedRequest[] = [];
    const logs: StubContext['logs'] = { info: [], warning: [], error: [], debug: [] };
    const serve = async (via: RecordedRequest['via'], url: string, init: HttpRequestInit | undefined): Promise<unknown> => {
        const request = toRequest(via, url, init);
        requests.push(request);
        const result = await responder(request);
        if (result instanceof Error) throw result;
        return result;
    };
    const ctx: ConnectorContext = {
        http: {
            async getText(url, init) {
                const result = await serve('getText', url, init);
                return typeof result === 'string' ? result : JSON.stringify(result);
            },
            async getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T> {
                return (await serve('getJson', url, init)) as T;
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
    return { ctx, requests, logs };
}

/** Exact-key router for simple cases: `"GET <url>"` / `"POST <url>"` -> value | Error | thunk. An unrouted request yields an Error. */
export function routes(table: Record<string, unknown>): Responder {
    return (request) => {
        const key = `${request.method} ${request.url}`;
        if (!(key in table)) return new Error(`unrouted request in test: ${key}`);
        const value = table[key];
        return typeof value === 'function' ? (value as () => unknown)() : value;
    };
}

export interface EndToEnd {
    rows: Array<Record<string, unknown>>;
    summary: RunSummary;
    billing: FakeBilling;
    store: InMemoryDeltaStore;
}

/**
 * Runs `connector` through the real router (preflight, fetch isolation, delta, watchlist guard, billing) with an
 * in-memory sink. Pass the same `store` to simulate a second scheduled run.
 */
export async function runThroughRouter(
    connector: Connector<any>,
    input: Record<string, unknown>,
    stub: StubContext,
    store: InMemoryDeltaStore = new InMemoryDeltaStore(),
    prices: Record<string, number> = { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 },
    clock = '2026-10-21T00:00:00Z',
): Promise<EndToEnd> {
    const engine: EngineDefinition = { slug: 'latam-global-tender-intelligence', connectors: [connector] };
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
    const summary = await runEngine(engine, input, { sinks, ctx: stub.ctx, clock: () => new Date(clock) });
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

/** Legacy delta-engine keys that the router replaced; a connector payload must not carry them. */
export const LEGACY_DELTA_KEYS = ['event_id', 'event_type', 'changed_fields', 'previousVersion', 'previousStatus'] as const;
