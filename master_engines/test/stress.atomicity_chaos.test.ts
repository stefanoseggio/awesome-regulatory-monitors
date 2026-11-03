/**
 * Randomized fault-injection ("chaos") test of billing and state atomicity.
 *
 * The REAL router (`runEngine`), the REAL `ApifyDeltaStore` (state records + delivery journal) and the REAL hit biller
 * run against a simulated platform (test/support/chaos_platform.ts) that can fail at every point a real one can: before
 * a push, between a push and its charge, after the charge, after the journal write, after the watchlist-hit charge,
 * on a checkpoint write, on a journal write, and by a hard kill that discards every later write (so no `finally` block
 * can save anything).
 *
 * A scenario (one seed) is: random upstream records (1..120, a few of them repeated inside one fetch), a delta mode
 * (all / onlyChanged / onlyNew), a watchlist (none, valid, valid mixed with junk, or poisoned), optionally a small per-run
 * USD budget (which the platform may already have partly spent out of band, as the SDK's start event does), optionally
 * fingerprint churn between attempts, then up to 40 attempts: the first K attempts (K from the seed) each get one random
 * fault at a random position, the settle phase runs fault-free until a run completes, and ONE MORE fault-free run (the
 * probe) must be a no-op. A second campaign arms TWO OR THREE coincident faults per attempt, half of them placed right
 * behind the first one. Seeds are fixed, so a scenario is exactly reproducible: every failure message names the seed, the
 * plan and the whole fault trace, and `runScenario(seed)` replays it. `CHAOS_SEED_BASE=<n>` shifts every campaign seed by n
 * (same checks, a different population; the committed population is 0).
 *
 * INVARIANTS (checked after every scenario by `checkInvariants`; the identifiers appear in every failure message):
 *   I1 no loss            every upstream record the delta mode must deliver is in the dataset at least once; only the
 *                         classes the mode allows are ever delivered; the settle phase completes.
 *   I2 billing <= delivery per attempt and per event the platform's ledger equals the number of charged dataset entries
 *                         (no charge without a push, no double charge), each row is billed at the event its delta class (or
 *                         billingEvent override) names, and the RUN_SUMMARY of every attempt that returned one matches the
 *                         platform's books (rows emitted, watchlist-hit charges, budget stop).
 *   I3 bounded repeats    a repeated delivery (the same record, same version, delivered again) exists only because a
 *                         pushed row's delivery was never remembered, and an attempt loses at most ONE row, however many
 *                         faults it suffers: for every attempt the number of its pushes that are later delivered again is
 *                         at most 1 when a repeating fault fired in it (charge_fail, kill_before_charge, kill_after_charge)
 *                         or when a lost journal write met a lost checkpoint write (the one coincidence of two
 *                         non-repeating faults that can lose the row in flight), and 0 otherwise (also 0 in every
 *                         fault-free attempt). Total repeats <= faults injected follows from that and is kept as a
 *                         cross-check. A record is never pushed twice inside one attempt (also when the upstream lists it
 *                         twice). Unchanged snapshot rows re-sent by deltaMode `all` are the mode's contract, not repeats.
 *   I4 bounded unbilled   a push without its charge exists only in an attempt in which charge_fail or kill_before_charge
 *                         fired (at most one per attempt); a watchlist-hit is lost only to a fault (at most one per faulted
 *                         attempt, none in a fault-free one) apart from the budget stop by design.
 *   I5 no ghost hits      a poisoned or empty watchlist flags no row and charges no watchlist-hit; otherwise the
 *                         is_watchlist_match flag is exact and hit charges never exceed the pushes of rows whose text
 *                         really contains a valid keyword (per attempt and in total).
 *   I6 idempotent         one more fault-free run delivers nothing and charges nothing (deltaMode `all` re-sends the
 *                         whole snapshot by contract: it must send every record exactly once, all as `unchanged`).
 *   I7 coherent memory    after the final run the delta memory holds every delivered record id at its final
 *                         fingerprint, has no duplicate id, and the delivery journal is empty; no journal write ever held
 *                         more than one checkpoint window (CHECKPOINT_EVERY_ROWS entries).
 *   I8 budget             per run, charged USD never exceeds the budget by more than one event (the SDK deliberately
 *                         overcharges by one at the limit), no charge is honoured once the run is strictly over budget
 *                         (spend booked out of band counts), and no billable call follows the platform's limit signal.
 *
 * WHAT THIS DOES NOT COVER (so a green run is not read as more than it is):
 *   - one source per scenario (cross-source ordering and `fetch` failures are covered by test/core.router.test.ts);
 *   - at most THREE coincident faults per attempt (the multi-fault campaign), and every fault fires at most once; the
 *     directed tests additionally pin that a lost journal write stops the run before a second fault can be reached (fail
 *     closed). A journal-less store (the optional-interface fallback) is only checked by directed scenarios, not by the
 *     campaigns: there a failed FINAL checkpoint repeats the rows since the last one, which is exactly what the journal is for;
 *   - the per-run watchlist-hit caps (maxWatchlistHitsPerRun, maxWatchlistSpendUsd) are never reached here (test/core.charging.test.ts
 *     covers them), so no hit is ever refused by a cap;
 *   - every platform write is atomic (no torn JSON), and faults live on the platform side only; the router itself is never
 *     patched, and the SDK's pushData/charge are simulated from its source rather than run (test/apify_sdk.integration.test.ts
 *     runs the real SDK, but only for a handful of fixed kill points);
 *   - a hit lost to a fault is accepted by design (the hit is billed after the journal write, so a kill between the two
 *     leaks one hit instead of double-billing a row): the checker bounds it (I4), it does not forbid it;
 *   - deltaMode `all` with a per-run budget below the snapshot re-sends and re-bills the same head rows every run and never
 *     reaches the tail (the mode has no cursor), so its settle and probe runs have no budget.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ApifyDeltaStore } from '../lib/apify_adapters.js';
import { WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { CHECKPOINT_EVERY_ROWS, type EngineDefinition, runEngine, type RunSinks } from '../lib/router_core.js';
import type { DeltaState, DeltaStore } from '../lib/state.js';
import { type Connector, type ConnectorContext, DELTA_MODES, type DeltaMode, type RunSummary, type SourceRecord } from '../lib/types.js';
import {
    type ArmedFault,
    type AttemptStats,
    CHAOS_NAMESPACE,
    ChaosPlatform,
    type DatasetEntry,
    describeFault,
    FAULT_KINDS,
    FAULT_OP_CLASS,
    type Fault,
    type FaultKind,
    KILL_KINDS,
    KillSignal,
    mulberry32,
    PlatformFault,
    SeededRandom,
    toMicro,
} from './support/chaos_platform.js';

const SOURCE_ID = 'chaos_src';
const MAX_FAULTED_ATTEMPTS = 39;
/** Shifts every campaign seed (`CHAOS_SEED_BASE=<n>`): the same checks on a different, equally reproducible population. 0 is the committed one. */
const SEED_BASE = Number.parseInt(process.env.CHAOS_SEED_BASE ?? '0', 10);
if (!Number.isSafeInteger(SEED_BASE) || SEED_BASE < 0) throw new Error(`CHAOS_SEED_BASE must be a non-negative integer, got "${process.env.CHAOS_SEED_BASE ?? ''}"`);
const PRICES: Readonly<Record<string, number>> = {
    'doc-new': 0.01,
    'doc-updated': 0.005,
    'doc-snapshot': 0.002,
    'doc-detail': 0.02,
    [WATCHLIST_HIT_EVENT]: 0.05,
};
const MAX_PRICE_MICRO = Math.max(...Object.values(PRICES).map(toMicro));
const EVENT_FOR_CLASS: Readonly<Record<string, string>> = { first_seen: 'doc-new', updated: 'doc-updated', unchanged: 'doc-snapshot' };
/** The only faults that can make the router push a row a second time (a row pushed whose delivery was never remembered). */
const REPEATING_KINDS: ReadonlySet<FaultKind> = new Set<FaultKind>(['charge_fail', 'kill_before_charge', 'kill_after_charge']);
/** The only faults that can leave a pushed row without its charge. */
const UNBILLING_KINDS: ReadonlySet<FaultKind> = new Set<FaultKind>(['charge_fail', 'kill_before_charge']);

const INVARIANTS = {
    I1: 'no loss',
    I2: 'billing never exceeds delivery',
    I3: 'bounded repeats',
    I4: 'bounded unbilled',
    I5: 'no ghost hits',
    I6: 'idempotent',
    I7: 'coherent memory',
    I8: 'budget',
    X: 'harness self-check or unexpected exception',
} as const;
type InvariantId = keyof typeof INVARIANTS;

interface Violation {
    invariant: InvariantId;
    message: string;
}

// ------------------------------------------------------------------------------------------------------------------
// Scenario model
// ------------------------------------------------------------------------------------------------------------------

type WatchKind = 'none' | 'valid' | 'mixed' | 'poisoned';

interface WatchPlan {
    kind: WatchKind;
    /** Exactly what is handed to the engine as `watchlistNames` (undefined: the field is absent). */
    input: unknown;
    /** The lower-cased keywords the guard must accept, written down independently of lib/_guards.ts. */
    needles: string[];
}

/** Watchlists the guard must treat as "no keyword at all". The record texts contain "a", "--", "x", "()" on purpose. */
const POISONED_WATCHLISTS: readonly unknown[] = [
    ['', '  ', '--', 'a'],
    [''],
    ['a'],
    '',
    'a',
    ' , ; ',
    ['--', '..', '()'],
    [null, 5, {}, ['x']],
    123,
    { a: 1 },
    ['\u200b\u200b', 'x'],
    ['   ', '\t', '\n'],
];

const VALID_WATCHLISTS: ReadonlyArray<{ input: unknown; needles: string[] }> = [
    { input: ['zephyr'], needles: ['zephyr'] },
    { input: ['  ZEPHYR  '], needles: ['zephyr'] },
    { input: ['Zephyr   Corp'], needles: ['zephyr corp'] },
    { input: ['nomatch-qq', 'zephyr corp'], needles: ['nomatch-qq', 'zephyr corp'] },
    { input: 'Zephyr, nomatch-qq', needles: ['zephyr', 'nomatch-qq'] },
];

const MIXED_WATCHLISTS: ReadonlyArray<{ input: unknown; needles: string[] }> = [
    { input: ['', 'a', '--', 'ZEPHYR', '  '], needles: ['zephyr'] },
    { input: ['x', 'zephyr corp', '()', null], needles: ['zephyr corp'] },
];

const BUDGETS_USD: readonly number[] = [0, 0.004, 0.025, 0.06, 0.1, 0.25];

interface WorldRecord {
    id: string;
    text: string | undefined;
    version: number;
    billingEvent: string | undefined;
}

interface AttemptDraw {
    kindRoll: number;
    at: number;
    hitRowRoll: number;
    appliedRoll: number;
}

interface ScenarioPlan {
    seed: number;
    mode: DeltaMode;
    records: WorldRecord[];
    watch: WatchPlan;
    budgetMicro: number | null;
    /** Probability that a record changes content between two attempts of the faulted phase. */
    churn: number;
    faultedAttempts: number;
    /** How many coincident faults each faulted attempt arms (1 in the first campaign, 2 or 3 in the multi-fault one). */
    faultsPerAttempt: number;
    draws: AttemptDraw[];
    churnRolls: number[][];
    /** One roll per faulted attempt: whether (and how much of) the budget the platform had already spent out of band. */
    outOfBandRolls: number[];
    /** Indexes of the records the upstream lists a second time (an exact id repeat with another fingerprint) at the end of its answer. */
    duplicates: number[];
}

interface RunOptions {
    recordCount?: number;
    recordRange?: readonly [number, number];
    mode?: DeltaMode;
    watch?: WatchKind;
    /** `random`: always a budget; `none`: never; omitted: a budget in about 40 percent of the scenarios. */
    budget?: 'none' | 'random';
    churn?: number;
    faultedAttempts?: number;
    /** Coincident faults armed per faulted attempt (default 1). */
    faultsPerAttempt?: number;
    /** An exact per-run budget in USD (wins over `budget`): used by the directed tests. */
    budgetUsd?: number;
    /** Exact out-of-band spend in micro-USD per faulted attempt (wins over the drawn one): used by the directed tests. */
    outOfBand?: readonly number[];
    /** Exact indexes of the records the upstream lists twice (wins over the drawn ones). */
    duplicates?: readonly number[];
    allowedKinds?: readonly FaultKind[];
    /** An explicit fault schedule, one entry per attempt (a fault, or several armed together), absolute positions: used by the directed tests. */
    faults?: ReadonlyArray<Fault | readonly Fault[]>;
    wrapStore?: (store: ApifyDeltaStore) => DeltaStore;
    wrapSinks?: (sinks: RunSinks) => RunSinks;
}

function planWatch(kind: WatchKind, roll: number): WatchPlan {
    switch (kind) {
        case 'none':
            return { kind, input: undefined, needles: [] };
        case 'valid': {
            const choice = VALID_WATCHLISTS[Math.floor(roll * VALID_WATCHLISTS.length)] ?? VALID_WATCHLISTS[0];
            return { kind, input: choice?.input, needles: choice?.needles ?? [] };
        }
        case 'mixed': {
            const choice = MIXED_WATCHLISTS[Math.floor(roll * MIXED_WATCHLISTS.length)] ?? MIXED_WATCHLISTS[0];
            return { kind, input: choice?.input, needles: choice?.needles ?? [] };
        }
        case 'poisoned':
            return { kind, input: POISONED_WATCHLISTS[Math.floor(roll * POISONED_WATCHLISTS.length)], needles: [] };
    }
}

/** Every random number is drawn unconditionally and in a fixed order, so a seed means the same plan whatever is overridden. */
function planScenario(rng: SeededRandom, seed: number, opt: RunOptions): ScenarioPlan {
    const sizeRoll = rng.float();
    const sizeFine = rng.float();
    const drawnCount = sizeRoll < 0.5 ? 1 + Math.floor(sizeFine * 30) : sizeRoll < 0.8 ? 31 + Math.floor(sizeFine * 40) : 71 + Math.floor(sizeFine * 50);
    const recordCount = opt.recordCount ?? (opt.recordRange ? opt.recordRange[0] + Math.floor(sizeFine * (opt.recordRange[1] - opt.recordRange[0] + 1)) : drawnCount);
    const modeRoll = rng.float();
    const mode = opt.mode ?? DELTA_MODES[Math.min(DELTA_MODES.length - 1, Math.floor(modeRoll * DELTA_MODES.length))] ?? 'onlyChanged';

    const watchRoll = rng.float();
    const watchKind: WatchKind = opt.watch ?? (watchRoll < 0.15 ? 'none' : watchRoll < 0.6 ? 'valid' : watchRoll < 0.75 ? 'mixed' : 'poisoned');
    const watch = planWatch(watchKind, rng.float());

    const budgetRoll = rng.float();
    const budgetPick = rng.float();
    const wantsBudget = opt.budget === 'random' || (opt.budget === undefined && budgetRoll < 0.4);
    const budgetMicro = wantsBudget ? toMicro(BUDGETS_USD[Math.floor(budgetPick * BUDGETS_USD.length)] ?? 0) : null;

    const churnRoll = rng.float();
    const drawnChurn = churnRoll < 0.4 ? 0 : churnRoll < 0.7 ? 0.05 : churnRoll < 0.9 ? 0.15 : 0.4;
    const kRoll = rng.float();
    const kFine = rng.float();
    const drawnFaulted = kRoll < 0.03 ? 0 : kRoll < 0.5 ? 1 + Math.floor(kFine * 12) : 1 + Math.floor(kFine * MAX_FAULTED_ATTEMPTS);

    const records: WorldRecord[] = [];
    let anyMatch = false;
    for (let index = 0; index < recordCount; index += 1) {
        const matchRoll = rng.float();
        const textRoll = rng.float();
        const detailRoll = rng.float();
        const match = matchRoll < 0.1;
        anyMatch = anyMatch || match;
        records.push({
            id: `r${String(index).padStart(3, '0')}`,
            text: match ? 'a -- x () .. zephyr corp' : textRoll < 0.05 ? undefined : 'a -- x () .. omega ltd',
            version: 0,
            billingEvent: detailRoll < 0.1 ? 'doc-detail' : undefined,
        });
    }
    const forcedPick = rng.float();
    if (!anyMatch && records.length >= 3) {
        const forced = records[Math.floor(forcedPick * records.length)];
        if (forced) forced.text = 'a -- x () .. zephyr corp';
    }
    const hostileRoll = rng.float();
    if (hostileRoll < 0.1 && records.length >= 2) {
        // Ids that are also Object.prototype members: the memory must round-trip them through the key-value store.
        const first = records[0];
        const second = records[1];
        if (first) first.id = '__proto__';
        if (second) second.id = 'constructor';
    }
    for (const record of records) record.text = record.text === undefined ? undefined : `${record.text} ${record.id}`;

    const draws: AttemptDraw[] = [];
    const churnRolls: number[][] = [];
    for (let attempt = 0; attempt < MAX_FAULTED_ATTEMPTS; attempt += 1) {
        draws.push({ kindRoll: rng.float(), at: rng.float(), hitRowRoll: rng.float(), appliedRoll: rng.float() });
        churnRolls.push(Array.from({ length: recordCount }, () => rng.float()));
    }
    // Drawn last, so adding them moved no earlier part of any plan.
    const outOfBandRolls = Array.from({ length: MAX_FAULTED_ATTEMPTS }, () => rng.float());
    const duplicateRoll = rng.float();
    const duplicateRolls = Array.from({ length: recordCount }, () => rng.float());
    const duplicateRate = duplicateRoll < 0.7 ? 0 : 0.12;
    const drawnDuplicates = duplicateRolls.flatMap((roll, index) => (roll < duplicateRate ? [index] : []));

    return {
        seed,
        mode,
        records,
        watch,
        budgetMicro: opt.budgetUsd !== undefined ? toMicro(opt.budgetUsd) : opt.budget === 'none' ? null : budgetMicro,
        churn: opt.churn ?? drawnChurn,
        faultedAttempts: opt.faults ? opt.faults.length : (opt.faultedAttempts ?? drawnFaulted),
        faultsPerAttempt: opt.faultsPerAttempt ?? 1,
        draws,
        churnRolls,
        outOfBandRolls,
        duplicates: opt.duplicates ? [...opt.duplicates] : drawnDuplicates,
    };
}

/**
 * Spend the platform had already booked against this attempt's budget before the router's first call (the SDK seeds its
 * charging state with it). A quarter of the budgeted faulted attempts get some: strictly over the budget (the first row is
 * trimmed away), exactly the budget (one more row is pushed on purpose), half of it, or all but one micro-USD.
 */
function outOfBandFor(plan: ScenarioPlan, attempt: number, explicit: readonly number[] | undefined): number {
    if (plan.budgetMicro === null) return 0;
    if (explicit) return explicit[attempt] ?? 0;
    const roll = plan.outOfBandRolls[attempt];
    if (roll === undefined || roll < 0.75) return 0;
    const budget = plan.budgetMicro;
    const choices = [budget + 1, budget, Math.floor(budget / 2), Math.max(0, budget - 1)];
    return choices[Math.min(choices.length - 1, Math.floor(((roll - 0.75) / 0.25) * choices.length))] ?? 0;
}

class World {
    constructor(
        readonly records: WorldRecord[],
        readonly duplicates: readonly number[] = [],
    ) {}

    /** The upstream's answer: every record once, then the repeated ones again with another fingerprint (the router keeps the FIRST). */
    snapshot(): SourceRecord[] {
        const answer: SourceRecord[] = this.records.map((record, index) => ({
            recordId: record.id,
            fingerprint: `v${record.version}`,
            payload: { fp: `v${record.version}`, n: index },
            watchText: record.text,
            billingEvent: record.billingEvent,
        }));
        for (const index of this.duplicates) {
            const record = this.records[index];
            if (record) answer.push({ recordId: record.id, fingerprint: 'repeat', payload: { fp: 'repeat', n: -1 - index }, watchText: record.text, billingEvent: undefined });
        }
        return answer;
    }

    /** Changes the content (fingerprint) of the records whose roll is below `probability`. Returns how many changed. */
    churn(rolls: readonly number[], probability: number): number {
        let changed = 0;
        this.records.forEach((record, index) => {
            if ((rolls[index] ?? 1) < probability) {
                record.version += 1;
                changed += 1;
            }
        });
        return changed;
    }
}

function reallyMatches(text: string | undefined, needles: readonly string[]): boolean {
    if (text === undefined) return false;
    const haystack = text.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
}

/**
 * The oracle for "which rows will the next run push, and how many operations will it make": written independently of
 * lib/router_core.ts. It is only used to place a fault where something is going to happen, never to judge a result.
 */
interface WorkEstimate {
    emits: number;
    hitRows: number;
    stateWrites: number;
    journalWrites: number;
}

function expectedWork(platform: ChaosPlatform, world: World, mode: DeltaMode, needles: readonly string[], budgetMicro: number | null): WorkEstimate {
    const memory = platform.durableFingerprints(SOURCE_ID);
    const pending = platform.durableJournal(SOURCE_ID).length > 0 ? 1 : 0;
    let emits = 0;
    let hitRows = 0;
    let spent = 0;
    for (const record of world.records) {
        const known = memory.get(record.id);
        const fingerprint = `v${record.version}`;
        const cls = known === undefined ? 'first_seen' : known === fingerprint ? 'unchanged' : 'updated';
        const emit = mode === 'all' || (mode === 'onlyChanged' && cls !== 'unchanged') || (mode === 'onlyNew' && cls === 'first_seen');
        if (!emit) continue;
        const price = toMicro(PRICES[record.billingEvent ?? EVENT_FOR_CLASS[cls] ?? 'doc-new'] ?? 0.01);
        if (budgetMicro !== null && Math.floor((budgetMicro - spent) / price) < 1 && spent > budgetMicro) break;
        emits += 1;
        if (reallyMatches(record.text, needles)) hitRows += 1;
        spent += price;
        if (budgetMicro !== null && Math.floor((budgetMicro - spent) / price) <= 0) break;
    }
    return {
        emits,
        hitRows,
        stateWrites: pending + Math.floor(emits / CHECKPOINT_EVERY_ROWS) + 1,
        journalWrites: pending + emits + Math.floor(emits / CHECKPOINT_EVERY_ROWS) + (emits > 0 ? 1 : 0),
    };
}

function armFault(draw: AttemptDraw, estimate: WorkEstimate, allowed: readonly FaultKind[]): Fault {
    const available = allowed.filter((kind) => {
        switch (FAULT_OP_CLASS[kind]) {
            case 'emit':
            case 'journal':
                return estimate.emits > 0;
            case 'hit':
                return estimate.hitRows > 0;
            case 'state':
                return true;
        }
    });
    const pool = available.length > 0 ? available : allowed;
    const kind = pool[Math.floor(draw.kindRoll * pool.length)] ?? 'push_fail';
    const target = FAULT_OP_CLASS[kind] === 'journal' && estimate.hitRows > 0 && draw.hitRowRoll < 0.5 ? 'hit_row' : 'any';
    let operations: number;
    switch (FAULT_OP_CLASS[kind]) {
        case 'emit':
            operations = estimate.emits;
            break;
        case 'journal':
            operations = target === 'hit_row' ? estimate.hitRows : estimate.journalWrites;
            break;
        case 'state':
            operations = estimate.stateWrites;
            break;
        case 'hit':
            operations = estimate.hitRows;
            break;
    }
    // About 3 percent of the faults are placed one operation past the end on purpose: they never fire (counted as unfired).
    const position = draw.at >= 0.97 ? operations + 1 : 1 + Math.floor((draw.at / 0.97) * operations);
    return { kind, position: Math.max(1, position), target, applied: draw.appliedRoll < 0.5 };
}

/**
 * Faults 2..count of one attempt. They come from their own generator (seeded by scenario and attempt), so a single-fault
 * plan never moves, and half of them are placed right behind the first fault (0..2 operations after it), where two faults
 * interact most: a lost journal write with a kill on the next push, a failed checkpoint with a failed retry.
 */
function armExtraFaults(first: Fault, count: number, estimate: WorkEstimate, allowed: readonly FaultKind[], seed: number, attempt: number): Fault[] {
    const rng = new SeededRandom((Math.imul(seed, 0x2545f491) ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0);
    const extra: Fault[] = [];
    for (let index = 1; index < count; index += 1) {
        const fault = armFault({ kindRoll: rng.float(), at: rng.float(), hitRowRoll: rng.float(), appliedRoll: rng.float() }, estimate, allowed);
        const behind = rng.float() < 0.5;
        const nudge = rng.int(0, 2);
        extra.push(behind ? { ...fault, position: Math.max(1, first.position + nudge) } : fault);
    }
    return extra;
}

// ------------------------------------------------------------------------------------------------------------------
// Scenario runner
// ------------------------------------------------------------------------------------------------------------------

type Phase = 'faulted' | 'settle' | 'probe';

interface AttemptTrace {
    attempt: number;
    phase: Phase;
    faults: ArmedFault[];
    outcome: 'completed' | 'killed' | 'error' | 'crashed';
    detail: string;
    stoppedOnChargeLimit: boolean;
    pushes: number;
    churned: number;
    outOfBandMicro: number;
    journalRecoveries: number;
}

interface ScenarioOutcome {
    seed: number;
    plan: ScenarioPlan;
    traces: AttemptTrace[];
    stats: AttemptStats[];
    dataset: readonly DatasetEntry[];
    ledger: ReadonlyMap<string, number>;
    finalRecords: Array<{ id: string; fingerprint: string; text: string | undefined; billingEvent: string | undefined }>;
    memory: DeltaState;
    journalLeft: number;
    durableKeys: string[];
    completed: boolean;
    completingAttempt: number;
    probeAttempt: number;
    /** How many records the upstream listed in each attempt's fetch (duplicates included), so a test can prove the router really was handed a repeated id. */
    fetchedCounts: number[];
    /** The RUN_SUMMARY of every attempt that returned one, by attempt number. */
    summaries: ReadonlyMap<number, RunSummary>;
}

const silentContext = (errors: string[], infos: string[]): ConnectorContext => ({
    http: {
        async getText() {
            throw new Error('network must not be used in chaos tests');
        },
        async getJson() {
            throw new Error('network must not be used in chaos tests');
        },
    },
    log: { info: (message) => void infos.push(message), warning() {}, error: (message) => void errors.push(message), debug() {} },
    now: () => new Date('2026-10-21T00:00:00Z'),
});
const clock = (): Date => new Date('2026-10-21T00:00:00Z');

async function runScenario(seed: number, opt: RunOptions = {}): Promise<ScenarioOutcome> {
    const platform = new ChaosPlatform({ seed: (Math.imul(seed + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0, prices: PRICES });
    const plan = planScenario(platform.rng, seed, opt);
    const world = new World(
        plan.records.map((record) => ({ ...record })),
        plan.duplicates,
    );
    const allowed = opt.allowedKinds ?? FAULT_KINDS;

    const fetchedCounts: number[] = [];
    const connector: Connector<Record<string, unknown>> = {
        id: SOURCE_ID,
        engine: 'global-regtech-compliance-feed',
        legacyActor: 'chaos',
        description: 'chaos source',
        status: 'active',
        optionsSchema: z.object({}).passthrough(),
        billing: { newEvent: 'doc-new', updatedEvent: 'doc-updated', snapshotEvent: 'doc-snapshot' },
        async fetch() {
            const answer = world.snapshot();
            fetchedCounts.push(answer.length);
            return answer;
        },
    };
    const engine: EngineDefinition = { slug: 'global-regtech-compliance-feed', connectors: [connector], extraBillingEvents: ['doc-detail'] };
    const input: Record<string, unknown> = { sources: [SOURCE_ID], deltaMode: plan.mode };
    // the engine's default window is 500 records per source; a bigger upstream (directed tests) needs a bigger one
    if (plan.records.length + plan.duplicates.length > 500) input.maxItemsPerSource = plan.records.length + plan.duplicates.length;
    if (plan.watch.input !== undefined) input.watchlistNames = plan.watch.input;

    const traces: AttemptTrace[] = [];
    const runAttempt = async (attempt: number, phase: Phase, fault: Fault | readonly Fault[] | null, budgetMicro: number | null, churned: number, outOfBandMicro: number): Promise<AttemptTrace> => {
        platform.beginAttempt(attempt, fault, budgetMicro, outOfBandMicro);
        const errors: string[] = [];
        const infos: string[] = [];
        let sinks = platform.sinks(opt.wrapStore ? opt.wrapStore(platform.openStore()) : undefined);
        if (opt.wrapSinks) sinks = opt.wrapSinks(sinks);
        let outcome: AttemptTrace['outcome'] = 'completed';
        let detail = '';
        let stopped = false;
        try {
            const summary = await runEngine(engine, input, { sinks, ctx: silentContext(errors, infos), clock });
            stopped = summary.stoppedOnChargeLimit;
        } catch (error) {
            if (error instanceof KillSignal) outcome = 'killed';
            else if (error instanceof PlatformFault) outcome = 'error';
            else outcome = 'crashed';
            detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        // The router's own `finally` swallows errors raised while persisting, so a kill can be absorbed there.
        if (platform.killed) outcome = 'killed';
        const stats = platform.endAttempt();
        if (outcome === 'completed' && errors.length > 0) detail = errors.slice(0, 2).join(' | ');
        const trace: AttemptTrace = {
            attempt,
            phase,
            faults: stats.faults,
            outcome,
            detail,
            stoppedOnChargeLimit: stopped,
            pushes: stats.pushes,
            churned,
            outOfBandMicro,
            journalRecoveries: infos.filter((line) => /recovered \d+ record/u.test(line)).length,
        };
        traces.push(trace);
        return trace;
    };

    let attempt = 0;
    for (; attempt < plan.faultedAttempts; attempt += 1) {
        const churned = attempt > 0 ? world.churn(plan.churnRolls[attempt - 1] ?? [], plan.churn) : 0;
        const draw = plan.draws[attempt] ?? plan.draws[0];
        let fault: Fault | readonly Fault[] | null = null;
        if (opt.faults) {
            fault = opt.faults[attempt] ?? null;
        } else if (draw) {
            const estimate = expectedWork(platform, world, plan.mode, plan.watch.needles, plan.budgetMicro);
            const first = armFault(draw, estimate, allowed);
            fault = plan.faultsPerAttempt > 1 ? [first, ...armExtraFaults(first, plan.faultsPerAttempt, estimate, allowed, seed, attempt)] : first;
        }
        await runAttempt(attempt, 'faulted', fault, plan.budgetMicro, churned, outOfBandFor(plan, attempt, opt.outOfBand));
    }

    // Settle: fault-free runs until one completes without hitting the budget. With a per-run budget smaller than the
    // snapshot, deltaMode `all` can never finish (it re-sends from the first record every run), so its settle and probe
    // runs have no budget; the other modes keep the budget and need several runs.
    const settleBudget = plan.mode === 'all' ? null : plan.budgetMicro;
    let completingAttempt = -1;
    for (let run = 0; run < plan.records.length + 3; run += 1) {
        const trace = await runAttempt(attempt, 'settle', null, settleBudget, 0, 0);
        attempt += 1;
        if (trace.outcome !== 'completed') break;
        if (!trace.stoppedOnChargeLimit) {
            completingAttempt = trace.attempt;
            break;
        }
    }
    const probeAttempt = attempt;
    await runAttempt(attempt, 'probe', null, settleBudget, 0, 0);

    const reader = platform.openStore();
    return {
        seed,
        plan,
        traces,
        stats: platform.attemptStats.slice(),
        dataset: platform.dataset,
        ledger: platform.ledger,
        finalRecords: world.records.map((record) => ({ id: record.id, fingerprint: `v${record.version}`, text: record.text, billingEvent: record.billingEvent })),
        memory: await reader.load(),
        journalLeft: (await reader.loadJournal(SOURCE_ID)).length,
        durableKeys: platform.durableKeys(),
        completed: completingAttempt >= 0,
        completingAttempt,
        probeAttempt,
        fetchedCounts,
        summaries: platform.summaries,
    };
}

// ------------------------------------------------------------------------------------------------------------------
// Invariant checker
// ------------------------------------------------------------------------------------------------------------------

const fingerprintOf = (entry: DatasetEntry): string => String(entry.row.fp);
const statusOf = (entry: DatasetEntry): string => String(entry.row.delta_status);

/** The faults of one attempt that actually fired. */
const firedFaults = (stats: AttemptStats): Fault[] => stats.faults.filter((armed) => armed.fired).map((armed) => armed.fault);
const describeFired = (fired: readonly Fault[]): string => (fired.length > 0 ? fired.map(describeFault).join(' + ') : 'no fault fired');

/**
 * A journal write that was lost (the row is in no journal) and a checkpoint write that was lost (the row is in no state),
 * in the SAME attempt: the one coincidence of two non-repeating faults that can lose the row in flight. Measured on the
 * multi-fault campaign: no other combination of non-repeating faults ever repeated a row.
 */
const journalAndCheckpointLost = (fired: readonly Fault[]): boolean =>
    fired.some((fault) => fault.kind === 'kv_journal_write_fail' && !fault.applied) && fired.some((fault) => fault.kind === 'kv_state_write_fail' && !fault.applied);

interface Analysis {
    byId: Map<string, DatasetEntry[]>;
    textById: Map<string, string | undefined>;
    /**
     * Per attempt, how many of its novel pushes (a first_seen id, or an updated (id, version)) were delivered AGAIN in a
     * later attempt: the rows that attempt "lost". A repeat is charged to the attempt whose push was not remembered, so
     * repeats that carry over several attempts are never charged to the wrong fault.
     */
    lostByAttempt: number[];
    /** Total repeated deliveries across attempts (pushes minus distinct deliveries). */
    repeatedRows: number;
    duplicatesWithinAttempt: number;
    unbilled: DatasetEntry[];
    matchPushes: number[];
    limitSkips: number[];
    hitCharges: number[];
    firedKinds: FaultKind[];
}

function analyse(o: ScenarioOutcome): Analysis {
    const byId = new Map<string, DatasetEntry[]>();
    for (const entry of o.dataset) {
        const list = byId.get(entry.record_id);
        if (list) list.push(entry);
        else byId.set(entry.record_id, [entry]);
    }
    const textById = new Map(o.finalRecords.map((record) => [record.id, record.text] as const));
    const attempts = o.stats.length;
    const lostByAttempt = new Array<number>(attempts).fill(0);
    const matchPushes = new Array<number>(attempts).fill(0);
    const limitSkips = new Array<number>(attempts).fill(0);
    const lastAttemptOfKey = new Map<string, number>();
    let duplicatesWithinAttempt = 0;
    let repeatedRows = 0;
    const unbilled: DatasetEntry[] = [];
    for (const entry of o.dataset) {
        if (!entry.charged) unbilled.push(entry);
        if (reallyMatches(textById.get(entry.record_id), o.plan.watch.needles)) {
            matchPushes[entry.attempt] = (matchPushes[entry.attempt] ?? 0) + 1;
            if (entry.limitReachedAfter) limitSkips[entry.attempt] = (limitSkips[entry.attempt] ?? 0) + 1;
        }
        const status = statusOf(entry);
        if (status === 'unchanged') continue;
        const key = status === 'first_seen' ? `F|${entry.record_id}` : `U|${entry.record_id}|${fingerprintOf(entry)}`;
        const previous = lastAttemptOfKey.get(key);
        if (previous === entry.attempt) {
            duplicatesWithinAttempt += 1;
        } else if (previous !== undefined) {
            // the previous push of this delivery was not remembered: charge the repeat to the attempt that made it
            lostByAttempt[previous] = (lostByAttempt[previous] ?? 0) + 1;
            repeatedRows += 1;
        }
        lastAttemptOfKey.set(key, entry.attempt);
    }
    return {
        byId,
        textById,
        lostByAttempt,
        repeatedRows,
        duplicatesWithinAttempt,
        unbilled,
        matchPushes,
        limitSkips,
        hitCharges: o.stats.map((stats) => stats.chargesByEvent.get(WATCHLIST_HIT_EVENT) ?? 0),
        firedKinds: o.stats.flatMap((stats) => firedFaults(stats).map((fault) => fault.kind)),
    };
}

function checkInvariants(o: ScenarioOutcome): Violation[] {
    const violations: Violation[] = [];
    const add = (invariant: InvariantId, message: string): void => void violations.push({ invariant, message });
    const a = analyse(o);
    const { plan } = o;
    const needles = plan.watch.needles;
    const faultsFired = a.firedKinds.length;
    const count = (kind: FaultKind): number => a.firedKinds.filter((fired) => fired === kind).length;

    for (const trace of o.traces) {
        if (trace.outcome === 'crashed') add('X', `attempt ${trace.attempt} threw an unexpected exception: ${trace.detail}`);
    }
    for (const stats of o.stats) {
        if (stats.callsAfterKill > 0) add('X', `attempt ${stats.attempt}: ${stats.callsAfterKill} call(s) reached the platform after the simulated kill`);
    }

    // I1 ---------------------------------------------------------------------------------------------------------
    if (!o.completed) add('I1', `the fault-free settle phase never completed (${o.traces.filter((t) => t.phase === 'settle').length} run(s))`);
    const finalById = new Map(o.finalRecords.map((record) => [record.id, record] as const));
    for (const record of o.finalRecords) {
        const entries = a.byId.get(record.id) ?? [];
        const delivered =
            plan.mode === 'onlyNew'
                ? entries.length > 0
                : plan.mode === 'onlyChanged'
                  ? entries.some((entry) => fingerprintOf(entry) === record.fingerprint)
                  : entries.some((entry) => entry.attempt === o.completingAttempt && fingerprintOf(entry) === record.fingerprint);
        if (!delivered) add('I1', `record ${record.id} (${plan.mode}, final version ${record.fingerprint}) was never delivered; its pushes: ${entries.map((e) => `a${e.attempt}:${statusOf(e)}:${fingerprintOf(e)}`).join(',') || 'none'}`);
    }
    for (const entry of o.dataset) {
        if (!finalById.has(entry.record_id)) add('I1', `a row for ${entry.record_id} was pushed but that record is not in the upstream`);
        const status = statusOf(entry);
        const allowedStatuses = plan.mode === 'all' ? ['first_seen', 'updated', 'unchanged'] : plan.mode === 'onlyChanged' ? ['first_seen', 'updated'] : ['first_seen'];
        if (!allowedStatuses.includes(status)) add('I1', `${plan.mode} delivered a ${status} row for ${entry.record_id} in attempt ${entry.attempt}`);
    }

    // I2 ---------------------------------------------------------------------------------------------------------
    for (const stats of o.stats) {
        const chargedEntries = new Map<string, number>();
        for (const entry of o.dataset) if (entry.attempt === stats.attempt && entry.charged) chargedEntries.set(entry.event, (chargedEntries.get(entry.event) ?? 0) + 1);
        const events = new Set([...stats.chargesByEvent.keys(), ...chargedEntries.keys()]);
        events.delete(WATCHLIST_HIT_EVENT);
        for (const event of events) {
            const ledger = stats.chargesByEvent.get(event) ?? 0;
            const entries = chargedEntries.get(event) ?? 0;
            if (ledger !== entries) add('I2', `attempt ${stats.attempt}: the platform charged "${event}" ${ledger} time(s) but ${entries} pushed row(s) carry that charge`);
        }
    }
    for (const entry of o.dataset) {
        const record = finalById.get(entry.record_id);
        const expected = record?.billingEvent ?? EVENT_FOR_CLASS[statusOf(entry)];
        if (entry.event !== expected) add('I2', `record ${entry.record_id} (${statusOf(entry)}) was billed at "${entry.event}", expected "${expected}"`);
    }
    // what the router REPORTS (the RUN_SUMMARY a customer reads) must match the platform's books, in every attempt that returned one
    for (const stats of o.stats) {
        const summary = o.summaries.get(stats.attempt);
        if (!summary) continue;
        const hitCharges = stats.chargesByEvent.get(WATCHLIST_HIT_EVENT) ?? 0;
        if (summary.totalEmitted !== stats.pushes) add('I2', `attempt ${stats.attempt}: the run summary reports ${summary.totalEmitted} emitted row(s) but the platform stored ${stats.pushes}`);
        const source = summary.sources.find((entry) => entry.source === SOURCE_ID);
        if (source?.emitted !== stats.pushes) add('I2', `attempt ${stats.attempt}: the source summary reports ${String(source?.emitted)} emitted row(s) but the platform stored ${stats.pushes}`);
        if (source?.watchlistHits !== (a.matchPushes[stats.attempt] ?? 0)) add('I2', `attempt ${stats.attempt}: the source summary reports ${String(source?.watchlistHits)} watchlist hit(s) but ${a.matchPushes[stats.attempt] ?? 0} pushed row(s) really match`);
        if (summary.watchlist.hitsCharged !== hitCharges) add('I2', `attempt ${stats.attempt}: the run summary reports ${summary.watchlist.hitsCharged} watchlist-hit charge(s) but the platform honoured ${hitCharges}`);
        if (summary.stoppedOnChargeLimit !== stats.limitSignalled) add('I2', `attempt ${stats.attempt}: the run summary says stoppedOnChargeLimit=${String(summary.stoppedOnChargeLimit)} but the platform ${stats.limitSignalled ? 'did' : 'did not'} signal the limit`);
    }

    // I3 ---------------------------------------------------------------------------------------------------------
    // implied by the per-attempt bound below (every repeat is charged to an attempt in which a fault fired); kept as a cross-check
    if (a.repeatedRows > faultsFired) add('I3', `${a.repeatedRows} repeated deliveries but only ${faultsFired} fault(s) were injected (each fault may repeat at most one row)`);
    for (const stats of o.stats) {
        const lost = a.lostByAttempt[stats.attempt] ?? 0;
        const fired = firedFaults(stats);
        const allowedLoss = fired.some((fault) => REPEATING_KINDS.has(fault.kind)) || journalAndCheckpointLost(fired) ? 1 : 0;
        if (lost > allowedLoss) add('I3', `attempt ${stats.attempt} (${describeFired(fired)}): ${lost} of its pushed rows were delivered again later, at most ${allowedLoss} allowed`);
    }
    if (a.duplicatesWithinAttempt > 0) add('I3', `${a.duplicatesWithinAttempt} row(s) were pushed twice inside a single attempt`);

    // I4 ---------------------------------------------------------------------------------------------------------
    const unbillingFaults = count('charge_fail') + count('kill_before_charge');
    // implied by the per-attempt rule below; kept as a cross-check
    if (a.unbilled.length > unbillingFaults) add('I4', `${a.unbilled.length} unbilled pushes but only ${unbillingFaults} charge_fail / kill_before_charge fault(s) fired`);
    const unbilledPerAttempt = new Map<number, number>();
    for (const entry of a.unbilled) unbilledPerAttempt.set(entry.attempt, (unbilledPerAttempt.get(entry.attempt) ?? 0) + 1);
    for (const [attempt, n] of unbilledPerAttempt) {
        const fired = o.stats[attempt] ? firedFaults(o.stats[attempt]) : [];
        if (!fired.some((fault) => UNBILLING_KINDS.has(fault.kind)) || n > 1) add('I4', `attempt ${attempt} left ${n} pushed row(s) unbilled although it suffered: ${describeFired(fired)}`);
    }
    for (const stats of o.stats) {
        const lost = (a.matchPushes[stats.attempt] ?? 0) - (a.hitCharges[stats.attempt] ?? 0) - (a.limitSkips[stats.attempt] ?? 0);
        const fired = firedFaults(stats);
        const allowedLoss = fired.length > 0 ? 1 : 0;
        if (lost > allowedLoss) add('I4', `attempt ${stats.attempt}: ${lost} watchlist-hit(s) were never charged (${a.matchPushes[stats.attempt]} matching pushes, ${a.hitCharges[stats.attempt]} hit charges, ${a.limitSkips[stats.attempt]} skipped at the budget limit) but ${fired.length > 0 ? `only: ${describeFired(fired)}` : 'no fault fired'}`);
    }

    // I5 ---------------------------------------------------------------------------------------------------------
    const hitLedger = o.ledger.get(WATCHLIST_HIT_EVENT) ?? 0;
    if (needles.length === 0) {
        if (hitLedger > 0) add('I5', `the watchlist is ${plan.watch.kind} (no valid keyword) yet ${hitLedger} watchlist-hit(s) were charged`);
    } else {
        const totalMatchPushes = a.matchPushes.reduce((sum, n) => sum + n, 0);
        if (hitLedger > totalMatchPushes) add('I5', `${hitLedger} watchlist-hit(s) charged for only ${totalMatchPushes} pushes of rows that really contain a valid keyword`);
    }
    for (const stats of o.stats) {
        if ((a.hitCharges[stats.attempt] ?? 0) > (a.matchPushes[stats.attempt] ?? 0)) add('I5', `attempt ${stats.attempt}: ${a.hitCharges[stats.attempt]} hit charge(s) for ${a.matchPushes[stats.attempt]} matching push(es)`);
    }
    for (const entry of o.dataset) {
        const really = reallyMatches(a.textById.get(entry.record_id), needles);
        if ((entry.row.is_watchlist_match === true) !== really) add('I5', `record ${entry.record_id}: is_watchlist_match=${String(entry.row.is_watchlist_match)} but the text ${really ? 'contains' : 'does not contain'} a valid keyword`);
        if ((entry.row.matched_watchlist_keyword !== null) !== really) add('I5', `record ${entry.record_id}: matched_watchlist_keyword=${String(entry.row.matched_watchlist_keyword)} disagrees with the oracle (${really})`);
    }

    // I6 ---------------------------------------------------------------------------------------------------------
    const probe = o.traces.find((trace) => trace.attempt === o.probeAttempt);
    const probeEntries = o.dataset.filter((entry) => entry.attempt === o.probeAttempt);
    const probeStats = o.stats[o.probeAttempt];
    const probeCharges = probeStats ? [...probeStats.chargesByEvent.values()].reduce((sum, n) => sum + n, 0) : 0;
    if (probe?.outcome !== 'completed') add('I6', `the probe run did not complete (${probe?.outcome ?? 'missing'}: ${probe?.detail ?? ''})`);
    if (plan.mode === 'all') {
        const ids = new Set(probeEntries.map((entry) => entry.record_id));
        if (probeEntries.length !== o.finalRecords.length || ids.size !== o.finalRecords.length) add('I6', `deltaMode all: the probe pushed ${probeEntries.length} row(s) (${ids.size} distinct) for ${o.finalRecords.length} record(s)`);
        if (probeEntries.some((entry) => statusOf(entry) !== 'unchanged')) add('I6', 'deltaMode all: the probe delivered a row that was not "unchanged"');
        if (probeEntries.some((entry) => !entry.charged)) add('I6', 'deltaMode all: the probe left a pushed row unbilled');
    } else if (probeEntries.length > 0 || probeCharges > 0) {
        add('I6', `the probe run pushed ${probeEntries.length} row(s) and made ${probeCharges} charge(s); a further fault-free run must be a no-op`);
    }

    // I7 ---------------------------------------------------------------------------------------------------------
    const entry = o.memory.sources[SOURCE_ID];
    if (!entry) {
        add('I7', 'the delta memory holds no record for the source');
    } else {
        if (new Set(entry.seenIds).size !== entry.seenIds.length) add('I7', 'seenIds contains a duplicate id');
        const seen = new Set(entry.seenIds);
        for (const id of a.byId.keys()) if (!seen.has(id)) add('I7', `delivered record ${id} is missing from the delta memory`);
        for (const record of o.finalRecords) {
            if (!seen.has(record.id)) add('I7', `upstream record ${record.id} is missing from the delta memory`);
            else if (!Object.prototype.hasOwnProperty.call(entry.fingerprints, record.id) || entry.fingerprints[record.id] !== record.fingerprint) add('I7', `memory holds ${String(entry.fingerprints[record.id])} for ${record.id}, expected ${record.fingerprint}`);
        }
    }
    if (o.journalLeft > 0 || o.durableKeys.some((key) => key.startsWith('journal.'))) add('I7', `the delivery journal still holds ${o.journalLeft} entr(ies) after the final run`);
    for (const stats of o.stats) {
        if (stats.maxJournalEntries > CHECKPOINT_EVERY_ROWS) add('I7', `attempt ${stats.attempt}: a journal write held ${stats.maxJournalEntries} entries, more than one checkpoint window (${CHECKPOINT_EVERY_ROWS})`);
    }

    // I8 ---------------------------------------------------------------------------------------------------------
    for (const stats of o.stats) {
        if (stats.budgetMicro !== null && stats.spentMicro > 0) {
            // the budget is shared with the spend the platform booked out of band; only the router's own charges are judged
            const booked = stats.outOfBandMicro + stats.spentMicro;
            if (booked - stats.lastChargeMicro > stats.budgetMicro) add('I8', `attempt ${stats.attempt}: a charge was honoured while the run was already over its budget (booked ${booked}, budget ${stats.budgetMicro} micro-USD)`);
            if (booked > stats.budgetMicro + MAX_PRICE_MICRO) add('I8', `attempt ${stats.attempt}: booked ${booked} micro-USD against a budget of ${stats.budgetMicro}, more than one event over`);
        }
        if (stats.callsAfterLimit > 0) add('I8', `attempt ${stats.attempt}: ${stats.callsAfterLimit} billable call(s) after the platform had signalled the budget limit`);
    }
    return violations;
}

// ------------------------------------------------------------------------------------------------------------------
// Reporting
// ------------------------------------------------------------------------------------------------------------------

interface Metrics {
    attempts: number;
    faultsArmed: Map<FaultKind, number>;
    faultsFired: Map<FaultKind, number>;
    pushes: number;
    repeatedRows: number;
    unbilledRows: number;
    lostHits: number;
    hitCharges: number;
    journalRecoveries: number;
    /** Largest number of rows that ONE fired fault of this kind made a later run deliver again (attempts in which it was the only fault that fired). */
    maxRepeatPerFault: Map<FaultKind, number>;
    /** Rows delivered again later, summed per kind, over the attempts in which that kind was the only fault that fired. */
    repeatedByKind: Map<FaultKind, number>;
    /** Pushed-but-unbilled rows, summed per kind, over the attempts in which that kind was the only fault that fired. */
    unbilledByKind: Map<FaultKind, number>;
    /** Attempts in which two or more faults fired. */
    multiFaultAttempts: number;
    /** Attempts in which a lost journal write met a lost checkpoint write, and how many of them lost the row in flight. */
    journalCheckpointCoincidences: number;
    coincidencesThatLostARow: number;
}

function bump<K>(map: Map<K, number>, key: K, by: number): void {
    map.set(key, (map.get(key) ?? 0) + by);
}

function measure(o: ScenarioOutcome): Metrics {
    const a = analyse(o);
    const metrics: Metrics = {
        attempts: o.traces.length,
        faultsArmed: new Map(),
        faultsFired: new Map(),
        pushes: o.dataset.length,
        repeatedRows: a.repeatedRows,
        unbilledRows: a.unbilled.length,
        lostHits: 0,
        hitCharges: a.hitCharges.reduce((sum, n) => sum + n, 0),
        journalRecoveries: o.traces.reduce((sum, trace) => sum + trace.journalRecoveries, 0),
        maxRepeatPerFault: new Map(),
        repeatedByKind: new Map(),
        unbilledByKind: new Map(),
        multiFaultAttempts: 0,
        journalCheckpointCoincidences: 0,
        coincidencesThatLostARow: 0,
    };
    const unbilledPerAttempt = new Map<number, number>();
    for (const entry of a.unbilled) bump(unbilledPerAttempt, entry.attempt, 1);
    for (const stats of o.stats) {
        for (const armed of stats.faults) bump(metrics.faultsArmed, armed.fault.kind, 1);
        const fired = firedFaults(stats);
        for (const fault of fired) bump(metrics.faultsFired, fault.kind, 1);
        const lost = a.lostByAttempt[stats.attempt] ?? 0;
        const only = fired.length === 1 ? fired[0] : undefined;
        if (only) {
            metrics.maxRepeatPerFault.set(only.kind, Math.max(metrics.maxRepeatPerFault.get(only.kind) ?? 0, lost));
            bump(metrics.repeatedByKind, only.kind, lost);
            bump(metrics.unbilledByKind, only.kind, unbilledPerAttempt.get(stats.attempt) ?? 0);
        }
        if (fired.length >= 2) metrics.multiFaultAttempts += 1;
        if (journalAndCheckpointLost(fired)) {
            metrics.journalCheckpointCoincidences += 1;
            if (lost > 0) metrics.coincidencesThatLostARow += 1;
        }
        metrics.lostHits += Math.max(0, (a.matchPushes[stats.attempt] ?? 0) - (a.hitCharges[stats.attempt] ?? 0) - (a.limitSkips[stats.attempt] ?? 0));
    }
    return metrics;
}

function describePlan(o: ScenarioOutcome): string {
    const { plan } = o;
    const budget = plan.budgetMicro === null ? 'none' : `${plan.budgetMicro / 1_000_000} USD/run`;
    return `mode=${plan.mode} records=${plan.records.length}${plan.duplicates.length > 0 ? `+${plan.duplicates.length} repeated` : ''} watch=${plan.watch.kind} budget=${budget} churn=${plan.churn} faultedAttempts=${plan.faultedAttempts} faultsPerAttempt=${plan.faultsPerAttempt}`;
}

function describeTrace(o: ScenarioOutcome): string {
    return o.traces
        .map((trace) => {
            const fault = trace.faults.length > 0 ? trace.faults.map((armed) => `${describeFault(armed.fault)} ${armed.fired ? `FIRED(${armed.firedAt})` : 'unfired'}`).join(' + ') : 'no fault';
            const extra = [trace.churned > 0 ? `churn=${trace.churned}` : '', trace.outOfBandMicro > 0 ? `out-of-band=${trace.outOfBandMicro}` : '', trace.stoppedOnChargeLimit ? 'budget-stop' : '', trace.journalRecoveries > 0 ? 'journal-recovery' : ''].filter(Boolean).join(',');
            return `a${trace.attempt}[${trace.phase}] ${fault} -> ${trace.outcome} pushes=${trace.pushes}${extra ? ` (${extra})` : ''}`;
        })
        .join(' | ');
}

function failureMessage(o: ScenarioOutcome, violations: readonly Violation[]): string {
    const shown = violations.slice(0, 6).map((v) => `  ${v.invariant} (${INVARIANTS[v.invariant]}): ${v.message}`);
    const more = violations.length > shown.length ? [`  ... and ${violations.length - shown.length} more`] : [];
    return [`SEED ${o.seed}: ${describePlan(o)}`, ...shown, ...more, `  fault trace: ${describeTrace(o)}`, `  replay: runScenario(${o.seed}) in test/stress.atomicity_chaos.test.ts`].join('\n');
}

// ------------------------------------------------------------------------------------------------------------------
// The simulator must be faithful, or none of the rest is evidence
// ------------------------------------------------------------------------------------------------------------------

describe('chaos platform: the simulator itself', () => {
    const newPlatform = () => new ChaosPlatform({ seed: 1, prices: PRICES });
    const row = (id: string, extra: Record<string, unknown> = {}) => ({ record_id: id, ...extra });

    it('mulberry32 is deterministic, uniform enough, and seed-sensitive', () => {
        const first = mulberry32(42);
        const second = mulberry32(42);
        const a = Array.from({ length: 1000 }, () => first());
        expect(a).toEqual(Array.from({ length: 1000 }, () => second()));
        expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
        const mean = a.reduce((sum, x) => sum + x, 0) / a.length;
        expect(mean).toBeGreaterThan(0.45);
        expect(mean).toBeLessThan(0.55);
        const other = mulberry32(43);
        expect(Array.from({ length: 5 }, () => other())).not.toEqual(a.slice(0, 5));
    });

    it('emit pushes first and charges second: a failing charge leaves a pushed, unbilled row', async () => {
        const platform = newPlatform();
        platform.beginAttempt(0, { kind: 'charge_fail', position: 2, target: 'any', applied: true }, null);
        const sinks = platform.sinks();
        await expect(sinks.emit(row('a'), 'doc-new')).resolves.toEqual({ emitted: true, limitReached: false });
        await expect(sinks.emit(row('b'), 'doc-new')).rejects.toBeInstanceOf(PlatformFault);
        const stats = platform.endAttempt();
        expect(platform.dataset.map((e) => [e.record_id, e.charged])).toEqual([['a', true], ['b', false]]);
        expect(platform.ledger.get('doc-new')).toBe(1);
        expect(stats.fired).toBe(true);
    });

    it('follows the SDK budget rules: push, charge, signal the limit, overcharge by one, then trim', async () => {
        const platform = newPlatform();
        // 0.025 USD at 0.01 per row: two rows fit, the budget is then below one more event (limit signalled on the second)
        platform.beginAttempt(0, null, toMicro(0.025));
        const first = await platform.emit(row('1'), 'doc-new');
        const second = await platform.emit(row('2'), 'doc-new');
        expect(first).toEqual({ emitted: true, limitReached: false });
        expect(second).toEqual({ emitted: true, limitReached: true });
        // the SDK pushes and bills ONE more row on purpose when the budget is used up but not exceeded ...
        const third = await platform.emit(row('3'), 'doc-new');
        expect(third).toEqual({ emitted: true, limitReached: true });
        // ... and trims every row after that: strictly over budget
        const fourth = await platform.emit(row('4'), 'doc-new');
        expect(fourth).toEqual({ emitted: false, limitReached: true });
        const stats = platform.endAttempt();
        expect(platform.dataset.map((e) => e.record_id)).toEqual(['1', '2', '3']);
        expect(stats.spentMicro).toBe(toMicro(0.03));
        // a hit charge follows the same rules: refused once strictly over budget
        platform.beginAttempt(1, null, toMicro(0.04));
        await platform.emit(row('5'), 'doc-new');
        const hit = await platform.billing.charge(WATCHLIST_HIT_EVENT, 1);
        expect(hit).toEqual({ chargedCount: 1, eventChargeLimitReached: true });
        const refused = await platform.billing.charge(WATCHLIST_HIT_EVENT, 1);
        expect(refused).toEqual({ chargedCount: 0, eventChargeLimitReached: true });
    });

    it('a hard kill discards every later write; the next attempt starts with only what was durable', async () => {
        const platform = newPlatform();
        platform.beginAttempt(0, { kind: 'kill_after_charge', position: 2, target: 'any', applied: true }, null);
        const sinks = platform.sinks();
        await sinks.store.saveSource?.('s', { seenIds: ['a'], fingerprints: { a: 'v0' }, lastRunAt: 't' });
        await sinks.emit(row('a'), 'doc-new');
        await expect(sinks.emit(row('b'), 'doc-new')).rejects.toBeInstanceOf(KillSignal);
        expect(platform.killed).toBe(true);
        // what a router `finally` block would try after the kill: all of it is silently dropped
        await sinks.store.saveSource?.('s', { seenIds: ['b', 'a'], fingerprints: { a: 'v0', b: 'v0' }, lastRunAt: 't2' });
        await sinks.store.saveJournal?.('s', [{ recordId: 'b', fingerprint: 'v0' }]);
        await sinks.billing.charge(WATCHLIST_HIT_EVENT, 1);
        await sinks.emit(row('c'), 'doc-new');
        platform.endAttempt();
        expect(platform.dataset.map((e) => e.record_id)).toEqual(['a', 'b']);
        expect(platform.ledger.get('doc-new')).toBe(2);
        expect(platform.ledger.get(WATCHLIST_HIT_EVENT)).toBeUndefined();

        platform.beginAttempt(1, null, null);
        expect(platform.killed).toBe(false);
        const reopened = platform.openStore();
        expect((await reopened.load()).sources.s?.seenIds).toEqual(['a']);
        expect(await reopened.loadJournal('s')).toEqual([]);
    });

    it('a kill can land after a write (the write is durable) and a failing write can be applied or lost', async () => {
        const platform = newPlatform();
        platform.beginAttempt(0, { kind: 'kill_after_journal', position: 1, target: 'any', applied: true }, null);
        await expect(platform.sinks().store.saveJournal?.('s', [{ recordId: 'a', fingerprint: 'v0' }])).rejects.toBeInstanceOf(KillSignal);
        platform.endAttempt();
        expect(platform.durableJournal('s')).toEqual([{ recordId: 'a', fingerprint: 'v0' }]);

        platform.beginAttempt(1, { kind: 'kv_journal_write_fail', position: 1, target: 'any', applied: false }, null);
        await expect(platform.sinks().store.saveJournal?.('s', [{ recordId: 'b', fingerprint: 'v0' }])).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect(platform.durableJournal('s')).toEqual([{ recordId: 'a', fingerprint: 'v0' }]);

        platform.beginAttempt(2, { kind: 'kv_journal_write_fail', position: 1, target: 'any', applied: true }, null);
        await expect(platform.sinks().store.saveJournal?.('s', [{ recordId: 'c', fingerprint: 'v0' }])).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect(platform.durableJournal('s')).toEqual([{ recordId: 'c', fingerprint: 'v0' }]);
    });

    it('kill_before_charge leaves a pushed, UNBILLED row; kill_after_charge leaves a pushed, billed one', async () => {
        const platform = newPlatform();
        platform.beginAttempt(0, { kind: 'kill_before_charge', position: 2, target: 'any', applied: true }, null);
        await platform.emit(row('a'), 'doc-new');
        await expect(platform.emit(row('b'), 'doc-new')).rejects.toBeInstanceOf(KillSignal);
        platform.endAttempt();
        expect(platform.dataset.map((e) => [e.record_id, e.charged])).toEqual([['a', true], ['b', false]]);
        expect(platform.ledger.get('doc-new')).toBe(1);

        platform.beginAttempt(1, { kind: 'kill_after_charge', position: 1, target: 'any', applied: true }, null);
        await expect(platform.emit(row('c'), 'doc-new')).rejects.toBeInstanceOf(KillSignal);
        platform.endAttempt();
        expect(platform.dataset.map((e) => [e.record_id, e.charged])).toEqual([['a', true], ['b', false], ['c', true]]);
        expect(platform.ledger.get('doc-new')).toBe(2);
    });

    it('kill_after_state_write lands the checkpoint (the journal clear that should follow never happens); a failing checkpoint write is applied or lost', async () => {
        const platform = newPlatform();
        const entry = { seenIds: ['a'], fingerprints: { a: 'v0' }, lastRunAt: 't' };
        platform.beginAttempt(0, { kind: 'kill_after_state_write', position: 1, target: 'any', applied: true }, null);
        const sinks = platform.sinks();
        await sinks.store.saveJournal?.('s', [{ recordId: 'a', fingerprint: 'v0' }]);
        await expect(sinks.store.saveSource?.('s', entry)).rejects.toBeInstanceOf(KillSignal);
        await sinks.store.saveJournal?.('s', []);
        platform.endAttempt();
        const reopened = platform.openStore();
        expect((await reopened.load()).sources.s?.seenIds).toEqual(['a']);
        expect(await reopened.loadJournal('s')).toEqual([{ recordId: 'a', fingerprint: 'v0' }]);

        platform.beginAttempt(1, { kind: 'kv_state_write_fail', position: 1, target: 'any', applied: false }, null);
        await expect(platform.sinks().store.saveSource?.('s', { ...entry, seenIds: ['b', 'a'] })).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect((await platform.openStore().load()).sources.s?.seenIds).toEqual(['a']);

        platform.beginAttempt(2, { kind: 'kv_state_write_fail', position: 1, target: 'any', applied: true }, null);
        await expect(platform.sinks().store.saveSource?.('s', { ...entry, seenIds: ['c', 'a'] })).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect((await platform.openStore().load()).sources.s?.seenIds).toEqual(['c', 'a']);
    });

    it('a failing watchlist-hit charge is applied (lost acknowledgement) or not; a kill after it keeps the charge', async () => {
        const platform = newPlatform();
        platform.beginAttempt(0, { kind: 'hit_charge_fail', position: 1, target: 'any', applied: true }, null);
        await expect(platform.billing.charge(WATCHLIST_HIT_EVENT, 1)).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect(platform.ledger.get(WATCHLIST_HIT_EVENT)).toBe(1);

        platform.beginAttempt(1, { kind: 'hit_charge_fail', position: 1, target: 'any', applied: false }, null);
        await expect(platform.billing.charge(WATCHLIST_HIT_EVENT, 1)).rejects.toBeInstanceOf(PlatformFault);
        platform.endAttempt();
        expect(platform.ledger.get(WATCHLIST_HIT_EVENT)).toBe(1);

        platform.beginAttempt(2, { kind: 'kill_after_hit_charge', position: 1, target: 'any', applied: true }, null);
        await expect(platform.billing.charge(WATCHLIST_HIT_EVENT, 1)).rejects.toBeInstanceOf(KillSignal);
        platform.endAttempt();
        expect(platform.ledger.get(WATCHLIST_HIT_EVENT)).toBe(2);
    });

    it('spend booked out of band counts against the budget: over it the first row is trimmed, exactly at it one more row is pushed on purpose', async () => {
        const platform = newPlatform();
        // strictly over: nothing is pushed or charged, and the platform says the limit is reached
        platform.beginAttempt(0, null, toMicro(0.03), toMicro(0.031));
        await expect(platform.emit(row('a'), 'doc-new')).resolves.toEqual({ emitted: false, limitReached: true });
        await expect(platform.billing.charge(WATCHLIST_HIT_EVENT, 1)).resolves.toEqual({ chargedCount: 0, eventChargeLimitReached: true });
        const over = platform.endAttempt();
        expect(platform.dataset).toHaveLength(0);
        expect(over.spentMicro).toBe(0);
        expect(over.outOfBandMicro).toBe(toMicro(0.031));

        // exactly used up: the SDK pushes and bills ONE row anyway, then trims
        platform.beginAttempt(1, null, toMicro(0.03), toMicro(0.03));
        await expect(platform.emit(row('b'), 'doc-new')).resolves.toEqual({ emitted: true, limitReached: true });
        await expect(platform.emit(row('c'), 'doc-new')).resolves.toEqual({ emitted: false, limitReached: true });
        platform.endAttempt();
        expect(platform.dataset.map((e) => e.record_id)).toEqual(['b']);

        // half spent: one row of 0.01 still fits, and the limit is signalled on it (0.005 left)
        platform.beginAttempt(2, null, toMicro(0.03), toMicro(0.015));
        await expect(platform.emit(row('d'), 'doc-new')).resolves.toEqual({ emitted: true, limitReached: true });
        platform.endAttempt();
    });
});

// ------------------------------------------------------------------------------------------------------------------
// Directed scenarios: the documented guarantees, at exact positions, through the same runner and checker
// ------------------------------------------------------------------------------------------------------------------

describe('chaos directed scenarios (the delivery model, at exact fault positions)', () => {
    const base: RunOptions = { recordCount: 60, mode: 'onlyNew', watch: 'none', budget: 'none', churn: 0 };
    const at = (kind: FaultKind, position: number, extra: Partial<Fault> = {}): Fault => ({ kind, position, target: 'any', applied: true, ...extra });

    it('a hard kill right after a push repeats AND re-bills only the one row in flight, and loses none', async () => {
        const outcome = await runScenario(1, { ...base, faults: [at('kill_after_charge', 40)] });
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        const metrics = measure(outcome);
        expect(metrics.repeatedRows).toBe(1);
        expect(metrics.pushes).toBe(61);
        expect(outcome.dataset.filter((entry) => entry.charged)).toHaveLength(61);
        expect(outcome.traces[0]?.outcome).toBe('killed');
        expect(outcome.traces[1]?.journalRecoveries).toBe(1);
    });

    it('the same kill with a checkpoint-only store repeats every row since the last checkpoint (15, as documented)', async () => {
        const outcome = await runScenario(1, { ...base, faults: [at('kill_after_charge', 40)], wrapStore: checkpointOnly });
        const metrics = measure(outcome);
        expect(metrics.repeatedRows).toBe(15);
        expect(checkInvariants(outcome).map((v) => v.invariant)).toContain('I3');
    });

    it('a kill after the journal write repeats nothing, and a kill before a push repeats nothing', async () => {
        for (const kind of ['kill_after_journal', 'kill_before_push'] as const) {
            const outcome = await runScenario(2, { ...base, faults: [at(kind, 31)] });
            expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
            expect(measure(outcome).repeatedRows, kind).toBe(0);
            expect(measure(outcome).pushes, kind).toBe(60);
        }
    });

    it('a platform error mid-run repeats nothing; a failing charge repeats exactly the pushed row and leaves one unbilled push', async () => {
        const failed = await runScenario(3, { ...base, recordCount: 10, faults: [at('push_fail', 8)] });
        expect(checkInvariants(failed)).toEqual([]);
        expect(measure(failed).repeatedRows).toBe(0);
        expect(measure(failed).pushes).toBe(10);

        const uncharged = await runScenario(3, { ...base, recordCount: 10, faults: [at('charge_fail', 8)] });
        expect(checkInvariants(uncharged)).toEqual([]);
        expect(measure(uncharged).repeatedRows).toBe(1);
        expect(measure(uncharged).unbilledRows).toBe(1);
        expect(measure(uncharged).pushes).toBe(11);
    });

    it('a failed checkpoint or journal write is survivable: the journal or the rewritten checkpoint remembers every row', async () => {
        for (const fault of [at('kv_state_write_fail', 1, { applied: false }), at('kv_state_write_fail', 2, { applied: true }), at('kv_journal_write_fail', 30, { applied: false }), at('kill_after_state_write', 2)]) {
            const outcome = await runScenario(4, { ...base, faults: [fault] });
            expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
            expect(measure(outcome).repeatedRows, describeFault(fault)).toBe(0);
        }
    });

    it('fails closed on a lost journal write: no further billable row is pushed, so a second fault armed right behind it is never reached', async () => {
        // journal write #5 is row 5's; the kill is armed for the very next push. A router that carried on after the failed
        // journal write would push row 6, die before journalling either row, and repeat TWO rows on the next run.
        const outcome = await runScenario(7, { ...base, faults: [[at('kv_journal_write_fail', 5, { applied: false }), at('kill_after_charge', 6)]] });
        expect(outcome.stats[0]?.faults.map((armed) => armed.fired)).toEqual([true, false]);
        expect(outcome.traces[0]?.outcome).toBe('error');
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        expect(measure(outcome).repeatedRows).toBe(0);
        expect(measure(outcome).pushes).toBe(60);
    });

    it('a watchlist-hit lost to a failed or killed charge is never billed twice: one hit missing, no row repeated', async () => {
        for (const fault of [at('hit_charge_fail', 1, { applied: false }), at('kill_after_journal', 1, { target: 'hit_row' })]) {
            const outcome = await runScenario(5, { ...base, watch: 'valid', faults: [fault] });
            expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
            const metrics = measure(outcome);
            expect(metrics.repeatedRows, describeFault(fault)).toBe(0);
            expect(metrics.lostHits, describeFault(fault)).toBe(1);
            expect(outcome.stats[0]?.fired, describeFault(fault)).toBe(true);
        }
        const survived = await runScenario(5, { ...base, watch: 'valid', faults: [at('kill_after_hit_charge', 1)] });
        expect(checkInvariants(survived)).toEqual([]);
        expect(measure(survived).lostHits).toBe(0);
        expect(measure(survived).repeatedRows).toBe(0);
    });

    it('a budget stops the run and loses nothing; the rest is delivered by the following runs, once', async () => {
        const outcome = await runScenario(6, { ...base, recordCount: 40, budget: 'random', faultedAttempts: 0 });
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        expect(measure(outcome).pushes).toBe(40);
        expect(outcome.dataset.every((entry) => entry.charged)).toBe(true);
    });

    it('spend booked out of band trims the very first row: nothing is pushed, nothing is marked delivered, the next runs deliver every record once', async () => {
        const over = await runScenario(8, { ...base, recordCount: 12, budgetUsd: 0.03, faults: [[]], outOfBand: [toMicro(0.031)] });
        expect(checkInvariants(over), failureMessage(over, checkInvariants(over))).toEqual([]);
        expect(over.traces[0]?.outcome).toBe('completed');
        expect(over.traces[0]?.stoppedOnChargeLimit).toBe(true);
        expect(over.stats[0]?.pushes).toBe(0);
        expect(over.dataset.every((entry) => entry.attempt > 0)).toBe(true);
        expect(measure(over).pushes).toBe(12);
        expect(measure(over).repeatedRows).toBe(0);

        // exactly used up out of band: the SDK pushes and bills ONE more row on purpose, and the router stops on it
        const exact = await runScenario(8, { ...base, recordCount: 12, budgetUsd: 0.03, faults: [[]], outOfBand: [toMicro(0.03)] });
        expect(checkInvariants(exact), failureMessage(exact, checkInvariants(exact))).toEqual([]);
        expect(exact.stats[0]?.pushes).toBe(1);
        expect(exact.traces[0]?.stoppedOnChargeLimit).toBe(true);
        expect(measure(exact).pushes).toBe(12);
    });

    it('the journal stays one checkpoint window long however many rows a run delivers: a kill at row 1060 of 1100 repeats only the row in flight', async () => {
        const outcome = await runScenario(9, { ...base, recordCount: 1100, faults: [at('kill_after_charge', 1060)] });
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        expect(measure(outcome).repeatedRows).toBe(1);
        expect(measure(outcome).pushes).toBe(1101);
        expect(outcome.stats[0]?.maxJournalEntries).toBeLessThanOrEqual(CHECKPOINT_EVERY_ROWS);
        expect(outcome.stats[0]?.maxJournalEntries).toBeGreaterThan(CHECKPOINT_EVERY_ROWS - 3);
    });

    it('an upstream that lists a record twice in one answer still delivers and bills it once, from its first listing', async () => {
        const outcome = await runScenario(11, { ...base, recordCount: 20, duplicates: [0, 3, 3, 19], faults: [] });
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        expect(outcome.fetchedCounts[0]).toBe(24);
        expect(measure(outcome).pushes).toBe(20);
        expect(outcome.dataset.every((entry) => entry.row.fp === 'v0')).toBe(true);
        expect(outcome.memory.sources[SOURCE_ID]?.fingerprints.r000).toBe('v0');
    });

    it('without a journal a failed checkpoint is retried in the finally block and repeats nothing, but a failed FINAL checkpoint repeats the rows since the last one (10 of 60): the journal is what closes that gap', async () => {
        const retried = await runScenario(10, { ...base, faults: [at('kv_state_write_fail', 1, { applied: false })], wrapStore: checkpointOnly });
        expect(checkInvariants(retried), failureMessage(retried, checkInvariants(retried))).toEqual([]);
        expect(retried.traces[0]?.outcome).toBe('error');
        expect(measure(retried).repeatedRows).toBe(0);
        expect(measure(retried).pushes).toBe(60);

        // checkpoints land at rows 25 and 50 and in the finally block (state writes 1, 2, 3): lose the third
        const finalLost = { ...base, faults: [at('kv_state_write_fail', 3, { applied: false })] };
        const withoutJournal = await runScenario(10, { ...finalLost, wrapStore: checkpointOnly });
        expect(withoutJournal.stats[0]?.fired).toBe(true);
        expect(measure(withoutJournal).repeatedRows).toBe(10);
        expect(checkInvariants(withoutJournal).map((v) => v.invariant)).toContain('I3');

        const withJournal = await runScenario(10, finalLost);
        expect(withJournal.stats[0]?.fired).toBe(true);
        expect(checkInvariants(withJournal), failureMessage(withJournal, checkInvariants(withJournal))).toEqual([]);
        expect(measure(withJournal).repeatedRows).toBe(0);
    });

    it('two coincident failures: a lost journal write met by a lost checkpoint write loses exactly the row in flight, never more', async () => {
        // row 5's journal write is lost (the run stops, fail closed); the finally checkpoint (state write 1) is lost as well
        const outcome = await runScenario(12, { ...base, faults: [[at('kv_journal_write_fail', 5, { applied: false }), at('kv_state_write_fail', 1, { applied: false })]] });
        expect(outcome.stats[0]?.faults.map((armed) => armed.fired)).toEqual([true, true]);
        expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
        expect(measure(outcome).repeatedRows).toBe(1);
        expect(measure(outcome).coincidencesThatLostARow).toBe(1);
        expect(measure(outcome).pushes).toBe(61);
    });

    it('a failure in the final checkpoint never masks the error that ended the run, and never fails a run that was otherwise complete', async () => {
        // the push of row 5 fails, and the checkpoint of the finally block (state write 1) fails too: the caller must see the PUSH error
        const masked = await runScenario(13, { ...base, faults: [[at('push_fail', 5), at('kv_state_write_fail', 1, { applied: false })]] });
        expect(masked.stats[0]?.faults.map((armed) => armed.fired)).toEqual([true, true]);
        expect(masked.traces[0]?.outcome).toBe('error');
        expect(masked.traces[0]?.detail).toMatch(/dataset push failed/u);
        expect(checkInvariants(masked), failureMessage(masked, checkInvariants(masked))).toEqual([]);

        // all 60 rows are delivered and the final checkpoint (state write 3) fails: the run still completes, and says so in its log
        const complete = await runScenario(13, { ...base, faults: [at('kv_state_write_fail', 3, { applied: false })] });
        expect(complete.stats[0]?.fired).toBe(true);
        expect(complete.traces[0]?.outcome).toBe('completed');
        expect(complete.traces[0]?.detail).toMatch(/could not persist delta memory/u);
        expect(checkInvariants(complete), failureMessage(complete, checkInvariants(complete))).toEqual([]);
    });

    it('a scenario is fully determined by its seed: the replay reproduces the trace, the dataset and the books', async () => {
        const one = await runScenario(777);
        const two = await runScenario(777);
        expect(describeTrace(two)).toBe(describeTrace(one));
        expect(two.dataset.map((e) => [e.record_id, e.event, e.charged, e.attempt])).toEqual(one.dataset.map((e) => [e.record_id, e.event, e.charged, e.attempt]));
        expect([...two.ledger]).toEqual([...one.ledger]);
        expect(describeTrace(await runScenario(778))).not.toBe(describeTrace(one));
    });
});

// ------------------------------------------------------------------------------------------------------------------
// The randomized campaign
// ------------------------------------------------------------------------------------------------------------------

/**
 * A campaign is a block of seeds run through the same runner and checker. `single` arms one fault per attempt (the
 * guarantees as documented); `multi` arms two or three coincident faults, which is where a failure handler is most likely
 * to hide a second bug (a failed checkpoint met by a failed retry, a lost journal write met by a kill on the next push).
 */
interface Campaign {
    name: 'single' | 'multi';
    firstSeed: number;
    scenarios: number;
    options: (seed: number) => RunOptions;
}

const CHUNK_SIZE = 150;
const CAMPAIGNS: Readonly<Record<Campaign['name'], Campaign>> = {
    single: { name: 'single', firstSeed: SEED_BASE + 1, scenarios: 1800, options: () => ({}) },
    multi: { name: 'multi', firstSeed: SEED_BASE + 200_001, scenarios: 900, options: (seed) => ({ faultsPerAttempt: 2 + (seed % 2) }) },
};

interface Totals {
    scenarios: number;
    attempts: number;
    faultsArmed: Map<FaultKind, number>;
    faultsFired: Map<FaultKind, number>;
    pushes: number;
    repeatedRows: number;
    unbilledRows: number;
    lostHits: number;
    hitCharges: number;
    journalRecoveries: number;
    maxRepeatPerFault: Map<FaultKind, number>;
    repeatedByKind: Map<FaultKind, number>;
    unbilledByKind: Map<FaultKind, number>;
    byMode: Map<DeltaMode, number>;
    byWatch: Map<WatchKind, number>;
    withBudget: number;
    withChurn: number;
    withOutOfBand: number;
    withDuplicates: number;
    multiFaultAttempts: number;
    journalCheckpointCoincidences: number;
    coincidencesThatLostARow: number;
}

function emptyTotals(): Totals {
    return {
        scenarios: 0,
        attempts: 0,
        faultsArmed: new Map(),
        faultsFired: new Map(),
        pushes: 0,
        repeatedRows: 0,
        unbilledRows: 0,
        lostHits: 0,
        hitCharges: 0,
        journalRecoveries: 0,
        maxRepeatPerFault: new Map(),
        repeatedByKind: new Map(),
        unbilledByKind: new Map(),
        byMode: new Map(),
        byWatch: new Map(),
        withBudget: 0,
        withChurn: 0,
        withOutOfBand: 0,
        withDuplicates: 0,
        multiFaultAttempts: 0,
        journalCheckpointCoincidences: 0,
        coincidencesThatLostARow: 0,
    };
}

function addCounts<K>(into: Map<K, number>, from: ReadonlyMap<K, number>, combine: (a: number, b: number) => number = (a, b) => a + b): void {
    for (const [key, value] of from) into.set(key, combine(into.get(key) ?? 0, value));
}

/** Folds `from` into `into`. `maxRepeatPerFault` combines by maximum, everything else by sum. */
function mergeTotals(into: Totals, from: Totals): void {
    into.scenarios += from.scenarios;
    into.attempts += from.attempts;
    addCounts(into.faultsArmed, from.faultsArmed);
    addCounts(into.faultsFired, from.faultsFired);
    addCounts(into.maxRepeatPerFault, from.maxRepeatPerFault, Math.max);
    addCounts(into.repeatedByKind, from.repeatedByKind);
    addCounts(into.unbilledByKind, from.unbilledByKind);
    addCounts(into.byMode, from.byMode);
    addCounts(into.byWatch, from.byWatch);
    into.pushes += from.pushes;
    into.repeatedRows += from.repeatedRows;
    into.unbilledRows += from.unbilledRows;
    into.lostHits += from.lostHits;
    into.hitCharges += from.hitCharges;
    into.journalRecoveries += from.journalRecoveries;
    into.withBudget += from.withBudget;
    into.withChurn += from.withChurn;
    into.withOutOfBand += from.withOutOfBand;
    into.withDuplicates += from.withDuplicates;
    into.multiFaultAttempts += from.multiFaultAttempts;
    into.journalCheckpointCoincidences += from.journalCheckpointCoincidences;
    into.coincidencesThatLostARow += from.coincidencesThatLostARow;
}

function accumulate(totals: Totals, o: ScenarioOutcome, metrics: Metrics): void {
    totals.scenarios += 1;
    totals.attempts += metrics.attempts;
    addCounts(totals.faultsArmed, metrics.faultsArmed);
    addCounts(totals.faultsFired, metrics.faultsFired);
    addCounts(totals.maxRepeatPerFault, metrics.maxRepeatPerFault, Math.max);
    addCounts(totals.repeatedByKind, metrics.repeatedByKind);
    addCounts(totals.unbilledByKind, metrics.unbilledByKind);
    totals.pushes += metrics.pushes;
    totals.repeatedRows += metrics.repeatedRows;
    totals.unbilledRows += metrics.unbilledRows;
    totals.lostHits += metrics.lostHits;
    totals.hitCharges += metrics.hitCharges;
    totals.journalRecoveries += metrics.journalRecoveries;
    totals.multiFaultAttempts += metrics.multiFaultAttempts;
    totals.journalCheckpointCoincidences += metrics.journalCheckpointCoincidences;
    totals.coincidencesThatLostARow += metrics.coincidencesThatLostARow;
    totals.byMode.set(o.plan.mode, (totals.byMode.get(o.plan.mode) ?? 0) + 1);
    totals.byWatch.set(o.plan.watch.kind, (totals.byWatch.get(o.plan.watch.kind) ?? 0) + 1);
    if (o.plan.budgetMicro !== null) totals.withBudget += 1;
    if (o.plan.churn > 0 && o.plan.faultedAttempts > 1) totals.withChurn += 1;
    if (o.traces.some((trace) => trace.outOfBandMicro > 0)) totals.withOutOfBand += 1;
    if (o.fetchedCounts.some((count) => count > o.plan.records.length)) totals.withDuplicates += 1;
}

interface ChunkResult {
    totals: Totals;
    failures: string[];
}

async function executeChunk(campaign: Campaign, index: number): Promise<ChunkResult> {
    const result: ChunkResult = { totals: emptyTotals(), failures: [] };
    for (let n = 0; n < CHUNK_SIZE; n += 1) {
        const seed = campaign.firstSeed + index * CHUNK_SIZE + n;
        const outcome = await runScenario(seed, campaign.options(seed));
        const violations = checkInvariants(outcome);
        accumulate(result.totals, outcome, measure(outcome));
        if (violations.length > 0) result.failures.push(failureMessage(outcome, violations));
    }
    return result;
}

const chunkCache = new Map<string, Promise<ChunkResult>>();
function chunk(campaign: Campaign, index: number): Promise<ChunkResult> {
    const key = `${campaign.name}:${index}`;
    let cached = chunkCache.get(key);
    if (!cached) {
        cached = executeChunk(campaign, index);
        chunkCache.set(key, cached);
    }
    return cached;
}

async function campaignTotals(campaign: Campaign): Promise<Totals> {
    const totals = emptyTotals();
    const chunks = await Promise.all(Array.from({ length: campaign.scenarios / CHUNK_SIZE }, (_, index) => chunk(campaign, index)));
    for (const result of chunks) mergeTotals(totals, result.totals);
    return totals;
}

const asObject = (map: ReadonlyMap<string, number>): Record<string, number> => Object.fromEntries([...map].sort(([x], [y]) => x.localeCompare(y)));
const sumOf = (map: ReadonlyMap<string, number>): number => [...map.values()].reduce((sum, n) => sum + n, 0);

/** Repeating faults (the only ones that may make a later run deliver a row again) and the unbilling ones, as the single-fault campaign must show them. */
const NON_REPEATING_KINDS: readonly FaultKind[] = FAULT_KINDS.filter((kind) => !REPEATING_KINDS.has(kind));
const NON_UNBILLING_KINDS: readonly FaultKind[] = FAULT_KINDS.filter((kind) => !UNBILLING_KINDS.has(kind));

describe('chaos campaign: randomized fault injection against billing and state atomicity', () => {
    const single = CAMPAIGNS.single;
    for (let index = 0; index < single.scenarios / CHUNK_SIZE; index += 1) {
        const first = single.firstSeed + index * CHUNK_SIZE;
        it(`seeds ${first}-${first + CHUNK_SIZE - 1}: invariants I1-I8 hold after every scenario`, async () => {
            const { failures, totals } = await chunk(single, index);
            expect(totals.scenarios).toBe(CHUNK_SIZE);
            expect(failures.slice(0, 5)).toEqual([]);
        }, 300_000);
    }

    it('actually exercised what it claims to: every fault kind fired, journals were recovered, budgets, out-of-band spend, repeated upstream ids and churn were in play', async () => {
        const totals = await campaignTotals(single);
        expect(totals.scenarios).toBeGreaterThanOrEqual(1500);
        for (const kind of FAULT_KINDS) expect(totals.faultsFired.get(kind) ?? 0, `fault kind ${kind} fired`).toBeGreaterThanOrEqual(150);
        const armed = sumOf(totals.faultsArmed);
        const fired = sumOf(totals.faultsFired);
        expect(fired / armed).toBeGreaterThan(0.6);
        // the campaign must have produced every effect the invariants bound, or they were never put under load
        expect(totals.repeatedRows).toBeGreaterThan(100);
        expect(totals.unbilledRows).toBeGreaterThan(50);
        expect(totals.lostHits).toBeGreaterThan(20);
        expect(totals.hitCharges).toBeGreaterThan(500);
        expect(totals.journalRecoveries).toBeGreaterThan(500);
        for (const mode of DELTA_MODES) expect(totals.byMode.get(mode) ?? 0).toBeGreaterThan(300);
        expect(totals.byWatch.get('poisoned') ?? 0).toBeGreaterThan(200);
        expect(totals.withBudget).toBeGreaterThan(400);
        expect(totals.withChurn).toBeGreaterThan(400);
        expect(totals.withOutOfBand).toBeGreaterThan(100);
        expect(totals.withDuplicates).toBeGreaterThan(300);
        // the headline guarantee: one kill never repeats more than the one row in flight
        for (const kind of KILL_KINDS) expect(totals.maxRepeatPerFault.get(kind) ?? 0, `largest repeat of one ${kind}`).toBeLessThanOrEqual(1);
        // and the effect of each fault kind is the documented one, not merely that it fired: a row is repeated only after a
        // charge_fail / kill_before_charge / kill_after_charge, and left unbilled only after a charge_fail / kill_before_charge
        for (const kind of REPEATING_KINDS) expect(totals.repeatedByKind.get(kind) ?? 0, `rows repeated after a lone ${kind}`).toBeGreaterThanOrEqual(100);
        for (const kind of NON_REPEATING_KINDS) expect(totals.repeatedByKind.get(kind) ?? 0, `rows repeated after a lone ${kind}`).toBe(0);
        for (const kind of UNBILLING_KINDS) expect(totals.unbilledByKind.get(kind) ?? 0, `rows left unbilled by a lone ${kind}`).toBeGreaterThanOrEqual(100);
        for (const kind of NON_UNBILLING_KINDS) expect(totals.unbilledByKind.get(kind) ?? 0, `rows left unbilled by a lone ${kind}`).toBe(0);

        if (process.env.CHAOS_REPORT === '1') {
            console.info(
                `CHAOS_REPORT ${JSON.stringify({
                    seedBase: SEED_BASE,
                    scenariosRun: totals.scenarios,
                    attempts: totals.attempts,
                    scenariosByMode: asObject(totals.byMode),
                    scenariosByWatchlist: asObject(totals.byWatch),
                    scenariosWithBudget: totals.withBudget,
                    scenariosWithOutOfBandSpend: totals.withOutOfBand,
                    scenariosWithRepeatedUpstreamIds: totals.withDuplicates,
                    scenariosWithChurn: totals.withChurn,
                    faultsArmedPerKind: asObject(totals.faultsArmed),
                    faultsInjectedPerKind: asObject(totals.faultsFired),
                    faultsInjectedTotal: fired,
                    totalPushes: totals.pushes,
                    totalRepeatedRows: totals.repeatedRows,
                    totalUnbilledRows: totals.unbilledRows,
                    totalLostWatchlistHits: totals.lostHits,
                    totalWatchlistHitCharges: totals.hitCharges,
                    journalRecoveries: totals.journalRecoveries,
                    largestRepeatPerFaultByKind: asObject(totals.maxRepeatPerFault),
                    repeatedRowsAfterALoneFaultByKind: asObject(totals.repeatedByKind),
                    unbilledRowsAfterALoneFaultByKind: asObject(totals.unbilledByKind),
                })}`,
            );
        }
    }, 300_000);
});

describe('chaos multi-fault campaign: two or three coincident faults per attempt', () => {
    const multi = CAMPAIGNS.multi;
    for (let index = 0; index < multi.scenarios / CHUNK_SIZE; index += 1) {
        const first = multi.firstSeed + index * CHUNK_SIZE;
        it(`seeds ${first}-${first + CHUNK_SIZE - 1}: invariants I1-I8 hold, and no attempt ever loses more than one row`, async () => {
            const { failures, totals } = await chunk(multi, index);
            expect(totals.scenarios).toBe(CHUNK_SIZE);
            expect(failures.slice(0, 5)).toEqual([]);
        }, 300_000);
    }

    it('actually put coincident faults under load: pairs fired, and a lost journal write did meet a lost checkpoint write', async () => {
        const totals = await campaignTotals(multi);
        expect(totals.scenarios).toBeGreaterThanOrEqual(800);
        for (const kind of FAULT_KINDS) expect(totals.faultsFired.get(kind) ?? 0, `fault kind ${kind} fired`).toBeGreaterThanOrEqual(100);
        expect(totals.multiFaultAttempts).toBeGreaterThan(500);
        expect(totals.repeatedRows).toBeGreaterThan(100);
        // the one carve-out of I3 is real: the coincidence happened, and it did lose the row in flight (and only that one row)
        expect(totals.journalCheckpointCoincidences).toBeGreaterThanOrEqual(10);
        expect(totals.coincidencesThatLostARow).toBeGreaterThanOrEqual(5);
        expect(totals.journalRecoveries).toBeGreaterThan(500);
        if (process.env.CHAOS_REPORT === '1') {
            console.info(
                `CHAOS_REPORT_MULTI ${JSON.stringify({
                    seedBase: SEED_BASE,
                    scenariosRun: totals.scenarios,
                    attempts: totals.attempts,
                    faultsInjectedPerKind: asObject(totals.faultsFired),
                    faultsInjectedTotal: sumOf(totals.faultsFired),
                    attemptsWithTwoOrMoreFiredFaults: totals.multiFaultAttempts,
                    totalRepeatedRows: totals.repeatedRows,
                    lostJournalMeetsLostCheckpointAttempts: totals.journalCheckpointCoincidences,
                    ofWhichLostTheRowInFlight: totals.coincidencesThatLostARow,
                })}`,
            );
        }
    }, 300_000);
});

// ------------------------------------------------------------------------------------------------------------------
// Negative controls: the invariants must be able to fail
// ------------------------------------------------------------------------------------------------------------------

/** The pre-journal store: whole-memory checkpoints only. */
function checkpointOnly(store: ApifyDeltaStore): DeltaStore {
    return { load: () => store.load(), save: (state) => store.save(state), saveSource: (source, entry) => store.saveSource(source, entry) };
}

/** A store that advertises journal support but silently drops every journal write. */
function journalWritesDropped(store: ApifyDeltaStore): DeltaStore {
    return {
        load: () => store.load(),
        save: (state) => store.save(state),
        saveSource: (source, entry) => store.saveSource(source, entry),
        loadJournal: (source) => store.loadJournal(source),
        saveJournal: async () => {},
    };
}

/** A sinks wrapper that bills every pushed row a second time. */
function doubleCharging(sinks: RunSinks): RunSinks {
    return {
        ...sinks,
        async emit(row, eventName) {
            const result = await sinks.emit(row, eventName);
            if (result.emitted && eventName !== undefined) await sinks.billing.charge(eventName, 1);
            return result;
        },
    };
}

describe('chaos negative controls (the invariants can fail, and they fail for the right reason)', () => {
    /** Kill scenarios on big enough sources that more than one checkpoint window is at stake. */
    const killRuns: RunOptions = { recordRange: [40, 120], mode: 'onlyNew', watch: 'none', budget: 'none', churn: 0, allowedKinds: ['kill_before_push', 'kill_before_charge', 'kill_after_charge'] };
    const NC_SEEDS = Array.from({ length: 60 }, (_, index) => 5001 + index);

    it('1. a checkpoint-only store (no journal) lets one kill repeat many rows: the harness observes it and I3 reports it', async () => {
        let flagged = 0;
        let largest = 0;
        for (const seed of NC_SEEDS) {
            const clean = await runScenario(seed, killRuns);
            expect(checkInvariants(clean), failureMessage(clean, checkInvariants(clean))).toEqual([]);

            const broken = await runScenario(seed, { ...killRuns, wrapStore: checkpointOnly });
            const violations = checkInvariants(broken);
            if (violations.some((v) => v.invariant === 'I3')) flagged += 1;
            for (const kind of KILL_KINDS) largest = Math.max(largest, measure(broken).maxRepeatPerFault.get(kind) ?? 0);
            // only the journal-less run can show a kill repeating more than the one row in flight
            expect(Math.max(0, ...KILL_KINDS.map((kind) => measure(clean).maxRepeatPerFault.get(kind) ?? 0))).toBeLessThanOrEqual(1);
        }
        expect(flagged).toBeGreaterThan(0);
        expect(largest).toBeGreaterThan(1);
        expect(largest).toBeLessThanOrEqual(CHECKPOINT_EVERY_ROWS);
        if (process.env.CHAOS_REPORT === '1') console.info(`CHAOS_REPORT_NC1 ${JSON.stringify({ scenarios: NC_SEEDS.length, scenariosFlaggedI3: flagged, largestRepeatOfOneKill: largest })}`);
    }, 300_000);

    it('2. a sinks wrapper that double-charges every pushed row makes I2 fail on every scenario', async () => {
        let flagged = 0;
        for (const seed of NC_SEEDS.slice(0, 40)) {
            const opt: RunOptions = { budget: 'none', watch: 'none' };
            const clean = await runScenario(seed, opt);
            expect(checkInvariants(clean), failureMessage(clean, checkInvariants(clean))).toEqual([]);

            const broken = await runScenario(seed, { ...opt, wrapSinks: doubleCharging });
            const violations = checkInvariants(broken);
            expect(
                violations.some((v) => v.invariant === 'I2'),
                `double charging must violate I2 (seed ${seed}); got ${violations.map((v) => v.invariant).join(',') || 'nothing'}`,
            ).toBe(true);
            expect(violations.some((v) => v.invariant === 'I2' && /charged ".*" \d+ time\(s\) but \d+ pushed row/u.test(v.message))).toBe(true);
            flagged += 1;
        }
        if (process.env.CHAOS_REPORT === '1') console.info(`CHAOS_REPORT_NC2 ${JSON.stringify({ scenarios: 40, scenariosFlaggedI2: flagged })}`);
    }, 300_000);

    it('3. a store whose saveJournal silently drops writes makes I3 fail, exactly like having no journal', async () => {
        let flagged = 0;
        let largest = 0;
        for (const seed of NC_SEEDS) {
            const broken = await runScenario(seed, { ...killRuns, wrapStore: journalWritesDropped });
            const violations = checkInvariants(broken);
            if (violations.some((v) => v.invariant === 'I3')) flagged += 1;
            for (const kind of KILL_KINDS) largest = Math.max(largest, measure(broken).maxRepeatPerFault.get(kind) ?? 0);
        }
        expect(flagged).toBeGreaterThan(0);
        expect(largest).toBeGreaterThan(1);
        if (process.env.CHAOS_REPORT === '1') console.info(`CHAOS_REPORT_NC3 ${JSON.stringify({ scenarios: NC_SEEDS.length, scenariosFlaggedI3: flagged, largestRepeatOfOneKill: largest })}`);
    }, 300_000);

    it('4. the other invariants fail on a deliberately corrupted outcome (each checker is wired to something)', async () => {
        const good = await runScenario(9001, { recordCount: 30, mode: 'onlyChanged', watch: 'valid', budget: 'none', faultedAttempts: 0 });
        expect(checkInvariants(good)).toEqual([]);
        const entries = good.dataset;
        const matching = entries.find((entry) => entry.row.is_watchlist_match === true);
        expect(matching).toBeDefined();

        // I1: a delivered row vanishes from the dataset
        expect(checkInvariants({ ...good, dataset: entries.slice(1) }).map((v) => v.invariant)).toContain('I1');
        // I3: a row delivered twice with nothing to explain it
        const duplicated = entries.concat([{ ...(entries[0] as DatasetEntry), attempt: good.probeAttempt }]);
        expect(checkInvariants({ ...good, dataset: duplicated }).map((v) => v.invariant)).toContain('I3');
        // I4: a pushed row that was never charged
        const unbilled = entries.map((entry, index) => (index === 0 ? { ...entry, charged: false } : entry));
        expect(checkInvariants({ ...good, dataset: unbilled }).map((v) => v.invariant)).toContain('I4');
        // I5: a watchlist-hit charge on a poisoned list
        const poisoned = { ...good, plan: { ...good.plan, watch: { ...good.plan.watch, needles: [] as string[] } } };
        expect(checkInvariants(poisoned).map((v) => v.invariant)).toContain('I5');
        // I6: the probe run delivered something
        const probed = entries.concat([{ ...(entries[0] as DatasetEntry), attempt: good.probeAttempt }]);
        expect(checkInvariants({ ...good, dataset: probed }).map((v) => v.invariant)).toContain('I6');
        // I7: the delta memory forgot a delivered record, and a journal was left behind
        expect(checkInvariants({ ...good, memory: { version: 2, sources: {} } }).map((v) => v.invariant)).toContain('I7');
        expect(checkInvariants({ ...good, journalLeft: 3 }).map((v) => v.invariant)).toContain('I7');
        // I8: a run that spent far beyond its budget
        const overspent = good.stats.map((stats, index) => (index === 0 ? { ...stats, budgetMicro: 10, spentMicro: 10 * MAX_PRICE_MICRO, lastChargeMicro: 1 } : stats));
        expect(checkInvariants({ ...good, stats: overspent }).map((v) => v.invariant)).toContain('I8');
    });

    it('5. every individual check inside the checker is wired to something: a minimal tampering of a good outcome trips exactly that check', async () => {
        const fixture = (mode: DeltaMode) => runScenario(9002, { recordCount: 60, mode, watch: 'valid', budget: 'none', faultedAttempts: 0, duplicates: [] });
        const byMode = { onlyChanged: await fixture('onlyChanged'), all: await fixture('all'), onlyNew: await fixture('onlyNew') };
        for (const outcome of Object.values(byMode)) {
            expect(checkInvariants(outcome), failureMessage(outcome, checkInvariants(outcome))).toEqual([]);
            expect(outcome.completingAttempt).toBe(0);
            expect(outcome.probeAttempt).toBe(1);
        }
        const changed = byMode.onlyChanged;
        const matching = changed.dataset.filter((entry) => entry.attempt === 0 && entry.row.is_watchlist_match === true);
        expect(matching.length).toBeGreaterThanOrEqual(3);
        const firstMatch = changed.dataset.findIndex((entry) => entry.row.is_watchlist_match === true);
        const firstPlain = changed.dataset.findIndex((entry) => entry.row.is_watchlist_match !== true);
        const firstPlainNoOverride = changed.dataset.findIndex((entry) => entry.row.is_watchlist_match !== true && changed.finalRecords.find((record) => record.id === entry.record_id)?.billingEvent === undefined);
        expect(Math.min(firstMatch, firstPlain, firstPlainNoOverride)).toBeGreaterThanOrEqual(0);

        const kind = (name: FaultKind, extra: Partial<Fault> = {}): Fault => ({ kind: name, position: 1, target: 'any', applied: true, ...extra });
        const patchStats = (o: ScenarioOutcome, attempt: number, patch: Partial<AttemptStats>): ScenarioOutcome => ({
            ...o,
            stats: o.stats.map((stats, index) => (index === attempt ? { ...stats, chargesByEvent: new Map(stats.chargesByEvent), ...patch } : stats)),
        });
        const withFired = (...faults: Fault[]): Partial<AttemptStats> => ({ faults: faults.map((fault) => ({ fault, fired: true, firedAt: 'tampered' })), fault: faults[0] ?? null, fired: faults.length > 0 });
        const patchEntry = (o: ScenarioOutcome, index: number, patch: Partial<DatasetEntry>): ScenarioOutcome => ({ ...o, dataset: o.dataset.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) });
        const patchRow = (o: ScenarioOutcome, index: number, row: Record<string, unknown>): ScenarioOutcome => patchEntry(o, index, { row: { ...(o.dataset[index] as DatasetEntry).row, ...row } });
        const repeatOf = (o: ScenarioOutcome, index: number, attempt: number, times = 1): ScenarioOutcome => ({ ...o, dataset: [...o.dataset, ...Array.from({ length: times }, () => ({ ...(o.dataset[index] as DatasetEntry), attempt }))] });
        const hits = (o: ScenarioOutcome): number => o.stats[0]?.chargesByEvent.get(WATCHLIST_HIT_EVENT) ?? 0;
        const setHits = (o: ScenarioOutcome, n: number, extra: Partial<AttemptStats> = {}): ScenarioOutcome => {
            const stats = o.stats[0] as AttemptStats;
            const chargesByEvent = new Map(stats.chargesByEvent);
            chargesByEvent.set(WATCHLIST_HIT_EVENT, n);
            return patchStats(o, 0, { chargesByEvent, ...extra });
        };
        const patchSummary = (o: ScenarioOutcome, patch: (summary: RunSummary) => RunSummary): ScenarioOutcome => {
            const summaries = new Map(o.summaries);
            summaries.set(0, patch(summaries.get(0) as RunSummary));
            return { ...o, summaries };
        };
        const dropRecord = (o: ScenarioOutcome, id: string): ScenarioOutcome => ({ ...o, dataset: o.dataset.filter((entry) => entry.record_id !== id) });
        const forget = (o: ScenarioOutcome, id: string): ScenarioOutcome => {
            const entry = o.memory.sources[SOURCE_ID] as DeltaState['sources'][string];
            return { ...o, memory: { version: 2, sources: { [SOURCE_ID]: { ...entry, seenIds: entry.seenIds.filter((seen) => seen !== id) } } } };
        };
        const firstId = (o: ScenarioOutcome): string => (o.finalRecords[0] as { id: string }).id;
        const probeEntries = (o: ScenarioOutcome): number[] => o.dataset.flatMap((entry, index) => (entry.attempt === o.probeAttempt ? [index] : []));
        const budgeted = (o: ScenarioOutcome, patch: Partial<AttemptStats>): ScenarioOutcome => patchStats(o, 0, { budgetMicro: 1000, ...patch });
        const N = hits(changed);

        interface Tamper {
            name: string;
            apply: () => ScenarioOutcome;
            trips: ReadonlyArray<readonly [InvariantId, RegExp]>;
            quiet?: ReadonlyArray<readonly [InvariantId, RegExp]>;
        }
        const tampers: Tamper[] = [
            { name: 'a trace that crashed', apply: () => ({ ...changed, traces: changed.traces.map((trace, index) => (index === 0 ? { ...trace, outcome: 'crashed' as const, detail: 'boom' } : trace)) }), trips: [['X', /unexpected exception: boom/u]] },
            { name: 'a billable call after the kill', apply: () => patchStats(changed, 0, { callsAfterKill: 2 }), trips: [['X', /2 call\(s\) reached the platform after the simulated kill/u]] },

            { name: 'I1 the settle phase never completes', apply: () => ({ ...changed, completed: false }), trips: [['I1', /never completed/u]] },
            { name: 'I1 onlyChanged: a record never delivered', apply: () => dropRecord(changed, firstId(changed)), trips: [['I1', /was never delivered/u]] },
            { name: 'I1 onlyNew: a record never delivered', apply: () => dropRecord(byMode.onlyNew, firstId(byMode.onlyNew)), trips: [['I1', /was never delivered/u]] },
            {
                name: 'I1 all: a record missing from the completing run (its probe row does not count)',
                apply: () => ({ ...byMode.all, dataset: byMode.all.dataset.filter((entry) => !(entry.record_id === firstId(byMode.all) && entry.attempt === 0)) }),
                trips: [['I1', /was never delivered/u]],
            },
            { name: 'I1 a row for a record the upstream does not have', apply: () => ({ ...changed, dataset: [...changed.dataset, { ...(changed.dataset[0] as DatasetEntry), record_id: 'ghost' }] }), trips: [['I1', /ghost was pushed but that record is not in the upstream/u]] },
            { name: 'I1 onlyChanged delivers an unchanged row', apply: () => patchRow(changed, 0, { delta_status: 'unchanged' }), trips: [['I1', /onlyChanged delivered a unchanged row/u]] },
            { name: 'I1 onlyNew delivers an updated row', apply: () => patchRow(byMode.onlyNew, 0, { delta_status: 'updated' }), trips: [['I1', /onlyNew delivered a updated row/u]] },

            {
                name: 'I2 the platform charged an event once more than its pushed rows carry',
                apply: () => patchStats(changed, 0, { chargesByEvent: new Map([...(changed.stats[0] as AttemptStats).chargesByEvent, ['doc-new', ((changed.stats[0] as AttemptStats).chargesByEvent.get('doc-new') ?? 0) + 1]]) }),
                trips: [['I2', /charged "doc-new" \d+ time\(s\) but \d+ pushed row/u]],
            },
            { name: 'I2 the run summary over-reports the rows it emitted', apply: () => patchSummary(changed, (summary) => ({ ...summary, totalEmitted: summary.totalEmitted + 1 })), trips: [['I2', /the run summary reports \d+ emitted row\(s\) but the platform stored \d+/u]] },
            { name: 'I2 the source summary over-reports the rows it emitted', apply: () => patchSummary(changed, (summary) => ({ ...summary, sources: summary.sources.map((source) => ({ ...source, emitted: source.emitted + 1 })) })), trips: [['I2', /the source summary reports \d+ emitted row\(s\) but the platform stored \d+/u]] },
            { name: 'I2 the source summary over-reports the watchlist hits', apply: () => patchSummary(changed, (summary) => ({ ...summary, sources: summary.sources.map((source) => ({ ...source, watchlistHits: source.watchlistHits + 1 })) })), trips: [['I2', /the source summary reports \d+ watchlist hit\(s\) but \d+ pushed row\(s\) really match/u]] },
            { name: 'I2 the run summary over-reports the watchlist-hit charges', apply: () => patchSummary(changed, (summary) => ({ ...summary, watchlist: { ...summary.watchlist, hitsCharged: summary.watchlist.hitsCharged + 1 } })), trips: [['I2', /the run summary reports \d+ watchlist-hit charge\(s\) but the platform honoured \d+/u]] },
            { name: 'I2 the run summary claims a budget stop that never happened', apply: () => patchSummary(changed, (summary) => ({ ...summary, stoppedOnChargeLimit: true })), trips: [['I2', /stoppedOnChargeLimit=true but the platform did not signal the limit/u]] },
            { name: 'I2 a row billed at the wrong event', apply: () => patchEntry(changed, firstPlainNoOverride, { event: 'doc-updated' }), trips: [['I2', /was billed at "doc-updated", expected "doc-new"/u]] },

            { name: 'I3 a row delivered again after a fault that cannot repeat it', apply: () => patchStats(repeatOf(changed, 0, 1), 0, withFired(kind('kill_after_journal'))), trips: [['I3', /attempt 0 \(kill_after_journal@1\): 1 of its pushed rows were delivered again later, at most 0 allowed/u]] },
            { name: 'I3 a row delivered again in an attempt with no fault at all', apply: () => repeatOf(changed, 0, 1), trips: [['I3', /attempt 0 \(no fault fired\): 1 of its pushed rows were delivered again later, at most 0 allowed/u]] },
            { name: 'I3 two rows delivered again after one repeating fault', apply: () => patchStats(repeatOf(changed, 1, 1, 1), 0, withFired(kind('kill_after_charge'))), trips: [], quiet: [['I3', /delivered again later/u]] },
            {
                name: 'I3 ... but two rows lost to one repeating fault are too many',
                apply: () => patchStats(repeatOf(repeatOf(changed, 0, 1), 1, 1), 0, withFired(kind('kill_after_charge'))),
                trips: [['I3', /attempt 0 \(kill_after_charge@1\): 2 of its pushed rows were delivered again later, at most 1 allowed/u]],
            },
            {
                name: 'I3 a lost journal write met by a lost checkpoint write may lose one row',
                apply: () => patchStats(repeatOf(changed, 0, 1), 0, withFired(kind('kv_journal_write_fail', { applied: false }), kind('kv_state_write_fail', { applied: false }))),
                trips: [],
                quiet: [['I3', /delivered again later/u]],
            },
            {
                name: 'I3 ... but not when the checkpoint write had landed',
                apply: () => patchStats(repeatOf(changed, 0, 1), 0, withFired(kind('kv_journal_write_fail', { applied: false }), kind('kv_state_write_fail', { applied: true }))),
                trips: [['I3', /delivered again later, at most 0 allowed/u]],
            },
            {
                name: 'I3 ... nor when the journal write had landed',
                apply: () => patchStats(repeatOf(changed, 0, 1), 0, withFired(kind('kv_journal_write_fail', { applied: true }), kind('kv_state_write_fail', { applied: false }))),
                trips: [['I3', /delivered again later, at most 0 allowed/u]],
            },
            { name: 'I3 a row pushed twice inside one attempt', apply: () => repeatOf(changed, 0, 0), trips: [['I3', /1 row\(s\) were pushed twice inside a single attempt/u]] },
            { name: 'I3 (cross-check) more repeats than faults', apply: () => repeatOf(repeatOf(changed, 0, 1), 1, 1), trips: [['I3', /2 repeated deliveries but only 0 fault\(s\) were injected/u]] },

            { name: 'I4 a pushed row without its charge in a fault-free attempt', apply: () => patchEntry(changed, 0, { charged: false }), trips: [['I4', /attempt 0 left 1 pushed row\(s\) unbilled although it suffered: no fault fired/u]] },
            { name: 'I4 a pushed row without its charge after a fault that cannot cause it', apply: () => patchStats(patchEntry(changed, 0, { charged: false }), 0, withFired(kind('kill_after_charge'))), trips: [['I4', /left 1 pushed row\(s\) unbilled although it suffered: kill_after_charge@1/u]] },
            { name: 'I4 two unbilled rows after one unbilling fault', apply: () => patchStats(patchEntry(patchEntry(changed, 0, { charged: false }), 1, { charged: false }), 0, withFired(kind('kill_before_charge'))), trips: [['I4', /left 2 pushed row\(s\) unbilled/u]] },
            { name: 'I4 one unbilled row after an unbilling fault is allowed', apply: () => patchStats(patchEntry(changed, 0, { charged: false }), 0, withFired(kind('charge_fail'))), trips: [], quiet: [['I4', /unbilled/u]] },
            { name: 'I4 (cross-check) more unbilled rows than unbilling faults', apply: () => patchEntry(changed, 0, { charged: false }), trips: [['I4', /1 unbilled pushes but only 0 charge_fail \/ kill_before_charge fault\(s\) fired/u]] },
            { name: 'I4 a watchlist-hit never charged in a fault-free attempt', apply: () => setHits(changed, N - 1), trips: [['I4', /1 watchlist-hit\(s\) were never charged .* but no fault fired/u]] },
            { name: 'I4 two watchlist-hits lost to one fault are too many', apply: () => setHits(changed, N - 2, withFired(kind('hit_charge_fail', { applied: false }))), trips: [['I4', /2 watchlist-hit\(s\) were never charged .* but only: hit_charge_fail@1/u]] },
            { name: 'I4 one watchlist-hit lost to a fault is allowed', apply: () => setHits(changed, N - 1, withFired(kind('kill_after_journal'))), trips: [], quiet: [['I4', /watchlist-hit/u]] },

            { name: 'I5 a watchlist-hit charged on a list with no valid keyword', apply: () => ({ ...changed, plan: { ...changed.plan, watch: { kind: 'poisoned' as const, input: [''], needles: [] as string[] } } }), trips: [['I5', /\(no valid keyword\) yet \d+ watchlist-hit\(s\) were charged/u]] },
            { name: 'I5 more hits in the books than rows that really match', apply: () => ({ ...changed, ledger: new Map([...changed.ledger, [WATCHLIST_HIT_EVENT, (changed.ledger.get(WATCHLIST_HIT_EVENT) ?? 0) + 1]]) }), trips: [['I5', /watchlist-hit\(s\) charged for only \d+ pushes of rows that really contain a valid keyword/u]] },
            { name: 'I5 more hit charges in one attempt than matching pushes', apply: () => setHits(changed, matching.length + 1), trips: [['I5', /attempt 0: \d+ hit charge\(s\) for \d+ matching push/u]] },
            { name: 'I5 a matching row not flagged', apply: () => patchRow(changed, firstMatch, { is_watchlist_match: false }), trips: [['I5', /is_watchlist_match=false but the text contains a valid keyword/u]] },
            { name: 'I5 a non-matching row flagged', apply: () => patchRow(changed, firstPlain, { is_watchlist_match: true }), trips: [['I5', /is_watchlist_match=true but the text does not contain a valid keyword/u]] },
            { name: 'I5 a flagged row without its matched keyword', apply: () => patchRow(changed, firstMatch, { matched_watchlist_keyword: null }), trips: [['I5', /matched_watchlist_keyword=null disagrees with the oracle/u]] },

            { name: 'I6 the probe run did not complete', apply: () => ({ ...changed, traces: changed.traces.map((trace) => (trace.attempt === changed.probeAttempt ? { ...trace, outcome: 'error' as const } : trace)) }), trips: [['I6', /probe run did not complete/u]] },
            { name: 'I6 onlyChanged: the probe delivers a row', apply: () => repeatOf(changed, 0, changed.probeAttempt), trips: [['I6', /must be a no-op/u]] },
            { name: 'I6 all: the probe misses a record', apply: () => ({ ...byMode.all, dataset: byMode.all.dataset.filter((_, index) => index !== (probeEntries(byMode.all)[0] as number)) }), trips: [['I6', /deltaMode all: the probe pushed \d+ row\(s\)/u]] },
            { name: 'I6 all: the probe sends a row that is not unchanged', apply: () => patchRow(byMode.all, probeEntries(byMode.all)[0] as number, { delta_status: 'first_seen' }), trips: [['I6', /the probe delivered a row that was not "unchanged"/u]] },
            { name: 'I6 all: the probe leaves a row unbilled', apply: () => patchEntry(byMode.all, probeEntries(byMode.all)[0] as number, { charged: false }), trips: [['I6', /the probe left a pushed row unbilled/u]] },

            { name: 'I7 the delta memory holds nothing for the source', apply: () => ({ ...changed, memory: { version: 2 as const, sources: {} } }), trips: [['I7', /holds no record for the source/u]] },
            {
                name: 'I7 a duplicate id in seenIds',
                apply: () => {
                    const entry = changed.memory.sources[SOURCE_ID] as DeltaState['sources'][string];
                    return { ...changed, memory: { version: 2 as const, sources: { [SOURCE_ID]: { ...entry, seenIds: [...entry.seenIds, firstId(changed)] } } } };
                },
                trips: [['I7', /seenIds contains a duplicate id/u]],
            },
            { name: 'I7 an upstream record the memory forgot (never delivered either)', apply: () => forget(dropRecord(changed, firstId(changed)), firstId(changed)), trips: [['I7', /upstream record .* is missing from the delta memory/u]], quiet: [['I7', /delivered record .* is missing/u]] },
            { name: 'I7 a delivered record the memory forgot (and the upstream no longer lists)', apply: () => ({ ...forget(changed, firstId(changed)), finalRecords: changed.finalRecords.slice(1) }), trips: [['I7', /delivered record .* is missing from the delta memory/u]], quiet: [['I7', /upstream record .* is missing/u]] },
            {
                name: 'I7 the memory holds a stale fingerprint',
                apply: () => {
                    const entry = changed.memory.sources[SOURCE_ID] as DeltaState['sources'][string];
                    return { ...changed, memory: { version: 2 as const, sources: { [SOURCE_ID]: { ...entry, fingerprints: { ...entry.fingerprints, [firstId(changed)]: 'stale' } } } } };
                },
                trips: [['I7', /memory holds stale for/u]],
            },
            { name: 'I7 a journal left behind', apply: () => ({ ...changed, journalLeft: 3 }), trips: [['I7', /delivery journal still holds 3 entr/u]] },
            { name: 'I7 a journal key left behind', apply: () => ({ ...changed, durableKeys: [...changed.durableKeys, `journal.${CHAOS_NAMESPACE}.${SOURCE_ID}`] }), trips: [['I7', /delivery journal still holds/u]] },
            { name: 'I7 a journal write longer than one checkpoint window', apply: () => patchStats(changed, 0, { maxJournalEntries: CHECKPOINT_EVERY_ROWS + 1 }), trips: [['I7', /a journal write held 26 entries, more than one checkpoint window \(25\)/u]] },
            { name: 'I7 a journal write of exactly one window is fine', apply: () => patchStats(changed, 0, { maxJournalEntries: CHECKPOINT_EVERY_ROWS }), trips: [], quiet: [['I7', /checkpoint window/u]] },

            { name: 'I8 a charge honoured although the run was already over budget', apply: () => budgeted(changed, { spentMicro: 1000 + 30_000, lastChargeMicro: 5000 }), trips: [['I8', /honoured while the run was already over its budget/u]], quiet: [['I8', /more than one event over/u]] },
            { name: 'I8 one charge that overshoots the budget by more than the dearest event', apply: () => budgeted(changed, { spentMicro: 1000 + 2 * MAX_PRICE_MICRO, lastChargeMicro: 1000 + 2 * MAX_PRICE_MICRO }), trips: [['I8', /more than one event over/u]], quiet: [['I8', /already over its budget/u]] },
            { name: 'I8 a billable call after the limit signal', apply: () => patchStats(changed, 0, { callsAfterLimit: 1 }), trips: [['I8', /1 billable call\(s\) after the platform had signalled the budget limit/u]] },
            { name: 'I8 out-of-band spend over the budget makes ANY honoured charge a violation', apply: () => budgeted(changed, { outOfBandMicro: 2000, spentMicro: 100, lastChargeMicro: 100 }), trips: [['I8', /honoured while the run was already over its budget/u]] },
            { name: 'I8 out-of-band spend over the budget with nothing charged is the platform trimming correctly', apply: () => budgeted(changed, { outOfBandMicro: 2000, spentMicro: 0, lastChargeMicro: 0 }), trips: [], quiet: [['I8', /./u]] },
            { name: 'I8 out-of-band spend exactly at the budget lets ONE overcharge-by-one row through', apply: () => budgeted(changed, { outOfBandMicro: 1000, spentMicro: 10_000, lastChargeMicro: 10_000 }), trips: [], quiet: [['I8', /./u]] },
        ];

        expect(changed.stats.length - 1).toBe(changed.probeAttempt);
        for (const tamper of tampers) {
            const violations = checkInvariants(tamper.apply());
            for (const [invariant, message] of tamper.trips) {
                expect(
                    violations.some((v) => v.invariant === invariant && message.test(v.message)),
                    `${tamper.name}: expected ${invariant} ${String(message)}; got ${violations.map((v) => `${v.invariant}: ${v.message}`).join(' | ') || 'nothing'}`,
                ).toBe(true);
            }
            for (const [invariant, message] of tamper.quiet ?? []) {
                expect(
                    violations.filter((v) => v.invariant === invariant && message.test(v.message)).map((v) => v.message),
                    `${tamper.name}: ${invariant} ${String(message)} must stay quiet`,
                ).toEqual([]);
            }
        }
    });
});
