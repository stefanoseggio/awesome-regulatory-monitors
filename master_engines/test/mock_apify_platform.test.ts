/**
 * Self-check of the mock Apify platform (test/support/mock_apify_platform.ts) against the REAL apify-client 2.x resource
 * clients, in-process: the mock is only worth anything if the real client behaves against it the way it does against the
 * platform. Each case pins one fact of the installed client that the platform-parity tests rely on (the file:line of the
 * client source is given where the case is about its behaviour rather than the mock's).
 */
import { ApifyClient, log, LogLevel } from 'apify';
import { afterEach, describe, expect, it } from 'vitest';

import { MockApifyPlatform, ppePricingInfo } from './support/mock_apify_platform.js';

// The client logs a warning for every retried request; the cases below retry on purpose.
log.setLevel(LogLevel.OFF);

const platforms: MockApifyPlatform[] = [];

async function setup(options: ConstructorParameters<typeof MockApifyPlatform>[0] = {}): Promise<{ platform: MockApifyPlatform; client: ApifyClient }> {
    const platform = await new MockApifyPlatform(options).start();
    platforms.push(platform);
    // 2 retries from 1 ms: the client's own default (8 retries from 500 ms, randomised) would take minutes.
    return { platform, client: new ApifyClient({ baseUrl: platform.baseUrl, token: platform.token, maxRetries: 2, minDelayBetweenRetriesMillis: 1 }) };
}

afterEach(async () => {
    await Promise.all(platforms.splice(0).map((p) => p.stop()));
});

describe('mock platform: key-value store records through the real KeyValueStoreClient', () => {
    it('the platform client has listKeys() but no keys(): the reason KeyValueStore.keys() throws at home', async () => {
        const { client } = await setup();
        const store = client.keyValueStore('anything') as unknown as Record<string, unknown>;
        expect(typeof store.listKeys).toBe('function');
        expect(store.keys).toBeUndefined();
    });

    it('opens a store by name the way the SDK does: lookup by id answers 404 (-> undefined), then get-or-create by name', async () => {
        const { platform, client } = await setup();
        platform.kv('named-store').setJson('K', { a: 1 });
        expect(await client.keyValueStore('named-store').get()).toBeUndefined();
        const created = await client.keyValueStores().getOrCreate('named-store');
        expect(created.id).not.toBe('named-store');
        expect(created.name).toBe('named-store');
        expect((await client.keyValueStores().getOrCreate('named-store')).id).toBe(created.id);
        expect((await client.keyValueStore(created.id).get())?.name).toBe('named-store');
        expect((await client.keyValueStore(created.id).getRecord('K'))?.value).toEqual({ a: 1 });
        expect(platform.unhandled).toEqual([]);
    });

    it('a missing record reads as undefined (404 record-not-found is swallowed by the client)', async () => {
        const { platform, client } = await setup();
        const { id } = await client.keyValueStores().getOrCreate('s');
        expect(await client.keyValueStore(id).getRecord('NOPE')).toBeUndefined();
        expect(platform.requestsMatching({ method: 'GET', key: 'NOPE' }).map((r) => r.status)).toEqual([404]);
    });

    it('JSON is parsed by the client; null and an empty body come back as null and undefined; other content types are not parsed', async () => {
        const { platform, client } = await setup();
        const kv = platform.kv('s');
        const store = client.keyValueStore(kv.id);
        kv.setJson('OBJ', { a: [1, 2] });
        kv.setRaw('NULL', 'null', 'application/json; charset=utf-8');
        kv.setRaw('EMPTY', '', 'application/json; charset=utf-8');
        kv.setRaw('TEXT', '{"a":1}', 'text/plain; charset=utf-8');
        kv.setRaw('BIN', Buffer.from([1, 2, 3]), 'application/octet-stream');
        expect(await store.getRecord('OBJ')).toMatchObject({ value: { a: [1, 2] }, contentType: 'application/json; charset=utf-8' });
        expect((await store.getRecord('NULL'))?.value).toBeNull();
        expect(await store.getRecord('EMPTY')).toMatchObject({ key: 'EMPTY', value: undefined });
        expect((await store.getRecord('TEXT'))?.value).toBe('{"a":1}');
        const bin = (await store.getRecord('BIN'))?.value;
        expect(Buffer.isBuffer(bin)).toBe(true);
    });

    it('a truncated JSON record makes the client THROW InvalidResponseBodyError, after retrying it (maxRetries + 1 requests)', async () => {
        const { platform, client } = await setup();
        const kv = platform.kv('s');
        kv.setTruncatedJson('BAD', { seenIds: ['a', 'b'], fingerprints: { a: 'x' } });
        const error = await client.keyValueStore(kv.id).getRecord('BAD').catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('InvalidResponseBodyError');
        expect((error as { code?: string }).code).toBe('invalid-response-body');
        expect(platform.requestsMatching({ method: 'GET', key: 'BAD' })).toHaveLength(3);
    });

    it('PUT stores the content type and body; a null write is a DELETE; deleting an absent record is a 204', async () => {
        const { platform, client } = await setup();
        const kv = platform.kv('s');
        const store = client.keyValueStore(kv.id);
        await store.setRecord({ key: 'A', value: { n: 1 } as never, contentType: 'application/json; charset=utf-8' });
        expect(kv.getRaw('A')?.contentType).toBe('application/json; charset=utf-8');
        expect(kv.json('A')).toEqual({ n: 1 });
        await store.deleteRecord('A');
        await store.deleteRecord('A');
        expect(kv.has('A')).toBe(false);
        expect(kv.writes.map((w) => `${w.op}:${w.key}`)).toEqual(['put:A', 'delete:A', 'delete:A']);
        expect(platform.requestsMatching({ method: 'DELETE' }).map((r) => r.status)).toEqual([204, 204]);
    });

    it('bodies of 1 KiB and more arrive brotli-compressed from the client and are stored decoded', async () => {
        const { platform, client } = await setup();
        const kv = platform.kv('s');
        const big = { ids: Array.from({ length: 400 }, (_, i) => `record-${i}`) };
        await client.keyValueStore(kv.id).setRecord({ key: 'BIG', value: big as never, contentType: 'application/json; charset=utf-8' });
        const put = platform.requestsMatching({ method: 'PUT', key: 'BIG' })[0];
        expect(put?.contentEncoding).toBe('br');
        expect(kv.json('BIG')).toEqual(big);
        expect((await client.keyValueStore(kv.id).getRecord('BIG'))?.value).toEqual(big);
    });
});

describe('mock platform: listing keys', () => {
    it('lists in key order, filters by prefix, and paginates with exclusiveStartKey / limit / isTruncated / nextExclusiveStartKey', async () => {
        const { platform, client } = await setup({ maxKeysPerPage: 2 });
        const kv = platform.kv('s');
        for (const key of ['state.ns.c', 'state.ns.a', 'journal.ns.a', 'state.ns.b', 'state.ns.d', 'zzz']) kv.setJson(key, {});
        const store = client.keyValueStore(kv.id);

        const first = await store.listKeys({ prefix: 'state.ns.' });
        expect(first.items.map((i) => i.key)).toEqual(['state.ns.a', 'state.ns.b']);
        expect(first.isTruncated).toBe(true);
        expect(first.nextExclusiveStartKey).toBe('state.ns.b');
        expect(first.limit).toBe(2);
        const second = await store.listKeys({ prefix: 'state.ns.', exclusiveStartKey: first.nextExclusiveStartKey });
        expect(second.items.map((i) => i.key)).toEqual(['state.ns.c', 'state.ns.d']);
        expect(second.isTruncated).toBe(false);
        expect(second.nextExclusiveStartKey).toBeNull();

        // The client's own iterator stops on `nextExclusiveStartKey === null` (apify-client key_value_store.js:136-139).
        const all: string[] = [];
        for await (const item of store.listKeys({ prefix: 'state.ns.' }) as unknown as AsyncIterable<{ key: string }>) all.push(item.key);
        expect(all).toEqual(['state.ns.a', 'state.ns.b', 'state.ns.c', 'state.ns.d']);

        expect((await store.listKeys({ limit: 1 })).items.map((i) => i.key)).toEqual(['journal.ns.a']);
        expect((await store.listKeys({ prefix: 'nothing' })).items).toEqual([]);
    });
});

describe('mock platform: datasets, charges and runs', () => {
    it('records dataset items (compressed batches included) and the default dataset is addressable by id', async () => {
        const { platform, client } = await setup();
        const dataset = client.dataset(platform.dataset.id);
        expect((await dataset.get())?.id).toBe(platform.dataset.id);
        await dataset.pushItems(JSON.stringify([{ n: 1 }, { n: 2 }]));
        await dataset.pushItems(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ n: i, pad: 'x'.repeat(20) }))));
        expect(platform.dataset.items).toHaveLength(302);
        expect(platform.dataset.pushes).toEqual([2, 300]);
        expect(platform.requestsMatching({ method: 'POST', path: /\/items$/ })[1]?.contentEncoding).toBe('br');
    });

    it('records every charge call with its idempotency key; a retry after a lost acknowledgement is not billed twice', async () => {
        const { platform, client } = await setup();
        platform.failNext((r) => r.method === 'POST' && r.path.endsWith('/charge'), 1, { applied: true });
        await client.run('run-x').charge({ eventName: 'doc-new', count: 3 });
        await client.run('run-x').charge({ eventName: 'watchlist-hit', count: 1 });
        expect(platform.charges.calls.map((c) => [c.eventName, c.count, c.duplicate])).toEqual([
            ['doc-new', 3, false],
            ['doc-new', 3, true],
            ['watchlist-hit', 1, false],
        ]);
        expect(platform.charges.byEvent()).toEqual({ 'doc-new': 3, 'watchlist-hit': 1 });
        expect(platform.charges.totalUsd({ 'doc-new': 0.01, 'watchlist-hit': 0.15 })).toBe(0.18);
        expect(platform.charges.calls[0]?.runId).toBe('run-x');
        expect(platform.charges.calls[0]?.idempotencyKey).toBeDefined();
        expect(platform.charges.calls[0]?.idempotencyKey).toBe(platform.charges.calls[1]?.idempotencyKey);
    });

    it('GET /v2/actor-runs/:id: a status, 404 record-not-found and 404 record-or-token-not-found read as undefined, 403 throws', async () => {
        const { platform, client } = await setup({ runId: 'own', pricingInfo: ppePricingInfo({ 'doc-new': 0.01 }), maxTotalChargeUsd: 5 });
        platform.setRunStatus('r-running', 'RUNNING');
        platform.setRunStatus('r-failed', 'FAILED');
        platform.setRunStatus('r-gone', 'not-found');
        platform.setRunStatus('r-hidden', 'token-not-found');
        platform.setRunStatus('r-forbidden', 403);
        expect((await client.run('r-running').get())?.status).toBe('RUNNING');
        expect((await client.run('r-failed').get())?.status).toBe('FAILED');
        expect(await client.run('r-gone').get()).toBeUndefined();
        expect(await client.run('r-hidden').get()).toBeUndefined();
        expect(await client.run('never-heard-of').get()).toBeUndefined();
        const error = await client.run('r-forbidden').get().catch((e: Error) => e);
        expect((error as { statusCode?: number }).statusCode).toBe(403);
        expect((error as { type?: string }).type).toBe('insufficient-permissions');
        // 403 is not retried (4xx): one request.
        expect(platform.requestsMatching({ method: 'GET', path: /r-forbidden$/ })).toHaveLength(1);
        const own = await client.run('own').get();
        expect(own).toMatchObject({ status: 'RUNNING', options: { maxTotalChargeUsd: 5 }, pricingInfo: { pricingModel: 'PAY_PER_EVENT' } });
    });

    it('fault hooks: failNext answers 500 (retried by the client) for the matching requests only, then the real answer; more failures than retries throw', async () => {
        const { platform, client } = await setup();
        const kv = platform.kv('s');
        kv.setJson('A', { ok: true });
        platform.failNext((r) => r.method === 'GET' && r.key === 'A', 2);
        expect((await client.keyValueStore(kv.id).getRecord('A'))?.value).toEqual({ ok: true });
        expect(platform.requestsMatching({ method: 'GET', key: 'A' }).map((r) => [r.status, r.faulted])).toEqual([
            [500, true],
            [500, true],
            [200, false],
        ]);
        platform.failNext((r) => r.key === 'A', 10);
        const error = await client.keyValueStore(kv.id).getRecord('A').catch((e: Error) => e);
        expect((error as { statusCode?: number }).statusCode).toBe(500);
        platform.clearFaults();
        expect((await client.keyValueStore(kv.id).getRecord('A'))?.value).toEqual({ ok: true });
    });

    it('an endpoint the mock does not implement answers 400 (not retried, not a swallowed 404) and is listed in `unhandled`', async () => {
        const { platform, client } = await setup();
        const error = await client.user('me').get().catch((e: Error) => e);
        expect((error as { statusCode?: number }).statusCode).toBe(400);
        expect(platform.unhandled).toHaveLength(1);
        expect(platform.unhandled[0]).toMatch(/GET \/v2\/users\/me/);
    });
});
