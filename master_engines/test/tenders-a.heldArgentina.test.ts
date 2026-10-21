/**
 * Held Argentine portals (ar_salta, ar_mendoza, ar_pba): they must NEVER be runnable.
 *
 * The central claim proved here: selecting any of them makes the real preflight (`resolveSources`, and `runEngine`
 * which calls it) throw FatalConfigError containing the held reason - even when `sourceOptions` are supplied for it,
 * even when other (active) sources are selected next to it, and without a single network call, state read or charge.
 */
import { describe, expect, it } from 'vitest';

import { arCordobaConnector } from '../latam-global-tender-intelligence/connectors/arCordoba.js';
import { arSantaFeConnector } from '../latam-global-tender-intelligence/connectors/arSantaFe.js';
import * as held from '../latam-global-tender-intelligence/connectors/held_argentina.js';
import { arMendozaConnector, arPbaConnector, arSaltaConnector, PBA_HOLD_REASON, PORTFOLIO_HOLD_REASON } from '../latam-global-tender-intelligence/connectors/held_argentina.js';
import { type EngineDefinition, EngineInputSchema, resolveSources, runEngine } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type Connector, FatalConfigError } from '../lib/types.js';
import { FakeBilling, RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { makeCtx } from './tenders-a.helpers.js';

const HELD: Array<[string, Connector<Record<string, unknown>>, string, string]> = [
    ['ar_salta', arSaltaConnector, 'salta-compras-monitor', PORTFOLIO_HOLD_REASON],
    ['ar_mendoza', arMendozaConnector, 'mendoza-compras-monitor', PORTFOLIO_HOLD_REASON],
    ['ar_pba', arPbaConnector, 'pba-tenders-monitor', PBA_HOLD_REASON],
];

const engine: EngineDefinition = {
    slug: 'latam-global-tender-intelligence',
    connectors: [arSantaFeConnector, arCordobaConnector, arSaltaConnector, arMendozaConnector, arPbaConnector],
};

function thrown(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return undefined;
}

describe('the held connectors themselves', () => {
    it('exports exactly the three held connectors and nothing else', () => {
        expect(Object.keys(held).sort()).toEqual(['PBA_HOLD_REASON', 'PORTFOLIO_HOLD_REASON', 'arMendozaConnector', 'arPbaConnector', 'arSaltaConnector']);
    });

    it.each(HELD)('%s is status "held", for the right engine and legacy actor, with its reason recorded', (id, connector, legacyActor, reason) => {
        expect(connector.id).toBe(id);
        expect(connector.status).toBe('held');
        expect(connector.engine).toBe('latam-global-tender-intelligence');
        expect(connector.legacyActor).toBe(legacyActor);
        expect(connector.heldReason).toBe(reason);
        expect(connector.description).toContain('HELD');
        expect(connector.requiredOptions).toBeUndefined();
    });

    it('uses the prescribed portfolio-decision text for the two legacy repos that document no blocking constraint, and a documented-block reason for ar_pba', () => {
        expect(arSaltaConnector.heldReason).toBe('held by portfolio decision (operator-designated held source); no technical constraint documented in the legacy repo');
        expect(arMendozaConnector.heldReason).toBe(arSaltaConnector.heldReason);
        expect(arPbaConnector.heldReason).not.toBe(arSaltaConnector.heldReason);
        expect(arPbaConnector.heldReason).toContain('pbac.cgp.gba.gov.ar blocks non-residential, non-Argentine traffic');
        expect(arPbaConnector.heldReason).toContain('Residential proxy with countryCode AR');
    });

    it.each(HELD)('%s: calling fetch directly throws FatalConfigError with the reason (defence in depth), without touching the network', async (id, connector, _legacy, reason) => {
        const stub = makeCtx(() => new Error('the network must not be used'));
        const error = await connector.fetch(stub.ctx, {}, { maxItemsPerSource: 10 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FatalConfigError);
        expect((error as Error).message).toBe(`Source "${id}" is held: ${reason}`);
        expect(stub.calls).toHaveLength(0);
    });
});

describe('preflight (the real resolveSources)', () => {
    it.each(HELD)('selecting %s throws FatalConfigError containing the held reason', (id, _connector, _legacy, reason) => {
        const input = EngineInputSchema.parse({ sources: [id] });
        const error = thrown(() => resolveSources(engine, input));
        expect(error).toBeInstanceOf(FatalConfigError);
        expect((error as Error).message).toContain(reason);
        expect((error as Error).message).toContain(`Source "${id}" is HELD and cannot run`);
    });

    it.each(HELD)('selecting %s still throws when sourceOptions are supplied for it - credentials, valid-looking options, junk', (id, _connector, _legacy, reason) => {
        for (const slice of [{}, { token: 'secret', apiKey: 'k', proxyUrl: 'http://user:pass@proxy:8080' }, { maxItems: 5, estados: ['1'], anything: [1, 2, 3] }, { held: false, status: 'active' }]) {
            const input = EngineInputSchema.parse({ sources: [id], sourceOptions: { [id]: slice } });
            const error = thrown(() => resolveSources(engine, input));
            expect(error).toBeInstanceOf(FatalConfigError);
            // the HELD message wins; it is never replaced by (or accompanied by) an options-validation message
            expect((error as Error).message).toContain(reason);
            expect((error as Error).message).not.toContain('Invalid options');
        }
    });

    it('matches the id however it is spelled (case, surrounding whitespace, duplicates) and under any sourceOptions key spelling', () => {
        for (const spelling of ['AR_SALTA', ' ar_salta ', 'Ar_Salta']) {
            const input = EngineInputSchema.parse({ sources: [spelling, 'ar_salta'], sourceOptions: { [spelling]: { x: 1 } } });
            expect((thrown(() => resolveSources(engine, input)) as Error).message).toContain(PORTFOLIO_HOLD_REASON);
        }
    });

    it('selecting a held source next to active ones still fails the WHOLE run (no partial run), listing every held source in one pass', () => {
        const input = EngineInputSchema.parse({ sources: ['ar_santafe', 'ar_cordoba', 'ar_salta', 'ar_mendoza', 'ar_pba'] });
        const error = thrown(() => resolveSources(engine, input)) as Error;
        expect(error).toBeInstanceOf(FatalConfigError);
        expect(error.message).toContain('Source "ar_salta" is HELD');
        expect(error.message).toContain('Source "ar_mendoza" is HELD');
        expect(error.message).toContain('Source "ar_pba" is HELD');
        expect(error.message).toContain(PORTFOLIO_HOLD_REASON);
        expect(error.message).toContain(PBA_HOLD_REASON);
        expect(error.message).not.toContain('ar_santafe');
        expect(error.message).not.toContain('ar_cordoba');
    });

    it('the active sources of the same group resolve fine on their own (so the failures above are caused by the held status alone)', () => {
        const resolved = resolveSources(engine, EngineInputSchema.parse({ sources: ['ar_santafe', 'ar_cordoba'] }));
        expect(resolved.map((r) => r.connector.id)).toEqual(['ar_santafe', 'ar_cordoba']);
    });

    it('an unknown source lists only ACTIVE connectors as available, never the held ones', () => {
        const error = thrown(() => resolveSources(engine, EngineInputSchema.parse({ sources: ['ar_nowhere'] }))) as Error;
        expect(error.message).toContain('Unknown source "ar_nowhere"');
        expect(error.message).toContain('Available: ar_santafe, ar_cordoba.');
        expect(error.message).not.toMatch(/Available:[^.]*ar_(salta|mendoza|pba)/);
    });
});

describe('runEngine (the full router)', () => {
    it.each(HELD)('selecting %s aborts before any network call, state read, emit or charge', async (id, _connector, _legacy, reason) => {
        const stub = makeCtx(() => new Error('the network must not be used'));
        const billing = new FakeBilling(true, { [RESULT_EVENT]: 0.002, [WATCHLIST_HIT_EVENT]: 0.05 });
        const store = new InMemoryDeltaStore();
        let loads = 0;
        let saves = 0;
        const originalLoad = store.load.bind(store);
        const originalSave = store.save.bind(store);
        store.load = async () => {
            loads += 1;
            return originalLoad();
        };
        store.save = async (state) => {
            saves += 1;
            return originalSave(state);
        };
        const emitted: unknown[] = [];
        const error = await runEngine(
            engine,
            { sources: [id], sourceOptions: { [id]: { token: 'secret' } }, watchlistNames: ['anything'] },
            {
                ctx: stub.ctx,
                sinks: {
                    async emit(row) {
                        emitted.push(row);
                        return { emitted: true, limitReached: false };
                    },
                    billing,
                    store,
                    async saveSummary() {},
                },
            },
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FatalConfigError);
        expect((error as Error).message).toContain(reason);
        expect(stub.calls).toHaveLength(0);
        expect(loads).toBe(0);
        expect(saves).toBe(0);
        expect(emitted).toEqual([]);
        expect(billing.calls).toEqual([]);
    });
});
