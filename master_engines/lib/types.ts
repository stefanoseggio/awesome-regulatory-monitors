/**
 * Shared contracts for the three Master Engines.
 *
 * A Master Engine is a thin `main.ts` + a registry of {@link Connector}s. Every
 * connector is a port of one legacy single-source actor; the router
 * (`router_core.ts`) owns everything that must behave identically across
 * sources: source selection, per-source options, delta memory, watchlist
 * guarding, billing and failure isolation.
 */
import type { z } from 'zod';

export const ENGINE_SLUGS = [
    'global-regtech-compliance-feed',
    'latam-global-tender-intelligence',
    'global-corporate-patent-intelligence',
] as const;
export type EngineSlug = (typeof ENGINE_SLUGS)[number];

/** `all` re-emits unchanged records, `onlyChanged` = first_seen + updated, `onlyNew` = first_seen only. */
export const DELTA_MODES = ['all', 'onlyChanged', 'onlyNew'] as const;
export type DeltaMode = (typeof DELTA_MODES)[number];

export type RecordClass = 'first_seen' | 'updated' | 'unchanged';

export interface Logger {
    info(message: string): void;
    warning(message: string): void;
    error(message: string): void;
    debug(message: string): void;
}

export interface HttpRequestInit {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    /** Hard cap on the response body in bytes; exceeding it throws `HttpBodyTooLargeError` and aborts the read. */
    maxBytes?: number;
    /**
     * Opt-in manual redirect handling. Without it the platform default (follow) applies.
     * With it, every hop is resolved here and `validate` must approve the target before it is requested -
     * the only place a caller-supplied hostname can be re-checked after a 3xx.
     */
    redirects?: { max: number; validate?: (target: URL) => boolean };
    /**
     * Transport HINT: PEM CERTIFICATE blocks to ADD to the trust store for this request (never a private key).
     * The default client cannot honour it on Node's global `fetch` and logs a warning instead of ignoring it
     * silently; set `NODE_EXTRA_CA_CERTS` on the Actor process (the engine Dockerfiles do) for the same effect.
     */
    tlsExtraCaPem?: string;
}

/** Undecoded response, for portals that mislabel their charset or thread state through `Set-Cookie`. */
export interface RawHttpResponse {
    status: number;
    body: Uint8Array;
    /** Every `Set-Cookie` header of the final response, one element per header. */
    setCookies: readonly string[];
}

/** Minimal HTTP port. Connectors never call `fetch` directly so tests can inject fixtures. */
export interface HttpClient {
    getText(url: string, init?: HttpRequestInit): Promise<string>;
    getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T>;
    /** Optional. Same retry/timeout/size/redirect policy as `getText`; a non-2xx status throws exactly like `getText`. */
    getRaw?(url: string, init?: HttpRequestInit): Promise<RawHttpResponse>;
}

export interface ConnectorContext {
    http: HttpClient;
    log: Logger;
    now: () => Date;
}

/** Run-level knobs every connector receives next to its own validated options. */
export interface RunParams {
    maxItemsPerSource: number;
}

/**
 * One normalised record produced by a connector. `recordId` must be stable
 * across runs; `fingerprint` must change iff a consumer-visible field changed.
 */
export interface SourceRecord {
    recordId: string;
    fingerprint: string;
    /** Dataset row (already normalised for the engine's output schema). */
    payload: Record<string, unknown>;
    /** Free text the watchlist is matched against (respondent, vessel owner, company name...). */
    watchText?: string;
}

export type ConnectorStatus = 'active' | 'held';

export interface Connector<O = Record<string, unknown>> {
    /** Stable id used in `input.sources`, `input.sourceOptions` and the state store. */
    readonly id: string;
    readonly engine: EngineSlug;
    /** Slug of the legacy actor this connector absorbs. */
    readonly legacyActor: string;
    readonly description: string;
    readonly status: ConnectorStatus;
    /** Required when `status === 'held'`: why the source must not run. */
    readonly heldReason?: string;
    /**
     * How many record ids of this source the delta memory retains (newest first). Defaults to 5000.
     * Raise it for snapshot sources larger than the default, otherwise the oldest ids are evicted and
     * re-emit as `first_seen` on the next run.
     */
    readonly maxSeenIds?: number;
    /** Zod schema for this source's slice of `input.sourceOptions[id]`. */
    readonly optionsSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
    /** Option keys that must be present (BYOK credentials etc.); checked in preflight, before any network call. */
    readonly requiredOptions?: readonly string[];
    fetch(ctx: ConnectorContext, options: O, run: RunParams): Promise<SourceRecord[]>;
}

/** Thrown in preflight for a run-fatal configuration problem (unknown/held source, missing credential, bad option). */
export class FatalConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FatalConfigError';
    }
}

/** Thrown by a connector for an upstream failure that should only affect that source. */
export class SourceFetchError extends Error {
    constructor(
        message: string,
        readonly source: string,
    ) {
        super(message);
        this.name = 'SourceFetchError';
    }
}

export interface SourceRunSummary {
    source: string;
    fetched: number;
    emitted: number;
    firstSeen: number;
    updated: number;
    unchanged: number;
    watchlistHits: number;
    error?: string;
}

export interface RunSummary {
    engine: EngineSlug;
    deltaMode: DeltaMode;
    startedAt: string;
    finishedAt: string;
    sources: SourceRunSummary[];
    totalEmitted: number;
    watchlist: { accepted: number; rejected: number; hitsCharged: number; hitsUnpriced: number };
    stoppedOnChargeLimit: boolean;
}
