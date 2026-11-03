/**
 * world_bank_notices connector tests.
 *
 * Fixtures (test/fixtures/tenders-b/, no network):
 *   - worldBankProcNotices_live_2026-10-21_excerpt.json: 3 notices from a REAL LIVE response captured in this port
 *     session (GET https://search.worldbank.org/api/v2/procnotices?format=json&rows=200&os=0, 2026-10-21), envelope
 *     verbatim (`rows` a number, `os`/`page`/`total` strings). Redacted for the repo: contact_name / contact_email /
 *     contact_phone_no / contact_address are replaced by "[redacted for fixture]" and notice_text is nulled, because
 *     the live values are named individuals' details. Every other value is verbatim, including the real Contract Award
 *     that OMITS contact_organization and submission_deadline_date altogether (absent keys, not nulls).
 *   - worldBankProcNotices.json: COPIED from the legacy actor (actor-20-mdb-procurement-monitor/test/fixtures). The
 *     legacy repo does not say how it was produced; row 1 reads like a capture and rows 2-3 carry an example.gov.in
 *     address and read as hand-written, so it is used as a legacy FIXTURE (it carries the one notice_text and the full
 *     contact columns the privacy tests need), not as evidence of live behaviour.
 * Inline notices and clocks are SYNTHETIC and labelled where used. The paging scenario in "pages by offset" is the
 * legacy actor's own de-duplication test (worldBankProcurementNotices.test.ts) ported to this connector.
 */
import { describe, expect, it } from 'vitest';

import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { sanitizeKeywordList } from '../lib/_guards.js';
import {
    HARD_PAGE_FETCH_CAP,
    isOlderThanDateRange,
    isWithinDateRange,
    matchesExactList,
    noticeTextToPlain,
    normalizeWorldBankProcurementNotice,
    parseWorldBankNoticeDate,
    toSourceRecord,
    watchTextOf,
    WORLD_BANK_PROCNOTICES_URL,
    type WorldBankProcNoticeRaw,
    WorldBankProcNoticesEnvelopeSchema,
    worldBankNoticesConnector,
    worldBankNoticesOptionsSchema,
} from '../latam-global-tender-intelligence/connectors/worldBankNotices.js';
import { jsonFixture, LEGACY_DELTA_KEYS, makeCtx, ROUTER_OWNED_KEYS, type Responder, runThroughRouter } from './tenders-b.helpers.js';

interface Envelope {
    rows: number | string;
    os: string;
    page: string;
    total: string;
    procnotices: WorldBankProcNoticeRaw[];
}
const liveEnvelope = jsonFixture<Envelope>('worldBankProcNotices_live_2026-10-21_excerpt.json');
const legacyEnvelope = jsonFixture<Envelope>('worldBankProcNotices.json');
const [reoiSn, awardHn, ifbMg] = liveEnvelope.procnotices as [WorldBankProcNoticeRaw, WorldBankProcNoticeRaw, WorldBankProcNoticeRaw];
const [kenya, india, peru] = legacyEnvelope.procnotices as [WorldBankProcNoticeRaw, WorldBankProcNoticeRaw, WorldBankProcNoticeRaw];

const RUN: RunParams = { maxItemsPerSource: 100 };
const opts = (overrides: Record<string, unknown> = {}) => worldBankNoticesOptionsSchema.parse(overrides);
const url = (rows: number, os: number) => `${WORLD_BANK_PROCNOTICES_URL}?format=json&rows=${rows}&os=${os}`;

/** The envelope the real API returns for a page: `rows` numeric, the rest strings. */
function envelopeOf(notices: Array<Record<string, unknown>>, total: number, os: number) {
    return { rows: notices.length, os: String(os), page: String(Math.floor(os / Math.max(notices.length, 1)) + 1), total: String(total), procnotices: notices };
}

/** SYNTHETIC: a minimal notice. */
function notice(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, notice_type: 'Invitation for Bids', noticedate: '19-Oct-2026', notice_status: 'Published', project_ctry_name: 'Kenya', bid_description: `Works ${id}`, contact_organization: `Agency ${id}`, ...extra };
}

/** SYNTHETIC feed of `all` notices served in offset order (the real feed is newest-first). */
function feed(all: Array<Record<string, unknown>>, total = all.length): Responder {
    return (request) => {
        const u = new URL(request.url);
        const rows = Number(u.searchParams.get('rows'));
        const os = Number(u.searchParams.get('os'));
        return envelopeOf(all.slice(os, os + rows), total, os);
    };
}

describe('dates', () => {
    it('parses the live "DD-MMM-YYYY" noticedate case-insensitively and rejects every other shape', () => {
        expect(parseWorldBankNoticeDate('19-Oct-2026')?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
        expect(parseWorldBankNoticeDate(' 05-sep-2026 ')?.toISOString()).toBe('2026-09-05T00:00:00.000Z');
        expect(parseWorldBankNoticeDate('1-Jan-2026')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(parseWorldBankNoticeDate('2026-10-19')).toBeNull();
        expect(parseWorldBankNoticeDate('19-Octo-2026')).toBeNull();
        expect(parseWorldBankNoticeDate('19-Xyz-2026')).toBeNull();
        expect(parseWorldBankNoticeDate('')).toBeNull();
        expect(parseWorldBankNoticeDate(null)).toBeNull();
        expect(parseWorldBankNoticeDate(undefined)).toBeNull();
    });

    it('isWithinDateRange is two-sided: a future-dated notice never matches, the window edge is inclusive', () => {
        const now = new Date('2026-10-21T00:00:00Z');
        expect(isWithinDateRange(null, undefined, now)).toBe(true);
        expect(isWithinDateRange(null, '7d', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-10-20T00:00:00Z'), '24h', now)).toBe(true); // exactly 24h
        expect(isWithinDateRange(new Date('2026-10-19T23:59:59Z'), '24h', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-10-22T00:00:00Z'), '30d', now)).toBe(false); // future
        expect(isWithinDateRange(new Date('2026-07-23T00:00:00Z'), '90d', now)).toBe(true);
        expect(isWithinDateRange(new Date('2025-10-21T00:00:00Z'), '365d', now)).toBe(true);
    });

    it('isOlderThanDateRange is true only for a parseable date strictly past the window', () => {
        const now = new Date('2026-10-21T00:00:00Z');
        expect(isOlderThanDateRange(new Date('2026-10-14T00:00:00Z'), '7d', now)).toBe(false); // exactly 7d is still in the window
        expect(isOlderThanDateRange(new Date('2026-10-13T23:59:59Z'), '7d', now)).toBe(true);
        expect(isOlderThanDateRange(null, '7d', now)).toBe(false);
        expect(isOlderThanDateRange(new Date('2000-01-01T00:00:00Z'), undefined, now)).toBe(false);
        expect(isOlderThanDateRange(new Date('2026-10-22T00:00:00Z'), '7d', now)).toBe(false); // future is not "old"
    });
});

describe('envelope schema (mixed types confirmed live)', () => {
    it('parses the real envelope: rows as a number, os / page / total as strings', () => {
        const parsed = WorldBankProcNoticesEnvelopeSchema.parse(liveEnvelope);
        expect(parsed.procnotices).toHaveLength(3);
        expect(typeof liveEnvelope.rows).toBe('number');
        expect(typeof liveEnvelope.total).toBe('string');
        expect(WorldBankProcNoticesEnvelopeSchema.safeParse({ ...liveEnvelope, total: 423546 }).success).toBe(true);
        expect(WorldBankProcNoticesEnvelopeSchema.safeParse({ ...liveEnvelope, procnotices: 'x' }).success).toBe(false);
        expect(WorldBankProcNoticesEnvelopeSchema.safeParse({ ...liveEnvelope, procnotices: [{ notice_type: 'no id' }] }).success).toBe(false);
    });
});

describe('normalisation (real live notices)', () => {
    it('a Request for Expression of Interest keeps the legacy UMS vocabulary', () => {
        const p = normalizeWorldBankProcurementNotice(reoiSn);
        expect(p).toMatchObject({
            source_url: `${WORLD_BANK_PROCNOTICES_URL}?format=json&id=OP00469523`,
            recipient_or_defendant_name: null,
            entity_identifier_native: '34-CONS-PADAES-2026',
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: '2026-11-04T00:00:00Z',
            publish_date_iso: '2026-10-19T00:00:00.000Z',
            category_or_type: 'Request for Expression of Interest',
            status_or_estado: 'Published',
            awarding_or_regulating_agency: 'SENEGAL NATIONAL ELECTRICITY AGENCY',
            jurisdiction: 'WB',
            source_document_url: 'www.senelec.sn',
            reference_number: '34-CONS-PADAES-2026',
        });
    });

    it('additive non-personal columns are surfaced; contact details and the notice text are not', () => {
        const p = normalizeWorldBankProcurementNotice(reoiSn);
        expect(p).toMatchObject({
            notice_id: 'OP00469523',
            project_id: 'P176620',
            project_name: 'Senegal Energy Access Scale Up Project',
            project_country: 'Senegal',
            procurement_group: 'CS',
            procurement_method_code: 'QCBS',
            procurement_method_name: 'Quality And Cost-Based Selection',
            notice_language: 'French',
            submission_deadline_time: '09:30',
            submission_date: '2026-10-19T00:00:00Z',
        });
        for (const key of ['contact_name', 'contact_email', 'contact_phone_no', 'contact_address', 'notice_text', 'contact_organization']) {
            expect(p, key).not.toHaveProperty(key);
        }
    });

    it('a real Contract Award that omits contact_organization and the deadline falls back / nulls instead of throwing', () => {
        expect(awardHn.contact_organization).toBeUndefined();
        expect(awardHn.submission_deadline_date).toBeUndefined();
        const p = normalizeWorldBankProcurementNotice(awardHn);
        expect(p).toMatchObject({
            category_or_type: 'Contract Award',
            awarding_or_regulating_agency: 'World Bank',
            effective_date_iso: null,
            source_document_url: null,
            entity_identifier_native: 'HN-SE-548371-NC-RFQ',
            submission_deadline_time: null,
            notice_text_fingerprint: null,
        });
    });

    it('entity_identifier_native falls back to the project id when there is no bid reference (SYNTHETIC)', () => {
        const p = normalizeWorldBankProcurementNotice({ id: 'x', project_id: 'P123' });
        expect(p).toMatchObject({ entity_identifier_native: 'P123', reference_number: null, awarding_or_regulating_agency: 'World Bank', publish_date_iso: null });
    });

    it('legacy fixture: personal contact data and the notice body never reach the payload, but the text is fingerprinted', () => {
        const p = normalizeWorldBankProcurementNotice(kenya);
        const serialised = JSON.stringify(p);
        for (const secret of ['kusp2proc@housingandurban.go.ke', 'Lilian Kieni', '0202734886', 'P.O. Box 30260', 'REQUEST FOR EXPRESSION OF INTEREST']) {
            expect(serialised, secret).not.toContain(secret);
        }
        expect(p.notice_text_fingerprint).toEqual(expect.any(String));
        expect(p.entity_identifier_native).toBe('KE-MOTI-566726-CS-QCBS');
        expect(normalizeWorldBankProcurementNotice(india).notice_text_fingerprint).toBeNull();
        expect(normalizeWorldBankProcurementNotice(peru).awarding_or_regulating_agency).toBe('Ministerio de Vivienda, Construccion y Saneamiento');
    });

    it('noticeTextToPlain strips markup and treats block re-wrapping as no change', () => {
        expect(noticeTextToPlain('<p>a</p><p>b</p>')).toBe('a b');
        expect(noticeTextToPlain('<p>a</p>\n<p>b</p>')).toBe('a b');
        expect(noticeTextToPlain('<p>x&nbsp;&nbsp;y</p><script>evil()</script><br>z')).toBe('x y z');
        expect(noticeTextToPlain('<p>&nbsp;</p>')).toBeNull();
        expect(noticeTextToPlain(null)).toBeNull();
    });

    it('the payload carries no router-owned and no legacy delta-engine keys (event_type is the router\'s delta_status now)', () => {
        const p = normalizeWorldBankProcurementNotice(reoiSn);
        for (const key of [...ROUTER_OWNED_KEYS, ...LEGACY_DELTA_KEYS]) expect(p, key).not.toHaveProperty(key);
    });

    it('watchText is buyer + project + bid title', () => {
        expect(watchTextOf(reoiSn)).toBe(
            "SENEGAL NATIONAL ELECTRICITY AGENCY Senegal Energy Access Scale Up Project Recrutement d'un Consultant pour la Réalisation des Etudes APS et APD pour l'Electrification à Moindre Coût de Localités dans le Périmètre de Senelec - MEPM (1600 Localités)",
        );
        expect(watchTextOf({ id: 'x' })).toBe('');
    });
});

describe('recordId and fingerprint', () => {
    it('recordId is the legacy wb-procnotice-<id> and is stable', () => {
        const a = toSourceRecord(kenya);
        expect(a.recordId).toBe('wb-procnotice-OP00467118');
        const b = toSourceRecord(structuredClone(kenya));
        expect(b.recordId).toBe(a.recordId);
        expect(b.fingerprint).toBe(a.fingerprint);
    });

    it('the fingerprint changes for a status transition, a deadline move, a description fix and an edited notice text', () => {
        const base = toSourceRecord(kenya).fingerprint;
        const changed = (patch: Partial<WorldBankProcNoticeRaw>) => toSourceRecord({ ...kenya, ...patch }).fingerprint;
        expect(changed({ notice_status: 'Closed' })).not.toBe(base);
        expect(changed({ submission_deadline_date: '2026-10-20T00:00:00Z' })).not.toBe(base);
        expect(changed({ submission_deadline_time: '11:00' })).not.toBe(base);
        expect(changed({ bid_description: 'Corrected description' })).not.toBe(base);
        expect(changed({ notice_text: '<p>An edited notice body</p>' })).not.toBe(base);
        expect(changed({ procurement_method_name: 'Direct Selection' })).not.toBe(base);
    });

    it('a pure re-wrap of the notice HTML is not a change (SYNTHETIC)', () => {
        const wrapped = { ...kenya, notice_text: '<p>one</p><p>two</p>' };
        const rewrapped = { ...kenya, notice_text: '<p>one</p>\n<p>two</p>' };
        expect(toSourceRecord(rewrapped).fingerprint).toBe(toSourceRecord(wrapped).fingerprint);
    });

    it('contact-person columns are not emitted, so changing only them does not re-emit the record (documented privacy trade-off)', () => {
        const base = toSourceRecord(kenya).fingerprint;
        expect(toSourceRecord({ ...kenya, contact_email: 'new.person@example.org', contact_name: 'Someone Else', contact_phone_no: '000', contact_address: 'elsewhere' }).fingerprint).toBe(base);
    });
});

describe('options and exact-match filters', () => {
    it('applies defaults and needs no credential', () => {
        expect(opts()).toEqual({ pageSize: 50 });
        expect(worldBankNoticesConnector.requiredOptions).toBeUndefined();
        const input = EngineInputSchema.parse({ sources: ['world_bank_notices'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [worldBankNoticesConnector] }, input)).toHaveLength(1);
    });

    it('validates pageSize and dateRange and rejects copied-over legacy keys', () => {
        expect(worldBankNoticesOptionsSchema.safeParse({ pageSize: 201 }).success).toBe(false);
        expect(worldBankNoticesOptionsSchema.safeParse({ pageSize: 0 }).success).toBe(false);
        expect(worldBankNoticesOptionsSchema.safeParse({ pageSize: 200 }).success).toBe(true);
        expect(worldBankNoticesOptionsSchema.safeParse({ dateRange: '3d' }).success).toBe(false);
        for (const range of ['24h', '7d', '30d', '90d', '365d']) expect(worldBankNoticesOptionsSchema.safeParse({ dateRange: range }).success).toBe(true);
        for (const key of ['onlyNew', 'sources', 'maxItemsPerSource']) expect(worldBankNoticesOptionsSchema.safeParse({ [key]: 1 }).success, key).toBe(false);
        expect(worldBankNoticesOptionsSchema.safeParse({ countryFilter: 5 }).success).toBe(false);
    });

    it('rejects a bad option in router preflight', () => {
        const input = EngineInputSchema.parse({ sources: ['world_bank_notices'], sourceOptions: { world_bank_notices: { pageSize: 500 } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [worldBankNoticesConnector] }, input)).toThrow(FatalConfigError);
    });

    it('matchesExactList is exact, case-insensitive and whitespace-normalised: "Niger" does not match "Nigeria"', () => {
        const list = sanitizeKeywordList(['Niger', ' kenya  ']);
        expect(matchesExactList('Niger', list)).toBe(true);
        expect(matchesExactList('NIGER', list)).toBe(true);
        expect(matchesExactList('Nigeria', list)).toBe(false);
        expect(matchesExactList('Kenya', list)).toBe(true);
        expect(matchesExactList(null, list)).toBe(false);
        expect(matchesExactList('anything', sanitizeKeywordList(undefined))).toBe(true); // empty list = no filtering
        expect(matchesExactList(null, sanitizeKeywordList(undefined))).toBe(true);
    });
});

describe('fetch (stubbed http)', () => {
    it('GETs the documented URL with no custom headers and returns the live notices (the stub ends the walk with an empty page)', async () => {
        const stub = makeCtx((request) => {
            if (request.url === url(50, 0)) return liveEnvelope;
            if (request.url === url(50, 3)) return envelopeOf([], 423546, 3);
            return new Error(`unexpected ${request.url}`);
        }, '2026-10-21T00:00:00Z');
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['wb-procnotice-OP00469523', 'wb-procnotice-OP00470730', 'wb-procnotice-OP00476003']);
        expect(stub.requests.map((r) => r.url)).toEqual([url(50, 0), url(50, 3)]);
        for (const request of stub.requests) {
            expect(request.method).toBe('GET');
            expect(request.via).toBe('getJson');
            expect(request.headers).toEqual({}); // honest identification is lib/http.ts's job; nothing is overridden here
        }
        expect(ifbMg.procurement_method_code).toBe('RFB');
    });

    it('pages by offset and de-duplicates a notice that reappears because the feed grew between pages (legacy scenario, SYNTHETIC ids)', async () => {
        const served: Record<number, Array<Record<string, unknown>>> = {
            0: [notice('n5'), notice('n4')],
            2: [notice('n4'), notice('n3')], // total grew; "n4" shifted back into view
            4: [notice('n2'), notice('n1')],
        };
        const totals: Record<number, number> = { 0: 5, 2: 6, 4: 6 };
        const stub = makeCtx((request) => {
            const os = Number(new URL(request.url).searchParams.get('os'));
            return served[os] ? envelopeOf(served[os] as Array<Record<string, unknown>>, totals[os] as number, os) : new Error(`unexpected os=${os}`);
        });
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts({ pageSize: 2 }), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['wb-procnotice-n5', 'wb-procnotice-n4', 'wb-procnotice-n3', 'wb-procnotice-n2', 'wb-procnotice-n1']);
        expect(stub.requests).toHaveLength(3);
    });

    it('stops paging once maxItemsPerSource is reached', async () => {
        const all = Array.from({ length: 20 }, (_, i) => notice(`m${i}`));
        const stub = makeCtx(feed(all, 1000));
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts({ pageSize: 2 }), { maxItemsPerSource: 3 });
        expect(records).toHaveLength(3);
        expect(stub.requests).toHaveLength(2);
    });

    it('stops when the reported total is reached and on an empty page', async () => {
        const all = Array.from({ length: 5 }, (_, i) => notice(`t${i}`));
        const byTotal = makeCtx(feed(all));
        expect(await worldBankNoticesConnector.fetch(byTotal.ctx, opts({ pageSize: 2 }), RUN)).toHaveLength(5);
        expect(byTotal.requests).toHaveLength(3); // os 0, 2, 4 -> os 6 >= total 5

        const byEmpty = makeCtx(feed(all, 1000));
        expect(await worldBankNoticesConnector.fetch(byEmpty.ctx, opts({ pageSize: 2 }), RUN)).toHaveLength(5);
        expect(byEmpty.requests).toHaveLength(4); // os 6 returns an empty page
    });

    it('client-side country / notice-type filters are exact and count only matches against maxItemsPerSource', async () => {
        const all = [
            notice('a', { project_ctry_name: 'Nigeria' }),
            notice('b', { project_ctry_name: 'Niger' }),
            notice('c', { project_ctry_name: 'Kenya', notice_type: 'Contract Award' }),
            notice('d', { project_ctry_name: 'KENYA' }),
            notice('e', { project_ctry_name: null }),
        ];
        const niger = await worldBankNoticesConnector.fetch(makeCtx(feed(all)).ctx, opts({ countryFilter: ['Niger'] }), RUN);
        expect(niger.map((r) => r.recordId)).toEqual(['wb-procnotice-b']);
        const kenyaOnly = await worldBankNoticesConnector.fetch(makeCtx(feed(all)).ctx, opts({ countryFilter: ['kenya'] }), RUN);
        expect(kenyaOnly.map((r) => r.recordId)).toEqual(['wb-procnotice-c', 'wb-procnotice-d']);
        const awards = await worldBankNoticesConnector.fetch(makeCtx(feed(all)).ctx, opts({ noticeTypeFilter: ['contract award'] }), RUN);
        expect(awards.map((r) => r.recordId)).toEqual(['wb-procnotice-c']);
        const both = await worldBankNoticesConnector.fetch(makeCtx(feed(all)).ctx, opts({ countryFilter: 'Kenya, Niger', noticeTypeFilter: ['Invitation for Bids'] }), RUN);
        expect(both.map((r) => r.recordId)).toEqual(['wb-procnotice-b', 'wb-procnotice-d']);
        const capped = await worldBankNoticesConnector.fetch(makeCtx(feed(all)).ctx, opts({ countryFilter: ['Kenya'], pageSize: 1 }), { maxItemsPerSource: 1 });
        expect(capped.map((r) => r.recordId)).toEqual(['wb-procnotice-c']);
    });

    it('keyword guard: blank / one-character / non-string filter entries mean "no filtering" (never "null country matches"), and are logged', async () => {
        const all = [notice('a', { project_ctry_name: null }), notice('b', { project_ctry_name: 'Kenya' })];
        for (const bad of [[''], [' '], ['a'], ['--'], [null], ''] as unknown[]) {
            const stub = makeCtx(feed(all));
            const records = await worldBankNoticesConnector.fetch(stub.ctx, { ...opts(), countryFilter: bad as never, noticeTypeFilter: bad as never }, RUN);
            expect(records, JSON.stringify(bad)).toHaveLength(2);
            expect(stub.logs.warning.some((m) => /NO countryFilter filtering is applied/.test(m)), JSON.stringify(bad)).toBe(true);
        }
    });

    it('dateRange keeps notices inside the window against the run clock (legacy fixture, SYNTHETIC clock 2026-09-05T12:00Z)', async () => {
        const responder: Responder = (request) => (new URL(request.url).searchParams.get('os') === '0' ? legacyEnvelope : envelopeOf([], 1000, 0));
        const at = (range: string) => worldBankNoticesConnector.fetch(makeCtx(responder, '2026-09-05T12:00:00Z').ctx, opts({ dateRange: range }), RUN);
        expect((await at('24h')).map((r) => r.recordId)).toEqual(['wb-procnotice-OP00467118']);
        expect((await at('7d')).map((r) => r.recordId)).toEqual(['wb-procnotice-OP00467118', 'wb-procnotice-OP00467020', 'wb-procnotice-OP00466911']);
    });

    it('a future-dated notice never matches a dateRange (SYNTHETIC)', async () => {
        const stub = makeCtx(feed([notice('future', { noticedate: '25-Dec-2026' }), notice('now', { noticedate: '21-Oct-2026' })]), '2026-10-21T12:00:00Z');
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts({ dateRange: '30d' }), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['wb-procnotice-now']);
    });

    it('stops at the first page that is entirely older than the window (the feed is newest-first, live-verified) (SYNTHETIC pages)', async () => {
        const all = [
            notice('p1a', { noticedate: '19-Oct-2026' }),
            notice('p1b', { noticedate: '18-Oct-2026' }),
            notice('p2a', { noticedate: '10-Oct-2026' }),
            notice('p2b', { noticedate: '09-Oct-2026' }),
            notice('p3a', { noticedate: '08-Oct-2026' }),
            notice('p3b', { noticedate: '07-Oct-2026' }),
        ];
        const stub = makeCtx(feed(all, 100_000), '2026-10-21T00:00:00Z');
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts({ pageSize: 2, dateRange: '7d' }), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['wb-procnotice-p1a', 'wb-procnotice-p1b']);
        expect(stub.requests).toHaveLength(2); // page 2 was entirely older -> page 3 never requested
        expect(stub.logs.info.some((m) => /a page entirely older than 7d/.test(m))).toBe(true);
    });

    it('does not stop early on a mixed page, or on a page whose dates cannot be parsed (SYNTHETIC)', async () => {
        const mixed = [notice('a', { noticedate: '19-Oct-2026' }), notice('b', { noticedate: '01-Jan-2020' }), notice('c', { noticedate: '18-Oct-2026' }), notice('d', { noticedate: '17-Oct-2026' })];
        const stubMixed = makeCtx(feed(mixed), '2026-10-21T00:00:00Z');
        const kept = await worldBankNoticesConnector.fetch(stubMixed.ctx, opts({ pageSize: 2, dateRange: '7d' }), RUN);
        expect(kept.map((r) => r.recordId)).toEqual(['wb-procnotice-a', 'wb-procnotice-c', 'wb-procnotice-d']);

        const undated = [notice('u1', { noticedate: null }), notice('u2', { noticedate: 'garbage' }), notice('u3', { noticedate: '19-Oct-2026' })];
        const stubUndated = makeCtx(feed(undated), '2026-10-21T00:00:00Z');
        const result = await worldBankNoticesConnector.fetch(stubUndated.ctx, opts({ pageSize: 2, dateRange: '7d' }), RUN);
        expect(result.map((r) => r.recordId)).toEqual(['wb-procnotice-u3']);
        expect(stubUndated.requests).toHaveLength(2);
    });

    it('the safety cap ends a walk that matches nothing after HARD_PAGE_FETCH_CAP pages', async () => {
        const stub = makeCtx((request) => {
            const os = Number(new URL(request.url).searchParams.get('os'));
            return envelopeOf([notice(`x${os}`, { project_ctry_name: 'Elsewhere' })], 10_000_000, os);
        });
        const records = await worldBankNoticesConnector.fetch(stub.ctx, opts({ pageSize: 1, countryFilter: ['Kenya'] }), RUN);
        expect(records).toEqual([]);
        expect(stub.requests).toHaveLength(HARD_PAGE_FETCH_CAP);
        expect(stub.logs.info.some((m) => /safety cap/.test(m))).toBe(true);
    });
});

describe('failure paths (SourceFetchError)', () => {
    const offsetBody =
        '{"Debug":true,"error":"400 - {\\"error\\":{\\"code\\":\\"InvalidRequestParameter\\",\\"message\\":\\"Value must be between 0 and 100000.\\\\r\\\\nParameter name: $skip\\"}}"}';

    it('an HTTP error (the live offset-ceiling 400) fails the source with the status and the body preview', async () => {
        const stub = makeCtx(() => new HttpStatusError(url(50, 150000), 400, offsetBody));
        const error = await worldBankNoticesConnector.fetch(stub.ctx, opts(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe('world_bank_notices');
        expect((error as Error).message).toMatch(/HTTP 400.*between 0 and 100000/);
    });

    it('a network failure fails the source', async () => {
        const stub = makeCtx(() => new TypeError('fetch failed: ECONNRESET'));
        await expect(worldBankNoticesConnector.fetch(stub.ctx, opts(), RUN)).rejects.toThrow(/network-level failure.*ECONNRESET/);
    });

    it('an envelope that does not match the contract, or a non-numeric total, fails the source instead of returning "no notices"', async () => {
        for (const bad of [{ error: 'x' }, null, 'html', { ...liveEnvelope, procnotices: [{ notice_type: 'x' }] }]) {
            await expect(worldBankNoticesConnector.fetch(makeCtx(() => bad).ctx, opts(), RUN)).rejects.toBeInstanceOf(SourceFetchError);
        }
        await expect(worldBankNoticesConnector.fetch(makeCtx(() => ({ ...liveEnvelope, total: 'lots' })).ctx, opts(), RUN)).rejects.toThrow(/non-numeric total/);
    });

    it('a failure on page 2 fails the whole source (no silent partial result)', async () => {
        const stub = makeCtx((request) => (new URL(request.url).searchParams.get('os') === '0' ? envelopeOf([notice('a'), notice('b')], 100, 0) : new HttpStatusError(request.url, 503, '')));
        await expect(worldBankNoticesConnector.fetch(stub.ctx, opts({ pageSize: 2 }), RUN)).rejects.toThrow(/HTTP 503/);
    });
});

describe('through the real router', () => {
    const engineInput = (extra: Record<string, unknown> = {}) => ({ sources: ['world_bank_notices'], deltaMode: 'onlyChanged', maxItemsPerSource: 100, ...extra });
    const served = (envelope: Envelope): Responder => (request) => (new URL(request.url).searchParams.get('os') === '0' ? envelope : envelopeOf([], 1000, 0));

    it('first run emits the three live notices as first_seen; an identical second run emits and bills nothing', async () => {
        const store = new InMemoryDeltaStore();
        const first = await runThroughRouter(worldBankNoticesConnector, engineInput(), makeCtx(served(liveEnvelope)), store);
        expect(first.rows).toHaveLength(3);
        expect(first.rows[0]).toMatchObject({
            engine: 'latam-global-tender-intelligence',
            source: 'world_bank_notices',
            record_id: 'wb-procnotice-OP00469523',
            delta_status: 'first_seen',
            is_new: true,
            jurisdiction: 'WB',
            category_or_type: 'Request for Expression of Interest',
        });
        expect(first.billing.totalFor(RESULT_EVENT)).toBe(3);

        const second = await runThroughRouter(worldBankNoticesConnector, engineInput(), makeCtx(served(liveEnvelope)), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 3, emitted: 0, unchanged: 3 });
    });

    it('a status transition re-emits the notice as "updated" (the legacy STATUS_CHANGE)', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(worldBankNoticesConnector, engineInput(), makeCtx(served(liveEnvelope)), store);
        const edited: Envelope = { ...liveEnvelope, procnotices: liveEnvelope.procnotices.map((n, i) => (i === 0 ? { ...n, notice_status: 'Closed' } : n)) };
        const next = await runThroughRouter(worldBankNoticesConnector, engineInput(), makeCtx(served(edited)), store);
        expect(next.rows).toHaveLength(1);
        expect(next.rows[0]).toMatchObject({ record_id: 'wb-procnotice-OP00469523', delta_status: 'updated', status_or_estado: 'Closed' });
    });

    it('a watchlist keyword matches the buyer / project / title and bills one hit; ghost-billing inputs bill none', async () => {
        const hit = await runThroughRouter(worldBankNoticesConnector, engineInput({ watchlistNames: ['Electrification'] }), makeCtx(served(liveEnvelope)));
        expect(hit.rows.filter((r) => r.is_watchlist_match === true).map((r) => r.record_id)).toEqual(['wb-procnotice-OP00469523']);
        expect(hit.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);

        const byBuyer = await runThroughRouter(worldBankNoticesConnector, engineInput({ watchlistNames: ['UGP PAAEP-JIRAMA'] }), makeCtx(served(liveEnvelope)));
        expect(byBuyer.rows.filter((r) => r.is_watchlist_match === true).map((r) => r.record_id)).toEqual(['wb-procnotice-OP00476003']);

        for (const watchlistNames of [[''], [' '], '', ['a']]) {
            const none = await runThroughRouter(worldBankNoticesConnector, engineInput({ watchlistNames }), makeCtx(served(liveEnvelope)));
            expect(none.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(none.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('an upstream failure is isolated to the source and reported', async () => {
        const result = await runThroughRouter(worldBankNoticesConnector, engineInput(), makeCtx(() => new HttpStatusError(url(50, 0), 503, 'down')));
        expect(result.rows).toHaveLength(0);
        expect(result.summary.sources[0]?.error).toMatch(/HTTP 503/);
    });
});
