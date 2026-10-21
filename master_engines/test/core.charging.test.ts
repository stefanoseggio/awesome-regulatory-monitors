import { describe, expect, it } from 'vitest';

import { FakeBilling, validatePerEventPrices, WATCHLIST_HIT_EVENT, WatchlistHitBiller } from '../lib/charging.js';

describe('WatchlistHitBiller', () => {
    it('charges exactly one watchlist-hit when PPE and priced', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 0.05 });
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('charged');
        expect(billing.calls).toEqual([{ eventName: WATCHLIST_HIT_EVENT, count: 1 }]);
        expect(biller.charged).toBe(1);
        expect(biller.spent).toBeCloseTo(0.05);
    });

    it('never charges outside pay-per-event', async () => {
        const billing = new FakeBilling(false, { 'watchlist-hit': 0.05 });
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('skipped_not_ppe');
        expect(billing.calls).toHaveLength(0);
    });

    it.each([
        ['missing', {}],
        ['zero', { 'watchlist-hit': 0 }],
        ['negative', { 'watchlist-hit': -1 }],
        ['NaN', { 'watchlist-hit': Number.NaN }],
        ['Infinity', { 'watchlist-hit': Number.POSITIVE_INFINITY }],
        ['string', { 'watchlist-hit': '0.05' as unknown as number }],
        ['inherited only', Object.create({ 'watchlist-hit': 0.05 }) as Record<string, number>],
    ])('refuses to charge when the price is %s', async (_label, prices) => {
        const billing = new FakeBilling(true, prices);
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('skipped_unpriced');
        expect(billing.calls).toHaveLength(0);
        expect(biller.hitsUnpriced).toBe(1);
    });

    it('enforces the per-run hit cap', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 0.01 });
        const biller = new WatchlistHitBiller(billing, { maxHitsPerRun: 2, maxHitSpendUsd: 100 });
        expect(await biller.chargeHit()).toBe('charged');
        expect(await biller.chargeHit()).toBe('charged');
        expect(await biller.chargeHit()).toBe('skipped_cap');
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(2);
        expect(biller.hitsCapped).toBe(1);
    });

    it('enforces the per-run USD cap before charging, not after', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 0.4 });
        const biller = new WatchlistHitBiller(billing, { maxHitsPerRun: 100, maxHitSpendUsd: 1 });
        expect(await biller.chargeHit()).toBe('charged');
        expect(await biller.chargeHit()).toBe('charged');
        expect(await biller.chargeHit()).toBe('skipped_cap');
        expect(biller.spent).toBeCloseTo(0.8);
    });

    it('treats a partially/zero fulfilled platform charge as limit_reached', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 1 }, 0);
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('limit_reached');
        expect(biller.charged).toBe(0);
    });

    it('reports limit_reached on the charge that exhausts the budget', async () => {
        const billing = new FakeBilling(true, { 'watchlist-hit': 1 }, 1);
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('limit_reached');
        expect(biller.charged).toBe(1);
    });
});

describe('validatePerEventPrices', () => {
    it('accepts a valid map', () => {
        expect(validatePerEventPrices({ 'apify-actor-start': 0.005, result: 0.002, 'watchlist-hit': 0.05 }, ['watchlist-hit']).ok).toBe(true);
    });

    it('reports invalid and missing required events', () => {
        const v = validatePerEventPrices({ result: -1, other: 'x' }, ['watchlist-hit']);
        expect(v.ok).toBe(false);
        expect(v.problems).toHaveLength(3);
    });

    it('requires a positive price for required events', () => {
        expect(validatePerEventPrices({ 'watchlist-hit': 0 }, ['watchlist-hit']).ok).toBe(false);
    });

    it('rejects non-objects', () => {
        expect(validatePerEventPrices(null).ok).toBe(false);
        expect(validatePerEventPrices([]).ok).toBe(false);
        expect(validatePerEventPrices('x').ok).toBe(false);
    });
});
