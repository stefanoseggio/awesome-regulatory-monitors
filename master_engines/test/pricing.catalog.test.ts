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

    it('flags non-documented prices; --strict accepts them once decided (G1 to G3) and still refuses an undecided one, a moved start price and a moved hit price', () => {
        const { notice } = buildPricingPutBody(REGTECH_PRICING, { now: NOW });
        // the provenance of the numbers is unchanged: a ratification records a decision, it does not turn a guess into a documented price
        expect(notice.operatorStatedEvents).toEqual(['watchlist-hit']);
        expect(notice.provisionalEvents).toEqual(['crawler-signal']);
        expect(notice.ratifiedEvents.map((e) => [e.name, e.gate, e.decidedOn])).toEqual([
            ['crawler-signal', 'G3', '2026-11-02'],
            ['watchlist-hit', 'G2', '2026-11-02'],
        ]);
        expect(notice.startPriceRatification).toMatchObject({ gate: 'G1', decidedOn: '2026-11-02' });
        for (const pricing of ALL_PRICING) expect(() => buildPricingPutBody(pricing, { now: NOW, strict: true }), pricing.engine).not.toThrow();

        // an undecided non-documented price is refused
        const undecided = structuredClone(REGTECH_PRICING);
        delete undecided.events.find((e) => e.name === 'crawler-signal')!.ratification;
        expect(() => buildPricingPutBody(undecided, { now: NOW, strict: true })).toThrow(/without a ratification \(crawler-signal/);
        // the locked start price (G1) and hit price (G2): inside the operator's range or not, strict mode refuses a different number
        const moved = structuredClone(REGTECH_PRICING);
        moved.startPriceUsd = 0.01;
        expect(() => buildPricingPutBody(moved, { now: NOW })).not.toThrow();
        expect(() => buildPricingPutBody(moved, { now: NOW, strict: true })).toThrow(/decision G1 locked it at 0\.005/);
        // a ratified price that moved since the decision is refused too: the decision was about the old number
        const dearerSignal = structuredClone(REGTECH_PRICING);
        dearerSignal.events.find((e) => e.name === 'crawler-signal')!.priceUsd = 0.02;
        const flagged = buildPricingPutBody(dearerSignal, { now: NOW }).notice;
        expect(flagged.ratifiedEvents.find((e) => e.name === 'crawler-signal')).toMatchObject({ decidedPriceUsd: 0.015, priceMatchesDecision: false });
        expect(() => buildPricingPutBody(dearerSignal, { now: NOW, strict: true })).toThrow(/ratified price that moved since the decision \(crawler-signal: decided at 0\.015, priced at 0\.02\)/);
        expect(notice.ratifiedEvents.every((e) => e.priceMatchesDecision)).toBe(true);
        expect(notice.startPriceRatification.priceMatchesDecision).toBe(true);
        expect(buildPricingPutBody(moved, { now: NOW }).notice.startPriceRatification.priceMatchesDecision).toBe(false);
        const cheaperHit = structuredClone(REGTECH_PRICING);
        const hit = cheaperHit.events.find((e) => e.name === 'watchlist-hit')!;
        hit.priceUsd = 0.1;
        // first the price moved away from the decision it carries ...
        expect(() => buildPricingPutBody(cheaperHit, { now: NOW, strict: true })).toThrow(/ratified price that moved since the decision \(watchlist-hit: decided at 0\.15, priced at 0\.1\)/);
        // ... and a fresh decision at the new price is still not the locked one (G2 is changed in the catalogue constant, not by editing an event)
        hit.ratification!.priceUsd = 0.1;
        expect(() => buildPricingPutBody(cheaperHit, { now: NOW, strict: true })).toThrow(/decision G2 locked it at 0\.15/);
    });

    it('every non-documented price carries a complete decision: who, when, why and what reopens it', () => {
        const undocumented = ALL_PRICING.flatMap((p) => p.events.filter((e) => e.basis !== 'legacy-readme').map((e) => ({ engine: p.engine, event: e })));
        expect(undocumented.map(({ event }) => event.name).sort()).toEqual(['crawler-signal', 'grant-updated', 'sg-entity-updated', 'uae-entity-updated', 'watchlist-hit', 'watchlist-hit', 'watchlist-hit']);
        for (const { engine, event } of undocumented) {
            const r = event.ratification;
            expect(r, `${engine}/${event.name} has no ratification`).toBeDefined();
            expect(r?.decidedOn).toBe('2026-11-02');
            expect(r?.priceUsd, `${engine}/${event.name} was decided at another price than it carries`).toBe(event.priceUsd);
            expect(r?.decidedBy).toContain('mandate of 2026-11-02');
            expect((r?.rationale ?? '').length, `${engine}/${event.name} rationale`).toBeGreaterThan(120);
            expect((r?.reviewWhen ?? '').length, `${engine}/${event.name} reviewWhen`).toBeGreaterThan(60);
            expect(r?.gate).toBe(event.name === 'watchlist-hit' ? 'G2' : 'G3');
        }
        // a documented price needs no ratification, and none was added to one
        for (const p of ALL_PRICING) for (const e of p.events.filter((x) => x.basis === 'legacy-readme')) expect(e.ratification, `${p.engine}/${e.name}`).toBeUndefined();
    });

    it('the start price is the G1 lock in every engine and the hit price the G2 lock in every engine', () => {
        for (const p of ALL_PRICING) {
            expect(p.startPriceUsd, p.engine).toBe(0.005);
            expect(p.events.find((e) => e.name === 'watchlist-hit')?.priceUsd, p.engine).toBe(0.15);
        }
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
