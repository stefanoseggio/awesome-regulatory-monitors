/**
 * One REAL Actor process for test/apify_sdk.integration.test.ts: the real `apify` SDK (Actor, ChargingManager,
 * Dataset, KeyValueStore on local storage) around the real router, with a stub connector (no network).
 *
 * Controlled by environment variables:
 *   ROWS, MATCH_EVERY   number of records, and every k-th one mentions "ACME CORP" (for the watchlist)
 *   INPUT_JSON          the Actor input passed to runEngine
 *   NS                  delta-memory namespace
 *   PUSHLOG, RUN_LABEL  file that receives one JSON line per row actually pushed, and this run's label
 *   KILL_AFTER=k        hard-kill the process (exit 137, no `finally`) right after the k-th successful push
 *   FAIL_PUSH_AT=k      make the k-th pushData call throw a platform error BEFORE pushing anything
 * The last stdout line is `RESULT:<json>` with the outcome and the SDK's own charged-event counts.
 */
import { appendFileSync } from 'node:fs';

import { Actor } from 'apify';
import { z } from 'zod';

import { createApifyLogger, createApifySinks } from '../../lib/apify_adapters.js';
import { createHttpClient } from '../../lib/http.js';
import { type EngineDefinition, runEngine } from '../../lib/router_core.js';
import { type Connector, FatalConfigError, type SourceRecord } from '../../lib/types.js';

const env = process.env;
const rows = Number(env.ROWS ?? 10);
const matchEvery = Number(env.MATCH_EVERY ?? 5);

const records: SourceRecord[] = Array.from({ length: rows }, (_, i) => ({
    recordId: `rec-${String(i).padStart(3, '0')}`,
    fingerprint: 'a',
    payload: { n: i },
    watchText: i % matchEvery === 0 ? `ACME CORP ${i}` : `OTHER ${i}`,
}));

const connector: Connector<Record<string, unknown>> = {
    id: 'stub',
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'stub',
    description: 'stub',
    status: 'active',
    optionsSchema: z.object({}).passthrough(),
    billing: { newEvent: 'doc-new', updatedEvent: 'doc-updated' },
    async fetch() {
        return records;
    },
};
const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors: [connector] };

await Actor.init();

const original = Actor.pushData.bind(Actor) as (item: unknown, eventName?: string) => Promise<unknown>;
let attempts = 0;
let pushed = 0;
(Actor as unknown as { pushData: unknown }).pushData = async (item: Record<string, unknown>, eventName?: string) => {
    attempts += 1;
    if (env.FAIL_PUSH_AT && attempts === Number(env.FAIL_PUSH_AT)) throw new Error('platform dataset error (HTTP 500)');
    const result = await original(item, eventName);
    pushed += 1;
    appendFileSync(env.PUSHLOG as string, `${JSON.stringify({ run: env.RUN_LABEL, event: eventName ?? null, record_id: item.record_id })}\n`);
    if (env.KILL_AFTER && pushed >= Number(env.KILL_AFTER)) process.exit(137);
    return result;
};

let outcome: Record<string, unknown>;
try {
    const summary = await runEngine(engine, JSON.parse(env.INPUT_JSON ?? '{"sources":["stub"]}'), {
        sinks: createApifySinks(engine.slug, env.NS ?? 'default'),
        ctx: { http: createHttpClient({ userAgent: 'sdk-integration-test (test@example.com)' }), log: createApifyLogger(), now: () => new Date() },
    });
    outcome = { ok: true, summary };
} catch (error) {
    outcome = { ok: false, error: (error as Error).message, fatal: error instanceof FatalConfigError };
}

const manager = Actor.getChargingManager();
const charged: Record<string, number> = {};
for (const name of ['doc-new', 'doc-updated', 'watchlist-hit', 'apify-default-dataset-item', 'apify-actor-start']) charged[name] = manager.getChargedEventCount(name);
console.log(`RESULT:${JSON.stringify({ ...outcome, pushed, charged })}`);
process.exit(0);
