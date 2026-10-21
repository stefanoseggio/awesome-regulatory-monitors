/**
 * Ghost-billing regression proof for the SEC enforcement source.
 *
 * The legacy actor matched `watchlistNames` as a raw case-insensitive substring, so an empty, blank or
 * one-character entry matched every respondent and every record was billed as a `watchlist-hit` ($0.15 each).
 * These tests drive the REAL router (`runEngine`) with the REAL `sec_enforcement` connector, `FakeBilling`
 * and `InMemoryDeltaStore`, and assert on what would have been invoiced:
 *   - every hostile / degenerate watchlist shape yields ZERO `is_watchlist_match` rows and ZERO `watchlist-hit`
 *     charges, while the run still emits and bills its normal `result` rows (so the proof is not vacuous);
 *   - a legitimate keyword against an "ACME CORP." style respondent yields exactly ONE hit and ONE charge.
 *
 * The feed items are byte-exact live SEC captures plus ONE clearly SYNTHETIC item (LR-99999, "ACME CORP."),
 * because the live window did not happen to contain an "Acme" respondent.
 */
import { describe, expect, it } from 'vitest';

import { secEnforcementConnector } from '../global-regtech-compliance-feed/connectors/secEnforcement.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import {
    buildAdminRss,
    buildLitigationRss,
    createEngineHarness,
    createStubHttp,
    SEC_ADMIN_URL,
    SEC_LITIGATION_URL,
    syntheticLitigationItem,
} from './regtech-b.helpers.js';
import { LIVE_LITIGATION_ITEMS } from './regtech-b.secFixtures.js';

/** SYNTHETIC: not a real SEC release. Present only to give the watchlist something legitimate to hit. */
const SYNTHETIC_ACME = syntheticLitigationItem({ number: 'LR-99999', title: 'ACME CORP.', pubDate: 'Tue, 20 Oct 2026 16:00:00 -0400' });

const LIVE_LITIGATION_COUNT = LIVE_LITIGATION_ITEMS.length; // 4
const LIVE_ADMIN_COUNT = 5;
const TOTAL_ROWS = LIVE_LITIGATION_COUNT + 1 + LIVE_ADMIN_COUNT; // 10 including the synthetic ACME item

function newHarness(prices?: Record<string, number>, store?: InMemoryDeltaStore) {
    const { http } = createStubHttp({
        [SEC_LITIGATION_URL]: buildLitigationRss([...LIVE_LITIGATION_ITEMS, SYNTHETIC_ACME]),
        [SEC_ADMIN_URL]: buildAdminRss(),
    });
    return createEngineHarness({ connectors: [secEnforcementConnector], http, ...(prices ? { prices } : {}), ...(store ? { store } : {}) });
}

const baseInput = { sources: ['sec_enforcement'], deltaMode: 'all' } as const;

/** Every shape the original bug (or a careless UI paste) can produce, plus the ones the guard must not coerce. */
const DEGENERATE_WATCHLISTS: Array<[label: string, value: unknown]> = [
    ['[""] (empty string element)', ['']],
    ['[" "] (blank element)', [' ']],
    ['"" (bare empty string)', ''],
    ['"a" (bare string, once iterated per character)', 'a'],
    ['["a"] (one-letter needle)', ['a']],
    ['["--"] (punctuation only)', ['--']],
    ['[null]', [null]],
    ['42 (number where an array is expected)', 42],
    ['all-whitespace / zero-width string', '​​ ⁠﻿ ‍  \t\n'],
    ['[] (empty list)', []],
    ['undefined (field omitted)', undefined],
    ['mixed junk ["", " ", "a", "--", null]', ['', ' ', 'a', '--', null]],
    ['{} (object)', {}],
    ['true (boolean)', true],
    ['[["Acme Corp"]] (nested array is not a string)', [['Acme Corp']]],
    ['["\\u200b\\u200b"] (zero-width only)', ['​​']],
    ['[".", "()", "  --  "] (no letter or digit)', ['.', '()', '  --  ']],
];

describe('SEC enforcement: degenerate watchlists can never match or bill', () => {
    it.each(DEGENERATE_WATCHLISTS)('watchlistNames = %s -> zero matches, zero watchlist-hit charges', async (_label, watchlistNames) => {
        const harness = newHarness();
        const summary = await harness.run({ ...baseInput, watchlistNames });

        // Not vacuous: the run really fetched and billed its normal rows.
        expect(harness.rows).toHaveLength(TOTAL_ROWS);
        expect(harness.billing.totalFor('result')).toBe(TOTAL_ROWS);

        expect(harness.rows.filter((row) => row.is_watchlist_match === true)).toHaveLength(0);
        expect(harness.rows.every((row) => row.matched_watchlist_keyword === null)).toBe(true);
        expect(harness.billing.totalFor('watchlist-hit')).toBe(0);
        expect(harness.billing.calls.filter((c) => c.eventName === 'watchlist-hit')).toHaveLength(0);
        expect(summary.watchlist.accepted).toBe(0);
        expect(summary.watchlist.hitsCharged).toBe(0);
        expect(summary.watchlist.hitsUnpriced).toBe(0);
        expect(summary.sources[0]?.watchlistHits).toBe(0);
    });

    it('a legacy-style watchlist inside sourceOptions.sec_enforcement cannot match or bill either', async () => {
        const harness = newHarness();
        const summary = await harness.run({
            ...baseInput,
            sourceOptions: { sec_enforcement: { watchlistNames: ['', ' ', 'a', 'Acme Corp'] } },
        });
        expect(harness.rows).toHaveLength(TOTAL_ROWS);
        expect(harness.rows.some((row) => row.is_watchlist_match === true)).toBe(false);
        expect(harness.billing.totalFor('watchlist-hit')).toBe(0);
        expect(summary.watchlist.hitsCharged).toBe(0);
    });

    it('stays at zero even when the watchlist-hit event is priced at the ghost-billing rate ($0.15)', async () => {
        const harness = newHarness({ result: 0.05, 'watchlist-hit': 0.15 });
        await harness.run({ ...baseInput, watchlistNames: [''] });
        const hitSpend = harness.billing.calls.filter((c) => c.eventName === 'watchlist-hit').reduce((sum, c) => sum + c.count * 0.15, 0);
        expect(hitSpend).toBe(0);
    });
});

describe('SEC enforcement: a legitimate keyword hits exactly once', () => {
    function assertSingleAcmeHit(harness: ReturnType<typeof newHarness>, keyword: string): void {
        const hits = harness.rows.filter((row) => row.is_watchlist_match === true);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ release_number: 'LR-99999', primary_respondent: 'ACME CORP.', matched_watchlist_keyword: keyword });
        expect(harness.billing.totalFor('watchlist-hit')).toBe(1);
        expect(harness.billing.totalFor('result')).toBe(TOTAL_ROWS);
    }

    it('["Acme Corp"] against respondent "ACME CORP." -> one hit, one charge', async () => {
        const harness = newHarness();
        const summary = await harness.run({ ...baseInput, watchlistNames: ['Acme Corp'] });
        assertSingleAcmeHit(harness, 'Acme Corp');
        expect(summary.watchlist).toMatchObject({ accepted: 1, rejected: 0, hitsCharged: 1, hitsUnpriced: 0 });
        expect(summary.sources[0]?.watchlistHits).toBe(1);
    });

    it('junk entries beside a real keyword are rejected without disturbing the one hit', async () => {
        const harness = newHarness();
        const summary = await harness.run({ ...baseInput, watchlistNames: ['', 'a', ' ', 'Acme Corp', null, '--'] });
        assertSingleAcmeHit(harness, 'Acme Corp');
        expect(summary.watchlist.accepted).toBe(1);
        expect(summary.watchlist.rejected).toBe(5);
    });

    it('normalises case and whitespace: "  acme   CORP " still hits once', async () => {
        const harness = newHarness();
        await harness.run({ ...baseInput, watchlistNames: ['  acme   CORP '] });
        assertSingleAcmeHit(harness, 'acme CORP');
    });

    it('a bare comma-separated string is split into keywords, never iterated per character', async () => {
        const harness = newHarness();
        const summary = await harness.run({ ...baseInput, watchlistNames: 'Acme Corp, a, ' });
        assertSingleAcmeHit(harness, 'Acme Corp');
        expect(summary.watchlist.accepted).toBe(1);
    });

    it('a keyword that matches nothing produces no hit and no charge', async () => {
        const harness = newHarness();
        await harness.run({ ...baseInput, watchlistNames: ['Zzyzx Holdings'] });
        expect(harness.rows.some((row) => row.is_watchlist_match === true)).toBe(false);
        expect(harness.billing.totalFor('watchlist-hit')).toBe(0);
    });

    it('matches a co-respondent that is not the primary respondent (watchText is the whole title)', async () => {
        const harness = newHarness();
        await harness.run({ ...baseInput, watchlistNames: ['Matthew Brown Companies'] });
        const hits = harness.rows.filter((row) => row.is_watchlist_match === true);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ release_number: 'LR-26673', primary_respondent: 'Matthew Brown' });
        expect(harness.billing.totalFor('watchlist-hit')).toBe(1);
    });
});

describe('SEC enforcement: billing safeguards around a real hit', () => {
    it('an unpriced watchlist-hit event is flagged as a match but never charged', async () => {
        const harness = newHarness({ result: 0.05 });
        const summary = await harness.run({ ...baseInput, watchlistNames: ['Acme Corp'] });
        expect(harness.rows.filter((row) => row.is_watchlist_match === true)).toHaveLength(1);
        expect(harness.billing.totalFor('watchlist-hit')).toBe(0);
        expect(summary.watchlist.hitsUnpriced).toBe(1);
        expect(summary.watchlist.hitsCharged).toBe(0);
    });

    it('maxWatchlistHitsPerRun = 0 turns a real hit into zero charges', async () => {
        const harness = newHarness();
        await harness.run({ ...baseInput, watchlistNames: ['Acme Corp'], maxWatchlistHitsPerRun: 0 });
        expect(harness.billing.totalFor('watchlist-hit')).toBe(0);
    });

    it('an unchanged record is neither re-emitted nor re-billed on the next run (delta memory)', async () => {
        const store = new InMemoryDeltaStore();
        const first = newHarness(undefined, store);
        await first.run({ sources: ['sec_enforcement'], deltaMode: 'onlyChanged', watchlistNames: ['Acme Corp'] });
        expect(first.billing.totalFor('watchlist-hit')).toBe(1);

        const second = newHarness(undefined, store);
        const summary = await second.run({ sources: ['sec_enforcement'], deltaMode: 'onlyChanged', watchlistNames: ['Acme Corp'] });
        expect(second.rows).toHaveLength(0);
        expect(second.billing.totalFor('result')).toBe(0);
        expect(second.billing.totalFor('watchlist-hit')).toBe(0);
        expect(summary.sources[0]).toMatchObject({ fetched: TOTAL_ROWS, emitted: 0, unchanged: TOTAL_ROWS });
    });
});
