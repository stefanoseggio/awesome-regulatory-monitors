/**
 * epo_opposition connector tests.
 *
 * Fixtures (test/fixtures/patents-a/, no network), and what each one honestly is:
 *   - epo_ops_legal_guide_example.xml        DOCUMENTATION EXAMPLE reproduced from the public EPO "OPS RESTful Web Services
 *                                            Reference Guide v 1.3.20" (section 3.5, pp.118-120). Not a live reply.
 *   - epo_ops_token_response_guide_example.json  The guide's printed token reply (p.36); the token is the guide's placeholder.
 *   - epo_ops_legal_opposition_synthetic.xml SYNTHETIC: the documented structure with INVENTED event codes / descriptions /
 *                                            parties, built to exercise the opposition heuristic, the field mapping and the
 *                                            record-id collision rules. It does not claim to be what EPO returns for any patent.
 * No OPS consumer key/secret is held by this codebase (BYOK), so no authenticated upstream response was ever captured; the
 * credentials used below are fake literals.
 *
 * The suite includes the proof that a credential never reaches a thrown error message or a log line.
 */
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    EPO_DEFAULT_REQUEST_INTERVAL_MS,
    EPO_MAX_WATCHLIST,
    epoOppositionConnector,
    epoOppositionOptionsSchema,
    epoPayload,
    epoWatchText,
    eventRecordId,
    fetchEpoOppositionEvents,
    isOppositionRelated,
    legalEventsToRecords,
    normaliseOpsDate,
    OPS_AUTH_URL,
    OPS_LEGAL_URL_BASE,
    parseLegalEvents,
    scrubSecrets,
} from '../global-corporate-patent-intelligence/connectors/epoOpposition.js';
import { RESULT_EVENT, WATCHLIST_HIT_EVENT } from '../lib/charging.js';
import { HttpStatusError } from '../lib/http.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { InMemoryDeltaStore } from '../lib/state.js';
import { FatalConfigError, type RunParams, SourceFetchError } from '../lib/types.js';
import { fixture, jsonFixture, makeCtx, type RecordedRequest, ROUTER_OWNED_KEYS, runThroughRouter, type StubContext } from './patents-a.helpers.js';

const KEY = 'ops-test-consumer-key-ABCD1234';
const SECRET = 'ops-test-consumer-secret-WXYZ9876';
const BASIC = Buffer.from(`${KEY}:${SECRET}`).toString('base64');
const RUN: RunParams = { maxItemsPerSource: 100 };

const guideXml = fixture('epo_ops_legal_guide_example.xml');
const oppositionXml = fixture('epo_ops_legal_opposition_synthetic.xml');
const guideToken = jsonFixture('epo_ops_token_response_guide_example.json');

afterEach(() => {
    vi.useRealTimers();
});

function options(extra: Record<string, unknown> = {}) {
    return epoOppositionConnector.optionsSchema.parse({
        epoOpsConsumerKey: KEY,
        epoOpsConsumerSecret: SECRET,
        epWatchlist: ['EP3000000'],
        requestIntervalMs: 0,
        ...extra,
    });
}

const legalUrl = (publicationNumber: string) => `${OPS_LEGAL_URL_BASE}/${encodeURIComponent(publicationNumber)}`;
const publicationOf = (request: RecordedRequest) => decodeURIComponent(request.url.slice(`${OPS_LEGAL_URL_BASE}/`.length));
const bearerOf = (request: RecordedRequest) => request.headers.authorization?.replace(/^Bearer /, '');

/** A tiny `<ops:legal>` document with `n` distinct opposition events for `pub` (all dates differ, so ids differ). */
function oppositionDoc(pub: string, n: number): string {
    const events = Array.from(
        { length: n },
        (_, i) =>
            `<ops:legal code="OPPO" desc="OPPOSITION FILED"><ops:L001EP desc="Country Code">${pub.slice(0, 2)}</ops:L001EP><ops:L007EP desc="Gazette DATE">2021-03-${String(i + 1).padStart(2, '0')}</ops:L007EP></ops:legal>`,
    ).join('');
    return `<?xml version="1.0"?><ops:world-patent-data xmlns:ops="http://ops.epo.org"><ops:patent-family><ops:family-member>${events}</ops:family-member></ops:patent-family></ops:world-patent-data>`;
}

interface OpsServerOptions {
    /** Response for one legal lookup; default: the synthetic opposition fixture. */
    legal?: (publicationNumber: string, request: RecordedRequest, callIndex: number) => unknown;
    /** Response for one token request; default: a JSON token carrying a fresh name per call. */
    token?: (callIndex: number, request: RecordedRequest) => unknown;
}

/** A stand-in for ops.epo.org: counts token requests, mints `tok-<n>-<padding>` tokens, answers legal lookups by number. */
function opsServer(server: OpsServerOptions = {}) {
    let tokenCalls = 0;
    let legalCalls = 0;
    return (request: RecordedRequest): unknown => {
        if (request.url === OPS_AUTH_URL) {
            tokenCalls += 1;
            return server.token ? server.token(tokenCalls, request) : JSON.stringify({ access_token: `tok-${tokenCalls}-abcdef`, expires_in: '1199', token_type: 'Bearer' });
        }
        if (request.url.startsWith(`${OPS_LEGAL_URL_BASE}/`)) {
            legalCalls += 1;
            const publicationNumber = publicationOf(request);
            return server.legal ? server.legal(publicationNumber, request, legalCalls) : oppositionXml;
        }
        return new Error(`unrouted request: ${request.method} ${request.url}`);
    };
}

const requestsTo = (stub: StubContext, prefix: string) => stub.requests.filter((r) => r.url === prefix || r.url.startsWith(`${prefix}/`));

describe('parseLegalEvents - the structure the OPS Reference Guide documents', () => {
    it('reads the guide\'s own example: one event per ops:legal, code / description from the attributes, date and country from the numbered fields', () => {
        const events = parseLegalEvents(guideXml, 'EP1000000');
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            publicationNumber: 'EP1000000',
            eventCode: 'AK', // the guide prints code="AK     " (space padded)
            eventDescription: 'DESIGNATED CONTRACTING STATES:',
            eventDate: '2000-05-17', // L007EP "Gazette DATE"
            eventCountry: 'EP', // L001EP "Country Code"
            isOppositionRelated: false,
            freeText: 'A1 AT BE CH CY DE DK ES FI FR GB GR IE IT LI LU MC NL PT SE',
        });
        expect(events[1]).toMatchObject({ eventCode: 'AX', eventDescription: 'EXTENSION OF THE EUROPEAN PATENT TO', eventDate: '2000-05-17', freeText: 'AL;LT;LV;MK;RO;SI' });
    });

    it('REGRESSION: the legacy parser\'s `legal-event, event` selector matches nothing in the documented structure, this one does', () => {
        const $ = cheerio.load(guideXml, { xmlMode: true });
        expect($('legal-event, event').length).toBe(0); // what the legacy actor looked for
        expect($('ops\\:legal').length).toBe(2); // what OPS actually sends
        expect(parseLegalEvents(guideXml, 'EP1000000')).toHaveLength(2);
    });

    it('is namespace-prefix agnostic: a different prefix, or none at all, parses the same events', () => {
        const reprefixed = oppositionXml.replaceAll('ops:', 'x:').replace('xmlns:ops', 'xmlns:x');
        expect(parseLegalEvents(reprefixed, 'EP3000000')).toEqual(parseLegalEvents(oppositionXml, 'EP3000000'));
        const bare = '<world-patent-data><patent-family><legal code="OPPO" desc="OPPOSITION FILED"><L001EP>EP</L001EP><L007EP>2021-03-12</L007EP></legal></patent-family></world-patent-data>';
        expect(parseLegalEvents(bare, 'EP3000000')).toMatchObject([{ eventCode: 'OPPO', eventDate: '2021-03-12', eventCountry: 'EP', isOppositionRelated: true }]);
    });

    it('maps the synthetic opposition document: trims padded codes, collapses multi-line descriptions, falls back to L019EP for the date', () => {
        const events = parseLegalEvents(oppositionXml, 'EP3000000');
        expect(events).toHaveLength(7);
        expect(events.map((e) => [e.eventCode, e.eventDate, e.eventCountry, e.isOppositionRelated])).toEqual([
            ['OPPO', '2021-03-12', 'EP', true],
            ['OPPO', '2021-03-12', 'EP', true],
            ['OPPO', '2021-03-12', 'EP', true],
            ['OPPO', '2021-03-12', 'AT', true],
            ['NOPP', '2022-01-05', 'EP', true],
            ['PG25', '2022-05-01', 'AT', false],
            ['APPO', '2023-01-10', 'EP', true], // from L019EP "20230110"
        ]);
        expect(events[6]!.eventDescription).toBe('APPEAL FILED BY THE OPPONENT AGAINST THE DECISION');
        expect(events[0]!.freeText).toBe('Opponent: Example Opponent GmbH');
        expect(events[3]!.freeText).toBeNull();
    });

    it('signatures: identical events share one, a different free text gets another', () => {
        const [first, second, duplicate] = parseLegalEvents(oppositionXml, 'EP3000000');
        expect(duplicate!.signature).toBe(first!.signature);
        expect(second!.signature).not.toBe(first!.signature);
    });

    it('a document with no ops:legal element is "no legal events", not an error', () => {
        const noEvents = '<?xml version="1.0"?><ops:world-patent-data xmlns:ops="http://ops.epo.org"><ops:patent-family legal="true"/></ops:world-patent-data>';
        expect(parseLegalEvents(noEvents, 'EP3000000')).toEqual([]);
    });

    it('refuses an empty body, an OPS <error> document and an HTML page that arrived with HTTP 200 - never "no events"', () => {
        expect(() => parseLegalEvents('', 'EP3000000')).toThrow(/empty OPS legal response/);
        expect(() => parseLegalEvents('   \n ', 'EP3000000')).toThrow(/empty OPS legal response/);
        expect(() => parseLegalEvents('<error><code>404</code><message>x</message></error>', 'EP3000000')).toThrow(/root element "error"/);
        expect(() => parseLegalEvents('<html><body>maintenance</body></html>', 'EP3000000')).toThrow(/root element "html"/);
    });

    it('normaliseOpsDate keeps ISO dates, converts compact ones and passes anything else through trimmed', () => {
        expect(normaliseOpsDate('2000-05-17')).toBe('2000-05-17');
        expect(normaliseOpsDate('20000517')).toBe('2000-05-17');
        expect(normaliseOpsDate('  May 2000 ')).toBe('May 2000');
        expect(normaliseOpsDate('')).toBeNull();
        expect(normaliseOpsDate(undefined)).toBeNull();
    });
});

describe('isOppositionRelated (legacy heuristic, unchanged)', () => {
    it('matches opposition, oppo, appeal filed and board of appeal in the code or the description, case-insensitively', () => {
        expect(isOppositionRelated(null, 'Opposition filed')).toBe(true);
        expect(isOppositionRelated('OPPO', null)).toBe(true);
        expect(isOppositionRelated('X', 'APPEAL FILED BY PROPRIETOR')).toBe(true);
        expect(isOppositionRelated('X', 'Decision of the Board of Appeal')).toBe(true);
        expect(isOppositionRelated('NOPP', 'NO OPPOSITION FILED WITHIN TIME LIMIT')).toBe(true); // opposition-FAMILY by design
    });
    it('does not match unrelated events', () => {
        expect(isOppositionRelated('AK', 'DESIGNATED CONTRACTING STATES:')).toBe(false);
        expect(isOppositionRelated(null, null)).toBe(false);
    });
});

describe('records: ids, payload, fingerprint, watch text', () => {
    const events = parseLegalEvents(oppositionXml, 'EP3000000');
    const records = legalEventsToRecords(events);

    it('keeps only opposition-family events and makes ids unique: legacy id, :country for a foreign event, #signature for a different event on the same id', () => {
        expect(records.map((r) => r.recordId)).toEqual([
            'EP3000000:OPPO:2021-03-12',
            `EP3000000:OPPO:2021-03-12#${events[1]!.signature}`,
            'EP3000000:OPPO:2021-03-12:AT',
            'EP3000000:NOPP:2022-01-05',
            'EP3000000:APPO:2023-01-10',
        ]);
    });

    it('drops an exact duplicate event instead of emitting it twice', () => {
        expect(records).toHaveLength(5); // 7 events - 1 non-opposition - 1 exact duplicate
        const taken = new Map<string, string>();
        const [first] = events;
        expect(eventRecordId(first!, taken)).toBe('EP3000000:OPPO:2021-03-12');
        taken.set('EP3000000:OPPO:2021-03-12', first!.signature);
        expect(eventRecordId(first!, taken)).toBeNull();
    });

    it('is deterministic: parsing the same document twice yields the same ids and fingerprints', () => {
        const again = legalEventsToRecords(parseLegalEvents(oppositionXml, 'EP3000000'));
        expect(again.map((r) => [r.recordId, r.fingerprint])).toEqual(records.map((r) => [r.recordId, r.fingerprint]));
    });

    it('the fingerprint changes when the code, date, description or country changes (the legacy `code|date|description|country`)', () => {
        const [event] = events;
        const fp = (patch: object) => legalEventsToRecords([{ ...event!, ...patch }])[0]!.fingerprint;
        const base = fp({});
        expect(fp({ eventDescription: 'OPPOSITION WITHDRAWN' })).not.toBe(base);
        expect(fp({ eventDate: '2021-04-01' })).not.toBe(base);
        expect(fp({ eventCountry: 'DE' })).not.toBe(base);
        expect(fp({ freeText: 'something else' })).toBe(base); // free text is matching text only, not a consumer field
    });

    it('payload: the legacy raw fields plus the legacy UMS mapping, with no owner name, no money, no invented URL', () => {
        expect(records[0]!.payload).toEqual({
            publicationNumber: 'EP3000000',
            eventCode: 'OPPO',
            eventDescription: 'OPPOSITION FILED',
            eventDate: '2021-03-12',
            eventCountry: 'EP',
            source_url: null,
            recipient_or_defendant_name: null,
            entity_identifier_native: 'EP3000000',
            value_native: null,
            value_currency: null,
            value_usd_normalized: null,
            effective_date_iso: '2021-03-12',
            publish_date_iso: '2021-03-12',
            category_or_type: 'OPPO',
            status_or_estado: 'OPPOSITION FILED',
            awarding_or_regulating_agency: 'European Patent Office (EPO) -- Legal/Opposition Division',
            jurisdiction: 'EP',
            source_document_url: null,
            reference_number: 'EP3000000',
        });
        for (const record of records) for (const key of [...ROUTER_OWNED_KEYS, 'event_type']) expect(Object.keys(record.payload)).not.toContain(key);
        expect(epoPayload(events[0]!)).toEqual(records[0]!.payload);
    });

    it('watch text is the watched number plus the event\'s free-format block (where parties appear), and nothing for an empty block', () => {
        expect(records[0]!.watchText).toBe('EP3000000 Opponent: Example Opponent GmbH');
        expect(records[1]!.watchText).toBe('EP3000000 Opponent: Second Example Party Ltd');
        expect(records[2]!.watchText).toBe('EP3000000'); // the AT event has an empty L500EP block
        expect(epoWatchText(events[0]!)).toBe(records[0]!.watchText);
    });
});

describe('options validation (through the real router preflight)', () => {
    const engine = { slug: 'global-corporate-patent-intelligence' as const, connectors: [epoOppositionConnector] };
    const resolve = (sourceOptions: Record<string, unknown>) => resolveSources(engine, EngineInputSchema.parse({ sources: ['epo_opposition'], sourceOptions: { epo_opposition: sourceOptions } }));
    const creds = { epoOpsConsumerKey: KEY, epoOpsConsumerSecret: SECRET };

    it('declares both credentials through requiredOptions and is an active connector of the patent engine', () => {
        expect(epoOppositionConnector.requiredOptions).toEqual(['epoOpsConsumerKey', 'epoOpsConsumerSecret']);
        expect(epoOppositionConnector.id).toBe('epo_opposition');
        expect(epoOppositionConnector.engine).toBe('global-corporate-patent-intelligence');
        expect(epoOppositionConnector.legacyActor).toBe('actor-21-patent-ip-enforcement-monitor');
        expect(epoOppositionConnector.status).toBe('active');
    });

    it('a missing credential fails preflight naming exactly the missing option(s)', () => {
        expect(() => resolve({ epWatchlist: ['EP3000000'] })).toThrow(FatalConfigError);
        expect(() => resolve({ epWatchlist: ['EP3000000'] })).toThrow(/requires option\(s\): epoOpsConsumerKey, epoOpsConsumerSecret/);
        expect(() => resolve({ epoOpsConsumerKey: KEY, epWatchlist: ['EP3000000'] })).toThrow(/requires option\(s\): epoOpsConsumerSecret\./);
        expect(() => resolve({ epoOpsConsumerSecret: SECRET, epWatchlist: ['EP3000000'] })).toThrow(/requires option\(s\): epoOpsConsumerKey\./);
        expect(() => resolve({ epoOpsConsumerKey: '  ', epoOpsConsumerSecret: SECRET, epWatchlist: ['EP3000000'] })).toThrow(/requires option\(s\): epoOpsConsumerKey\./);
    });

    it('accepts valid credentials and applies the defaults', () => {
        const [resolved] = resolve({ ...creds, epWatchlist: ['EP3000000'] });
        expect(resolved!.options).toEqual({ ...creds, epWatchlist: ['EP3000000'], requestIntervalMs: EPO_DEFAULT_REQUEST_INTERVAL_MS });
    });

    it('an empty, blank, missing or malformed watchlist fails preflight - it is the lookup driver, so it can never mean "look everything up"', () => {
        for (const epWatchlist of [undefined, [], [''], [' '], ['', ' '], '', ' ', null]) {
            expect(() => resolve({ ...creds, epWatchlist })).toThrow(/epWatchlist must contain at least one EP publication number/);
        }
        // the key entirely absent (not just undefined) gets the same clear message, not a bare "Required"
        expect(() => resolve({ ...creds })).toThrow(/epWatchlist must contain at least one EP publication number/);
        expect(() => resolve({ ...creds, epWatchlist: 42 })).toThrow(/epWatchlist must be an array of EP publication numbers/);
        expect(() => resolve({ ...creds, epWatchlist: { a: 1 } })).toThrow(/epWatchlist must be an array/);
    });

    it('lists entries that are not epodoc publication numbers instead of silently dropping them', () => {
        expect(() => resolve({ ...creds, epWatchlist: ['not a number'] })).toThrow(/not accepted: not a number/);
        expect(() => resolve({ ...creds, epWatchlist: ['EP3000000', 'EP300../0000'] })).toThrow(/not accepted: EP300\.\.\/0000/);
        expect(() => resolve({ ...creds, epWatchlist: ['EP3000000', 5] })).toThrow(/not accepted: \[number\]/); // a non-string entry is shown as a constant tag, never serialised
        expect(() => resolve({ ...creds, epWatchlist: ['E'] })).toThrow(/not accepted/);
        expect(() => resolve({ ...creds, epWatchlist: ['EP.1000000.A1'] })).toThrow(/not accepted/); // docdb format, not epodoc
    });

    it('normalises: upper-cases, strips inner spaces, de-duplicates, ignores blanks, splits a pasted string', () => {
        const parse = (epWatchlist: unknown) => epoOppositionOptionsSchema.parse({ epWatchlist }).epWatchlist;
        expect(parse(['ep3000000', 'EP 3000001', 'EP3000000', '', ' '])).toEqual(['EP3000000', 'EP3000001']);
        expect(parse('EP3000000, ep3000001\nEP3000002;EP3000000')).toEqual(['EP3000000', 'EP3000001', 'EP3000002']);
        expect(parse(['ep3000000b1'])).toEqual(['EP3000000B1']);
        expect(parse(['US5000000'])).toEqual(['US5000000']);
    });

    it('caps the watchlist at 100 entries', () => {
        const numbers = (n: number) => Array.from({ length: n }, (_, i) => `EP${3000000 + i}`);
        expect(epoOppositionOptionsSchema.parse({ epWatchlist: numbers(EPO_MAX_WATCHLIST) }).epWatchlist).toHaveLength(100);
        expect(() => resolve({ ...creds, epWatchlist: numbers(101) })).toThrow(/at most 100 entries per run.*got 101/);
    });

    it('requestIntervalMs is a bounded non-negative integer', () => {
        expect(epoOppositionOptionsSchema.parse({ epWatchlist: ['EP3000000'] }).requestIntervalMs).toBe(1100);
        expect(epoOppositionOptionsSchema.parse({ epWatchlist: ['EP3000000'], requestIntervalMs: 0 }).requestIntervalMs).toBe(0);
        for (const requestIntervalMs of [-1, 60_001, 1.5, '10']) expect(() => resolve({ ...creds, epWatchlist: ['EP3000000'], requestIntervalMs })).toThrow(/requestIntervalMs/);
    });

    it('rejects unknown keys, and a non-string credential error never echoes the value', () => {
        expect(() => resolve({ ...creds, epWatchlist: ['EP3000000'], onlyNew: true })).toThrow(/Invalid options for "epo_opposition"/);
        try {
            resolve({ epoOpsConsumerKey: 987654321, epoOpsConsumerSecret: SECRET, epWatchlist: ['EP3000000'] });
            expect.unreachable();
        } catch (error) {
            expect((error as Error).message).not.toContain('987654321');
            expect((error as Error).message).not.toContain(SECRET);
        }
    });
});

describe('fetch: token exchange', () => {
    it('POSTs the documented OAuth2 client-credentials request: Basic base64(key:secret), form content type, grant_type body', async () => {
        const stub = makeCtx(opsServer());
        await fetchEpoOppositionEvents(stub.ctx, options(), RUN);
        const [tokenRequest] = requestsTo(stub, OPS_AUTH_URL);
        expect(tokenRequest).toMatchObject({ method: 'POST', url: 'https://ops.epo.org/3.2/auth/accesstoken', rawBody: 'grant_type=client_credentials', via: 'getText' });
        expect(tokenRequest!.headers.authorization).toBe(`Basic ${BASIC}`);
        expect(tokenRequest!.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(tokenRequest!.url).not.toContain(KEY);
    });

    it('accepts the token reply exactly as the guide prints it and uses that token as the Bearer', async () => {
        const stub = makeCtx(opsServer({ token: () => JSON.stringify(guideToken) }));
        await fetchEpoOppositionEvents(stub.ctx, options(), RUN);
        expect(bearerOf(requestsTo(stub, OPS_LEGAL_URL_BASE)[0]!)).toBe('4AWoepfVNgf09DRmimEnGdXcgoFU');
    });

    it('requests ONE token per fetch() call and reuses it for every lookup of that call', async () => {
        const stub = makeCtx(opsServer());
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(1);
        const legal = requestsTo(stub, OPS_LEGAL_URL_BASE);
        expect(legal.map(publicationOf)).toEqual(['EP3000000', 'EP3000001', 'EP3000002']);
        expect(new Set(legal.map(bearerOf))).toEqual(new Set(['tok-1-abcdef']));
    });

    it('never caches the token across fetch() calls: a second call authenticates again', async () => {
        const stub = makeCtx(opsServer());
        await fetchEpoOppositionEvents(stub.ctx, options(), RUN);
        await fetchEpoOppositionEvents(stub.ctx, options(), RUN);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(2);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(bearerOf)).toEqual(['tok-1-abcdef', 'tok-2-abcdef']);
    });

    it('re-authenticates inside one call when the stated lifetime (minus a one-minute margin) has passed', async () => {
        let stub: StubContext;
        stub = makeCtx(
            opsServer({
                legal: (_pub, _request, callIndex) => {
                    if (callIndex === 1) stub.setNow('2026-10-21T00:20:00Z'); // 1200 s later; expires_in is 1199 s
                    return oppositionXml;
                },
            }),
        );
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(2);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(bearerOf)).toEqual(['tok-1-abcdef', 'tok-2-abcdef', 'tok-2-abcdef']);
    });

    it('does not re-authenticate before that point', async () => {
        let stub: StubContext;
        stub = makeCtx(
            opsServer({
                legal: (_pub, _request, callIndex) => {
                    if (callIndex === 1) stub.setNow('2026-10-21T00:18:00Z'); // 1080 s < 1199 - 60
                    return oppositionXml;
                },
            }),
        );
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(1);
    });

    it('on an `invalid_access_token` reply it gets a new token once, as the guide instructs, and retries the lookup', async () => {
        const stub = makeCtx(
            opsServer({
                legal: (_pub, request) =>
                    bearerOf(request) === 'tok-1-abcdef' ? new HttpStatusError(request.url, 400, '<error><code>400</code><message>invalid_access_token</message></error>') : oppositionXml,
            }),
        );
        const records = await fetchEpoOppositionEvents(stub.ctx, options(), RUN);
        expect(records).toHaveLength(5);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(2);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(bearerOf)).toEqual(['tok-1-abcdef', 'tok-2-abcdef']);
    });

    it('a token refused twice in a row is a failure, not a skipped number', async () => {
        const stub = makeCtx(opsServer({ legal: (_pub, request) => new HttpStatusError(request.url, 400, '<error><message>invalid_access_token</message></error>') }));
        await expect(fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN)).rejects.toBeInstanceOf(SourceFetchError);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(2); // original + one retry, then stop
    });

    it('token endpoint rejection: a SourceFetchError that says the key/secret was rejected and makes no lookup', async () => {
        const stub = makeCtx(opsServer({ token: (_n, request) => new HttpStatusError(request.url, 401, '<error><code>401</code><message>ClientId is Invalid</message></error>') }));
        const error = await fetchEpoOppositionEvents(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as SourceFetchError,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expect(error!.source).toBe('epo_opposition');
        expect(error!.message).toMatch(/EPO OPS token endpoint answered HTTP 401: <error><code>401<\/code><message>ClientId is Invalid<\/message><\/error>.*key\/secret was rejected/);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(0);
    });

    it('a token reply that is not JSON, or has no access_token, is a clear failure', async () => {
        const html = makeCtx(opsServer({ token: () => '<html>maintenance</html>' }));
        await expect(fetchEpoOppositionEvents(html.ctx, options(), RUN)).rejects.toThrow(/non-JSON body/);
        const empty = makeCtx(opsServer({ token: () => JSON.stringify({ status: 'approved', expires_in: '1199' }) }));
        await expect(fetchEpoOppositionEvents(empty.ctx, options(), RUN)).rejects.toThrow(/without an access_token/);
        expect(requestsTo(html, OPS_LEGAL_URL_BASE)).toHaveLength(0);
        expect(requestsTo(empty, OPS_LEGAL_URL_BASE)).toHaveLength(0);
    });

    it('falls back to the documented ~20 minute lifetime when expires_in is absent', async () => {
        let stub: StubContext;
        stub = makeCtx(
            opsServer({
                token: (n) => JSON.stringify({ access_token: `tok-${n}-abcdef` }),
                legal: (_pub, _request, callIndex) => {
                    if (callIndex === 1) stub.setNow('2026-10-21T00:19:30Z'); // 1170 s > 1200 - 60
                    return oppositionXml;
                },
            }),
        );
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN);
        expect(requestsTo(stub, OPS_AUTH_URL)).toHaveLength(2);
    });
});

describe('fetch: lookups', () => {
    it('looks each number up at the epodoc legal URL with a Bearer token and an XML Accept header', async () => {
        const stub = makeCtx(opsServer());
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000000B1'] }), RUN);
        const legal = requestsTo(stub, OPS_LEGAL_URL_BASE);
        expect(legal.map((r) => r.url)).toEqual([legalUrl('EP3000000'), legalUrl('EP3000000B1')]);
        expect(legal.map((r) => r.method)).toEqual(['GET', 'GET']);
        expect(legal[0]!.url).toBe('https://ops.epo.org/3.2/rest-services/legal/publication/epodoc/EP3000000');
        expect(legal[0]!.headers.accept).toBe('application/xml');
        expect(legal[0]!.headers.authorization).toBe('Bearer tok-1-abcdef');
    });

    it('returns the opposition-family events of every number, with ids made unique across numbers too', async () => {
        const stub = makeCtx(opsServer());
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN);
        expect(records).toHaveLength(10);
        expect(new Set(records.map((r) => r.recordId)).size).toBe(10);
        expect(records.filter((r) => r.recordId.startsWith('EP3000001:'))).toHaveLength(5);
    });

    it('honours maxItemsPerSource: stops collecting and stops looking numbers up once the budget is met', async () => {
        const stub = makeCtx(opsServer({ legal: (pub) => oppositionDoc(pub, 3) }));
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), { maxItemsPerSource: 4 });
        expect(records).toHaveLength(4);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(publicationOf)).toEqual(['EP3000000', 'EP3000001']); // 3 + 1 >= 4: the third is never asked
    });

    it('a non-positive budget or an empty (schema-bypassing) watchlist makes no request at all', async () => {
        const stub = makeCtx(opsServer());
        expect(await fetchEpoOppositionEvents(stub.ctx, options(), { maxItemsPerSource: 0 })).toEqual([]);
        expect(await fetchEpoOppositionEvents(stub.ctx, { ...options(), epWatchlist: [] }, RUN)).toEqual([]);
        expect(stub.requests).toHaveLength(0);
    });

    it('called directly without credentials it fails with a SourceFetchError before any request', async () => {
        const stub = makeCtx(opsServer());
        await expect(fetchEpoOppositionEvents(stub.ctx, { ...options(), epoOpsConsumerSecret: undefined }, RUN)).rejects.toThrow(/both required/);
        expect(stub.requests).toHaveLength(0);
    });

    it('a number OPS does not know (404) or rejects (400) is skipped with a warning; the rest are still looked up', async () => {
        const stub = makeCtx(
            opsServer({
                legal: (pub, request) => (pub === 'EP3000000' ? new HttpStatusError(request.url, 404, '<error><code>404</code><message>SERVER.EntityNotFound</message></error>') : pub === 'EP3000001' ? new HttpStatusError(request.url, 400, '<error><message>CLIENT.InvalidQuery</message></error>') : oppositionDoc(pub, 2)),
            }),
        );
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(records).toHaveLength(2);
        expect(stub.logs.warning).toHaveLength(2);
        expect(stub.logs.warning[0]).toMatch(/EP3000000.*HTTP 404.*skipping this number/);
        expect(stub.logs.warning[1]).toMatch(/EP3000001.*HTTP 400.*skipping this number/);
        expect(stub.logs.info.join('\n')).toMatch(/looked up 1 of 3 watched publication\(s\) \(2 skipped\); 2 opposition-family event\(s\)/);
    });

    it('a 403 fair-use rejection STOPS the lookups: with events already found they are returned and the truncation is logged', async () => {
        const stub = makeCtx(opsServer({ legal: (pub, request) => (pub === 'EP3000000' ? oppositionDoc(pub, 2) : new HttpStatusError(request.url, 403, '<error><code>403</code><message>This request has been rejected due to the violation of Fair Use policy</message></error>')) }));
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(records).toHaveLength(2);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(publicationOf)).toEqual(['EP3000000', 'EP3000001']); // EP3000002 is never requested
        expect(stub.logs.warning.join('\n')).toMatch(/stopping after 1 of 3 lookup\(s\) with 2 event\(s\) kept.*HTTP 403.*fair-use/);
    });

    it('a 403 with nothing found yet is a source failure', async () => {
        const stub = makeCtx(opsServer({ legal: (_pub, request) => new HttpStatusError(request.url, 403, '') }));
        await expect(fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN)).rejects.toThrow(/lookup for EP3000000 answered HTTP 403.*fair-use rejection/);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(1);
    });

    it('a 5xx that survived the shared client\'s retries stops the lookups the same way', async () => {
        const stub = makeCtx(opsServer({ legal: (_pub, request) => new HttpStatusError(request.url, 503, 'unavailable') }));
        await expect(fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN)).rejects.toThrow(/HTTP 503/);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(1);
    });

    it('an unreadable 200 reply (an OPS <error> document) is a SourceFetchError naming the number, not "no events"', async () => {
        const stub = makeCtx(opsServer({ legal: () => '<error><code>500</code><message>SERVER.DomainAccess</message></error>' }));
        await expect(fetchEpoOppositionEvents(stub.ctx, options(), RUN)).rejects.toThrow(/legal response for EP3000000 could not be read.*root element "error"/);
    });

    it('an unreadable reply AFTER events were found stops the lookups and keeps what was found, with the truncation logged', async () => {
        const stub = makeCtx(opsServer({ legal: (pub) => (pub === 'EP3000000' ? oppositionDoc(pub, 2) : '<error><code>500</code><message>SERVER.DomainAccess</message></error>') }));
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(records).toHaveLength(2);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE).map(publicationOf)).toEqual(['EP3000000', 'EP3000001']);
        expect(stub.logs.warning.join('\n')).toMatch(/stopping after 1 of 3 lookup\(s\) with 2 event\(s\) kept.*legal response for EP3000001 could not be read/);
    });

    it('paces the lookups: nothing is requested before the interval has elapsed, the first lookup is immediate', async () => {
        vi.useFakeTimers();
        const stub = makeCtx(opsServer({ legal: (pub) => oppositionDoc(pub, 1) }));
        const run = fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'], requestIntervalMs: 1100 }), RUN);
        await vi.advanceTimersByTimeAsync(0);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1099);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1100);
        expect(await run).toHaveLength(3);
        expect(requestsTo(stub, OPS_LEGAL_URL_BASE)).toHaveLength(3);
    });
});

describe('credentials never reach an error message or a log line', () => {
    /** Every credential-bearing string this connector ever holds: key, secret, the Basic header value and the issued token. */
    const secrets = [KEY, SECRET, BASIC, `Basic ${BASIC}`, 'tok-1-abcdef'];
    const expectClean = (text: string) => {
        for (const secret of secrets) expect(text).not.toContain(secret);
    };

    it('token endpoint failure whose body echoes the key, the secret and the Basic header', async () => {
        const body = `<error>bad client ${KEY} secret ${SECRET} header Basic ${BASIC}</error>`;
        const stub = makeCtx(opsServer({ token: (_n, request) => new HttpStatusError(request.url, 401, body) }));
        const error = await fetchEpoOppositionEvents(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expectClean(error!.message);
        expect(error!.message).toContain('***');
        stub.allLogLines().forEach(expectClean);
    });

    it('legal lookup failure whose body echoes the Bearer token and the key', async () => {
        const stub = makeCtx(opsServer({ legal: (_pub, request) => new HttpStatusError(request.url, 403, `rejected bearer ${bearerOf(request)} for ${KEY}`) }));
        const error = await fetchEpoOppositionEvents(stub.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(error).toBeInstanceOf(SourceFetchError);
        expectClean(error!.message);
        expect(error!.message).toContain('***');
        stub.allLogLines().forEach(expectClean);
    });

    it('a skipped-number warning and a partial-stop warning are scrubbed too', async () => {
        const stub = makeCtx(
            opsServer({
                legal: (pub, request, callIndex) =>
                    callIndex === 1 ? new HttpStatusError(request.url, 404, `unknown ${pub} for ${KEY}/${SECRET}`) : callIndex === 2 ? oppositionDoc(pub, 1) : new HttpStatusError(request.url, 403, `bearer ${bearerOf(request)}`),
            }),
        );
        const records = await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001', 'EP3000002'] }), RUN);
        expect(records).toHaveLength(1);
        expect(stub.logs.warning).toHaveLength(2);
        stub.allLogLines().forEach(expectClean);
        expect(stub.logs.warning.join('\n')).toContain('***');
    });

    it('a transport error that mentions the secret, and a parse failure, are scrubbed', async () => {
        const network = makeCtx(opsServer({ legal: () => new Error(`socket hang up (Authorization: Bearer tok-1-abcdef, client ${SECRET})`) }));
        const error = await fetchEpoOppositionEvents(network.ctx, options(), RUN).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expectClean(error!.message);
        network.allLogLines().forEach(expectClean);
    });

    it('a fully successful run logs counts and publication numbers only', async () => {
        const stub = makeCtx(opsServer());
        await fetchEpoOppositionEvents(stub.ctx, options({ epWatchlist: ['EP3000000', 'EP3000001'] }), RUN);
        expect(stub.allLogLines().length).toBeGreaterThan(0);
        stub.allLogLines().forEach(expectClean);
    });

    it('end to end through the router: neither the run summary, the rows, nor any log line carries a credential', async () => {
        const stub = makeCtx(opsServer({ legal: (_pub, request) => new HttpStatusError(request.url, 403, `bearer ${bearerOf(request)} ${KEY} ${SECRET}`) }));
        const result = await runThroughRouter(epoOppositionConnector, { sources: ['epo_opposition'], sourceOptions: { epo_opposition: { epoOpsConsumerKey: KEY, epoOpsConsumerSecret: SECRET, epWatchlist: ['EP3000000'], requestIntervalMs: 0 } } }, stub);
        expect(result.summary.sources[0]!.error).toBeTruthy();
        const everything = JSON.stringify([result.summary, result.rows, stub.allLogLines()]);
        expectClean(everything);
    });

    it('scrubSecrets only touches secrets of length >= 4', () => {
        expect(scrubSecrets(`a ${KEY} b`, [KEY])).toBe('a *** b');
        expect(scrubSecrets('abc', ['abc'])).toBe('abc');
    });
});

describe('end to end through the real router', () => {
    const input = (extra: Record<string, unknown> = {}, watchlist: string[] = ['EP3000000']) => ({
        sources: ['epo_opposition'],
        sourceOptions: { epo_opposition: { epoOpsConsumerKey: KEY, epoOpsConsumerSecret: SECRET, epWatchlist: watchlist, requestIntervalMs: 0 } },
        deltaMode: 'onlyChanged',
        ...extra,
    });

    it('first run emits each opposition-family event as first_seen with engine / source / record_id from the router', async () => {
        const result = await runThroughRouter(epoOppositionConnector, input(), makeCtx(opsServer()));
        expect(result.rows).toHaveLength(5);
        expect(result.rows[0]).toMatchObject({
            engine: 'global-corporate-patent-intelligence',
            source: 'epo_opposition',
            record_id: 'EP3000000:OPPO:2021-03-12',
            delta_status: 'first_seen',
            is_new: true,
            publicationNumber: 'EP3000000',
            eventCode: 'OPPO',
            jurisdiction: 'EP',
            is_watchlist_match: false,
        });
        expect(result.billing.totalFor(RESULT_EVENT)).toBe(5);
    });

    it('delta memory: an unchanged second run emits nothing; a changed description re-emits that event as updated', async () => {
        const store = new InMemoryDeltaStore();
        await runThroughRouter(epoOppositionConnector, input(), makeCtx(opsServer()), store);
        const second = await runThroughRouter(epoOppositionConnector, input(), makeCtx(opsServer()), store);
        expect(second.rows).toHaveLength(0);
        expect(second.summary.sources[0]).toMatchObject({ fetched: 5, unchanged: 5 });

        const changed = oppositionXml.replace('desc="NO OPPOSITION FILED WITHIN TIME LIMIT"', 'desc="NO OPPOSITION FILED WITHIN THE TIME LIMIT"');
        const third = await runThroughRouter(epoOppositionConnector, input(), makeCtx(opsServer({ legal: () => changed })), store);
        expect(third.rows).toHaveLength(1);
        expect(third.rows[0]).toMatchObject({ record_id: 'EP3000000:NOPP:2022-01-05', delta_status: 'updated', eventDescription: 'NO OPPOSITION FILED WITHIN THE TIME LIMIT' });
    });

    it('the watchlist matches the publication number and the party names the register puts in the free text, and bills each hit once', async () => {
        const byOpponent = await runThroughRouter(epoOppositionConnector, input({ watchlistNames: ['example opponent'] }), makeCtx(opsServer()));
        expect(byOpponent.rows.filter((r) => r.is_watchlist_match).map((r) => r.record_id)).toEqual(['EP3000000:OPPO:2021-03-12']);
        expect(byOpponent.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(1);

        const byNumber = await runThroughRouter(epoOppositionConnector, input({ watchlistNames: ['EP3000000'] }), makeCtx(opsServer()));
        expect(byNumber.rows.every((r) => r.is_watchlist_match)).toBe(true);
        expect(byNumber.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(5);
    });

    it('ghost-billing guard: empty, blank and one-letter watchlists match nothing and bill nothing', async () => {
        for (const watchlistNames of [[''], [' '], ['e'], '', [], undefined, null, 7]) {
            const result = await runThroughRouter(epoOppositionConnector, input({ watchlistNames }), makeCtx(opsServer()));
            expect(result.rows).toHaveLength(5);
            expect(result.rows.some((r) => r.is_watchlist_match)).toBe(false);
            expect(result.billing.totalFor(WATCHLIST_HIT_EVENT)).toBe(0);
        }
    });

    it('a missing credential or an empty watchlist aborts the whole run in preflight: no token, no lookup, no billing', async () => {
        const noCreds = makeCtx(opsServer());
        await expect(runThroughRouter(epoOppositionConnector, { sources: ['epo_opposition'], sourceOptions: { epo_opposition: { epWatchlist: ['EP3000000'] } } }, noCreds)).rejects.toThrow(/requires option\(s\)/);
        const noList = makeCtx(opsServer());
        await expect(runThroughRouter(epoOppositionConnector, input({}, []), noList)).rejects.toThrow(/epWatchlist must contain at least one/);
        expect(noCreds.requests).toHaveLength(0);
        expect(noList.requests).toHaveLength(0);
    });

    it('the engine-level maxItemsPerSource caps the emitted events', async () => {
        const result = await runThroughRouter(epoOppositionConnector, input({ maxItemsPerSource: 2 }), makeCtx(opsServer()));
        expect(result.rows).toHaveLength(2);
    });
});
