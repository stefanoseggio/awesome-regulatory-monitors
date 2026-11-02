/**
 * What the Store shows about the three engines must say what the code does (Store Publishing Terms 2.2.2 and 2.2.4.3:
 * an up-to-date description, nothing misleading). Findings F-18 and F-19 of the pre-publication review of 2026-11-02.
 */
import { describe, expect, it } from 'vitest';

import { ALL_PRICING } from '../pricing/event_catalog.js';
import { ENGINE_META } from '../scripts/actor_files.js';

describe('F-18: the listing does not claim the World Bank debarment register', () => {
    it('no Actor title and no event title or description says "debar" (the connector reads only the "Other Sanctions" table)', () => {
        for (const [slug, meta] of Object.entries(ENGINE_META)) expect(meta.title, slug).not.toMatch(/debar/i);
        for (const pricing of ALL_PRICING) {
            for (const event of pricing.events) expect(`${event.title} ${event.description}`, `${pricing.engine}/${event.name}`).not.toMatch(/debar/i);
        }
    });

    it('the World Bank event is titled for what the connector reads', () => {
        const regtech = ALL_PRICING.find((p) => p.engine === 'global-regtech-compliance-feed');
        const event = regtech?.events.find((e) => e.name === 'debarment-record');
        expect(event?.title).toBe('World Bank sanction record');
        expect(event?.description).toContain('Other Sanctions');
    });
});
