/**
 * Single source of truth for Pay-Per-Event pricing of the three Master Engines.
 *
 * It feeds two consumers and nothing else is allowed to define a price:
 *   1. `applyCatalogBilling` stamps each connector with the event(s) it bills (router_core reads them);
 *   2. `build_put_payloads.ts` renders the `pricingInfos` body of `PUT /v2/actors/{actorId}`.
 *
 * WHY PER-SOURCE EVENTS: the legacy single-source actors were priced very differently ($0.0005 per OFAC vessel,
 * $0.05 per SEC release, $0.003 per tender). One blended `result` price on a consolidated engine would either
 * over-bill the cheap sources ~100x or under-bill the expensive ones, so each legacy price is kept as its own event.
 *
 * `basis` says how trustworthy a price is:
 *   - 'legacy-readme'   quoted from the legacy actor's README/AGENTS.md (evidence gives file:line);
 *   - 'provisional'     no price is documented for that exact event; derived from the nearest documented sibling;
 *   - 'operator-stated' a figure given in the engagement brief that no legacy document corroborates.
 * `--strict` in the generator refuses to emit while any event is not 'legacy-readme'.
 *
 * Evidence paths are relative to the legacy corpus (`<repo>/README.md:<line>`), checked 2026-10-21.
 */
import type { ConnectorBilling, EngineSlug } from '../lib/types.js';

export type PriceBasis = 'legacy-readme' | 'provisional' | 'operator-stated';

export interface PricedEvent {
    /** Event name exactly as used by the router and in `actorChargeEvents`. kebab-case. */
    name: string;
    title: string;
    description: string;
    priceUsd: number;
    basis: PriceBasis;
    evidence: string;
    /** Exactly one per engine: the event shown as the Store's headline price. A commercial choice, not a technical one. */
    primary?: boolean;
}

export interface EnginePricing {
    engine: EngineSlug;
    /** Memory the Actor must be configured with. `apify-actor-start` is charged once per GB (minimum one). */
    memoryMbytes: number;
    /** Price of `apify-actor-start`. Apify's default is $0.00005; the operator asked for $0.002-$0.01. */
    startPriceUsd: number;
    events: PricedEvent[];
    /** connector id -> events it bills. Held connectors are omitted. */
    sourceBilling: Record<string, ConnectorBilling>;
}

/** Operator-requested bounds for the start event. Apify itself documents no bound (it only recommends the default). */
export const START_PRICE_MIN_USD = 0.002;
export const START_PRICE_MAX_USD = 0.01;
/** Apify's documented default for `apify-actor-start`. */
export const APIFY_DEFAULT_START_PRICE_USD = 0.00005;

const WATCHLIST_HIT = (engineNoun: string): PricedEvent => ({
    name: 'watchlist-hit',
    title: 'Watchlist hit',
    description: `Charged once for each delivered ${engineNoun} record whose text matches a keyword of the caller's own watchlist. Never charged when no valid keyword was supplied.`,
    priceUsd: 0.15,
    basis: 'operator-stated',
    evidence: 'Engagement brief: "$0.15 ghost billing per record". No legacy README defines a `watchlist-hit` event; the legacy SEC actor billed `result` at $0.05 (sec-enforcement-litigation-delta-feed/README.md:38).',
});

export const REGTECH_PRICING: EnginePricing = {
    engine: 'global-regtech-compliance-feed',
    memoryMbytes: 2048, // OFAC loads a 29 MB SDN.XML into a DOM (~660 MB RSS measured); legacy actor ran at 1-4 GB.
    startPriceUsd: 0.005,
    events: [
        { name: 'vessel-record', title: 'Sanctioned vessel record', description: 'One OFAC SDN sanctioned-vessel record delivered to the dataset.', priceUsd: 0.0005, basis: 'legacy-readme', evidence: 'actor-19-maritime-sanctions-monitor/README.md:56', primary: true },
        { name: 'debarment-record', title: 'Debarment / sanction record', description: 'One World Bank "Other Sanctions" record delivered to the dataset.', priceUsd: 0.003, basis: 'legacy-readme', evidence: 'actor-20-mdb-procurement-monitor/AGENTS.md:53 (debarredFirms $0.003/record)' },
        { name: 'statement-new', title: 'New modern slavery statement', description: 'A UK Modern Slavery Statement Registry statement never delivered before.', priceUsd: 0.02, basis: 'legacy-readme', evidence: 'uk-modern-slavery-statement-registry-monitor/README.md:149' },
        { name: 'statement-updated', title: 'Updated modern slavery statement', description: 'A previously delivered UK statement whose content changed.', priceUsd: 0.01, basis: 'legacy-readme', evidence: 'uk-modern-slavery-statement-registry-monitor/README.md:150' },
        { name: 'enforcement-release', title: 'New SEC enforcement release', description: 'A SEC litigation release or administrative proceeding not delivered before.', priceUsd: 0.05, basis: 'legacy-readme', evidence: 'sec-enforcement-litigation-delta-feed/README.md:38' },
        { name: 'enforcement-update', title: 'Updated SEC enforcement release', description: 'A previously delivered SEC release whose content changed.', priceUsd: 0.02, basis: 'legacy-readme', evidence: 'sec-enforcement-litigation-delta-feed/README.md:39' },
        { name: 'crawler-signal', title: 'AI crawler permission snapshot', description: 'A domain\'s AI-crawler permission and Content-Signal state delivered for the first time.', priceUsd: 0.015, basis: 'provisional', evidence: 'ai-crawler-content-signal-permission-monitor/README.md:38-39 prices a permission FLIP at $0.015; this engine also delivers the first snapshot of a domain, which the legacy actor did not bill.' },
        { name: 'crawler-signal-change', title: 'AI crawler signal change', description: 'A previously delivered domain whose crawler permissions, Content-Signal or llms.txt changed.', priceUsd: 0.006, basis: 'legacy-readme', evidence: 'ai-crawler-content-signal-permission-monitor/README.md:40,72 (result-summary $0.006)' },
        { name: 'recall-record', title: 'Drug safety record', description: 'One FDA enforcement or EMA safety record delivered to the dataset.', priceUsd: 0.001, basis: 'legacy-readme', evidence: 'actor-22-drug-safety-recalls-monitor/README.md:31 ($0.001 x 200 results)' },
        WATCHLIST_HIT('regulatory'),
    ],
    sourceBilling: {
        ofac: { newEvent: 'vessel-record' },
        world_bank_debarred: { newEvent: 'debarment-record' },
        uk_modern_slavery: { newEvent: 'statement-new', updatedEvent: 'statement-updated' },
        sec_enforcement: { newEvent: 'enforcement-release', updatedEvent: 'enforcement-update' },
        ai_crawler_signals: { newEvent: 'crawler-signal', updatedEvent: 'crawler-signal-change' },
        fda_ema_recalls: { newEvent: 'recall-record' },
    },
};

export const TENDERS_PRICING: EnginePricing = {
    engine: 'latam-global-tender-intelligence',
    memoryMbytes: 1024,
    startPriceUsd: 0.005,
    events: [
        { name: 'tender-detail', title: 'Tender record', description: 'One tender delivered with its full detail (buyer, budget, dates, documents).', priceUsd: 0.003, basis: 'legacy-readme', evidence: 'santafe-compras-monitor/README.md:70; florida-tenders-monitor/README.md:30; tucuman-compras-monitor/README.md:32; entrerios-compras-monitor/README.md:8; diario-oficial-cl-monitor/README.md:9. Cordoba documents only "from $0.001" (cordoba-compras-monitor/README.md:8): $0.003 is the sibling rate and is PROVISIONAL for ar_cordoba.', primary: true },
        { name: 'tender-summary', title: 'Tender summary record', description: 'One tender delivered from the listing only (no detail page fetched).', priceUsd: 0.001, basis: 'legacy-readme', evidence: 'santafe-compras-monitor/README.md:71; florida-tenders-monitor/README.md:31' },
        { name: 'notice-record', title: 'Procurement notice', description: 'One World Bank procurement notice delivered to the dataset.', priceUsd: 0.001, basis: 'legacy-readme', evidence: 'actor-20-mdb-procurement-monitor/README.md:63' },
        { name: 'notice-new', title: 'New EU TED notice', description: 'A TED procurement notice never delivered before.', priceUsd: 0.02, basis: 'legacy-readme', evidence: 'eu-ted-procurement-delta-monitor/README.md:187' },
        { name: 'notice-updated', title: 'Updated EU TED notice', description: 'A previously delivered TED notice whose content changed.', priceUsd: 0.01, basis: 'legacy-readme', evidence: 'eu-ted-procurement-delta-monitor/README.md:188' },
        { name: 'grant-new', title: 'New Lombardia grant call', description: 'A Regione Lombardia grant call (bando) never delivered before.', priceUsd: 0.02, basis: 'legacy-readme', evidence: 'regione-lombardia-grants-registry-monitor/README.md:67' },
        { name: 'grant-updated', title: 'Updated Lombardia grant call', description: 'A previously delivered grant call whose status or fields changed.', priceUsd: 0.008, basis: 'provisional', evidence: 'regione-lombardia-grants-registry-monitor/README.md:68-69 prices a status change at $0.02 and any other update at $0.008; the router cannot tell them apart, so the lower rate is used to avoid over-billing.' },
        WATCHLIST_HIT('tender'),
    ],
    sourceBilling: {
        ar_santafe: { newEvent: 'tender-detail' },
        ar_tucuman: { newEvent: 'tender-detail' },
        ar_entrerios: { newEvent: 'tender-detail' },
        ar_cordoba: { newEvent: 'tender-detail' },
        cl_diario_oficial: { newEvent: 'tender-detail' },
        us_florida: { newEvent: 'tender-detail' },
        world_bank_notices: { newEvent: 'notice-record' },
        eu_ted: { newEvent: 'notice-new', updatedEvent: 'notice-updated' },
        it_lombardia_grants: { newEvent: 'grant-new', updatedEvent: 'grant-updated' },
    },
};

export const PATENTS_PRICING: EnginePricing = {
    engine: 'global-corporate-patent-intelligence',
    memoryMbytes: 1024,
    startPriceUsd: 0.005,
    events: [
        { name: 'patent-proceeding', title: 'Patent enforcement proceeding', description: 'One USPTO PTAB trial or EPO opposition-related legal event delivered to the dataset.', priceUsd: 0.002, basis: 'legacy-readme', evidence: 'actor-21-patent-ip-enforcement-monitor/README.md:30', primary: true },
        { name: 'clinical-record', title: 'Clinical trial / Orange Book record', description: 'One new or changed ClinicalTrials.gov study or FDA Orange Book record delivered.', priceUsd: 0.002, basis: 'legacy-readme', evidence: 'actor-24-clinical-trials-delta-engine/README.md:59' },
        { name: 'uae-entity-new', title: 'New UAE register entity', description: 'An ADGM or DIFC registration never delivered before.', priceUsd: 0.02, basis: 'legacy-readme', evidence: 'uae-corporate-registry-monitor/README.md:173' },
        { name: 'uae-entity-updated', title: 'Updated UAE register entity', description: 'A previously delivered ADGM/DIFC entity whose status or content changed.', priceUsd: 0.01, basis: 'provisional', evidence: 'uae-corporate-registry-monitor/README.md:174-175 prices a status change at $0.02 and a content change at $0.01; the router cannot tell them apart, so the lower rate is used to avoid over-billing.' },
        { name: 'sg-entity-new', title: 'New Singapore ACRA entity', description: 'An ACRA-registered entity never delivered before.', priceUsd: 0.03, basis: 'legacy-readme', evidence: 'singapore-acra-registry-monitor/README.md:83' },
        { name: 'sg-entity-updated', title: 'Updated Singapore ACRA entity', description: 'A previously delivered ACRA entity whose status or content changed.', priceUsd: 0.01, basis: 'provisional', evidence: 'singapore-acra-registry-monitor/README.md:84-85 prices a status change at $0.03 and a content change at $0.01; the router cannot tell them apart, so the lower rate is used to avoid over-billing.' },
        WATCHLIST_HIT('corporate or patent'),
    ],
    sourceBilling: {
        uspto_ptab: { newEvent: 'patent-proceeding' },
        epo_opposition: { newEvent: 'patent-proceeding' },
        clinicaltrials_orange_book: { newEvent: 'clinical-record' },
        ae_registers: { newEvent: 'uae-entity-new', updatedEvent: 'uae-entity-updated' },
        sg_acra: { newEvent: 'sg-entity-new', updatedEvent: 'sg-entity-updated' },
    },
};

export const ALL_PRICING: readonly EnginePricing[] = [REGTECH_PRICING, TENDERS_PRICING, PATENTS_PRICING];

/** Record-level overrides some connectors set via `SourceRecord.billingEvent`; they must exist in the catalog too. */
export const RECORD_LEVEL_EVENTS: Readonly<Record<EngineSlug, readonly string[]>> = {
    'global-regtech-compliance-feed': [],
    'latam-global-tender-intelligence': ['tender-summary'],
    'global-corporate-patent-intelligence': [],
};
