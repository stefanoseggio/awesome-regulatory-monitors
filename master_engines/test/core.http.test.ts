import { describe, expect, it } from 'vitest';

import { createHttpClient, HttpBodyTooLargeError, HttpRedirectError, HttpStatusError, redactUrl } from '../lib/http.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function clientWith(handler: Handler, extra: { maxRetries?: number } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sleeps: number[] = [];
    const client = createHttpClient({
        userAgent: 'test-agent (contact@example.com)',
        maxRetries: extra.maxRetries ?? 2,
        baseDelayMs: 10,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        fetchImpl: (async (input: string | URL | Request, init: RequestInit = {}) => {
            const url = String(input);
            calls.push({ url, init });
            return handler(url, init);
        }) as typeof fetch,
    });
    return { client, calls, sleeps };
}

describe('redactUrl', () => {
    it('masks credential-looking query parameters and userinfo', () => {
        expect(redactUrl('https://api.example.com/x?api_key=SECRET&q=ok')).toBe('https://api.example.com/x?api_key=***&q=ok');
        expect(redactUrl('https://api.example.com/x?access_token=abc&Signature=zzz')).toContain('access_token=***');
        expect(redactUrl('https://api.example.com/x?Signature=zzz')).toContain('Signature=***');
        expect(redactUrl('https://user:pw@example.com/')).toBe('https://***@example.com/');
        expect(redactUrl('https://example.com/plain?page=2')).toBe('https://example.com/plain?page=2');
    });

    it('falls back to a regex for unparseable input', () => {
        expect(redactUrl('not a url?token=abc&x=1')).toBe('not a url?token=***&x=1');
    });
});

describe('createHttpClient', () => {
    it('sends the identifying user-agent and returns text/json', async () => {
        const { client, calls } = clientWith((url) => new Response(url.endsWith('.json') ? '{"a":1}' : 'hello'));
        expect(await client.getText('https://x.test/a')).toBe('hello');
        expect(await client.getJson('https://x.test/a.json')).toEqual({ a: 1 });
        expect((calls[0]?.init.headers as Record<string, string>)['user-agent']).toBe('test-agent (contact@example.com)');
    });

    it('retries retryable statuses with exponential back-off, then succeeds', async () => {
        let n = 0;
        const { client, sleeps } = clientWith(() => (++n < 3 ? new Response('busy', { status: 503 }) : new Response('ok')));
        expect(await client.getText('https://x.test/')).toBe('ok');
        expect(n).toBe(3);
        expect(sleeps).toEqual([10, 20]);
    });

    it('does not retry a 404 and surfaces a redacted URL in the error', async () => {
        let n = 0;
        const { client } = clientWith(() => {
            n += 1;
            return new Response('nope', { status: 404 });
        });
        const call = client.getText('https://x.test/data?api_key=TOPSECRET');
        await expect(call).rejects.toBeInstanceOf(HttpStatusError);
        await expect(call).rejects.not.toThrow(/TOPSECRET/);
        expect(n).toBe(1);
    });

    it('gives up after maxRetries on a persistent 500', async () => {
        let n = 0;
        const { client } = clientWith(() => {
            n += 1;
            return new Response('x', { status: 500 });
        }, { maxRetries: 2 });
        await expect(client.getText('https://x.test/')).rejects.toBeInstanceOf(HttpStatusError);
        expect(n).toBe(3);
    });

    it('retries a network error and eventually rethrows it', async () => {
        let n = 0;
        const { client } = clientWith(() => {
            n += 1;
            throw new Error('ECONNRESET');
        }, { maxRetries: 1 });
        await expect(client.getText('https://x.test/')).rejects.toThrow('ECONNRESET');
        expect(n).toBe(2);
    });
});

describe('maxBytes', () => {
    it('rejects a body larger than the cap while streaming, without retrying', async () => {
        let n = 0;
        const { client } = clientWith(() => {
            n += 1;
            return new Response('x'.repeat(5000));
        });
        await expect(client.getText('https://x.test/big', { maxBytes: 1000 })).rejects.toBeInstanceOf(HttpBodyTooLargeError);
        expect(n).toBe(1);
    });

    it('rejects early from a declared content-length', async () => {
        const { client } = clientWith(() => new Response('tiny', { headers: { 'content-length': '999999' } }));
        await expect(client.getText('https://x.test/', { maxBytes: 100 })).rejects.toBeInstanceOf(HttpBodyTooLargeError);
    });

    it('accepts a body at or under the cap and decodes multi-byte text', async () => {
        const { client } = clientWith(() => new Response('café 中文'));
        expect(await client.getText('https://x.test/', { maxBytes: 1000 })).toBe('café 中文');
    });
});

describe('redirect validation', () => {
    const handler: Handler = (url) => {
        if (url === 'https://a.test/start') return new Response(null, { status: 302, headers: { location: 'https://b.test/mid' } });
        if (url === 'https://b.test/mid') return new Response(null, { status: 301, headers: { location: '/final' } });
        if (url === 'https://b.test/final') return new Response('arrived');
        if (url === 'https://a.test/evil') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
        if (url === 'https://a.test/loop') return new Response(null, { status: 302, headers: { location: 'https://a.test/loop' } });
        if (url === 'https://a.test/nolocation') return new Response(null, { status: 302 });
        if (url === 'https://a.test/file') return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } });
        return new Response('?', { status: 404 });
    };

    it('follows hops (including relative Location) when each is approved', async () => {
        const { client, calls } = clientWith(handler);
        expect(await client.getText('https://a.test/start', { redirects: { max: 5, validate: () => true } })).toBe('arrived');
        expect(calls.map((c) => c.url)).toEqual(['https://a.test/start', 'https://b.test/mid', 'https://b.test/final']);
        expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
    });

    it('refuses a hop to a host the validator rejects, before requesting it', async () => {
        const { client, calls } = clientWith(handler);
        const call = client.getText('https://a.test/evil', { redirects: { max: 5, validate: (u) => u.hostname !== '169.254.169.254' } });
        await expect(call).rejects.toBeInstanceOf(HttpRedirectError);
        expect(calls.map((c) => c.url)).toEqual(['https://a.test/evil']);
    });

    it('refuses non-http(s) schemes, missing Location and redirect loops', async () => {
        const { client } = clientWith(handler);
        await expect(client.getText('https://a.test/file', { redirects: { max: 3 } })).rejects.toThrow(/unsupported scheme/);
        await expect(client.getText('https://a.test/nolocation', { redirects: { max: 3 } })).rejects.toThrow(/missing Location/);
        await expect(client.getText('https://a.test/loop', { redirects: { max: 3 } })).rejects.toThrow(/more than 3 redirects/);
    });

    it('leaves default redirect behaviour untouched when the option is absent', async () => {
        const { client, calls } = clientWith(() => new Response('plain'));
        await client.getText('https://a.test/x');
        expect(calls[0]?.init.redirect).toBeUndefined();
    });
});
