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

    async forEachKey(iteratee: (key: string) => void | Promise<void>, options: { prefix?: string } = {}): Promise<void> {
        for (const key of [...this.data.keys()].sort()) {
            if (options.prefix === undefined || key.startsWith(options.prefix)) await iteratee(key);
        }
    }

    async getValue(key: string): Promise<unknown> {
        if (this.unparsable.has(key)) throw new InvalidResponseBodyError();
        return structuredClone(this.data.get(key));
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
