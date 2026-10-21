import { describe, expect, it } from 'vitest';

import { ApifyLeaseStorage, ApifyRunLiveness, type KeyValueLike } from '../lib/apify_adapters.js';
import {
    InMemoryLeaseStorage,
    LeaseConflictError,
    LeaseLostError,
    type LeaseRecord,
    RunLeases,
    type RunLeasesOptions,
    type RunLiveness,
    type RunLivenessChecker,
} from '../lib/lease.js';
import { FatalConfigError } from '../lib/types.js';

/** A controllable clock: `advance` moves time, `sleep` records its argument and advances time. */
function clock(startIso = '2026-10-21T10:00:00.000Z') {
    let t = Date.parse(startIso);
    const sleeps: number[] = [];
    return {
        now: () => new Date(t),
        advance: (ms: number) => {
            t += ms;
        },
        sleeps,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            t += ms;
        },
    };
}

function leases(storage: InMemoryLeaseStorage, runId: string, c = clock(), extra: Partial<RunLeasesOptions> = {}): RunLeases {
    return new RunLeases(storage, { runId, namespace: 'default', now: c.now, sleep: c.sleep, ...extra });
}

const liveness = (verdicts: Record<string, RunLiveness | Error>): RunLivenessChecker => ({
    async check(runId: string): Promise<RunLiveness> {
        const v = verdicts[runId];
        if (v instanceof Error) throw v;
        return v ?? 'unknown';
    },
});

describe('RunLeases.acquire', () => {
    it('takes a free lease for every source, waits the settle delay once, and records the holder and a heartbeat', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac', 'sec_enforcement']);
        for (const source of ['ofac', 'sec_enforcement']) {
            expect(storage.peek(source)).toMatchObject({ runId: 'run-a', heartbeatAt: '2026-10-21T10:00:00.000Z', acquiredAt: '2026-10-21T10:00:00.000Z' });
        }
        expect(c.sleeps).toEqual([1_500]);
    });

    it('acquires nothing and waits for nothing when no source is selected', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire([]);
        expect(storage.writes).toBe(0);
        expect(c.sleeps).toEqual([]);
    });

    it('refuses while another run holds the lease with a fresh heartbeat (platform status unknown), naming source, holder and heartbeat, and holds nothing', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        c.advance(60_000);
        const b = leases(storage, 'run-b', c);
        const error = await b.acquire(['ofac', 'sec_enforcement']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseConflictError);
        expect(error).toBeInstanceOf(FatalConfigError);
        expect((error as LeaseConflictError).conflicts).toEqual([{ source: 'ofac', holder: 'run-a', heartbeatAt: '2026-10-21T10:00:00.000Z' }]);
        expect((error as Error).message).toContain('source "ofac" is held by run run-a');
        expect((error as Error).message).toContain('stateNamespace ("default")');
        expect((error as Error).message).toContain('did not start');
        // run-b holds nothing: the free source it wrote is released again, run-a's lease is untouched
        expect(storage.peek('sec_enforcement')).toBeUndefined();
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a' });
    });

    it('takes over a lease whose holder has not renewed for longer than staleAfterMs when the platform cannot say', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        c.advance(15 * 60_000 + 1);
        await leases(storage, 'run-b', c).acquire(['ofac']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });

    it('does NOT take over just under the stale limit', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        c.advance(15 * 60_000 - 1_501);
        await expect(leases(storage, 'run-b', c).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
    });

    it('a holder the platform reports as live blocks even with an old heartbeat; one it reports as dead is overtaken at once', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        c.advance(60 * 60_000);
        await expect(leases(storage, 'run-b', c, { liveness: liveness({ 'run-a': 'live' }) }).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);

        const fresh = new InMemoryLeaseStorage();
        const c2 = clock();
        await leases(fresh, 'run-a', c2).acquire(['ofac']);
        c2.advance(1_000); // heartbeat is fresh, but the platform says the holder is gone (killed): no waiting for the heartbeat to age
        await leases(fresh, 'run-b', c2, { liveness: liveness({ 'run-a': 'dead' }) }).acquire(['ofac']);
        expect(fresh.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });

    it('falls back to the heartbeat when the platform check says unknown or throws', async () => {
        for (const verdict of ['unknown', new Error('403 forbidden')] as const) {
            const storage = new InMemoryLeaseStorage();
            const c = clock();
            await leases(storage, 'run-a', c).acquire(['ofac']);
            c.advance(1_000);
            await expect(leases(storage, 'run-b', c, { liveness: liveness({ 'run-a': verdict }) }).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
            c.advance(16 * 60_000);
            await leases(storage, 'run-b', c, { liveness: liveness({ 'run-a': verdict }) }).acquire(['ofac']);
        }
    });

    it('treats a lease record it cannot read as no lease, so a bad record never blocks a source forever', async () => {
        for (const bad of ['text', 5, [], { runId: '' }, { runId: 'x' }, { runId: 'x', heartbeatAt: 'not a date' }, { runId: 7, heartbeatAt: '2026-10-21T10:00:00.000Z' }]) {
            const storage = new InMemoryLeaseStorage();
            storage.poke('ofac', bad);
            await leases(storage, 'run-b').acquire(['ofac']);
            expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
        }
    });

    it('lets the same run id acquire again (a resurrected run after a migration) and keeps its original acquiredAt', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        c.advance(5 * 60_000);
        await leases(storage, 'run-a', c).acquire(['ofac']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a', acquiredAt: '2026-10-21T10:00:00.000Z' });
    });

    it('leases are per source: different sources of the same namespace never conflict', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        await leases(storage, 'run-a', c).acquire(['ofac']);
        await leases(storage, 'run-b', c).acquire(['sec_enforcement']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a' });
        expect(storage.peek('sec_enforcement')).toMatchObject({ runId: 'run-b' });
    });

    it('two runs that start at the same instant: both write, the settle delay lets the writes land, and the one whose id is not in the record backs off', async () => {
        const storage = new InMemoryLeaseStorage();
        // run-b's write lands during run-a's settle delay (it overwrites run-a's record): run-a must lose, run-b must win
        const c = clock();
        const a = new RunLeases(storage, {
            runId: 'run-a',
            namespace: 'default',
            now: c.now,
            sleep: async (ms) => {
                storage.poke('ofac', { runId: 'run-b', acquiredAt: c.now().toISOString(), heartbeatAt: c.now().toISOString() } satisfies LeaseRecord);
                c.advance(ms);
            },
        });
        const error = await a.acquire(['ofac']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseConflictError);
        expect((error as LeaseConflictError).conflicts[0]).toMatchObject({ source: 'ofac', holder: 'run-b' });
        // the winner's record is not deleted by the loser
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });

    it('concurrent starters on one storage: exactly one of two wins when their writes interleave', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        // both read "free", both write; the later write is the record both read back
        const make = (runId: string) => new RunLeases(storage, { runId, namespace: 'default', now: c.now, sleep: async () => undefined });
        const results = await Promise.allSettled([make('run-a').acquire(['ofac']), make('run-b').acquire(['ofac'])]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(LeaseConflictError);
        const winner = (storage.peek('ofac') as LeaseRecord).runId;
        expect(['run-a', 'run-b']).toContain(winner);
    });
});

describe('RunLeases.renewIfDue and release', () => {
    it('does nothing before the renewal interval, then refreshes the heartbeat and keeps acquiredAt', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        const a = leases(storage, 'run-a', c);
        await a.acquire(['ofac']);
        const writesAfterAcquire = storage.writes;
        c.advance(59_000);
        await a.renewIfDue();
        expect(storage.writes).toBe(writesAfterAcquire);
        c.advance(2_000);
        await a.renewIfDue();
        expect(storage.writes).toBe(writesAfterAcquire + 1);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-a', acquiredAt: '2026-10-21T10:00:00.000Z', heartbeatAt: '2026-10-21T10:01:02.500Z' });
    });

    it('a renewed lease is not taken over by a run that starts later', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        const a = leases(storage, 'run-a', c);
        await a.acquire(['ofac']);
        for (let i = 0; i < 40; i += 1) {
            c.advance(61_000);
            await a.renewIfDue();
        }
        await expect(leases(storage, 'run-b', c).acquire(['ofac'])).rejects.toBeInstanceOf(LeaseConflictError);
    });

    it('stops with LeaseLostError when the lease was taken over, and never overwrites the new holder', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        const a = leases(storage, 'run-a', c);
        await a.acquire(['ofac']);
        c.advance(20 * 60_000); // suspended for longer than the stale limit
        await leases(storage, 'run-b', c).acquire(['ofac']);
        c.advance(61_000);
        const error = await a.renewIfDue().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseLostError);
        expect(error).toBeInstanceOf(FatalConfigError);
        expect((error as Error).message).toContain('taken over by run run-b');
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });

    it('release removes only leases that are still this run\'s', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        const a = leases(storage, 'run-a', c);
        await a.acquire(['ofac', 'sec_enforcement']);
        storage.poke('sec_enforcement', { runId: 'run-b', acquiredAt: c.now().toISOString(), heartbeatAt: c.now().toISOString() });
        await a.release();
        expect(storage.peek('ofac')).toBeUndefined();
        expect(storage.peek('sec_enforcement')).toMatchObject({ runId: 'run-b' });
        // a second release is a no-op
        await a.release();
    });

    it('after release another run can take the lease immediately', async () => {
        const storage = new InMemoryLeaseStorage();
        const c = clock();
        const a = leases(storage, 'run-a', c);
        await a.acquire(['ofac']);
        await a.release();
        await leases(storage, 'run-b', c).acquire(['ofac']);
        expect(storage.peek('ofac')).toMatchObject({ runId: 'run-b' });
    });
});

describe('ApifyLeaseStorage', () => {
    class FakeKv implements KeyValueLike {
        readonly data = new Map<string, unknown>();
        async *keys(): AsyncIterable<string> {
            for (const key of [...this.data.keys()]) yield key;
        }
        async getValue(key: string): Promise<unknown> {
            return structuredClone(this.data.get(key));
        }
        async setValue(key: string, value: unknown): Promise<void> {
            if (value === null) this.data.delete(key);
            else this.data.set(key, structuredClone(value));
        }
    }

    it('keeps one record per source under lease.<namespace>.<source>, away from the memory and the journal, and deletes it with null', async () => {
        const kv = new FakeKv();
        const storage = new ApifyLeaseStorage('team-a', async () => kv);
        const record: LeaseRecord = { runId: 'r', acquiredAt: 't', heartbeatAt: 't' };
        await storage.write('ofac', record);
        expect([...kv.data.keys()]).toEqual(['lease.team-a.ofac']);
        expect(await storage.read('ofac')).toEqual(record);
        expect(await storage.read('sec')).toBeUndefined();
        await storage.remove('ofac');
        expect(kv.data.size).toBe(0);
    });

    it('separate namespaces keep separate leases', async () => {
        const kv = new FakeKv();
        const a = new RunLeases(new ApifyLeaseStorage('team-a', async () => kv), { runId: 'run-a', namespace: 'team-a', settleMs: 0 });
        const b = new RunLeases(new ApifyLeaseStorage('team-b', async () => kv), { runId: 'run-b', namespace: 'team-b', settleMs: 0 });
        await a.acquire(['ofac']);
        await b.acquire(['ofac']);
        expect([...kv.data.keys()].sort()).toEqual(['lease.team-a.ofac', 'lease.team-b.ofac']);
    });
});

describe('ApifyRunLiveness', () => {
    const check = (run: { status?: string } | undefined | Error) =>
        new ApifyRunLiveness(async () => {
            if (run instanceof Error) throw run;
            return run;
        }).check('r');

    it.each([['READY'], ['RUNNING'], ['TIMING-OUT'], ['ABORTING']])('%s is live', async (status) => {
        expect(await check({ status })).toBe('live');
    });

    it.each([['SUCCEEDED'], ['FAILED'], ['TIMED-OUT'], ['ABORTED']])('%s is dead', async (status) => {
        expect(await check({ status })).toBe('dead');
    });

    it('a run that no longer exists is dead; an unknown status, a missing status and an API error are unknown', async () => {
        expect(await check(undefined)).toBe('dead');
        expect(await check({ status: 'SOMETHING-NEW' })).toBe('unknown');
        expect(await check({})).toBe('unknown');
        expect(await check(new Error('403'))).toBe('unknown');
    });
});
