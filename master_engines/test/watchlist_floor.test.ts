/**
 * Finding F-11 of the pre-publication review of 2026-11-02: the watchlist has a floor of three characters (letters or digits).
 * Every match of a watchlist keyword is a billed `watchlist-hit`, and a two-character keyword ("AG", "SA", "LL") is a substring of
 * a large share of company names. `sanitizeKeywordList` also reads about fifteen connector options for which a two-character entry
 * is a real value (the SSIC division "62" of sg_acra), so its default floor stays 2; only the watchlist is raised.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findKeywordMatch, MIN_KEYWORD_LENGTH, MIN_WATCHLIST_KEYWORD_LENGTH, sanitizeKeywordList, sanitizeWatchlist } from '../lib/_guards.js';
import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import type { Connector, ConnectorContext, RunSummary, SourceRecord } from '../lib/types.js';

const reasons = (list: ReturnType<typeof sanitizeWatchlist>): string[] => list.rejected.map((r) => r.reason);

describe('F-11: the watchlist floor', () => {
    it('is 3 for the watchlist and stays 2 for every other keyword list', () => {
        expect(MIN_WATCHLIST_KEYWORD_LENGTH).toBe(3);
        expect(MIN_KEYWORD_LENGTH).toBe(2);
    });

    it('refuses two letters or digits, bare or padded with punctuation, as too_short', () => {
        const list = sanitizeWatchlist(['AG', 'BP', '3M', 'a.b', 'S.A.', '(ab)', '1.2', 'a-1']);
        expect(list.keywords).toEqual([]);
        expect(reasons(list)).toEqual(Array.from({ length: 8 }, () => 'too_short'));
    });

    it('keeps the other reasons once the entry is long enough to reach them: one letter is single_letter_or_digit, none is no_letter_or_digit', () => {
        // "c." and "--" are two characters and stop at the length rule; "a--" and "---" have three characters and reach the count of letters or digits
        const list = sanitizeWatchlist(['c.', '--', 'a--', 'a | -', '---']);
        expect(reasons(list)).toEqual(['too_short', 'too_short', 'single_letter_or_digit', 'single_letter_or_digit', 'no_letter_or_digit']);
    });

    it('accepts three letters or digits, wherever the punctuation sits', () => {
        const list = sanitizeWatchlist(['IBM', 'UBS', '3M1', 'a.b.c', 'S.A.R', '(abc)', 'Acme Corp']);
        expect(list.keywords).toEqual(['IBM', 'UBS', '3M1', 'a.b.c', 'S.A.R', '(abc)', 'Acme Corp']);
        expect(list.rejected).toEqual([]);
    });

    it('counts glyphs and visible characters against the same floor: two expanding glyphs are two characters', () => {
        expect(reasons(sanitizeWatchlist(['⑳⑳', '№№']))).toEqual(['too_short', 'too_short']);
        expect(sanitizeWatchlist(['⑳⑳⑳']).keywords).toEqual(['202020']);
    });

    it('does not let a caller lower the floor below the structural minimum of 2', () => {
        expect(sanitizeKeywordList(['a', 'ab'], 0).keywords).toEqual(['ab']);
        expect(sanitizeKeywordList(['a', 'ab'], 1).keywords).toEqual(['ab']);
        expect(sanitizeKeywordList(['ab', 'abc'], 3).keywords).toEqual(['abc']);
        expect(sanitizeKeywordList(['ab', 'abc'], Number.NaN).keywords).toEqual(['ab', 'abc']);
    });

    it('leaves the connector-option reader at 2: the SSIC division "62" and a two-letter sponsor are valid there', () => {
        const options = sanitizeKeywordList(['62', 'BP', '4651']);
        expect(options.keywords).toEqual(['62', 'BP', '4651']);
        expect(options.rejected).toEqual([]);
        // and the same entries are refused as a watchlist
        expect(sanitizeWatchlist(['62', 'BP', '4651']).keywords).toEqual(['4651']);
    });

    it('matching is unchanged: a hand-built list with a two-character needle still matches by the structural rule', () => {
        const options = sanitizeKeywordList(['BP']);
        expect(findKeywordMatch('BP plc', options)).toBe('BP');
        expect(findKeywordMatch('BP plc', sanitizeWatchlist(['BP']))).toBeNull();
    });
});

describe('F-11: the router reads watchlistNames through the watchlist floor, end to end', () => {
    const silent = { info() {}, warning() {}, error() {}, debug() {} };
    const ctx: ConnectorContext = {
        http: {
            async getText() {
                throw new Error('no network in this test');
            },
            async getJson() {
                throw new Error('no network in this test');
            },
        },
        log: silent,
        now: () => new Date('2026-11-02T00:00:00Z'),
    };
    const clock = () => new Date('2026-11-02T00:00:00Z');

    function engineOf(records: SourceRecord[]): EngineDefinition {
        const connector: Connector<any> = {
            id: 'alpha',
            engine: 'global-regtech-compliance-feed',
            legacyActor: 'legacy-alpha',
            description: 'alpha',
            status: 'active',
            optionsSchema: z.object({}).passthrough(),
            async fetch() {
                return records;
            },
        };
        return { slug: 'global-regtech-compliance-feed', connectors: [connector] };
    }

    async function run(watchlistNames: unknown): Promise<{ summary: RunSummary; rows: Array<Record<string, unknown>>; hits: number }> {
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.15 });
        const rows: Array<Record<string, unknown>> = [];
        const summaries: RunSummary[] = [];
        const sinks: RunSinks = {
            async emit(row, eventName = RESULT_EVENT) {
                const charged = await billing.charge(eventName, 1);
                if (charged.chargedCount < 1) return { emitted: false, limitReached: true };
                rows.push(row);
                return { emitted: true, limitReached: charged.eventChargeLimitReached };
            },
            billing,
            store: new InMemoryDeltaStore(),
            async saveSummary(s) {
                summaries.push(s);
            },
        };
        const records: SourceRecord[] = [
            { recordId: '1', fingerprint: 'a', payload: {}, watchText: 'AG Holdings' },
            { recordId: '2', fingerprint: 'a', payload: {}, watchText: 'Acme Corp' },
            { recordId: '3', fingerprint: 'a', payload: {}, watchText: 'Zeta SA' },
        ];
        const summary = await runEngine(engineOf(records), { sources: ['alpha'], watchlistNames }, { sinks, ctx, clock });
        const hits = billing.calls.filter((c) => c.eventName === WATCHLIST_HIT_EVENT).reduce((sum, c) => sum + c.count, 0);
        return { summary, rows, hits };
    }

    it('bills a three-letter keyword and refuses the two-letter one next to it', async () => {
        const { summary, rows, hits } = await run(['AG', 'Acme']);
        expect(summary.watchlist.accepted).toBe(1);
        expect(summary.watchlist.rejected).toBe(1);
        expect(rows.map((r) => r.is_watchlist_match)).toEqual([false, true, false]);
        expect(hits).toBe(1);
    });

    it('bills nothing when every keyword is short of the floor', async () => {
        const { summary, rows, hits } = await run(['AG', 'SA', 'Ze']);
        expect(summary.watchlist.accepted).toBe(0);
        expect(rows.map((r) => r.is_watchlist_match)).toEqual([false, false, false]);
        expect(hits).toBe(0);
    });
});
