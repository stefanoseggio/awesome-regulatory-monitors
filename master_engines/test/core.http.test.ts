import { describe, expect, it } from 'vitest';

import { createHttpClient, HttpBodyTooLargeError, HttpRedirectError, HttpStatusError, parseRetryAfterMs, redactUrl } from '../lib/http.js';

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

    it('handles redirects itself by default (manual), following up to 5 hops without a validator', async () => {
        const { client, calls } = clientWith(handler);
        expect(await client.getText('https://a.test/start')).toBe('arrived');
        expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
        await expect(client.getText('https://a.test/loop')).rejects.toThrow(/more than 5 redirects/);
    });
});

describe('getRaw', () => {
    it('returns undecoded bytes, status and every Set-Cookie header', async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'ASP.NET_SessionId=abc; path=/; HttpOnly');
        headers.append('set-cookie', 'lang=es; path=/');
        const bytes = new Uint8Array([0x70, 0xf3, 0x6c, 0x69, 0x7a, 0x61]); // "póliza" in windows-1252/latin1
        const { client } = clientWith(() => new Response(bytes, { headers }));
        const raw = await client.getRaw!('https://x.test/');
        expect(raw.status).toBe(200);
        expect(Array.from(raw.body)).toEqual(Array.from(bytes));
        expect(raw.setCookies).toEqual(['ASP.NET_SessionId=abc; path=/; HttpOnly', 'lang=es; path=/']);
    });

    it('shares the retry, status and size policy with getText', async () => {
        let n = 0;
        const flaky = clientWith(() => (++n < 2 ? new Response('busy', { status: 503 }) : new Response('ok')));
        expect((await flaky.client.getRaw!('https://x.test/')).status).toBe(200);
        expect(n).toBe(2);

        const missing = clientWith(() => new Response('nope', { status: 404 }));
        await expect(missing.client.getRaw!('https://x.test/')).rejects.toBeInstanceOf(HttpStatusError);

        const big = clientWith(() => new Response('x'.repeat(5000)));
        await expect(big.client.getRaw!('https://x.test/', { maxBytes: 100 })).rejects.toBeInstanceOf(HttpBodyTooLargeError);
    });

    it('forwards a POST body and headers (cookie threading)', async () => {
        const { client, calls } = clientWith(() => new Response('ok'));
        await client.getRaw!('https://x.test/post', { method: 'POST', body: 'a=1', headers: { cookie: 'ASP.NET_SessionId=abc' } });
        expect(calls[0]?.init.method).toBe('POST');
        expect(calls[0]?.init.body).toBe('a=1');
        expect((calls[0]?.init.headers as Record<string, string>).cookie).toBe('ASP.NET_SessionId=abc');
    });
});

describe('tlsExtraCaPem hint', () => {
    it('warns once instead of being silently ignored', async () => {
        const warnings: string[] = [];
        const client = createHttpClient({
            userAgent: 'ua',
            maxRetries: 0,
            log: { info() {}, debug() {}, error() {}, warning: (m) => warnings.push(m) },
            fetchImpl: (async () => new Response('ok')) as typeof fetch,
        });
        await client.getText('https://x.test/', { tlsExtraCaPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----' });
        await client.getText('https://x.test/', { tlsExtraCaPem: 'again' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('NODE_EXTRA_CA_CERTS');
    });
});

describe('retry floor and Retry-After', () => {
    it('never retries sooner than minRetryDelayMs', async () => {
        let n = 0;
        const { client, sleeps } = clientWith(() => (++n < 3 ? new Response('slow down', { status: 429 }) : new Response('ok')));
        await client.getText('https://x.test/', { minRetryDelayMs: 5000 });
        expect(sleeps).toEqual([5000, 5000]);
    });

    it('honours a larger Retry-After header than the back-off schedule', async () => {
        let n = 0;
        const { client, sleeps } = clientWith(() => (++n < 2 ? new Response('x', { status: 429, headers: { 'retry-after': '7' } }) : new Response('ok')));
        await client.getText('https://x.test/');
        expect(sleeps).toEqual([7000]);
    });

    it('keeps the exponential schedule when it is already larger', async () => {
        let n = 0;
        const { client, sleeps } = clientWith(() => (++n < 3 ? new Response('x', { status: 503, headers: { 'retry-after': '0' } }) : new Response('ok')));
        await client.getText('https://x.test/');
        expect(sleeps).toEqual([10, 20]);
    });

    it('parseRetryAfterMs handles seconds, dates, junk and the cap', () => {
        expect(parseRetryAfterMs('3')).toBe(3000);
        expect(parseRetryAfterMs('0')).toBe(0);
        expect(parseRetryAfterMs(null)).toBe(0);
        expect(parseRetryAfterMs('soon')).toBe(0);
        expect(parseRetryAfterMs('99999')).toBe(120_000);
        expect(parseRetryAfterMs('-5')).toBe(0);
        const now = Date.parse('2026-10-21T00:00:00Z');
        expect(parseRetryAfterMs('Wed, 21 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
        expect(parseRetryAfterMs('Wed, 21 Oct 2026 00:00:00 GMT', now + 5000)).toBe(0);
    });
});

describe('redirects never leak credentials', () => {
    const redirectTo = (location: string, status = 302): Handler => (url) => (url === 'https://api.test/start' ? new Response(null, { status, headers: { location } }) : new Response('ok'));

    it('drops credential headers when the origin changes, keeps the safe ones', async () => {
        const { client, calls } = clientWith(redirectTo('https://other.test/landing'));
        await client.getText('https://api.test/start', { headers: { 'x-api-key': 'KEY-123456', 'x-app-token': 'TOK-123456', authorization: 'Bearer abcdef', cookie: 'a=b', accept: 'application/json' } });
        const second = calls[1]?.init.headers as Record<string, string>;
        expect(second['x-api-key']).toBeUndefined();
        expect(second['x-app-token']).toBeUndefined();
        expect(second.authorization).toBeUndefined();
        expect(second.cookie).toBeUndefined();
        expect(second['user-agent']).toBe('test-agent (contact@example.com)');
        expect(second.accept).toBe('application/json');
    });

    it('keeps headers on a same-origin redirect', async () => {
        const { client, calls } = clientWith(redirectTo('/next'));
        await client.getText('https://api.test/start', { headers: { 'x-api-key': 'KEY-123456' } });
        expect((calls[1]?.init.headers as Record<string, string>)['x-api-key']).toBe('KEY-123456');
    });

    it('refuses an https to http downgrade even on the same host', async () => {
        const { client, calls } = clientWith(redirectTo('http://api.test/plain'));
        await expect(client.getText('https://api.test/start', { headers: { 'x-api-key': 'KEY-123456' } })).rejects.toThrow(/downgrade/);
        expect(calls).toHaveLength(1);
    });

    it('turns a POST into a body-less GET on 302/303 and preserves it on 307/308', async () => {
        for (const [status, expectedMethod, expectedBody] of [[302, 'GET', undefined], [303, 'GET', undefined], [307, 'POST', 'a=1'], [308, 'POST', 'a=1']] as const) {
            const { client, calls } = clientWith(redirectTo('/next', status));
            await client.getText('https://api.test/start', { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
            expect(calls[1]?.init.method, String(status)).toBe(expectedMethod);
            expect(calls[1]?.init.body, String(status)).toBe(expectedBody);
        }
    });
});

describe('error bodies are bounded', () => {
    function endlessBody(): Response {
        let chunks = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                chunks += 1;
                if (chunks > 100_000) {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(64 * 1024).fill(65));
            },
        });
        return new Response(stream, { status: 404 });
    }

    it('reads at most a small preview of a non-2xx body and cancels the stream', async () => {
        const { client } = clientWith(() => endlessBody());
        const started = Date.now();
        const error = await client.getText('https://x.test/hostile', { maxBytes: 1000 }).catch((e: Error) => e);
        expect(error).toBeInstanceOf(HttpStatusError);
        expect((error as HttpStatusError).bodyPreview.length).toBeLessThanOrEqual(200);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('does the same on a retryable status across every attempt', async () => {
        let n = 0;
        const { client } = clientWith(() => {
            n += 1;
            return new Response('x'.repeat(5_000_000), { status: 503 });
        }, { maxRetries: 2 });
        await expect(client.getText('https://x.test/')).rejects.toBeInstanceOf(HttpStatusError);
        expect(n).toBe(3);
    });
});

describe('secret hygiene in logs', () => {
    it('redactUrl strips fragments and more credential names', () => {
        expect(redactUrl('https://x.test/p?session=abc&jwt=def&bearer=ghi&page=2#access_token=zzz')).toBe('https://x.test/p?session=***&jwt=***&bearer=***&page=2');
    });

    it('does not echo a header value in the retry debug line', async () => {
        const lines: string[] = [];
        const client = createHttpClient({
            userAgent: 'ua',
            maxRetries: 1,
            baseDelayMs: 1,
            sleep: async () => undefined,
            log: { info() {}, warning() {}, error() {}, debug: (m) => lines.push(m) },
            fetchImpl: (async (_u: string, init: RequestInit) => {
                throw new TypeError(`Headers.append: "${(init.headers as Record<string, string>)['x-app-token']}" is an invalid header value.`);
            }) as typeof fetch,
        });
        await expect(client.getText('https://x.test/', { headers: { 'x-app-token': 'LEAKME-SECRET-0123456789' } })).rejects.toThrow();
        expect(lines.join('\n')).not.toContain('LEAKME-SECRET-0123456789');
        expect(lines.join('\n')).toContain('***');
    });
});
