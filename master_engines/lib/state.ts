/**
 * Delta memory shared by all three engines.
 *
 * One JSON document per engine (stored by the Apify adapter in a named
 * key-value store so it survives across scheduled runs), keyed per source id.
 * Per source we keep:
 *   - `seenIds`      newest-first, capped, the "have we ever emitted this id" memory
 *   - `fingerprints` id -> fingerprint, pruned to exactly the ids still in `seenIds`
 *
 * Classification:
 *   first_seen  id not in memory
 *   updated     id in memory, fingerprint differs
 *   unchanged   id in memory, fingerprint identical
 */
import type { RecordClass } from './types.js';

export const DEFAULT_MAX_SEEN_IDS_PER_SOURCE = 5000;
/** Absolute ceiling for an automatically sized memory, so a source cannot grow its state document without bound. */
export const MAX_SEEN_IDS_HARD_CEILING = 50_000;

/**
 * How many ids a source's delta memory must retain.
 *   - A connector that declares `maxSeenIds` is authoritative.
 *   - Otherwise the memory is never smaller than what one run may deliver (`maxItemsPerSource`), nor than what it
 *     already holds (so a run with a small limit cannot silently shrink it), capped at the hard ceiling. Anything
 *     smaller evicts ids the run just processed and re-emits - and re-bills - them as first_seen next run.
 */
export function effectiveMaxSeenIds(connectorCap: number | undefined, maxItemsPerSource: number, previousLength: number): number {
    if (connectorCap !== undefined) return Math.max(1, connectorCap);
    return Math.min(MAX_SEEN_IDS_HARD_CEILING, Math.max(DEFAULT_MAX_SEEN_IDS_PER_SOURCE, maxItemsPerSource, previousLength));
}

export interface SourceDeltaState {
    /** Newest first. */
    seenIds: string[];
    fingerprints: Record<string, string>;
    lastRunAt: string;
}

export interface DeltaState {
    version: 2;
    sources: Record<string, SourceDeltaState>;
}

/** Persistence port. The Apify implementation lives in `apify_adapters.ts`; tests use {@link InMemoryDeltaStore}. */
export interface DeltaStore {
    load(): Promise<DeltaState>;
    save(state: DeltaState): Promise<void>;
    /**
     * Optional. Persists ONE source's memory without rewriting the others. Stores that implement it avoid the
     * read-modify-write race between overlapping runs of the same engine (the whole-document `save` would write back
     * every other source as it was when this run started and erase a concurrent run's progress).
     */
    saveSource?(source: string, entry: SourceDeltaState): Promise<void>;
}

export function createEmptyState(): DeltaState {
    return { version: 2, sources: {} };
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/** Validates a persisted blob. Anything malformed becomes an empty state (never throws, never half-loads). */
export function parseState(value: unknown): DeltaState {
    if (!value || typeof value !== 'object') return createEmptyState();
    const candidate = value as { version?: unknown; sources?: unknown };
    if (candidate.version !== 2 || !candidate.sources || typeof candidate.sources !== 'object') return createEmptyState();

    const sources: Record<string, SourceDeltaState> = {};
    for (const [source, raw] of Object.entries(candidate.sources as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Partial<SourceDeltaState>;
        if (!Array.isArray(s.seenIds) || !s.seenIds.every((id) => typeof id === 'string')) continue;
        if (!isRecordOfStrings(s.fingerprints)) continue;
        sources[source] = {
            seenIds: s.seenIds,
            fingerprints: s.fingerprints,
            lastRunAt: typeof s.lastRunAt === 'string' ? s.lastRunAt : '',
        };
    }
    return { version: 2, sources };
}

export function classifyRecord(state: DeltaState, source: string, recordId: string, fingerprint: string): RecordClass {
    const s = state.sources[source];
    // Own-property check: a record id such as 'constructor' or 'toString' must not resolve to an inherited member.
    if (!s || !Object.prototype.hasOwnProperty.call(s.fingerprints, recordId)) return 'first_seen';
    return s.fingerprints[recordId] === fingerprint ? 'unchanged' : 'updated';
}

export interface ProcessedRecord {
    recordId: string;
    fingerprint: string;
}

/**
 * Folds the records this run actually PROCESSED into memory (returns a new state).
 *
 * Callers must pass only records that were emitted or deliberately skipped by the
 * delta mode. A record that was fetched but never reached (run aborted on the
 * charge limit, for example) must NOT be passed, otherwise it would be classified
 * `unchanged` next run and silently lost.
 */
export function markProcessed(
    state: DeltaState,
    source: string,
    processed: readonly ProcessedRecord[],
    runAt: string,
    maxSeenIds: number = DEFAULT_MAX_SEEN_IDS_PER_SOURCE,
): DeltaState {
    const previous = state.sources[source] ?? { seenIds: [], fingerprints: {}, lastRunAt: '' };

    const thisRunIds: string[] = [];
    const thisRunSet = new Set<string>();
    // Null-prototype dictionaries: record ids come from upstream and may be '__proto__' or 'constructor'.
    const fingerprints: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, previous.fingerprints);
    for (const item of processed) {
        fingerprints[item.recordId] = item.fingerprint;
        if (!thisRunSet.has(item.recordId)) {
            thisRunSet.add(item.recordId);
            thisRunIds.push(item.recordId);
        }
    }

    const merged = [...thisRunIds, ...previous.seenIds.filter((id) => !thisRunSet.has(id))].slice(0, Math.max(1, maxSeenIds));
    const retained = new Set(merged);
    const pruned: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const id of merged) {
        const fp = fingerprints[id];
        if (fp !== undefined && retained.has(id)) pruned[id] = fp;
    }

    return {
        version: 2,
        sources: { ...state.sources, [source]: { seenIds: merged, fingerprints: pruned, lastRunAt: runAt } },
    };
}

export class InMemoryDeltaStore implements DeltaStore {
    private snapshot: DeltaState;
    saves = 0;

    constructor(initial: DeltaState = createEmptyState()) {
        this.snapshot = initial;
    }

    async load(): Promise<DeltaState> {
        return structuredClone(this.snapshot);
    }

    async save(state: DeltaState): Promise<void> {
        this.snapshot = structuredClone(state);
        this.saves += 1;
    }

    peek(): DeltaState {
        return structuredClone(this.snapshot);
    }
}

const NAMESPACE_PATTERN = /^[a-z0-9-]{1,40}$/u;

/**
 * Which delta-memory namespace a run uses. Two Tasks with different watchlists, filters or delta modes must not share
 * memory (one would consume the other's "new" records), so:
 *   1. an explicit `stateNamespace` input wins (validated);
 *   2. otherwise a run started from a Task gets `task-<task id>`;
 *   3. otherwise `default` (ad-hoc API/console runs share one memory, as a single-schedule setup expects).
 * Throws an Error with a user-facing message for an invalid explicit value.
 */
export function resolveStateNamespace(rawInput: unknown, taskId: string | undefined): string {
    const explicit = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>).stateNamespace : undefined;
    if (explicit !== undefined && explicit !== null && explicit !== '') {
        if (typeof explicit !== 'string' || !NAMESPACE_PATTERN.test(explicit)) throw new Error('stateNamespace must be 1-40 characters of a-z, 0-9 and "-".');
        return explicit;
    }
    const cleaned = (taskId ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 34);
    return cleaned === '' ? 'default' : `task-${cleaned}`;
}
