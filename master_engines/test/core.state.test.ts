import { describe, expect, it } from 'vitest';

import { classifyRecord, CorruptDeltaRecordError, createEmptyState, InMemoryDeltaStore, markProcessed, MAX_JOURNAL_ENTRIES, parseJournal, parseState } from '../lib/state.js';

describe('delta state', () => {
    it('classifies first_seen / unchanged / updated', () => {
        let state = createEmptyState();
        expect(classifyRecord(state, 's', 'a', 'f1')).toBe('first_seen');
        state = markProcessed(state, 's', [{ recordId: 'a', fingerprint: 'f1' }], 't1');
        expect(classifyRecord(state, 's', 'a', 'f1')).toBe('unchanged');
        expect(classifyRecord(state, 's', 'a', 'f2')).toBe('updated');
        expect(classifyRecord(state, 'other', 'a', 'f1')).toBe('first_seen');
    });

    it('is immutable: markProcessed returns a new state', () => {
        const before = createEmptyState();
        const after = markProcessed(before, 's', [{ recordId: 'a', fingerprint: 'f' }], 't');
        expect(before.sources).toEqual({});
        expect(after.sources.s?.seenIds).toEqual(['a']);
    });

    it('keeps newest first and caps, pruning fingerprints to retained ids', () => {
        let state = createEmptyState();
        state = markProcessed(state, 's', [{ recordId: 'a', fingerprint: '1' }, { recordId: 'b', fingerprint: '2' }], 't1', 3);
        state = markProcessed(state, 's', [{ recordId: 'c', fingerprint: '3' }, { recordId: 'd', fingerprint: '4' }], 't2', 3);
        const s = state.sources.s;
        expect(s?.seenIds).toEqual(['c', 'd', 'a']);
        expect(Object.keys(s?.fingerprints ?? {}).sort()).toEqual(['a', 'c', 'd']);
    });

    it('updates the fingerprint of a re-seen id and moves it to the front', () => {
        let state = markProcessed(createEmptyState(), 's', [{ recordId: 'a', fingerprint: '1' }, { recordId: 'b', fingerprint: '2' }], 't1');
        state = markProcessed(state, 's', [{ recordId: 'b', fingerprint: '9' }], 't2');
        expect(state.sources.s?.seenIds).toEqual(['b', 'a']);
        expect(state.sources.s?.fingerprints.b).toBe('9');
        expect(state.sources.s?.lastRunAt).toBe('t2');
    });

    it('does not duplicate an id repeated within one run', () => {
        const state = markProcessed(createEmptyState(), 's', [{ recordId: 'a', fingerprint: '1' }, { recordId: 'a', fingerprint: '2' }], 't');
        expect(state.sources.s?.seenIds).toEqual(['a']);
        expect(state.sources.s?.fingerprints.a).toBe('2');
    });

    it('leaves other sources untouched', () => {
        let state = markProcessed(createEmptyState(), 'x', [{ recordId: 'a', fingerprint: '1' }], 't');
        state = markProcessed(state, 'y', [{ recordId: 'b', fingerprint: '2' }], 't');
        expect(state.sources.x?.seenIds).toEqual(['a']);
        expect(state.sources.y?.seenIds).toEqual(['b']);
    });
});

describe('parseState', () => {
    it.each([null, undefined, 'x', 3, [], {}, { version: 1, sources: {} }, { version: 2 }, { version: 2, sources: 'x' }])('returns empty state for %j', (value) => {
        expect(parseState(value)).toEqual(createEmptyState());
    });

    it('drops malformed sources but keeps valid ones', () => {
        const parsed = parseState({
            version: 2,
            sources: {
                good: { seenIds: ['a'], fingerprints: { a: 'f' }, lastRunAt: 't' },
                badIds: { seenIds: [1], fingerprints: {}, lastRunAt: 't' },
                badFp: { seenIds: ['a'], fingerprints: { a: 1 }, lastRunAt: 't' },
                notObject: 5,
            },
        });
        expect(Object.keys(parsed.sources)).toEqual(['good']);
    });

    it('round-trips through the in-memory store without aliasing', async () => {
        const store = new InMemoryDeltaStore();
        const state = markProcessed(createEmptyState(), 's', [{ recordId: 'a', fingerprint: 'f' }], 't');
        await store.save(state);
        const loaded = await store.load();
        loaded.sources.s?.seenIds.push('zzz');
        expect((await store.load()).sources.s?.seenIds).toEqual(['a']);
        expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    });
});

describe('parseJournal', () => {
    it('accepts a well-formed journal and returns copies of exactly recordId and fingerprint', () => {
        expect(parseJournal([{ recordId: 'a', fingerprint: 'f1', extra: 1 }, { recordId: 'b', fingerprint: '' }])).toEqual([
            { recordId: 'a', fingerprint: 'f1' },
            { recordId: 'b', fingerprint: '' },
        ]);
        expect(parseJournal([])).toEqual([]);
    });

    it('treats an ABSENT record (null or undefined) as an empty journal', () => {
        expect(parseJournal(null)).toEqual([]);
        expect(parseJournal(undefined)).toEqual([]);
    });

    it.each([
        ['a string (a record the store could not parse)', 'abc'],
        ['a truncated JSON text', '[{"recordId":"a","fingerprint":"f"'],
        ['an object', { recordId: 'a', fingerprint: 'f' }],
        ['a number', 7],
        ['a boolean', false],
        ['an entry that is not an object', ['x']],
        ['a null entry', [null]],
        ['an empty record id', [{ recordId: '', fingerprint: 'f' }]],
        ['a numeric record id', [{ recordId: 1, fingerprint: 'f' }]],
        ['a missing fingerprint', [{ recordId: 'a' }]],
        ['a numeric fingerprint', [{ recordId: 'a', fingerprint: 3 }]],
        ['one bad entry among good ones (all-or-nothing)', [{ recordId: 'a', fingerprint: 'f' }, { recordId: 2, fingerprint: 'f' }]],
    ])('throws CorruptDeltaRecordError for %s: a PRESENT record that cannot be read must not be read as "no journal"', (_label, value) => {
        expect(() => parseJournal(value)).toThrow(CorruptDeltaRecordError);
    });

    it('carries the caller description in the error message', () => {
        expect(() => parseJournal('x', 'journal record "journal.ns.ofac" is unreadable')).toThrow('journal record "journal.ns.ofac" is unreadable');
    });

    it('refuses a journal longer than one checkpoint window could ever produce', () => {
        const entries = Array.from({ length: MAX_JOURNAL_ENTRIES + 1 }, (_, i) => ({ recordId: String(i), fingerprint: 'f' }));
        expect(() => parseJournal(entries)).toThrow(CorruptDeltaRecordError);
        expect(parseJournal(entries.slice(0, MAX_JOURNAL_ENTRIES))).toHaveLength(MAX_JOURNAL_ENTRIES);
    });

    it('keeps prototype-named record ids as plain data', () => {
        expect(parseJournal([{ recordId: '__proto__', fingerprint: 'f' }, { recordId: 'constructor', fingerprint: 'g' }])).toEqual([
            { recordId: '__proto__', fingerprint: 'f' },
            { recordId: 'constructor', fingerprint: 'g' },
        ]);
    });
});

describe('parseState reports a present-but-unreadable per-source record instead of dropping it', () => {
    const good = { seenIds: ['a'], fingerprints: { a: 'f' }, lastRunAt: 't' };

    it('keeps valid records and lists no invalid source when everything is well formed', () => {
        const state = parseState({ version: 2, sources: { ofac: good } });
        expect(Object.keys(state.sources)).toEqual(['ofac']);
        expect(state.invalid).toBeUndefined();
    });

    it('treats a null or undefined record as absent, not invalid', () => {
        const state = parseState({ version: 2, sources: { ofac: null, sec: undefined, eu: good } });
        expect(Object.keys(state.sources)).toEqual(['eu']);
        expect(state.invalid).toBeUndefined();
    });

    it.each([
        ['a string (corrupt JSON)', 'not json'],
        ['a number', 5],
        ['an array', [1]],
        ['a missing seenIds', { fingerprints: {} }],
        ['a non-string id', { seenIds: [1], fingerprints: {} }],
        ['a non-string fingerprint', { seenIds: ['a'], fingerprints: { a: 1 } }],
        ['fingerprints that are not an object', { seenIds: ['a'], fingerprints: 'x' }],
    ])('lists a source whose record is %s as invalid, with the caller reason, and keeps the others', (_label, bad) => {
        const state = parseState({ version: 2, sources: { ofac: bad, eu: good } }, (source) => `record for ${source} is unreadable`);
        expect(Object.keys(state.sources)).toEqual(['eu']);
        expect(state.invalid).toEqual({ ofac: 'record for ofac is unreadable' });
    });

    it('keeps the invalid list when a source is processed (markProcessed)', () => {
        const state = parseState({ version: 2, sources: { ofac: 'bad', eu: good } });
        const next = markProcessed(state, 'eu', [{ recordId: 'b', fingerprint: 'g' }], 't2');
        expect(next.invalid).toEqual(state.invalid);
        expect(Object.keys(next.invalid ?? {})).toEqual(['ofac']);
    });
});

describe('InMemoryDeltaStore journal', () => {
    it('overwrites per source, clears on an empty list, and never aliases the caller array', async () => {
        const store = new InMemoryDeltaStore();
        const entries = [{ recordId: 'a', fingerprint: 'f' }];
        await store.saveJournal('s1', entries);
        entries.push({ recordId: 'b', fingerprint: 'f' });
        expect(await store.loadJournal('s1')).toEqual([{ recordId: 'a', fingerprint: 'f' }]);
        await store.saveJournal('s2', [{ recordId: 'z', fingerprint: 'g' }]);
        await store.saveJournal('s1', [{ recordId: 'c', fingerprint: 'f' }]);
        expect(await store.loadJournal('s1')).toEqual([{ recordId: 'c', fingerprint: 'f' }]);
        expect(await store.loadJournal('s2')).toEqual([{ recordId: 'z', fingerprint: 'g' }]);
        await store.saveJournal('s1', []);
        expect(await store.loadJournal('s1')).toEqual([]);
        expect(store.journalWrites).toBe(4);
    });
});
