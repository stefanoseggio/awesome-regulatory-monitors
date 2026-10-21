import { describe, expect, it } from 'vitest';

import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { resolveSources } from '../lib/router_core.js';

const base = { sourceOptions: {}, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 } as const;

describe('latam-global-tender-intelligence registry', () => {
    it('has unique ids and every connector belongs to this engine', () => {
        const ids = tendersEngine.connectors.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(tendersEngine.connectors.every((c) => c.engine === 'latam-global-tender-intelligence')).toBe(true);
    });

    it.each(['ar_salta', 'ar_mendoza', 'ar_pba'])('%s is held and can never be selected', (id) => {
        const connector = tendersEngine.connectors.find((c) => c.id === id);
        expect(connector?.status).toBe('held');
        expect(() => resolveSources(tendersEngine, { ...base, sources: [id], sourceOptions: { [id]: { proxyUrl: 'http://x' } } })).toThrow(/HELD/);
    });

    it('every active connector preflights with empty options', () => {
        const active = tendersEngine.connectors.filter((c) => c.status === 'active').map((c) => c.id);
        expect(active.length).toBeGreaterThanOrEqual(8);
        for (const id of active) {
            const connector = tendersEngine.connectors.find((c) => c.id === id);
            if (connector?.requiredOptions?.length) continue;
            expect(() => resolveSources(tendersEngine, { ...base, sources: [id] }), id).not.toThrow();
        }
    });

    it('mixing an active and a held source rejects the whole run before any fetch', () => {
        expect(() => resolveSources(tendersEngine, { ...base, sources: ['eu_ted', 'ar_salta'] })).toThrow(/ar_salta/);
    });
});
