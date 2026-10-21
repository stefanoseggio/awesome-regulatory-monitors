/**
 * Renders the Pay-Per-Event pricing body for `PUT /v2/actors/{actorId}` from the event catalog.
 *
 * Field names follow Apify's published API reference (docs.apify.com/api/v2/actor-put) as verified in
 * docs-research/apify-ppe-policy-verification.md. This module only BUILDS a body: it never calls the API.
 *
 * NOTICE POLICY (Store Publishing Terms section 9.4, verified in the same report; the brief's "2.2.4.2" is
 * "Specific Prohibitions" in the current edition, not the price-change rule): a change that can increase a user's
 * price - including a pricing-model change and a NEW paid event - becomes effective only 14 days after it is
 * submitted, is limited to one per month per Actor, and cannot be cancelled or edited while pending. The API has no
 * field that sets a notice period: `startedAt` is the effective date and the platform stamps
 * `notifiedAboutFutureChangeAt`. If the Actor has no paying users there is no waiting period.
 */
import {
    APIFY_DEFAULT_START_PRICE_USD,
    type EnginePricing,
    RECORD_LEVEL_EVENTS,
    START_PRICE_MAX_USD,
    START_PRICE_MIN_USD,
} from './event_catalog.js';

export const NOTICE_DAYS = 14;
export const START_EVENT_NAME = 'apify-actor-start';
export const DEFAULT_DATASET_ITEM_EVENT = 'apify-default-dataset-item';
/** Apify's share of PPE revenue; the API schema marks `apifyMarginPercentage` required. */
export const APIFY_MARGIN_PERCENTAGE = 0.2;
/** Smallest total charge a caller can set on a run of this Actor. */
export const MINIMAL_MAX_TOTAL_CHARGE_USD = 0.1;

const EVENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export interface ChargeEventBody {
    eventTitle: string;
    eventDescription: string;
    eventPriceUsd: number;
    isOneTimeEvent?: boolean;
    isPrimaryEvent?: boolean;
}

export interface PricingPutBody {
    pricingInfos: Array<{
        pricingModel: 'PAY_PER_EVENT';
        pricingPerEvent: { actorChargeEvents: Record<string, ChargeEventBody> };
        minimalMaxTotalChargeUsd: number;
        apifyMarginPercentage: number;
        createdAt: string;
        startedAt: string;
        reasonForChange: string;
    }>;
}

export interface NoticeMetadata {
    engine: string;
    policy: string;
    noticeDays: number;
    hasPayingUsers: boolean;
    submittedAt: string;
    effectiveAt: string;
    changeLimit: string;
    startEventPriceUsd: number;
    startEventPerRunUsd: number;
    memoryMbytes: number;
    reasonForChange: string;
    provisionalEvents: string[];
    operatorStatedEvents: string[];
    notes: string[];
}

export interface BuildOptions {
    /** ISO-8601 instant used as `createdAt`. Passed in so the output is deterministic. */
    now: string;
    /** true -> `startedAt = now + 14 days`; false -> `startedAt = now`. Default true: the conservative assumption. */
    hasPayingUsers?: boolean;
    reasonForChange?: string;
    /** Refuse to build while any event is not 'legacy-readme'. */
    strict?: boolean;
}

export function validatePricing(pricing: EnginePricing): string[] {
    const problems: string[] = [];
    const names = new Set<string>();

    if (!Number.isFinite(pricing.startPriceUsd) || pricing.startPriceUsd < START_PRICE_MIN_USD || pricing.startPriceUsd > START_PRICE_MAX_USD) {
        problems.push(`startPriceUsd ${pricing.startPriceUsd} is outside the requested $${START_PRICE_MIN_USD}-$${START_PRICE_MAX_USD} range`);
    }
    if (!(pricing.memoryMbytes >= 256) || pricing.memoryMbytes % 256 !== 0) problems.push(`memoryMbytes ${pricing.memoryMbytes} must be a multiple of 256 and at least 256`);

    let primaries = 0;
    for (const event of pricing.events) {
        const where = `event "${event.name}"`;
        if (!EVENT_NAME.test(event.name)) problems.push(`${where}: name must be kebab-case`);
        if (event.name === START_EVENT_NAME) problems.push(`${where}: the start event is set via startPriceUsd, not as a catalog event`);
        if (event.name === DEFAULT_DATASET_ITEM_EVENT) problems.push(`${where}: must not be priced - with it priced, pushData(item, eventName) bills both events per row`);
        if (names.has(event.name)) problems.push(`${where}: duplicate`);
        names.add(event.name);
        if (!Number.isFinite(event.priceUsd) || event.priceUsd <= 0 || event.priceUsd > 10) problems.push(`${where}: priceUsd ${event.priceUsd} must be a finite number in (0, 10]`);
        if (event.title.trim() === '' || event.title.length > 80) problems.push(`${where}: title must be 1-80 characters`);
        if (event.description.trim() === '' || event.description.length > 500) problems.push(`${where}: description must be 1-500 characters`);
        if (event.evidence.trim() === '') problems.push(`${where}: evidence is required`);
        if (event.primary) primaries += 1;
    }
    if (primaries !== 1) problems.push(`exactly one primary event is required, found ${primaries}`);
    if (!names.has('watchlist-hit')) problems.push('the watchlist-hit event must be priced (billing it unpriced is silently free)');

    const referenced = new Set<string>(RECORD_LEVEL_EVENTS[pricing.engine]);
    for (const [source, billing] of Object.entries(pricing.sourceBilling)) {
        for (const event of [billing.newEvent, billing.updatedEvent, billing.snapshotEvent]) {
            if (event === undefined) continue;
            referenced.add(event);
            if (!names.has(event)) problems.push(`source "${source}" bills "${event}", which is not in the catalog (it would be free)`);
        }
        if (billing.newEvent === undefined) problems.push(`source "${source}" has no newEvent`);
    }
    for (const event of RECORD_LEVEL_EVENTS[pricing.engine]) {
        if (!names.has(event)) problems.push(`record-level event "${event}" is not in the catalog (it would be free)`);
    }
    for (const name of names) {
        if (name !== 'watchlist-hit' && !referenced.has(name)) problems.push(`event "${name}" is priced but no source bills it`);
    }
    return problems;
}

export function addDays(iso: string, days: number): string {
    const base = Date.parse(iso);
    if (!Number.isFinite(base)) throw new Error(`Invalid ISO timestamp: ${iso}`);
    return new Date(base + days * 86_400_000).toISOString();
}

export function buildPricingPutBody(pricing: EnginePricing, options: BuildOptions): { body: PricingPutBody; notice: NoticeMetadata } {
    const problems = validatePricing(pricing);
    if (problems.length > 0) throw new Error(`Invalid pricing for ${pricing.engine}:\n- ${problems.join('\n- ')}`);

    const provisional = pricing.events.filter((e) => e.basis === 'provisional').map((e) => e.name);
    const operatorStated = pricing.events.filter((e) => e.basis === 'operator-stated').map((e) => e.name);
    if (options.strict && (provisional.length > 0 || operatorStated.length > 0)) {
        throw new Error(`--strict: ${pricing.engine} has non-documented prices (provisional: ${provisional.join(', ') || 'none'}; operator-stated: ${operatorStated.join(', ') || 'none'}).`);
    }

    const hasPayingUsers = options.hasPayingUsers ?? true;
    const createdAt = new Date(Date.parse(options.now)).toISOString();
    const startedAt = hasPayingUsers ? addDays(options.now, NOTICE_DAYS) : createdAt;
    const reasonForChange =
        options.reasonForChange ??
        `Consolidation of single-source Actors into ${pricing.engine}: each legacy source keeps its own per-record price as a separate event, and the start event is set to $${pricing.startPriceUsd}.`;

    const actorChargeEvents: Record<string, ChargeEventBody> = {
        [START_EVENT_NAME]: {
            eventTitle: 'Actor start',
            eventDescription: 'Charged when the Actor starts running. Number of events charged depends on Actor memory (one event per GB, minimum one event).',
            eventPriceUsd: pricing.startPriceUsd,
            isOneTimeEvent: true,
        },
    };
    for (const event of pricing.events) {
        actorChargeEvents[event.name] = {
            eventTitle: event.title,
            eventDescription: event.description,
            eventPriceUsd: event.priceUsd,
            ...(event.primary ? { isPrimaryEvent: true } : {}),
        };
    }

    const body: PricingPutBody = {
        pricingInfos: [
            {
                pricingModel: 'PAY_PER_EVENT',
                pricingPerEvent: { actorChargeEvents },
                minimalMaxTotalChargeUsd: MINIMAL_MAX_TOTAL_CHARGE_USD,
                apifyMarginPercentage: APIFY_MARGIN_PERCENTAGE,
                createdAt,
                startedAt,
                reasonForChange,
            },
        ],
    };

    const perRun = Math.round(pricing.startPriceUsd * Math.max(1, Math.ceil(pricing.memoryMbytes / 1024)) * 1e6) / 1e6;
    const notice: NoticeMetadata = {
        engine: pricing.engine,
        policy: 'Apify Store Publishing Terms section 9.4 (verified); the brief cited 2.2.4.2, which is "Specific Prohibitions".',
        noticeDays: NOTICE_DAYS,
        hasPayingUsers,
        submittedAt: createdAt,
        effectiveAt: startedAt,
        changeLimit: 'At most 1 price-increasing change per month per Actor; a pending change cannot be cancelled or edited.',
        startEventPriceUsd: pricing.startPriceUsd,
        startEventPerRunUsd: perRun,
        memoryMbytes: pricing.memoryMbytes,
        reasonForChange,
        provisionalEvents: provisional,
        operatorStatedEvents: operatorStated,
        notes: [
            `The default apify-actor-start price is $${APIFY_DEFAULT_START_PRICE_USD}; ${pricing.startPriceUsd} is ${Math.round(pricing.startPriceUsd / APIFY_DEFAULT_START_PRICE_USD)}x that. Apify only recommends keeping the default; it documents no maximum.`,
            `With ${pricing.memoryMbytes} MB the start event is charged ${Math.max(1, Math.ceil(pricing.memoryMbytes / 1024))} time(s) per run = $${perRun}, even when a run delivers no records.`,
            'apify-default-dataset-item is intentionally absent: with it priced, pushData(item, eventName) bills both events per row.',
            'startedAt must be re-computed from the real submission time before sending; regenerate with --now=<ISO instant>.',
        ],
    };
    return { body, notice };
}
