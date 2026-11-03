/**
 * One REAL Actor process that goes through `runEngineMain` (the code path every engine's main.ts uses), with stub
 * connectors that either succeed or fail. MODE selects the scenario:
 *   all-fail      every selected source throws          -> the run must end FAILED (non-zero exit)
 *   partial-fail  one source throws, one delivers rows   -> the run must end SUCCEEDED (exit 0)
 *   empty-ok      one source answers with zero records   -> the run must end SUCCEEDED (exit 0)
 */
import { z } from 'zod';

import { runEngineMain } from '../../lib/engine_main.js';
import type { EngineDefinition } from '../../lib/router_core.js';
import type { Connector, SourceRecord } from '../../lib/types.js';

function stub(id: string, records: SourceRecord[] | Error): Connector<Record<string, unknown>> {
    return {
        id,
        engine: 'global-regtech-compliance-feed',
        legacyActor: `legacy-${id}`,
        description: id,
        status: 'active',
        optionsSchema: z.object({}).passthrough(),
        billing: { newEvent: 'doc-new', updatedEvent: 'doc-updated' },
        async fetch() {
            if (records instanceof Error) throw records;
            return records;
        },
    };
}

const row: SourceRecord = { recordId: 'r1', fingerprint: 'a', payload: { n: 1 } };
const mode = process.env.MODE ?? 'all-fail';
const connectors =
    mode === 'all-fail'
        ? [stub('down_a', new Error('upstream 503')), stub('down_b', new Error('connect timeout'))]
        : mode === 'partial-fail'
          ? [stub('down_a', new Error('upstream 503')), stub('up', [row])]
          : [stub('empty', [])];
const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors };

await runEngineMain(engine, 'main-child-test (test@example.com)');
