/**
 * Regression tests for the confirmed findings of the adversarial review (ids in the test names).
 * Each test reproduces the failing scenario through the public entry points.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findKeywordMatch, normaliseKeyword, sanitizeKeywordList } from '../lib/_guards.js';
import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT, WatchlistHitBiller } from '../lib/charging.js';
import { fingerprintOf } from '../lib/connector_helpers.js';
import {
    CHECKPOINT_EVERY_ROWS,
    checkRuntimePricing,
    type EngineDefinition,
    mergeCredentialFields,
    resolveSources,
    runEngine,
    type RunSinks,
} from '../lib/router_core.js';
import { classifyRecord, createEmptyState, effectiveMaxSeenIds, InMemoryDeltaStore, markProcessed, MAX_SEEN_IDS_HARD_CEILING, type DeltaState, type SourceDeltaState } from '../lib/state.js';
import type { Connector, ConnectorContext, SourceRecord } from '../lib/types.js';

const logs: string[] = [];
const ctx: ConnectorContext = {
    http: {
        async getText() {
            throw new Error('no network');
        },
        async getJson() {
            throw new Error('no network');
        },
    },
    log: { info: (m) => logs.push(m), warning: (m) => logs.push(m), error: (m) => logs.push(m), debug: (m) => logs.push(m) },
    now: () => new Date('2026-10-21T00:00:00Z'),
};
const clock = () => new Date('2026-10-21T00:00:00Z');

const rec = (id: string, fp = 'a', watchText?: string): SourceRecord => ({ recordId: id, fingerprint: fp, payload: { t: id }, watchText });
const feed = (n: number, fp = 'a'): SourceRecord[] => Array.from({ length: n }, (_, i) => rec(`id-${i}`, fp));

function stub(id: string, records: SourceRecord[] | (() => Promise<SourceRecord[]>), extra: Partial<Connector<any>> = {}): Connector<any> {
    return {
        id,
        engine: 'global-regtech-compliance-feed',
        legacyActor: `legacy-${id}`,
        description: id,
        status: 'active',
        optionsSchema: z.object({ token: z.string().optional(), apiKey: z.string().optional() }).passthrough(),
        async fetch() {
            return typeof records === 'function' ? records() : records;
        },
        ...extra,
    };
}
const engineOf = (...connectors: Array<Connector<any>>): EngineDefinition => ({ slug: 'global-regtech-compliance-feed', connectors });

/** A store that, like the Apify one, can persist a single source without rewriting the whole document. */
class SourceAwareStore extends InMemoryDeltaStore {
    readonly savedSources: string[] = [];

    async saveSource(source: string, entry: SourceDeltaState): Promise<void> {
        this.savedSources.push(source);
        const current: DeltaState = this.peek();
        await this.save({ ...current, sources: { ...current.sources, [source]: entry } });
    }
}

function harness(opts: { ppe?: boolean; prices?: Record<string, number>; budgetUsd?: number; store?: InMemoryDeltaStore; failEmitAt?: number; withSaveSource?: boolean } = {}) {
    const billing = new FakeBilling(opts.ppe ?? true, opts.prices ?? { result: 0.001, 'watchlist-hit': 0.15 }, opts.budgetUsd);
    const store = opts.store ?? (opts.withSaveSource ? new SourceAwareStore() : new InMemoryDeltaStore());
    const rows: Array<Record<string, unknown>> = [];
    let emits = 0;
    const sinks: RunSinks = {
        async emit(row, eventName = RESULT_EVENT) {
            emits += 1;
            if (opts.failEmitAt !== undefined && emits === opts.failEmitAt) throw new Error('dataset push failed (HTTP 500)');
            const r = await billing.charge(eventName, 1);
            if (r.chargedCount < 1) return { emitted: false, limitReached: true };
            rows.push(row);
            return { emitted: true, limitReached: r.eventChargeLimitReached };
        },
        billing,
        store,
        async saveSummary() {},
    };
    return { sinks, rows, billing, store };
}

describe('B1 / DI-2: delta memory is sized to what one run can deliver', () => {
    it('effectiveMaxSeenIds: connector cap is authoritative; otherwise max(default, maxItems, previous) up to the hard ceiling', () => {
        expect(effectiveMaxSeenIds(8, 10_000, 99)).toBe(8);
        expect(effectiveMaxSeenIds(undefined, 500, 0)).toBe(5000);
        expect(effectiveMaxSeenIds(undefined, 10_000, 0)).toBe(10_000);
        expect(effectiveMaxSeenIds(undefined, 500, 8000)).toBe(8000);
        expect(effectiveMaxSeenIds(undefined, 10_000, 90_000)).toBe(MAX_SEEN_IDS_HARD_CEILING);
    });

    it('an 8,000-record feed with maxItemsPerSource=10000 is delivered once and then stays unchanged', async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(stub('big', feed(8000)));
        const first = harness({ store, prices: { result: 0.001 } });
        await runEngine(engine, { sources: ['big'], maxItemsPerSource: 10_000 }, { sinks: first.sinks, ctx, clock });
        expect(first.rows).toHaveLength(8000);
        for (let run = 0; run < 3; run += 1) {
            const again = harness({ store, prices: { result: 0.001 } });
            await runEngine(engine, { sources: ['big'], maxItemsPerSource: 10_000 }, { sinks: again.sinks, ctx, clock });
            expect(again.rows, `run ${run + 2}`).toHaveLength(0);
            expect(again.billing.calls).toHaveLength(0);
        }
    });

    it('a later run with a small maxItemsPerSource does not shrink the memory and re-bill the rest', async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(stub('big', feed(8000)));
        await runEngine(engine, { sources: ['big'], maxItemsPerSource: 10_000 }, { sinks: harness({ store }).sinks, ctx, clock });
        await runEngine(engine, { sources: ['big'], maxItemsPerSource: 500 }, { sinks: harness({ store }).sinks, ctx, clock });
        const third = harness({ store });
        await runEngine(engine, { sources: ['big'], maxItemsPerSource: 10_000 }, { sinks: third.sinks, ctx, clock });
        expect(third.rows).toHaveLength(0);
    });
});

describe('B4 / DI-1: delta memory survives a failure after rows were already pushed and billed', () => {
    it('remembers the rows pushed before an emit exception, so a rerun does not deliver (or bill) them again', async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(stub('s', feed(6)));
        const failing = harness({ store, failEmitAt: 4 });
        await expect(runEngine(engine, { sources: ['s'] }, { sinks: failing.sinks, ctx, clock })).rejects.toThrow('dataset push failed');
        expect(failing.rows.map((r) => r.record_id)).toEqual(['id-0', 'id-1', 'id-2']);
        expect(store.peek().sources.s?.seenIds.sort()).toEqual(['id-0', 'id-1', 'id-2']);

        const rerun = harness({ store });
        await runEngine(engine, { sources: ['s'] }, { sinks: rerun.sinks, ctx, clock });
        expect(rerun.rows.map((r) => r.record_id)).toEqual(['id-3', 'id-4', 'id-5']);
    });

    it(`checkpoints every ${CHECKPOINT_EVERY_ROWS} emitted rows, so a hard kill can duplicate at most that many`, async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(stub('s', feed(CHECKPOINT_EVERY_ROWS * 3 + 5)));
        const h = harness({ store, failEmitAt: CHECKPOINT_EVERY_ROWS * 2 + 3 });
        const savesBefore = store.saves;
        await expect(runEngine(engine, { sources: ['s'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow();
        // two periodic checkpoints plus the one in `finally`
        expect(store.saves - savesBefore).toBeGreaterThanOrEqual(3);
        expect(store.peek().sources.s?.seenIds).toHaveLength(CHECKPOINT_EVERY_ROWS * 2 + 2);
    });

    it('a failing state save does not mask the original error', async () => {
        const store = new InMemoryDeltaStore();
        store.save = async () => {
            throw new Error('kv store unavailable');
        };
        const h = harness({ store, failEmitAt: 2 });
        await expect(runEngine(engineOf(stub('s', feed(3))), { sources: ['s'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow('dataset push failed');
        expect(logs.join('\n')).toContain('could not persist delta memory');
    });

    it('uses saveSource when the store offers it, so overlapping runs never rewrite each other\'s sources (DI-3)', async () => {
        const store = new SourceAwareStore();
        const h = harness({ store });
        await runEngine(engineOf(stub('a', feed(2)), stub('b', feed(2))), { sources: ['a', 'b'] }, { sinks: h.sinks, ctx, clock });
        expect(store.savedSources.sort()).toEqual(['a', 'b']);
        expect(Object.keys(store.peek().sources).sort()).toEqual(['a', 'b']);
    });
});

describe('B2: no extra watchlist-hit charge once the budget is spent', () => {
    it('flags the hit but does not bill it when the emission already hit the limit', async () => {
        const h = harness({ prices: { result: 0.001, 'watchlist-hit': 0.15 }, budgetUsd: 0.001 });
        const engine = engineOf(stub('s', [rec('1', 'a', 'ACME CORP'), rec('2', 'a', 'ACME CORP')]));
        const summary = await runEngine(engine, { sources: ['s'], watchlistNames: ['Acme'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(1);
        expect(h.rows[0]?.is_watchlist_match).toBe(true);
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        expect(summary.stoppedOnChargeLimit).toBe(true);
    });
});

describe('B3: an unchanged record re-sent by deltaMode all is not billed as new', () => {
    it('bills the lower updated event', async () => {
        const store = new InMemoryDeltaStore();
        const connector = stub('s', [rec('1')], { billing: { newEvent: 'doc-new', updatedEvent: 'doc-updated' } });
        const prices = { 'doc-new': 0.05, 'doc-updated': 0.02, 'watchlist-hit': 0.15 };
        await runEngine(engineOf(connector), { sources: ['s'] }, { sinks: harness({ store, prices }).sinks, ctx, clock });
        const again = harness({ store, prices });
        await runEngine(engineOf(connector), { sources: ['s'], deltaMode: 'all' }, { sinks: again.sinks, ctx, clock });
        expect(again.billing.calls).toEqual([{ eventName: 'doc-updated', count: 1 }]);
    });
});

describe('B5: live pricing is checked before any row is billed', () => {
    const connector = stub('s', [rec('1')], { billing: { newEvent: 'doc-new' } });
    const engine = engineOf(connector);

    it('refuses the run when apify-default-dataset-item is priced (every row would be billed twice)', async () => {
        const h = harness({ prices: { 'doc-new': 0.05, 'apify-default-dataset-item': 0.001 } });
        await expect(runEngine(engine, { sources: ['s'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/billed twice/);
        expect(h.rows).toHaveLength(0);
        expect(h.billing.calls).toHaveLength(0);
    });

    it('warns and records an event that is not priced, still delivering the rows', async () => {
        const h = harness({ prices: { result: 0.001 } });
        const summary = await runEngine(engine, { sources: ['s'] }, { sinks: h.sinks, ctx, clock });
        expect(summary.pricing.unpricedEvents).toEqual(['doc-new']);
        expect(logs.join('\n')).toMatch(/no positive price.*doc-new/);
    });

    it('includes engine-level record events and the watchlist-hit event only when a watchlist is active', () => {
        const withExtra: EngineDefinition = { ...engine, extraBillingEvents: ['doc-summary'] };
        const selected = resolveSources(withExtra, { sources: ['s'], sourceOptions: {}, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 });
        const billing = new FakeBilling(true, { 'doc-new': 0.05 });
        expect(checkRuntimePricing(withExtra, selected, billing, false).unpricedEvents).toEqual(['doc-summary']);
        expect(checkRuntimePricing(withExtra, selected, billing, true).unpricedEvents).toEqual(['doc-summary', 'watchlist-hit']);
        expect(checkRuntimePricing(withExtra, selected, new FakeBilling(false, {}), true).unpricedEvents).toEqual([]);
    });
});

describe('SEC-01: credentials never reach logs or the run summary', () => {
    it('scrubs the token (and its URL-encoded form) from a connector error, a warning and every log level', async () => {
        const secret = 'LEAKME-SECRET/0123456789';
        const leaky = stub('s', [], {
            requiredOptions: ['apiKey'],
            async fetch(c: ConnectorContext, options: Record<string, unknown>) {
                c.log.warning(`retrying with ${String(options.apiKey)} and ${encodeURIComponent(String(options.apiKey))}`);
                c.log.info(`using ${String(options.apiKey)}`);
                throw new Error(`upstream said: invalid key ${String(options.apiKey)}`);
            },
        });
        logs.length = 0;
        const h = harness();
        const summary = await runEngine(engineOf(leaky), { sources: ['s'], sourceOptions: { s: { apiKey: secret } } }, { sinks: h.sinks, ctx, clock });
        const everything = JSON.stringify(summary) + logs.join('\n');
        expect(everything).not.toContain(secret);
        expect(everything).not.toContain(encodeURIComponent(secret));
        expect(summary.sources[0]?.error).toContain('***');
        expect(summary.sources[0]?.warnings[0]).toContain('***');
    });
});

describe('DI-5: record ids that look like Object.prototype members', () => {
    it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])('%s is first_seen once, then unchanged', (id) => {
        let state = createEmptyState();
        expect(classifyRecord(state, 's', id, 'fp')).toBe('first_seen');
        state = markProcessed(state, 's', [{ recordId: id, fingerprint: 'fp' }], 't');
        expect(classifyRecord(state, 's', id, 'fp')).toBe('unchanged');
        expect(classifyRecord(state, 's', id, 'other')).toBe('updated');
        expect(classifyRecord(markProcessed(createEmptyState(), 's', [], 't'), 's', id, 'fp')).toBe('first_seen');
    });

    it('survives a JSON round trip through the store', async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(stub('s', [rec('__proto__'), rec('constructor')]));
        await runEngine(engine, { sources: ['s'] }, { sinks: harness({ store }).sinks, ctx, clock });
        const again = harness({ store });
        await runEngine(engine, { sources: ['s'] }, { sinks: again.sinks, ctx, clock });
        expect(again.rows).toHaveLength(0);
    });
});

describe('DI-6: a malformed sourceOptions is reported, not silently replaced', () => {
    const engine: EngineDefinition = { ...engineOf(stub('s', [])), credentialFields: { apiKey: { source: 's', option: 'apiKey' } } };

    it.each([['a string', 'oops'], ['an array', []], ['null', null], ['a number', 7]])('rejects sourceOptions that is %s', async (_label, bad) => {
        const h = harness();
        await expect(runEngine(engine, { sources: ['s'], apiKey: 'secret-value', sourceOptions: bad }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/sourceOptions/);
    });

    it('leaves the input untouched when sourceOptions is malformed', () => {
        const input = { sources: ['s'], apiKey: 'k', sourceOptions: 'oops' };
        expect(mergeCredentialFields(engine, input)).toBe(input);
    });
});

describe('B6: line breaks and tabs are word separators, not deleted characters', () => {
    it.each([
        ['Banco\nCentral', 'Banco Central'],
        ['Banco\tCentral', 'Banco Central'],
        ['Banco\r\nCentral', 'Banco Central'],
        ['Banco\u0085Central', 'Banco Central'],
        ['Banco Central', 'Banco Central'],
        ['A​cme', 'Acme'],
    ])('normaliseKeyword(%j) = %j', (raw, expected) => {
        expect(normaliseKeyword(raw)).toBe(expected);
    });

    it('matches across a line break in record text and does not invent a match by fusing words', () => {
        const list = sanitizeKeywordList(['Banco Central', 'ngco']);
        expect(findKeywordMatch('BANCO\nCENTRAL de la República', list)).toBe('Banco Central');
        expect(findKeywordMatch('Trading\nCo', list)).toBeNull();
        expect(sanitizeKeywordList(['\t\n']).keywords).toEqual([]);
    });
});

describe('B10: one astral-plane letter is one character', () => {
    it('rejects a single astral letter and accepts two', () => {
        const one = '\u{1D49C}'; // MATHEMATICAL SCRIPT CAPITAL A, NFKC -> "A"
        expect(sanitizeKeywordList(['\u{20BB7}']).keywords).toEqual([]); // 1 code point (2 UTF-16 units)
        expect(sanitizeKeywordList(['\u{20BB7}\u{20BB7}']).keywords).toHaveLength(1);
        expect(sanitizeKeywordList([one]).keywords).toEqual([]);
    });
});

describe('B8: the watchlist spend cap is exact', () => {
    it('does not trip one hit early because of float drift', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 0.1 });
        const biller = new WatchlistHitBiller(billing, { maxHitsPerRun: 100, maxHitSpendUsd: 0.3 });
        const out = [await biller.chargeHit(), await biller.chargeHit(), await biller.chargeHit(), await biller.chargeHit()];
        expect(out).toEqual(['charged', 'charged', 'charged', 'skipped_cap']);
        expect(biller.spent).toBeCloseTo(0.3, 10);
    });
});

describe('DI-8: fingerprintOf does not collide', () => {
    it('keeps type and separator distinctions, and keeps null/undefined/empty as one token', () => {
        expect(fingerprintOf(['a␟b', 'c'])).not.toBe(fingerprintOf(['a', 'b␟c']));
        expect(fingerprintOf([1])).not.toBe(fingerprintOf(['1']));
        expect(fingerprintOf([['a', 'b']])).not.toBe(fingerprintOf(['a,b']));
        expect(fingerprintOf([null, 'x'])).toBe(fingerprintOf([undefined, 'x']));
        expect(fingerprintOf([null, 'x'])).toBe(fingerprintOf(['', 'x']));
        expect(fingerprintOf(['a', 'b'])).toBe(fingerprintOf(['a', 'b']));
    });
});
