/**
 * Platform parity: the production runtime, run through the REAL Apify SDK and the REAL apify-client resource clients
 * "at home" (APIFY_IS_AT_HOME=1) against an in-process mock of the Apify REST API (test/support/mock_apify_platform.ts),
 * in child processes (test/support/platform_child.ts).
 *
 * Every other real-SDK test runs the SDK on LOCAL storage. On the platform the SDK uses apify-client's resource clients,
 * which differ in ways a local run cannot show: the key-value-store client has `listKeys` but no `keys()`; a record body
 * is JSON-parsed BY THE CLIENT, so a truncated JSON record throws `InvalidResponseBodyError` (after the client's retries)
 * instead of reading as `null`; `RunClient.get` turns a 404 of type `record-not-found` AND `record-or-token-not-found`
 * into `undefined`; the charge goes through `POST /v2/actor-runs/:id/charge`.
 *
 * These tests state the behaviour the runtime SHOULD have on the platform (the documented one: lib/state.ts, lib/lease.ts,
 * docs "a present-but-invalid record fails THAT SOURCE ONLY ... its siblings still run", "a record that cannot be read is
 * treated as no lease", "liveness is the platform's run status when it can be READ, otherwise the heartbeat").
 * Cases that depend on defects of the current code fail on purpose; the others pin behaviour that must not regress.
 *
 * Timing: every child runs with 2 client retries from 5 ms (`API_RETRIES`) and a 20 ms lease settle window; the client's
 * own default (8 retries from 500 ms) would make ONE unreadable record cost minutes. No fixed sleeps.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { MockApifyPlatform, type MockKeyValueStore, type MockPlatformOptions, ppePricingInfo, type RunBehaviour } from './support/mock_apify_platform.js';

vi.setConfig({ testTimeout: 45_000 });

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHILD = join(ROOT, 'test', 'support', 'platform_child.ts');

/** The delta-memory store of the stub engine (`${engine}-delta-state`). */
const STORE = 'global-regtech-compliance-feed-delta-state';
const NS = 'ns1';
const PRICES = { 'apify-actor-start': 0.005, 'doc-new': 0.01, 'doc-updated': 0.005, 'watchlist-hit': 0.15 };

interface StubRecord {
    recordId: string;
    fingerprint: string;
    payload: Record<string, unknown>;
    watchText: string;
}

type Sources = Record<string, StubRecord[] | { error: string }>;

interface SourceSummary {
    source: string;
    fetched: number;
    emitted: number;
    firstSeen: number;
    updated: number;
    unchanged: number;
    watchlistHits: number;
    warnings: string[];
    error?: string;
}

interface ChildResult {
    ok: boolean;
    summary?: {
        totalEmitted: number;
        stoppedOnChargeLimit: boolean;
        sources: SourceSummary[];
        watchlist: { accepted: number; rejected: number; hitsCharged: number; hitsUnpriced: number };
    };
    error?: { name: string; message: string; fatal: boolean; conflicts?: Array<{ source: string; holder: string; heartbeatAt: string }> };
    charged: Record<string, number>;
    logs: string[];
    exitCode?: number;
}

interface ChildRun {
    exitCode: number;
    result: ChildResult | null;
    stderr: string;
}

interface ChildOptions {
    runId: string;
    sources: Sources;
    ns?: string;
    input?: unknown;
    env?: Record<string, string>;
}

/** `count` records `<prefix>0..`; the indices in `hits` mention ACME CORP (a watchlist match). */
function rows(prefix: string, count: number, hits: readonly number[] = []): StubRecord[] {
    return Array.from({ length: count }, (_, i) => ({ recordId: `${prefix}${i}`, fingerprint: 'a', payload: { i }, watchText: hits.includes(i) ? 'ACME CORP filing' : 'other notice' }));
}

/** A valid delta-memory record that remembers `ids` (all with fingerprint `a`). */
function stateRecord(ids: readonly string[]): { seenIds: string[]; fingerprints: Record<string, string>; lastRunAt: string } {
    return { seenIds: [...ids].reverse(), fingerprints: Object.fromEntries(ids.map((id) => [id, 'a'])), lastRunAt: '2026-01-01T00:00:00.000Z' };
}

/** A valid lease record of run `runId` whose last heartbeat was `heartbeatAgoMs` ago. */
function leaseRecord(runId: string, heartbeatAgoMs: number): { runId: string; acquiredAt: string; heartbeatAt: string } {
    const heartbeatAt = new Date(Date.now() - heartbeatAgoMs).toISOString();
    return { runId, acquiredAt: heartbeatAt, heartbeatAt };
}

async function runChild(platform: MockApifyPlatform, options: ChildOptions): Promise<ChildRun> {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...platform.childEnv(),
        RUN_ID: options.runId,
        NS: options.ns ?? NS,
        SOURCES_JSON: JSON.stringify(options.sources),
        PRICING_INFO: JSON.stringify(ppePricingInfo(PRICES)),
        LEASE_SETTLE_MS: '20',
        LEASE_STALE_MS: '60000',
        ...(options.input !== undefined ? { INPUT_JSON: JSON.stringify(options.input) } : {}),
        ...options.env,
    };
    const parse = (stdout: string): ChildResult | null => {
        const line = stdout.split('\n').reverse().find((l) => l.startsWith('RESULT:'));
        return line ? (JSON.parse(line.slice('RESULT:'.length)) as ChildResult) : null;
    };
    try {
        const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', CHILD], { cwd: ROOT, env, timeout: 40_000, maxBuffer: 32 * 1024 * 1024 });
        return { exitCode: 0, result: parse(stdout), stderr };
    } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof e.code === 'number' ? e.code : 1, result: parse(e.stdout ?? ''), stderr: e.stderr ?? '' };
    }
}

/** What an assertion message should show about a child run. */
function why(childRun: ChildRun): string {
    const r = childRun.result;
    return JSON.stringify({
        exitCode: childRun.exitCode,
        ok: r?.ok,
        error: r?.error,
        sources: r?.summary?.sources.map((s) => ({ source: s.source, emitted: s.emitted, error: s.error })),
        stderrTail: childRun.stderr.slice(-600),
    });
}

/** Starts a mock platform, runs `body`, checks that the mock saw nothing it does not implement, and stops it. */
async function withPlatform(options: MockPlatformOptions, body: (platform: MockApifyPlatform) => Promise<void>): Promise<void> {
    const platform = await new MockApifyPlatform(options).start();
    try {
        await body(platform);
        expect(platform.unhandled, 'requests the mock does not implement').toEqual([]);
    } finally {
        await platform.stop();
    }
}

const sourceOf = (childRun: ChildRun, id: string): SourceSummary | undefined => childRun.result?.summary?.sources.find((s) => s.source === id);
const deliveredIds = (platform: MockApifyPlatform): string[] => platform.dataset.items.map((item) => String(item.record_id));
const key = (kind: 'state' | 'journal' | 'lease', source: string): string => `${kind}.${NS}.${source}`;

describe.concurrent('platform parity: a plain run at home', () => {
    it('(a) loads delta memory with the platform client, delivers rows, writes state and journal, clears the journal with a null write; a second run delivers nothing', async () => {
        await withPlatform({}, async (platform) => {
            const kv: MockKeyValueStore = platform.kv(STORE);
            const sources = { stub: rows('r', 6, [1]) };
            const input = { sources: ['stub'], watchlistNames: ['ACME CORP'] };

            const first = await runChild(platform, { runId: 'run-1', sources, input, env: { LEASE_RENEW_MS: '1' } });
            expect(first.result?.ok, why(first)).toBe(true);
            expect(first.result?.summary?.totalEmitted).toBe(6);
            expect(deliveredIds(platform)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);

            // The delta memory was LISTED through the platform client (a keys request that succeeded).
            expect(platform.requestsMatching({ method: 'GET', path: /\/keys$/ }).map((r) => r.status)).toEqual([200]);
            // State: one record for the source, remembering every delivered id.
            expect(kv.json<{ seenIds: string[] }>(key('state', 'stub'))?.seenIds.slice().sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
            // Journal: rewritten after each delivered row (one PUT per row), then cleared by a null write, which is a DELETE.
            const journalWrites = kv.writesTo(key('journal', 'stub'));
            expect(journalWrites.filter((w) => w.op === 'put')).toHaveLength(6);
            expect(journalWrites.at(-1)?.op).toBe('delete');
            expect(kv.has(key('journal', 'stub'))).toBe(false);
            // Lease: taken, renewed (LEASE_RENEW_MS=1 renews after every row), and released with a null write.
            const leaseWrites = kv.writesTo(key('lease', 'stub'));
            expect(leaseWrites.filter((w) => w.op === 'put').length).toBeGreaterThanOrEqual(2);
            expect(leaseWrites.at(-1)?.op).toBe('delete');
            expect(kv.has(key('lease', 'stub'))).toBe(false);
            // The run summary went to the DEFAULT store.
            expect(platform.defaultKv.json('RUN_SUMMARY')).toMatchObject({ totalEmitted: 6 });

            const chargesAfterFirst = platform.charges.calls.length;
            const second = await runChild(platform, { runId: 'run-2', sources, input });
            expect(second.result?.ok, why(second)).toBe(true);
            expect(second.result?.summary?.totalEmitted).toBe(0);
            expect(second.result?.summary?.sources[0]).toMatchObject({ fetched: 6, emitted: 0, unchanged: 6, firstSeen: 0 });
            expect(platform.dataset.items).toHaveLength(6);
            expect(platform.charges.calls).toHaveLength(chargesAfterFirst);
        });
    });

    it('(a2) runEngineMain at home: reads INPUT from the default store, delivers, releases its lease and exits 0', async () => {
        await withPlatform({ runId: 'run-main' }, async (platform) => {
            platform.defaultKv.setJson('INPUT', { sources: ['stub'], stateNamespace: NS });
            const main = await runChild(platform, { runId: 'run-main', sources: { stub: rows('r', 3) }, env: { ENTRY: 'main' } });
            expect(main.result?.ok, why(main)).toBe(true);
            expect(main.exitCode).toBe(0);
            expect(deliveredIds(platform)).toEqual(['r0', 'r1', 'r2']);
            expect(platform.kv(STORE).has(key('state', 'stub'))).toBe(true);
            expect(platform.kv(STORE).has(key('lease', 'stub'))).toBe(false);
        });
    });

    it('(a4) memory that spans several pages of the key listing is read completely, and keys of other namespaces are ignored', async () => {
        await withPlatform({ maxKeysPerPage: 2 }, async (platform) => {
            const kv = platform.kv(STORE);
            const ids = ['s1', 's2', 's3', 's4', 's5'];
            for (const id of ids) kv.setJson(key('state', id), stateRecord([`${id}-0`, `${id}-1`]));
            // Keys of other namespaces and kinds that sort BEFORE ours: a listing that stops at the first page sees only these.
            for (const other of ['journal.aaa.s1', 'lease.aaa.s1', 'state.aaa.s1', 'state.aaa.s2', 'state.ns0.s1']) kv.setJson(other, {});
            const sources = Object.fromEntries(ids.map((id) => [id, rows(`${id}-`, 2)]));
            const result = await runChild(platform, { runId: 'run-1', sources });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(result.result?.summary?.totalEmitted, 'every source must have found its memory').toBe(0);
            expect(platform.dataset.items).toEqual([]);
            expect(platform.requestsMatching({ method: 'GET', path: /\/keys$/ }).length, 'the listing was paginated').toBeGreaterThan(1);
        });
    });

    it('(a3) a pricing read from GET /v2/actor-runs/:id (instead of the environment) bills the same', async () => {
        await withPlatform({ runId: 'run-priced', pricingInfo: ppePricingInfo(PRICES), maxTotalChargeUsd: 50 }, async (platform) => {
            const result = await runChild(platform, { runId: 'run-priced', sources: { stub: rows('r', 4) }, env: { PRICING_VIA: 'run' } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(platform.charges.byEvent()).toEqual({ 'doc-new': 4 });
        });
    });
});

describe.concurrent('platform parity: unreadable (truncated) records fail the source, not the run', () => {
    it('(b4) with the client\'s DEFAULT retry settings a truncated state, journal and lease record cost no client retry: records are read as bytes, so none of them waits out the client\'s 2 to 4 minutes of backoff', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setTruncatedJson(key('state', 'a'), stateRecord(['a0', 'a1']));
            kv.setTruncatedJson(key('journal', 'b'), [{ recordId: 'b0', fingerprint: 'a' }]);
            kv.setTruncatedJson(key('lease', 'b'), { runId: 'dead', acquiredAt: 't', heartbeatAt: 't' });
            const started = Date.now();
            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 2), b: rows('b', 2), c: rows('c', 2) }, env: { API_RETRIES: 'default' } });
            expect(Date.now() - started, 'a stalled retry would take minutes (and the child is killed at 40 s)').toBeLessThan(30_000);
            expect(result.result?.ok, why(result)).toBe(true);
            expect(sourceOf(result, 'a')?.error).toContain(key('state', 'a'));
            expect(sourceOf(result, 'b')?.error).toContain(key('journal', 'b'));
            expect(sourceOf(result, 'c')).toMatchObject({ emitted: 2 });
            for (const k of [key('state', 'a'), key('journal', 'b'), key('lease', 'b')]) {
                // the lease is read a few times by design (take, second read, read-back, release); a retried body would add 8 more each
                expect(platform.requestsMatching({ method: 'GET', key: k }).length, `reads of ${k}`).toBeLessThanOrEqual(6);
            }
        });
    });

    it('(b) a truncated state record fails that source with an error naming key and store; the source with a valid record still runs', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setJson(key('state', 'a'), stateRecord(['a0', 'a1', 'a2']));
            kv.setTruncatedJson(key('state', 'b'), stateRecord(['b0', 'b1']));
            const truncated = kv.getRaw(key('state', 'b'))?.body.toString('utf8');
            expect(() => JSON.parse(truncated ?? '')).toThrow();

            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 5), b: rows('b', 3) } });
            expect(result.result?.ok, `the whole run must not die: ${why(result)}`).toBe(true);
            const b = sourceOf(result, 'b');
            expect(b?.error, 'source b must fail').toBeDefined();
            expect(b?.error).toContain(key('state', 'b'));
            expect(b?.error).toContain(STORE);
            expect(b?.emitted).toBe(0);
            // The healthy source delivered its two new records and remembered all five.
            expect(sourceOf(result, 'a')).toMatchObject({ emitted: 2, unchanged: 3, firstSeen: 2 });
            expect(sourceOf(result, 'a')?.error).toBeUndefined();
            expect(deliveredIds(platform)).toEqual(['a3', 'a4']);
            expect(kv.json<{ seenIds: string[] }>(key('state', 'a'))?.seenIds.slice().sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
            // The unreadable record is left alone for an operator (the error message tells them to delete it).
            expect(kv.getRaw(key('state', 'b'))?.body.toString('utf8')).toBe(truncated);
            expect(kv.writesTo(key('state', 'b'))).toEqual([]);
        });
    });

    it('(b1) runEngineMain: when the only source has an unreadable memory record the run ends FAILED (exit 1) with a status message that names the record and the store', async () => {
        await withPlatform({ runId: 'run-main' }, async (platform) => {
            platform.defaultKv.setJson('INPUT', { sources: ['stub'], stateNamespace: NS });
            platform.kv(STORE).setTruncatedJson(key('state', 'stub'), stateRecord(['r0', 'r1']));
            const main = await runChild(platform, { runId: 'run-main', sources: { stub: rows('r', 3) }, env: { ENTRY: 'main' } });
            expect(main.exitCode, why(main)).toBe(1);
            const status = platform.statusMessage('run-main') ?? '(no status message was set)';
            expect(status, 'terminal status message of the run').toContain(key('state', 'stub'));
            expect(status).toContain(STORE);
            expect(platform.dataset.items).toEqual([]);
            expect(platform.charges.calls).toEqual([]);
        });
    });

    it('(b2) control: a state record that is valid JSON of the wrong shape fails only that source (already handled)', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setJson(key('state', 'b'), { seenIds: ['b0'] });
            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 2), b: rows('b', 3) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(sourceOf(result, 'b')?.error).toContain(key('state', 'b'));
            expect(sourceOf(result, 'b')?.error).toContain(STORE);
            expect(sourceOf(result, 'a')?.emitted).toBe(2);
            expect(deliveredIds(platform)).toEqual(['a0', 'a1']);
        });
    });

    it('(b3) a state record with a non-JSON content type (text/plain, octet-stream) fails closed for that source only', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setRaw(key('state', 'b'), JSON.stringify(stateRecord(['b0'])), 'text/plain; charset=utf-8');
            kv.setRaw(key('state', 'c'), Buffer.from(JSON.stringify(stateRecord(['c0']))), 'application/octet-stream');
            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 2), b: rows('b', 2), c: rows('c', 2) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(sourceOf(result, 'b')?.error, 'text/plain record').toContain(key('state', 'b'));
            expect(sourceOf(result, 'c')?.error, 'octet-stream record').toContain(key('state', 'c'));
            expect(sourceOf(result, 'a')?.emitted).toBe(2);
            expect(deliveredIds(platform)).toEqual(['a0', 'a1']);
        });
    });

    it('(c) a truncated journal record fails only that source (the next source still runs)', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setTruncatedJson(key('journal', 'a'), [{ recordId: 'a0', fingerprint: 'a' }, { recordId: 'a1', fingerprint: 'a' }]);
            const truncated = kv.getRaw(key('journal', 'a'))?.body.toString('utf8');

            // `a` comes first: a run that dies on its journal never reaches `b`.
            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 3), b: rows('b', 3) } });
            expect(result.result?.ok, `the whole run must not die: ${why(result)}`).toBe(true);
            const a = sourceOf(result, 'a');
            expect(a?.error, 'source a must fail').toBeDefined();
            expect(a?.error).toContain(key('journal', 'a'));
            expect(a?.error).toContain(STORE);
            expect(a?.emitted).toBe(0);
            expect(sourceOf(result, 'b')).toMatchObject({ emitted: 3 });
            expect(deliveredIds(platform)).toEqual(['b0', 'b1', 'b2']);
            expect(kv.getRaw(key('journal', 'a'))?.body.toString('utf8')).toBe(truncated);
        });
    });

    it('(c2) a valid journal of an interrupted run is folded into the memory: its rows are not delivered again; the journal record is deleted', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setJson(key('journal', 'a'), [{ recordId: 'a0', fingerprint: 'a' }, { recordId: 'a1', fingerprint: 'a' }]);
            const result = await runChild(platform, { runId: 'run-1', sources: { a: rows('a', 4) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(deliveredIds(platform)).toEqual(['a2', 'a3']);
            expect(result.result?.logs.some((l) => l.includes('recovered 2 record(s) from the delivery journal'))).toBe(true);
            expect(kv.has(key('journal', 'a'))).toBe(false);
            expect(kv.json<{ seenIds: string[] }>(key('state', 'a'))?.seenIds.slice().sort()).toEqual(['a0', 'a1', 'a2', 'a3']);
        });
    });

    it('(d) a truncated lease record is treated as no lease: the run starts and overwrites it', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setTruncatedJson(key('lease', 'stub'), leaseRecord('run-dead', 0));
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 3) } });
            expect(result.result?.ok, `the run must start: ${why(result)}`).toBe(true);
            expect(result.result?.summary?.totalEmitted).toBe(3);
            // The bad record was replaced by a valid lease of this run (a PUT whose body parses and names run-1) ...
            const puts = kv.writesTo(key('lease', 'stub')).filter((w) => w.op === 'put');
            expect(puts.length).toBeGreaterThanOrEqual(1);
            expect(JSON.parse(puts[0]?.body?.toString('utf8') ?? 'null')).toMatchObject({ runId: 'run-1' });
            // ... and removed again when the run ended.
            expect(kv.has(key('lease', 'stub'))).toBe(false);
        });
    });

    it.each([
        ['valid JSON of the wrong shape', (kv: MockKeyValueStore) => kv.setJson(key('lease', 'stub'), { owner: 'someone' })],
        ['a text/plain body', (kv: MockKeyValueStore) => kv.setRaw(key('lease', 'stub'), 'locked by hand', 'text/plain; charset=utf-8')],
        ['an octet-stream body', (kv: MockKeyValueStore) => kv.setRaw(key('lease', 'stub'), Buffer.from([0, 1, 2, 3]), 'application/octet-stream')],
    ])('(d2) a lease record that is %s is treated as no lease', async (_label, seed) => {
        await withPlatform({}, async (platform) => {
            seed(platform.kv(STORE));
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 2) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(result.result?.summary?.totalEmitted).toBe(2);
            expect(platform.kv(STORE).has(key('lease', 'stub'))).toBe(false);
        });
    });
});

/** The platform's answers about the holder that the lease must treat as "alive" (a status) or as "cannot tell" (everything it cannot read). */
const LIVE_STATUSES = ['RUNNING', 'READY', 'TIMING-OUT', 'ABORTING'] as const;
const DEAD_STATUSES = ['FAILED', 'ABORTED', 'TIMED-OUT', 'SUCCEEDED'] as const;
const UNREADABLE: ReadonlyArray<{ label: string; behaviour: RunBehaviour }> = [
    { label: '404 record-not-found', behaviour: 'not-found' },
    { label: '404 record-or-token-not-found', behaviour: 'token-not-found' },
    { label: '403 insufficient permissions', behaviour: 403 },
];

describe.concurrent('platform parity: lease liveness through the real Actor.apifyClient', () => {
    /** Another run (`run-holder`) holds the lease of `stub`; `run-2` starts. */
    async function secondRun(behaviour: RunBehaviour, heartbeatAgoMs: number): Promise<{ platform: MockApifyPlatform; kv: MockKeyValueStore; child: ChildRun }> {
        const platform = await new MockApifyPlatform({ runId: 'run-2' }).start();
        const kv = platform.kv(STORE);
        kv.setJson(key('lease', 'stub'), leaseRecord('run-holder', heartbeatAgoMs));
        platform.setRunStatus('run-holder', behaviour);
        const child = await runChild(platform, { runId: 'run-2', sources: { stub: rows('r', 3) } });
        return { platform, kv, child };
    }

    function expectRefused({ platform, kv, child }: { platform: MockApifyPlatform; kv: MockKeyValueStore; child: ChildRun }): void {
        expect(child.result?.ok, 'the second run must refuse').toBe(false);
        expect(child.result?.error?.name, why(child)).toBe('LeaseConflictError');
        expect(child.result?.error?.fatal).toBe(true);
        expect(child.result?.error?.conflicts?.[0]).toMatchObject({ source: 'stub', holder: 'run-holder' });
        // Refused BEFORE any billable event or delivered row, and before the memory was read.
        expect(platform.dataset.items, 'no dataset push').toEqual([]);
        expect(platform.charges.calls, 'no charge').toEqual([]);
        expect(platform.requestsMatching({ path: /\/keys$/ }), 'memory not read').toEqual([]);
        // The holder's lease is untouched (a refused run never deletes the record of the run that holds it).
        expect(kv.json<{ runId: string }>(key('lease', 'stub'))?.runId).toBe('run-holder');
        expect(platform.unhandled).toEqual([]);
    }

    function expectTookOver({ platform, kv, child }: { platform: MockApifyPlatform; kv: MockKeyValueStore; child: ChildRun }): void {
        expect(child.result?.ok, why(child)).toBe(true);
        expect(child.result?.summary?.totalEmitted).toBe(3);
        expect(deliveredIds(platform)).toEqual(['r0', 'r1', 'r2']);
        const puts = kv.writesTo(key('lease', 'stub')).filter((w) => w.op === 'put');
        expect(JSON.parse(puts[0]?.body?.toString('utf8') ?? 'null')).toMatchObject({ runId: 'run-2' });
        expect(kv.has(key('lease', 'stub'))).toBe(false);
        expect(platform.unhandled).toEqual([]);
    }

    it.each(LIVE_STATUSES)('(e) holder %s with a fresh heartbeat: the second run refuses (LeaseConflictError) before any push or charge', async (status) => {
        const outcome = await secondRun(status, 0);
        try {
            expectRefused(outcome);
            // The status came from the platform (GET /v2/actor-runs/run-holder), through the real client.
            expect(outcome.platform.requestsMatching({ method: 'GET', path: /\/actor-runs\/run-holder$/ }).length).toBeGreaterThanOrEqual(1);
        } finally {
            await outcome.platform.stop();
        }
    });

    it('(e2) holder RUNNING with a STALE heartbeat: the platform status wins, the second run still refuses', async () => {
        const outcome = await secondRun('RUNNING', 10 * 60_000);
        try {
            expectRefused(outcome);
        } finally {
            await outcome.platform.stop();
        }
    });

    it.each(DEAD_STATUSES)('(e3) holder %s even with a fresh heartbeat: the second run takes over', async (status) => {
        const outcome = await secondRun(status, 0);
        try {
            expectTookOver(outcome);
            expect(outcome.platform.requestsMatching({ method: 'GET', path: /\/actor-runs\/run-holder$/ }).length).toBeGreaterThanOrEqual(1);
        } finally {
            await outcome.platform.stop();
        }
    });

    it.each(UNREADABLE)('(e4) holder status unreadable ($label) + FRESH heartbeat: liveness is unknown, the heartbeat decides, the second run refuses', async ({ behaviour }) => {
        const outcome = await secondRun(behaviour, 0);
        try {
            expectRefused(outcome);
        } finally {
            await outcome.platform.stop();
        }
    });

    it.each(UNREADABLE)('(e5) holder status unreadable ($label) + STALE heartbeat: the heartbeat decides, the second run takes over', async ({ behaviour }) => {
        const outcome = await secondRun(behaviour, 10 * 60_000);
        try {
            expectTookOver(outcome);
        } finally {
            await outcome.platform.stop();
        }
    });
});

describe.concurrent('platform parity: absent records and platform errors', () => {
    it('(f) a state, journal and lease record whose body is the JSON literal null are treated as absent', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            for (const kind of ['state', 'journal', 'lease'] as const) kv.setRaw(key(kind, 'stub'), 'null', 'application/json; charset=utf-8');
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 3) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(sourceOf(result, 'stub')?.error).toBeUndefined();
            expect(sourceOf(result, 'stub')).toMatchObject({ emitted: 3, firstSeen: 3 });
            expect(deliveredIds(platform)).toEqual(['r0', 'r1', 'r2']);
            expect(kv.json<{ seenIds: string[] }>(key('state', 'stub'))?.seenIds.slice().sort()).toEqual(['r0', 'r1', 'r2']);
            expect(kv.has(key('journal', 'stub'))).toBe(false);
            expect(kv.has(key('lease', 'stub'))).toBe(false);
        });
    });

    it.each(['state', 'journal'] as const)('(f2) an EMPTY %s record is a record that exists and cannot be read, not an absent one: its source fails and nothing is delivered', async (kind) => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setRaw(key(kind, 'stub'), '', 'application/json; charset=utf-8');
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 3) } });
            expect(sourceOf(result, 'stub')?.error, why(result)).toContain(key(kind, 'stub'));
            expect(deliveredIds(platform)).toEqual([]);
            expect(platform.charges.calls).toEqual([]);
        });
    });

    it('(f3) an EMPTY lease record is no lease: the run starts and overwrites it', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setRaw(key('lease', 'stub'), '', 'application/json; charset=utf-8');
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 2) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(deliveredIds(platform)).toEqual(['r0', 'r1']);
            expect(kv.has(key('lease', 'stub')), 'released at the end').toBe(false);
        });
    });

    it('(h) a transient 500 on reading the memory is retried by the client: the run still sees its memory and delivers nothing again', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setJson(key('state', 'stub'), stateRecord(['r0', 'r1', 'r2']));
            platform.failNext((r) => r.method === 'GET' && r.key === key('state', 'stub'), 1);
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 3) } });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(result.result?.summary?.totalEmitted).toBe(0);
            expect(platform.requestsMatching({ method: 'GET', key: key('state', 'stub') }).map((r) => r.status)).toEqual([500, 200]);
            expect(platform.dataset.items).toEqual([]);
        });
    });

    it('(h2) a persistent platform error on reading the memory fails the run; it is never read as "empty" (nothing delivered, nothing billed)', async () => {
        await withPlatform({}, async (platform) => {
            const kv = platform.kv(STORE);
            kv.setJson(key('state', 'stub'), stateRecord(['r0', 'r1', 'r2']));
            platform.failNext((r) => r.method === 'GET' && r.key === key('state', 'stub'), 100);
            const result = await runChild(platform, { runId: 'run-1', sources: { stub: rows('r', 3) } });
            expect(result.result?.ok).toBe(false);
            expect(platform.dataset.items).toEqual([]);
            expect(platform.charges.calls).toEqual([]);
            expect(kv.has(key('lease', 'stub')), 'the lease is released even though the run failed').toBe(false);
        });
    });
});

describe.concurrent('platform parity: charges through the real charge endpoint', () => {
    it('(g) bills one result event per delivered row and one watchlist-hit per proven match, row first, then the hit', async () => {
        await withPlatform({}, async (platform) => {
            const result = await runChild(platform, {
                runId: 'run-1',
                sources: { stub: rows('r', 8, [1, 5]) },
                input: { sources: ['stub'], watchlistNames: ['ACME CORP'] },
            });
            expect(result.result?.ok, why(result)).toBe(true);
            expect(platform.dataset.items).toHaveLength(8);
            expect(platform.charges.byEvent()).toEqual({ 'doc-new': 8, 'watchlist-hit': 2 });
            // One charge call per row (count 1), never a synthetic `apify-*` event.
            expect(platform.charges.calls.filter((c) => c.eventName === 'doc-new').map((c) => c.count)).toEqual(Array(8).fill(1));
            expect(platform.charges.calls.some((c) => c.eventName.startsWith('apify-'))).toBe(false);
            expect(platform.charges.calls.every((c) => c.runId === 'run-1' && c.idempotencyKey !== undefined && !c.duplicate)).toBe(true);
            expect(platform.charges.totalUsd(PRICES)).toBe(0.38);
            // The SDK's own ledger agrees with what the platform received.
            expect(result.result?.charged).toMatchObject({ 'doc-new': 8, 'watchlist-hit': 2 });
            // Order on the wire: items POST, then the row charge; the hit is charged after its row.
            const wire = platform.requests.filter((r) => /\/items$/.test(r.path) || /\/charge$/.test(r.path)).map((r) => (r.path.endsWith('/items') ? 'push' : 'charge'));
            expect(wire.slice(0, 4)).toEqual(['push', 'charge', 'push', 'charge']);
            const calls = platform.charges.calls.map((c) => c.eventName);
            expect(calls.slice(0, 3)).toEqual(['doc-new', 'doc-new', 'watchlist-hit']);
        });
    });

    it('(g2) the router decides: a per-run hit cap leaves the second hit flagged but unbilled; an unpriced hit event is never charged', async () => {
        await withPlatform({}, async (platform) => {
            const capped = await runChild(platform, {
                runId: 'run-1',
                sources: { stub: rows('r', 8, [1, 5]) },
                input: { sources: ['stub'], watchlistNames: ['ACME CORP'], maxWatchlistHitsPerRun: 1 },
            });
            expect(capped.result?.ok, why(capped)).toBe(true);
            expect(sourceOf(capped, 'stub')?.watchlistHits).toBe(2);
            expect(capped.result?.summary?.watchlist.hitsCharged).toBe(1);
            expect(platform.charges.count('watchlist-hit')).toBe(1);
            expect(platform.charges.count('doc-new')).toBe(8);
        });
        await withPlatform({}, async (platform) => {
            const withoutHit = Object.fromEntries(Object.entries(PRICES).filter(([name]) => name !== 'watchlist-hit'));
            const unpriced = await runChild(platform, {
                runId: 'run-1',
                sources: { stub: rows('r', 4, [1, 2]) },
                input: { sources: ['stub'], watchlistNames: ['ACME CORP'] },
                env: { PRICING_INFO: JSON.stringify(ppePricingInfo(withoutHit)) },
            });
            expect(unpriced.result?.ok, why(unpriced)).toBe(true);
            expect(unpriced.result?.summary?.watchlist.hitsUnpriced).toBe(2);
            expect(platform.charges.byEvent()).toEqual({ 'doc-new': 4 });
        });
    });

    it('(g3) a budget stops the run at the limit with nothing lost: the next run delivers exactly the rest', async () => {
        await withPlatform({}, async (platform) => {
            // doc-new is $0.01: a $0.05 budget pays for five rows.
            const sources = { stub: rows('r', 8) };
            const first = await runChild(platform, { runId: 'run-1', sources, env: { MAX_TOTAL_CHARGE_USD: '0.05' } });
            expect(first.result?.ok, why(first)).toBe(true);
            expect(first.result?.summary?.stoppedOnChargeLimit).toBe(true);
            expect(platform.dataset.items).toHaveLength(5);
            expect(platform.charges.count('doc-new')).toBe(5);
            expect(platform.charges.totalUsd(PRICES)).toBeLessThanOrEqual(0.05);

            const second = await runChild(platform, { runId: 'run-2', sources });
            expect(second.result?.ok, why(second)).toBe(true);
            expect(deliveredIds(platform)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
            expect(platform.charges.count('doc-new')).toBe(8);
        });
    });
});
