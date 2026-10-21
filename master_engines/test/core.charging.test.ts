import { describe, expect, it } from 'vitest';

import { type BillingPort, FakeBilling, type PortChargeResult, validatePerEventPrices, WATCHLIST_HIT_EVENT, WatchlistHitBiller } from '../lib/charging.js';

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

/** A port that behaves like the SDK at the budget limit: it "overcharges by one" while any budget is left. */
class OverchargingBilling extends FakeBilling {
    spentUsd = 0;
    constructor(
        private readonly unitPrices: Record<string, number>,
        private readonly budget: number,
    ) {
        super(true, unitPrices, budget);
    }
    override affordableCount(eventName: string): number {
        const unit = this.unitPrices[eventName] ?? 0;
        return unit === 0 ? Number.POSITIVE_INFINITY : Math.floor((this.budget - this.spentUsd + 1e-9) / unit);
    }
    override async charge(eventName: string, count: number): Promise<PortChargeResult> {
        const unit = this.unitPrices[eventName] ?? 0;
        // like ChargingManager.charge: over the limit by one event is allowed while the total is not yet above the maximum
        const allowed = this.spentUsd + unit * count <= this.budget + 1e-9 ? count : this.spentUsd <= this.budget ? 1 : 0;
        this.spentUsd += allowed * unit;
        return { chargedCount: allowed, eventChargeLimitReached: this.spentUsd + unit > this.budget };
    }
}

describe('WatchlistHitBiller and the budget limit (the SDK overcharges by one event at the limit)', () => {
    const prices = { 'doc-new': 0.01, [WATCHLIST_HIT_EVENT]: 0.15 };

    it('does not attempt a hit the remaining budget cannot pay: stops with limit_reached and charges nothing', async () => {
        const billing = new FakeBilling(true, prices, 0.14);
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('limit_reached');
        expect(billing.calls.filter((c) => c.eventName === WATCHLIST_HIT_EVENT)).toEqual([]);
        expect(biller.charged).toBe(0);
    });

    it('charges the hit when the remaining budget pays exactly one', async () => {
        const billing = new FakeBilling(true, prices, 0.15);
        const biller = new WatchlistHitBiller(billing);
        expect(await biller.chargeHit()).toBe('limit_reached'); // the budget is spent by this hit
        expect(billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);
    });

    it('never exceeds the customer maximum with a port that overcharges by one, because it asks first (control: without the question it overshoots by one hit)', async () => {
        const asking = new OverchargingBilling(prices, 0.15);
        await asking.charge('doc-new', 1); // 0.01 spent, 0.14 left: less than one hit
        expect(await new WatchlistHitBiller(asking).chargeHit()).toBe('limit_reached');
        expect(asking.spentUsd).toBeCloseTo(0.01, 9);

        // the same port WITHOUT affordableCount (the old behaviour) bills the hit and overshoots the 0.15 maximum
        class NoQuestion implements BillingPort {
            constructor(private readonly inner: OverchargingBilling) {}
            isPayPerEvent = () => this.inner.isPayPerEvent();
            perEventPrices = () => this.inner.perEventPrices();
            charge = (eventName: string, count: number) => this.inner.charge(eventName, count);
        }
        const inner = new OverchargingBilling(prices, 0.15);
        await inner.charge('doc-new', 1);
        expect(await new WatchlistHitBiller(new NoQuestion(inner)).chargeHit()).toBe('limit_reached');
        expect(inner.spentUsd).toBeCloseTo(0.16, 9);
    });

    it('a port without affordableCount is treated as unbounded (nothing else changes)', async () => {
        class Plain implements BillingPort {
            charges = 0;
            isPayPerEvent = () => true;
            perEventPrices = () => prices;
            charge = async (): Promise<PortChargeResult> => {
                this.charges += 1;
                return { chargedCount: 1, eventChargeLimitReached: false };
            };
        }
        const plain = new Plain();
        expect(await new WatchlistHitBiller(plain).chargeHit()).toBe('charged');
        expect(plain.charges).toBe(1);
    });

    it('FakeBilling.affordableCount is the budget divided by the price, Infinity for a free event or no budget', () => {
        const billing = new FakeBilling(true, { 'doc-new': 0.01, free: 0 }, 0.05);
        expect(billing.affordableCount('doc-new')).toBe(5);
        expect(billing.affordableCount('free')).toBe(Number.POSITIVE_INFINITY);
        expect(billing.affordableCount('unpriced')).toBe(Number.POSITIVE_INFINITY);
        expect(new FakeBilling(true, { 'doc-new': 0.01 }).affordableCount('doc-new')).toBe(Number.POSITIVE_INFINITY);
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
