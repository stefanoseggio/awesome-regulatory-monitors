/**
 * Regression tests for the findings of the independent review of the run lease, the fail-closed records and the router's
 * failure paths. Each test names the finding it pins (F-01 .. F-10). They are written to the behaviour the code must have; the
 * review's reproductions showed the opposite on the code before the fixes.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApifyDeltaStore, ApifyLeaseStorage, ApifyRunLiveness, isUnparsableRecordError } from '../lib/apify_adapters.js';
import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { InMemoryLeaseStorage, LeaseConflictError, LeaseLostError, type LeaseRecord, type LeaseStorage, MAX_CLOCK_SKEW_MS, RunLeases, type RunLeasesOptions, type RunLivenessChecker } from '../lib/lease.js';
import { MAX_ROW_BYTES, runEngine, type RunSinks } from '../lib/router_core.js';
import { CorruptDeltaRecordError, InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, RunSummary, SourceRecord } from '../lib/types.js';
import { InvalidResponseBodyError, PlatformLikeKv } from './support/fake_kv.js';

const silentLog = { info() {}, warning() {}, error() {}, debug() {} };
const ctx: ConnectorContext = {
    http: {
        async getText() {
            throw new Error('network must not be used');
        },
        async getJson() {
            throw new Error('network must not be used');
        },
    },
    log: silentLog,
    now: () => new Date('2026-10-21T00:00:00Z'),
};
const clock = () => new Date('2026-10-21T00:00:00Z');

/** A controllable clock shared by leases. */
function fakeClock(startIso = '2026-10-21T10:00:00.000Z') {
    let t = Date.parse(startIso);
    return {
        now: () => new Date(t),
        advance: (ms: number) => {
            t += ms;
        },
        set: (iso: string) => {
            t = Date.parse(iso);
        },
        sleep: async (ms: number) => {
            t += ms;
        },
    };
}

function leasesFor(storage: LeaseStorage, runId: string, c: ReturnType<typeof fakeClock>, extra: Partial<RunLeasesOptions> = {}): RunLeases {
    return new RunLeases(storage, { runId, namespace: 'default', now: c.now, sleep: c.sleep, ...extra });
}

function rec(id: string, watchText?: string, payload: Record<string, unknown> = {}): SourceRecord {
    return { recordId: id, fingerprint: 'a', payload: { title: `t-${id}`, ...payload }, watchText };
}

function connector(id: string, fetch: () => Promise<SourceRecord[]>): Connector<any> {
    return { id, engine: 'global-regtech-compliance-feed', legacyActor: `legacy-${id}`, description: id, status: 'active', optionsSchema: z.object({}).passthrough(), fetch };
}

interface Harness {
    sinks: RunSinks;
    rows: Array<Record<string, unknown>>;
    billing: FakeBilling;
    store: InMemoryDeltaStore;
    summaries: RunSummary[];
}

function harness(opts: { store?: InMemoryDeltaStore; billing?: FakeBilling; rows?: Array<Record<string, unknown>> } = {}): Harness {
    const billing = opts.billing ?? new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 });
    const store = opts.store ?? new InMemoryDeltaStore();
    const rows = opts.rows ?? [];
    const summaries: RunSummary[] = [];
    const sinks: RunSinks = {
        async emit(row, eventName = RESULT_EVENT) {
            const r = await billing.charge(eventName, 1);
            if (r.chargedCount < 1) return { emitted: false, limitReached: true };
            rows.push(row);
            return { emitted: true, limitReached: r.eventChargeLimitReached };
        },
        billing,
        store,
        async saveSummary(s) {
            summaries.push(s);
        },
    };
    return { sinks, rows, billing, store, summaries };
}

const engineOf = (...connectors: Array<Connector<any>>) => ({ slug: 'global-regtech-compliance-feed' as const, connectors });
const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('F-01 delta memory is listed the way the platform client can list it', () => {
    it('loads every source of the namespace from a store that has no keys() (apify-client has listKeys only), and nothing of another namespace', async () => {
        const kv = new PlatformLikeKv();
        await kv.setValue('state.team-a.ofac', { seenIds: ['1'], fingerprints: { '1': 'f' }, lastRunAt: 't' });
        await kv.setValue('state.team-a.sec_enforcement', { seenIds: ['2'], fingerprints: { '2': 'f' }, lastRunAt: 't' });
        await kv.setValue('state.team-b.ofac', { seenIds: ['9'], fingerprints: { '9': 'f' }, lastRunAt: 't' });
        await kv.setValue('journal.team-a.ofac', [{ recordId: 'x', fingerprint: 'f' }]);
        await kv.setValue('lease.team-a.ofac', { runId: 'r', acquiredAt: 't', heartbeatAt: 't' });
        expect('keys' in kv).toBe(false);
        const state = await new ApifyDeltaStore('s', 'team-a', async () => kv).load();
        expect(Object.keys(state.sources).sort()).toEqual(['ofac', 'sec_enforcement']);
        expect(state.invalid).toBeUndefined();
    });

    it('asks the store for the namespace prefix only (the platform pages the listing; the prefix keeps it short)', async () => {
        const kv = new PlatformLikeKv();
        const prefixes: Array<string | undefined> = [];
        const original = kv.forEachKey.bind(kv);
        kv.forEachKey = async (iteratee, options) => {
            prefixes.push(options?.prefix);
            return original(iteratee, options);
        };
        await new ApifyDeltaStore('s', 'team-a', async () => kv).load();
        expect(prefixes).toEqual(['state.team-a.']);
    });
});

describe('F-03 a run that cannot be found is not a dead run', () => {
    const lookup = (result: unknown): RunLivenessChecker => new ApifyRunLiveness(async () => (result instanceof Error ? Promise.reject(result) : (result as { status?: string } | undefined)));

    it('maps only terminal statuses to dead and only running ones to live; not found, a permission error and an unknown status are unknown', async () => {
        for (const status of ['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING']) expect(await lookup({ status }).check('r'), status).toBe('live');
        for (const status of ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']) expect(await lookup({ status }).check('r'), status).toBe('dead');
        expect(await lookup(undefined).check('r')).toBe('unknown');
        expect(await lookup(new Error('403 forbidden')).check('r')).toBe('unknown');
        expect(await lookup({ status: 'PAUSED' }).check('r')).toBe('unknown');
    });

    it('with the holder not found and a FRESH heartbeat the lease is refused; with a stale heartbeat it is taken', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        await leasesFor(storage, 'holder', c, { settleMs: 0 }).acquire(['ofac']);
        c.advance(60_000);
        const second = leasesFor(storage, 'second', c, { settleMs: 0, liveness: lookup(undefined) });
        await expect(second.acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
        c.advance(20 * 60_000);
        await second.acquire(['ofac']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'second' });
    });
});

describe('F-04 a record that exists but cannot be parsed fails ITS source, not the run', () => {
    it('isUnparsableRecordError recognises the apify-client error by name and code, and nothing else', () => {
        expect(isUnparsableRecordError(new InvalidResponseBodyError())).toBe(true);
        expect(isUnparsableRecordError({ code: 'invalid-response-body' })).toBe(true);
        expect(isUnparsableRecordError(new Error('ECONNRESET'))).toBe(false);
        expect(isUnparsableRecordError(null)).toBe(false);
        expect(isUnparsableRecordError('x')).toBe(false);
    });

    it('a truncated state record is reported as invalid for that source; the healthy sources of the namespace still load', async () => {
        const kv = new PlatformLikeKv();
        await kv.setValue('state.ns.good', { seenIds: ['1'], fingerprints: { '1': 'f' }, lastRunAt: 't' });
        kv.putUnparsable('state.ns.bad');
        const state = await new ApifyDeltaStore('store-x', 'ns', async () => kv).load();
        expect(Object.keys(state.sources)).toEqual(['good']);
        expect(Object.keys(state.invalid ?? {})).toEqual(['bad']);
        expect(state.invalid?.bad).toContain('"state.ns.bad"');
        expect(state.invalid?.bad).toContain('"store-x"');
    });

    it('a platform failure while reading a record is NOT a corrupt record: it propagates', async () => {
        const kv = new PlatformLikeKv();
        await kv.setValue('state.ns.good', { seenIds: [], fingerprints: {}, lastRunAt: 't' });
        kv.client.getRecord = async () => {
            throw new Error('ECONNRESET');
        };
        await expect(new ApifyDeltaStore('s', 'ns', async () => kv).load()).rejects.toThrow('ECONNRESET');
    });

    it('a truncated journal record is a CorruptDeltaRecordError naming the key and the store, not a raw client error', async () => {
        const kv = new PlatformLikeKv();
        kv.putUnparsable('journal.ns.ofac');
        const store = new ApifyDeltaStore('store-x', 'ns', async () => kv);
        const error = await store.loadJournal('ofac').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CorruptDeltaRecordError);
        expect((error as Error).message).toContain('journal.ns.ofac');
        expect((error as Error).message).toContain('store-x');
    });

    it('a truncated lease record reads as unreadable, is overwritten by the next run and never blocks it', async () => {
        const kv = new PlatformLikeKv();
        kv.putUnparsable('lease.ns.ofac');
        const storage = new ApifyLeaseStorage('ns', async () => kv);
        const c = fakeClock();
        await leasesFor(storage, 'run-a', c, { settleMs: 0 }).acquire(['ofac']);
        expect(kv.data.get('lease.ns.ofac')).toMatchObject({ runId: 'run-a' });
    });

    it('through the router: a truncated record fails that source only, the healthy sibling delivers, and nothing is written for the failed one', async () => {
        const kv = new PlatformLikeKv();
        kv.putUnparsable('state.default.bad');
        const store = new ApifyDeltaStore('s', 'default', async () => kv);
        const h = harness();
        h.sinks.store = store;
        const summary = await runEngine(engineOf(connector('bad', async () => [rec('b1')]), connector('good', async () => [rec('g1')])), { sources: ['bad', 'good'] }, { sinks: h.sinks, ctx, clock });
        expect(summary.sources.map((s) => [s.source, s.emitted, s.error === undefined])).toEqual([
            ['bad', 0, false],
            ['good', 1, true],
        ]);
        expect(summary.sources[0]?.error).toContain('state.default.bad');
        expect(h.rows.map((r) => r.record_id)).toEqual(['g1']);
    });
});

describe('F-02 an overtaken run is stopped, and never writes over the run that took the lease', () => {
    it('a lease record that has disappeared means the run was overtaken and the new holder has finished: the next check throws LeaseLostError', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const a = leasesFor(storage, 'run-a', c, { settleMs: 0, staleAfterMs: 15 * 60_000 });
        await a.acquire(['ofac']);
        c.advance(20 * 60_000); // run A is suspended for longer than the stale limit
        const b = leasesFor(storage, 'run-b', c, { settleMs: 0, staleAfterMs: 15 * 60_000 });
        await b.acquire(['ofac']);
        await b.release(); // run B finishes before A wakes: the record is gone
        expect(storage.peek('ofac')).toBeUndefined();
        const error = await a.renewIfDue().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseLostError);
        expect((error as Error).message).toContain('is gone');
        // and it keeps throwing: a lost lease is not found again by a second call
        await expect(a.renewIfDue()).rejects.toBeInstanceOf(LeaseLostError);
        expect(storage.peek('ofac')).toBeUndefined();
    });

    it('a lease record held by another run, or unreadable, is a lost lease too', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const a = leasesFor(storage, 'run-a', c, { settleMs: 0 });
        await a.acquire(['ofac']);
        c.advance(61_000);
        storage.poke('ofac', { runId: 'run-b', acquiredAt: 't', heartbeatAt: c.now().toISOString() });
        await expect(a.renewIfDue()).rejects.toThrow('taken over by run run-b');
        const b = leasesFor(storage, 'run-c', c, { settleMs: 0 });
        storage.poke('ofac', 'garbage');
        await b.acquire(['ofac']);
        c.advance(61_000);
        storage.poke('ofac', 'garbage');
        await expect(b.renewIfDue()).rejects.toThrow('unreadable record');
    });

    it('end to end: run A is suspended in a long fetch, run B takes the lease, delivers everything and finishes; A wakes and delivers NOTHING (it used to deliver and bill its whole list again)', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const store = new InMemoryDeltaStore();
        const rows: Array<Record<string, unknown>> = [];
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 });
        const recordsFor = () => ids(10).map((id) => rec(id));
        const options = { settleMs: 0, staleAfterMs: 15 * 60_000 };

        const hB = harness({ store, billing, rows });
        hB.sinks.leases = leasesFor(storage, 'run-b', c, options);
        const hA = harness({ store, billing, rows });
        hA.sinks.leases = leasesFor(storage, 'run-a', c, options);

        // A holds the lease, then its fetch hangs for 20 minutes (a connector that fetches a detail page per record) ...
        let resumeA!: () => void;
        const gate = new Promise<void>((resolve) => {
            resumeA = resolve;
        });
        const runA = runEngine(
            engineOf(
                connector('a', async () => {
                    await gate;
                    return recordsFor();
                }),
            ),
            { sources: ['a'] },
            { sinks: hA.sinks, ctx, clock },
        );
        await new Promise((resolve) => setTimeout(resolve, 5)); // A has taken the lease and is inside its fetch
        c.advance(20 * 60_000);
        // ... B starts, takes the stale lease, delivers all ten rows and releases
        const summaryB = await runEngine(engineOf(connector('a', async () => recordsFor())), { sources: ['a'] }, { sinks: hB.sinks, ctx, clock });
        expect(summaryB.totalEmitted).toBe(10);
        expect(storage.peek('a')).toBeUndefined();
        // A wakes up
        resumeA();
        await expect(runA).rejects.toBeInstanceOf(LeaseLostError);
        expect(rows.map((r) => r.record_id)).toEqual(ids(10));
        expect(billing.calls.filter((call) => call.eventName === RESULT_EVENT)).toHaveLength(10);
        // B's delta memory is intact: A did not write over it
        expect(store.peek().sources.a?.seenIds.sort()).toEqual(ids(10).sort());
    });

    it('end to end: A is overtaken while B is still running; A stops before its next push and leaves B memory and journal alone', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const store = new InMemoryDeltaStore();
        const rows: Array<Record<string, unknown>> = [];
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 });
        const hA = harness({ store, billing, rows });
        hA.sinks.leases = leasesFor(storage, 'run-a', c, { settleMs: 0, staleAfterMs: 15 * 60_000 });
        // B's progress as it would be in the shared records: one row in its journal, memory with an earlier record
        let pushed = 0;
        const innerEmit = hA.sinks.emit;
        hA.sinks.emit = async (row, eventName) => {
            const result = await innerEmit(row, eventName);
            pushed += 1;
            if (pushed === 2) {
                // while A is working on its third row, the clock jumps past the stale limit and B takes the lease and journals a row
                c.advance(20 * 60_000);
                storage.poke('a', { runId: 'run-b', acquiredAt: c.now().toISOString(), heartbeatAt: c.now().toISOString() });
                await store.saveJournal('a', [{ recordId: 'b-row', fingerprint: 'a' }]);
            }
            return result;
        };
        await expect(runEngine(engineOf(connector('a', async () => ids(10).map((id) => rec(id)))), { sources: ['a'] }, { sinks: hA.sinks, ctx, clock })).rejects.toBeInstanceOf(LeaseLostError);
        expect(rows).toHaveLength(2);
        // A's last write was the journal entry of the row that was in flight when it was overtaken; it did NOT clear the journal and
        // wrote no memory, so whoever runs next folds those rows in and delivers nothing twice
        expect(store.peekJournal('a'), 'not cleared').toHaveLength(2);
        expect(store.journalWrites).toBe(3); // A's entry for row 1, B's, A's entry for the row in flight; never a clearing write
        expect(store.peek().sources.a, 'A wrote no memory over the new holder').toBeUndefined();
        expect(storage.peek('a')).toMatchObject({ runId: 'run-b' });
    });
});

describe('F-06 the lease is written only after a second read of the same record', () => {
    it('a start whose platform status call is slow does not overwrite a lease that another run wrote while it waited: it re-reads and refuses', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        // a stale record of a dead run is there, so every start goes through the (slow) status call
        storage.poke('ofac', { runId: 'dead-run', acquiredAt: '2026-10-21T08:00:00.000Z', heartbeatAt: '2026-10-21T08:00:00.000Z' });
        const slowLiveness: RunLivenessChecker = {
            async check(runId) {
                if (runId === 'dead-run') {
                    // while this start waits for the platform, another run reads the same stale record and takes the lease
                    await leasesFor(storage, 'run-a', c, { settleMs: 0 }).acquire(['ofac']);
                    return 'dead';
                }
                return 'live';
            },
        };
        const b = leasesFor(storage, 'run-b', c, { settleMs: 1_500, liveness: slowLiveness });
        const error = await b.acquire(['ofac']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseConflictError);
        expect((error as LeaseConflictError).conflicts[0]?.holder).toBe('run-a');
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a' });
    });

    it('a record that keeps changing under the run is a conflict after three attempts, not a lease', async () => {
        const c = fakeClock();
        const inner = new InMemoryLeaseStorage();
        let reads = 0;
        const storage: LeaseStorage = {
            async read(source) {
                reads += 1;
                // every read sees a different (stale-looking) record, as if somebody were writing it all the time
                return { runId: `churn-${reads}`, acquiredAt: '2026-10-21T08:00:00.000Z', heartbeatAt: `2026-10-21T08:00:0${reads % 10}.000Z` };
            },
            write: (source, record) => inner.write(source, record),
            remove: (source) => inner.remove(source),
        };
        const error = await leasesFor(storage, 'run-x', c, { settleMs: 0 }).acquire(['ofac']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseConflictError);
        expect(inner.writes).toBe(0);
    });
});

describe('F-07 a lease check never comes between a delivered row and its watchlist-hit', () => {
    it('a lease store that fails after a row was pushed does not lose that row hit: every pushed matched row has its hit charged', async () => {
        let checks = 0;
        const h = harness();
        h.sinks.leases = {
            async acquire() {},
            async renewIfDue() {
                checks += 1;
                // 1 and 2 surround the fetch; 3 precedes row 1, 4 precedes row 2; the store fails there
                if (checks === 4) throw new Error('kv store unavailable');
            },
            async release() {},
        };
        const records = [rec('m1', 'ACME CORP'), rec('m2', 'ACME CORP'), rec('m3', 'ACME CORP')];
        await expect(runEngine(engineOf(connector('a', async () => records)), { sources: ['a'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow('kv store unavailable');
        expect(h.rows.map((r) => r.record_id)).toEqual(['m1']);
        expect(h.billing.calls.filter((call) => call.eventName === WATCHLIST_HIT_EVENT)).toHaveLength(1);
        expect(h.store.peek().sources.a?.seenIds).toEqual(['m1']);
    });
});

describe('F-09 the lease survives clocks that disagree', () => {
    it('a heartbeat from the far future does not block anyone: its holder is treated as dead', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        storage.poke('ofac', { runId: 'fast-clock', acquiredAt: '2999-01-01T00:00:00.000Z', heartbeatAt: '2999-01-01T00:00:00.000Z' });
        await leasesFor(storage, 'run-b', c, { settleMs: 0 }).acquire(['ofac']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });

    it('a heartbeat a little ahead (within the skew allowance) still counts as live', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        storage.poke('ofac', { runId: 'slightly-ahead', acquiredAt: 't', heartbeatAt: new Date(c.now().getTime() + MAX_CLOCK_SKEW_MS / 2).toISOString() });
        await expect(leasesFor(storage, 'run-b', c, { settleMs: 0 }).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
    });

    it('a clock that steps backwards makes the run renew at once instead of going silent', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const a = leasesFor(storage, 'run-a', c, { settleMs: 0, renewEveryMs: 60_000 });
        await a.acquire(['ofac']);
        const before = storage.writes;
        c.advance(-30 * 60_000); // 30 minutes back
        await a.renewIfDue();
        expect(storage.writes).toBe(before + 1);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a', heartbeatAt: c.now().toISOString() });
    });
});

describe('F-10 acquire and release are exception safe', () => {
    /** A storage whose write or remove fails for chosen sources. */
    function flaky(inner: InMemoryLeaseStorage, failing: { write?: Set<string>; remove?: Set<string> }): LeaseStorage {
        return {
            read: (source) => inner.read(source),
            async write(source, record) {
                if (failing.write?.has(source)) throw new Error(`write failed for ${source}`);
                return inner.write(source, record);
            },
            async remove(source) {
                if (failing.remove?.has(source)) throw new Error(`remove failed for ${source}`);
                return inner.remove(source);
            },
        };
    }

    it('a write error on the second source of a two-source run leaves no lease behind for the first', async () => {
        const c = fakeClock();
        const inner = new InMemoryLeaseStorage();
        const a = leasesFor(flaky(inner, { write: new Set(['b']) }), 'run-a', c, { settleMs: 0 });
        await expect(a.acquire(['a', 'b'])).rejects.toThrow('write failed for b');
        expect(inner.peek('a')).toBeUndefined();
        expect(inner.peek('b')).toBeUndefined();
    });

    it('a release that fails inside the conflict path does not replace the LeaseConflictError with a storage error', async () => {
        const c = fakeClock();
        const inner = new InMemoryLeaseStorage();
        await leasesFor(inner, 'holder', c, { settleMs: 0 }).acquire(['b']);
        const storage = flaky(inner, { remove: new Set(['a']) });
        const error = await leasesFor(storage, 'run-x', c, { settleMs: 0 }).acquire(['a', 'b']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseConflictError);
    });

    it('release attempts every lease even when one removal fails, reports the failure, and a second release finishes the job', async () => {
        const c = fakeClock();
        const inner = new InMemoryLeaseStorage();
        const failing = new Set(['a']);
        const a = leasesFor(flaky(inner, { remove: failing }), 'run-a', c, { settleMs: 0 });
        await a.acquire(['a', 'b', 'c']);
        await expect(a.release()).rejects.toThrow('remove failed for a');
        expect(inner.peek('a')).toMatchObject({ runId: 'run-a' });
        expect(inner.peek('b')).toBeUndefined();
        expect(inner.peek('c')).toBeUndefined();
        failing.clear();
        await a.release();
        expect(inner.peek('a')).toBeUndefined();
    });
});

describe('the heartbeat timer keeps a lease alive while the run is busy inside one long fetch', () => {
    it('renews on its own every renewEveryMs, stops at release, and a takeover is found by the next check', async () => {
        const storage = new InMemoryLeaseStorage();
        const a = new RunLeases(storage, { runId: 'run-a', namespace: 'default', settleMs: 0, renewEveryMs: 15, heartbeat: true });
        await a.acquire(['ofac']);
        const writesAfterAcquire = storage.writes;
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(storage.writes - writesAfterAcquire).toBeGreaterThanOrEqual(2);
        // somebody takes the lease over: the timer finds out and the next check throws
        storage.poke('ofac', { runId: 'run-b', acquiredAt: 't', heartbeatAt: new Date().toISOString() });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await expect(a.renewIfDue()).rejects.toBeInstanceOf(LeaseLostError);
        await a.release();
        const writes = storage.writes;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(storage.writes).toBe(writes);
    });

    it('does not keep the process alive and stops after release', async () => {
        const storage = new InMemoryLeaseStorage();
        const a = new RunLeases(storage, { runId: 'run-a', namespace: 'default', settleMs: 0, renewEveryMs: 10, heartbeat: true });
        await a.acquire(['ofac']);
        await a.release();
        const writes = storage.writes;
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(storage.writes).toBe(writes);
    });
});

describe('F-05 a row that the platform would refuse to store does not stop the run', () => {
    it('is skipped (and reported once), the rows around it and the next source are delivered, and it is not remembered', async () => {
        const huge = 'x'.repeat(MAX_ROW_BYTES + 1);
        const warnings: string[] = [];
        const h = harness();
        const records = [rec('ok1'), rec('big', undefined, { blob: huge }), rec('ok2')];
        const summary = await runEngine(engineOf(connector('a', async () => records), connector('b', async () => [rec('b1')])), { sources: ['a', 'b'] }, { sinks: h.sinks, ctx: { ...ctx, log: { ...silentLog, warning: (m: string) => warnings.push(m) } }, clock });
        expect(h.rows.map((r) => r.record_id)).toEqual(['ok1', 'ok2', 'b1']);
        expect(summary.sources.map((s) => s.emitted)).toEqual([2, 1]);
        expect(warnings.filter((w) => w.includes('larger than'))).toHaveLength(1);
        expect(h.store.peek().sources.a?.seenIds.sort()).toEqual(['ok1', 'ok2']);
    });

    it('a row exactly at the limit is delivered', async () => {
        const h = harness();
        const overhead = JSON.stringify({ title: 't-edge', blob: '', engine: 'global-regtech-compliance-feed', source: 'a', record_id: 'edge', delta_status: 'first_seen', is_new: true, is_watchlist_match: false, matched_watchlist_keyword: null, scraped_at: '2026-10-21T00:00:00.000Z' }).length;
        await runEngine(engineOf(connector('a', async () => [rec('edge', undefined, { blob: 'x'.repeat(MAX_ROW_BYTES - overhead) })])), { sources: ['a'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(1);
    });
});

describe('F-08 hits that were not billed are in the summary', () => {
    it('counts the hits skipped by the per-run cap', async () => {
        const h = harness();
        const records = ids(5).map((id) => rec(id, 'ACME CORP'));
        const summary = await runEngine(engineOf(connector('a', async () => records)), { sources: ['a'], watchlistNames: ['Acme Corp'], maxWatchlistHitsPerRun: 2 }, { sinks: h.sinks, ctx, clock });
        expect(summary.watchlist).toMatchObject({ hitsCharged: 2, hitsCapped: 3, hitsUnpriced: 0 });
        expect(summary.sources[0]?.watchlistHits).toBe(5);
    });

    it('counts a hit that the spending limit left unbilled: the row that reaches the limit is delivered, its hit is not billed', async () => {
        // a budget of 0.003 pays for one row (0.002); after it the budget cannot pay another row, so the SDK would overcharge by one event
        // to end the run, and the router never spends that extra event on a hit
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 }, 0.003);
        const h = harness({ billing });
        const records = ids(4).map((id) => rec(id, 'ACME CORP'));
        const summary = await runEngine(engineOf(connector('a', async () => records)), { sources: ['a'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(summary.stoppedOnChargeLimit).toBe(true);
        expect(summary.totalEmitted).toBe(1);
        expect(summary.sources[0]?.watchlistHits).toBe(1);
        expect(summary.watchlist).toMatchObject({ hitsCharged: 0, hitsCapped: 1 });
    });

    it('a hit the budget cannot afford (the affordability check) is not attempted, is counted, and the run stops', async () => {
        // 0.0515: the first row (0.002) fits and leaves 0.0495, enough for another row but not for the 0.05 hit
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 }, 0.0515);
        const h = harness({ billing });
        const records = ids(4).map((id) => rec(id, 'ACME CORP'));
        const summary = await runEngine(engineOf(connector('a', async () => records)), { sources: ['a'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(summary.stoppedOnChargeLimit).toBe(true);
        expect(summary.totalEmitted).toBe(1);
        expect(summary.watchlist).toMatchObject({ hitsCharged: 0, hitsCapped: 1 });
        expect(billing.calls.filter((call) => call.eventName === WATCHLIST_HIT_EVENT)).toEqual([]);
    });
});

describe('the lease record type is unchanged for readers of an old record', () => {
    it('a record with only runId and heartbeatAt is still read (acquiredAt defaults to the heartbeat)', async () => {
        const c = fakeClock();
        const storage = new InMemoryLeaseStorage();
        const old: Partial<LeaseRecord> = { runId: 'old', heartbeatAt: '2026-10-21T09:59:00.000Z' };
        storage.poke('ofac', old);
        await expect(leasesFor(storage, 'run-b', c, { settleMs: 0 }).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
    });
});
