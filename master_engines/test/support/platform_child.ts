/**
 * One REAL Actor process "at home" for test/platform_parity.integration.test.ts: the real `apify` SDK and the real
 * apify-client resource clients (key-value store, dataset, run, charge) talking HTTP to the in-process mock of the Apify
 * REST API in test/support/mock_apify_platform.ts, around the real router, with stub connectors (no network).
 * Run it with `node --import tsx test/support/platform_child.ts`, like test/support/sdk_child.ts, which keeps the same
 * conventions (stub connector, last stdout line `RESULT:<json>`).
 *
 * The at-home environment is set from these variables BEFORE the SDK is imported (every inherited APIFY_*, ACTOR_* and
 * CRAWLEE_* variable is dropped first, so the parent's environment cannot leak in):
 *   PLATFORM_URL                  base URL of the mock (required)            -> APIFY_API_BASE_URL (+ APIFY_IS_AT_HOME=1)
 *   PLATFORM_TOKEN                                                           -> APIFY_TOKEN
 *   PLATFORM_DEFAULT_KV_ID, PLATFORM_DEFAULT_DATASET_ID   default storages   -> APIFY_DEFAULT_*_ID
 *   RUN_ID                        id of this run (default run-under-test)    -> ACTOR_RUN_ID
 *   PRICING_INFO                  JSON `pricingInfo` of the run (default: the pay-per-event prices below)
 *   PRICING_VIA                   `env` (default: APIFY_ACTOR_PRICING_INFO, as the platform sets it) or `run` (the SDK reads
 *                                 pricingInfo from GET /v2/actor-runs/:id; the mock must be built with that pricingInfo)
 *   MAX_TOTAL_CHARGE_USD          the run's budget (default 50)              -> ACTOR_MAX_TOTAL_CHARGE_USD
 * What the run does:
 *   ENTRY=sinks (default)         `runEngine` through `createApifySinks(slug, NS, { leases })`; prints the summary or the error
 *   ENTRY=main                    `runEngineMain` (INPUT is read from the default store, leases with their default timings;
 *                                 the SDK exits the process): prints the exit code
 *   SOURCES_JSON                  {"<source id>": [SourceRecord, ...] | {"error": "<message the fetch throws>"}}
 *   INPUT_JSON                    Actor input for runEngine (default: every source selected)
 *   NS                            delta-memory namespace for ENTRY=sinks (default `default`)
 *   LEASES=0                      no leases (ENTRY=sinks); otherwise LEASE_SETTLE_MS (default 20), LEASE_STALE_MS, LEASE_RENEW_MS
 *   API_RETRIES, API_RETRY_DELAY_MS   apify-client retries (default 2 retries, 5 ms base delay; `API_RETRIES=default` keeps the
 *                                 client's own 8 retries from 500 ms, which make one unreadable record cost minutes)
 * The last stdout line is `RESULT:<json>`: { ok, summary | error: { name, message, fatal, conflicts? }, charged, logs, exitCode? }.
 */
import { z } from 'zod';

import type { EngineDefinition } from '../../lib/router_core.js';
import type { Connector, SourceRecord } from '../../lib/types.js';

const env = process.env;
const DEFAULT_PRICES: Record<string, number> = { 'apify-actor-start': 0.005, 'doc-new': 0.01, 'doc-updated': 0.005, 'watchlist-hit': 0.15 };

function requiredEnv(name: string): string {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`platform_child: ${name} is required`);
    return value;
}

// 1. The at-home environment, before the SDK is imported.
for (const name of Object.keys(env)) if (/^(APIFY_|ACTOR_|CRAWLEE_)/u.test(name)) delete env[name];
const pricingInfo =
    env.PRICING_INFO ??
    JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: Object.fromEntries(Object.entries(DEFAULT_PRICES).map(([name, eventPriceUsd]) => [name, { eventTitle: name, eventDescription: name, eventPriceUsd }])) },
    });
Object.assign(env, {
    APIFY_IS_AT_HOME: '1',
    APIFY_API_BASE_URL: requiredEnv('PLATFORM_URL'),
    APIFY_API_PUBLIC_BASE_URL: requiredEnv('PLATFORM_URL'),
    APIFY_TOKEN: env.PLATFORM_TOKEN ?? 'mock-token',
    ACTOR_RUN_ID: env.RUN_ID ?? 'run-under-test',
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: env.PLATFORM_DEFAULT_KV_ID ?? 'default-kv',
    APIFY_DEFAULT_DATASET_ID: env.PLATFORM_DEFAULT_DATASET_ID ?? 'default-dataset',
    APIFY_DEFAULT_REQUEST_QUEUE_ID: 'default-rq',
    ACTOR_MAX_TOTAL_CHARGE_USD: env.MAX_TOTAL_CHARGE_USD ?? '50',
    ...(env.PRICING_VIA === 'run' ? {} : { APIFY_ACTOR_PRICING_INFO: pricingInfo, APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}' }),
});

const { Actor } = await import('apify');
const { createApifyLogger, createApifySinks } = await import('../../lib/apify_adapters.js');
const { runEngineMain } = await import('../../lib/engine_main.js');
const { createHttpClient } = await import('../../lib/http.js');
const { runEngine } = await import('../../lib/router_core.js');
const { FatalConfigError } = await import('../../lib/types.js');

// 2. The stub engine: one connector per entry of SOURCES_JSON.
type SourceSpec = SourceRecord[] | { error: string };
const specs = JSON.parse(env.SOURCES_JSON ?? '{"stub":[]}') as Record<string, SourceSpec>;

function stub(id: string, spec: SourceSpec): Connector<Record<string, unknown>> {
    return {
        id,
        engine: 'global-regtech-compliance-feed',
        legacyActor: `legacy-${id}`,
        description: id,
        status: 'active',
        optionsSchema: z.object({}).passthrough(),
        billing: { newEvent: 'doc-new', updatedEvent: 'doc-updated' },
        async fetch() {
            if (!Array.isArray(spec)) throw new Error(spec.error);
            return spec;
        },
    };
}
const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors: Object.entries(specs).map(([id, spec]) => stub(id, spec)) };
const input: unknown = JSON.parse(env.INPUT_JSON ?? JSON.stringify({ sources: Object.keys(specs) }));

// 3. Output.
const logs: string[] = [];
const realLogger = createApifyLogger();
const logger = {
    info: (m: string) => (logs.push(`I ${m}`), realLogger.info(m)),
    warning: (m: string) => (logs.push(`W ${m}`), realLogger.warning(m)),
    error: (m: string) => (logs.push(`E ${m}`), realLogger.error(m)),
    debug: (m: string) => realLogger.debug(m),
};

function chargedCounts(): Record<string, number> {
    try {
        const manager = Actor.getChargingManager();
        return Object.fromEntries(Object.keys(manager.getPricingInfo().perEventPrices).map((name) => [name, manager.getChargedEventCount(name)]));
    } catch {
        return {};
    }
}

function describeError(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) return { name: 'NonError', message: String(error), fatal: false };
    const conflicts = (error as { conflicts?: unknown }).conflicts;
    return { name: error.name, message: error.message, fatal: error instanceof FatalConfigError, ...(conflicts !== undefined ? { conflicts } : {}) };
}

function print(result: Record<string, unknown>): void {
    console.log(`RESULT:${JSON.stringify({ ...result, charged: chargedCounts(), logs })}`);
}

// 4. Run.
if (env.API_RETRIES !== 'default') {
    // The client retries 5xx, 429 and an unparseable body (InvalidResponseBodyError) with exponential backoff.
    const retries = Number(env.API_RETRIES ?? 2);
    Actor.apifyClient.httpClient.maxRetries = Number.isFinite(retries) ? retries : 2;
    Actor.apifyClient.httpClient.minDelayBetweenRetriesMillis = Number(env.API_RETRY_DELAY_MS ?? 5);
}

if (env.ENTRY === 'main') {
    let mainError: Record<string, unknown> | undefined;
    process.on('exit', (code) => print({ ...(mainError ? { ok: false, error: mainError } : { ok: code === 0 }), exitCode: code }));
    try {
        await runEngineMain(engine, 'platform-parity-test (test@example.com)');
    } catch (error) {
        mainError = describeError(error);
    }
    process.exit(mainError ? 1 : 0);
} else {
    await Actor.init();
    let outcome: Record<string, unknown>;
    try {
        const leases = env.LEASES === '0' ? undefined : { settleMs: Number(env.LEASE_SETTLE_MS ?? 20), ...(env.LEASE_STALE_MS ? { staleAfterMs: Number(env.LEASE_STALE_MS) } : {}), ...(env.LEASE_RENEW_MS ? { renewEveryMs: Number(env.LEASE_RENEW_MS) } : {}) };
        const summary = await runEngine(engine, input, {
            sinks: createApifySinks(engine.slug, env.NS ?? 'default', leases ? { leases } : {}),
            ctx: { http: createHttpClient({ userAgent: 'platform-parity-test (test@example.com)' }), log: logger, now: () => new Date() },
        });
        outcome = { ok: true, summary };
    } catch (error) {
        outcome = { ok: false, error: describeError(error) };
    }
    print(outcome);
    process.exit(0);
}
