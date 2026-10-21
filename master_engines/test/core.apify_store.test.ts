import { describe, expect, it } from 'vitest';

import { ApifyDeltaStore, type KeyValueLike } from '../lib/apify_adapters.js';
import { createEmptyState, markProcessed, resolveStateNamespace } from '../lib/state.js';

class FakeKv implements KeyValueLike {
    readonly data = new Map<string, unknown>();
    async *keys(): AsyncIterable<string> {
        for (const key of [...this.data.keys()]) yield key;
    }
    async getValue(key: string): Promise<unknown> {
        return structuredClone(this.data.get(key));
    }
    async setValue(key: string, value: unknown): Promise<void> {
        this.data.set(key, structuredClone(value));
    }
}

const stateWith = (source: string, ids: string[]) => markProcessed(createEmptyState(), source, ids.map((id) => ({ recordId: id, fingerprint: 'f' })), 't');

describe('ApifyDeltaStore', () => {
    it('stores one record per source under state.<namespace>.<source> and reloads them', async () => {
        const kv = new FakeKv();
        const store = new ApifyDeltaStore('s', 'task-abc', async () => kv);
        await store.save({ ...stateWith('ofac', ['1', '2']), sources: { ...stateWith('ofac', ['1', '2']).sources, ...stateWith('sec', ['9']).sources } });
        expect([...kv.data.keys()].sort()).toEqual(['state.task-abc.ofac', 'state.task-abc.sec']);
        const loaded = await store.load();
        expect(loaded.sources.ofac?.seenIds.sort()).toEqual(['1', '2']);
        expect(loaded.sources.sec?.seenIds).toEqual(['9']);
    });

    it('saveSource writes only that source, so overlapping runs cannot clobber each other (DI-3)', async () => {
        const kv = new FakeKv();
        const a = new ApifyDeltaStore('s', 'default', async () => kv);
        const b = new ApifyDeltaStore('s', 'default', async () => kv);
        const staleA = await a.load();
        const staleB = await b.load();
        await a.saveSource('ofac', stateWith('ofac', ['1']).sources.ofac!);
        await b.saveSource('sec', stateWith('sec', ['2']).sources.sec!);
        expect(staleA.sources).toEqual({});
        expect(staleB.sources).toEqual({});
        const merged = await new ApifyDeltaStore('s', 'default', async () => kv).load();
        expect(Object.keys(merged.sources).sort()).toEqual(['ofac', 'sec']);
    });

    it('namespaces are isolated from each other (B7 / DI-4)', async () => {
        const kv = new FakeKv();
        await new ApifyDeltaStore('s', 'task-a', async () => kv).saveSource('ofac', stateWith('ofac', ['1']).sources.ofac!);
        const other = await new ApifyDeltaStore('s', 'task-b', async () => kv).load();
        expect(other.sources).toEqual({});
        const same = await new ApifyDeltaStore('s', 'task-a', async () => kv).load();
        expect(Object.keys(same.sources)).toEqual(['ofac']);
    });

    it('ignores unrelated and malformed records, and tolerates a prefix-sharing namespace', async () => {
        const kv = new FakeKv();
        kv.data.set('RUN_SUMMARY', { x: 1 });
        kv.data.set('state.default.ofac', { seenIds: [1], fingerprints: {}, lastRunAt: 't' });
        kv.data.set('state.default-2.sec', stateWith('sec', ['9']).sources.sec);
        kv.data.set('state.default.good', stateWith('good', ['7']).sources.good);
        const loaded = await new ApifyDeltaStore('s', 'default', async () => kv).load();
        expect(Object.keys(loaded.sources)).toEqual(['good']);
    });

    it('round-trips ids that look like Object.prototype members', async () => {
        const kv = new FakeKv();
        const store = new ApifyDeltaStore('s', 'default', async () => kv);
        await store.saveSource('ofac', stateWith('ofac', ['__proto__', 'constructor']).sources.ofac!);
        const loaded = await store.load();
        expect(Object.prototype.hasOwnProperty.call(loaded.sources.ofac?.fingerprints, '__proto__')).toBe(true);
    });
});

describe('resolveStateNamespace', () => {
    it('prefers an explicit valid namespace, then the task id, then default', () => {
        expect(resolveStateNamespace({ stateNamespace: 'weekly-eu' }, 'TASK123')).toBe('weekly-eu');
        expect(resolveStateNamespace({}, 'Ab3-Cd_4')).toBe('task-ab3cd4');
        expect(resolveStateNamespace({}, undefined)).toBe('default');
        expect(resolveStateNamespace(undefined, '')).toBe('default');
        expect(resolveStateNamespace({ stateNamespace: '' }, undefined)).toBe('default');
    });

    it('caps a task-derived namespace and rejects an invalid explicit one', () => {
        expect(resolveStateNamespace({}, 'x'.repeat(100)).length).toBeLessThanOrEqual(40);
        for (const bad of ['Has Space', 'UPPER', 'a/b', 'x'.repeat(41), 7, ['a']]) {
            expect(() => resolveStateNamespace({ stateNamespace: bad }, undefined), JSON.stringify(bad)).toThrow(/stateNamespace/);
        }
    });
});
