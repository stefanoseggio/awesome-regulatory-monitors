/**
 * Shared harness for the regtech-b connector tests: a stub HttpClient (no network, ever), a recording logger,
 * and a router harness (FakeBilling + InMemoryDeltaStore). Errors thrown by the stub are the REAL
 * `HttpStatusError` from lib/http.ts, so the connectors are tested against the exact error shape production uses.
 */
import { FakeBilling } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { type EngineDefinition, type RunSinks, runEngine } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, HttpClient, HttpRequestInit, Logger, RunSummary } from '../lib/types.js';
import { LIVE_ADMIN_HEAD, LIVE_ADMIN_ITEMS, LIVE_ADMIN_TAIL, LIVE_LITIGATION_HEAD, LIVE_LITIGATION_ITEMS, LIVE_LITIGATION_TAIL } from './regtech-b.secFixtures.js';

export const FIXED_NOW = new Date('2026-10-21T12:00:00.000Z');

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

/** Exact-URL routes. An unrouted URL throws, so a test can never silently reach for the network or an unplanned URL. */
export function createStubHttp(routes: Record<string, StubRoute>): { http: HttpClient; calls: StubCall[] } {
    const calls: StubCall[] = [];
    async function resolve(url: string, init: HttpRequestInit | undefined): Promise<StubBody> {
        calls.push({ url, init });
        const route = routes[url];
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
    return { ctx: { http, log, now: () => now }, logs: entries };
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

export const SEC_LITIGATION_URL = 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss';
export const SEC_ADMIN_URL = 'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss';

/** Wraps raw <item> strings in the exact channel header/footer of the live captures. */
export function buildLitigationRss(items: readonly string[] = LIVE_LITIGATION_ITEMS): string {
    return `${LIVE_LITIGATION_HEAD}${items.join('\n')}${LIVE_LITIGATION_TAIL}`;
}

export function buildAdminRss(items: readonly string[] = LIVE_ADMIN_ITEMS): string {
    return `${LIVE_ADMIN_HEAD}${items.join('\n')}${LIVE_ADMIN_TAIL}`;
}

/**
 * SYNTHETIC item (not from SEC). Used only where a test needs a respondent that the live window happened not to
 * contain (for example "ACME CORP." for the watchlist-hit proof). It is shaped exactly like the live items.
 */
export function syntheticLitigationItem(options: { number: string; title: string; pubDate?: string }): string {
    const pubDate = options.pubDate ?? 'Mon, 19 Oct 2026 09:00:00 -0400';
    const slug = options.number.toLowerCase();
    return (
        `<item>\n  <title>${options.title}</title>\n  <link>https://www.sec.gov/enforcement-litigation/litigation-releases/${slug}\n</link>\n` +
        `  <description>${options.title}</description>\n  <pubDate>${pubDate}</pubDate>\n    <dc:creator>${options.number}</dc:creator>\n` +
        `    <guid isPermaLink="false">00000000-0000-4000-8000-${options.number.replace(/\D/gu, '').padStart(12, '0')}</guid>\n    </item>`
    );
}

export interface EngineHarness {
    rows: Record<string, unknown>[];
    billing: FakeBilling;
    store: InMemoryDeltaStore;
    summaries: RunSummary[];
    run(input: unknown): Promise<RunSummary>;
}

/**
 * Router harness: every emitted row is recorded AND billed as a `result` event through the same FakeBilling that
 * records `watchlist-hit` charges, so a test can assert on exactly what a real run would have invoiced.
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
    const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors: options.connectors };
    const { ctx } = makeCtx(options.http);
    return {
        rows,
        billing,
        store,
        summaries,
        run: (input) => runEngine(engine, input, { sinks, ctx, clock: () => FIXED_NOW }),
    };
}
