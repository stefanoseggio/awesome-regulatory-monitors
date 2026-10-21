/**
 * Pay-Per-Event guard rails.
 *
 * Facts about the Apify SDK this module is built around (verified against the
 * installed `apify` typings, `dist/charging.d.ts`):
 *   - `Actor.getChargingManager().getPricingInfo()` exposes `isPayPerEvent` and
 *     `perEventPrices: Record<string, number>` (USD per event).
 *   - `calculateMaxEventChargeCountWithinLimit(eventName)` returns `Infinity`
 *     for an event that is NOT registered: an unregistered event is treated as
 *     FREE. A typo or an un-published price therefore never raises an error -
 *     it silently stops billing (or, worse, hides a billing assumption).
 *   - `charge()` can be partially fulfilled (`chargedCount < count`).
 *
 * So `watchlist-hit` is only ever charged when ALL of these hold:
 *   1. the run is pay-per-event;
 *   2. `perEventPrices` has an OWN property `watchlist-hit` with a finite price > 0
 *      (unpriced -> skipped and counted, never charged, never thrown);
 *   3. the per-run hit cap and the per-run hit-spend cap are not exhausted;
 *   4. the caller (router_core) proved a concrete keyword match from a non-empty,
 *      guard-sanitised keyword list (see `_guards.ts`).
 */

export const START_EVENT = 'apify-actor-start';
export const RESULT_EVENT = 'result';
export const WATCHLIST_HIT_EVENT = 'watchlist-hit';
/** Apify's automatic per-dataset-item event. It must never be priced alongside explicit events (double billing). */
export const DEFAULT_DATASET_ITEM_EVENT = 'apify-default-dataset-item';

export interface PortChargeResult {
    chargedCount: number;
    eventChargeLimitReached: boolean;
}

/** Billing port. `ApifyBilling` in `apify_adapters.ts` implements it; tests use {@link FakeBilling}. */
export interface BillingPort {
    isPayPerEvent(): boolean;
    perEventPrices(): Readonly<Record<string, number>>;
    charge(eventName: string, count: number): Promise<PortChargeResult>;
}

export interface PriceValidation {
    ok: boolean;
    problems: string[];
}

/** Validates a `perEventPrices` map as returned by the SDK. Pure. */
export function validatePerEventPrices(prices: unknown, requiredEvents: readonly string[] = []): PriceValidation {
    const problems: string[] = [];
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
        return { ok: false, problems: ['perEventPrices is not an object'] };
    }
    const map = prices as Record<string, unknown>;
    for (const [event, price] of Object.entries(map)) {
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
            problems.push(`event "${event}" has an invalid price (${String(price)})`);
        }
    }
    for (const event of requiredEvents) {
        if (!Object.prototype.hasOwnProperty.call(map, event)) {
            problems.push(`required event "${event}" is not priced`);
        } else if (typeof map[event] !== 'number' || !((map[event] as number) > 0)) {
            problems.push(`required event "${event}" must have a price > 0`);
        }
    }
    return { ok: problems.length === 0, problems };
}

export type ChargeOutcome =
    /** The event was billed (chargedCount >= 1). */
    | 'charged'
    /** Not a pay-per-event run: nothing to bill. */
    | 'skipped_not_ppe'
    /** PPE run but this event has no valid positive price: refused, counted, never billed. */
    | 'skipped_unpriced'
    /** A local per-run cap (hits or USD) was reached: refused. */
    | 'skipped_cap'
    /** The platform budget (`maxTotalChargeUsd`) is exhausted for this event: the caller must stop. */
    | 'limit_reached';

export interface HitBillerOptions {
    /** Hard ceiling on billed `watchlist-hit` events per run. */
    maxHitsPerRun: number;
    /** Hard ceiling on USD billed for `watchlist-hit` per run. */
    maxHitSpendUsd: number;
}

export const DEFAULT_HIT_BILLER_OPTIONS: HitBillerOptions = { maxHitsPerRun: 200, maxHitSpendUsd: 50 };

/** Hard-protected `Actor.charge({ eventName: 'watchlist-hit', count: 1 })`. */
const MICRO = 1_000_000;
const toMicro = (usd: number): number => Math.round(usd * MICRO);

export class WatchlistHitBiller {
    private hitsCharged = 0;
    /** Spend in integer micro-USD: summing decimal prices as floats drifts and trips a cap one hit early. */
    private spendMicro = 0;
    hitsUnpriced = 0;
    hitsCapped = 0;

    constructor(
        private readonly billing: BillingPort,
        private readonly options: HitBillerOptions = DEFAULT_HIT_BILLER_OPTIONS,
    ) {}

    get charged(): number {
        return this.hitsCharged;
    }

    get spent(): number {
        return this.spendMicro / MICRO;
    }

    async chargeHit(): Promise<ChargeOutcome> {
        if (!this.billing.isPayPerEvent()) return 'skipped_not_ppe';

        const prices = this.billing.perEventPrices();
        const price = Object.prototype.hasOwnProperty.call(prices, WATCHLIST_HIT_EVENT) ? prices[WATCHLIST_HIT_EVENT] : undefined;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
            this.hitsUnpriced += 1;
            return 'skipped_unpriced';
        }

        if (this.hitsCharged >= this.options.maxHitsPerRun || this.spendMicro + toMicro(price) > toMicro(this.options.maxHitSpendUsd)) {
            this.hitsCapped += 1;
            return 'skipped_cap';
        }

        const result = await this.billing.charge(WATCHLIST_HIT_EVENT, 1);
        if (result.chargedCount < 1) return 'limit_reached';

        this.hitsCharged += 1;
        this.spendMicro += toMicro(price);
        return result.eventChargeLimitReached ? 'limit_reached' : 'charged';
    }
}

/** Deterministic in-memory billing used by tests and `--dry-run` style harnesses. */
export class FakeBilling implements BillingPort {
    readonly calls: Array<{ eventName: string; count: number }> = [];
    private remainingBudgetUsd: number;

    constructor(
        private readonly ppe: boolean,
        private readonly prices: Record<string, number>,
        budgetUsd: number = Number.POSITIVE_INFINITY,
    ) {
        this.remainingBudgetUsd = budgetUsd;
    }

    isPayPerEvent(): boolean {
        return this.ppe;
    }

    perEventPrices(): Readonly<Record<string, number>> {
        return this.prices;
    }

    async charge(eventName: string, count: number): Promise<PortChargeResult> {
        const unit = this.prices[eventName] ?? 0;
        const affordable = unit === 0 ? count : Math.min(count, Math.floor(this.remainingBudgetUsd / unit));
        this.calls.push({ eventName, count: affordable });
        this.remainingBudgetUsd -= affordable * unit;
        return { chargedCount: affordable, eventChargeLimitReached: affordable < count || this.remainingBudgetUsd < unit };
    }

    totalFor(eventName: string): number {
        return this.calls.filter((c) => c.eventName === eventName).reduce((sum, c) => sum + c.count, 0);
    }
}
