/**
 * INDEPENDENT AUDIT of the committed Pay-Per-Event artifacts.
 *
 * Everything here is re-derived from plain files and integer micro-USD (BigInt) arithmetic that is written in this
 * file. The test never calls pricing/build_put_payloads.ts or scripts/actor_files.ts to compute an expectation.
 * What it reads:
 *   - pricing/payloads/<engine>.put.json and <engine>.notice.json   (raw text, so price literals are checked as written);
 *   - <engine>/.actor/actor.json and input_schema.json              (memory, default hit caps);
 *   - the engine registries and pricing/event_catalog.ts            (imported ONLY as the objects being audited);
 *   - <engine>/connectors/*.ts                                      (source text, to find record-level billing overrides).
 *
 * The frozen tables below (GOLDEN) are the audit-time snapshot of every price and every exposure figure. They are
 * typed by hand from the catalog evidence and the brief, so a payload and a catalog that drift together are still caught.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { CHECKPOINT_EVERY_ROWS, type EngineDefinition } from '../lib/router_core.js';
import { ALL_PRICING, type EnginePricing, PATENTS_PRICING, RECORD_LEVEL_EVENTS, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';
import { collectEngineExposure, collectExposure, decimalToMicro, formatUsd, renderReport } from '../scripts/audit_pricing_exposure.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

const MICRO = 1_000_000n;
const DAY_MS = 86_400_000n;
const START = 'apify-actor-start';
const HIT = 'watchlist-hit';
const DATASET_ITEM = 'apify-default-dataset-item';

/** Exact decimal literal -> micro-USD. Throws on exponent notation, signs and more than 6 decimals. */
function micro(literal: string): bigint {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(literal);
    if (!m) throw new Error(`"${literal}" is not a plain decimal with at most 6 decimals`);
    return BigInt(m[1] ?? '0') * MICRO + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

/** Like {@link micro} but yields -1 for an invalid literal, so loading the files never throws and the named test reports it. */
function microOrInvalid(literal: string): bigint {
    try {
        return micro(literal);
    } catch {
        return -1n;
    }
}

/** USD with exactly 6 decimals, written independently of the script's formatter. */
function usd6(value: bigint): string {
    const whole = value / MICRO;
    const frac = (value % MICRO).toString().padStart(6, '0');
    return `${whole}.${frac}`;
}

function ceilDiv(a: bigint, b: bigint): bigint {
    return (a + b - 1n) / b;
}

function must<T>(value: T | undefined | null, what: string): T {
    if (value === undefined || value === null) throw new Error(`missing ${what}`);
    return value;
}

async function tsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await tsFiles(full)));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out.sort();
}

interface ChargeEvent {
    eventTitle: string;
    eventDescription: string;
    eventPriceUsd: number;
    isOneTimeEvent?: boolean;
    isPrimaryEvent?: boolean;
}

interface PricingRecord {
    pricingModel: string;
    pricingPerEvent: { actorChargeEvents: Record<string, ChargeEvent> };
    minimalMaxTotalChargeUsd: number;
    apifyMarginPercentage: number;
    createdAt: string;
    startedAt: string;
    reasonForChange: string;
}

interface Notice {
    engine: string;
    policy: string;
    noticeDays: number;
    hasPayingUsers: boolean;
    submittedAt: string;
    effectiveAt: string;
    changeLimit: string;
    startEventPriceUsd: number;
    startEventPerRunUsd: number;
    memoryMbytes: number;
    reasonForChange: string;
    provisionalEvents: string[];
    operatorStatedEvents: string[];
    notes: string[];
}

interface Golden {
    memoryMbytes: number;
    /** Event name -> price in micro-USD, typed by hand. Includes the start event and watchlist-hit. */
    prices: Record<string, bigint>;
    primary: string;
    basis: { legacy: number; provisional: number; operator: number };
    active: number;
    held: number;
    exposure: { emptyRun: bigint; dearestRow: bigint; oneRow: bigint; uncapped1000: bigint; capped1000: bigint; killWithJournal: bigint; killOldWindow: bigint };
}

interface Case {
    slug: string;
    engine: EngineDefinition;
    catalog: EnginePricing;
    golden: Golden;
}

const CASES: Case[] = [
    {
        slug: 'global-regtech-compliance-feed',
        engine: regtechEngine,
        catalog: REGTECH_PRICING,
        golden: {
            memoryMbytes: 2048,
            prices: {
                [START]: 5_000n,
                'vessel-record': 500n,
                'debarment-record': 3_000n,
                'statement-new': 20_000n,
                'statement-updated': 10_000n,
                'enforcement-release': 50_000n,
                'enforcement-update': 20_000n,
                'crawler-signal': 15_000n,
                'crawler-signal-change': 6_000n,
                'recall-record': 1_000n,
                [HIT]: 150_000n,
            },
            primary: 'vessel-record',
            basis: { legacy: 8, provisional: 1, operator: 1 },
            active: 6,
            held: 3,
            exposure: { emptyRun: 10_000n, dearestRow: 50_000n, oneRow: 200_000n, uncapped1000: 200_010_000n, capped1000: 80_010_000n, killWithJournal: 50_000n, killOldWindow: 5_000_000n },
        },
    },
    {
        slug: 'latam-global-tender-intelligence',
        engine: tendersEngine,
        catalog: TENDERS_PRICING,
        golden: {
            memoryMbytes: 1024,
            prices: {
                [START]: 5_000n,
                'tender-detail': 3_000n,
                'tender-summary': 1_000n,
                'notice-record': 1_000n,
                'notice-new': 20_000n,
                'notice-updated': 10_000n,
                'grant-new': 20_000n,
                'grant-updated': 8_000n,
                [HIT]: 150_000n,
            },
            primary: 'tender-detail',
            basis: { legacy: 6, provisional: 1, operator: 1 },
            active: 8,
            held: 7,
            exposure: { emptyRun: 5_000n, dearestRow: 20_000n, oneRow: 170_000n, uncapped1000: 170_005_000n, capped1000: 50_005_000n, killWithJournal: 20_000n, killOldWindow: 4_250_000n },
        },
    },
    {
        slug: 'global-corporate-patent-intelligence',
        engine: patentsEngine,
        catalog: PATENTS_PRICING,
        golden: {
            memoryMbytes: 1024,
            prices: {
                [START]: 5_000n,
                'patent-proceeding': 2_000n,
                'clinical-record': 2_000n,
                'uae-entity-new': 20_000n,
                'uae-entity-updated': 10_000n,
                'sg-entity-new': 30_000n,
                'sg-entity-updated': 10_000n,
                [HIT]: 150_000n,
            },
            primary: 'patent-proceeding',
            basis: { legacy: 4, provisional: 2, operator: 1 },
            active: 5,
            held: 0,
            exposure: { emptyRun: 5_000n, dearestRow: 30_000n, oneRow: 180_000n, uncapped1000: 180_005_000n, capped1000: 60_005_000n, killWithJournal: 30_000n, killOldWindow: 4_500_000n },
        },
    },
];

interface Facts {
    putText: string;
    noticeText: string;
    record: PricingRecord;
    notice: Notice;
    events: Record<string, ChargeEvent>;
    /** Price of every event as written in the file, in micro-USD (from the raw literal, never from a parsed float). */
    priceMicro: Map<string, bigint>;
    actor: { name: string; minMemoryMbytes: number; maxMemoryMbytes: number };
    inputSchema: { properties: Record<string, { default?: unknown }> };
}

function rawLiterals(text: string, key: string): string[] {
    return [...text.matchAll(new RegExp(`"${key}":\\s*([^,\\s}]+)`, 'gu'))].map((m) => m[1] ?? '');
}

async function loadFacts(c: Case): Promise<Facts> {
    const putText = await readFile(join(ROOT, 'pricing', 'payloads', `${c.slug}.put.json`), 'utf8');
    const noticeText = await readFile(join(ROOT, 'pricing', 'payloads', `${c.slug}.notice.json`), 'utf8');
    const put = JSON.parse(putText) as { pricingInfos: PricingRecord[] };
    const record = must(put.pricingInfos[0], `${c.slug} pricing record`);
    const events = record.pricingPerEvent.actorChargeEvents;
    const names = Object.keys(events);
    const literals = rawLiterals(putText, 'eventPriceUsd');
    if (names.length !== literals.length) throw new Error(`${c.slug}: ${names.length} events but ${literals.length} eventPriceUsd literals`);
    return {
        putText,
        noticeText,
        record,
        notice: JSON.parse(noticeText) as Notice,
        events,
        priceMicro: new Map(names.map((name, i) => [name, microOrInvalid(must(literals[i], 'literal'))])),
        actor: JSON.parse(await readFile(join(ROOT, c.slug, '.actor', 'actor.json'), 'utf8')),
        inputSchema: JSON.parse(await readFile(join(ROOT, c.slug, '.actor', 'input_schema.json'), 'utf8')),
    };
}

const FACTS = new Map<string, Facts>();
for (const c of CASES) FACTS.set(c.slug, await loadFacts(c));
const factsOf = (slug: string): Facts => must(FACTS.get(slug), `facts for ${slug}`);

/** Own derivation of the events an engine's ACTIVE connectors can bill (delta-class fallbacks written out here). */
function billableEvents(engine: EngineDefinition): Set<string> {
    const out = new Set<string>();
    for (const connector of engine.connectors) {
        if (connector.status !== 'active') continue;
        const base = connector.billing?.newEvent ?? 'result';
        out.add(base);
        out.add(connector.billing?.updatedEvent ?? base);
        out.add(connector.billing?.snapshotEvent ?? connector.billing?.updatedEvent ?? base);
    }
    for (const event of RECORD_LEVEL_EVENTS[engine.slug]) out.add(event);
    return out;
}

function startEventsFor(memoryMbytes: number): bigint {
    const gb = ceilDiv(BigInt(memoryMbytes), 1024n);
    return gb < 1n ? 1n : gb;
}

/** Words that mean "unfinished text". The two task markers are assembled so a repository scan for them does not match this file. */
const MARKER_WORDS = ['TO' + 'DO', 'FIX' + 'ME', 'TBD', 'XXX', 'lorem', 'ipsum', 'placeholder', 'changeme', 'undefined', 'null', 'NaN'];
const PLACEHOLDER = new RegExp(`\\b(${MARKER_WORDS.join('|')})\\b|\\[object|\\{\\{|\\}\\}|\\$\\{|<[A-Za-z][^>]*>`, 'iu');
const TASK_MARKERS = new RegExp(`${MARKER_WORDS[0]}|${MARKER_WORDS[1]}`, 'u');

function instant(value: string): bigint {
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    const ms = Date.parse(value);
    expect(Number.isFinite(ms)).toBe(true);
    expect(new Date(ms).toISOString()).toBe(value);
    return BigInt(ms);
}

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: committed Pay-Per-Event payload', (slug, c) => {
    const f = factsOf(slug);
    const { golden } = c;

    it('holds exactly one PAY_PER_EVENT record with the documented fields and nothing the platform stamps itself', () => {
        const put = JSON.parse(f.putText) as Record<string, unknown>;
        expect(Object.keys(put)).toEqual(['pricingInfos']);
        const infos = put.pricingInfos as Array<Record<string, unknown>>;
        expect(infos).toHaveLength(1);
        expect(infos.filter((i) => i.pricingModel === 'PAY_PER_EVENT')).toHaveLength(1);
        expect(Object.keys(f.record).sort()).toEqual(['apifyMarginPercentage', 'createdAt', 'minimalMaxTotalChargeUsd', 'pricingModel', 'pricingPerEvent', 'reasonForChange', 'startedAt']);
        for (const forbidden of ['notifiedAboutFutureChangeAt', 'notifiedAboutChangeAt', 'isPriceChangeNotificationSuppressed', 'forceContainsSignificantPriceChange']) {
            expect(f.putText, forbidden).not.toContain(forbidden);
        }
        expect(Object.keys(f.record.pricingPerEvent)).toEqual(['actorChargeEvents']);
        expect(f.putText.endsWith('\n')).toBe(true);
    });

    it('prices apify-actor-start at 0.005 inside 0.002-0.01 as a one-time, non-primary event', () => {
        const start = must(f.events[START], START);
        const startMicro = must(f.priceMicro.get(START), 'start price');
        expect(rawLiterals(f.putText, 'eventPriceUsd')[0]).toBe('0.005');
        expect(startMicro).toBe(5_000n);
        expect(startMicro >= 2_000n && startMicro <= 10_000n).toBe(true);
        expect(start.isOneTimeEvent).toBe(true);
        expect(start.isPrimaryEvent).toBeUndefined();
        expect(Object.keys(f.events)[0]).toBe(START);
    });

    it('prices exactly the events its active connectors can bill, plus watchlist-hit and apify-actor-start (no orphan, no unpriced event)', () => {
        const billable = billableEvents(c.engine);
        expect(billable.has('result')).toBe(false);
        for (const connector of c.engine.connectors.filter((x) => x.status === 'active')) {
            expect(connector.billing?.newEvent, `${connector.id} has no newEvent`).toBeDefined();
        }
        const expected = [...billable, HIT, START].sort();
        expect(Object.keys(f.events).sort()).toEqual(expected);
        expect(Object.keys(f.events)).not.toContain(DATASET_ITEM);
        expect(Object.keys(f.events)).not.toContain('result');
    });

    it('keeps the catalog billing map aligned with the registry: one entry per active source, none for held sources', () => {
        const activeIds = c.engine.connectors.filter((x) => x.status === 'active').map((x) => x.id).sort();
        const heldIds = c.engine.connectors.filter((x) => x.status === 'held').map((x) => x.id);
        expect(Object.keys(c.catalog.sourceBilling).sort()).toEqual(activeIds);
        expect(activeIds).toHaveLength(golden.active);
        expect(heldIds).toHaveLength(golden.held);
        for (const id of heldIds) expect(c.catalog.sourceBilling[id], id).toBeUndefined();
        for (const connector of c.engine.connectors.filter((x) => x.status === 'held')) expect(connector.billing, connector.id).toBeUndefined();
    });

    it('marks exactly one primary event, and it is a source event (not the start event, not watchlist-hit)', () => {
        const primaries = Object.entries(f.events).filter(([, e]) => e.isPrimaryEvent !== undefined);
        expect(primaries).toHaveLength(1);
        const [name, event] = must(primaries[0], 'primary');
        expect(event.isPrimaryEvent).toBe(true);
        expect(name).toBe(golden.primary);
        expect(name).not.toBe(START);
        expect(name).not.toBe(HIT);
        expect(billableEvents(c.engine).has(name)).toBe(true);
        expect(c.catalog.events.filter((e) => e.primary).map((e) => e.name)).toEqual([name]);
    });

    it('writes every price as a plain decimal literal: finite, positive, at most 6 decimals, at most 10 USD', () => {
        const literals = rawLiterals(f.putText, 'eventPriceUsd');
        expect(literals).toHaveLength(Object.keys(f.events).length);
        for (const literal of literals) {
            expect(literal, literal).toMatch(/^\d+(\.\d{1,6})?$/u);
            const value = micro(literal);
            expect(value > 0n, literal).toBe(true);
            expect(value <= 10n * MICRO, literal).toBe(true);
        }
        for (const [name, event] of Object.entries(f.events)) {
            expect(typeof event.eventPriceUsd, name).toBe('number');
            expect(Number.isFinite(event.eventPriceUsd), name).toBe(true);
            expect(BigInt(Math.round(event.eventPriceUsd * 1e6)), name).toBe(must(f.priceMicro.get(name), name));
        }
    });

    it('gives every event a clean, unique title and a clean description, with the documented key set', () => {
        const titles = new Set<string>();
        for (const [name, event] of Object.entries(f.events)) {
            expect(Object.keys(event).every((k) => ['eventTitle', 'eventDescription', 'eventPriceUsd', 'isOneTimeEvent', 'isPrimaryEvent'].includes(k)), name).toBe(true);
            expect(name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
            for (const text of [event.eventTitle, event.eventDescription]) {
                expect(typeof text, name).toBe('string');
                expect(text.trim().length, name).toBeGreaterThan(0);
                expect(text, name).toBe(text.trim());
                expect(text, name).not.toMatch(PLACEHOLDER);
            }
            expect(event.eventTitle.length, name).toBeLessThanOrEqual(80);
            expect(event.eventDescription.length, name).toBeLessThanOrEqual(500);
            expect(titles.has(event.eventTitle), `duplicate title ${event.eventTitle}`).toBe(false);
            titles.add(event.eventTitle);
            if (name !== START) expect(event.isOneTimeEvent, name).toBeUndefined();
        }
        expect(f.putText).not.toMatch(TASK_MARKERS);
        expect(f.noticeText).not.toMatch(TASK_MARKERS);
    });

    it('stamps createdAt and startedAt as canonical ISO instants exactly 14 days apart (Store Publishing Terms section 9.4)', () => {
        const created = instant(f.record.createdAt);
        const started = instant(f.record.startedAt);
        expect(started - created).toBe(14n * DAY_MS);
        expect(f.notice.noticeDays).toBe(14);
        expect(f.notice.hasPayingUsers).toBe(true);
        expect(f.notice.submittedAt).toBe(f.record.createdAt);
        expect(f.notice.effectiveAt).toBe(f.record.startedAt);
    });

    it('sets minimalMaxTotalChargeUsd to start price x GB plus the dearest non-start event, rounded up to the cent, never below 0.10', () => {
        const startMicro = must(f.priceMicro.get(START), 'start');
        const nonStart = [...f.priceMicro.entries()].filter(([name]) => name !== START).map(([, value]) => value);
        const dearest = nonStart.reduce((a, b) => (b > a ? b : a));
        expect(dearest).toBe(150_000n);
        const exact = startMicro * startEventsFor(f.actor.minMemoryMbytes) + dearest;
        const roundedUpToCent = ceilDiv(exact, 10_000n) * 10_000n;
        const floor = micro(must(rawLiterals(f.putText, 'minimalMaxTotalChargeUsd')[0], 'floor literal'));
        expect(floor).toBe(roundedUpToCent > 100_000n ? roundedUpToCent : 100_000n);
        expect(floor >= exact).toBe(true);
        expect(floor - exact < 10_000n).toBe(true);
        expect(floor >= 100_000n).toBe(true);
    });

    it('pins the Actor memory so the per-GB start cost is exact, and agrees with the pricing notice', () => {
        expect(f.actor.minMemoryMbytes).toBe(golden.memoryMbytes);
        expect(f.actor.maxMemoryMbytes).toBe(f.actor.minMemoryMbytes);
        expect(f.actor.minMemoryMbytes % 256).toBe(0);
        expect(f.notice.memoryMbytes).toBe(f.actor.minMemoryMbytes);
        const startMicro = must(f.priceMicro.get(START), 'start');
        const perRun = micro(must(rawLiterals(f.noticeText, 'startEventPerRunUsd')[0], 'perRun literal'));
        expect(perRun).toBe(startMicro * startEventsFor(f.actor.minMemoryMbytes));
        expect(micro(must(rawLiterals(f.noticeText, 'startEventPriceUsd')[0], 'start literal'))).toBe(startMicro);
    });

    it('has sane scalar fields: margin in [0, 1], a non-empty reason, no extra platform-owned keys', () => {
        expect(typeof f.record.apifyMarginPercentage).toBe('number');
        expect(f.record.apifyMarginPercentage).toBeGreaterThanOrEqual(0);
        expect(f.record.apifyMarginPercentage).toBeLessThanOrEqual(1);
        expect(micro(must(rawLiterals(f.putText, 'apifyMarginPercentage')[0], 'margin literal'))).toBe(200_000n);
        expect(f.record.pricingModel).toBe('PAY_PER_EVENT');
        expect(typeof f.record.reasonForChange).toBe('string');
        expect(f.record.reasonForChange.trim().length).toBeGreaterThan(20);
        expect(f.record.reasonForChange).not.toMatch(PLACEHOLDER);
        expect(f.record.reasonForChange).toContain(slug);
    });

    it('keeps notice.json consistent with the payload, the catalog basis and its own narrative numbers', () => {
        const n = f.notice;
        expect(n.engine).toBe(slug);
        expect(n.reasonForChange).toBe(f.record.reasonForChange);
        expect(n.policy).toContain('section 9.4');
        expect(n.changeLimit.length).toBeGreaterThan(0);
        expect(n.provisionalEvents).toEqual(c.catalog.events.filter((e) => e.basis === 'provisional').map((e) => e.name));
        expect(n.operatorStatedEvents).toEqual(c.catalog.events.filter((e) => e.basis === 'operator-stated').map((e) => e.name));
        for (const name of [...n.provisionalEvents, ...n.operatorStatedEvents]) expect(f.events[name], name).toBeDefined();

        const startMicro = must(f.priceMicro.get(START), 'start');
        const gb = startEventsFor(f.actor.minMemoryMbytes);
        const [defaultNote, perRunNote] = n.notes;
        const dm = /default apify-actor-start price is \$(\d+(?:\.\d+)?); (\d+(?:\.\d+)?) is (\d+)x that/u.exec(must(defaultNote, 'notes[0]'));
        expect(dm).not.toBeNull();
        expect(micro(must(dm?.[2], 'quoted start'))).toBe(startMicro);
        expect(BigInt(must(dm?.[3], 'multiplier')) * micro(must(dm?.[1], 'default price'))).toBe(startMicro);
        const pm = /With (\d+) MB the start event is charged (\d+) time\(s\) per run = \$(\d+(?:\.\d+)?)/u.exec(must(perRunNote, 'notes[1]'));
        expect(pm).not.toBeNull();
        expect(Number(pm?.[1])).toBe(f.actor.minMemoryMbytes);
        expect(BigInt(must(pm?.[2], 'times'))).toBe(gb);
        expect(micro(must(pm?.[3], 'per run'))).toBe(startMicro * gb);
        const rm = /start event is set to \$(\d+(?:\.\d+)?)\./u.exec(f.record.reasonForChange);
        expect(micro(must(rm?.[1], 'reason start price'))).toBe(startMicro);
        expect(n.notes.some((note) => note.includes(DATASET_ITEM) && note.includes('absent'))).toBe(true);
    });

    it('matches the frozen audit price table to the micro-dollar (a payload and catalog drifting together are still caught)', () => {
        expect(Object.fromEntries(f.priceMicro)).toEqual(golden.prices);
        expect(Object.fromEntries(c.catalog.events.map((e) => [e.name, BigInt(Math.round(e.priceUsd * 1e6))]))).toEqual(Object.fromEntries(Object.entries(golden.prices).filter(([name]) => name !== START)));
        expect(BigInt(Math.round(c.catalog.startPriceUsd * 1e6))).toBe(must(golden.prices[START], 'golden start'));
        expect(c.catalog.memoryMbytes).toBe(golden.memoryMbytes);
    });

    it('declares the price basis per event: the exact legacy / provisional / operator breakdown', () => {
        const count = (basis: string): number => c.catalog.events.filter((e) => e.basis === basis).length;
        expect(count('legacy-readme')).toBe(golden.basis.legacy);
        expect(count('provisional')).toBe(golden.basis.provisional);
        expect(count('operator-stated')).toBe(golden.basis.operator);
        expect(c.catalog.events.map((e) => e.basis).every((b) => ['legacy-readme', 'provisional', 'operator-stated'].includes(b))).toBe(true);
        expect(c.catalog.events).toHaveLength(Object.keys(f.events).length - 1);
        expect(c.catalog.events.filter((e) => e.basis === 'operator-stated').map((e) => e.name)).toEqual([HIT]);
    });

    it('cites every documented price with a structured file:line citation, and quoted dollar amounts agree with the price', () => {
        const citation = /([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+\.md):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/gu;
        for (const event of c.catalog.events) {
            expect(event.evidence.trim().length, event.name).toBeGreaterThan(0);
            const cites = [...event.evidence.matchAll(citation)];
            if (event.basis !== 'operator-stated') expect(cites.length, `${event.name} cites no file:line`).toBeGreaterThan(0);
            for (const cite of cites) {
                const path = must(cite[1], 'path');
                const lines = must(cite[2], 'lines');
                expect(path.split('/').every((segment) => segment.length > 0), path).toBe(true);
                expect(path, event.name).toMatch(/\/(README|AGENTS)\.md$/u);
                for (const part of lines.split(',')) {
                    const [from, to] = part.split('-').map(Number);
                    expect(Number.isInteger(from) && (from ?? 0) >= 1, `${event.name} ${path}:${lines}`).toBe(true);
                    if (to !== undefined) expect(to >= (from ?? 0), `${event.name} ${path}:${lines} range`).toBe(true);
                }
            }
            const quoted = [...event.evidence.matchAll(/\$(\d+(?:\.\d+)?)/gu)].map((m) => micro(must(m[1], 'amount')));
            const price = BigInt(Math.round(event.priceUsd * 1e6));
            if (quoted.length > 0) expect(quoted.includes(price), `${event.name}: ${usd6(price)} is not among the quoted ${quoted.map(usd6).join(', ')}`).toBe(true);
            // A provisional price derived from several documented prices must take the lowest one, so no customer is over-billed.
            if (event.basis === 'provisional' && quoted.length > 1) expect(price, event.name).toBe(quoted.reduce((a, b) => (b < a ? b : a)));
            if (event.basis === 'operator-stated') expect(event.evidence).toContain('Engagement brief');
        }
    });
});

describe('the three payloads together', () => {
    it('price 25 events beyond the start event: 18 legacy-readme, 4 provisional, 3 operator-stated', () => {
        const all = ALL_PRICING.flatMap((p) => p.events);
        expect(all).toHaveLength(25);
        expect(all.filter((e) => e.basis === 'legacy-readme')).toHaveLength(18);
        expect(all.filter((e) => e.basis === 'provisional').map((e) => e.name)).toEqual(['crawler-signal', 'grant-updated', 'uae-entity-updated', 'sg-entity-updated']);
        expect(all.filter((e) => e.basis === 'operator-stated').map((e) => e.name)).toEqual([HIT, HIT, HIT]);
        const committed = CASES.reduce((sum, c) => sum + Object.keys(factsOf(c.slug).events).length - 1, 0);
        expect(committed).toBe(25);
    });

    it('cover 19 active and 10 held connectors', () => {
        const all = CASES.flatMap((c) => c.engine.connectors);
        expect(all.filter((x) => x.status === 'active')).toHaveLength(19);
        expect(all.filter((x) => x.status === 'held')).toHaveLength(10);
        expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    });

    it('are one coordinated submission: same instants, margin, start price, start title and start description', () => {
        const records = CASES.map((c) => factsOf(c.slug).record);
        for (const key of ['createdAt', 'startedAt', 'apifyMarginPercentage'] as const) expect(new Set(records.map((r) => r[key])).size, key).toBe(1);
        const starts = CASES.map((c) => factsOf(c.slug).events[START]);
        expect(new Set(starts.map((s) => JSON.stringify(s))).size).toBe(1);
        const watchlist = CASES.map((c) => must(factsOf(c.slug).events[HIT], HIT));
        expect(new Set(watchlist.map((w) => w.eventPriceUsd)).size).toBe(1);
        expect(new Set(watchlist.map((w) => w.eventTitle)).size).toBe(1);
    });

    it('reach the unpriced-event fallback nowhere: record-level overrides found in connector source equal RECORD_LEVEL_EVENTS', async () => {
        for (const c of CASES) {
            const dir = join(ROOT, c.slug, 'connectors');
            const found = new Set<string>();
            for (const file of (await readdir(dir)).filter((name) => name.endsWith('.ts'))) {
                const text = await readFile(join(dir, file), 'utf8');
                for (const line of text.split('\n').filter((l) => /^\s+billingEvent:/u.test(l))) {
                    const expression = line.replace(/^\s+billingEvent:/u, '');
                    const resolved: string[] = [];
                    for (const [, literal] of expression.matchAll(/'([a-z][a-z0-9-]*)'/gu)) resolved.push(must(literal, 'literal'));
                    for (const [identifier] of expression.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/gu)) {
                        const value = new RegExp(`const ${identifier} = '([a-z][a-z0-9-]*)'`, 'u').exec(text)?.[1];
                        if (value !== undefined) resolved.push(value);
                    }
                    expect(resolved.length, `${file}: unresolvable billingEvent expression ${expression.trim()}`).toBeGreaterThan(0);
                    for (const event of resolved) found.add(event);
                }
            }
            expect([...found].sort(), c.slug).toEqual([...RECORD_LEVEL_EVENTS[c.engine.slug]].sort());
            for (const event of found) expect(factsOf(c.slug).events[event], `${c.slug}: record-level event ${event} is not priced`).toBeDefined();
        }
    });

    it('leaves no billingEvent reference the record-level scan cannot read (shorthand, assignment, other folders, shared helpers)', async () => {
        for (const c of CASES) {
            for (const file of await tsFiles(join(ROOT, c.slug))) {
                const text = await readFile(file, 'utf8');
                const mentions = (text.match(/\bbillingEvent\b/gu) ?? []).length;
                const scanned = text.split('\n').filter((line) => /^\s+billingEvent:/u.test(line)).length;
                expect(mentions, `${relative(ROOT, file)} mentions billingEvent in a form the scan does not read`).toBe(scanned);
                if (scanned > 0) expect(dirname(file), `${relative(ROOT, file)} sets billingEvent outside the scanned connectors folder`).toBe(join(ROOT, c.slug, 'connectors'));
            }
        }
        // Outside the engines only the two files that declare the field may mention it; a new shared helper must be audited first.
        for (const file of await tsFiles(join(ROOT, 'lib'))) {
            if (['types.ts', 'router_core.ts'].includes(relative(join(ROOT, 'lib'), file))) continue;
            expect((await readFile(file, 'utf8')).match(/\bbillingEvent\b/gu) ?? [], `lib/${relative(join(ROOT, 'lib'), file)} mentions billingEvent`).toEqual([]);
        }
    });
});

describe('pricing exposure figures', () => {
    function ownFigures(c: Case): Golden['exposure'] & { hits: bigint } {
        const f = factsOf(c.slug);
        const startMicro = must(f.priceMicro.get(START), 'start');
        const hitMicro = must(f.priceMicro.get(HIT), 'hit');
        const sourceEvents = [...billableEvents(c.engine)];
        const dearest = sourceEvents.map((name) => must(f.priceMicro.get(name), name)).reduce((a, b) => (b > a ? b : a));
        const emptyRun = startMicro * startEventsFor(f.actor.minMemoryMbytes);
        const oneRow = dearest + hitMicro;
        const hitCap = BigInt(Number(must(f.inputSchema.properties.maxWatchlistHitsPerRun?.default, 'hit cap default')));
        const spendCap = BigInt(Math.round(Number(must(f.inputSchema.properties.maxWatchlistSpendUsd?.default, 'spend cap default')) * 1e6));
        const candidates = [1000n, hitCap, spendCap / hitMicro];
        const hits = candidates.reduce((a, b) => (b < a ? b : a));
        return {
            emptyRun,
            dearestRow: dearest,
            oneRow,
            uncapped1000: emptyRun + 1000n * oneRow,
            capped1000: emptyRun + 1000n * dearest + hits * hitMicro,
            // The hit is charged after the journal write: a kill can repeat only the row event in flight.
            killWithJournal: dearest,
            killOldWindow: BigInt(CHECKPOINT_EVERY_ROWS) * oneRow,
            hits,
        };
    }

    it.each(CASES.map((c) => [c.slug, c] as const))('%s: own micro-USD arithmetic equals the frozen figures and the exposure script', async (slug, c) => {
        const own = ownFigures(c);
        const { hits, ...figures } = own;
        expect(figures).toEqual(c.golden.exposure);
        expect(hits).toBe(200n);
        const reported = must((await collectExposure(ROOT)).find((r) => r.slug === slug), `exposure for ${slug}`);
        expect(reported.emptyRunMicro).toBe(own.emptyRun);
        expect(reported.dearestEvent.priceMicro).toBe(own.dearestRow);
        expect(reported.rowWorstMicro).toBe(own.oneRow);
        expect(reported.run1000UncappedMicro).toBe(own.uncapped1000);
        expect(reported.run1000CappedMicro).toBe(own.capped1000);
        expect(reported.effectiveHits).toBe(own.hits);
        expect(reported.killDoubleBillMicro).toBe(own.killWithJournal);
        expect(reported.oldWindowDoubleBillMicro).toBe(own.killOldWindow);
        expect(reported.oldWindowDoubleBillMicro).toBe(25n * reported.rowWorstMicro);
        // The remaining reported figures: pinned memory, start events, the committed floor, the matched-row budget and the price basis per event.
        expect(reported.memoryMbytes).toBe(c.golden.memoryMbytes);
        expect(reported.startEvents).toBe(startEventsFor(c.golden.memoryMbytes));
        expect(reported.committedFloorMicro).toBe(micro(must(rawLiterals(factsOf(slug).putText, 'minimalMaxTotalChargeUsd')[0], 'floor literal')));
        expect(reported.matchedRowBudgetMicro).toBe(own.emptyRun + own.oneRow);
        expect(reported.hitMicro).toBe(150_000n);
        expect(reported.events.map((e) => [e.name, e.basis])).toEqual([[START, 'platform'], ...c.catalog.events.map((e) => [e.name, e.basis])]);
    });

    it('the journal bound is exactly 25 times smaller than the old checkpoint window', () => {
        expect(CHECKPOINT_EVERY_ROWS).toBe(25);
    });

    it('lists, per event, the sources that bill it, covering every active source exactly where its mapping says', async () => {
        const report = await collectExposure(ROOT);
        for (const c of CASES) {
            const r = must(report.find((x) => x.slug === c.slug), c.slug);
            expect(r.events.map((e) => e.name)).toEqual(Object.keys(factsOf(c.slug).events));
            for (const connector of c.engine.connectors.filter((x) => x.status === 'active')) {
                const billed = [connector.billing?.newEvent, connector.billing?.updatedEvent, connector.billing?.snapshotEvent].filter((e): e is string => e !== undefined);
                for (const event of billed) expect(must(r.events.find((e) => e.name === event), event).sources, `${c.slug}/${event}`).toContain(connector.id);
            }
            for (const event of RECORD_LEVEL_EVENTS[c.engine.slug]) expect(must(r.events.find((e) => e.name === event), event).sources.length, event).toBeGreaterThan(0);
            for (const e of r.events.filter((x) => x.name !== START && x.name !== HIT)) expect(e.sources.length, `${c.slug}/${e.name} has no billing source`).toBeGreaterThan(0);
        }
        const tenderSummary = must(must(report.find((x) => x.slug === 'latam-global-tender-intelligence'), 'tenders').events.find((e) => e.name === 'tender-summary'), 'tender-summary');
        expect(tenderSummary.sources).toEqual(['ar_santafe', 'us_florida']);
    });

    it('prints a deterministic Markdown report containing every audited figure, identical across two real runs and the in-process render', async () => {
        const inProcess = renderReport(await collectExposure(ROOT));
        const args = ['--import', 'tsx', join(ROOT, 'scripts', 'audit_pricing_exposure.ts')];
        const first = await run(process.execPath, args, { cwd: ROOT, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
        const second = await run(process.execPath, args, { cwd: ROOT, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
        expect(first.stderr).toBe('');
        expect(first.stdout).toBe(second.stdout);
        expect(first.stdout).toBe(inProcess);
        for (const c of CASES) {
            expect(first.stdout).toContain(`## ${c.slug}`);
            const x = c.golden.exposure;
            for (const [label, amount] of [
                ['Start cost of an empty run', x.emptyRun],
                ['Worst-case cost of one delivered row', x.oneRow],
                ['Worst-case double bill from ONE hard kill (delivery journal)', x.killWithJournal],
                ['Same kill with the old 25-row checkpoint window', x.killOldWindow],
            ] as const) {
                expect(first.stdout, `${c.slug} ${label}`).toContain(`| ${label} | ${usd6(amount)} |`);
                expect(usd6(amount)).toBe(formatUsd(amount));
            }
            expect(first.stdout).toContain(`| Worst-case 1000-row run, every row a hit (no caps) | ${usd6(x.uncapped1000)} |`);
            expect(first.stdout).toContain(`| Worst-case 1000-row run under the default hit caps | ${usd6(x.capped1000)} |`);
            expect(first.stdout).toContain(`| Dearest source event | ${usd6(x.dearestRow)} |`);
            expect(first.stdout).toContain('| Committed minimalMaxTotalChargeUsd | 0.160000 |');
            expect(first.stdout).toContain(`| Budget for the start events plus one matched row | ${usd6(x.emptyRun + x.oneRow)} |`);
            expect(first.stdout).toContain(`| ${c.slug} | ${usd6(x.emptyRun)} | ${usd6(x.oneRow)} | ${usd6(x.uncapped1000)} | ${usd6(x.capped1000)} | ${usd6(x.killWithJournal)} | ${usd6(x.killOldWindow)} |`);
            expect(first.stdout).toContain(`| \`${START}\` | ${usd6(must(c.golden.prices[START], 'start'))} | platform |`);
            for (const event of c.catalog.events) expect(first.stdout).toContain(`| \`${event.name}\` | ${usd6(must(c.golden.prices[event.name], event.name))} | ${event.basis} |`);
        }
        expect(first.stdout).toContain('| **all engines** | 18 | 4 | 3 |');
        expect(first.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    }, 120_000);
});

describe('the exposure script on controlled inputs', () => {
    const TEMP_DIRS: string[] = [];
    afterAll(async () => {
        for (const dir of TEMP_DIRS) await rm(dir, { recursive: true, force: true });
    });

    const regtech = must(CASES[0], 'regtech case');
    const tenders = must(CASES[1], 'tenders case');

    interface Edits {
        memory?: number | { min: number; max: number };
        schema?: (schema: { properties: Record<string, Record<string, unknown>> }) => void;
        put?: (text: string) => string;
    }

    /** A minimal controlled copy of exactly the files the script reads; the connector sources are linked, not copied. */
    async function controlledRoot(c: Case, edits: Edits): Promise<string> {
        const f = factsOf(c.slug);
        const root = await mkdtemp(join(tmpdir(), 'audit-exposure-'));
        TEMP_DIRS.push(root);
        await mkdir(join(root, 'pricing', 'payloads'), { recursive: true });
        await mkdir(join(root, c.slug, '.actor'), { recursive: true });
        await writeFile(join(root, 'pricing', 'payloads', `${c.slug}.put.json`), edits.put ? edits.put(f.putText) : f.putText);
        const actor = JSON.parse(await readFile(join(ROOT, c.slug, '.actor', 'actor.json'), 'utf8')) as Record<string, unknown>;
        if (typeof edits.memory === 'number') {
            actor.minMemoryMbytes = edits.memory;
            actor.maxMemoryMbytes = edits.memory;
        } else if (edits.memory !== undefined) {
            actor.minMemoryMbytes = edits.memory.min;
            actor.maxMemoryMbytes = edits.memory.max;
        }
        await writeFile(join(root, c.slug, '.actor', 'actor.json'), `${JSON.stringify(actor, null, 4)}\n`);
        const schema = JSON.parse(await readFile(join(ROOT, c.slug, '.actor', 'input_schema.json'), 'utf8')) as { properties: Record<string, Record<string, unknown>> };
        edits.schema?.(schema);
        await writeFile(join(root, c.slug, '.actor', 'input_schema.json'), `${JSON.stringify(schema, null, 4)}\n`);
        await symlink(join(ROOT, c.slug, 'connectors'), join(root, c.slug, 'connectors'), 'dir');
        return root;
    }

    const MEMORY_CASES: Array<[number, bigint]> = [
        [0, 1n],
        [256, 1n],
        [512, 1n],
        [1024, 1n],
        [1280, 2n],
        [1536, 2n],
        [2048, 2n],
        [2049, 3n],
        [3072, 3n],
        [4096, 4n],
    ];

    it.each(MEMORY_CASES)('charges apify-actor-start once per started GB with a minimum of one event: %i MB -> %s event(s)', async (memory, events) => {
        const r = await collectEngineExposure(await controlledRoot(regtech, { memory }), regtech.engine);
        expect(r.memoryMbytes).toBe(memory);
        expect(r.startEvents).toBe(events);
        expect(r.emptyRunMicro).toBe(5_000n * events);
        expect(r.matchedRowBudgetMicro).toBe(5_000n * events + 200_000n);
        expect(r.run1000UncappedMicro).toBe(5_000n * events + 1000n * 200_000n);
    });

    // [hit cap, spend cap in USD, hits the capped 1000-row run can bill]: 1000 rows, the hit cap and spend / 0.15 (rounded down) are the three bounds.
    const CAP_CASES: Array<[number, number, bigint]> = [
        [5, 50, 5n],
        [200, 15, 100n],
        [5000, 10000, 1000n],
        [0, 50, 0n],
        [200, 0, 0n],
        [1000, 49.99, 333n],
        [200, 50, 200n],
    ];

    it.each(CAP_CASES)('bounds the billable hits of the capped run by the cheapest of 1000 rows, the hit cap and the spend cap: cap %i hits, %f USD -> %s hits', async (hits, spend, expected) => {
        const root = await controlledRoot(regtech, {
            schema: (schema) => {
                must(schema.properties.maxWatchlistHitsPerRun, 'hit cap property').default = hits;
                must(schema.properties.maxWatchlistSpendUsd, 'spend cap property').default = spend;
            },
        });
        const r = await collectEngineExposure(root, regtech.engine);
        expect(r.hitCap).toBe(BigInt(hits));
        expect(r.spendCapMicro).toBe(BigInt(Math.round(spend * 1e6)));
        expect(r.effectiveHits).toBe(expected);
        expect(r.run1000CappedMicro).toBe(10_000n + 1000n * 50_000n + expected * 150_000n);
        expect(r.run1000UncappedMicro).toBe(10_000n + 1000n * 200_000n);
    });

    it('reads decimal literals exactly and rejects exponents, signs, spaces and more than 6 decimals', () => {
        const exact: Array<[string, bigint]> = [
            ['0', 0n],
            ['0.0005', 500n],
            ['0.000001', 1n],
            ['0.15', 150_000n],
            ['10', 10_000_000n],
            ['200.01', 200_010_000n],
        ];
        for (const [literal, value] of exact) expect(decimalToMicro(literal), literal).toBe(value);
        for (const bad of ['', '-1', '+1', '1e-3', '5e-3', '0.0000001', '.5', '5.', '1,5', '0x10', ' 1', '1 ']) expect(() => decimalToMicro(bad), `"${bad}"`).toThrow(/plain decimal/u);
    });

    it('prints USD with exactly six decimals and keeps the sign of a negative amount', () => {
        const cases: Array<[bigint, string]> = [
            [0n, '0.000000'],
            [1n, '0.000001'],
            [999_999n, '0.999999'],
            [1_000_000n, '1.000000'],
            [200_010_000n, '200.010000'],
            [-1n, '-0.000001'],
            [-1_500_000n, '-1.500000'],
        ];
        for (const [value, text] of cases) expect(formatUsd(value), String(value)).toBe(text);
    });

    it('refuses to report on a payload that disagrees with the catalog or is malformed', async () => {
        const priceDrift = await controlledRoot(tenders, { put: (text) => text.replace('"eventPriceUsd": 0.003', '"eventPriceUsd": 0.0031') });
        await expect(collectEngineExposure(priceDrift, tenders.engine)).rejects.toThrow(/tender-detail is 0\.003100 in the payload but 0\.003000 in the catalog/u);

        const orphan = await controlledRoot(tenders, {
            put: (text) => text.replace('"watchlist-hit": {', '"orphan-record": {\n "eventTitle": "Orphan",\n "eventDescription": "Nothing bills it.",\n "eventPriceUsd": 0.01\n },\n "watchlist-hit": {'),
        });
        await expect(collectEngineExposure(orphan, tenders.engine)).rejects.toThrow(/the payload prices 10 events, the catalog 8 plus the start event/u);

        const noStart = await controlledRoot(tenders, { put: (text) => text.replace(/ {20}"apify-actor-start": \{.*?\n {20}\},\n/su, '') });
        await expect(collectEngineExposure(noStart, tenders.engine)).rejects.toThrow(/apify-actor-start and watchlist-hit must both be priced/u);

        const exponent = await controlledRoot(tenders, { put: (text) => text.replace('"eventPriceUsd": 0.005,', '"eventPriceUsd": 5e-3,') });
        await expect(collectEngineExposure(exponent, tenders.engine)).rejects.toThrow(/Price literal "5e-3" is not a plain decimal/u);

        const twoRecords = await controlledRoot(tenders, { put: (text) => text.replace(/\n {8}\}\n {4}\]\n\}/u, '\n        },\n        {}\n    ]\n}') });
        await expect(collectEngineExposure(twoRecords, tenders.engine)).rejects.toThrow(/exactly one pricing record/u);

        const unpinned = await controlledRoot(tenders, { memory: { min: 1024, max: 2048 } });
        await expect(collectEngineExposure(unpinned, tenders.engine)).rejects.toThrow(/must pin the memory/u);

        const noCap = await controlledRoot(tenders, { schema: (schema) => void delete must(schema.properties.maxWatchlistHitsPerRun, 'hit cap property').default });
        await expect(collectEngineExposure(noCap, tenders.engine)).rejects.toThrow(/watchlist-hit cap defaults are missing/u);
    });

    it('refuses to report when a registry connector falls back to the unpriced result event, or an event has no active source', async () => {
        const without = (id: string): EngineDefinition => ({ ...tenders.engine, connectors: tenders.engine.connectors.filter((x) => x.id !== id) });
        const unbilled: EngineDefinition = { ...tenders.engine, connectors: tenders.engine.connectors.map((x) => (x.id === 'ar_tucuman' ? { ...x, billing: undefined } : x)) };
        await expect(collectEngineExposure(ROOT, unbilled)).rejects.toThrow(/unpriced "result" event/u);
        await expect(collectEngineExposure(ROOT, without('eu_ted'))).rejects.toThrow(/event notice-new is priced but no active source bills it/u);
    });

    it('lists only ACTIVE sources, also for record-level overrides found in connector source (a held source bills nothing)', async () => {
        const held: EngineDefinition = { ...tenders.engine, connectors: tenders.engine.connectors.map((x) => (x.id === 'us_florida' ? ({ ...x, status: 'held', heldReason: 'audit probe' } as typeof x) : x)) };
        const r = await collectEngineExposure(ROOT, held);
        const sourcesOf = (name: string): string[] => must(r.events.find((e) => e.name === name), name).sources;
        expect(sourcesOf('tender-summary')).toEqual(['ar_santafe']);
        expect(sourcesOf('tender-detail')).toEqual(['ar_santafe', 'ar_tucuman', 'ar_entrerios', 'cl_diario_oficial']);
    });

    it('exits with status 1, a reason on stderr and nothing on stdout when the committed payload disagrees with the catalog', async () => {
        const root = await mkdtemp(join(tmpdir(), 'audit-cli-'));
        TEMP_DIRS.push(root);
        await mkdir(join(root, 'scripts'), { recursive: true });
        await cp(join(ROOT, 'scripts', 'audit_pricing_exposure.ts'), join(root, 'scripts', 'audit_pricing_exposure.ts'));
        for (const entry of ['lib', 'pricing', 'package.json', 'tsconfig.json', ...CASES.map((c) => c.slug)]) await cp(join(ROOT, entry), join(root, entry), { recursive: true });
        await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
        const args = ['--import', 'tsx', join(root, 'scripts', 'audit_pricing_exposure.ts')];

        // Control: the unmodified copy prints the same report as the real tree, so the failure below can only come from the edit.
        const control = await run(process.execPath, args, { cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
        expect(control.stdout).toBe(renderReport(await collectExposure(ROOT)));

        const payload = join(root, 'pricing', 'payloads', `${tenders.slug}.put.json`);
        await writeFile(payload, (await readFile(payload, 'utf8')).replace('"eventPriceUsd": 0.003', '"eventPriceUsd": 0.0031'));
        const failure = await run(process.execPath, args, { cwd: root, timeout: 90_000 }).then(
            () => undefined,
            (error: unknown) => error as { code?: number; stdout?: string; stderr?: string },
        );
        expect(failure).toBeDefined();
        expect(failure?.code).toBe(1);
        expect(failure?.stdout).toBe('');
        expect(failure?.stderr).toContain('tender-detail is 0.003100 in the payload but 0.003000 in the catalog');
    }, 180_000);
});
