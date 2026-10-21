/**
 * Apify platform adapters: the only file in `lib/` that imports the `apify` SDK.
 * Everything else depends on the ports in `types.ts`, `state.ts` and `charging.ts`.
 */
import { Actor, log } from 'apify';

import { type BillingPort, RESULT_EVENT } from './charging.js';
import type { RunSinks } from './router_core.js';
import { type DeltaState, type DeltaStore, parseState } from './state.js';
import type { EngineSlug, Logger, RunSummary } from './types.js';

export function createApifyLogger(): Logger {
    return {
        info: (m) => log.info(m),
        warning: (m) => log.warning(m),
        error: (m) => log.error(m),
        debug: (m) => log.debug(m),
    };
}

export class ApifyDeltaStore implements DeltaStore {
    constructor(private readonly storeName: string) {}

    async load(): Promise<DeltaState> {
        const store = await Actor.openKeyValueStore(this.storeName);
        return parseState(await store.getValue('state'));
    }

    async save(state: DeltaState): Promise<void> {
        const store = await Actor.openKeyValueStore(this.storeName);
        await store.setValue('state', state);
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

export function createApifySinks(engine: EngineSlug): RunSinks {
    return {
        async emit(row) {
            // `pushData(row, eventName)` limits by remaining budget, pushes, then bills
            // `result` in one step - a separate Actor.charge() afterwards would double-bill.
            const charge = await Actor.pushData(row, RESULT_EVENT);
            const emitted = charge === undefined ? true : charge.chargedCount > 0 || !Actor.getChargingManager().getPricingInfo().isPayPerEvent;
            return { emitted, limitReached: charge?.eventChargeLimitReached ?? false };
        },
        billing: new ApifyBilling(),
        store: new ApifyDeltaStore(`${engine}-delta-state`),
        async saveSummary(summary: RunSummary) {
            await Actor.setValue('RUN_SUMMARY', summary);
        },
    };
}
