/**
 * Shared test plumbing for the tenders-a connectors (ar_cordoba, ar_santafe, ar_tucuman, ar_entrerios,
 * cl_diario_oficial, held Argentine portals). Not a test file (vitest only collects *.test.ts).
 *
 * No network: every connector test injects a stub `ctx.http` that serves fixtures, and the end-to-end
 * tests drive the REAL router (`runEngine`) with in-memory sinks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, HttpClient, RunSummary } from '../lib/types.js';
import type { RawHttpCapability, RawRequestInit } from '../latam-global-tender-intelligence/support/portalHttp.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Reads a fixture from test/fixtures/tenders-a/ as text (UTF-8). */
export function fixture(name: string): string {
    return readFileSync(join(here, 'fixtures', 'tenders-a', name), 'utf-8');
}

/** Reads a fixture from test/fixtures/tenders-a/ as raw bytes. */
export function fixtureBytes(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(here, 'fixtures', 'tenders-a', name)));
}

export interface StubResponse {
    body: string | Uint8Array;
    setCookies?: string[];
    status?: number;
}

export interface StubRequest {
    url: string;
    init: RawRequestInit | undefined;
    /** 0-based index of this request across the whole stub. */
    index: number;
}

export type Handled = string | Uint8Array | StubResponse | Error;
export type Handler = (request: StubRequest) => Handled | Promise<Handled>;
export type Routes = Record<string, Handled | ((request: StubRequest) => Handled | Promise<Handled>)>;

export interface StubContext {
    ctx: ConnectorContext;
    /** Every request made through ctx.http (getText or getRaw), in order. */
    calls: StubRequest[];
    logs: { info: string[]; warning: string[]; error: string[]; debug: string[] };
}

export interface StubOptions {
    /** When true, the stub http ALSO implements the optional `getRaw` capability. */
    raw?: boolean;
    now?: string;
}

function normalise(handled: Handled): StubResponse {
    if (typeof handled === 'string' || handled instanceof Uint8Array) return { body: handled };
    return handled as StubResponse;
}

function toBytes(body: string | Uint8Array): Uint8Array {
    return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function toUtf8Text(body: string | Uint8Array): string {
    return typeof body === 'string' ? body : new TextDecoder('utf-8').decode(body);
}

/**
 * A ConnectorContext whose http serves `source`: either a handler function or an exact-URL route map.
 * An unrouted URL throws, so a connector that reaches for an endpoint the test did not declare fails
 * loudly. `getText` mirrors lib/http.ts (the body decoded as UTF-8); `getRaw` exists only with `raw: true`.
 */
export function makeCtx(source: Handler | Routes, options: StubOptions = {}): StubContext {
    const calls: StubRequest[] = [];
    const logs: StubContext['logs'] = { info: [], warning: [], error: [], debug: [] };

    const handler: Handler =
        typeof source === 'function'
            ? source
            : async (request) => {
                  const route = source[request.url];
                  if (route === undefined) throw new Error(`unrouted URL in test: ${request.url}`);
                  return typeof route === 'function' ? route(request) : route;
              };

    async function serve(url: string, init: RawRequestInit | undefined): Promise<StubResponse> {
        const request: StubRequest = { url, init, index: calls.length };
        calls.push(request);
        const handled = await handler(request);
        if (handled instanceof Error) throw handled;
        return normalise(handled);
    }

    const http: HttpClient & Partial<RawHttpCapability> = {
        async getText(url, init) {
            return toUtf8Text((await serve(url, init)).body);
        },
        async getJson() {
            throw new Error('connectors under test must not call getJson');
        },
    };
    if (options.raw) {
        http.getRaw = async (url, init) => {
            const response = await serve(url, init);
            return { status: response.status ?? 200, body: toBytes(response.body), setCookies: response.setCookies ?? [] };
        };
    }

    const ctx: ConnectorContext = {
        http,
        log: {
            info: (m) => logs.info.push(m),
            warning: (m) => logs.warning.push(m),
            error: (m) => logs.error.push(m),
            debug: (m) => logs.debug.push(m),
        },
        now: () => new Date(options.now ?? '2026-10-21T12:00:00Z'),
    };
    return { ctx, calls, logs };
}

export interface EndToEnd {
    rows: Array<Record<string, unknown>>;
    summary: RunSummary;
    billing: FakeBilling;
    store: InMemoryDeltaStore;
}

/**
 * Runs `connector` through the real router (preflight, fetch isolation, delta, watchlist guard,
 * billing) with an in-memory sink. Pass the same `store` to simulate a second scheduled run.
 */
export async function runThroughRouter(
    connector: Connector<any>,
    input: Record<string, unknown>,
    stub: StubContext,
    store: InMemoryDeltaStore = new InMemoryDeltaStore(),
    prices: Record<string, number> = { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 },
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
    const summary = await runEngine(engine, input, { sinks, ctx: stub.ctx, clock: () => new Date('2026-10-21T12:00:00Z') });
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
