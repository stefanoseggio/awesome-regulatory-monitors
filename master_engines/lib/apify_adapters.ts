/**
 * Apify platform adapters: the only file in `lib/` that imports the `apify` SDK.
 * Everything else depends on the ports in `types.ts`, `state.ts` and `charging.ts`.
 */
import { randomUUID } from 'node:crypto';

import { Actor, log } from 'apify';

import { type BillingPort, hasPositivePrice, RESULT_EVENT } from './charging.js';
import { type LeaseRecord, type LeaseStorage, RunLeases, type RunLivenessChecker, type RunLiveness } from './lease.js';
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
        return parseState({ version: 2, sources }, (source) => `The delta-memory record "${this.prefix}${source}" in the key-value store "${this.storeName}" exists but cannot be read`);
    }

    async saveSource(source: string, entry: SourceDeltaState): Promise<void> {
        const store = await this.store();
        await store.setValue(`${this.prefix}${source}`, entry);
    }

    async loadJournal(source: string): Promise<ProcessedRecord[]> {
        const store = await this.store();
        return parseJournal(await store.getValue(this.journalKey(source)), `The delivery-journal record "${this.journalKey(source)}" in the key-value store "${this.storeName}" exists but cannot be read`);
    }

    async saveJournal(source: string, entries: readonly ProcessedRecord[]): Promise<void> {
        const store = await this.store();
        await store.setValue(this.journalKey(source), entries.length === 0 ? null : entries.map(({ recordId, fingerprint }) => ({ recordId, fingerprint })));
    }

    async save(state: DeltaState): Promise<void> {
        for (const [source, entry] of Object.entries(state.sources)) await this.saveSource(source, entry);
    }
}

/** Lease records next to the delta memory, one per source under `lease.<namespace>.<source>`; clearing writes `null`. */
export class ApifyLeaseStorage implements LeaseStorage {
    constructor(
        private readonly namespace: string,
        private readonly openStore: () => Promise<KeyValueLike>,
    ) {}

    private key(source: string): string {
        return `lease.${this.namespace}.${source}`;
    }

    async read(source: string): Promise<unknown> {
        return (await this.openStore()).getValue(this.key(source));
    }

    async write(source: string, record: LeaseRecord): Promise<void> {
        await (await this.openStore()).setValue(this.key(source), record);
    }

    async remove(source: string): Promise<void> {
        await (await this.openStore()).setValue(this.key(source), null);
    }
}

/** The platform run statuses in which a run is still going (the transitional ones are still going until they finish). */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']);
const DEAD_RUN_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * Reads the status of another run from the platform. A run that no longer exists is dead. A run that cannot be read (an
 * Actor with limited permissions may not see other runs, or the API is down) is `unknown`, and the caller falls back to
 * the lease heartbeat.
 */
export class ApifyRunLiveness implements RunLivenessChecker {
    constructor(private readonly getRun: (runId: string) => Promise<{ status?: string } | undefined> = async (runId) => Actor.apifyClient.run(runId).get()) {}

    async check(runId: string): Promise<RunLiveness> {
        try {
            const run = await this.getRun(runId);
            if (run === undefined || run === null) return 'dead';
            if (typeof run.status === 'string' && LIVE_RUN_STATUSES.has(run.status)) return 'live';
            if (typeof run.status === 'string' && DEAD_RUN_STATUSES.has(run.status)) return 'dead';
            return 'unknown';
        } catch {
            return 'unknown';
        }
    }
}

export class ApifyBilling implements BillingPort {
    isPayPerEvent(): boolean {
        return Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    }

    perEventPrices(): Readonly<Record<string, number>> {
        return Actor.getChargingManager().getPricingInfo().perEventPrices ?? {};
    }

    affordableCount(eventName: string): number {
        return Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(eventName);
    }

    async charge(eventName: string, count: number) {
        const result = await Actor.charge({ eventName, count });
        return { chargedCount: result.chargedCount, eventChargeLimitReached: result.eventChargeLimitReached };
    }
}

export interface ApifySinkOptions {
    /**
     * Take a run lease per selected source (see lib/lease.ts). Off unless given: `runEngineMain` turns it on. The values
     * are the lease timings in milliseconds (tests shorten them).
     */
    leases?: { staleAfterMs?: number; renewEveryMs?: number; settleMs?: number; runId?: string };
}

export function createApifySinks(engine: EngineSlug, namespace: string = 'default', options: ApifySinkOptions = {}): RunSinks {
    const storeName = `${engine}-delta-state`;
    let opened: Promise<KeyValueLike> | undefined;
    const openStore = (): Promise<KeyValueLike> => {
        opened ??= Actor.openKeyValueStore(storeName) as unknown as Promise<KeyValueLike>;
        return opened;
    };
    const leases = options.leases
        ? new RunLeases(new ApifyLeaseStorage(namespace, openStore), {
              runId: options.leases.runId ?? Actor.getEnv().actorRunId ?? randomUUID(),
              namespace,
              // The platform's run status only means something on the platform: locally the API answers "not found" for a
              // run id it never issued, which would read as "the holder is dead". Locally the heartbeat decides.
              liveness: Actor.isAtHome() ? new ApifyRunLiveness() : undefined,
              staleAfterMs: options.leases.staleAfterMs,
              renewEveryMs: options.leases.renewEveryMs,
              settleMs: options.leases.settleMs,
          })
        : undefined;
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
        store: new ApifyDeltaStore(storeName, namespace, openStore),
        ...(leases ? { leases } : {}),
        async saveSummary(summary: RunSummary) {
            await Actor.setValue('RUN_SUMMARY', summary);
        },
    };
}
