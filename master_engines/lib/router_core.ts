/**
 * router_core.ts - the one runtime every Master Engine shares.
 *
 * Responsibilities (and nothing else):
 *   1. PREFLIGHT   resolve `input.sources` against the engine's registry, refuse
 *                  unknown and `held` sources, validate each source's slice of
 *                  `input.sourceOptions`, verify required credentials - all
 *                  before a single network request or billable event.
 *   2. FETCH       call each selected connector in isolation; one source failing
 *                  never discards another source's records.
 *   3. DELTA       classify every record against persisted memory and apply the
 *                  `deltaMode` (`all` | `onlyChanged` | `onlyNew`).
 *   4. WATCHLIST   match through `_guards.ts` only; an empty/invalid watchlist
 *                  can never produce a match, hence never a billable hit.
 *   5. BILLING     emit + bill `result` atomically via the sink; bill
 *                  `watchlist-hit` through the hard-capped {@link WatchlistHitBiller}.
 *   6. STATE       persist memory after EACH source, and only for records that were
 *                  actually processed (a record cut off by the charge limit stays
 *                  "first_seen" for the next run).
 */
import { z } from 'zod';

import { clampInteger, describeSanitization, findKeywordMatch, sanitizeKeywordList } from './_guards.js';
import { type BillingPort, DEFAULT_DATASET_ITEM_EVENT, DEFAULT_HIT_BILLER_OPTIONS, hasPositivePrice, RESULT_EVENT, WATCHLIST_HIT_EVENT, WatchlistHitBiller } from './charging.js';
import { createScrubber, collectSecrets } from './secrets.js';
import { classifyRecord, type DeltaStore, effectiveMaxSeenIds, markProcessed, type ProcessedRecord } from './state.js';
import {
    type Connector,
    type ConnectorContext,
    DELTA_MODES,
    type DeltaMode,
    type EngineSlug,
    FatalConfigError,
    type RecordClass,
    type RunSummary,
    type SourceRecord,
    type SourceRunSummary,
} from './types.js';

/** A BYOK credential exposed as its own top-level (secret) input field and routed into one source's options. */
export interface CredentialField {
    source: string;
    option: string;
}

export interface EngineDefinition {
    slug: EngineSlug;
    connectors: ReadonlyArray<Connector<any>>;
    /**
     * top-level input key -> the source option it feeds. Apify only masks/encrypts a field declared `isSecret` in the
     * input schema, so credentials get their own top-level fields instead of travelling inside the free-form
     * `sourceOptions` JSON object.
     */
    credentialFields?: Readonly<Record<string, CredentialField>>;
    /** PPE events a connector can reach through `SourceRecord.billingEvent` (outside its `billing` mapping). Checked at run start. */
    extraBillingEvents?: readonly string[];
}

/**
 * Copies top-level credential fields into `sourceOptions[source][option]`. An explicit value already present in
 * `sourceOptions` wins; blank or non-string values are ignored. Pure: returns a new object.
 */
export function mergeCredentialFields(engine: EngineDefinition, rawInput: unknown): unknown {
    if (!engine.credentialFields || !rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return rawInput;
    const input = rawInput as Record<string, unknown>;
    // A malformed sourceOptions (string, array, null...) is left alone so schema validation reports it, instead of being
    // silently replaced by {} and masking the caller's mistake.
    if (input.sourceOptions !== undefined && (input.sourceOptions === null || typeof input.sourceOptions !== 'object' || Array.isArray(input.sourceOptions))) return rawInput;
    const existing = (input.sourceOptions ?? {}) as Record<string, unknown>;
    const sourceOptions: Record<string, unknown> = { ...existing };
    for (const [topKey, target] of Object.entries(engine.credentialFields)) {
        const value = input[topKey];
        if (typeof value !== 'string' || value.trim() === '') continue;
        const current = sourceOptions[target.source] && typeof sourceOptions[target.source] === 'object' ? (sourceOptions[target.source] as Record<string, unknown>) : {};
        if (current[target.option] !== undefined) continue;
        sourceOptions[target.source] = { ...current, [target.option]: value.trim() };
    }
    return { ...input, sourceOptions };
}

export const EngineInputSchema = z.object({
    /** Source ids to run (see the engine's registry). Held sources are rejected. */
    sources: z.array(z.string().min(1)).min(1, 'Select at least one source.'),
    /** Per-source options keyed by source id. Each connector validates its own slice. */
    sourceOptions: z.record(z.record(z.unknown())).default({}),
    deltaMode: z.enum(DELTA_MODES).default('onlyChanged'),
    maxItemsPerSource: z.number().int().min(1).max(10_000).default(500),
    /**
     * Deliberately `unknown`: the SEC ghost-billing bug lived in trusting this
     * field's type. It is only ever read through `sanitizeKeywordList`.
     */
    watchlistNames: z.unknown().optional(),
    maxWatchlistHitsPerRun: z.number().int().min(0).max(100_000).default(DEFAULT_HIT_BILLER_OPTIONS.maxHitsPerRun),
    maxWatchlistSpendUsd: z.number().min(0).max(10_000).default(DEFAULT_HIT_BILLER_OPTIONS.maxHitSpendUsd),
    /**
     * Isolates delta memory: two Tasks (different watchlists, filters or delta modes) must not consume each other's
     * "new" records. Read by the Apify adapter before the store is opened; the router itself never uses it.
     */
    stateNamespace: z.string().regex(/^[a-z0-9-]{1,40}$/u, 'stateNamespace must be 1-40 characters of a-z, 0-9 and "-".').optional(),
});
export type EngineInput = z.infer<typeof EngineInputSchema>;

/** Where the router sends rows and how it bills them. */
export interface RunSinks {
    /**
     * Pushes one row and bills `eventName` (default `result`) in a single step.
     * `emitted: false` means the row was NOT pushed because the budget is exhausted.
     */
    emit(row: Record<string, unknown>, eventName?: string): Promise<{ emitted: boolean; limitReached: boolean }>;
    billing: BillingPort;
    store: DeltaStore;
    saveSummary(summary: RunSummary): Promise<void>;
}

export interface ResolvedSource {
    connector: Connector<any>;
    options: Record<string, unknown>;
}

/** Normalises ids so `OFAC`, ` ofac ` and `ofac` select the same connector. */
function normaliseSourceId(id: string): string {
    return id.trim().toLowerCase();
}

/**
 * Preflight. Throws {@link FatalConfigError} on the first problem class, listing every
 * offending source so the operator fixes the input in one pass.
 */
export function resolveSources(engine: EngineDefinition, input: EngineInput): ResolvedSource[] {
    const registry = new Map(engine.connectors.map((c) => [normaliseSourceId(c.id), c]));
    const problems: string[] = [];
    const resolved: ResolvedSource[] = [];
    const seen = new Set<string>();

    for (const requested of input.sources) {
        const id = normaliseSourceId(requested);
        if (seen.has(id)) continue;
        seen.add(id);

        const connector = registry.get(id);
        if (!connector) {
            const available = engine.connectors.filter((c) => c.status === 'active').map((c) => c.id).join(', ');
            problems.push(`Unknown source "${requested}" for ${engine.slug}. Available: ${available}.`);
            continue;
        }
        if (connector.status === 'held') {
            problems.push(`Source "${connector.id}" is HELD and cannot run: ${connector.heldReason ?? 'no reason recorded'}.`);
            continue;
        }

        const rawOptions = input.sourceOptions[connector.id] ?? input.sourceOptions[requested] ?? {};
        const parsed = connector.optionsSchema.safeParse(rawOptions);
        if (!parsed.success) {
            problems.push(
                `Invalid options for "${connector.id}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}.`,
            );
            continue;
        }
        const options = parsed.data as Record<string, unknown>;

        const missing = (connector.requiredOptions ?? []).filter((key) => {
            const value = options[key];
            return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
        });
        if (missing.length > 0) {
            problems.push(`Source "${connector.id}" requires option(s): ${missing.join(', ')}.`);
            continue;
        }
        resolved.push({ connector, options });
    }

    if (problems.length > 0) throw new FatalConfigError(problems.join(' '));
    return resolved;
}

/** The PPE event billed for a delivered record of class `cls` from `connector`. */
export function billingEventFor(connector: Connector<any>, cls: RecordClass): string {
    const b = connector.billing;
    const base = b?.newEvent ?? RESULT_EVENT;
    if (cls === 'updated') return b?.updatedEvent ?? base;
    // An unchanged record re-sent by deltaMode 'all' is NOT a new delivery: bill the lower "updated" event unless the
    // connector declares a dedicated snapshot event.
    if (cls === 'unchanged') return b?.snapshotEvent ?? b?.updatedEvent ?? base;
    return base;
}

/** Whether a record of class `cls` is emitted under `mode`. */
export function shouldEmit(mode: DeltaMode, cls: RecordClass): boolean {
    if (mode === 'all') return true;
    if (mode === 'onlyChanged') return cls !== 'unchanged';
    return cls === 'first_seen';
}

export interface PricingCheck {
    /** Events this run can bill that have no own, finite, positive price (PPE runs only). They would be delivered free. */
    unpricedEvents: string[];
}

/**
 * Runtime guard on the LIVE pricing, for pay-per-event runs:
 *   - `apify-default-dataset-item` priced => `pushData(row, eventName)` bills BOTH events per row (verified in the
 *     installed SDK): refuse the run, the customer would be double-billed;
 *   - an event this run can bill that is not priced is treated as free by the SDK and reported as charged: warn and
 *     record it, so a pricing mismatch (notice window not elapsed, renamed event) is visible instead of silent.
 */
export function checkRuntimePricing(engine: EngineDefinition, selected: readonly ResolvedSource[], billing: BillingPort, watchlistActive: boolean): PricingCheck {
    if (!billing.isPayPerEvent()) return { unpricedEvents: [] };
    const prices = billing.perEventPrices();
    const priced = (name: string): boolean => hasPositivePrice(prices, name);

    if (priced(DEFAULT_DATASET_ITEM_EVENT)) {
        throw new FatalConfigError(
            `The Actor's pricing prices "${DEFAULT_DATASET_ITEM_EVENT}". With it priced, every row would be billed twice (once as itself and once as its own event). Remove that event from the pricing and run again.`,
        );
    }
    const needed = new Set<string>(engine.extraBillingEvents ?? []);
    for (const { connector } of selected) {
        for (const cls of ['first_seen', 'updated', 'unchanged'] as const) needed.add(billingEventFor(connector, cls));
    }
    if (watchlistActive) needed.add(WATCHLIST_HIT_EVENT);
    return { unpricedEvents: [...needed].filter((name) => !priced(name)).sort() };
}

interface RunDeps {
    sinks: RunSinks;
    ctx: ConnectorContext;
    /** Injected for deterministic tests. */
    clock?: () => Date;
}

/** Persist delta memory after this many emitted rows, bounding what a hard kill (timeout, OOM, migration) can re-deliver. */
export const CHECKPOINT_EVERY_ROWS = 25;

export async function runEngine(engine: EngineDefinition, rawInput: unknown, deps: RunDeps): Promise<RunSummary> {
    const { sinks } = deps;
    const clock = deps.clock ?? (() => new Date());
    const startedAt = clock().toISOString();

    const parsedInput = EngineInputSchema.safeParse(mergeCredentialFields(engine, rawInput ?? {}));
    if (!parsedInput.success) {
        throw new FatalConfigError(
            `Invalid ${engine.slug} input: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        );
    }
    const input = parsedInput.data;

    // 1. PREFLIGHT - nothing below runs if this throws.
    const selected = resolveSources(engine, input);

    // Every log line, warning and error from here on is scrubbed with the credentials of the selected sources.
    const scrub = createScrubber(selected.flatMap(({ options }) => collectSecrets(options)));
    const ctx: ConnectorContext = {
        ...deps.ctx,
        log: {
            info: (m) => deps.ctx.log.info(scrub(m)),
            warning: (m) => deps.ctx.log.warning(scrub(m)),
            error: (m) => deps.ctx.log.error(scrub(m)),
            debug: (m) => deps.ctx.log.debug(scrub(m)),
        },
    };

    // 4. WATCHLIST - sanitised exactly once, up front.
    const watchlist = sanitizeKeywordList(input.watchlistNames);
    if (input.watchlistNames !== undefined) ctx.log.info(describeSanitization(watchlist));

    // LIVE pricing check (pay-per-event runs): refuse a double-billing configuration, record unpriced events.
    const pricing = checkRuntimePricing(engine, selected, sinks.billing, watchlist.keywords.length > 0);
    if (pricing.unpricedEvents.length > 0) {
        ctx.log.warning(`Pay-per-event events with no positive price in this Actor's pricing (rows billed at them are delivered free): ${pricing.unpricedEvents.join(', ')}.`);
    }

    const biller = new WatchlistHitBiller(sinks.billing, {
        maxHitsPerRun: clampInteger(input.maxWatchlistHitsPerRun, 0, 100_000, DEFAULT_HIT_BILLER_OPTIONS.maxHitsPerRun),
        maxHitSpendUsd: input.maxWatchlistSpendUsd,
    });

    let state = await sinks.store.load();
    const sourceSummaries: SourceRunSummary[] = [];
    let totalEmitted = 0;
    let stoppedOnChargeLimit = false;

    for (const { connector, options } of selected) {
        if (stoppedOnChargeLimit) break;

        const summary: SourceRunSummary = {
            source: connector.id,
            fetched: 0,
            emitted: 0,
            firstSeen: 0,
            updated: 0,
            unchanged: 0,
            watchlistHits: 0,
            warnings: [],
        };
        sourceSummaries.push(summary);

        // Connectors report partial failures through ctx.log.warning; capture them on the summary so a
        // "one sub-source down" run is machine-visible without every connector learning a new API.
        const sourceCtx: ConnectorContext = {
            ...ctx,
            log: {
                ...ctx.log,
                warning(message: string) {
                    if (summary.warnings.length < 50) summary.warnings.push(scrub(message).slice(0, 500));
                    ctx.log.warning(message);
                },
            },
        };

        // 2. FETCH - isolated per source.
        let records: SourceRecord[];
        try {
            records = await connector.fetch(sourceCtx, options, { maxItemsPerSource: input.maxItemsPerSource });
        } catch (error) {
            summary.error = scrub(error instanceof Error ? error.message : String(error));
            ctx.log.error(`[${connector.id}] fetch failed: ${summary.error}`);
            continue;
        }
        records = dedupeById(records).slice(0, input.maxItemsPerSource);
        summary.fetched = records.length;

        // 3 + 5. DELTA, EMIT, BILL. Delta memory is checkpointed while the loop runs and once more in `finally`, so a
        // row that was already pushed and billed is remembered even if a later push throws or the run is killed.
        const processed: ProcessedRecord[] = [];
        const memoryCap = effectiveMaxSeenIds(connector.maxSeenIds, input.maxItemsPerSource, state.sources[connector.id]?.seenIds.length ?? 0);
        const persist = async (): Promise<void> => {
            if (processed.length === 0) return;
            const batch = processed.slice();
            state = markProcessed(state, connector.id, batch, clock().toISOString(), memoryCap);
            const entry = state.sources[connector.id];
            if (sinks.store.saveSource && entry) await sinks.store.saveSource(connector.id, entry);
            else await sinks.store.save(state);
            processed.splice(0, batch.length);
        };
        let sinceCheckpoint = 0;

        try {
            for (const record of records) {
                const cls = classifyRecord(state, connector.id, record.recordId, record.fingerprint);
                summary[cls === 'first_seen' ? 'firstSeen' : cls] += 1;

                if (!shouldEmit(input.deltaMode, cls)) {
                    processed.push({ recordId: record.recordId, fingerprint: record.fingerprint });
                    continue;
                }

                const matchedKeyword = findKeywordMatch(record.watchText, watchlist);
                const row: Record<string, unknown> = {
                    ...record.payload,
                    engine: engine.slug,
                    source: connector.id,
                    record_id: record.recordId,
                    delta_status: cls,
                    is_new: cls === 'first_seen',
                    is_watchlist_match: matchedKeyword !== null,
                    matched_watchlist_keyword: matchedKeyword,
                    scraped_at: clock().toISOString(),
                };

                const emission = await sinks.emit(row, record.billingEvent ?? billingEventFor(connector, cls));
                if (!emission.emitted) {
                    stoppedOnChargeLimit = true;
                    ctx.log.info(`[${connector.id}] charge limit reached before record ${record.recordId}; stopping.`);
                    break;
                }
                summary.emitted += 1;
                totalEmitted += 1;
                processed.push({ recordId: record.recordId, fingerprint: record.fingerprint });

                if (matchedKeyword !== null) {
                    summary.watchlistHits += 1;
                    // At the budget limit the SDK would "overcharge by one" to terminate the Actor: never spend that
                    // extra event on a hit. The hit stays flagged on the row; it is just not billed.
                    if (!emission.limitReached) {
                        const outcome = await biller.chargeHit();
                        if (outcome === 'limit_reached') {
                            stoppedOnChargeLimit = true;
                            ctx.log.info(`[${connector.id}] watchlist-hit charge limit reached; stopping.`);
                            break;
                        }
                    }
                }
                if (emission.limitReached) {
                    stoppedOnChargeLimit = true;
                    break;
                }
                sinceCheckpoint += 1;
                if (sinceCheckpoint >= CHECKPOINT_EVERY_ROWS) {
                    sinceCheckpoint = 0;
                    await persist();
                }
            }
        } finally {
            // 6. STATE - whatever was actually processed. A failure to save must not mask the error that got us here.
            try {
                await persist();
            } catch (saveError) {
                ctx.log.error(`[${connector.id}] could not persist delta memory: ${scrub(saveError instanceof Error ? saveError.message : String(saveError))}`);
            }
        }
    }

    const summary: RunSummary = {
        engine: engine.slug,
        deltaMode: input.deltaMode,
        startedAt,
        finishedAt: clock().toISOString(),
        sources: sourceSummaries,
        totalEmitted,
        watchlist: {
            accepted: watchlist.keywords.length,
            rejected: watchlist.rejected.length,
            hitsCharged: biller.charged,
            hitsUnpriced: biller.hitsUnpriced,
        },
        pricing,
        stoppedOnChargeLimit,
    };
    await sinks.saveSummary(summary);
    return summary;
}

/**
 * True when the run selected at least one source, EVERY selected source failed its fetch, and nothing was delivered.
 * Such a run has produced nothing a consumer can use and must end FAILED (so schedulers, integrations and alerting
 * see it) instead of SUCCEEDED with an empty dataset. A run in which at least one source answered, even with zero
 * records, is a normal run: per-source errors stay isolated on `RUN_SUMMARY.sources[].error`.
 */
export function allSourcesFailed(summary: RunSummary): boolean {
    return summary.sources.length > 0 && summary.totalEmitted === 0 && summary.sources.every((source) => source.error !== undefined);
}

/** One line per failed source, for the FAILED status message. Messages are already credential-scrubbed by the router. */
export function describeSourceFailures(summary: RunSummary): string {
    const failures = summary.sources.filter((source) => source.error !== undefined).map((source) => `${source.source}: ${source.error}`);
    return `All ${failures.length} selected source(s) failed and nothing was delivered. ${failures.join(' | ')}`.slice(0, 2000);
}

function dedupeById(records: SourceRecord[]): SourceRecord[] {
    const seen = new Set<string>();
    const out: SourceRecord[] = [];
    for (const record of records) {
        if (seen.has(record.recordId)) continue;
        seen.add(record.recordId);
        out.push(record);
    }
    return out;
}
