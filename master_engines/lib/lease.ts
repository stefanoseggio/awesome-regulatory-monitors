/**
 * Run leases: at most one live run may deliver a given source into a given delta-memory namespace.
 *
 * WHY. Delta memory is loaded once when a run starts and written back as the run progresses. Two runs that deliver the
 * same source into the same namespace at the same time (a schedule firing while the previous run is still going, a
 * double Start, an API retry that created a second run) each classify the same records as new, so both deliver them and
 * both bill them: with 100 records and 30 ms per row, two overlapping runs delivered and billed 198 rows. The delivery
 * journal and the checkpoints protect a single writer; they cannot protect against a second one.
 *
 * HOW. One small record per (namespace, source) in the same key-value store as the memory. A run takes the lease of
 * every selected source before it reads any state, renews it while it works, and releases it when it ends. A run that
 * finds a lease held by another LIVE run refuses to start, before any request or billable event, and says so.
 *   - Liveness of a holder: the platform's run status when it can be read (a holder in READY, RUNNING, TIMING-OUT or
 *     ABORTING is live; any other status, or a run that no longer exists, is dead, so the lease of a killed run does not
 *     block anyone); otherwise a heartbeat: the holder is live while its lease was renewed less than `staleAfterMs` ago.
 *   - A record that cannot be read is treated as no lease: a lease must never block a source forever.
 *   - Two runs that start at the same instant both write; each then waits `settleMs`, reads the record back, and the one
 *     whose id is not in it backs off.
 *   - A run whose lease has been taken over (it was suspended for longer than `staleAfterMs`) stops at its next renewal
 *     instead of delivering more rows.
 *
 * LIMITS. A key-value store has no compare-and-set, so this is a lease with a settle delay, not a lock: it closes the
 * realistic overlaps (start times seconds or more apart, or the same instant) but is not a proof against every
 * interleaving of two runs that write within `settleMs` of each other with unlucky ordering of reads. A run that is
 * suspended for longer than `staleAfterMs` without renewing can be overtaken.
 */
import { FatalConfigError } from './types.js';

export interface LeaseRecord {
    runId: string;
    acquiredAt: string;
    heartbeatAt: string;
}

/** Persistence of lease records, one per source (the namespace is fixed by the adapter). */
export interface LeaseStorage {
    read(source: string): Promise<unknown>;
    write(source: string, record: LeaseRecord): Promise<void>;
    remove(source: string): Promise<void>;
}

export type RunLiveness = 'live' | 'dead' | 'unknown';

export interface RunLivenessChecker {
    /** Whether the run `runId` is still going. `unknown` when the platform cannot say (no permission, no network). */
    check(runId: string): Promise<RunLiveness>;
}

export interface LeaseConflict {
    source: string;
    holder: string;
    heartbeatAt: string;
}

/** Another live run holds a lease this run needs. Raised before any request or billable event. */
export class LeaseConflictError extends FatalConfigError {
    constructor(
        readonly conflicts: readonly LeaseConflict[],
        namespace: string,
    ) {
        super(
            `Another run is already delivering into the same delta memory: ${conflicts.map((c) => `source "${c.source}" is held by run ${c.holder} (last heartbeat ${c.heartbeatAt})`).join('; ')}. ` +
                `Two overlapping runs of the same stateNamespace ("${namespace}") would deliver and bill the same records twice, so this run did not start. ` +
                'Wait for the other run to finish, or give a concurrent run its own stateNamespace.',
        );
        this.name = 'LeaseConflictError';
    }
}

/** This run's lease was taken over by another run while it was working; it stops instead of delivering more rows. */
export class LeaseLostError extends FatalConfigError {
    constructor(source: string, holder: string) {
        super(`The lease for source "${source}" was taken over by run ${holder} while this run was working (it went without a heartbeat for too long); stopping so that no record is delivered and billed twice.`);
        this.name = 'LeaseLostError';
    }
}

/** What the router needs. */
export interface RunLeasePort {
    /** Takes the lease of every source or throws {@link LeaseConflictError} holding nothing. */
    acquire(sources: readonly string[]): Promise<void>;
    /** Refreshes the heartbeat when it is due; throws {@link LeaseLostError} when a lease is no longer this run's. */
    renewIfDue(): Promise<void>;
    /** Releases every lease this run still holds. */
    release(): Promise<void>;
}

export const DEFAULT_LEASE_STALE_MS = 15 * 60_000;
export const DEFAULT_LEASE_RENEW_EVERY_MS = 60_000;
export const DEFAULT_LEASE_SETTLE_MS = 1_500;

export interface RunLeasesOptions {
    runId: string;
    /** Used only in messages. */
    namespace: string;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    liveness?: RunLivenessChecker;
    staleAfterMs?: number;
    renewEveryMs?: number;
    settleMs?: number;
}

/** A lease record read from storage: the record, `undefined` when absent, or `corrupt`. */
function parseLease(raw: unknown): LeaseRecord | 'corrupt' | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'corrupt';
    const { runId, acquiredAt, heartbeatAt } = raw as { runId?: unknown; acquiredAt?: unknown; heartbeatAt?: unknown };
    if (typeof runId !== 'string' || runId === '' || typeof heartbeatAt !== 'string' || Number.isNaN(Date.parse(heartbeatAt))) return 'corrupt';
    return { runId, acquiredAt: typeof acquiredAt === 'string' ? acquiredAt : heartbeatAt, heartbeatAt };
}

export class RunLeases implements RunLeasePort {
    private readonly held = new Set<string>();
    private lastRenewMs = 0;
    private readonly now: () => Date;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly staleAfterMs: number;
    private readonly renewEveryMs: number;
    private readonly settleMs: number;

    constructor(
        private readonly storage: LeaseStorage,
        private readonly options: RunLeasesOptions,
    ) {
        this.now = options.now ?? (() => new Date());
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.staleAfterMs = options.staleAfterMs ?? DEFAULT_LEASE_STALE_MS;
        this.renewEveryMs = options.renewEveryMs ?? DEFAULT_LEASE_RENEW_EVERY_MS;
        this.settleMs = options.settleMs ?? DEFAULT_LEASE_SETTLE_MS;
    }

    private record(acquiredAt?: string): LeaseRecord {
        const stamp = this.now().toISOString();
        return { runId: this.options.runId, acquiredAt: acquiredAt ?? stamp, heartbeatAt: stamp };
    }

    /** Whether the holder of `existing` is still going. */
    private async holderIsLive(existing: LeaseRecord): Promise<boolean> {
        let verdict: RunLiveness = 'unknown';
        if (this.options.liveness) {
            try {
                verdict = await this.options.liveness.check(existing.runId);
            } catch {
                verdict = 'unknown';
            }
        }
        if (verdict === 'live') return true;
        if (verdict === 'dead') return false;
        return this.now().getTime() - Date.parse(existing.heartbeatAt) < this.staleAfterMs;
    }

    async acquire(sources: readonly string[]): Promise<void> {
        const unique = [...new Set(sources)];
        if (unique.length === 0) return;
        const conflicts: LeaseConflict[] = [];

        // 1. Look at who holds what; write ours where nobody live does.
        await Promise.all(
            unique.map(async (source) => {
                const existing = parseLease(await this.storage.read(source));
                if (existing !== undefined && existing !== 'corrupt' && existing.runId !== this.options.runId && (await this.holderIsLive(existing))) {
                    conflicts.push({ source, holder: existing.runId, heartbeatAt: existing.heartbeatAt });
                    return;
                }
                await this.storage.write(source, this.record(existing !== undefined && existing !== 'corrupt' && existing.runId === this.options.runId ? existing.acquiredAt : undefined));
                this.held.add(source);
            }),
        );

        // 2. Two runs that started together both wrote: let the writes settle, read back, and the loser backs off.
        if (conflicts.length === 0 && this.settleMs > 0) {
            await this.sleep(this.settleMs);
            await Promise.all(
                [...this.held].map(async (source) => {
                    const after = parseLease(await this.storage.read(source));
                    if (after !== undefined && after !== 'corrupt' && after.runId !== this.options.runId) {
                        conflicts.push({ source, holder: after.runId, heartbeatAt: after.heartbeatAt });
                        this.held.delete(source);
                    }
                }),
            );
        }

        if (conflicts.length > 0) {
            await this.release();
            throw new LeaseConflictError(
                conflicts.sort((a, b) => a.source.localeCompare(b.source)),
                this.options.namespace,
            );
        }
        this.lastRenewMs = this.now().getTime();
    }

    async renewIfDue(): Promise<void> {
        if (this.held.size === 0) return;
        const nowMs = this.now().getTime();
        if (nowMs - this.lastRenewMs < this.renewEveryMs) return;
        for (const source of this.held) {
            const current = parseLease(await this.storage.read(source));
            if (current !== undefined && current !== 'corrupt' && current.runId !== this.options.runId) throw new LeaseLostError(source, current.runId);
            await this.storage.write(source, this.record(current !== undefined && current !== 'corrupt' ? current.acquiredAt : undefined));
        }
        this.lastRenewMs = nowMs;
    }

    async release(): Promise<void> {
        const sources = [...this.held];
        this.held.clear();
        for (const source of sources) {
            const current = parseLease(await this.storage.read(source));
            // Only a lease that is still this run's is removed: never delete the record of the run that took over.
            if (current !== undefined && current !== 'corrupt' && current.runId === this.options.runId) await this.storage.remove(source);
        }
    }
}

/** In-memory storage for tests and for engines that run without a key-value store. */
export class InMemoryLeaseStorage implements LeaseStorage {
    private readonly records = new Map<string, unknown>();
    writes = 0;

    async read(source: string): Promise<unknown> {
        return structuredClone(this.records.get(source));
    }

    async write(source: string, record: LeaseRecord): Promise<void> {
        this.writes += 1;
        this.records.set(source, structuredClone(record));
    }

    async remove(source: string): Promise<void> {
        this.records.delete(source);
    }

    /** Test hook: put any value (including a corrupt one) under a source. */
    poke(source: string, value: unknown): void {
        this.records.set(source, structuredClone(value));
    }

    peek(source: string): unknown {
        return structuredClone(this.records.get(source));
    }
}
