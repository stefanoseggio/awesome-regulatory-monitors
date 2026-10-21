/**
 * epoOpposition.ts - EPO Open Patent Services legal-status ("epo_opposition") connector.
 *
 * Absorbs the `epo_opposition` source of `actor-21-patent-ip-enforcement-monitor`
 * (src/sources/epoOpposition.ts, the EPO half of umsNormalizer.ts, the EPO types and the
 * input contract in schemas.ts). Delta state, `onlyNew`, the legacy event-type vocabulary
 * and Actor.charge are the router's business and are not ported.
 *
 * SCOPE: OPS has no documented "search all recently-opposed patents" endpoint - `legal` is a
 * per-publication-number lookup. So unlike the PTAB source (a newest-first crawl) this source is
 * WATCHLIST-DRIVEN: the operator supplies EP publication numbers (`epWatchlist`) and the
 * connector reports which of them show an opposition-family legal event. The list is the lookup
 * driver, not a filter: an empty or invalid list fails preflight (it can never turn into "look up
 * everything", and nothing is fetched or billed).
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * LEGACY RECORD (2026-09-07, condensed)
 * 3. EPO Open Patent Services (OPS) v3.2 - real and documented. https://developers.epo.org/:
 *    "Register to get access credentials" (free), define an app, authenticate "using OAuth" - a
 *    standard OAuth2 client-credentials flow keyed by a per-app Consumer Key/Secret. Base URL and
 *    token endpoint were cross-checked against the literal URL constants of the open-source OPS
 *    client ip-tools/python-epo-ops-client (epo_ops/api.py):
 *      Auth:  POST https://ops.epo.org/3.2/auth/accesstoken
 *             (HTTP Basic base64(consumerKey:consumerSecret), form body grant_type=client_credentials)
 *      Base:  https://ops.epo.org/3.2/rest-services
 *      Legal: GET  {base}/legal/publication/epodoc/{number}
 *    A bare unauthenticated `curl https://ops.epo.org/robots.txt` returned HTTP 403 with the body
 *    `This request has been rejected due to the violation of Fair Use policy` - EPO's published Fair
 *    Use policy is the access gate, applied to every unregistered caller, not a targeted bot
 *    challenge. Free tier found via search: 4 GB/week.
 * 4. WIPO PATENTSCOPE (https://www.wipo.int/en/web/patentscope/data/index, 2026-09-07) - every
 *    structured/bulk data product is a PAID subscription in Swiss francs and the SOAP web service
 *    is paid too; only the human web UI is free. EXCLUDED, not force-fit against a paid gate.
 *
 * RE-VERIFIED IN THIS PORT SESSION (2026-10-21):
 *  a. https://link.epo.org/web/searching-for-patents/data/en-ops-v3.2-documentation-version-1.3.20.pdf
 *     (the public "OPS RESTful Web Services Reference Guide v 1.3.20, June 2024", 154 pages; the
 *     legacy record called the PDF login-gated, it downloaded anonymously, HTTP 200) states:
 *       - p.36: `POST https://ops.epo.org/3.2/auth/accesstoken`, `Authorization: Basic <base64>`,
 *         `Content-Type: application/x-www-form-urlencoded`, payload `grant_type=client_credentials`;
 *         the 200 reply is JSON `{"issued_at", "scope", "status", "expires_in": "1199", "token_type":
 *         "Bearer", "access_token", ...}` and "The access token produced is valid for approximately
 *         20mins. A New access token should be requested as soon as an invalid access token message
 *         is received from OPS." (error: HTTP 400 `<message>invalid_access_token</message>`).
 *       - Fair use: `/legal/*` is throttled as service `inpadoc` (60 requests per 60 s window when the
 *         system is idle, 45 busy, 30 overloaded; black = suspended with `Retry-After`), errors
 *         `403 This request has been rejected due to the violation of Fair Use policy` /
 *         `403 CLIENT.RobotDetected`, and "you should moderate your usage of the service over a 60
 *         second window". This connector therefore paces its lookups (`requestIntervalMs`).
 *       - pp.117-120 (3.5 Legal service) + pp.87-89: the response is `<ops:world-patent-data
 *         xmlns:ops="http://ops.epo.org" xmlns="http://www.epo.org/exchange">` containing
 *         `<ops:patent-family legal="true"><ops:family-member>` and one
 *         `<ops:legal code="AK     " desc="DESIGNATED CONTRACTING STATES:" infl="+" dateMigr="...">`
 *         PER LEGAL EVENT, whose children are `ops:pre` text lines and the numbered fields
 *         `ops:L001EP` "Country Code", `L002EP` "Filing / Published Document", `L003EP` "Document
 *         Number", `L004EP` "Kind Code", `L005EP` "IPR Type", `L006EP` "PRS DOCUMENT TYPE",
 *         `L007EP` "Gazette DATE", `L008EP` "Legal Event Code 1", `L018EP` "DATE last exchanged",
 *         `L019EP` "DATE first created" and an `L500EP` block of free-format text fields.
 *  b. python-epo-ops-client (raw.githubusercontent.com/ip-tools/python-epo-ops-client/master/
 *     epo_ops/api.py, fetched live): `Client.legal("publication", epo_ops.models.Epodoc("EP1000000"))`
 *     documents `"ops:legal" in response.text`, default `Accept: application/xml`, auth URL
 *     `https://ops.epo.org/3.2/auth/accesstoken` - i.e. the legal URL below and the `ops:legal`
 *     element are corroborated by an independent maintained client.
 *  c. Live, no credentials: `POST https://ops.epo.org/3.2/auth/accesstoken` with Basic `bogus:bogus`
 *     -> HTTP 401 `<error><code>401</code><message>ClientId is Invalid</message></error>` (the token
 *     endpoint exists and is the OAuth client-credentials gate). `GET .../legal/publication/epodoc/
 *     EP3000000` with `Bearer bogus` -> HTTP 400 `invalid_access_token` (the gateway validates the
 *     token before routing, so this does NOT prove the legal route itself; the route rests on a and b).
 *
 * LEGACY PARSER DEFECT, CORRECTED HERE. The legacy parser selected `legal-event, event` elements
 * ("deliberately defensive; the exact tag names could not be confirmed"). Against the documented
 * structure that selects NOTHING (verified with this repo's cheerio: the legacy selector matches 0
 * elements of the guide's example, while the real element is `ops:legal`), so on a real response the
 * legacy actor would have reported zero opposition events. This port reads `ops:legal` elements by
 * LOCAL name (namespace prefix ignored), `code` / `desc` attributes and the numbered `L0xxEP`
 * children exactly as the guide documents them.
 *
 * STILL NOT VERIFIED: an AUTHENTICATED OPS response (no Consumer Key/Secret is held by this codebase;
 * BYOK). The element/attribute names above come from the public guide, not from a live reply; the
 * "event date" mapping (L007EP Gazette DATE, falling back to L019EP DATE first created) and the
 * opposition heuristic below are choices, not facts about EPO's code tables. Validate against a real
 * response before treating EPO output as production-reliable.
 * ============================================================================
 */
import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';
import { z } from 'zod';

import { type KeywordRejectionReason, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf, byokCredential } from '../../lib/connector_helpers.js';
import { HttpStatusError } from '../../lib/http.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const EPO_SOURCE_ID = 'epo_opposition';
export const OPS_AUTH_URL = 'https://ops.epo.org/3.2/auth/accesstoken';
export const OPS_LEGAL_URL_BASE = 'https://ops.epo.org/3.2/rest-services/legal/publication/epodoc';
export const EPO_AGENCY_NAME = 'European Patent Office (EPO) -- Legal/Opposition Division';
export const EPO_JURISDICTION = 'EP';
/** Legacy cap (timeout-budget arithmetic: each entry is one sequential, independently retried HTTP call). */
export const EPO_MAX_WATCHLIST = 100;
/** < 60 lookups per 60 s window, the OPS `inpadoc` idle limit for `/legal/*` (see header). */
export const EPO_DEFAULT_REQUEST_INTERVAL_MS = 1100;
/** Lifetime assumed when a token reply carries no usable `expires_in` ("approximately 20mins", OPS guide p.36). */
const OPS_DEFAULT_TOKEN_LIFETIME_SECONDS = 1200;
/** Re-authenticate this long before the stated expiry. */
const OPS_TOKEN_REFRESH_MARGIN_SECONDS = 60;
const OPS_MAX_TOKEN_BYTES = 64_000;
const OPS_MAX_LEGAL_BYTES = 8_000_000;

// ---------------------------------------------------------------------------
// Opposition heuristic (legacy, unchanged)
// ---------------------------------------------------------------------------

const OPPOSITION_TERMS = ['opposition', 'oppo', 'appeal filed', 'board of appeal'];

/**
 * True when the event code / description text-matches an opposition-family term. A HEURISTIC, not an
 * authoritative INPADOC code-table lookup (legacy position, kept). Consequence worth knowing: a
 * "NO OPPOSITION FILED WITHIN TIME LIMIT" event is opposition-family by this test, which is intended
 * ("what happened in the opposition window"), not a false positive to filter out.
 */
export function isOppositionRelated(code: string | null, description: string | null): boolean {
    const haystack = `${code ?? ''} ${description ?? ''}`.toLowerCase();
    return OPPOSITION_TERMS.some((term) => haystack.includes(term));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface EpoLegalEvent {
    publicationNumber: string;
    eventCode: string | null;
    eventDescription: string | null;
    eventDate: string | null;
    eventCountry: string | null;
    isOppositionRelated: boolean;
    /** Collapsed free-format text of the event (the `L500EP` block); only used for watch matching. */
    freeText: string | null;
    /** Short hash of the event's complete text; disambiguates two events sharing code + date + country. */
    signature: string;
}

function collapse(value: string | undefined | null): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

function localName(tag: string): string {
    const colon = tag.lastIndexOf(':');
    return colon === -1 ? tag : tag.slice(colon + 1);
}

/** `YYYY-MM-DD` as published; a compact `YYYYMMDD` is converted; anything else is kept verbatim (trimmed). */
export function normaliseOpsDate(value: string | null | undefined): string | null {
    const trimmed = collapse(value);
    if (trimmed === '') return null;
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
    return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : trimmed;
}

/**
 * Reads every `ops:legal` element (namespace prefix ignored) of an OPS legal-service response.
 * Throws when the document is empty or its root is not `world-patent-data`: an OPS `<error>` body or an
 * HTML interstitial that arrived with HTTP 200 must not be read as "this patent has no legal events".
 */
export function parseLegalEvents(xml: string, publicationNumber: string): EpoLegalEvent[] {
    if (collapse(xml) === '') throw new Error('empty OPS legal response');
    const $ = cheerio.load(xml, { xmlMode: true });
    const rootNode = $.root().children().first().get(0);
    const rootName = rootNode && 'name' in rootNode ? localName(rootNode.name) : '';
    if (rootName !== 'world-patent-data') {
        throw new Error(`unexpected OPS legal response root element "${rootName || '(none)'}" (expected world-patent-data)`);
    }

    const events: EpoLegalEvent[] = [];
    $('*').each((_, node) => {
        if (!('name' in node) || localName(node.name) !== 'legal') return;
        const legal = $(node);

        const fields = new Map<number, string>();
        let freeText: string | null = null;
        for (const child of legal.children().toArray()) {
            const match = /^L(\d{3})[A-Z]{2}$/.exec(localName(child.name));
            if (!match) continue;
            const number = Number(match[1]);
            const value = collapse($(child).text());
            if (number === 500) freeText = value === '' ? null : value;
            else if (value !== '' && !fields.has(number)) fields.set(number, value);
        }

        const code = collapse(legal.attr('code')) || fields.get(8) || null;
        const description = collapse(legal.attr('desc')) || null;
        const eventDate = normaliseOpsDate(fields.get(7) ?? fields.get(19));
        const eventCountry = fields.get(1) ?? null;
        const signature = createHash('sha1').update(collapse(legal.text())).digest('hex').slice(0, 8);

        events.push({
            publicationNumber,
            eventCode: code,
            eventDescription: description,
            eventDate,
            eventCountry,
            isOppositionRelated: isOppositionRelated(code, description),
            freeText,
            signature,
        });
    });
    return events;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Legacy id `{publicationNumber}:{eventCode}:{eventDate}`. Two additions, both needed because the router
 * silently drops a repeated id: an event whose own country differs from the watched number's country
 * prefix gets `:{country}` (a lapse in AT and in BE on the same gazette date are two events), and a
 * remaining collision between two DIFFERENT events gets `#{signature}` (a hash of the event's complete
 * text). An event whose text is identical to the one already holding the id is an exact duplicate and
 * yields `null`. For the ordinary case - an `EP` event of an `EP` publication - the id is the legacy one.
 *
 * `taken` maps every id handed out so far to the signature of the event that holds it.
 */
export function eventRecordId(event: EpoLegalEvent, taken: ReadonlyMap<string, string>): string | null {
    const countryPrefix = event.publicationNumber.slice(0, 2).toUpperCase();
    const country = event.eventCountry !== null && event.eventCountry.toUpperCase() !== countryPrefix ? `:${event.eventCountry}` : '';
    const base = `${event.publicationNumber}:${event.eventCode ?? 'unknown'}:${event.eventDate ?? 'unknown'}${country}`;
    const holder = taken.get(base);
    if (holder === undefined) return base;
    if (holder === event.signature) return null;
    const disambiguated = `${base}#${event.signature}`;
    return taken.has(disambiguated) ? null : disambiguated;
}

/** Legacy UMS mapping (normalizeEpoRecord) minus the router-owned keys, plus the legacy raw fields. */
export function epoPayload(event: EpoLegalEvent): Record<string, unknown> {
    return {
        publicationNumber: event.publicationNumber,
        eventCode: event.eventCode,
        eventDescription: event.eventDescription,
        eventDate: event.eventDate,
        eventCountry: event.eventCountry,
        // UMS envelope fields. The OPS legal response carries no patent-owner name, so
        // recipient_or_defendant_name stays null (legacy decision) rather than guessed; no monetary
        // amount exists for a legal event; there is no verified public per-event page.
        source_url: null,
        recipient_or_defendant_name: null,
        entity_identifier_native: event.publicationNumber,
        value_native: null,
        value_currency: null,
        value_usd_normalized: null,
        effective_date_iso: event.eventDate,
        publish_date_iso: event.eventDate,
        category_or_type: event.eventCode,
        status_or_estado: event.eventDescription,
        awarding_or_regulating_agency: EPO_AGENCY_NAME,
        jurisdiction: EPO_JURISDICTION,
        source_document_url: null,
        reference_number: event.publicationNumber,
    };
}

/**
 * Watch text: the OPS legal events carry no owner or opponent field, so the text is the watched
 * publication number plus the event's free-format block (which is where a register puts party names
 * for the events that have any). Matching an owner name therefore needs the PTAB source or a
 * publication number in the engine watchlist.
 */
export function epoWatchText(event: EpoLegalEvent): string {
    return [event.publicationNumber, event.freeText].filter((part): part is string => part !== null && part !== '').join(' ');
}

/** Opposition-family events of one publication as source records, ids made unique within the call. */
export function legalEventsToRecords(events: readonly EpoLegalEvent[], taken: Map<string, string> = new Map()): SourceRecord[] {
    const records: SourceRecord[] = [];
    for (const event of events) {
        if (!event.isOppositionRelated) continue;
        const recordId = eventRecordId(event, taken);
        if (recordId === null) continue;
        taken.set(recordId, event.signature);
        records.push({
            recordId,
            fingerprint: fingerprintOf([event.eventCode, event.eventDate, event.eventDescription, event.eventCountry]),
            payload: epoPayload(event),
            watchText: epoWatchText(event),
        });
    }
    return records;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** OPS epodoc publication number: 2-letter authority code, digits, optional kind code (`EP3000000`, `EP3000000B1`). */
const EPODOC_PUBLICATION_NUMBER = /^[A-Z]{2}[0-9]{1,15}[A-Z0-9]{0,3}$/;
const TOLERATED_REJECTIONS: ReadonlySet<KeywordRejectionReason> = new Set(['duplicate', 'empty_after_normalisation']);

/**
 * The watchlist is read through `sanitizeKeywordList` (never iterated raw), then every entry must be an
 * epodoc publication number. Blank elements and repeats are ignored (UI paste artefacts); a malformed
 * entry fails preflight with the offending values listed, because a typo that is silently dropped is a
 * patent that is silently not monitored.
 */
const epWatchlistSchema = z.unknown().transform((raw, issueCtx): string[] => {
    const list = sanitizeKeywordList(raw);
    if (list.malformedContainer) {
        issueCtx.addIssue({ code: z.ZodIssueCode.custom, message: 'epWatchlist must be an array of EP publication numbers (or one comma/newline separated string).' });
        return z.NEVER;
    }
    const numbers: string[] = [];
    const invalid: string[] = list.rejected.filter((r) => !TOLERATED_REJECTIONS.has(r.reason)).map((r) => r.value);
    for (const keyword of list.keywords) {
        const candidate = keyword.replace(/\s+/g, '').toUpperCase();
        if (!EPODOC_PUBLICATION_NUMBER.test(candidate)) invalid.push(keyword.length > 40 ? `${keyword.slice(0, 37)}...` : keyword);
        else if (!numbers.includes(candidate)) numbers.push(candidate);
    }
    if (invalid.length > 0) {
        issueCtx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `epWatchlist entries must be publication numbers in OPS epodoc format (e.g. EP3000000 or EP3000000B1); not accepted: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? `, +${invalid.length - 5} more` : ''}.`,
        });
    }
    if (numbers.length === 0) {
        issueCtx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'epWatchlist must contain at least one EP publication number (OPS has no bulk opposition search; the watchlist is what is looked up).',
        });
    }
    if (numbers.length > EPO_MAX_WATCHLIST) {
        issueCtx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `epWatchlist supports at most ${EPO_MAX_WATCHLIST} entries per run (each is one sequential, independently retried HTTP call); got ${numbers.length}.`,
        });
    }
    return numbers;
});

export const epoOppositionOptionsSchema = z
    .object({
        /** BYOK: EPO OPS OAuth2 Consumer Key from a free developers.epo.org account + app. Never logged. */
        epoOpsConsumerKey: byokCredential('epoOpsConsumerKey'),
        /** BYOK: the paired Consumer Secret. Never logged. */
        epoOpsConsumerSecret: byokCredential('epoOpsConsumerSecret'),
        /** EP publication numbers in OPS epodoc format, at most 100. */
        epWatchlist: epWatchlistSchema,
        /** Pause between two lookups, to stay under the OPS `inpadoc` fair-use window (see header). 0 disables pacing. */
        requestIntervalMs: z.number().int().min(0).max(60_000).default(EPO_DEFAULT_REQUEST_INTERVAL_MS),
    })
    .strict();
export type EpoOppositionOptions = z.infer<typeof epoOppositionOptionsSchema>;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Replaces every occurrence of each secret (length >= 4) with `***`. Pure; exported for tests. */
export function scrubSecrets(message: string, secrets: ReadonlyArray<string | undefined>): string {
    let scrubbed = message;
    for (const secret of secrets) {
        if (secret !== undefined && secret.length >= 4) scrubbed = scrubbed.split(secret).join('***');
    }
    return scrubbed;
}

interface OpsToken {
    value: string;
    /** Epoch ms after which a new token is requested (stated expiry minus a safety margin). */
    refreshAtMs: number;
}

function describeFailure(what: string, error: unknown, secrets: ReadonlyArray<string | undefined>): string {
    if (error instanceof HttpStatusError) {
        const hint =
            error.status === 403
                ? ' - EPO fair-use rejection (quota, throttle or robot detection); the lookup was stopped'
                : error.status === 401 || /invalid_client|ClientId is Invalid/i.test(error.bodyPreview)
                  ? ' - the OPS consumer key/secret was rejected'
                  : '';
        const preview = error.bodyPreview ? `: ${collapse(error.bodyPreview)}` : '';
        return scrubSecrets(`${what} answered HTTP ${error.status}${preview}${hint}`, secrets);
    }
    return scrubSecrets(`${what} failed: ${error instanceof Error ? error.message : String(error)}`, secrets);
}

/**
 * OAuth2 client credentials, exactly as the OPS guide (p.36) documents: HTTP Basic
 * base64(key:secret), form body `grant_type=client_credentials`. The token lives only in the caller's
 * local variable for the duration of one fetch(); nothing is cached across runs.
 */
async function acquireToken(ctx: ConnectorContext, basicCredentials: string, secrets: string[]): Promise<OpsToken> {
    let body: string;
    try {
        body = await ctx.http.getText(OPS_AUTH_URL, {
            method: 'POST',
            headers: {
                authorization: `Basic ${basicCredentials}`,
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
            },
            body: 'grant_type=client_credentials',
            maxBytes: OPS_MAX_TOKEN_BYTES,
        });
    } catch (error) {
        throw new SourceFetchError(describeFailure('EPO OPS token endpoint', error, secrets), EPO_SOURCE_ID);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new SourceFetchError(`EPO OPS token endpoint returned a non-JSON body (${body.length} chars).`, EPO_SOURCE_ID);
    }
    const reply = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const accessToken = typeof reply.access_token === 'string' ? reply.access_token.trim() : '';
    if (accessToken === '') {
        throw new SourceFetchError('EPO OPS token endpoint answered without an access_token.', EPO_SOURCE_ID);
    }
    secrets.push(accessToken);

    const stated = Number(reply.expires_in);
    const lifetimeSeconds = Number.isFinite(stated) && stated > 0 ? stated : OPS_DEFAULT_TOKEN_LIFETIME_SECONDS;
    const refreshAfterSeconds = Math.max(0, lifetimeSeconds - OPS_TOKEN_REFRESH_MARGIN_SECONDS);
    return { value: accessToken, refreshAtMs: ctx.now().getTime() + refreshAfterSeconds * 1000 };
}

function isInvalidAccessToken(error: unknown): boolean {
    return error instanceof HttpStatusError && (error.status === 400 || error.status === 401) && /invalid_access_token/i.test(error.bodyPreview);
}

/**
 * A per-number problem (bad reference, nothing recorded): skip the number, keep looking up the rest. A 400 that
 * says `invalid_access_token` is NOT per-number - the token was refused twice in a row - so it stops the lookups.
 */
function isSkippableLookupError(error: unknown): boolean {
    return error instanceof HttpStatusError && (error.status === 404 || (error.status === 400 && !isInvalidAccessToken(error)));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * One sequential lookup per watchlisted publication. Returns only opposition-family events, capped at
 * `maxItemsPerSource`.
 *
 * Failure policy: a bad credential or token failure is a source failure. A 400/404 for one number skips
 * that number (OPS answers 404 for an unknown reference). Any other failure - notably 403 fair-use /
 * robot rejections, 429 and 5xx after the shared client's own retries - STOPS the lookups (hammering
 * a throttled service is the one thing a fair-use policy forbids): with no records yet it is a source
 * failure, otherwise the records found so far are returned and the truncation is logged. A 200 reply that
 * cannot be read as an OPS legal document is handled the same way.
 */
export async function fetchEpoOppositionEvents(ctx: ConnectorContext, options: EpoOppositionOptions, run: RunParams): Promise<SourceRecord[]> {
    const key = options.epoOpsConsumerKey;
    const secret = options.epoOpsConsumerSecret;
    if (key === undefined || key === '' || secret === undefined || secret === '') {
        throw new SourceFetchError('epoOpsConsumerKey and epoOpsConsumerSecret are both required for source epo_opposition (BYOK).', EPO_SOURCE_ID);
    }
    const watchlist = options.epWatchlist;
    if (watchlist.length === 0 || run.maxItemsPerSource <= 0) return [];

    const basicCredentials = Buffer.from(`${key}:${secret}`).toString('base64');
    const secrets: string[] = [key, secret, basicCredentials];

    let token = await acquireToken(ctx, basicCredentials, secrets);
    const lookup = async (publicationNumber: string): Promise<string> => {
        const fetchOnce = (current: OpsToken): Promise<string> =>
            ctx.http.getText(`${OPS_LEGAL_URL_BASE}/${encodeURIComponent(publicationNumber)}`, {
                headers: { authorization: `Bearer ${current.value}`, accept: 'application/xml' },
                maxBytes: OPS_MAX_LEGAL_BYTES,
            });
        if (ctx.now().getTime() >= token.refreshAtMs) token = await acquireToken(ctx, basicCredentials, secrets);
        try {
            return await fetchOnce(token);
        } catch (error) {
            if (!isInvalidAccessToken(error)) throw error;
            // The guide: "A New access token should be requested as soon as an invalid access token message is received."
            token = await acquireToken(ctx, basicCredentials, secrets);
            return fetchOnce(token);
        }
    };

    const records: SourceRecord[] = [];
    const taken = new Map<string, string>();
    let lookedUp = 0;
    let skipped = 0;

    for (const [index, publicationNumber] of watchlist.entries()) {
        if (records.length >= run.maxItemsPerSource) break;
        if (index > 0 && options.requestIntervalMs > 0) await sleep(options.requestIntervalMs);

        let xml: string;
        try {
            xml = await lookup(publicationNumber);
        } catch (error) {
            if (error instanceof SourceFetchError) throw error; // token failure
            const message = describeFailure(`EPO OPS legal lookup for ${publicationNumber}`, error, secrets);
            if (isSkippableLookupError(error)) {
                skipped += 1;
                ctx.log.warning(`[${EPO_SOURCE_ID}] ${message}; skipping this number.`);
                continue;
            }
            if (records.length === 0) throw new SourceFetchError(message, EPO_SOURCE_ID);
            ctx.log.warning(`[${EPO_SOURCE_ID}] stopping after ${lookedUp} of ${watchlist.length} lookup(s) with ${records.length} event(s) kept. ${message}`);
            break;
        }

        let events: EpoLegalEvent[];
        try {
            events = parseLegalEvents(xml, publicationNumber);
        } catch (error) {
            // An unreadable reply (an OPS <error> document or an HTML page with HTTP 200) is never read as "no events".
            const message = scrubSecrets(`EPO OPS legal response for ${publicationNumber} could not be read: ${error instanceof Error ? error.message : String(error)}`, secrets);
            if (records.length === 0) throw new SourceFetchError(message, EPO_SOURCE_ID);
            ctx.log.warning(`[${EPO_SOURCE_ID}] stopping after ${lookedUp} of ${watchlist.length} lookup(s) with ${records.length} event(s) kept. ${message}`);
            break;
        }
        lookedUp += 1;
        for (const record of legalEventsToRecords(events, taken)) {
            records.push(record);
            if (records.length >= run.maxItemsPerSource) break;
        }
    }

    ctx.log.info(`[${EPO_SOURCE_ID}] looked up ${lookedUp} of ${watchlist.length} watched publication(s) (${skipped} skipped); ${records.length} opposition-family event(s).`);
    return records;
}

export const epoOppositionConnector: Connector<EpoOppositionOptions> = {
    id: EPO_SOURCE_ID,
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'actor-21-patent-ip-enforcement-monitor',
    description:
        'EPO Open Patent Services legal-status lookup for a watchlist of EP publication numbers, reporting opposition-family legal events. BYOK: needs your own EPO OPS consumer key and secret (OAuth2 client credentials).',
    status: 'active',
    optionsSchema: epoOppositionOptionsSchema,
    requiredOptions: ['epoOpsConsumerKey', 'epoOpsConsumerSecret'],
    fetch: fetchEpoOppositionEvents,
};
