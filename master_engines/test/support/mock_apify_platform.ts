/**
 * An in-process mock of the slice of the Apify REST API that the Apify SDK 3.x and apify-client 2.x use "at home"
 * (APIFY_IS_AT_HOME=1), so that the production code can be run through the REAL SDK and the REAL platform resource
 * clients (KeyValueStoreClient, DatasetClient, RunClient) against it, from a child process (see platform_child.ts).
 *
 * WHY. Every other real-SDK test of this package runs the SDK on LOCAL storage (crawlee MemoryStorage). The platform path
 * differs in ways that matter (all verified in the installed packages):
 *   - the key-value-store client has `listKeys()` but no `keys()`, so `KeyValueStore.keys()` throws on the platform
 *     (@crawlee/core storages/key_value_store.js `keys()`);
 *   - a record is fetched with its content type and JSON-PARSED BY THE CLIENT: a truncated `application/json` body makes
 *     `getRecord` throw `InvalidResponseBodyError` after the client's retries (apify-client interceptors.js,
 *     http_client.js `_isResponseBodyInvalid`), it never returns `null`;
 *   - `getRecord`, `RunClient.get` and the other `get` calls turn a 404 whose error type is `record-not-found` OR
 *     `record-or-token-not-found` into `undefined`; every other status (403, 5xx after the retries) is thrown
 *     (apify-client utils.js `catchNotFoundOrThrow`);
 *   - request bodies of 1 KiB and more are compressed (brotli) by the client (utils.js `maybeCompressValue`);
 *   - the pay-per-event charge goes through `POST /v2/actor-runs/:id/charge` (resource_clients/run.js `charge`).
 * The mock is deterministic (counter ids, fixed timestamps, no randomness) and depends on `node:` modules only.
 *
 * What it does NOT model: authentication, quotas, storage limits (the 9,436,240-byte dataset item limit is enforced
 * CLIENT-SIDE by crawlee's `checkAndSerialize`, so the real client rejects an oversized item before any request) and the
 * platform's answer to a charge beyond `maxTotalChargeUsd` (the SDK's ChargingManager enforces the budget locally and
 * never sends such a call; the mock only records the calls it receives).
 *
 * Usage:
 *   const platform = await new MockApifyPlatform({ runId: 'run-1' }).start();
 *   platform.kv('my-store').setJson('lease.default.ofac', {...});   // seed (not logged as a request)
 *   ...run the child against platform.childEnv()...
 *   expect(platform.dataset.items).toHaveLength(3);
 *   await platform.stop();
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const LIVE_STATUSES: readonly string[] = ['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'];

/** The statuses of an Actor run (`ACTOR_JOB_STATUSES` in @apify/consts). Any other string is also accepted, to test an unexpected one. */
export type RunStatus = 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMING-OUT' | 'TIMED-OUT' | 'ABORTING' | 'ABORTED';

/**
 * What `GET /v2/actor-runs/:id` answers for a run:
 *   a status               200 with that status
 *   'not-found'            404, error type `record-not-found`           (apify-client returns `undefined`)
 *   'token-not-found'      404, error type `record-or-token-not-found`  (apify-client returns `undefined`, too)
 *   403                    403, error type `insufficient-permissions`   (apify-client throws; the type name is the mock's choice)
 */
export type RunBehaviour = RunStatus | (string & {}) | 'not-found' | 'token-not-found' | 403;

export interface StoredRecord {
    body: Buffer;
    contentType: string;
}

/** One write that reached the mock over HTTP (seeding through the accessors is not logged here). */
export interface KvWrite {
    seq: number;
    op: 'put' | 'delete';
    key: string;
    contentType?: string;
    body?: Buffer;
}

/** A key-value store of the mock. Reads and seeds go through these accessors; the code under test goes through HTTP. */
export class MockKeyValueStore {
    readonly records = new Map<string, StoredRecord>();
    /** Every PUT and DELETE of a record that arrived over HTTP, in order. */
    readonly writes: KvWrite[] = [];

    constructor(
        readonly id: string,
        readonly name: string | undefined,
    ) {}

    has(key: string): boolean {
        return this.records.has(key);
    }

    /** The raw record: exactly the bytes and content type the platform would serve. */
    getRaw(key: string): StoredRecord | undefined {
        return this.records.get(key);
    }

    text(key: string): string | undefined {
        return this.records.get(key)?.body.toString('utf8');
    }

    /** The record parsed as JSON; `undefined` when absent. Throws when the body is not valid JSON. */
    json<T = unknown>(key: string): T | undefined {
        const text = this.text(key);
        return text === undefined ? undefined : (JSON.parse(text) as T);
    }

    /** Stores `value` the way the SDK does (`application/json; charset=utf-8`, 2-space indentation). */
    setJson(key: string, value: unknown): void {
        this.records.set(key, { body: Buffer.from(JSON.stringify(value, null, 2), 'utf8'), contentType: 'application/json; charset=utf-8' });
    }

    /** Stores arbitrary bytes under an arbitrary content type (a truncated JSON body, an empty body, `text/plain`...). */
    setRaw(key: string, body: string | Buffer, contentType: string): void {
        this.records.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), contentType });
    }

    /** Stores the JSON of `value` cut off after `keepFraction` of its bytes, served as `application/json`: a half-written record. */
    setTruncatedJson(key: string, value: unknown, keepFraction = 0.6): void {
        const full = JSON.stringify(value);
        this.setRaw(key, full.slice(0, Math.max(1, Math.floor(full.length * keepFraction))), 'application/json; charset=utf-8');
    }

    delete(key: string): boolean {
        return this.records.delete(key);
    }

    /** Record keys in the order the platform lists them (ascending), optionally those that start with `prefix`. */
    keys(prefix = ''): string[] {
        return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys);
    }

    writesTo(key: string): KvWrite[] {
        return this.writes.filter((w) => w.key === key);
    }
}

export class MockDataset {
    /** Every item pushed over HTTP, in order. */
    readonly items: Array<Record<string, unknown>> = [];
    /** The size of every POST .../items request (batch), in order. */
    readonly pushes: number[] = [];

    constructor(
        readonly id: string,
        readonly name: string | undefined,
    ) {}
}

export interface ChargeCall {
    seq: number;
    runId: string;
    eventName: string;
    count: number;
    idempotencyKey: string | undefined;
    /** True when an earlier call carried the same idempotency key: the platform answers 201 and does not charge twice. */
    duplicate: boolean;
}

/** Every `POST /v2/actor-runs/:id/charge` the mock received. */
export class MockCharges {
    readonly calls: ChargeCall[] = [];

    /** The calls the platform would actually bill (no replays of an idempotency key). */
    get accepted(): ChargeCall[] {
        return this.calls.filter((c) => !c.duplicate);
    }

    /** Billed count of one event. */
    count(eventName: string): number {
        return this.accepted.filter((c) => c.eventName === eventName).reduce((sum, c) => sum + c.count, 0);
    }

    /** Billed counts per event. */
    byEvent(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const c of this.accepted) out[c.eventName] = (out[c.eventName] ?? 0) + c.count;
        return out;
    }

    /** What the billed events cost under `prices` (event name -> USD). An event without a price costs nothing. */
    totalUsd(prices: Readonly<Record<string, number>>): number {
        return Number(this.accepted.reduce((sum, c) => sum + c.count * (prices[c.eventName] ?? 0), 0).toFixed(6));
    }
}

/** What a request looks like to a request log filter and to a fault predicate. */
export interface RequestInfo {
    method: string;
    /** URL path without the query. */
    path: string;
    query: Readonly<Record<string, string>>;
    /** Id of the key-value store, when the request addresses one. */
    storeId?: string;
    /** Name of that store (undefined for the default store). */
    storeName?: string;
    /** Record key (decoded), for `.../records/:key`. */
    key?: string;
    /** Run id, for `/v2/actor-runs/:id...`. */
    runId?: string;
    datasetId?: string;
}

export interface RequestLogEntry extends RequestInfo {
    seq: number;
    /** HTTP status the mock answered (0 until it answered). */
    status: number;
    /** Size of the (decoded) request body. */
    bodyBytes: number;
    contentEncoding?: string;
    /** True when a fault hook produced the answer. */
    faulted: boolean;
}

export interface FaultOptions {
    /** Default 500. */
    status?: number;
    /** Default `{ error: { type: 'internal-error', message: ... } }`. */
    body?: unknown;
    /** When true the request is applied first (a write is stored, a charge is recorded) and the failure is the lost acknowledgement. */
    applied?: boolean;
}

interface Fault {
    predicate: (request: RequestInfo) => boolean;
    remaining: number;
    options: FaultOptions;
}

export interface MockPlatformOptions {
    /** The run under test (`ACTOR_RUN_ID` of the child). Its record is served with `pricingInfo` and the budget. Default `run-under-test`. */
    runId?: string;
    token?: string;
    /** Served in the own run record, for runs whose SDK reads the pricing from the API instead of the environment. */
    pricingInfo?: unknown;
    maxTotalChargeUsd?: number;
    /** Server-side cap of `GET .../keys` pages (the real cap is 1000); lowered in tests to exercise pagination. */
    maxKeysPerPage?: number;
    /** Keys a listing leaves out although the record exists (a listing that lags behind a write); direct reads still find them. */
    listingHides?: (key: string) => boolean;
}

/** The `pricingInfo` of a pay-per-event Actor with these event prices (USD). */
export function ppePricingInfo(prices: Readonly<Record<string, number>>): {
    pricingModel: 'PAY_PER_EVENT';
    pricingPerEvent: { actorChargeEvents: Record<string, { eventTitle: string; eventDescription: string; eventPriceUsd: number }> };
} {
    return {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: Object.fromEntries(Object.entries(prices).map(([name, eventPriceUsd]) => [name, { eventTitle: name, eventDescription: name, eventPriceUsd }])) },
    };
}

function compareKeys(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
    switch (encoding?.toLowerCase()) {
        case undefined:
        case '':
        case 'identity':
            return body;
        case 'br':
            return brotliDecompressSync(body);
        case 'gzip':
            return gunzipSync(body);
        case 'deflate':
            return inflateSync(body);
        default:
            throw new Error(`unsupported content-encoding ${encoding}`);
    }
}

export class MockApifyPlatform {
    readonly runId: string;
    readonly token: string;
    readonly defaultKv: MockKeyValueStore;
    readonly dataset: MockDataset;
    readonly charges = new MockCharges();
    /** Every request the mock received, in order, with the status it answered. */
    readonly requests: RequestLogEntry[] = [];
    /** Requests the mock does not implement (answered 400 `mock-not-implemented`): a test should expect this to stay empty. */
    readonly unhandled: string[] = [];
    maxKeysPerPage: number;
    listingHides: ((key: string) => boolean) | undefined;

    private readonly stores = new Map<string, MockKeyValueStore>();
    private readonly datasetsById = new Map<string, MockDataset>();
    private readonly runBehaviours = new Map<string, RunBehaviour>();
    private readonly runStatusMessages = new Map<string, string>();
    private readonly seenIdempotencyKeys = new Set<string>();
    private readonly faults: Fault[] = [];
    private readonly pricingInfo: unknown;
    private readonly maxTotalChargeUsd: number | undefined;
    private nextId = 1;
    private seq = 0;
    private server: Server | undefined;
    private url: string | undefined;

    constructor(options: MockPlatformOptions = {}) {
        this.runId = options.runId ?? 'run-under-test';
        this.token = options.token ?? 'mock-token';
        this.pricingInfo = options.pricingInfo;
        this.maxTotalChargeUsd = options.maxTotalChargeUsd;
        this.maxKeysPerPage = options.maxKeysPerPage ?? 1000;
        this.listingHides = options.listingHides;
        this.defaultKv = new MockKeyValueStore('default-kv', undefined);
        this.stores.set(this.defaultKv.id, this.defaultKv);
        this.dataset = new MockDataset('default-dataset', undefined);
        this.datasetsById.set(this.dataset.id, this.dataset);
    }

    async start(): Promise<this> {
        if (this.server) return this;
        const server = createServer((req, res) => {
            this.handle(req, res).catch((error: unknown) => {
                this.unhandled.push(`INTERNAL ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'mock-internal-error', message: String(error) } }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        this.server = server;
        this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return this;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) return;
        this.server = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /** Base URL of the API (`APIFY_API_BASE_URL`), without a trailing slash. */
    get baseUrl(): string {
        if (!this.url) throw new Error('MockApifyPlatform is not started');
        return this.url;
    }

    /** What platform_child.ts needs to point the SDK at this mock. */
    childEnv(): Record<string, string> {
        return {
            PLATFORM_URL: this.baseUrl,
            PLATFORM_TOKEN: this.token,
            PLATFORM_DEFAULT_KV_ID: this.defaultKv.id,
            PLATFORM_DEFAULT_DATASET_ID: this.dataset.id,
        };
    }

    /** The NAMED key-value store `name` (created empty when it does not exist yet, as the platform's get-or-create does). */
    kv(name: string): MockKeyValueStore {
        for (const store of this.stores.values()) if (store.name === name) return store;
        return this.createStore(name);
    }

    /** Names of the named key-value stores that exist. */
    storeNames(): string[] {
        return [...this.stores.values()].flatMap((s) => (s.name === undefined ? [] : [s.name]));
    }

    /** What `GET /v2/actor-runs/:id` answers for `runId` (see {@link RunBehaviour}). Not set: the own run is RUNNING, any other is 'not-found'. */
    setRunStatus(runId: string, behaviour: RunBehaviour): void {
        this.runBehaviours.set(runId, behaviour);
    }

    /** Status message the code under test set on a run (the SDK does it on `Actor.exit` / `Actor.fail`). */
    statusMessage(runId: string = this.runId): string | undefined {
        return this.runStatusMessages.get(runId);
    }

    /**
     * Makes the next `times` requests that match `predicate` fail (default status 500, which apify-client retries). Use
     * `{ applied: true }` for a lost acknowledgement. Faults are consumed in the order they were added.
     */
    failNext(predicate: (request: RequestInfo) => boolean, times = 1, options: FaultOptions = {}): void {
        this.faults.push({ predicate, remaining: times, options });
    }

    clearFaults(): void {
        this.faults.length = 0;
    }

    /** Requests of the log that match `method` (exact, optional), `path` (regular expression, optional) and `key` (exact or regular expression, optional). */
    requestsMatching(filter: { method?: string; path?: RegExp; key?: string | RegExp }): RequestLogEntry[] {
        return this.requests.filter((r) => {
            if (filter.method !== undefined && r.method !== filter.method) return false;
            if (filter.path !== undefined && !filter.path.test(r.path)) return false;
            if (typeof filter.key === 'string' && r.key !== filter.key) return false;
            if (filter.key instanceof RegExp && !(r.key !== undefined && filter.key.test(r.key))) return false;
            return true;
        });
    }

    // ---------------------------------------------------------------------------------------------------------------

    private createStore(name: string | undefined): MockKeyValueStore {
        const store = new MockKeyValueStore(`kvs${String(this.nextId++).padStart(4, '0')}`, name);
        this.stores.set(store.id, store);
        return store;
    }

    private createDataset(name: string | undefined): MockDataset {
        const dataset = new MockDataset(`ds${String(this.nextId++).padStart(4, '0')}`, name);
        this.datasetsById.set(dataset.id, dataset);
        return dataset;
    }

    private async readBody(req: IncomingMessage): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
    }

    private runRecord(runId: string, status: string): Record<string, unknown> {
        const own = runId === this.runId;
        return {
            id: runId,
            actId: 'mock-actor',
            userId: 'mock-user',
            startedAt: FIXED_TIME,
            ...(LIVE_STATUSES.includes(status) ? {} : { finishedAt: FIXED_TIME }),
            status,
            statusMessage: this.runStatusMessages.get(runId),
            defaultKeyValueStoreId: this.defaultKv.id,
            defaultDatasetId: this.dataset.id,
            defaultRequestQueueId: 'default-rq',
            options: { build: 'latest', timeoutSecs: 3600, memoryMbytes: 1024, ...(own && this.maxTotalChargeUsd !== undefined ? { maxTotalChargeUsd: this.maxTotalChargeUsd } : {}) },
            ...(own && this.pricingInfo !== undefined ? { pricingInfo: this.pricingInfo, chargedEventCounts: {} } : {}),
        };
    }

    private currentRunStatus(runId: string): string {
        const behaviour = this.runBehaviours.get(runId);
        return behaviour === undefined || typeof behaviour === 'number' || behaviour === 'not-found' || behaviour === 'token-not-found' ? 'RUNNING' : behaviour;
    }

    private storeObject(store: MockKeyValueStore): Record<string, unknown> {
        return { id: store.id, ...(store.name !== undefined ? { name: store.name } : {}), userId: 'mock-user', createdAt: FIXED_TIME, modifiedAt: FIXED_TIME, accessedAt: FIXED_TIME };
    }

    private datasetObject(dataset: MockDataset): Record<string, unknown> {
        return {
            id: dataset.id,
            ...(dataset.name !== undefined ? { name: dataset.name } : {}),
            userId: 'mock-user',
            createdAt: FIXED_TIME,
            modifiedAt: FIXED_TIME,
            accessedAt: FIXED_TIME,
            itemCount: dataset.items.length,
            cleanItemCount: dataset.items.length,
        };
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = (req.method ?? 'GET').toUpperCase();
        const url = new URL(req.url ?? '/', 'http://mock');
        const query: Record<string, string> = {};
        for (const [name, value] of url.searchParams) query[name] = value;
        const path = url.pathname;

        const raw = await this.readBody(req);
        const contentEncoding = req.headers['content-encoding'];
        const body = decodeBody(raw, typeof contentEncoding === 'string' ? contentEncoding : undefined);

        // Which resource does the request address? Resolved before the fault predicates run, so that they can match on it.
        const info: RequestInfo = { method, path, query };
        const kvRoute = path.match(/^\/v2\/key-value-stores\/([^/]+)(?:\/(keys)|\/records\/(.+))?$/);
        const store = kvRoute ? this.stores.get(decodeURIComponent(kvRoute[1] as string)) : undefined;
        const key = kvRoute?.[3] !== undefined ? decodeURIComponent(kvRoute[3]) : undefined;
        if (kvRoute) {
            info.storeId = decodeURIComponent(kvRoute[1] as string);
            if (store?.name !== undefined) info.storeName = store.name;
            if (key !== undefined) info.key = key;
        }
        const runRoute = path.match(/^\/v2\/actor-runs\/([^/]+)(\/charge)?$/);
        const runId = runRoute ? decodeURIComponent(runRoute[1] as string) : undefined;
        if (runId !== undefined) info.runId = runId;
        const datasetRoute = path.match(/^\/v2\/datasets\/([^/]+)(\/items)?$/);
        const datasetId = datasetRoute ? decodeURIComponent(datasetRoute[1] as string) : undefined;
        if (datasetId !== undefined) info.datasetId = datasetId;

        const entry: RequestLogEntry = { ...info, seq: ++this.seq, status: 0, bodyBytes: body.length, ...(typeof contentEncoding === 'string' ? { contentEncoding } : {}), faulted: false };
        this.requests.push(entry);

        let override: (() => void) | undefined;
        const write = (status: number, headers: Record<string, string>, data?: Buffer): void => {
            entry.status = status;
            res.writeHead(status, headers);
            res.end(method === 'HEAD' ? undefined : data);
        };
        const send = (status: number, payload?: unknown, contentType = 'application/json; charset=utf-8'): void => {
            if (override) return override();
            const data = payload === undefined ? undefined : Buffer.isBuffer(payload) ? payload : typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(JSON.stringify(payload), 'utf8');
            write(status, data === undefined ? {} : { 'content-type': contentType, 'content-length': String(data.length) }, data);
        };
        const error = (status: number, type: string, message: string): void => send(status, { error: { type, message } });
        const notFound = (what: string): void => error(404, 'record-not-found', `${what} was not found`);

        // Fault hooks. A fault that is `applied` lets the handler below run (its side effects happen) and replaces its answer.
        const fault = this.faults.find((f) => f.remaining > 0 && f.predicate(info));
        if (fault) {
            fault.remaining -= 1;
            entry.faulted = true;
            const status = fault.options.status ?? 500;
            const payload = fault.options.body ?? { error: { type: 'internal-error', message: `injected failure of ${method} ${path}` } };
            const data = Buffer.from(JSON.stringify(payload), 'utf8');
            const fail = (): void => write(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(data.length) }, data);
            if (!fault.options.applied) return fail();
            override = fail;
        }

        // --- key-value stores ---------------------------------------------------------------------------------------
        if (method === 'POST' && path === '/v2/key-value-stores') {
            // get-or-create by name: the SDK's fallback when the lookup by id (next route) answered 404
            const name = query.name;
            return send(201, { data: this.storeObject(name === undefined ? this.createStore(undefined) : this.kv(name)) });
        }
        if (kvRoute && kvRoute[2] === undefined && kvRoute[3] === undefined) {
            // A bare name in the id position is NOT resolved (the platform accepts an id or `username~name`): the SDK then falls
            // back to POST /v2/key-value-stores?name=..., which is what this mock exercises.
            if (!store) return notFound('Key-value store');
            if (method === 'GET') return send(200, { data: this.storeObject(store) });
            if (method === 'DELETE') {
                this.stores.delete(store.id);
                return send(204);
            }
        }
        if (kvRoute && kvRoute[2] === 'keys' && method === 'GET') {
            if (!store) return notFound('Key-value store');
            const limit = Math.min(Number(query.limit ?? this.maxKeysPerPage) || this.maxKeysPerPage, this.maxKeysPerPage);
            const after = query.exclusiveStartKey;
            const all = store.keys(query.prefix ?? '').filter((k) => (after === undefined || k > after) && !this.listingHides?.(k));
            const page = all.slice(0, limit);
            const isTruncated = all.length > page.length;
            return send(200, {
                data: {
                    items: page.map((k) => ({ key: k, size: store.records.get(k)?.body.length ?? 0 })),
                    count: page.length,
                    limit,
                    ...(after !== undefined ? { exclusiveStartKey: after } : {}),
                    isTruncated,
                    // The real API answers null when there is no next page; apify-client's own iterator tests `!== null`.
                    nextExclusiveStartKey: isTruncated ? (page[page.length - 1] ?? null) : null,
                },
            });
        }
        if (kvRoute && key !== undefined) {
            if (!store) return notFound('Key-value store');
            if (method === 'GET' || method === 'HEAD') {
                const found = store.records.get(key);
                if (!found) return error(404, 'record-not-found', `Record with key ${key} was not found`);
                if (override) return override();
                return write(200, { 'content-type': found.contentType, 'content-length': String(found.body.length), 'content-disposition': `attachment; filename="${key}"` }, found.body);
            }
            if (method === 'PUT') {
                const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
                store.records.set(key, { body, contentType });
                store.writes.push({ seq: entry.seq, op: 'put', key, contentType, body });
                return send(201, { data: {} });
            }
            if (method === 'DELETE') {
                // idempotent: deleting a record that is not there still answers 204
                store.records.delete(key);
                store.writes.push({ seq: entry.seq, op: 'delete', key });
                return send(204);
            }
        }

        // --- datasets -----------------------------------------------------------------------------------------------
        if (method === 'POST' && path === '/v2/datasets') {
            const name = query.name;
            const existing = name === undefined ? undefined : [...this.datasetsById.values()].find((d) => d.name === name);
            return send(201, { data: this.datasetObject(existing ?? this.createDataset(name)) });
        }
        if (datasetRoute && datasetRoute[2] === undefined && method === 'GET') {
            const dataset = this.datasetsById.get(datasetId as string);
            return dataset ? send(200, { data: this.datasetObject(dataset) }) : notFound('Dataset');
        }
        if (datasetRoute && datasetRoute[2] === '/items' && method === 'POST') {
            const dataset = this.datasetsById.get(datasetId as string);
            if (!dataset) return notFound('Dataset');
            let parsed: unknown;
            try {
                parsed = JSON.parse(body.toString('utf8'));
            } catch {
                return error(400, 'invalid-items', 'The request body is not valid JSON');
            }
            const items = Array.isArray(parsed) ? parsed : [parsed];
            if (!items.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) return error(400, 'invalid-items', 'Every dataset item must be an object');
            dataset.items.push(...(items as Array<Record<string, unknown>>));
            dataset.pushes.push(items.length);
            return send(201, { data: {} });
        }

        // --- actor runs ---------------------------------------------------------------------------------------------
        if (runRoute && runRoute[2] === '/charge' && runId !== undefined && method === 'POST') {
            let parsed: { eventName?: unknown; count?: unknown };
            try {
                parsed = JSON.parse(body.toString('utf8')) as { eventName?: unknown; count?: unknown };
            } catch {
                return error(400, 'invalid-input', 'The request body is not valid JSON');
            }
            if (typeof parsed.eventName !== 'string' || typeof parsed.count !== 'number') return error(400, 'invalid-input', 'eventName (string) and count (number) are required');
            const header = req.headers['idempotency-key'];
            const idempotencyKey = typeof header === 'string' ? header : undefined;
            const duplicate = idempotencyKey !== undefined && this.seenIdempotencyKeys.has(idempotencyKey);
            if (idempotencyKey !== undefined) this.seenIdempotencyKeys.add(idempotencyKey);
            this.charges.calls.push({ seq: entry.seq, runId, eventName: parsed.eventName, count: parsed.count, idempotencyKey, duplicate });
            return send(201, { data: {} });
        }
        if (runRoute && runRoute[2] === undefined && runId !== undefined) {
            if (method === 'GET') {
                const behaviour = this.runBehaviours.get(runId) ?? (runId === this.runId ? 'RUNNING' : 'not-found');
                if (behaviour === 'not-found') return error(404, 'record-not-found', `Run ${runId} was not found`);
                if (behaviour === 'token-not-found') return error(404, 'record-or-token-not-found', `Run ${runId} was not found or the token has no access to it`);
                if (behaviour === 403) return error(403, 'insufficient-permissions', `The token has no permission to read run ${runId}`);
                return send(200, { data: this.runRecord(runId, behaviour) });
            }
            if (method === 'PUT') {
                // Actor.exit()/fail() set the terminal status message here.
                try {
                    const parsed = JSON.parse(body.toString('utf8')) as { statusMessage?: unknown };
                    if (typeof parsed.statusMessage === 'string') this.runStatusMessages.set(runId, parsed.statusMessage);
                } catch {
                    // not JSON: ignored
                }
                return send(200, { data: this.runRecord(runId, this.currentRunStatus(runId)) });
            }
        }

        this.unhandled.push(`${method} ${url.pathname}${url.search}`);
        return error(400, 'mock-not-implemented', `The mock does not implement ${method} ${path}`);
    }
}
