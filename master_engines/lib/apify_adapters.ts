/**
 * Apify platform adapters: the only file in `lib/` that imports the `apify` SDK.
 * Everything else depends on the ports in `types.ts`, `state.ts` and `charging.ts`.
 */
import { Actor, log } from 'apify';

import { type BillingPort, hasPositivePrice, RESULT_EVENT } from './charging.js';
import type { RunSinks } from './router_core.js';
import { type DeltaState, type DeltaStore, parseJournal, parseState, type ProcessedRecord, type SourceDeltaState } from './state.js';
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
 *
 * The same store holds one small DELIVERY JOURNAL per source under `journal.<namespace>.<source>` (see
 * `DeltaStore.saveJournal`). `load()` ignores it: the router folds it into the memory at the start of the source.
 * Clearing writes `null`, which deletes the record in a key-value store.
 */
export class ApifyDeltaStore implements DeltaStore {
    private opened: Promise<KeyValueLike> | undefined;

    constructor(
        private readonly storeName: string,
        private readonly namespace: string = 'default',
        private readonly openStore: () => Promise<KeyValueLike> = async () => (await Actor.openKeyValueStore(storeName)) as unknown as KeyValueLike,
    ) {}

    private get prefix(): string {
        return `state.${this.namespace}.`;
    }

    private journalKey(source: string): string {
        return `journal.${this.namespace}.${source}`;
    }

    /** Opens the store once per run: the journal is written after every row, so the handle must not be re-opened each time. */
    private store(): Promise<KeyValueLike> {
        this.opened ??= this.openStore();
        return this.opened;
    }

    async load(): Promise<DeltaState> {
        const store = await this.store();
        const sources: Record<string, unknown> = {};
        for await (const key of store.keys()) {
            if (!key.startsWith(this.prefix)) continue;
            sources[key.slice(this.prefix.length)] = await store.getValue(key);
        }
        return parseState({ version: 2, sources });
    }

    async saveSource(source: string, entry: SourceDeltaState): Promise<void> {
        const store = await this.store();
        await store.setValue(`${this.prefix}${source}`, entry);
    }

    async loadJournal(source: string): Promise<ProcessedRecord[]> {
        const store = await this.store();
        return parseJournal(await store.getValue(this.journalKey(source)));
    }

    async saveJournal(source: string, entries: readonly ProcessedRecord[]): Promise<void> {
        const store = await this.store();
        await store.setValue(this.journalKey(source), entries.length === 0 ? null : entries.map(({ recordId, fingerprint }) => ({ recordId, fingerprint })));
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
            // `pushData(row, eventName)` trims the batch to the remaining budget, PUSHES, and only then calls the
            // platform's charge API (verified in the installed SDK, charging.js pushDataAndCharge): ordered, not
            // transactional. A crash between the two leaves a delivered row unbilled; a row is never billed
            // without having been pushed. A separate Actor.charge() afterwards would double-bill.
            // The pricing must NOT also carry `apify-default-dataset-item`: with both priced, pushData bills both
            // events per row (the router refuses such a run in checkRuntimePricing).
            // An event with no positive price is not requested: the SDK would treat it as free anyway and log a
            // warning for every row. The run summary already records it under `pricing.unpricedEvents`.
            const pricing = Actor.getChargingManager().getPricingInfo();
            if (!pricing.isPayPerEvent || !hasPositivePrice(pricing.perEventPrices ?? {}, eventName)) {
                // Not pay-per-event, or this event is free: a plain push, no charge call, no per-row SDK warning.
                await Actor.pushData(row);
                return { emitted: true, limitReached: false };
            }
            const charge = await Actor.pushData(row, eventName);
            // At the budget limit the SDK pushes and bills ONE more row on purpose, "so the Platform terminates the run";
            // that row counts as delivered and `eventChargeLimitReached` then stops the router. A row that was trimmed
            // away by the budget (chargedCount 0) was NOT pushed.
            return { emitted: charge.chargedCount > 0, limitReached: charge.eventChargeLimitReached };
        },
        billing: new ApifyBilling(),
        store: new ApifyDeltaStore(`${engine}-delta-state`, namespace),
        async saveSummary(summary: RunSummary) {
            await Actor.setValue('RUN_SUMMARY', summary);
        },
    };
}
