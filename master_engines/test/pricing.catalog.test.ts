import { describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import type { EngineDefinition } from '../lib/router_core.js';
import { applyCatalogBilling } from '../pricing/apply_billing.js';
import {
    addDays,
    APIFY_MARGIN_PERCENTAGE,
    buildPricingPutBody,
    DEFAULT_DATASET_ITEM_EVENT,
    NOTICE_DAYS,
    START_EVENT_NAME,
    validatePricing,
} from '../pricing/build_put_payloads.js';
import { ALL_PRICING, type EnginePricing, PATENTS_PRICING, REGTECH_PRICING, START_PRICE_MAX_USD, START_PRICE_MIN_USD, TENDERS_PRICING } from '../pricing/event_catalog.js';

const NOW = '2026-10-21T00:00:00.000Z';
const ENGINES: Array<[string, EngineDefinition, EnginePricing]> = [
    ['regtech', regtechEngine, REGTECH_PRICING],
    ['tenders', tendersEngine, TENDERS_PRICING],
    ['patents', patentsEngine, PATENTS_PRICING],
];

describe.each(ENGINES)('%s pricing catalog', (_label, engine, pricing) => {
    it('validates cleanly', () => {
        expect(validatePricing(pricing)).toEqual([]);
    });

    it('prices the start event inside the requested $0.002-$0.01 range', () => {
        expect(pricing.startPriceUsd).toBeGreaterThanOrEqual(START_PRICE_MIN_USD);
        expect(pricing.startPriceUsd).toBeLessThanOrEqual(START_PRICE_MAX_USD);
    });

    it('every active connector bills only events that are priced', () => {
        const priced = new Set(pricing.events.map((e) => e.name));
        for (const c of engine.connectors.filter((x) => x.status === 'active')) {
            expect(c.billing?.newEvent, c.id).toBeDefined();
            for (const e of [c.billing?.newEvent, c.billing?.updatedEvent, c.billing?.snapshotEvent]) {
                if (e !== undefined) expect(priced.has(e), `${c.id} -> ${e}`).toBe(true);
            }
        }
    });

    it('held connectors carry no billing', () => {
        for (const c of engine.connectors.filter((x) => x.status === 'held')) expect(c.billing, c.id).toBeUndefined();
    });

    it('never prices apify-default-dataset-item and keeps exactly one primary event', () => {
        expect(pricing.events.map((e) => e.name)).not.toContain(DEFAULT_DATASET_ITEM_EVENT);
        expect(pricing.events.filter((e) => e.primary)).toHaveLength(1);
    });

    it('prices watchlist-hit', () => {
        expect(pricing.events.find((e) => e.name === 'watchlist-hit')?.priceUsd).toBeGreaterThan(0);
    });
});

describe('validatePricing catches the mistakes that would bill wrongly', () => {
    const clone = (): EnginePricing => structuredClone(REGTECH_PRICING);

    it('rejects a start price outside the requested range', () => {
        const p = clone();
        p.startPriceUsd = 0.00005;
        expect(validatePricing(p).join('\n')).toMatch(/outside the requested/);
        p.startPriceUsd = 0.5;
        expect(validatePricing(p).join('\n')).toMatch(/outside the requested/);
    });

    it('rejects pricing apify-default-dataset-item (double billing)', () => {
        const p = clone();
        p.events.push({ name: DEFAULT_DATASET_ITEM_EVENT, title: 't', description: 'd', priceUsd: 0.001, basis: 'legacy-readme', evidence: 'x' });
        expect(validatePricing(p).join('\n')).toMatch(/bills both events/);
    });

    it('rejects a connector billing an event that is not in the catalog (it would be free)', () => {
        const p = clone();
        p.sourceBilling.ofac = { newEvent: 'vesel-record' };
        expect(validatePricing(p).join('\n')).toMatch(/"vesel-record", which is not in the catalog/);
    });

    it('rejects an orphan priced event, missing watchlist-hit, zero/negative/NaN prices and bad names', () => {
        const p = clone();
        p.events = p.events.filter((e) => e.name !== 'watchlist-hit');
        p.events.push({ name: 'orphan', title: 't', description: 'd', priceUsd: 0.1, basis: 'legacy-readme', evidence: 'x' });
        p.events.push({ name: 'Bad_Name', title: 't', description: 'd', priceUsd: 0, basis: 'legacy-readme', evidence: 'x' });
        p.events.push({ name: 'nan-price', title: 't', description: 'd', priceUsd: Number.NaN, basis: 'legacy-readme', evidence: 'x' });
        const text = validatePricing(p).join('\n');
        expect(text).toMatch(/"orphan" is priced but no source bills it/);
        expect(text).toMatch(/watchlist-hit event must be priced/);
        expect(text).toMatch(/Bad_Name.*kebab-case/);
        expect(text).toMatch(/Bad_Name.*priceUsd 0/);
        expect(text).toMatch(/nan-price.*priceUsd NaN/);
    });

    it('rejects zero or two primary events and a catalog-defined start event', () => {
        const none = clone();
        for (const e of none.events) delete e.primary;
        expect(validatePricing(none).join('\n')).toMatch(/exactly one primary event is required, found 0/);
        const two = clone();
        for (const e of two.events) e.primary = true;
        expect(validatePricing(two).join('\n')).toContain(`found ${two.events.length}`);
        const start = clone();
        start.events.push({ name: START_EVENT_NAME, title: 't', description: 'd', priceUsd: 0.005, basis: 'legacy-readme', evidence: 'x' });
        expect(validatePricing(start).join('\n')).toMatch(/set via startPriceUsd/);
    });
});

describe('applyCatalogBilling', () => {
    it('refuses an active connector with no catalog entry', () => {
        const stray = { ...regtechEngine.connectors.find((c) => c.id === 'ofac')!, id: 'brand_new_source', billing: undefined };
        expect(() => applyCatalogBilling({ slug: 'global-regtech-compliance-feed', connectors: [stray] }, REGTECH_PRICING)).toThrow(/no entry in the global-regtech-compliance-feed pricing catalog/);
    });

    it('refuses pricing for the wrong engine', () => {
        expect(() => applyCatalogBilling(regtechEngine, TENDERS_PRICING)).toThrow(/applied to/);
    });
});

describe('buildPricingPutBody', () => {
    it.each(ALL_PRICING.map((p) => [p.engine, p] as const))('%s: shape matches the verified PUT body', (_engine, pricing) => {
        const { body, notice } = buildPricingPutBody(pricing, { now: NOW });
        const info = body.pricingInfos[0]!;
        expect(body.pricingInfos).toHaveLength(1);
        expect(info.pricingModel).toBe('PAY_PER_EVENT');
        expect(info.apifyMarginPercentage).toBe(APIFY_MARGIN_PERCENTAGE);
        const events = info.pricingPerEvent.actorChargeEvents;
        expect(events[START_EVENT_NAME]).toMatchObject({ eventPriceUsd: pricing.startPriceUsd, isOneTimeEvent: true });
        expect(events[DEFAULT_DATASET_ITEM_EVENT]).toBeUndefined();
        expect(Object.values(events).filter((e) => e.isPrimaryEvent)).toHaveLength(1);
        for (const [name, e] of Object.entries(events)) {
            expect(e.eventTitle.length, name).toBeGreaterThan(0);
            expect(e.eventDescription.length, name).toBeGreaterThan(0);
            expect(e.eventPriceUsd, name).toBeGreaterThan(0);
        }
        expect(Object.keys(events)).toHaveLength(pricing.events.length + 1);
        expect(notice.noticeDays).toBe(NOTICE_DAYS);
    });

    it('schedules the change 14 days out when the Actor has paying users (default)', () => {
        const { body, notice } = buildPricingPutBody(REGTECH_PRICING, { now: NOW });
        expect(body.pricingInfos[0]?.createdAt).toBe('2026-10-21T00:00:00.000Z');
        expect(body.pricingInfos[0]?.startedAt).toBe('2026-11-04T00:00:00.000Z');
        expect(notice.effectiveAt).toBe('2026-11-04T00:00:00.000Z');
        expect(notice.hasPayingUsers).toBe(true);
    });

    it('takes effect immediately when the Actor has no paying users', () => {
        const { body } = buildPricingPutBody(REGTECH_PRICING, { now: NOW, hasPayingUsers: false });
        expect(body.pricingInfos[0]?.startedAt).toBe(body.pricingInfos[0]?.createdAt);
    });

    it('reports the real per-run start cost (price x GB), even for an empty run', () => {
        expect(buildPricingPutBody(REGTECH_PRICING, { now: NOW }).notice.startEventPerRunUsd).toBe(0.01);
        expect(buildPricingPutBody(TENDERS_PRICING, { now: NOW }).notice.startEventPerRunUsd).toBe(0.005);
    });

    it('flags non-documented prices and --strict refuses them', () => {
        const { notice } = buildPricingPutBody(REGTECH_PRICING, { now: NOW });
        expect(notice.operatorStatedEvents).toEqual(['watchlist-hit']);
        expect(notice.provisionalEvents).toEqual(['crawler-signal']);
        expect(() => buildPricingPutBody(REGTECH_PRICING, { now: NOW, strict: true })).toThrow(/--strict/);
    });

    it('refuses to build from an invalid catalog and from a bad timestamp', () => {
        const bad = structuredClone(REGTECH_PRICING);
        bad.startPriceUsd = 1;
        expect(() => buildPricingPutBody(bad, { now: NOW })).toThrow(/Invalid pricing/);
        expect(() => addDays('not a date', 14)).toThrow(/Invalid ISO/);
    });

    it('does not mutate the catalog', () => {
        const before = JSON.stringify(REGTECH_PRICING);
        buildPricingPutBody(REGTECH_PRICING, { now: NOW });
        expect(JSON.stringify(REGTECH_PRICING)).toBe(before);
    });

    it('keeps every legacy-documented price exactly as quoted', () => {
        const price = (p: EnginePricing, name: string) => p.events.find((e) => e.name === name)?.priceUsd;
        expect(price(REGTECH_PRICING, 'vessel-record')).toBe(0.0005);
        expect(price(REGTECH_PRICING, 'enforcement-release')).toBe(0.05);
        expect(price(REGTECH_PRICING, 'statement-new')).toBe(0.02);
        expect(price(TENDERS_PRICING, 'tender-detail')).toBe(0.003);
        expect(price(TENDERS_PRICING, 'tender-summary')).toBe(0.001);
        expect(price(PATENTS_PRICING, 'patent-proceeding')).toBe(0.002);
        expect(price(PATENTS_PRICING, 'sg-entity-new')).toBe(0.03);
    });
});

describe('committed payload files', () => {
    it.each(ALL_PRICING.map((p) => [p.engine, p] as const))('%s: pricing/payloads is in sync with the catalog', async (engine, pricing) => {
        const { readFile } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const dir = fileURLToPath(new URL('../pricing/payloads/', import.meta.url));
        const expected = buildPricingPutBody(pricing, { now: NOW });
        expect(JSON.parse(await readFile(`${dir}${engine}.put.json`, 'utf8'))).toEqual(expected.body);
        expect(JSON.parse(await readFile(`${dir}${engine}.notice.json`, 'utf8'))).toEqual(expected.notice);
    });
});

describe('minimalMaxTotalChargeFor (B2)', () => {
    it.each(ALL_PRICING.map((p) => [p.engine, p] as const))('%s: the smallest allowed run budget affords the start events plus the dearest event', (_engine, pricing) => {
        const { body } = buildPricingPutBody(pricing, { now: NOW });
        const floor = body.pricingInfos[0]!.minimalMaxTotalChargeUsd;
        const startEvents = Math.max(1, Math.ceil(pricing.memoryMbytes / 1024));
        const dearest = Math.max(...pricing.events.map((e) => e.priceUsd));
        expect(floor).toBeGreaterThanOrEqual(pricing.startPriceUsd * startEvents + dearest);
        expect(floor).toBeGreaterThanOrEqual(0.1);
        expect(floor).toBeLessThan(pricing.startPriceUsd * startEvents + dearest + 0.011);
    });
});
