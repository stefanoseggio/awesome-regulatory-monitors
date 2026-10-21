import { describe, expect, it } from 'vitest';

import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { resolveSources } from '../lib/router_core.js';

const base = { sourceOptions: {}, deltaMode: 'onlyChanged', maxItemsPerSource: 5, maxWatchlistHitsPerRun: 1, maxWatchlistSpendUsd: 1 } as const;

describe('global-corporate-patent-intelligence registry', () => {
    it('has the five requested sources, unique ids, this engine only', () => {
        const ids = patentsEngine.connectors.map((c) => c.id).sort();
        expect(ids).toEqual(['ae_registers', 'clinicaltrials_orange_book', 'epo_opposition', 'sg_acra', 'uspto_ptab']);
        expect(patentsEngine.connectors.every((c) => c.engine === 'global-corporate-patent-intelligence')).toBe(true);
    });

    it('BYOK sources refuse to run without their credentials, before any request', () => {
        expect(() => resolveSources(patentsEngine, { ...base, sources: ['uspto_ptab'] })).toThrow(/usptoOdpApiKey/);
        // EPO's schema asks for the watchlist first; once it is present the missing credentials are what blocks the run.
        expect(() => resolveSources(patentsEngine, { ...base, sources: ['epo_opposition'] })).toThrow(/epo_opposition.*epWatchlist/);
        expect(() => resolveSources(patentsEngine, { ...base, sources: ['epo_opposition'], sourceOptions: { epo_opposition: { epWatchlist: ['EP1234567'] } } })).toThrow(/epoOpsConsumerKey/);
    });

    it('credential-free sources preflight with empty options', () => {
        for (const id of ['clinicaltrials_orange_book', 'sg_acra', 'ae_registers']) {
            expect(() => resolveSources(patentsEngine, { ...base, sources: [id] }), id).not.toThrow();
        }
    });
});
