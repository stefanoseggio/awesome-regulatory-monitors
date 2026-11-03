/**
 * The guarded `watchlist-hit` charge, as a drop-in for an Actor's own `main.ts`.
 *
 *   const chargeHit = createWatchlistHitCharger(Actor);
 *   ...
 *   if (matchedKeyword !== null) {          // matchedKeyword comes from findKeywordMatch() over a sanitizeKeywordList() list
 *       const outcome = await chargeHit();  // 'charged' | 'skipped_not_ppe' | 'skipped_unpriced' | 'skipped_cap' | 'limit_reached'
 *       if (outcome === 'limit_reached') break;
 *   }
 *
 * Under the hood this is `await Actor.charge({ eventName: 'watchlist-hit', count: 1 })`, reached only when the run
 * is pay-per-event AND `getPricingInfo().perEventPrices['watchlist-hit']` is an own, finite, positive number AND the
 * per-run hit/spend caps allow it. The SDK itself would otherwise treat an unpriced event as free and report it as
 * charged (`chargedCount === count`), so a typo such as `watchlist_hit` would silently bill nothing.
 */
import { type BillingPort, DEFAULT_HIT_BILLER_OPTIONS, type HitBillerOptions, type PortChargeResult, WatchlistHitBiller } from './charging.js';

/** The slice of the Apify `Actor` class this helper needs. */
export interface ChargingActor {
    getChargingManager(): { getPricingInfo(): { isPayPerEvent: boolean; perEventPrices?: Record<string, number> } };
    charge(options: { eventName: string; count?: number }): Promise<{ chargedCount: number; eventChargeLimitReached: boolean }>;
}

export function billingPortFromActor(actor: ChargingActor): BillingPort {
    return {
        isPayPerEvent: () => actor.getChargingManager().getPricingInfo().isPayPerEvent,
        perEventPrices: () => actor.getChargingManager().getPricingInfo().perEventPrices ?? {},
        async charge(eventName: string, count: number): Promise<PortChargeResult> {
            const result = await actor.charge({ eventName, count });
            return { chargedCount: result.chargedCount, eventChargeLimitReached: result.eventChargeLimitReached };
        },
    };
}

export function createWatchlistHitCharger(actor: ChargingActor, options: HitBillerOptions = DEFAULT_HIT_BILLER_OPTIONS): () => ReturnType<WatchlistHitBiller['chargeHit']> {
    const biller = new WatchlistHitBiller(billingPortFromActor(actor), options);
    return () => biller.chargeHit();
}
