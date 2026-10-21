import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { createHeldConnector } from '../lib/connector_helpers.js';
import { allSourcesFailed, billingEventFor, describeSourceFailures, type EngineDefinition, mergeCredentialFields, resolveSources, runEngine, type RunSinks, shouldEmit } from '../lib/router_core.js';
import { type DeltaStore, InMemoryDeltaStore, type ProcessedRecord } from '../lib/state.js';
import {
    type Connector,
    type ConnectorContext,
    FatalConfigError,
    type RunSummary,
    type SourceRecord,
} from '../lib/types.js';

const silentLog = { info() {}, warning() {}, error() {}, debug() {} };
const ctx: ConnectorContext = {
    http: {
        async getText() {
            throw new Error('network must not be used in router tests');
        },
        async getJson() {
            throw new Error('network must not be used in router tests');
        },
    },
    log: silentLog,
    now: () => new Date('2026-10-21T00:00:00Z'),
};
const clock = () => new Date('2026-10-21T00:00:00Z');

function rec(id: string, fp: string, watchText?: string): SourceRecord {
    return { recordId: id, fingerprint: fp, payload: { title: `t-${id}`, event_type: 'SANCTION' }, watchText };
}

function stub(id: string, records: SourceRecord[] | (() => Promise<SourceRecord[]>), extra: Partial<Connector<any>> = {}): Connector<any> {
    return {
        id,
        engine: 'global-regtech-compliance-feed',
        legacyActor: `legacy-${id}`,
        description: id,
        status: 'active',
        optionsSchema: z.object({ token: z.string().optional() }).passthrough(),
        async fetch() {
            return typeof records === 'function' ? records() : records;
        },
        ...extra,
    };
}

function engineOf(...connectors: Array<Connector<any>>): EngineDefinition {
    return { slug: 'global-regtech-compliance-feed', connectors };
}

interface Harness {
    sinks: RunSinks;
    rows: Array<Record<string, unknown>>;
    billing: FakeBilling;
    store: InMemoryDeltaStore;
    summaries: RunSummary[];
}

function harness(opts: { ppe?: boolean; prices?: Record<string, number>; budgetUsd?: number; store?: InMemoryDeltaStore } = {}): Harness {
    const prices = opts.prices ?? { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 };
    const billing = new FakeBilling(opts.ppe ?? true, prices, opts.budgetUsd);
    const store = opts.store ?? new InMemoryDeltaStore();
    const rows: Array<Record<string, unknown>> = [];
    const summaries: RunSummary[] = [];
    const sinks: RunSinks = {
        async emit(row, eventName = RESULT_EVENT) {
            if (billing.isPayPerEvent()) {
                const r = await billing.charge(eventName, 1);
                if (r.chargedCount < 1) return { emitted: false, limitReached: true };
                rows.push(row);
                return { emitted: true, limitReached: r.eventChargeLimitReached };
            }
            rows.push(row);
            return { emitted: true, limitReached: false };
        },
        billing,
        store,
        async saveSummary(s) {
            summaries.push(s);
        },
    };
    return { sinks, rows, billing, store, summaries };
}

describe('shouldEmit', () => {
    it.each([
        ['all', 'first_seen', true],
        ['all', 'updated', true],
        ['all', 'unchanged', true],
        ['onlyChanged', 'first_seen', true],
        ['onlyChanged', 'updated', true],
        ['onlyChanged', 'unchanged', false],
        ['onlyNew', 'first_seen', true],
        ['onlyNew', 'updated', false],
        ['onlyNew', 'unchanged', false],
    ] as const)('%s + %s -> %s', (mode, cls, expected) => {
        expect(shouldEmit(mode, cls)).toBe(expected);
    });
});

describe('preflight', () => {
    const engine = engineOf(
        stub('alpha', []),
        stub('byok', [], { requiredOptions: ['apiKey'], optionsSchema: z.object({ apiKey: z.string().optional() }) }),
        createHeldConnector({ id: 'ar_salta', engine: 'global-regtech-compliance-feed', legacyActor: 'salta', description: 'held', reason: 'operator-designated held source' }),
    );

    it('rejects unknown sources and lists the available ones', async () => {
        const h = harness();
        await expect(runEngine(engine, { sources: ['nope'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/Unknown source "nope".*Available: alpha, byok/);
    });

    it('rejects a held source even when options are supplied, with its reason, before any fetch', async () => {
        const h = harness();
        const call = runEngine(engine, { sources: ['alpha', 'ar_salta'], sourceOptions: { ar_salta: { anything: 1 } } }, { sinks: h.sinks, ctx, clock });
        await expect(call).rejects.toBeInstanceOf(FatalConfigError);
        await expect(call).rejects.toThrow(/HELD.*operator-designated held source/);
        expect(h.rows).toHaveLength(0);
        expect(h.store.saves).toBe(0);
        expect(h.billing.calls).toHaveLength(0);
    });

    it('fails fast on a missing credential and reports every problem at once', async () => {
        const h = harness();
        const call = runEngine(engine, { sources: ['byok', 'ar_salta', 'ghost'] }, { sinks: h.sinks, ctx, clock });
        await expect(call).rejects.toThrow(/requires option\(s\): apiKey/);
        await expect(call).rejects.toThrow(/HELD/);
        await expect(call).rejects.toThrow(/Unknown source "ghost"/);
    });

    it('treats a blank credential as missing', () => {
        expect(() => resolveSources(engine, { sources: ['byok'], sourceOptions: { byok: { apiKey: '   ' } }, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 })).toThrow(/requires option/);
    });

    it('normalises source ids and de-duplicates', () => {
        const resolved = resolveSources(engine, { sources: ['ALPHA', ' alpha '], sourceOptions: {}, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 });
        expect(resolved.map((r) => r.connector.id)).toEqual(['alpha']);
    });

    it('rejects invalid input shapes', async () => {
        const h = harness();
        await expect(runEngine(engine, { sources: [] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/Select at least one source/);
        await expect(runEngine(engine, { sources: ['alpha'], deltaMode: 'sometimes' }, { sinks: h.sinks, ctx, clock })).rejects.toBeInstanceOf(FatalConfigError);
        await expect(runEngine(engine, { sources: ['alpha'], maxItemsPerSource: 0 }, { sinks: h.sinks, ctx, clock })).rejects.toBeInstanceOf(FatalConfigError);
    });

    it('validates per-source options through the connector schema', async () => {
        const strict = engineOf(stub('strict', [], { optionsSchema: z.object({ limit: z.number().int().max(3) }) }));
        const h = harness();
        await expect(runEngine(strict, { sources: ['strict'], sourceOptions: { strict: { limit: 99 } } }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/Invalid options for "strict": limit/);
    });
});

describe('delta modes and state', () => {
    it('emits first_seen then nothing on an identical re-run (onlyChanged)', async () => {
        const engine = engineOf(stub('alpha', [rec('1', 'a'), rec('2', 'a')]));
        const store = new InMemoryDeltaStore();
        const first = harness({ store });
        await runEngine(engine, { sources: ['alpha'] }, { sinks: first.sinks, ctx, clock });
        expect(first.rows.map((r) => [r.record_id, r.delta_status, r.is_new])).toEqual([['1', 'first_seen', true], ['2', 'first_seen', true]]);

        const second = harness({ store });
        await runEngine(engine, { sources: ['alpha'] }, { sinks: second.sinks, ctx, clock });
        expect(second.rows).toHaveLength(0);
        expect(second.summaries[0]?.sources[0]?.unchanged).toBe(2);
    });

    it('onlyChanged emits an updated record; onlyNew does not', async () => {
        const store = new InMemoryDeltaStore();
        await runEngine(engineOf(stub('alpha', [rec('1', 'a')])), { sources: ['alpha'] }, { sinks: harness({ store }).sinks, ctx, clock });

        const changed = engineOf(stub('alpha', [rec('1', 'b'), rec('2', 'x')]));
        const asChanged = harness({ store: new InMemoryDeltaStore(store.peek()) });
        await runEngine(changed, { sources: ['alpha'], deltaMode: 'onlyChanged' }, { sinks: asChanged.sinks, ctx, clock });
        expect(asChanged.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['1', 'updated'], ['2', 'first_seen']]);

        const asNew = harness({ store: new InMemoryDeltaStore(store.peek()) });
        await runEngine(changed, { sources: ['alpha'], deltaMode: 'onlyNew' }, { sinks: asNew.sinks, ctx, clock });
        expect(asNew.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['2', 'first_seen']]);
    });

    it('all re-emits unchanged records tagged unchanged', async () => {
        const engine = engineOf(stub('alpha', [rec('1', 'a')]));
        const store = new InMemoryDeltaStore();
        await runEngine(engine, { sources: ['alpha'] }, { sinks: harness({ store }).sinks, ctx, clock });
        const h = harness({ store });
        await runEngine(engine, { sources: ['alpha'], deltaMode: 'all' }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.map((r) => [r.record_id, r.delta_status, r.is_new])).toEqual([['1', 'unchanged', false]]);
    });

    it('a skipped (unchanged / not-new) record is still remembered', async () => {
        const store = new InMemoryDeltaStore();
        await runEngine(engineOf(stub('alpha', [rec('1', 'a')])), { sources: ['alpha'] }, { sinks: harness({ store }).sinks, ctx, clock });
        await runEngine(engineOf(stub('alpha', [rec('1', 'b')])), { sources: ['alpha'], deltaMode: 'onlyNew' }, { sinks: harness({ store }).sinks, ctx, clock });
        expect(store.peek().sources.alpha?.fingerprints['1']).toBe('b');
    });

    it('de-duplicates repeated ids from a connector and honours maxItemsPerSource', async () => {
        const engine = engineOf(stub('alpha', [rec('1', 'a'), rec('1', 'a'), rec('2', 'a'), rec('3', 'a')]));
        const h = harness();
        await runEngine(engine, { sources: ['alpha'], maxItemsPerSource: 2 }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.map((r) => r.record_id)).toEqual(['1', '2']);
    });

    it('stamps engine/source/scraped_at and keeps connector payload fields', async () => {
        const h = harness();
        await runEngine(engineOf(stub('alpha', [rec('1', 'a')])), { sources: ['alpha'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows[0]).toMatchObject({
            engine: 'global-regtech-compliance-feed',
            source: 'alpha',
            record_id: '1',
            title: 't-1',
            event_type: 'SANCTION',
            scraped_at: '2026-10-21T00:00:00.000Z',
            is_watchlist_match: false,
            matched_watchlist_keyword: null,
        });
    });

    it('a connector cannot spoof router-owned fields', async () => {
        const evil: SourceRecord = { recordId: '1', fingerprint: 'a', payload: { is_watchlist_match: true, source: 'forged', delta_status: 'x', record_id: 'forged' } };
        const h = harness();
        await runEngine(engineOf(stub('alpha', [evil])), { sources: ['alpha'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows[0]).toMatchObject({ is_watchlist_match: false, source: 'alpha', delta_status: 'first_seen', record_id: '1' });
    });
});

describe('per-connector delta memory size', () => {
    it('retains maxSeenIds ids for a connector that declares it, instead of the global default', async () => {
        const many = Array.from({ length: 12 }, (_, i) => rec(String(i), 'a'));
        const store = new InMemoryDeltaStore();
        const h = harness({ store });
        await runEngine(engineOf(stub('big', many, { maxSeenIds: 8 })), { sources: ['big'] }, { sinks: h.sinks, ctx, clock });
        expect(store.peek().sources.big?.seenIds).toHaveLength(8);
    });

    it('keeps everything under the default when maxSeenIds is not declared', async () => {
        const many = Array.from({ length: 12 }, (_, i) => rec(String(i), 'a'));
        const store = new InMemoryDeltaStore();
        const h = harness({ store });
        await runEngine(engineOf(stub('plain', many)), { sources: ['plain'] }, { sinks: h.sinks, ctx, clock });
        expect(store.peek().sources.plain?.seenIds).toHaveLength(12);
    });
});

describe('failure isolation', () => {
    it('one failing source does not discard the others, and its state is untouched', async () => {
        const engine = engineOf(
            stub('boom', async () => {
                throw new Error('upstream 503');
            }),
            stub('ok', [rec('1', 'a')]),
        );
        const h = harness();
        const summary = await runEngine(engine, { sources: ['boom', 'ok'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.map((r) => r.source)).toEqual(['ok']);
        expect(summary.sources[0]?.error).toBe('upstream 503');
        expect(h.store.peek().sources.boom?.seenIds ?? []).toEqual([]);
        expect(h.store.peek().sources.ok?.seenIds).toEqual(['1']);
    });

    it('persists state after each source, so a later failure cannot lose an earlier source', async () => {
        const store = new InMemoryDeltaStore();
        const h = harness({ store });
        const engine = engineOf(stub('first', [rec('1', 'a')]), stub('second', [rec('2', 'a')]));
        await runEngine(engine, { sources: ['first', 'second'] }, { sinks: h.sinks, ctx, clock });
        expect(store.saves).toBe(2);
    });
});

describe('delivery journal (a hard kill must not make the next run deliver and bill rows twice)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => rec(String(i + 1), 'a'));

    it('writes the journal after every emitted row and clears it at every full checkpoint', async () => {
        const store = new InMemoryDeltaStore();
        const h = harness({ store });
        await runEngine(engineOf(stub('ok', many(30))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        // 30 rows + a clear at the checkpoint after row 25 + a clear in the final persist (5 rows)
        expect(store.journalWrites).toBe(32);
        expect(store.peekJournal('ok')).toEqual([]);
        expect(store.peek().sources.ok?.seenIds).toHaveLength(30);
    });

    it('holds exactly the rows delivered since the last checkpoint', async () => {
        const snapshots: ProcessedRecord[][] = [];
        const spy = new (class extends InMemoryDeltaStore {
            override async saveJournal(source: string, entries: readonly ProcessedRecord[]): Promise<void> {
                snapshots.push([...entries]);
                return super.saveJournal(source, entries);
            }
        })();
        const h = harness({ store: spy });
        await runEngine(engineOf(stub('ok', many(27))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(snapshots[0]).toEqual([{ recordId: '1', fingerprint: 'a' }]);
        expect(snapshots[24]).toHaveLength(25);
        expect(snapshots[25]).toEqual([]); // cleared by the checkpoint
        expect(snapshots[26]).toEqual([{ recordId: '26', fingerprint: 'a' }]);
        expect(snapshots[27]).toHaveLength(2);
    });

    it('recovers a journal left by an interrupted run and does not deliver those rows again', async () => {
        const store = new InMemoryDeltaStore();
        await store.saveJournal('ok', [
            { recordId: '1', fingerprint: 'a' },
            { recordId: '2', fingerprint: 'a' },
            { recordId: '3', fingerprint: 'a' },
        ]);
        const h = harness({ store });
        const summary = await runEngine(engineOf(stub('ok', many(5))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.map((r) => r.record_id)).toEqual(['4', '5']);
        expect(summary.sources[0]).toMatchObject({ fetched: 5, emitted: 2, firstSeen: 2, unchanged: 3 });
        expect(store.peekJournal('ok')).toEqual([]);
        expect(store.peek().sources.ok?.seenIds.sort()).toEqual(['1', '2', '3', '4', '5']);
        expect(h.billing.totalFor(RESULT_EVENT)).toBe(2);
    });

    it('a journalled record whose content has changed since is still delivered, as updated', async () => {
        const store = new InMemoryDeltaStore();
        await store.saveJournal('ok', [{ recordId: '1', fingerprint: 'old' }]);
        const h = harness({ store });
        await runEngine(engineOf(stub('ok', [rec('1', 'new')])), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(1);
        expect(h.rows[0]).toMatchObject({ record_id: '1', delta_status: 'updated' });
    });

    it('a journal for a source that is not selected is left untouched', async () => {
        const store = new InMemoryDeltaStore();
        await store.saveJournal('other', [{ recordId: 'x', fingerprint: 'a' }]);
        const h = harness({ store });
        await runEngine(engineOf(stub('ok', many(2)), stub('other', [])), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(store.peekJournal('other')).toEqual([{ recordId: 'x', fingerprint: 'a' }]);
    });

    it('fails closed: when a journal write fails no further row is pushed, and the row already pushed is remembered', async () => {
        const failing = new (class extends InMemoryDeltaStore {
            private calls = 0;
            override async saveJournal(source: string, entries: readonly ProcessedRecord[]): Promise<void> {
                this.calls += 1;
                if (this.calls === 3) throw new Error('kv store unavailable');
                return super.saveJournal(source, entries);
            }
        })();
        const h = harness({ store: failing });
        await expect(runEngine(engineOf(stub('ok', many(10))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow('kv store unavailable');
        expect(h.rows.map((r) => r.record_id)).toEqual(['1', '2', '3']);
        // the third row was pushed before its journal write failed; the `finally` checkpoint still remembers it
        expect(failing.peek().sources.ok?.seenIds.sort()).toEqual(['1', '2', '3']);
    });

    it('fails closed when the journal cannot be read: nothing is fetched into the dataset', async () => {
        const unreadable = new (class extends InMemoryDeltaStore {
            override async loadJournal(): Promise<ProcessedRecord[]> {
                throw new Error('kv store unavailable');
            }
        })();
        const h = harness({ store: unreadable });
        await expect(runEngine(engineOf(stub('ok', many(3))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock })).rejects.toThrow('kv store unavailable');
        expect(h.rows).toEqual([]);
    });

    it('is written BEFORE the watchlist-hit charge, so a kill between them leaks one hit instead of double-billing the row', async () => {
        const order: string[] = [];
        const store = new (class extends InMemoryDeltaStore {
            override async saveJournal(source: string, entries: readonly ProcessedRecord[]): Promise<void> {
                if (entries.length > 0) order.push('journal');
                return super.saveJournal(source, entries);
            }
        })();
        const h = harness({ store });
        const realCharge = h.billing.charge.bind(h.billing);
        h.billing.charge = async (event: string, count: number) => {
            if (event === WATCHLIST_HIT_EVENT) order.push('hit');
            else order.push('row');
            return realCharge(event, count);
        };
        await runEngine(engineOf(stub('ok', [rec('1', 'a', 'ACME CORP')])), { sources: ['ok'], watchlistNames: ['Acme'] }, { sinks: h.sinks, ctx, clock });
        expect(order).toEqual(['row', 'journal', 'hit']);
    });

    it('a store without journal support still works (checkpoints only)', async () => {
        const inner = new InMemoryDeltaStore();
        const plain: DeltaStore = { load: () => inner.load(), save: (state) => inner.save(state) };
        const h = harness();
        h.sinks.store = plain;
        await runEngine(engineOf(stub('ok', many(3))), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(3);
        expect(inner.peek().sources.ok?.seenIds).toHaveLength(3);
    });
});

describe('a run in which every source failed', () => {
    const boom = (id: string, message: string) =>
        stub(id, async () => {
            throw new Error(message);
        });

    it('is flagged when every selected source errored and nothing was delivered', async () => {
        const h = harness();
        const summary = await runEngine(engineOf(boom('a', 'upstream 503'), boom('b', 'timeout')), { sources: ['a', 'b'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toEqual([]);
        expect(allSourcesFailed(summary)).toBe(true);
        expect(describeSourceFailures(summary)).toBe('All 2 selected source(s) failed and nothing was delivered. a: upstream 503 | b: timeout');
        // the summary is still saved, so the failure is inspectable
        expect(h.summaries).toHaveLength(1);
    });

    it('is also flagged for a single selected source that errored', async () => {
        const h = harness();
        const summary = await runEngine(engineOf(boom('only', 'HTTP 500')), { sources: ['only'] }, { sinks: h.sinks, ctx, clock });
        expect(allSourcesFailed(summary)).toBe(true);
    });

    it('is NOT flagged when one source answered, even with zero records (partial failure stays isolated)', async () => {
        const h = harness();
        const summary = await runEngine(engineOf(boom('a', 'upstream 503'), stub('empty', [])), { sources: ['a', 'empty'] }, { sinks: h.sinks, ctx, clock });
        expect(allSourcesFailed(summary)).toBe(false);
    });

    it('is NOT flagged when a failing source was selected next to a source that delivered rows', async () => {
        const h = harness();
        const summary = await runEngine(engineOf(boom('a', 'upstream 503'), stub('ok', [rec('1', 'a')])), { sources: ['a', 'ok'] }, { sinks: h.sinks, ctx, clock });
        expect(allSourcesFailed(summary)).toBe(false);
        expect(summary.totalEmitted).toBe(1);
    });

    it('is NOT flagged for a healthy source with nothing new (an unchanged re-run is a success)', async () => {
        const store = new InMemoryDeltaStore();
        const h = harness({ store });
        const engine = engineOf(stub('ok', [rec('1', 'a')]));
        await runEngine(engine, { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        const again = await runEngine(engine, { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(again.totalEmitted).toBe(0);
        expect(allSourcesFailed(again)).toBe(false);
    });

    it('is not flagged for a run that stopped on the charge limit after failing nothing', async () => {
        const h = harness({ budgetUsd: 0.002 });
        const summary = await runEngine(engineOf(stub('ok', [rec('1', 'a'), rec('2', 'a')])), { sources: ['ok'] }, { sinks: h.sinks, ctx, clock });
        expect(allSourcesFailed(summary)).toBe(false);
    });
});

describe('charge limit does not lose records', () => {
    it('stops at the budget and leaves unreached records first_seen for the next run', async () => {
        const records = [rec('1', 'a'), rec('2', 'a'), rec('3', 'a'), rec('4', 'a')];
        const engine = engineOf(stub('alpha', records));
        const store = new InMemoryDeltaStore();

        const limited = harness({ store, budgetUsd: 0.005 });
        const summary = await runEngine(engine, { sources: ['alpha'] }, { sinks: limited.sinks, ctx, clock });
        expect(limited.rows.map((r) => r.record_id)).toEqual(['1', '2']);
        expect(summary.stoppedOnChargeLimit).toBe(true);
        expect(store.peek().sources.alpha?.seenIds.sort()).toEqual(['1', '2']);

        const next = harness({ store });
        await runEngine(engine, { sources: ['alpha'] }, { sinks: next.sinks, ctx, clock });
        expect(next.rows.map((r) => r.record_id)).toEqual(['3', '4']);
    });

    it('does not start later sources once the budget is exhausted', async () => {
        const engine = engineOf(stub('a', [rec('1', 'a')]), stub('b', [rec('2', 'a')]));
        const h = harness({ budgetUsd: 0.002 });
        const summary = await runEngine(engine, { sources: ['a', 'b'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.map((r) => r.source)).toEqual(['a']);
        expect(summary.sources.map((s) => s.source)).toEqual(['a']);
    });
});

describe('watchlist billing through the router', () => {
    const records = [rec('1', 'a', 'ACME CORP., a Delaware corporation'), rec('2', 'a', 'Globex LLC'), rec('3', 'a', undefined)];
    const engine = engineOf(stub('alpha', records));

    it('one keyword, one hit, one charge', async () => {
        const h = harness();
        const summary = await runEngine(engine, { sources: ['alpha'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.filter((r) => r.is_watchlist_match)).toHaveLength(1);
        expect(h.rows[0]?.matched_watchlist_keyword).toBe('Acme Corp');
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
        expect(h.billing.totalFor(RESULT_EVENT)).toBe(3);
        expect(summary.watchlist).toMatchObject({ accepted: 1, rejected: 0, hitsCharged: 1, hitsUnpriced: 0 });
    });

    it.each([[['']], [[' ']], [''], ['a'], [['a']], [['--']], [[null]], [42], [undefined], [[]]])('ghost-billing input %j: zero matches, zero watchlist-hit charges', async (input) => {
        const h = harness();
        await runEngine(engine, { sources: ['alpha'], watchlistNames: input }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(3);
        expect(h.rows.some((r) => r.is_watchlist_match)).toBe(false);
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
    });

    it('a poison entry beside a valid one is dropped, the valid one still works', async () => {
        const h = harness();
        await runEngine(engine, { sources: ['alpha'], watchlistNames: ['', 'a', ' Globex '] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.filter((r) => r.is_watchlist_match).map((r) => r.record_id)).toEqual(['2']);
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
    });

    it('still flags matches but never bills when watchlist-hit is not priced', async () => {
        const h = harness({ prices: { [RESULT_EVENT]: 0.002 } });
        const summary = await runEngine(engine, { sources: ['alpha'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(h.rows.filter((r) => r.is_watchlist_match)).toHaveLength(1);
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        expect(summary.watchlist.hitsUnpriced).toBe(1);
    });

    it('never bills watchlist-hit outside pay-per-event', async () => {
        const h = harness({ ppe: false });
        await runEngine(engine, { sources: ['alpha'], watchlistNames: ['Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(h.billing.calls).toHaveLength(0);
        expect(h.rows.filter((r) => r.is_watchlist_match)).toHaveLength(1);
    });

    it('does not bill a hit for a record that was not emitted (unchanged under onlyChanged)', async () => {
        const store = new InMemoryDeltaStore();
        await runEngine(engine, { sources: ['alpha'], watchlistNames: ['Acme Corp'] }, { sinks: harness({ store }).sinks, ctx, clock });
        const again = harness({ store });
        await runEngine(engine, { sources: ['alpha'], watchlistNames: ['Acme Corp'] }, { sinks: again.sinks, ctx, clock });
        expect(again.billing.calls).toHaveLength(0);
    });

    it('honours maxWatchlistHitsPerRun', async () => {
        const many = engineOf(stub('alpha', Array.from({ length: 6 }, (_, i) => rec(String(i), 'a', 'Acme Corp'))));
        const h = harness();
        await runEngine(many, { sources: ['alpha'], watchlistNames: ['Acme'], maxWatchlistHitsPerRun: 2 }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(6);
        expect(h.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(2);
        expect(h.rows.filter((r) => r.is_watchlist_match)).toHaveLength(6);
    });

    it('writes a run summary', async () => {
        const h = harness();
        await runEngine(engine, { sources: ['alpha'], watchlistNames: ['', 'Acme Corp'] }, { sinks: h.sinks, ctx, clock });
        expect(h.summaries).toHaveLength(1);
        expect(h.summaries[0]).toMatchObject({ engine: 'global-regtech-compliance-feed', deltaMode: 'onlyChanged', totalEmitted: 3, watchlist: { accepted: 1, rejected: 1 } });
    });
});

describe('per-source billing events', () => {
    const priced = { 'apify-actor-start': 0.005, result: 0.001, 'vessel-record': 0.0005, 'statement-new': 0.02, 'statement-updated': 0.01, 'watchlist-hit': 0.15 };

    it('billingEventFor falls back from updated/snapshot to new to result', () => {
        const none = stub('a', []);
        const only = stub('b', [], { billing: { newEvent: 'vessel-record' } });
        const full = stub('c', [], { billing: { newEvent: 'statement-new', updatedEvent: 'statement-updated', snapshotEvent: 'statement-snapshot' } });
        expect(['first_seen', 'updated', 'unchanged'].map((c) => billingEventFor(none, c as never))).toEqual(['result', 'result', 'result']);
        expect(['first_seen', 'updated', 'unchanged'].map((c) => billingEventFor(only, c as never))).toEqual(['vessel-record', 'vessel-record', 'vessel-record']);
        expect(['first_seen', 'updated', 'unchanged'].map((c) => billingEventFor(full, c as never))).toEqual(['statement-new', 'statement-updated', 'statement-snapshot']);
    });

    it('bills each source at its own event, and a new vs updated record at different events', async () => {
        const store = new InMemoryDeltaStore();
        const engine = engineOf(
            stub('ofac', [rec('1', 'a')], { billing: { newEvent: 'vessel-record' } }),
            stub('uk', [rec('9', 'a')], { billing: { newEvent: 'statement-new', updatedEvent: 'statement-updated' } }),
        );
        const first = harness({ prices: priced, store });
        await runEngine(engine, { sources: ['ofac', 'uk'] }, { sinks: first.sinks, ctx, clock });
        expect(first.billing.calls).toEqual([
            { eventName: 'vessel-record', count: 1 },
            { eventName: 'statement-new', count: 1 },
        ]);

        const changed = engineOf(
            stub('ofac', [rec('1', 'a')], { billing: { newEvent: 'vessel-record' } }),
            stub('uk', [rec('9', 'b')], { billing: { newEvent: 'statement-new', updatedEvent: 'statement-updated' } }),
        );
        const second = harness({ prices: priced, store });
        await runEngine(changed, { sources: ['ofac', 'uk'] }, { sinks: second.sinks, ctx, clock });
        expect(second.billing.calls).toEqual([{ eventName: 'statement-updated', count: 1 }]);
    });

    it('a connector without billing keeps using the result event', async () => {
        const h = harness({ prices: priced });
        await runEngine(engineOf(stub('plain', [rec('1', 'a')])), { sources: ['plain'] }, { sinks: h.sinks, ctx, clock });
        expect(h.billing.calls).toEqual([{ eventName: 'result', count: 1 }]);
    });
});

describe('connector warnings reach the run summary', () => {
    it('captures ctx.log.warning calls made during fetch, per source', async () => {
        const noisy = stub('noisy', [rec('1', 'a')], {
            async fetch(c: ConnectorContext) {
                c.log.warning('difc failed, adgm ok');
                return [rec('1', 'a')];
            },
        });
        const h = harness();
        const summary = await runEngine(engineOf(noisy, stub('quiet', [rec('2', 'a')])), { sources: ['noisy', 'quiet'] }, { sinks: h.sinks, ctx, clock });
        expect(summary.sources.find((s) => s.source === 'noisy')?.warnings).toEqual(['difc failed, adgm ok']);
        expect(summary.sources.find((s) => s.source === 'quiet')?.warnings).toEqual([]);
        expect(summary.sources.find((s) => s.source === 'noisy')?.error).toBeUndefined();
    });

    it('bounds the number and size of captured warnings', async () => {
        const chatty = stub('chatty', [], {
            async fetch(c: ConnectorContext) {
                for (let i = 0; i < 80; i += 1) c.log.warning('x'.repeat(2000));
                return [];
            },
        });
        const h = harness();
        const summary = await runEngine(engineOf(chatty), { sources: ['chatty'] }, { sinks: h.sinks, ctx, clock });
        const w = summary.sources[0]?.warnings ?? [];
        expect(w).toHaveLength(50);
        expect(w.every((m) => m.length <= 500)).toBe(true);
    });
});

describe('credential fields', () => {
    const engine: EngineDefinition = {
        slug: 'global-regtech-compliance-feed',
        credentialFields: { apiKey: { source: 'byok', option: 'apiKey' } },
        connectors: [stub('byok', [rec('1', 'a')], { requiredOptions: ['apiKey'], optionsSchema: z.object({ apiKey: z.string().optional() }) })],
    };

    it('routes a top-level secret field into the source options', async () => {
        const h = harness();
        await runEngine(engine, { sources: ['byok'], apiKey: '  s3cret  ' }, { sinks: h.sinks, ctx, clock });
        expect(h.rows).toHaveLength(1);
    });

    it('an explicit sourceOptions value wins over the top-level field', () => {
        const merged = mergeCredentialFields(engine, { sources: ['byok'], apiKey: 'top', sourceOptions: { byok: { apiKey: 'explicit' } } }) as { sourceOptions: Record<string, Record<string, string>> };
        expect(merged.sourceOptions.byok?.apiKey).toBe('explicit');
    });

    it('ignores blank and non-string values, so a missing credential still fails preflight', async () => {
        const h = harness();
        for (const apiKey of ['', '   ', 42, null, {}]) {
            await expect(runEngine(engine, { sources: ['byok'], apiKey }, { sinks: h.sinks, ctx, clock })).rejects.toThrow(/requires option\(s\): apiKey/);
        }
    });

    it('never echoes the credential in a preflight error', async () => {
        const strict: EngineDefinition = {
            slug: 'global-regtech-compliance-feed',
            credentialFields: { apiKey: { source: 'strict', option: 'apiKey' } },
            connectors: [stub('strict', [], { optionsSchema: z.object({ apiKey: z.string().min(50) }) })],
        };
        const h = harness();
        const error = await runEngine(strict, { sources: ['strict'], apiKey: 'TOP-SECRET-VALUE' }, { sinks: h.sinks, ctx, clock }).catch((e: Error) => e);
        expect((error as Error).message).toMatch(/Invalid options/);
        expect((error as Error).message).not.toContain('TOP-SECRET-VALUE');
    });

    it('does not mutate the caller input and leaves engines without credential fields untouched', () => {
        const input = { sources: ['byok'], apiKey: 'k' };
        const copy = JSON.stringify(input);
        mergeCredentialFields(engine, input);
        expect(JSON.stringify(input)).toBe(copy);
        const plain = { slug: 'global-regtech-compliance-feed' as const, connectors: [] };
        expect(mergeCredentialFields(plain, input)).toBe(input);
    });
});
