/**
 * Shared `main()` for all three engines: init, read input, run the router, map a
 * preflight failure, or a run in which every selected source failed and nothing was
 * delivered, to a FAILED run (so API callers see the real message, not a SUCCEEDED
 * run with an error row), and exit.
 */
import { Actor } from 'apify';

import { createApifyLogger, createApifySinks } from './apify_adapters.js';
import { createHttpClient } from './http.js';
import { allSourcesFailed, describeSourceFailures, type EngineDefinition, runEngine } from './router_core.js';
import { resolveStateNamespace } from './state.js';
import { FatalConfigError } from './types.js';

export async function runEngineMain(engine: EngineDefinition, userAgent: string): Promise<void> {
    await Actor.init();
    const log = createApifyLogger();
    try {
        const input = await Actor.getInput<Record<string, unknown>>();
        let namespace: string;
        try {
            namespace = resolveStateNamespace(input, Actor.getEnv().actorTaskId ?? undefined);
        } catch (error) {
            throw new FatalConfigError(error instanceof Error ? error.message : String(error));
        }
        const summary = await runEngine(engine, input ?? {}, {
            sinks: createApifySinks(engine.slug, namespace, { leases: {} }),
            ctx: { http: createHttpClient({ userAgent, log }), log, now: () => new Date() },
        });
        if (allSourcesFailed(summary)) {
            const message = describeSourceFailures(summary);
            log.error(message);
            await Actor.fail(message);
            return;
        }
        log.info(`Done: ${summary.totalEmitted} record(s) emitted across ${summary.sources.length} source(s).`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(message);
        if (error instanceof FatalConfigError) {
            await Actor.fail(message);
            return;
        }
        throw error;
    }
    await Actor.exit();
}
