/**
 * au_grantconnect is a HELD connector, so these tests pin the hold itself: it stays registered, it cannot be selected,
 * it never touches the network, and its reason is the auditable one. There is no parser to test on purpose (see the
 * connector header): the legacy parsers cannot be exercised against the live site without the browser impersonation
 * the compliance doctrine forbids, and fixtures alone would not be evidence.
 *
 * The 403 evidence itself (honest User-Agent, curl User-Agent and no User-Agent all answered HTTP 403 by CloudFront,
 * including /robots.txt, on 2026-10-21) was captured with curl in the port session and is recorded in the connector
 * header; no test here reaches the network.
 */
import { describe, expect, it } from 'vitest';

import { FakeBilling } from '../lib/charging.js';
import { type EngineDefinition, EngineInputSchema, resolveSources, runEngine } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams } from '../lib/types.js';
import { AU_GRANTCONNECT_HELD_REASON, auGrantconnectConnector } from '../latam-global-tender-intelligence/connectors/auGrantconnect.js';
import { euTedConnector } from '../latam-global-tender-intelligence/connectors/euTed.js';
import { makeCtx } from './tenders-b.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const engine: EngineDefinition = { slug: 'latam-global-tender-intelligence', connectors: [auGrantconnectConnector, euTedConnector] };

describe('au_grantconnect (HELD)', () => {
    it('is registered, held, and carries the legacy actor slug and an auditable reason', () => {
        expect(auGrantconnectConnector.id).toBe('au_grantconnect');
        expect(auGrantconnectConnector.engine).toBe('latam-global-tender-intelligence');
        expect(auGrantconnectConnector.legacyActor).toBe('australia-grantconnect-monitor');
        expect(auGrantconnectConnector.status).toBe('held');
        expect(auGrantconnectConnector.heldReason).toBe(AU_GRANTCONNECT_HELD_REASON);
        expect(auGrantconnectConnector.description).toMatch(/GrantConnect/);
    });

    it('the held reason states what was found and why it is not worked around', () => {
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/403/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/robots\.txt/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/Chrome/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/impit/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/fingerprint spoofing/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/2026-10-21/);
        expect(AU_GRANTCONNECT_HELD_REASON).toMatch(/permission|official channel/);
    });

    it('fetch refuses with a FatalConfigError and makes no HTTP request', async () => {
        const stub = makeCtx(() => new Error('the held connector must not touch the network'));
        await expect(auGrantconnectConnector.fetch(stub.ctx, {}, RUN)).rejects.toBeInstanceOf(FatalConfigError);
        await expect(auGrantconnectConnector.fetch(stub.ctx, {}, RUN)).rejects.toThrow(/Source "au_grantconnect" is held: .*403/);
        expect(stub.requests).toHaveLength(0);
    });

    it('selecting it fails preflight with the reason, even alongside an active source and in any letter case', () => {
        for (const requested of ['au_grantconnect', 'AU_GrantConnect', '  au_grantconnect ']) {
            const input = EngineInputSchema.parse({ sources: [requested, 'eu_ted'] });
            expect(() => resolveSources(engine, input), requested).toThrow(FatalConfigError);
            expect(() => resolveSources(engine, input), requested).toThrow(/Source "au_grantconnect" is HELD and cannot run: .*403/);
        }
        // The active source on its own is unaffected.
        expect(resolveSources(engine, EngineInputSchema.parse({ sources: ['eu_ted'] })).map((r) => r.connector.id)).toEqual(['eu_ted']);
    });

    it('the router refuses the whole run before any network call or billable event when it is selected', async () => {
        const stub = makeCtx(() => new Error('no network expected'));
        const billing = new FakeBilling(true, { result: 0.002, 'watchlist-hit': 0.05 });
        let emitted = 0;
        const sinks = {
            async emit() {
                emitted += 1;
                return { emitted: true, limitReached: false };
            },
            billing,
            store: new InMemoryDeltaStore(),
            async saveSummary() {},
        };
        await expect(runEngine(engine, { sources: ['au_grantconnect'] }, { sinks, ctx: stub.ctx })).rejects.toThrow(/HELD/);
        expect(stub.requests).toHaveLength(0);
        expect(emitted).toBe(0);
        expect(billing.calls).toHaveLength(0);
    });

    it('accepts any options object (held connectors validate nothing) but cannot be run with them', () => {
        expect(auGrantconnectConnector.optionsSchema.safeParse({}).success).toBe(true);
        expect(auGrantconnectConnector.optionsSchema.safeParse({ keyword: 'aged care' }).success).toBe(true);
        expect(auGrantconnectConnector.requiredOptions).toBeUndefined();
    });
});
