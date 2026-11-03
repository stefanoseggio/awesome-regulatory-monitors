import { describe, expect, it } from 'vitest';

import { usptoPtabConnector } from '../global-corporate-patent-intelligence/connectors/usptoPtab.js';
import type { ConnectorContext, HttpRequestInit } from '../lib/types.js';

describe('uspto_ptab respects the published 5 second retry floor', () => {
    it('passes minRetryDelayMs >= 5000 on every request', async () => {
        const seen: Array<HttpRequestInit | undefined> = [];
        const ctx: ConnectorContext = {
            http: {
                async getText() {
                    throw new Error('not used');
                },
                async getJson<T>(_url: string, init?: HttpRequestInit): Promise<T> {
                    seen.push(init);
                    return { count: 0, patentTrialProceedingDataBag: [] } as unknown as T;
                },
            },
            log: { info() {}, warning() {}, error() {}, debug() {} },
            now: () => new Date('2026-10-21T00:00:00Z'),
        };
        const options = usptoPtabConnector.optionsSchema.parse({ usptoOdpApiKey: 'k-test-123456' });
        await usptoPtabConnector.fetch(ctx, options, { maxItemsPerSource: 10 });
        expect(seen.length).toBeGreaterThan(0);
        for (const init of seen) expect(init?.minRetryDelayMs).toBeGreaterThanOrEqual(5000);
    });
});
