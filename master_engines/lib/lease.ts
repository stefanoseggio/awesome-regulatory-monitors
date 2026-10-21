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
 *   - A run whose lease has been taken over (it was suspended for longer than `staleAfterMs`) stops at its next check,
 *     before it pushes another row. A record that has DISAPPEARED counts as taken over too: the only thing that removes
 *     a lease is the release of the run that took it over, so an absent record at renewal means this run was overtaken
 *     and that run has already finished.
 *   - With `heartbeat: true` a timer renews the lease while the run is busy in one long `connector.fetch` (a connector
 *     that fetches a detail page per record can take longer than `staleAfterMs` without returning to the router).
 *
 * WRITING. The lease is written only after the record has been read twice with the same answer (the platform status
 * call between the two reads can be slow, and a run that started meanwhile must not be overwritten), then the run waits
 * `settleMs`, reads it back, and the one whose id is not in it backs off.
 *
 * LIMITS. A key-value store has no compare-and-set, so this is a lease with a settle delay, not a lock: it closes the
 * realistic overlaps (start times seconds or more apart, or the same instant) but is not a proof against every
 * interleaving of two runs whose second read and write are further apart than `settleMs` (a store that answers a
 * single request more slowly than that). A run that is suspended for longer than `staleAfterMs` without renewing can be
 * overtaken; it then stops at its next check, but the rows it pushed after the takeover and before that check (at most
 * the one in flight when it was paused) are delivered twice. Clocks: a heartbeat stamped more than `MAX_CLOCK_SKEW_MS`
 * in the future is treated as stale (a holder whose clock is ahead must not block everyone else), and a clock that
 * steps backwards makes this run renew at once instead of never.
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
    constructor(source: string, holder: string | undefined) {
        super(
            holder === undefined
                ? `The lease for source "${source}" is gone: another run took it over while this run was working (it went without a heartbeat for too long) and has already finished; stopping so that no record is delivered and billed twice.`
                : `The lease for source "${source}" was taken over by run ${holder} while this run was working (it went without a heartbeat for too long); stopping so that no record is delivered and billed twice.`,
        );
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

/** A heartbeat stamped further than this ahead of the reader's clock cannot be trusted: its holder is treated as dead. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Times `acquire` re-reads a record that keeps changing under it before it gives up and reports a conflict. */
const MAX_TAKE_ATTEMPTS = 3;
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
    /** Renew from a timer too (every `renewEveryMs`), so a long connector fetch cannot let the lease go stale. Off by default (tests). */
    heartbeat?: boolean;
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
    private lostError: LeaseLostError | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private timerBusy = false;
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
        const age = this.now().getTime() - Date.parse(existing.heartbeatAt);
        // A heartbeat from the future is a holder whose clock is ahead (or a forged record): it must not block anyone for hours.
        if (age < -MAX_CLOCK_SKEW_MS) return false;
        return age < this.staleAfterMs;
    }

    async acquire(sources: readonly string[]): Promise<void> {
        const unique = [...new Set(sources)];
        if (unique.length === 0) return;
        try {
            await this.acquireUnique(unique);
        } catch (error) {
            // Whatever went wrong (a conflict, a store that answers with an error halfway through a two-source run), no lease may
            // be left behind by a run that never started, and a failure to clean up must not hide the reason.
            await this.release().catch(() => undefined);
            throw error;
        }
        this.lastRenewMs = this.now().getTime();
        this.lostError = undefined;
        if (this.options.heartbeat) this.startTimer();
    }

    private async acquireUnique(unique: readonly string[]): Promise<void> {
        const conflicts: LeaseConflict[] = [];

        // 1. Look at who holds what; write ours where nobody live does.
        await Promise.all(
            unique.map(async (source) => {
                const conflict = await this.take(source);
                if (conflict) conflicts.push(conflict);
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
            await this.release().catch(() => undefined);
            throw new LeaseConflictError(
                conflicts.sort((a, b) => a.source.localeCompare(b.source)),
                this.options.namespace,
            );
        }
    }

    /**
     * Takes the lease of one source: a conflict when a live run holds it, otherwise it writes ours. The record is read again
     * right before the write and the write happens only when it has not changed, because deciding whether a holder is live
     * can take a platform call, and another run may have written its lease while this one was waiting for the answer.
     */
    private async take(source: string): Promise<LeaseConflict | undefined> {
        let latest: LeaseRecord | 'corrupt' | undefined;
        for (let attempt = 0; attempt < MAX_TAKE_ATTEMPTS; attempt += 1) {
            const existing = parseLease(await this.storage.read(source));
            if (existing !== undefined && existing !== 'corrupt' && existing.runId !== this.options.runId && (await this.holderIsLive(existing))) {
                return { source, holder: existing.runId, heartbeatAt: existing.heartbeatAt };
            }
            latest = parseLease(await this.storage.read(source));
            if (sameLease(existing, latest)) {
                await this.storage.write(source, this.record(existing !== undefined && existing !== 'corrupt' && existing.runId === this.options.runId ? existing.acquiredAt : undefined));
                this.held.add(source);
                return undefined;
            }
        }
        // The record kept changing under this run: someone else is writing it right now.
        if (latest !== undefined && latest !== 'corrupt') return { source, holder: latest.runId, heartbeatAt: latest.heartbeatAt };
        return { source, holder: 'unknown', heartbeatAt: this.now().toISOString() };
    }

    async renewIfDue(): Promise<void> {
        if (this.lostError) throw this.lostError;
        if (this.held.size === 0) return;
        const elapsed = this.now().getTime() - this.lastRenewMs;
        // A negative elapsed time is a clock that stepped backwards: renew now rather than never.
        if (elapsed >= 0 && elapsed < this.renewEveryMs) return;
        await this.renewNow();
    }

    /** Reads every held lease and rewrites its heartbeat; throws {@link LeaseLostError} (and remembers it) when one is no longer ours. */
    private async renewNow(): Promise<void> {
        const nowMs = this.now().getTime();
        for (const source of this.held) {
            const current = parseLease(await this.storage.read(source));
            // Absent means the run that took this lease over has already released it; corrupt or another id means somebody else owns it.
            if (current === undefined) {
                this.lostError = new LeaseLostError(source, undefined);
                throw this.lostError;
            }
            if (current === 'corrupt' || current.runId !== this.options.runId) {
                this.lostError = new LeaseLostError(source, current === 'corrupt' ? 'an unreadable record' : current.runId);
                throw this.lostError;
            }
            await this.storage.write(source, this.record(current.acquiredAt));
        }
        this.lastRenewMs = nowMs;
    }

    private startTimer(): void {
        this.stopTimer();
        this.timer = setInterval(() => {
            if (this.timerBusy || this.lostError) return;
            this.timerBusy = true;
            this.renewNow()
                .catch(() => undefined) // a LeaseLostError is remembered and thrown at the next check; a store error is retried at the next tick
                .finally(() => {
                    this.timerBusy = false;
                });
        }, this.renewEveryMs);
        this.timer.unref();
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    async release(): Promise<void> {
        this.stopTimer();
        let failure: unknown;
        // Every lease is attempted even when one fails, and one that could not be removed stays in `held` for a second attempt.
        for (const source of [...this.held]) {
            try {
                const current = parseLease(await this.storage.read(source));
                // Only a lease that is still this run's is removed: never delete the record of the run that took over.
                if (current !== undefined && current !== 'corrupt' && current.runId === this.options.runId) await this.storage.remove(source);
                this.held.delete(source);
            } catch (error) {
                failure ??= error;
            }
        }
        if (failure !== undefined) throw failure;
    }
}

/** Whether two reads of a lease record are the same answer. */
function sameLease(a: LeaseRecord | 'corrupt' | undefined, b: LeaseRecord | 'corrupt' | undefined): boolean {
    if (a === undefined || b === undefined || a === 'corrupt' || b === 'corrupt') return a === b;
    return a.runId === b.runId && a.heartbeatAt === b.heartbeatAt;
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
