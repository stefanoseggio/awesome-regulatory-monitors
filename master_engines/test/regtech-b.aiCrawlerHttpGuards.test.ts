/**
 * ai_crawler_signals transport guards: every request must carry a body cap and a per-hop redirect validator
 * that refuses non-https hops and any host that would not itself pass the SSRF hostname guard. No network.
 */
import { describe, expect, it } from 'vitest';

import { aiCrawlerSignalsConnector, MAX_BODY_BYTES } from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';
import { aiCrawlerOptionsSchema } from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';
import { createStubHttp, makeCtx, must } from './regtech-b.helpers.js';

describe('ai_crawler_signals transport guards', () => {
    async function captureInit() {
        const routes = {
            'https://example.com/robots.txt': 'User-agent: *\nAllow: /\n',
            'https://example.com/llms.txt': 'llms',
            'https://example.com/llms-full.txt': 'llms full',
        };
        const { http, calls } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        await aiCrawlerSignalsConnector.fetch(ctx, aiCrawlerOptionsSchema.parse({ domains: ['example.com'] }), { maxItemsPerSource: 10 });
        return calls;
    }

    it('caps every request body and enables per-hop redirect validation', async () => {
        const calls = await captureInit();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call.init?.maxBytes).toBe(MAX_BODY_BYTES);
            expect(call.init?.redirects?.max).toBe(5);
            expect(typeof call.init?.redirects?.validate).toBe('function');
        }
    });

    it('the redirect validator allows public https hosts and refuses everything else', async () => {
        const calls = await captureInit();
        const validate = must(must(calls[0]).init?.redirects?.validate, 'validate');
        expect(validate(new URL('https://www.example.com/robots.txt'))).toBe(true);
        expect(validate(new URL('http://www.example.com/robots.txt'))).toBe(false);
        expect(validate(new URL('https://169.254.169.254/latest/meta-data'))).toBe(false);
        expect(validate(new URL('https://localhost/robots.txt'))).toBe(false);
        expect(validate(new URL('https://10.0.0.1.nip.io/robots.txt'))).toBe(false);
        expect(validate(new URL('https://internal.corp.local/robots.txt'))).toBe(false);
        expect(validate(new URL('https://intranet/robots.txt'))).toBe(false);
        expect(validate(new URL('https://[::1]/robots.txt'))).toBe(false);
    });
});
