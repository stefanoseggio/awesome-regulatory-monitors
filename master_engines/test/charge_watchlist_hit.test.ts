import { describe, expect, it } from 'vitest';

import { type ChargingActor, createWatchlistHitCharger } from '../lib/charge_watchlist_hit.js';

function fakeActor(opts: { ppe: boolean; prices?: Record<string, number>; budget?: number }) {
    const charges: Array<{ eventName: string; count?: number }> = [];
    let remaining = opts.budget ?? Number.POSITIVE_INFINITY;
    const actor: ChargingActor = {
        getChargingManager: () => ({ getPricingInfo: () => ({ isPayPerEvent: opts.ppe, perEventPrices: opts.prices }) }),
        async charge(o) {
            charges.push(o);
            const unit = opts.prices?.[o.eventName] ?? 0;
            const n = unit === 0 ? (o.count ?? 1) : Math.min(o.count ?? 1, Math.floor(remaining / unit));
            remaining -= n * unit;
            return { chargedCount: n, eventChargeLimitReached: n < (o.count ?? 1) || remaining < unit };
        },
    };
    return { actor, charges };
}

describe('createWatchlistHitCharger', () => {
    it('calls Actor.charge({ eventName: "watchlist-hit", count: 1 }) when PPE and priced', async () => {
        const { actor, charges } = fakeActor({ ppe: true, prices: { 'watchlist-hit': 0.15 } });
        expect(await createWatchlistHitCharger(actor)()).toBe('charged');
        expect(charges).toEqual([{ eventName: 'watchlist-hit', count: 1 }]);
    });

    it('never calls Actor.charge for a typo such as watchlist_hit that the SDK would treat as free', async () => {
        const { actor, charges } = fakeActor({ ppe: true, prices: { watchlist_hit: 0.15 } });
        expect(await createWatchlistHitCharger(actor)()).toBe('skipped_unpriced');
        expect(charges).toHaveLength(0);
    });

    it('never calls Actor.charge when perEventPrices is undefined or the run is not PPE', async () => {
        const a = fakeActor({ ppe: true });
        expect(await createWatchlistHitCharger(a.actor)()).toBe('skipped_unpriced');
        const b = fakeActor({ ppe: false, prices: { 'watchlist-hit': 0.15 } });
        expect(await createWatchlistHitCharger(b.actor)()).toBe('skipped_not_ppe');
        expect(a.charges.length + b.charges.length).toBe(0);
    });

    it('honours the per-run caps and reports the platform limit', async () => {
        const capped = fakeActor({ ppe: true, prices: { 'watchlist-hit': 0.15 } });
        const charge = createWatchlistHitCharger(capped.actor, { maxHitsPerRun: 2, maxHitSpendUsd: 100 });
        expect(await charge()).toBe('charged');
        expect(await charge()).toBe('charged');
        expect(await charge()).toBe('skipped_cap');
        const broke = fakeActor({ ppe: true, prices: { 'watchlist-hit': 0.15 }, budget: 0 });
        expect(await createWatchlistHitCharger(broke.actor)()).toBe('limit_reached');
    });
});
