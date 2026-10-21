/**
 * Billing and delta-memory behaviour against the REAL Apify SDK (ChargingManager, pushData, local storage), run in
 * child processes (test/support/sdk_child.ts). These are the guarantees the strategy document claims, checked
 * end to end:
 *
 *   - every row that is pushed is billed exactly once, at its own event; a watchlist-hit is billed once per proven match;
 *   - a poisoned watchlist produces no hit and no charge;
 *   - a budget limit stops the run and loses nothing (the next run delivers the rest, with no duplicate);
 *   - a pricing that prices `apify-default-dataset-item` is refused before any row is pushed;
 *   - a hard kill repeats (delivers AND bills again) at most the one row in flight, thanks to the delivery journal;
 *     a platform error mid-run repeats none.
 *
 * Local-mode caveat, from the SDK source (charging.js calculateEventPrice): outside the platform the number of rows
 * a budget still allows is computed with a price of $1 per event, while the amount actually accumulated uses the
 * configured price. The budget scenario therefore prices its event at exactly $1, where both agree and the numbers
 * are the real platform's; the other scenarios assert invariants (billed == pushed, nothing lost or duplicated).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHILD = join(ROOT, 'test', 'support', 'sdk_child.ts');

const PRICES = {
    'apify-actor-start': 0.005,
    'doc-new': 0.01,
    'doc-updated': 0.005,
    'watchlist-hit': 0.15,
};

function pricingInfo(extra: Record<string, number> = {}, drop: string[] = []): string {
    const prices: Record<string, number> = { ...PRICES, ...extra };
    for (const key of drop) delete prices[key];
    return JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: Object.fromEntries(Object.entries(prices).map(([name, eventPriceUsd]) => [name, { eventTitle: name, eventDescription: name, eventPriceUsd }])) },
    });
}

interface ChildResult {
    ok: boolean;
    error?: string;
    fatal?: boolean;
    pushed: number;
    charged: Record<string, number>;
    summary?: {
        stoppedOnChargeLimit: boolean;
        totalEmitted: number;
        watchlist: { accepted: number; rejected: number; hitsCharged: number; hitsUnpriced: number };
        pricing: { unpricedEvents: string[] };
        sources: Array<{ emitted: number; firstSeen: number; watchlistHits: number }>;
    };
}

interface Sandbox {
    dir: string;
    pushLog: string;
    pushes(runLabel?: string): Array<{ run: string; event: string | null; record_id: string }>;
}

function sandbox(): Sandbox {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-it-'));
    const pushLog = join(dir, 'pushlog.jsonl');
    return {
        dir,
        pushLog,
        pushes(runLabel) {
            if (!existsSync(pushLog)) return [];
            const lines = readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { run: string; event: string | null; record_id: string });
            return runLabel ? lines.filter((l) => l.run === runLabel) : lines;
        },
    };
}

async function child(sb: Sandbox, runLabel: string, env: Record<string, string>): Promise<{ exitCode: number; result: ChildResult | null; stderr: string }> {
    const base: NodeJS.ProcessEnv = {
        ...process.env,
        CRAWLEE_STORAGE_DIR: sb.dir,
        APIFY_LOCAL_STORAGE_DIR: sb.dir,
        PUSHLOG: sb.pushLog,
        RUN_LABEL: runLabel,
        ...env,
    };
    for (const key of ['ACTOR_TEST_PAY_PER_EVENT', 'APIFY_ACTOR_PRICING_INFO', 'ACTOR_MAX_TOTAL_CHARGE_USD', 'APIFY_CHARGED_ACTOR_EVENT_COUNTS']) if (env[key] === undefined) delete base[key];
    try {
        const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', CHILD], { cwd: ROOT, env: base, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
        const line = stdout.split('\n').reverse().find((l) => l.startsWith('RESULT:'));
        return { exitCode: 0, result: line ? (JSON.parse(line.slice('RESULT:'.length)) as ChildResult) : null, stderr };
    } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        const line = (e.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('RESULT:'));
        return { exitCode: typeof e.code === 'number' ? e.code : 1, result: line ? (JSON.parse(line.slice('RESULT:'.length)) as ChildResult) : null, stderr: e.stderr ?? '' };
    }
}

const ppe = (extra: Record<string, string> = {}, pricing = pricingInfo()): Record<string, string> => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    APIFY_ACTOR_PRICING_INFO: pricing,
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
    ...extra,
});

describe('real Apify SDK: billing', () => {
    it('bills each pushed row exactly once at its own event, and watchlist-hit once per proven match', async () => {
        const sb = sandbox();
        const { exitCode, result } = await child(sb, 'A', ppe({ ROWS: '10', MATCH_EVERY: '5', INPUT_JSON: JSON.stringify({ sources: ['stub'], watchlistNames: ['Acme Corp'] }) }));
        expect(exitCode).toBe(0);
        expect(result?.ok).toBe(true);
        expect(result?.pushed).toBe(10);
        expect(sb.pushes().every((p) => p.event === 'doc-new')).toBe(true);
        expect(result?.charged['doc-new']).toBe(10);
        // rows 0 and 5 mention ACME CORP
        expect(result?.charged['watchlist-hit']).toBe(2);
        expect(result?.summary?.watchlist.hitsCharged).toBe(2);
        expect(result?.summary?.pricing.unpricedEvents).toEqual([]);
        expect(new Set(sb.pushes().map((p) => p.record_id)).size).toBe(10);
    }, 120_000);

    it('a poisoned watchlist (empty, blank, one letter) produces no hit and no watchlist-hit charge', async () => {
        const sb = sandbox();
        const { result } = await child(sb, 'A', ppe({ ROWS: '10', MATCH_EVERY: '1', INPUT_JSON: JSON.stringify({ sources: ['stub'], watchlistNames: ['', ' ', 'a', ['x']] }) }));
        expect(result?.ok).toBe(true);
        expect(result?.pushed).toBe(10);
        expect(result?.charged['watchlist-hit']).toBe(0);
        expect(result?.summary?.watchlist).toMatchObject({ accepted: 0, hitsCharged: 0 });
    }, 120_000);

    it('outside pay-per-event rows are delivered and nothing is charged', async () => {
        const sb = sandbox();
        const { result } = await child(sb, 'A', { ROWS: '10', INPUT_JSON: JSON.stringify({ sources: ['stub'], watchlistNames: ['Acme'] }) });
        expect(result?.ok).toBe(true);
        expect(result?.pushed).toBe(10);
        expect(result?.charged['doc-new']).toBe(0);
        expect(result?.charged['watchlist-hit']).toBe(0);
    }, 120_000);

    it('an event with no price is delivered unbilled, recorded on the summary, and never requested from the SDK', async () => {
        const sb = sandbox();
        const { result, stderr } = await child(sb, 'A', ppe({ ROWS: '10' }, pricingInfo({}, ['doc-new'])));
        expect(result?.ok).toBe(true);
        expect(result?.pushed).toBe(10);
        expect(result?.charged['doc-new']).toBe(0);
        expect(result?.summary?.pricing.unpricedEvents).toEqual(['doc-new']);
        expect(stderr).not.toMatch(/Attempting to charge for an unknown event/);
        expect(sb.pushes().every((p) => p.event === null)).toBe(true);
    }, 120_000);

    it('refuses a pricing that prices apify-default-dataset-item (double billing) before any row is pushed', async () => {
        const sb = sandbox();
        const { result } = await child(sb, 'A', ppe({ ROWS: '10' }, pricingInfo({ 'apify-default-dataset-item': 0.001 })));
        expect(result?.ok).toBe(false);
        expect(result?.fatal).toBe(true);
        expect(result?.error).toMatch(/billed twice/);
        expect(result?.pushed).toBe(0);
        expect(sb.pushes()).toHaveLength(0);
    }, 120_000);

    it('a budget limit stops the run, bills exactly what was pushed, and the next run delivers the rest with no duplicate', async () => {
        const sb = sandbox();
        const dollarEvent = pricingInfo({ 'doc-new': 1 });
        const first = await child(sb, 'A', ppe({ ROWS: '12', ACTOR_MAX_TOTAL_CHARGE_USD: '6' }, dollarEvent));
        expect(first.result?.ok).toBe(true);
        expect(first.result?.summary?.stoppedOnChargeLimit).toBe(true);
        const deliveredA = sb.pushes('A').length;
        // a $6 budget at $1 per row: exactly six rows, then the run stops
        expect(deliveredA).toBe(6);
        // billed exactly what was pushed
        expect(first.result?.charged['doc-new']).toBe(deliveredA);

        const second = await child(sb, 'B', ppe({ ROWS: '12' }, dollarEvent));
        expect(second.result?.ok).toBe(true);
        const ids = sb.pushes().map((p) => p.record_id);
        expect(new Set(ids).size).toBe(12);
        expect(ids).toHaveLength(12);
    }, 180_000);
});

describe('real Apify SDK: retries, kills and platform errors', () => {
    // Every row is pushed with its event, and the SDK bills that event inside `pushData`: one push line == one charge.
    const billedRows = (sb: Sandbox) => sb.pushes().filter((p) => p.event === 'doc-new').length;
    const overBilledRows = (sb: Sandbox) => {
        const counts = new Map<string, number>();
        for (const p of sb.pushes()) counts.set(p.record_id, (counts.get(p.record_id) ?? 0) + 1);
        return [...counts.values()].reduce((sum, n) => sum + (n - 1), 0);
    };

    it('a hard kill right after a push re-delivers AND re-bills only that one row in flight, and loses none', async () => {
        const sb = sandbox();
        const killed = await child(sb, 'A', ppe({ ROWS: '60', KILL_AFTER: '40' }));
        expect(killed.exitCode).toBe(137);
        expect(sb.pushes('A')).toHaveLength(40);

        const rerun = await child(sb, 'B', ppe({ ROWS: '60' }));
        expect(rerun.result?.ok).toBe(true);
        const all = sb.pushes().map((p) => p.record_id);
        expect(new Set(all).size).toBe(60);
        // Rows 1..39 were in the delivery journal; only row 40 (pushed and billed, journal write not reached) repeats.
        // Before the journal this was 15 rows: everything since the checkpoint after row 25.
        expect(overBilledRows(sb)).toBe(1);
        expect(billedRows(sb)).toBe(61);
        expect(rerun.result?.summary?.sources[0]?.emitted).toBe(21);
    }, 180_000);

    it('a hard kill after the journal write repeats nothing: no duplicate delivery, no second charge', async () => {
        const sb = sandbox();
        const killed = await child(sb, 'A', ppe({ ROWS: '60', KILL_AFTER_JOURNAL: '40' }));
        expect(killed.exitCode).toBe(137);
        expect(sb.pushes('A')).toHaveLength(40);

        const rerun = await child(sb, 'B', ppe({ ROWS: '60' }));
        expect(rerun.result?.ok).toBe(true);
        expect(new Set(sb.pushes().map((p) => p.record_id)).size).toBe(60);
        expect(overBilledRows(sb)).toBe(0);
        expect(billedRows(sb)).toBe(60);
    }, 180_000);

    it('the journal never lets a kill repeat more than one row, wherever in the run it lands', async () => {
        for (const killAt of [1, 2, 24, 25, 26, 49, 50, 51]) {
            const sb = sandbox();
            const killed = await child(sb, 'A', ppe({ ROWS: '60', KILL_AFTER: String(killAt) }));
            expect(killed.exitCode).toBe(137);
            const rerun = await child(sb, 'B', ppe({ ROWS: '60' }));
            expect(rerun.result?.ok).toBe(true);
            expect(new Set(sb.pushes().map((p) => p.record_id)).size).toBe(60);
            expect(overBilledRows(sb), `kill after push ${killAt}`).toBeLessThanOrEqual(1);
            expect(billedRows(sb), `kill after push ${killAt}`).toBeLessThanOrEqual(61);
        }
    }, 300_000);

    it('a platform error mid-run is remembered: nothing already pushed is delivered or billed again', async () => {
        const sb = sandbox();
        const failed = await child(sb, 'A', ppe({ ROWS: '10', FAIL_PUSH_AT: '8' }));
        expect(failed.result?.ok).toBe(false);
        expect(failed.result?.error).toMatch(/platform dataset error/);
        expect(sb.pushes('A')).toHaveLength(7);

        const rerun = await child(sb, 'B', ppe({ ROWS: '10' }));
        expect(rerun.result?.ok).toBe(true);
        const all = sb.pushes().map((p) => p.record_id);
        expect(all).toHaveLength(10);
        expect(new Set(all).size).toBe(10);
        expect(rerun.result?.charged['doc-new']).toBe(3);
    }, 180_000);

    it('an unchanged re-run delivers and bills nothing', async () => {
        const sb = sandbox();
        await child(sb, 'A', ppe({ ROWS: '10' }));
        const again = await child(sb, 'B', ppe({ ROWS: '10' }));
        expect(again.result?.ok).toBe(true);
        expect(again.result?.pushed).toBe(0);
        expect(again.result?.charged['doc-new']).toBe(0);
    }, 180_000);

    it('separate namespaces keep separate memory (two Tasks do not consume each other\'s new records)', async () => {
        const sb = sandbox();
        await child(sb, 'A', ppe({ ROWS: '5', NS: 'task-a' }));
        const other = await child(sb, 'B', ppe({ ROWS: '5', NS: 'task-b' }));
        expect(other.result?.pushed).toBe(5);
        const same = await child(sb, 'C', ppe({ ROWS: '5', NS: 'task-a' }));
        expect(same.result?.pushed).toBe(0);
    }, 180_000);
});

describe('real Apify SDK: overlapping runs of the same namespace (run leases)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const billedRows = (sb: Sandbox) => sb.pushes().filter((p) => p.event === 'doc-new').length;
    const leased = (extra: Record<string, string>) => ppe({ LEASES: '1', LEASE_SETTLE_MS: '300', ...extra });

    it('a second process started while the first is still delivering is refused before it pushes or bills anything; the first delivers every row exactly once', async () => {
        const sb = sandbox();
        const first = child(sb, 'A', leased({ ROWS: '40', ROW_DELAY_MS: '60', RUN_ID: 'run-a' }));
        await sleep(1_800); // past the lease acquisition and the first rows of A
        const second = await child(sb, 'B', leased({ ROWS: '40', RUN_ID: 'run-b' }));
        expect(second.result?.ok).toBe(false);
        expect(second.result?.fatal).toBe(true);
        expect(second.result?.error).toMatch(/Another run is already delivering into the same delta memory/);
        expect(second.result?.error).toMatch(/source "stub" is held by run run-a/);
        expect(second.result?.pushed).toBe(0);
        const done = await first;
        expect(done.result?.ok).toBe(true);
        expect(sb.pushes('B')).toHaveLength(0);
        const ids = sb.pushes().map((p) => p.record_id);
        expect(ids).toHaveLength(40);
        expect(new Set(ids).size).toBe(40);
        expect(billedRows(sb)).toBe(40);
    }, 180_000);

    it('without leases the same overlap delivers and bills the same rows twice (the control that shows what the lease prevents)', async () => {
        const sb = sandbox();
        const first = child(sb, 'A', ppe({ ROWS: '40', ROW_DELAY_MS: '60' }));
        await sleep(1_800);
        const second = child(sb, 'B', ppe({ ROWS: '40', ROW_DELAY_MS: '60' }));
        await Promise.all([first, second]);
        expect(sb.pushes().length).toBeGreaterThan(40);
        expect(billedRows(sb)).toBeGreaterThan(40);
    }, 180_000);

    it('the lease is released when the run ends: the next run starts at once and finds nothing new', async () => {
        const sb = sandbox();
        const first = await child(sb, 'A', leased({ ROWS: '10', RUN_ID: 'run-a' }));
        expect(first.result?.ok).toBe(true);
        const second = await child(sb, 'B', leased({ ROWS: '10', RUN_ID: 'run-b' }));
        expect(second.result?.ok).toBe(true);
        expect(second.result?.pushed).toBe(0);
    }, 180_000);

    it('the lease of a killed run does not block for ever: once its heartbeat is older than the stale limit the next run takes over, recovers the journal and repeats at most the row in flight', async () => {
        const sb = sandbox();
        const killed = await child(sb, 'A', leased({ ROWS: '30', KILL_AFTER: '12', RUN_ID: 'run-a', LEASE_STALE_MS: '1500' }));
        expect(killed.exitCode).toBe(137);
        const tooSoon = await child(sb, 'B', leased({ ROWS: '30', RUN_ID: 'run-b', LEASE_STALE_MS: '60000' }));
        expect(tooSoon.result?.error).toMatch(/held by run run-a/);
        await sleep(1_700);
        const taken = await child(sb, 'C', leased({ ROWS: '30', RUN_ID: 'run-c', LEASE_STALE_MS: '1500' }));
        expect(taken.result?.ok).toBe(true);
        const ids = sb.pushes().map((p) => p.record_id);
        expect(new Set(ids).size).toBe(30);
        expect(ids.length - new Set(ids).size).toBeLessThanOrEqual(1);
    }, 180_000);

    it('different namespaces overlap freely', async () => {
        const sb = sandbox();
        const first = child(sb, 'A', leased({ ROWS: '20', ROW_DELAY_MS: '40', RUN_ID: 'run-a', NS: 'team-a' }));
        await sleep(1_500);
        const second = await child(sb, 'B', leased({ ROWS: '20', RUN_ID: 'run-b', NS: 'team-b' }));
        expect(second.result?.ok).toBe(true);
        expect((await first).result?.ok).toBe(true);
        expect(sb.pushes()).toHaveLength(40);
    }, 180_000);
});

describe('real Apify SDK: run status through runEngineMain', () => {
    const MAIN_CHILD = join(ROOT, 'test', 'support', 'main_child.ts');

    async function mainRun(mode: string, input: Record<string, unknown>): Promise<{ exitCode: number; output: string; summary: { sources: Array<{ error?: string }> } | null }> {
        const dir = mkdtempSync(join(tmpdir(), 'sdk-main-'));
        mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
        writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
        const env: NodeJS.ProcessEnv = { ...process.env, CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, MODE: mode };
        for (const key of ['ACTOR_TEST_PAY_PER_EVENT', 'APIFY_ACTOR_PRICING_INFO', 'ACTOR_MAX_TOTAL_CHARGE_USD', 'APIFY_CHARGED_ACTOR_EVENT_COUNTS']) delete env[key];
        let exitCode = 0;
        let output = '';
        try {
            const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', MAIN_CHILD], { cwd: ROOT, env, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
            output = `${stdout}\n${stderr}`;
        } catch (error) {
            const e = error as { code?: number; stdout?: string; stderr?: string };
            exitCode = typeof e.code === 'number' ? e.code : 1;
            output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
        }
        const summaryPath = join(dir, 'key_value_stores', 'default', 'RUN_SUMMARY.json');
        return { exitCode, output, summary: existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as { sources: Array<{ error?: string }> }) : null };
    }

    it('ends FAILED, with the per-source errors in the message, when every selected source fails', async () => {
        const result = await mainRun('all-fail', { sources: ['down_a', 'down_b'] });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toMatch(/All 2 selected source\(s\) failed and nothing was delivered/);
        expect(result.output).toMatch(/down_a: upstream 503/);
        // the summary was still written, so the failure can be inspected
        expect(result.summary?.sources.map((s) => s.error)).toEqual(['upstream 503', 'connect timeout']);
    }, 120_000);

    it('ends SUCCEEDED when one source fails but another delivers (failures stay isolated)', async () => {
        const result = await mainRun('partial-fail', { sources: ['down_a', 'up'] });
        expect(result.exitCode).toBe(0);
        expect(result.summary?.sources.map((s) => s.error)).toEqual(['upstream 503', undefined]);
    }, 120_000);

    it('ends SUCCEEDED when a healthy source simply has nothing to report', async () => {
        const result = await mainRun('empty-ok', { sources: ['empty'] });
        expect(result.exitCode).toBe(0);
    }, 120_000);
});
