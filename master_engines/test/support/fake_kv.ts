import type { KeyValueLike } from '../../lib/apify_adapters.js';

/** What apify-client throws for a record whose body is declared JSON but is not (a truncated record). */
export class InvalidResponseBodyError extends Error {
    readonly code = 'invalid-response-body';
    constructor() {
        super('Response body could not be parsed.\nCause: Unexpected end of JSON input');
        this.name = 'InvalidResponseBodyError';
    }
}

/**
 * An in-memory key-value store that behaves like the PLATFORM client, not like local storage: it has no `keys()` (apify-client's
 * `KeyValueStoreClient` only has `listKeys`, which `forEachKey` pages through), `setValue(key, null)` deletes, and a record put
 * with {@link putUnparsable} makes `getValue` throw `InvalidResponseBodyError`, as the platform client does for truncated JSON.
 */
export class PlatformLikeKv implements KeyValueLike {
    readonly data = new Map<string, unknown>();
    private readonly unparsable = new Set<string>();
    /** Raw reads (`buffer: true`) of records, the way the adapters read them; `reads` counts them. */
    readonly rawReads: string[] = [];
    readonly client = {
        getRecord: async (key: string, options: { buffer?: boolean } = {}): Promise<{ value: unknown; contentType?: string } | undefined> => {
            if (!this.data.has(key)) return undefined;
            const body = this.unparsable.has(key) ? String(this.data.get(key)) : JSON.stringify(this.data.get(key));
            if (options.buffer) {
                this.rawReads.push(key);
                return { value: Buffer.from(body, 'utf8'), contentType: 'application/json; charset=utf-8' };
            }
            // what the client does without `buffer`: parse, and throw on a body that is not JSON
            if (this.unparsable.has(key)) throw new InvalidResponseBodyError();
            return { value: JSON.parse(body) as unknown, contentType: 'application/json; charset=utf-8' };
        },
    };

    async forEachKey(iteratee: (key: string) => void | Promise<void>, options: { prefix?: string } = {}): Promise<void> {
        for (const key of [...this.data.keys()].sort()) {
            if (options.prefix === undefined || key.startsWith(options.prefix)) await iteratee(key);
        }
    }

    async getValue(key: string): Promise<unknown> {
        const record = await this.client.getRecord(key);
        return record?.value ?? null;
    }

    async setValue(key: string, value: unknown): Promise<void> {
        this.unparsable.delete(key);
        // Same contract as a key-value store: `null` deletes the record.
        if (value === null) this.data.delete(key);
        else this.data.set(key, structuredClone(value));
    }

    /** Test hook: a record that exists but whose body cannot be parsed. */
    putUnparsable(key: string): void {
        this.data.set(key, '{"seenIds":[');
        this.unparsable.add(key);
    }
}
