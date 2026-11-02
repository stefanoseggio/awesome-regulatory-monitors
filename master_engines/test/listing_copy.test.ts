/**
 * What the Store shows about the three engines must say what the code does (Store Publishing Terms 2.2.2 and 2.2.4.3:
 * an up-to-date description, nothing misleading) and fit the limits of the listing form. Findings F-18 and F-19 of the
 * pre-publication review of 2026-11-02.
 *
 * `store_listings/listing_fields.json` holds the Store fields (title, SEO title, description, SEO description, categories).
 * `scripts/actor_files.ts` generates `actor.json` from the same title and description, so a later `apify push` cannot put the
 * longer generated text back; this file fails if the two drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALL_PRICING } from '../pricing/event_catalog.js';
import { ENGINE_META } from '../scripts/actor_files.js';

interface ListingFields {
    title: string;
    seoTitle: string;
    description: string;
    seoDescription: string;
    categories: string[];
}

const FIELDS = JSON.parse(readFileSync(fileURLToPath(new URL('../store_listings/listing_fields.json', import.meta.url)), 'utf8')) as Record<string, ListingFields>;
const SLUGS = ['global-regtech-compliance-feed', 'latam-global-tender-intelligence', 'global-corporate-patent-intelligence'];

/** The fleet's conventions (every live title is at most 58 characters, every description at most 300); the Publication form is the authority. */
const LIMITS = { title: 60, seoTitle: 60, description: 300, seoDescription: 160 } as const;

describe('F-18: the listing does not claim the World Bank debarment register', () => {
    it('no Actor title and no event title or description says "debar" (the connector reads only the "Other Sanctions" table)', () => {
        for (const [slug, meta] of Object.entries(ENGINE_META)) expect(meta.title, slug).not.toMatch(/debar/i);
        for (const pricing of ALL_PRICING) {
            for (const event of pricing.events) expect(`${event.title} ${event.description}`, `${pricing.engine}/${event.name}`).not.toMatch(/debar/i);
        }
        for (const slug of SLUGS) expect(Object.values(FIELDS[slug] ?? {}).flat().join(' '), slug).not.toMatch(/debar/i);
    });

    it('the World Bank event is titled for what the connector reads', () => {
        const regtech = ALL_PRICING.find((p) => p.engine === 'global-regtech-compliance-feed');
        const event = regtech?.events.find((e) => e.name === 'debarment-record');
        expect(event?.title).toBe('World Bank sanction record');
        expect(event?.description).toContain('Other Sanctions');
    });
});

describe('F-19: the listing fields fit the form and match the generated actor.json', () => {
    it('lists exactly the three engines', () => {
        expect(Object.keys(FIELDS).sort()).toEqual([...SLUGS].sort());
        expect(Object.keys(ENGINE_META).sort()).toEqual([...SLUGS].sort());
    });

    it.each(SLUGS)('%s: every field is within its length limit', (slug) => {
        const fields = FIELDS[slug];
        expect(fields).toBeDefined();
        for (const [name, max] of Object.entries(LIMITS)) {
            const length = [...(fields as unknown as Record<string, string>)[name]!].length;
            expect(length, `${slug}.${name} is ${length} characters, the limit is ${max}`).toBeLessThanOrEqual(max);
            expect(length, `${slug}.${name} is empty`).toBeGreaterThan(10);
        }
        expect(fields?.categories).toEqual(['BUSINESS']);
    });

    it.each(SLUGS)('%s: the generated actor.json carries the listing title and description', (slug) => {
        expect(ENGINE_META[slug]?.title).toBe(FIELDS[slug]?.title);
        expect(ENGINE_META[slug]?.description).toBe(FIELDS[slug]?.description);
    });

    it.each(SLUGS)('%s: no price figure, real-time claim, link or contact in the Store fields', (slug) => {
        const text = [FIELDS[slug]?.title, FIELDS[slug]?.seoTitle, FIELDS[slug]?.description, FIELDS[slug]?.seoDescription].join('\n');
        expect(text).not.toMatch(/[$€£]\s?\d|\bUSD\s?\d|\d\s?(?:USD|dollars?|cents?)\b/i);
        expect(text).not.toMatch(/real[- ]?time/i);
        expect(text).not.toMatch(/https?:|www\.|@\w|linkedin|github|pypi/i);
    });
});
