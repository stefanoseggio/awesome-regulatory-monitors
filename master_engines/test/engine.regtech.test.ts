import { describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { resolveSources } from '../lib/router_core.js';

const base = { sourceOptions: {}, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 } as const;

describe('global-regtech-compliance-feed registry', () => {
    it('has unique ids and every connector belongs to this engine', () => {
        const ids = regtechEngine.connectors.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(regtechEngine.connectors.every((c) => c.engine === 'global-regtech-compliance-feed')).toBe(true);
    });

    it('registers the six requested sources as active', () => {
        const active = regtechEngine.connectors.filter((c) => c.status === 'active').map((c) => c.id).sort();
        expect(active).toEqual(['ai_crawler_signals', 'fda_ema_recalls', 'ofac', 'sec_enforcement', 'uk_modern_slavery', 'world_bank_debarred']);
    });

    it.each(['paris_mou_thetis', 'tokyo_mou_apcis', 'imo_gisis'])('%s is held with a documented reason', (id) => {
        const connector = regtechEngine.connectors.find((c) => c.id === id);
        expect(connector?.status).toBe('held');
        expect(connector?.heldReason?.length).toBeGreaterThan(40);
        expect(() => resolveSources(regtechEngine, { ...base, sources: [id] })).toThrow(/HELD/);
    });

    it('ai_crawler_signals requires its domains; the others preflight with empty options', () => {
        expect(() => resolveSources(regtechEngine, { ...base, sources: ['ai_crawler_signals'] })).toThrow(/ai_crawler_signals.*domains/i);
        for (const id of ['ofac', 'world_bank_debarred', 'uk_modern_slavery', 'sec_enforcement', 'fda_ema_recalls']) {
            expect(() => resolveSources(regtechEngine, { ...base, sources: [id] }), id).not.toThrow();
        }
    });

    it('uk_modern_slavery declares a delta memory larger than one registry year', () => {
        const uk = regtechEngine.connectors.find((c) => c.id === 'uk_modern_slavery');
        expect(uk?.maxSeenIds).toBeGreaterThan(13_048);
    });
});
