/**
 * chaos_platform.ts - a simulated Apify platform for test/stress.atomicity_chaos.test.ts.
 *
 * It owns everything the router talks to, so a fault can be injected at the exact instant a real platform could fail:
 *
 *   - a DATASET (`dataset`): one entry per row that was durably pushed, with `charged` telling whether the pay-per-event
 *     charge that belongs to that push went through;
 *   - the per-event CHARGE LEDGER (`ledger`) and a per-attempt copy (`AttemptStats`): only charges that were durably
 *     honoured count, exactly like the platform's own counters;
 *   - a KEY-VALUE STORE: state records (`state.<ns>.<source>`) and delivery journals (`journal.<ns>.<source>`). The router
 *     is given the REAL `ApifyDeltaStore` on top of it, so key naming, JSON serialisation, `null` meaning "delete" and the
 *     `parseState` / `parseJournal` validators are the production ones, and the DeltaStore interface (load, save,
 *     saveSource, loadJournal, saveJournal) is honoured by construction;
 *   - a seeded PRNG (mulberry32) and a FAULT SCHEDULE: one attempt is one run of the Actor; the campaign arms at most one
 *     {@link Fault} per attempt, directed tests may arm several (each fires at most once).
 *
 * `emit` mimics the real SDK `Actor.pushData(row, event)` (node_modules/apify/dist/charging.js, pushDataAndCharge): it
 * decides from the remaining budget whether the row may be pushed, PUSHES it, and only THEN charges the event, then
 * answers `{ emitted, limitReached }`. The budget rules are the SDK's, not a simplification: a row is trimmed away only
 * when the run is already STRICTLY over budget; when the budget is used up but not exceeded, the SDK pushes and charges
 * ONE more row on purpose ("so the Platform terminates the run") and reports `limitReached`. The same overcharge-by-one
 * applies to `billing.charge` (the `watchlist-hit` path). Money is kept in integer micro-USD so no float drift can trip
 * a limit one event early.
 *
 * OUT-OF-BAND SPEND. The SDK seeds its charging state at init from the charges the platform already holds for the run
 * (`chargedEventCounts`: the Actor-start event, a resumed run's earlier charges), and all of it counts against the budget.
 * `beginAttempt(..., outOfBandMicro)` models that: the router never made those charges, yet the budget is already (partly or
 * wholly) spent when its first row arrives. Without it a row is TRIMMED (`emitted: false`) only if the router keeps going
 * after a limit signal: every in-run charge that exhausts the budget also reports `limitReached`, after which a correct
 * router stops by itself, so out-of-band spend is what puts the trim path under test.
 *
 * HARD KILL. A real kill cannot run `finally` blocks. A kill is modelled as `killed = true` plus a thrown
 * {@link KillSignal}; from that instant EVERY write the platform receives (dataset push, charge, key-value set) is silently
 * discarded, so the router's `finally`-block checkpoint cannot save anything. Because the router's own `finally`
 * swallows errors raised while persisting, a KillSignal can be absorbed there and `runEngine` can still return: the
 * harness therefore decides "killed" from `platform.killed`, never from how `runEngine` ended. The next attempt
 * (`beginAttempt`) starts with `killed = false` and with only what was durably written before the kill.
 */
import { ApifyDeltaStore, type KeyValueLike } from '../../lib/apify_adapters.js';
import { type BillingPort, type PortChargeResult, WATCHLIST_HIT_EVENT } from '../../lib/charging.js';
import type { RunSinks } from '../../lib/router_core.js';
import type { DeltaStore, ProcessedRecord } from '../../lib/state.js';
import type { RunSummary } from '../../lib/types.js';

export const CHAOS_STORE_NAME = 'chaos-delta-state';
export const CHAOS_NAMESPACE = 'default';

const MICRO = 1_000_000;
/** USD to integer micro-USD. */
export const toMicro = (usd: number): number => Math.round(usd * MICRO);

/** mulberry32: a small, well-mixed, fully deterministic 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export class SeededRandom {
    private readonly next: () => number;

    constructor(readonly seed: number) {
        this.next = mulberry32(seed);
    }

    /** A float in [0, 1). */
    float(): number {
        return this.next();
    }

    /** An integer in [min, max], both inclusive. */
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    chance(probability: number): boolean {
        return this.next() < probability;
    }

    pick<T>(items: readonly T[]): T {
        const item = items[Math.floor(this.next() * items.length)];
        if (item === undefined) throw new Error('SeededRandom.pick on an empty list');
        return item;
    }
}

/** Thrown into the router when the simulated process is hard-killed. Nothing after it can reach the platform. */
export class KillSignal extends Error {
    constructor(readonly point: string) {
        super(`chaos: hard kill at ${point}`);
        this.name = 'KillSignal';
    }
}

/** A platform error (HTTP 5xx, timeout) the router sees as an ordinary exception. */
export class PlatformFault extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlatformFault';
    }
}

/**
 * The faults, grouped by the kind of operation they hang on. `position` counts that kind of operation inside one attempt.
 *   emit     push_fail             throw before the row is pushed
 *            charge_fail           row pushed, then throw before it is charged
 *            kill_before_push      hard kill before the row is pushed
 *            kill_before_charge    row pushed, hard kill before it is charged
 *            kill_after_charge     row pushed AND charged, hard kill before the journal write
 *   journal  kv_journal_write_fail a journal write throws (applied or lost, see `applied`)
 *            kill_after_journal    journal written, hard kill before the watchlist-hit charge
 *   state    kv_state_write_fail   a full checkpoint write throws (applied or lost)
 *            kill_after_state_write checkpoint written, hard kill before the journal is cleared
 *   hit      hit_charge_fail       the watchlist-hit charge throws (applied or lost)
 *            kill_after_hit_charge watchlist-hit charged, hard kill
 */
export const FAULT_KINDS = [
    'push_fail',
    'charge_fail',
    'kill_before_push',
    'kill_before_charge',
    'kill_after_charge',
    'kill_after_journal',
    'kv_state_write_fail',
    'kill_after_state_write',
    'kv_journal_write_fail',
    'hit_charge_fail',
    'kill_after_hit_charge',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const KILL_KINDS: readonly FaultKind[] = FAULT_KINDS.filter((kind) => kind.startsWith('kill_'));

export type OpClass = 'emit' | 'journal' | 'state' | 'hit';

export const FAULT_OP_CLASS: Readonly<Record<FaultKind, OpClass>> = {
    push_fail: 'emit',
    charge_fail: 'emit',
    kill_before_push: 'emit',
    kill_before_charge: 'emit',
    kill_after_charge: 'emit',
    kill_after_journal: 'journal',
    kv_journal_write_fail: 'journal',
    kv_state_write_fail: 'state',
    kill_after_state_write: 'state',
    hit_charge_fail: 'hit',
    kill_after_hit_charge: 'hit',
};

export interface Fault {
    kind: FaultKind;
    /** 1-based index, inside one attempt, of the operation (of the fault's class) the fault fires on. */
    position: number;
    /** `hit_row` (journal faults only): count only journal writes that directly follow a watchlist-matching row. */
    target: 'any' | 'hit_row';
    /** For a failing write or charge: whether the operation took effect before the error was reported (a lost ack). */
    applied: boolean;
}

export function describeFault(fault: Fault): string {
    const flags = `${fault.target === 'hit_row' ? '/hit-row' : ''}${fault.kind.endsWith('_fail') && FAULT_OP_CLASS[fault.kind] !== 'emit' ? (fault.applied ? '/applied' : '/lost') : ''}`;
    return `${fault.kind}@${fault.position}${flags}`;
}

export interface DatasetEntry {
    record_id: string;
    event: string;
    /** True once the charge that belongs to this push went through. */
    charged: boolean;
    attempt: number;
    /** What `emit` answered for this push: the platform signalled that the budget is used up. */
    limitReachedAfter: boolean;
    /** The pushed row exactly as the router built it. */
    row: Readonly<Record<string, unknown>>;
}

export interface ArmedFault {
    fault: Fault;
    fired: boolean;
    /** Where the fault fired, for the trace. */
    firedAt: string;
}

export interface AttemptStats {
    attempt: number;
    /** The first armed fault (the campaign arms exactly one per attempt). */
    fault: Fault | null;
    /** Whether the first armed fault fired. */
    fired: boolean;
    firedAt: string;
    /** Every armed fault of the attempt with its own outcome (directed tests may arm several). */
    faults: ArmedFault[];
    pushes: number;
    /** Charges durably honoured in this attempt, per event. */
    chargesByEvent: Map<string, number>;
    budgetMicro: number | null;
    /** Spend that counted against the budget before the router's first call (see the header), never charged by the router. */
    outOfBandMicro: number;
    /** Micro-USD charged by the router's own honoured calls in this attempt (out-of-band spend not included). */
    spentMicro: number;
    /** Micro-USD of the most recent honoured charge. */
    lastChargeMicro: number;
    /** Billable calls (emit / charge) made after the platform had already signalled the budget limit. */
    callsAfterLimit: number;
    /** Billable calls (emit / charge) that reached the platform after the kill: a dead process makes none, so this is a simulation self-check. */
    callsAfterKill: number;
    /** Key-value writes the platform silently discarded after the kill (the router's `finally` checkpoint trying to save). */
    discardedWrites: number;
    /** The most entries the router ever tried to put into one delivery-journal write (clears excluded): the journal must stay one checkpoint window long. */
    maxJournalEntries: number;
    limitSignalled: boolean;
}

interface OpCounters {
    emit: number;
    journal: number;
    journalHitRow: number;
    state: number;
    hit: number;
}

function freshStats(attempt: number, faults: readonly Fault[], budgetMicro: number | null, outOfBandMicro: number): AttemptStats {
    return {
        attempt,
        fault: faults[0] ?? null,
        fired: false,
        firedAt: '',
        faults: [],
        pushes: 0,
        chargesByEvent: new Map(),
        budgetMicro,
        outOfBandMicro,
        spentMicro: 0,
        lastChargeMicro: 0,
        callsAfterLimit: 0,
        callsAfterKill: 0,
        discardedWrites: 0,
        maxJournalEntries: 0,
        limitSignalled: false,
    };
}

export interface ChaosPlatformOptions {
    seed: number;
    /** USD per event (the pay-per-event pricing). Every event the router can bill must be listed. */
    prices: Readonly<Record<string, number>>;
}

export class ChaosPlatform {
    readonly rng: SeededRandom;
    readonly dataset: DatasetEntry[] = [];
    /** Durable charge counters per event, the platform's own books. */
    readonly ledger = new Map<string, number>();
    readonly attemptStats: AttemptStats[] = [];
    /** The RUN_SUMMARY the router stored, per attempt (a killed process stores none). */
    readonly summaries = new Map<number, RunSummary>();
    readonly billing: BillingPort;
    killed = false;

    private readonly kv = new Map<string, string>();
    private readonly keyValue: KeyValueLike;
    private readonly pricesUsd: Readonly<Record<string, number>>;
    private attempt = -1;
    private actives: ArmedFault[] = [];
    private budgetMicro: number | null = null;
    private limitSignalled = false;
    private lastPushed: DatasetEntry | null = null;
    private ops: OpCounters = { emit: 0, journal: 0, journalHitRow: 0, state: 0, hit: 0 };
    private stats: AttemptStats = freshStats(-1, [], null, 0);

    constructor(options: ChaosPlatformOptions) {
        this.rng = new SeededRandom(options.seed);
        this.pricesUsd = options.prices;
        this.keyValue = {
            // forEachKey, not keys(): the platform's key-value client has no keys() (see KeyValueLike)
            forEachKey: async (iteratee, listing = {}) => {
                for (const key of [...this.kv.keys()].sort()) if (listing.prefix === undefined || key.startsWith(listing.prefix)) await iteratee(key);
            },
            getValue: async (key) => {
                const raw = this.kv.get(key);
                return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
            },
            setValue: (key, value) => this.kvSet(key, value),
        };
        this.billing = {
            isPayPerEvent: () => true,
            perEventPrices: () => this.pricesUsd,
            charge: (eventName, count) => this.billingCharge(eventName, count),
        };
    }

    /**
     * Starts one run of the Actor. Everything volatile is reset (a new process); everything durable (dataset, ledger,
     * key-value store) is kept. `budgetMicro` is this run's maximum total charge (the platform applies it per run);
     * `outOfBandMicro` is spend the platform had already booked against that budget when the process started.
     */
    beginAttempt(attempt: number, fault: Fault | readonly Fault[] | null, budgetMicro: number | null, outOfBandMicro: number = 0): void {
        const faults: readonly Fault[] = fault === null ? [] : 'kind' in fault ? [fault] : fault;
        this.attempt = attempt;
        this.killed = false;
        this.actives = faults.map((armed) => ({ fault: armed, fired: false, firedAt: '' }));
        this.budgetMicro = budgetMicro;
        this.limitSignalled = false;
        this.lastPushed = null;
        this.ops = { emit: 0, journal: 0, journalHitRow: 0, state: 0, hit: 0 };
        this.stats = freshStats(attempt, faults, budgetMicro, outOfBandMicro);
    }

    endAttempt(): AttemptStats {
        const stats = this.stats;
        stats.faults = this.actives.map((armed) => ({ ...armed }));
        stats.fired = this.actives[0]?.fired ?? false;
        stats.firedAt = this.actives[0]?.firedAt ?? '';
        stats.limitSignalled = this.limitSignalled;
        this.attemptStats.push(stats);
        return stats;
    }

    /** A fresh store handle on the shared key-value store: what a newly started process would open. */
    openStore(): ApifyDeltaStore {
        return new ApifyDeltaStore(CHAOS_STORE_NAME, CHAOS_NAMESPACE, async () => this.keyValue);
    }

    sinks(store: DeltaStore = this.openStore()): RunSinks {
        return {
            emit: (row, eventName) => this.emit(row, eventName),
            billing: this.billing,
            store,
            saveSummary: async (summary) => {
                if (!this.killed) this.summaries.set(this.attempt, summary);
            },
        };
    }

    /** What the SDK's `pushData(row, event)` does: decide from the budget, PUSH, then CHARGE, then report. */
    async emit(row: Record<string, unknown>, eventName: string = 'result'): Promise<{ emitted: boolean; limitReached: boolean }> {
        if (this.killed) {
            this.stats.callsAfterKill += 1;
            return { emitted: true, limitReached: false };
        }
        this.ops.emit += 1;
        const position = this.ops.emit;
        const recordId = String(row.record_id);
        if (this.limitSignalled) this.stats.callsAfterLimit += 1;
        const due = this.due('emit');
        const dueKind = due?.fault.kind;

        if (due && dueKind === 'push_fail') {
            this.fire(due, `emit #${position} (${recordId})`);
            throw new PlatformFault('dataset push failed (HTTP 500) before the row was stored');
        }
        if (due && dueKind === 'kill_before_push') {
            this.fire(due, `emit #${position} (${recordId})`);
            this.kill('before the push');
        }

        const priceMicro = this.priceMicro(eventName);
        const maxCharged = this.maxCharges(priceMicro);
        // calculatePushDataLimits: keep the row when the budget allows it; when the budget is used up but not exceeded,
        // keep ONE row anyway (overcharge by one); once strictly over budget, trim it away.
        const keep = maxCharged >= 1 || this.budgetMicro === null || this.totalSpentMicro() <= this.budgetMicro;
        if (!keep) {
            this.limitSignalled = true;
            return { emitted: false, limitReached: true };
        }

        const entry: DatasetEntry = { record_id: recordId, event: eventName, charged: false, attempt: this.attempt, limitReachedAfter: false, row: { ...row } };
        this.dataset.push(entry);
        this.stats.pushes += 1;
        this.lastPushed = entry;

        if (due && dueKind === 'charge_fail') {
            this.fire(due, `emit #${position} (${recordId})`);
            throw new PlatformFault('charge API failed (HTTP 500) after the row was stored');
        }
        if (due && dueKind === 'kill_before_charge') {
            this.fire(due, `emit #${position} (${recordId})`);
            this.kill('between the push and its charge');
        }

        this.commitCharge(eventName, 1, priceMicro);
        entry.charged = true;
        const limitReached = this.maxCharges(priceMicro) <= 0;
        entry.limitReachedAfter = limitReached;
        if (limitReached) this.limitSignalled = true;

        if (due && dueKind === 'kill_after_charge') {
            this.fire(due, `emit #${position} (${recordId})`);
            this.kill('after the charge, before the journal write');
        }
        return { emitted: true, limitReached };
    }

    /** Durable view of one source's memory the way the router will recover it: the state record with the journal folded in. */
    durableFingerprints(source: string): Map<string, string> {
        const memory = new Map<string, string>();
        const rawState = this.kv.get(`state.${CHAOS_NAMESPACE}.${source}`);
        if (rawState !== undefined) {
            const parsed = JSON.parse(rawState) as { fingerprints?: Record<string, string> };
            for (const [id, fingerprint] of Object.entries(parsed.fingerprints ?? {})) memory.set(id, fingerprint);
        }
        for (const entry of this.durableJournal(source)) memory.set(entry.recordId, entry.fingerprint);
        return memory;
    }

    durableJournal(source: string): ProcessedRecord[] {
        const raw = this.kv.get(`journal.${CHAOS_NAMESPACE}.${source}`);
        return raw === undefined ? [] : (JSON.parse(raw) as ProcessedRecord[]);
    }

    durableKeys(): string[] {
        return [...this.kv.keys()].sort();
    }

    private async kvSet(key: string, value: unknown): Promise<void> {
        if (this.killed) {
            this.stats.discardedWrites += 1;
            return;
        }
        const clear = value === null;
        const apply = (): void => {
            if (clear) this.kv.delete(key);
            else this.kv.set(key, JSON.stringify(value));
        };
        let due: ArmedFault | null = null;
        if (key.startsWith('journal.')) {
            this.ops.journal += 1;
            if (Array.isArray(value)) this.stats.maxJournalEntries = Math.max(this.stats.maxJournalEntries, value.length);
            const qualifies = !clear && this.lastPushed?.row.is_watchlist_match === true;
            if (qualifies) this.ops.journalHitRow += 1;
            due = this.due('journal', qualifies);
        } else if (key.startsWith('state.')) {
            this.ops.state += 1;
            due = this.due('state');
        }
        if (due === null) {
            apply();
            return;
        }
        const detail = `${key.startsWith('journal.') ? 'journal' : 'state'} write #${key.startsWith('journal.') ? this.ops.journal : this.ops.state}${clear ? ' (clear)' : ''}`;
        if (due.fault.kind === 'kv_journal_write_fail' || due.fault.kind === 'kv_state_write_fail') {
            this.fire(due, detail);
            if (due.fault.applied) apply();
            throw new PlatformFault(`key-value store write failed (HTTP 500): ${key}`);
        }
        // kill_after_journal / kill_after_state_write: the write lands, then the process dies.
        apply();
        this.fire(due, detail);
        this.kill('after the write');
    }

    /** The SDK's `ChargingManager.charge`, with the faults of the watchlist-hit path. */
    private async billingCharge(eventName: string, count: number): Promise<PortChargeResult> {
        if (this.killed) {
            this.stats.callsAfterKill += 1;
            return { chargedCount: count, eventChargeLimitReached: false };
        }
        if (this.limitSignalled) this.stats.callsAfterLimit += 1;
        let due: ArmedFault | null = null;
        if (eventName === WATCHLIST_HIT_EVENT) {
            this.ops.hit += 1;
            due = this.due('hit');
        }
        if (due && due.fault.kind === 'hit_charge_fail' && !due.fault.applied) {
            this.fire(due, `hit charge #${this.ops.hit}`);
            throw new PlatformFault('charge API failed (HTTP 500) before the watchlist-hit was charged');
        }

        const priceMicro = this.priceMicro(eventName);
        const maxCount = this.maxCharges(priceMicro);
        let chargedCount: number;
        if (count <= maxCount) chargedCount = count;
        else if (this.budgetMicro === null || this.totalSpentMicro() <= this.budgetMicro) chargedCount = maxCount + 1; // overcharge by one
        else chargedCount = 0;

        let result: PortChargeResult;
        if (chargedCount === 0) {
            this.limitSignalled = true;
            result = { chargedCount: 0, eventChargeLimitReached: count > 0 };
        } else {
            this.commitCharge(eventName, chargedCount, priceMicro);
            const limitReached = this.maxCharges(priceMicro) <= 0;
            if (limitReached) this.limitSignalled = true;
            result = { chargedCount, eventChargeLimitReached: limitReached };
        }

        if (due && due.fault.kind === 'hit_charge_fail') {
            this.fire(due, `hit charge #${this.ops.hit}`);
            throw new PlatformFault('charge API reported an error after the watchlist-hit was charged (lost acknowledgement)');
        }
        if (due && due.fault.kind === 'kill_after_hit_charge') {
            this.fire(due, `hit charge #${this.ops.hit}`);
            this.kill('after the watchlist-hit charge');
        }
        return result;
    }

    private priceMicro(eventName: string): number {
        const price = this.pricesUsd[eventName];
        if (price === undefined) throw new Error(`chaos platform: event "${eventName}" has no price`);
        return toMicro(price);
    }

    /** How many more events of this price the run's budget still allows (Infinity without a budget). */
    private maxCharges(priceMicro: number): number {
        if (this.budgetMicro === null || priceMicro <= 0) return Number.POSITIVE_INFINITY;
        return Math.max(0, Math.floor((this.budgetMicro - this.totalSpentMicro()) / priceMicro));
    }

    /** Everything booked against the run's budget so far: the out-of-band spend plus the router's own honoured charges. */
    private totalSpentMicro(): number {
        return this.stats.outOfBandMicro + this.stats.spentMicro;
    }

    private commitCharge(eventName: string, count: number, priceMicro: number): void {
        this.ledger.set(eventName, (this.ledger.get(eventName) ?? 0) + count);
        this.stats.chargesByEvent.set(eventName, (this.stats.chargesByEvent.get(eventName) ?? 0) + count);
        this.stats.spentMicro += count * priceMicro;
        this.stats.lastChargeMicro = count * priceMicro;
    }

    /** The armed fault (not yet fired) that hangs on THIS operation of class `cls`, if any. */
    private due(cls: OpClass, hitRowQualifies = false): ArmedFault | null {
        for (const armed of this.actives) {
            if (armed.fired || FAULT_OP_CLASS[armed.fault.kind] !== cls) continue;
            const { position, target } = armed.fault;
            const index = cls === 'journal' && target === 'hit_row' ? (hitRowQualifies ? this.ops.journalHitRow : -1) : this.ops[cls];
            if (index === position) return armed;
        }
        return null;
    }

    private fire(armed: ArmedFault, detail: string): void {
        armed.fired = true;
        armed.firedAt = detail;
    }

    private kill(point: string): never {
        this.killed = true;
        throw new KillSignal(point);
    }
}
