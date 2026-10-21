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
    /**
     * Minimum delay before retrying a retryable response, in ms (a published rate-limit floor such as USPTO ODP's
     * "at least 5 second delay"). A `Retry-After` header larger than the back-off schedule also wins, capped at 120 s.
     */
    minRetryDelayMs?: number;
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
     * silently; set `NODE_EXTRA_CA_CERTS` on the Actor process for the same effect (no engine image currently needs it).
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
    /** Optional injectable delay for connectors that pace their own requests (robots.txt Crawl-delay). Tests inject a no-op. */
    sleep?: (ms: number) => Promise<void>;
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
    /**
     * Overrides the PPE event for this one record (e.g. a listing-only summary row that is cheaper than a
     * full-detail row). Takes precedence over the connector's `billing` mapping; must exist in the engine's pricing.
     */
    billingEvent?: string;
}

export type ConnectorStatus = 'active' | 'held';

export interface ConnectorBilling {
    /** Event for a `first_seen` record (default `result`). */
    newEvent?: string;
    /** Event for an `updated` record (default: `newEvent`). */
    updatedEvent?: string;
    /** Event for an `unchanged` record re-emitted by `deltaMode: all` (default: `newEvent`). */
    snapshotEvent?: string;
}

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
     * PPE event billed per delivered record, by delta class. Anything omitted falls back to `newEvent`, then to
     * `result`. This lets a consolidated engine keep each legacy actor's own price (e.g. $0.0005 for an OFAC
     * vessel vs $0.05 for an SEC release) instead of forcing one blended price on every source.
     */
    readonly billing?: ConnectorBilling;
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
    /** Non-fatal problems the connector logged while it still returned records (one sub-source down, a throttled stop...). */
    warnings: string[];
    error?: string;
}

export interface RunSummary {
    engine: EngineSlug;
    deltaMode: DeltaMode;
    startedAt: string;
    finishedAt: string;
    sources: SourceRunSummary[];
    totalEmitted: number;
    watchlist: {
        accepted: number;
        rejected: number;
        hitsCharged: number;
        hitsUnpriced: number;
        /** Matched rows whose hit was not billed because a per-run cap (hits or USD) or the spending limit was reached. */
        hitsCapped: number;
    };
    /** Live-pricing check for pay-per-event runs: events this run can bill that have no positive price. */
    pricing: { unpricedEvents: string[] };
    stoppedOnChargeLimit: boolean;
}
