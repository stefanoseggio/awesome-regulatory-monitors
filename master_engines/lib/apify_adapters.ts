/**
 * Apify platform adapters: the only file in `lib/` that imports the `apify` SDK.
 * Everything else depends on the ports in `types.ts`, `state.ts` and `charging.ts`.
 */
import { Actor, log } from 'apify';

import { type BillingPort, RESULT_EVENT } from './charging.js';
import type { RunSinks } from './router_core.js';
import { type DeltaState, type DeltaStore, parseState, type SourceDeltaState } from './state.js';
import type { EngineSlug, Logger, RunSummary } from './types.js';

export function createApifyLogger(): Logger {
    return {
        info: (m) => log.info(m),
        warning: (m) => log.warning(m),
        error: (m) => log.error(m),
        debug: (m) => log.debug(m),
    };
}

/** The slice of a key-value store the delta store needs (the Apify `KeyValueStore` satisfies it). */
export interface KeyValueLike {
    keys(): AsyncIterable<string>;
    getValue(key: string): Promise<unknown>;
    setValue(key: string, value: unknown): Promise<void>;
}

/**
 * Delta memory in a named key-value store, ONE RECORD PER SOURCE under `state.<namespace>.<source>`.
 *   - per-source records: two overlapping runs of the same engine can no longer overwrite each other's sources with a
 *     stale whole-document copy;
 *   - namespaces: separate Tasks keep separate memory (see `resolveStateNamespace`).
 * Record keys use only characters Apify allows (source ids are [a-z_], namespaces [a-z0-9-]).
 */
export class ApifyDeltaStore implements DeltaStore {
    constructor(
        private readonly storeName: string,
        private readonly namespace: string = 'default',
        private readonly openStore: () => Promise<KeyValueLike> = async () => (await Actor.openKeyValueStore(storeName)) as unknown as KeyValueLike,
    ) {}

    private get prefix(): string {
        return `state.${this.namespace}.`;
    }

    async load(): Promise<DeltaState> {
        const store = await this.openStore();
        const sources: Record<string, unknown> = {};
        for await (const key of store.keys()) {
            if (!key.startsWith(this.prefix)) continue;
            sources[key.slice(this.prefix.length)] = await store.getValue(key);
        }
        return parseState({ version: 2, sources });
    }

    async saveSource(source: string, entry: SourceDeltaState): Promise<void> {
        const store = await this.openStore();
        await store.setValue(`${this.prefix}${source}`, entry);
    }

    async save(state: DeltaState): Promise<void> {
        for (const [source, entry] of Object.entries(state.sources)) await this.saveSource(source, entry);
    }
}

export class ApifyBilling implements BillingPort {
    isPayPerEvent(): boolean {
        return Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    }

    perEventPrices(): Readonly<Record<string, number>> {
        return Actor.getChargingManager().getPricingInfo().perEventPrices ?? {};
    }

    async charge(eventName: string, count: number) {
        const result = await Actor.charge({ eventName, count });
        return { chargedCount: result.chargedCount, eventChargeLimitReached: result.eventChargeLimitReached };
    }
}

export function createApifySinks(engine: EngineSlug, namespace: string = 'default'): RunSinks {
    return {
        async emit(row, eventName = RESULT_EVENT) {
            // `pushData(row, eventName)` limits by remaining budget, pushes, then bills
            // `eventName` in one step - a separate Actor.charge() afterwards would double-bill.
            // The pricing must NOT also carry `apify-default-dataset-item`: with both priced,
            // pushData bills both events per row (verified in the installed SDK).
            const charge = await Actor.pushData(row, eventName);
            const emitted = charge === undefined ? true : charge.chargedCount > 0 || !Actor.getChargingManager().getPricingInfo().isPayPerEvent;
            return { emitted, limitReached: charge?.eventChargeLimitReached ?? false };
        },
        billing: new ApifyBilling(),
        store: new ApifyDeltaStore(`${engine}-delta-state`, namespace),
        async saveSummary(summary: RunSummary) {
            await Actor.setValue('RUN_SUMMARY', summary);
        },
    };
}
