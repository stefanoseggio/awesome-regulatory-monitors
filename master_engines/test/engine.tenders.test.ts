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

    it.each(['ar_salta', 'ar_mendoza', 'ar_pba', 'ar_cordoba'])('%s is held and can never be selected', (id) => {
        const connector = tendersEngine.connectors.find((c) => c.id === id);
        expect(connector?.status).toBe('held');
        expect(() => resolveSources(tendersEngine, { ...base, sources: [id], sourceOptions: { [id]: { proxyUrl: 'http://x' } } })).toThrow(/HELD/);
    });

    it('every active connector preflights with empty options', () => {
        const active = tendersEngine.connectors.filter((c) => c.status === 'active').map((c) => c.id);
        expect(active.length).toBe(8);
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

describe('ar_cordoba is formally held', () => {
    const cordoba = tendersEngine.connectors.find((c) => c.id === 'ar_cordoba');

    it('is registered as held with the legacy-documented reason, and carries no billing', () => {
        expect(cordoba?.status).toBe('held');
        expect(cordoba?.legacyActor).toBe('cordoba-compras-monitor');
        expect(cordoba?.heldReason).toMatch(/non-residential, non-Argentine traffic/);
        expect(cordoba?.heldReason).toMatch(/AGENTS\.md lines 86-88/);
        expect(cordoba?.billing).toBeUndefined();
    });

    it('is refused in preflight even when options (including a proxy and a CA bundle) are supplied', () => {
        const options = { proxyUrl: 'http://proxy.example:8080', extraCaPem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----' };
        expect(() => resolveSources(tendersEngine, { ...base, sources: ['ar_cordoba'], sourceOptions: { ar_cordoba: options } })).toThrow(/HELD.*network level/);
        expect(() => resolveSources(tendersEngine, { ...base, sources: ['eu_ted', 'ar_cordoba'] })).toThrow(/ar_cordoba/);
    });

    it('its fetch throws before any network call, even if called directly', async () => {
        const ctx = {
            http: {
                async getText(): Promise<string> {
                    throw new Error('network must not be used');
                },
                async getJson(): Promise<never> {
                    throw new Error('network must not be used');
                },
            },
            log: { info() {}, warning() {}, error() {}, debug() {} },
            now: () => new Date('2026-10-21T00:00:00Z'),
        };
        await expect(cordoba!.fetch(ctx, {}, { maxItemsPerSource: 5 })).rejects.toThrow(/held/);
    });

    it('the dormant implementation is not imported by the engine, so none of it is on a runnable path', async () => {
        const { readFile } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const index = await readFile(fileURLToPath(new URL('../latam-global-tender-intelligence/index.ts', import.meta.url)), 'utf8');
        expect(index).not.toMatch(/connectors\/arCordoba\.js/);
        expect(index).toContain('arCordobaHeldConnector');
    });

    it('the tenders engine now offers exactly eight active sources', () => {
        const active = tendersEngine.connectors.filter((c) => c.status === 'active').map((c) => c.id).sort();
        expect(active).toEqual(['ar_entrerios', 'ar_santafe', 'ar_tucuman', 'cl_diario_oficial', 'eu_ted', 'it_lombardia_grants', 'us_florida', 'world_bank_notices']);
    });
});
