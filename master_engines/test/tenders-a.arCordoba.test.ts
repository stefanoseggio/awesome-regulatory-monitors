/**
 * ar_cordoba connector tests.
 *
 * The portal could NOT be reached from the sandbox in this session (connection reset; see the connector header), so
 * everything here is fixture-driven and the walk is exercised against a stub that mimics the ASP.NET session chain.
 *
 * Fixtures (test/fixtures/tenders-a/):
 *   - cordoba.trimmed.page1.html / page2.html / page8_last.html / page9_no_rows.html: TRIMMED REAL CAPTURES derived from
 *     the legacy actor's test/fixtures (real captures of 2026-09-04; each file's leading comment says exactly what was
 *     changed: __VIEWSTATE / __EVENTVALIDATION values shortened, page chrome dropped, only the first N grid rows kept;
 *     hidden inputs, grid rows and pager verbatim). page9_no_rows has ALL grid rows removed to stand for "the page after
 *     the last"; the other three keep 3 / 2 / 2 real rows.
 *   - cordoba.legacy.page_no_results.html: COPIED VERBATIM (hand-built by the legacy authors: a header-only #gv, the
 *     shape observed live for a genuine 0-tender day).
 *   - cordoba.legacy.page_bot_check.html: COPIED VERBATIM (hand-built by the legacy authors: HTTP-200 page with no #gv).
 * Everything else is SYNTHETIC and labelled where used: the session cookies, the mutated pagers / rows, and the fake
 * certificate bodies (random base64, NOT real certificates).
 */
import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';

import {
    arCordobaConnector,
    arCordobaOptionsSchema,
    BASE_URL,
    buildPostbackPayload,
    certificateOnlyPemProblem,
    CORDOBA_SOURCE_ID,
    extractFormFields,
    getCurrentPage,
    hasNextBlockLink,
    hasPageLink,
    hasResultsGrid,
    isWithinDateRange,
    parseFechaInicio,
    parseGrid,
    toSourceRecord,
} from '../latam-global-tender-intelligence/connectors/arCordoba.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, makeCtx, ROUTER_OWNED_KEYS, runThroughRouter, type StubRequest, type StubResponse } from './tenders-a.helpers.js';

const RUN: RunParams = { maxItemsPerSource: 100 };
const P1 = fixture('cordoba.trimmed.page1.html');
const P2 = fixture('cordoba.trimmed.page2.html');
const P8 = fixture('cordoba.trimmed.page8_last.html');
const P9 = fixture('cordoba.trimmed.page9_no_rows.html');
const NO_RESULTS = fixture('cordoba.legacy.page_no_results.html');
const BOT_CHECK = fixture('cordoba.legacy.page_bot_check.html');

const load = (html: string) => cheerio.load(html);
const options = (input: Record<string, unknown> = {}) => arCordobaOptionsSchema.parse(input);

/** SYNTHETIC fake certificate body: valid base64, 160 chars - NOT a real certificate. */
const FAKE_BODY = 'QUJD'.repeat(40);
const FAKE_CERT = `-----BEGIN CERTIFICATE-----\n${FAKE_BODY}\n-----END CERTIFICATE-----`;
const FAKE_BUNDLE = `${FAKE_CERT}\n${FAKE_CERT}\n`;

/**
 * A stateful stub of the portal: the GET returns page 1 and sets a session cookie; each POST must carry the cookie the
 * previous response set and returns the page `chain[postIndex]` (setting a rotated cookie when `rotate` is true).
 * A POST with the wrong cookie gets the session-expired page (no #gv), exactly the failure the real chain produces.
 */
function sessionPortal(chain: string[], opts: { rotate?: boolean; firstCookie?: string | null; expectCookie?: string } = {}) {
    let expected: string | null = opts.firstCookie === undefined ? 'ASP.NET_SessionId=sess-1' : opts.firstCookie;
    const initial = expected;
    if (opts.expectCookie !== undefined) expected = opts.expectCookie;
    let posts = 0;
    return (request: StubRequest): StubResponse => {
        if (request.init?.method !== 'POST') {
            return { body: P1, setCookies: initial ? [`${initial}; path=/; HttpOnly`, 'other=ignored; path=/'] : [] };
        }
        const sent = request.init.headers?.cookie ?? null;
        if (sent !== expected) return { body: BOT_CHECK };
        const body = chain[posts] ?? P9;
        posts += 1;
        if (opts.rotate) {
            expected = `ASP.NET_SessionId=sess-${posts + 1}`;
            return { body, setCookies: [`${expected}; path=/; HttpOnly`] };
        }
        return { body };
    };
}

function posts(calls: StubRequest[]) {
    return calls.filter((c) => c.init?.method === 'POST');
}

function target(call: StubRequest | undefined): string | null {
    return new URLSearchParams(call?.init?.body).get('__EVENTTARGET');
}

describe('form / pager / grid parsers (trimmed real captures)', () => {
    it('parseGrid reads the 9-cell rows, the per-item popup and the contact phone', () => {
        const rows = parseGrid(load(P1));
        expect(rows.map((r) => r.nroCotizacion)).toEqual(['2026/000091', '2026/000090', '2026/000089']);
        expect(rows[0]).toEqual({
            nroCotizacion: '2026/000091',
            tipoContratacion: 'Licitación - Soporte Digital',
            servicioAdministrativo: 'Agencia Córdoba De Inversión Y Financiamiento',
            jurisdiccion: 'Agencia Córdoba De Inversión Y Financiamiento',
            fechaInicio: '04/09/2026 09:21:28',
            fechaFinalizacion: '21/09/2026 12:00:00',
            estado: 'EN PROCESO',
            prorroga: false,
            items: [
                {
                    renglon: 'EJECUCIÓN DUPLICACIÓN Y ROTONDA EN CALLE REFORMA UNIVERSITARIA DE LA CIUDAD DE RÍO CUARTO - DPTO RIO CUARTO',
                    cantidad: '1',
                    precioReferencia: '$ 3.961.365.736,2000',
                    presupuestoOficial: '$ 3.961.365.736,2000',
                },
            ],
            telefonoContacto: '3517660269',
        });
        expect(parseGrid(load(P2)).map((r) => r.nroCotizacion)).toEqual(['2026/000077', '2026/000076']);
        expect(parseGrid(load(P8)).map((r) => r.nroCotizacion)).toEqual(['2026/000013', '2026/000014']);
    });

    it('distinguishes a genuine 0-tender day (header-only #gv) from a page without the grid', () => {
        expect(parseGrid(load(NO_RESULTS))).toEqual([]);
        expect(hasResultsGrid(load(NO_RESULTS))).toBe(true);
        expect(parseGrid(load(BOT_CHECK))).toEqual([]);
        expect(hasResultsGrid(load(BOT_CHECK))).toBe(false);
        expect(hasResultsGrid(load(P9))).toBe(true);
        expect(parseGrid(load(P9))).toEqual([]);
    });

    it('reads the sliding 11-slot pager: the active slot id shifts, `paglbN` links, `paglbS` past the window', () => {
        expect(getCurrentPage(load(P1))).toBe(1);
        expect(hasPageLink(load(P1), 2)).toBe(true);
        expect(hasPageLink(load(P1), 1)).toBe(false); // the active slot is a label, not a link
        expect(getCurrentPage(load(P2))).toBe(2);
        expect(hasPageLink(load(P2), 3)).toBe(true);
        expect(hasPageLink(load(P2), 12)).toBe(false);
        expect(hasNextBlockLink(load(P2))).toBe(true);
        expect(getCurrentPage(load(P8))).toBe(8);
        expect(hasNextBlockLink(load(NO_RESULTS))).toBe(false);
    });

    it('builds the postback exactly like a browser: hidden fields + selects, buttons and unchecked checkboxes omitted', () => {
        const fields = extractFormFields(load(P1));
        expect(fields.__VIEWSTATE).toBe('TRIMMED_VIEWSTATE_TOKEN');
        expect(fields.__VIEWSTATEGENERATOR).toBe('C9F7B97E');
        expect(fields.__VIEWSTATEENCRYPTED).toBe('');
        expect(fields.ddlID_VIGENCIA).toBe('172'); // the select's `selected` option
        expect(fields.ddljurisdiccion).toBe('--Seleccionar--');
        expect(fields).not.toHaveProperty('ddljurisdiccion_CheckBoxLista$0'); // unchecked checkbox
        expect(buildPostbackPayload(load(P1), 'paglb2')).toMatchObject({ __EVENTTARGET: 'paglb2', __EVENTARGUMENT: '', __VIEWSTATE: 'TRIMMED_VIEWSTATE_TOKEN' });
    });

    it('includes only CHECKED checkboxes / radios, the first option of an unselected select, textareas, and skips buttons (SYNTHETIC form)', () => {
        const $ = load(`<form>
            <input type="hidden" name="h" value="1"/><input type="text" name="t"/>
            <input type="checkbox" name="c1" value="v1" checked="checked"/><input type="checkbox" name="c2" value="v2"/>
            <input type="checkbox" name="c3" checked="checked"/><input type="radio" name="r" value="a"/><input type="radio" name="r" value="b" checked/>
            <input type="submit" name="s" value="go"/><input type="image" name="i"/><input type="button" name="b"/><input type="reset" name="x"/>
            <select name="sel"><option value="o1">1</option><option value="o2">2</option></select>
            <select name="sel2"><option value="p1">1</option><option selected value="p2">2</option></select>
            <textarea name="ta">hello</textarea></form>`);
        expect(extractFormFields($)).toEqual({ h: '1', t: '', c1: 'v1', c3: 'on', r: 'b', sel: 'o1', sel2: 'p2', ta: 'hello' });
    });
});

describe('date window', () => {
    it('converts Argentina wall-clock (fixed UTC-3) to UTC and rejects other shapes', () => {
        expect(parseFechaInicio('04/09/2026 09:21:28')?.toISOString()).toBe('2026-09-04T12:21:28.000Z');
        expect(parseFechaInicio('04/09/2026')).toBeNull();
        expect(parseFechaInicio('')).toBeNull();
        expect(parseFechaInicio(undefined)).toBeNull();
    });

    it('keeps everything when no preset is set, drops unparseable dates when one is, and is inclusive at the boundary', () => {
        const now = new Date('2026-09-05T12:21:28Z');
        expect(isWithinDateRange(null, undefined, now)).toBe(true);
        expect(isWithinDateRange(null, '24h', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-09-04T12:21:28Z'), '24h', now)).toBe(true);
        expect(isWithinDateRange(new Date('2026-09-04T12:21:27Z'), '24h', now)).toBe(false);
        expect(isWithinDateRange(new Date('2026-09-20T12:21:28Z'), '24h', now)).toBe(true); // legacy: a future date passes
    });
});

describe('options validation', () => {
    it('has no required option and no credential; an empty slice passes preflight', () => {
        expect(arCordobaConnector.requiredOptions ?? []).toEqual([]);
        expect(options()).toEqual({});
        const input = EngineInputSchema.parse({ sources: ['AR_Cordoba'] });
        expect(resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arCordobaConnector] }, input)).toHaveLength(1);
    });

    it('accepts a certificate-only PEM bundle and normalises line endings; a blank value means "not set"', () => {
        expect(options({ extraCaPem: FAKE_BUNDLE.replace(/\n/g, '\r\n') }).extraCaPem).toBe(`${FAKE_CERT}\n${FAKE_CERT}`);
        expect(options({ extraCaPem: '   ' }).extraCaPem).toBeUndefined();
        expect(options({ extraCaPem: '' }).extraCaPem).toBeUndefined();
        expect(options({ dateRange: '7d' }).dateRange).toBe('7d');
    });

    it('rejects anything that is not a certificate-only PEM: private keys, stray text, bad base64, no block, too many, too large', () => {
        const key = `-----BEGIN PRIVATE KEY-----\n${FAKE_BODY}\n-----END PRIVATE KEY-----`;
        const rsa = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\n${FAKE_BODY}\n-----END RSA PRIVATE KEY-----`;
        const cases: Array<[string, string, RegExp]> = [
            ['a PKCS#8 private key', key, /private-key material/],
            ['an RSA key', rsa, /private-key material/],
            ['a certificate followed by a private key', `${FAKE_CERT}\n${key}`, /private-key material/],
            ['a public key block', `-----BEGIN PUBLIC KEY-----\n${FAKE_BODY}\n-----END PUBLIC KEY-----`, /non-certificate PEM block/],
            ['stray text around a certificate', `hello\n${FAKE_CERT}`, /outside the certificate blocks/],
            ['no block at all', 'just some words', /no "-----BEGIN CERTIFICATE-----" block/],
            ['a body that is not base64', `-----BEGIN CERTIFICATE-----\n${'!'.repeat(80)}\n-----END CERTIFICATE-----`, /not valid base64/],
            ['a body that is too short', '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----', /not valid base64/],
            ['11 certificates', Array.from({ length: 11 }, () => FAKE_CERT).join('\n'), /more than 10 certificates/],
            ['an oversized value', `${FAKE_CERT}\n${' '.repeat(70_000)}`, /larger than 65536/],
        ];
        for (const [name, pem, message] of cases) {
            expect(certificateOnlyPemProblem(pem), name).toMatch(message);
            const parsed = arCordobaOptionsSchema.safeParse({ extraCaPem: pem });
            expect(parsed.success, name).toBe(false);
            if (!parsed.success) expect(parsed.error.issues[0]?.message, name).toMatch(/^extraCaPem /);
        }
        expect(certificateOnlyPemProblem(FAKE_BUNDLE)).toBeNull();
    });

    it('rejects unknown keys, a bad window and the proxy / legacy options the master engine does not carry (preflight)', () => {
        for (const bad of [{ dateRange: '1y' }, { proxyConfiguration: { useApifyProxy: true } }, { proxyUrl: 'http://x' }, { onlyNew: true }, { maxItems: 5 }, { extraCaPem: 5 }]) {
            expect(arCordobaOptionsSchema.safeParse(bad).success).toBe(false);
        }
        const input = EngineInputSchema.parse({ sources: ['ar_cordoba'], sourceOptions: { ar_cordoba: { extraCaPem: 'nope' } } });
        expect(() => resolveSources({ slug: 'latam-global-tender-intelligence', connectors: [arCordobaConnector] }, input)).toThrow(/Invalid options for "ar_cordoba": extraCaPem/);
    });
});

describe('fetch: the cookie-threaded postback walk (stateful stub, getRaw available)', () => {
    it('walks page 1 -> paglb2 -> paglb3 -> paglb9 and stops on the first page without rows, threading the rotated session cookie', async () => {
        const stub = makeCtx(sessionPortal([P2, P8, P9], { rotate: true }), { raw: true });
        const records = await arCordobaConnector.fetch(stub.ctx, options(), RUN);

        expect(records.map((r) => r.recordId)).toEqual(['2026/000091', '2026/000090', '2026/000089', '2026/000077', '2026/000076', '2026/000013', '2026/000014']);
        expect(stub.calls.map((c) => [c.init?.method, c.url])).toEqual([
            ['GET', BASE_URL],
            ['POST', BASE_URL],
            ['POST', BASE_URL],
            ['POST', BASE_URL],
        ]);
        const sent = posts(stub.calls);
        expect(sent.map((c) => target(c))).toEqual(['paglb2', 'paglb3', 'paglb9']); // page 8's own pager offers paglb9, which returns no rows
        expect(sent.map((c) => c.init?.headers?.cookie)).toEqual(['ASP.NET_SessionId=sess-1', 'ASP.NET_SessionId=sess-2', 'ASP.NET_SessionId=sess-3']);
        expect(sent.every((c) => c.init?.headers?.['content-type'] === 'application/x-www-form-urlencoded')).toBe(true);
        expect(stub.calls[0]?.init?.headers?.cookie).toBeUndefined();
        // each POST body carries the PREVIOUS response's form fields
        expect(new URLSearchParams(sent[0]?.init?.body).get('__VIEWSTATE')).toBe('TRIMMED_VIEWSTATE_TOKEN');
        expect(new URLSearchParams(sent[0]?.init?.body).get('__EVENTARGUMENT')).toBe('');
        expect(stub.logs.info.some((m) => m.includes('page 9: 0 rows - end of results'))).toBe(true);
    });

    it('keeps replaying the first cookie when later responses do not rotate it', async () => {
        const stub = makeCtx(sessionPortal([P2, P9]), { raw: true });
        await arCordobaConnector.fetch(stub.ctx, options(), RUN);
        expect(posts(stub.calls).map((c) => c.init?.headers?.cookie)).toEqual(['ASP.NET_SessionId=sess-1', 'ASP.NET_SessionId=sess-1']);
    });

    it('sends the POSTs without a Cookie header when the portal never set a session cookie', async () => {
        const stub = makeCtx(sessionPortal([P2, P9], { firstCookie: null }), { raw: true });
        const records = await arCordobaConnector.fetch(stub.ctx, options(), RUN);
        expect(records).toHaveLength(5);
        expect(posts(stub.calls).every((c) => c.init?.headers?.cookie === undefined)).toBe(true);
    });

    it('falls back to the `paglbS` next-block control when the direct link for the next page is missing (SYNTHETIC mutation)', async () => {
        const noDirectLink = P2.replace('id="paglb3"', 'id="xx3"');
        expect(hasPageLink(load(noDirectLink), 3)).toBe(false);
        const stub = makeCtx(sessionPortal([noDirectLink, P9]), { raw: true });
        await arCordobaConnector.fetch(stub.ctx, options(), RUN);
        expect(posts(stub.calls).map((c) => target(c))).toEqual(['paglb2', 'paglbS']);
    });

    it('de-duplicates rows that shifted between two page requests (live data drift) and honours maxItemsPerSource as a hard cap', async () => {
        // SYNTHETIC mutation: page 2 repeats page 1's last row id (the register grew between the two requests)
        const shifted = P2.replace('2026/000077', '2026/000089');
        const drift = makeCtx(sessionPortal([shifted, P9]), { raw: true });
        const records = await arCordobaConnector.fetch(drift.ctx, options(), RUN);
        expect(records.map((r) => r.recordId)).toEqual(['2026/000091', '2026/000090', '2026/000089', '2026/000076']);

        const capped = makeCtx(sessionPortal([P2, P8, P9]), { raw: true });
        const four = await arCordobaConnector.fetch(capped.ctx, options(), { maxItemsPerSource: 4 });
        expect(four.map((r) => r.recordId)).toEqual(['2026/000091', '2026/000090', '2026/000089', '2026/000077']);
        expect(posts(capped.calls)).toHaveLength(1); // the cap stopped the walk after page 2
    });

    it('stops (with a warning, keeping what it has) when a later request fails, when the pager does not advance, or when the session is lost', async () => {
        const failing = makeCtx((request) => (request.init?.method === 'POST' ? new Error('HTTP 503') : { body: P1, setCookies: ['ASP.NET_SessionId=sess-1; path=/'] }), { raw: true });
        const partial = await arCordobaConnector.fetch(failing.ctx, options(), RUN);
        expect(partial).toHaveLength(3);
        expect(failing.logs.warning.some((m) => m.includes('request for page 2 failed after retries: HTTP 503'))).toBe(true);

        // the POST answers with page 1 again: the pager did not move
        const stuck = makeCtx((request) => ({ body: P1, setCookies: request.init?.method === 'POST' ? [] : ['ASP.NET_SessionId=sess-1; path=/'] }), { raw: true });
        const same = await arCordobaConnector.fetch(stuck.ctx, options(), RUN);
        expect(same).toHaveLength(3);
        expect(stuck.logs.warning.some((m) => m.includes('pager did not advance from page 1'))).toBe(true);

        // the portal does not recognise the replayed cookie and answers the postback with the session-expired page (no grid, no rows)
        const lost = makeCtx(sessionPortal([P2], { expectCookie: 'ASP.NET_SessionId=somebody-else' }), { raw: true });
        const wrong = await arCordobaConnector.fetch(lost.ctx, options(), RUN);
        expect(wrong.map((r) => r.recordId)).toEqual(['2026/000091', '2026/000090', '2026/000089']);
        expect(posts(lost.calls)).toHaveLength(1);
    });
});

describe('fetch: failure modes', () => {
    it('fails the source when the first response has no results grid (bot-check / expired session), never reporting "0 tenders"', async () => {
        const stub = makeCtx(() => BOT_CHECK, { raw: true });
        const error = await arCordobaConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).source).toBe(CORDOBA_SOURCE_ID);
        expect((error as SourceFetchError).message).toContain('does not contain the results grid (#gv)');
    });

    it('reads a genuine 0-tender day (header-only grid) as an empty result', async () => {
        const stub = makeCtx(() => NO_RESULTS, { raw: true });
        expect(await arCordobaConnector.fetch(stub.ctx, options(), RUN)).toEqual([]);
        expect(stub.calls).toHaveLength(1);
    });

    it('wraps a failing first request in SourceFetchError that names the documented TCP-level block and the CA hint, without trying to route around it', async () => {
        const stub = makeCtx(() => new Error('connect ETIMEDOUT 200.16.0.1:443'), { raw: true });
        const error = await arCordobaConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        const message = (error as SourceFetchError).message;
        expect(message).toContain('ETIMEDOUT');
        expect(message).toContain('blocks non-residential, non-Argentine traffic at the TCP level');
        expect(message).toContain('extraCaPem');
        expect(stub.calls).toHaveLength(1);
    });
});

describe('fetch: without the optional getRaw capability (today\'s lib/http.ts)', () => {
    it('still serves a result that fits on page 1 (a plain GET needs no cookie)', async () => {
        const stub = makeCtx(() => P1); // getText only
        const records = await arCordobaConnector.fetch(stub.ctx, options(), { maxItemsPerSource: 3 });
        expect(records.map((r) => r.recordId)).toEqual(['2026/000091', '2026/000090', '2026/000089']);
        expect(stub.calls).toHaveLength(1);
        // a genuine 0-tender day has no pager at all, so it needs no postback either
        const empty = makeCtx(() => NO_RESULTS);
        expect(await arCordobaConnector.fetch(empty.ctx, options(), RUN)).toEqual([]);
    });

    it('fails the source instead of silently truncating when more pages are needed', async () => {
        const stub = makeCtx(() => P1);
        const error = await arCordobaConnector.fetch(stub.ctx, options(), RUN).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).message).toContain('HttpClient.getRaw');
        expect((error as SourceFetchError).message).toContain('silent truncation');
        expect(stub.calls).toHaveLength(1); // no POST was attempted without the cookie
    });

    it('is isolated by the router: nothing emitted, the summary carries the reason', async () => {
        const run = await runThroughRouter(arCordobaConnector, { sources: ['ar_cordoba'] }, makeCtx(() => P1));
        expect(run.rows).toEqual([]);
        expect(run.summary.sources[0]?.error).toContain('HttpClient.getRaw');
    });
});

describe('extra CA hint', () => {
    it('forwards the validated PEM as `tlsExtraCaPem` on EVERY request, and never logs it', async () => {
        const stub = makeCtx(sessionPortal([P2, P9]), { raw: true });
        await arCordobaConnector.fetch(stub.ctx, options({ extraCaPem: FAKE_BUNDLE }), RUN);
        expect(stub.calls).toHaveLength(3);
        for (const call of stub.calls) expect(call.init?.tlsExtraCaPem).toBe(`${FAKE_CERT}\n${FAKE_CERT}`);
        const logged = Object.values(stub.logs).flat().join('\n');
        expect(logged).not.toContain(FAKE_BODY);
        expect(logged).toContain('extra CA bundle supplied (2 certificate(s))');
    });

    it('does not set the hint at all when no bundle was supplied', async () => {
        const stub = makeCtx(sessionPortal([P2, P9]), { raw: true });
        await arCordobaConnector.fetch(stub.ctx, options(), RUN);
        for (const call of stub.calls) expect(call.init).not.toHaveProperty('tlsExtraCaPem');
    });
});

describe('dateRange, fingerprint and recordId', () => {
    it('dateRange filters on fechaInicio after the capped walk, against the injected clock', async () => {
        const run = async (dateRange: string, now: string) => {
            const stub = makeCtx(sessionPortal([P2, P9]), { raw: true, now });
            const records = await arCordobaConnector.fetch(stub.ctx, options({ dateRange }), RUN);
            return records.map((r) => r.recordId);
        };
        // page 1 rows are 04/09/2026 ~09:20 ART (12:2x Z); page 2 rows are 28/08/2026 ~08:5x ART
        expect(await run('24h', '2026-09-05T00:00:00Z')).toEqual(['2026/000091', '2026/000090', '2026/000089']);
        expect(await run('24h', '2026-09-06T00:00:00Z')).toEqual([]);
        expect(await run('7d', '2026-09-06T00:00:00Z')).toEqual(['2026/000091', '2026/000090', '2026/000089']);
        expect(await run('30d', '2026-09-06T00:00:00Z')).toHaveLength(5);
    });

    async function fetchPage1(html: string) {
        const stub = makeCtx(() => html, { raw: true });
        return arCordobaConnector.fetch(stub.ctx, options(), { maxItemsPerSource: 3 });
    }

    it('maps a row to a SourceRecord with the legacy field names, no router-owned key and a buyer + type + item watchText', async () => {
        const [first] = await fetchPage1(P1);
        expect(first?.recordId).toBe('2026/000091');
        expect(first?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
        expect(first?.watchText).toBe(
            'Agencia Córdoba De Inversión Y Financiamiento Licitación - Soporte Digital EJECUCIÓN DUPLICACIÓN Y ROTONDA EN CALLE REFORMA UNIVERSITARIA DE LA CIUDAD DE RÍO CUARTO - DPTO RIO CUARTO',
        );
        expect(first?.payload).toMatchObject({ nroCotizacion: '2026/000091', estado: 'EN PROCESO', prorroga: false, telefonoContacto: '3517660269', source_url: BASE_URL });
        expect(typeof first?.payload.contentHash).toBe('string');
        for (const key of ROUTER_OWNED_KEYS) expect(first?.payload).not.toHaveProperty(key);
        expect(first?.payload).not.toHaveProperty('event_type');
    });

    it('includes the jurisdiction in the watchText only when it differs from the administrative service', () => {
        const [row] = parseGrid(load(P1));
        if (!row) throw new Error('fixture has rows');
        expect(toSourceRecord({ ...row, jurisdiccion: 'Ministerio de Obras' }).watchText).toContain('Agencia Córdoba De Inversión Y Financiamiento Ministerio de Obras Licitación');
        expect(toSourceRecord({ ...row, jurisdiccion: row.servicioAdministrativo.toUpperCase() }).watchText?.startsWith('Agencia Córdoba De Inversión Y Financiamiento Licitación')).toBe(true);
    });

    it('is identical across runs, and changes when a prórroga is granted or the estado moves, with the recordId unchanged', async () => {
        const base = await fetchPage1(P1);
        const again = await fetchPage1(P1);
        expect(again.map((r) => r.fingerprint)).toEqual(base.map((r) => r.fingerprint));

        // SYNTHETIC mutation: tender 2026/000090 is granted a prórroga (the 8th cell "NO" -> "SI") ...
        const row2 = P1.indexOf('2026/000090');
        const cell = P1.indexOf('>NO</td>', row2);
        const prorrogated = `${P1.slice(0, cell)}>SI</td>${P1.slice(cell + '>NO</td>'.length)}`;
        const granted = await fetchPage1(prorrogated);
        expect(granted.map((r) => r.recordId)).toEqual(base.map((r) => r.recordId));
        expect(granted.map((r, i) => r.fingerprint === base[i]?.fingerprint)).toEqual([true, false, true]);
        expect(granted[1]?.payload.prorroga).toBe(true);

        // ... and tender 2026/000089 changes estado
        const row3 = P1.indexOf('2026/000089');
        const estadoCell = P1.indexOf('>EN PROCESO</td>', row3);
        const adjudicada = `${P1.slice(0, estadoCell)}>ADJUDICADA</td>${P1.slice(estadoCell + '>EN PROCESO</td>'.length)}`;
        const moved = await fetchPage1(adjudicada);
        expect(moved.map((r, i) => r.fingerprint === base[i]?.fingerprint)).toEqual([true, true, false]);
        expect(moved[2]?.payload.estado).toBe('ADJUDICADA');
    });

    it('does not depend on the clock', async () => {
        const fetchAt = async (now: string) => {
            const stub = makeCtx(() => P1, { raw: true, now });
            return arCordobaConnector.fetch(stub.ctx, options(), { maxItemsPerSource: 3 });
        };
        expect((await fetchAt('2026-09-05T00:00:00Z')).map((r) => r.fingerprint)).toEqual((await fetchAt('2030-01-01T00:00:00Z')).map((r) => r.fingerprint));
    });
});

describe('end to end through the real router', () => {
    it('emits first_seen rows, is silent on an unchanged rerun, re-emits an amended tender as `updated`, and matches the watchlist on buyer + type + item', async () => {
        const store = new InMemoryDeltaStore();
        const input = { sources: ['ar_cordoba'], watchlistNames: ['rotonda'], maxItemsPerSource: 3, deltaMode: 'onlyChanged' };
        const portal = () => makeCtx(() => P1, { raw: true });
        const first = await runThroughRouter(arCordobaConnector, input, portal(), store);
        expect(first.rows.map((r) => [r.record_id, r.delta_status, r.is_watchlist_match])).toEqual([
            ['2026/000091', 'first_seen', true],
            ['2026/000090', 'first_seen', false],
            ['2026/000089', 'first_seen', false],
        ]);
        expect(first.rows[0]).toMatchObject({ engine: 'latam-global-tender-intelligence', source: 'ar_cordoba', matched_watchlist_keyword: 'rotonda' });
        expect(first.summary.watchlist.hitsCharged).toBe(1);

        const second = await runThroughRouter(arCordobaConnector, input, portal(), store);
        expect(second.rows).toHaveLength(0);

        const row2 = P1.indexOf('2026/000090');
        const cell = P1.indexOf('>NO</td>', row2);
        const prorrogated = `${P1.slice(0, cell)}>SI</td>${P1.slice(cell + '>NO</td>'.length)}`;
        const third = await runThroughRouter(arCordobaConnector, input, makeCtx(() => prorrogated, { raw: true }), store);
        expect(third.rows.map((r) => [r.record_id, r.delta_status])).toEqual([['2026/000090', 'updated']]);
    });

    it('never bills a hit for blank / whitespace / one-character watchlist entries (ghost-billing guard)', async () => {
        for (const watchlistNames of [[''], ['   '], 'a', ['e']]) {
            const run = await runThroughRouter(arCordobaConnector, { sources: ['ar_cordoba'], watchlistNames, maxItemsPerSource: 3 }, makeCtx(() => P1, { raw: true }));
            expect(run.rows).toHaveLength(3);
            expect(run.rows.every((r) => r.is_watchlist_match === false)).toBe(true);
            expect(run.summary.watchlist.hitsCharged).toBe(0);
        }
    });
});
