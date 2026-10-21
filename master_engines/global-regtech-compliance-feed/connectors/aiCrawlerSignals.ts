/**
 * ai_crawler_signals - AI-crawler content-signal permission monitor.
 *
 * Absorbs the legacy actor `ai-crawler-content-signal-permission-monitor`. That legacy repository is
 * README-ONLY (its `robotsParser.ts` / `deltaEngine.ts` are proprietary), so this connector implements the
 * behaviour the README documents and nothing more: for each caller-supplied domain it fetches
 * `/robots.txt` (plus, optionally, `/llms.txt` and `/llms-full.txt`), reports the effective permission of
 * every tracked AI-crawler token, the Cloudflare `Content-Signal` categories, and the presence / SHA-256 /
 * size of the llms files. The router owns delta memory, so a changed domain simply gets a changed fingerprint.
 *
 * LIVE SOURCE VERIFICATION (2026-10-21, plain GET with a descriptive User-Agent, redirects followed):
 *   - https://cloudflare.com/robots.txt -> 200 text/plain (via www.cloudflare.com). `User-agent: GPTBot` etc.
 *     each followed by `Allow: /`, then a stand-alone line
 *     `Content-Signal: ai-train=yes, search=yes, ai-input=yes` positioned AFTER the last group.
 *   - https://apify.com/robots.txt -> 200 text/plain. `User-agent: *` immediately followed by
 *     `Content-Signal: search=yes, ai-input=yes, ai-train=yes` inside the wildcard group, then `Allow: /`.
 *   - https://openai.com/robots.txt -> 200; only a `*` group with `Disallow: /microsoft-for-startups/`.
 *   - https://www.nytimes.com/robots.txt -> 200; explicit `Disallow: /` groups for GPTBot, ClaudeBot, CCBot,
 *     Google-Extended, PerplexityBot, Bytespider, anthropic-ai and others.
 *   - /llms.txt: cloudflare.com 200 text/plain (17,173 bytes); apify.com 200; apify.com/llms-full.txt 404
 *     (a markdown "404 Not Found" body); anthropic.com and nytimes.com 404 with an HTML error page;
 *     openai.com answers /llms.txt with HTTP 403 and an HTML challenge page. No bypass is attempted: a 4xx other
 *     than 404/410 is reported as `blocked`, never retried with different headers.
 *   So `Content-Signal` appears either inside the `*` group or after other groups; both are handled, and
 *   `content_signals_scope` says which one produced the values.
 *
 * STATUS CLASSIFICATION (so that a transient failure can never masquerade as a policy change):
 *   200 (non-HTML)  -> present
 *   404 / 410       -> absent     (the legacy README: "404 = valid 'absent' signal")
 *   200 with an HTML document body -> absent (soft 404 from a single-page-app catch-all; this guard is this
 *                      connector's own addition and is covered by a clearly synthetic test)
 *   other 4xx       -> blocked    (stable and deterministic, e.g. a WAF 403; reported, never bypassed)
 *   5xx, 408/425/429, network error, timeout -> TRANSIENT: the domain is skipped this run and retried next
 *                      run, because emitting a guess would create a false delta.
 *
 * SSRF GUARD. Domains are caller-supplied and fetched server-side, so the zod schema accepts a bare public
 * hostname only: no scheme, path, query, credentials, port, IPv4/IPv6 literal (including decimal, hex and
 * shorthand forms), `localhost`, single-label names, reserved/internal suffixes, or hostnames that embed an
 * IPv4 address (the `127.0.0.1.nip.io` family). At most MAX_DOMAINS domains are accepted. Two residual risks
 * cannot be closed from inside a connector and are reported as lib change requests: (1) DNS can still resolve
 * a public-looking name to a private address (rebinding), and (2) `lib/http.ts` follows redirects without a
 * per-hop host check. Only parsed signals are ever emitted - never the raw response body - so a redirect
 * to an internal service can at most reveal presence/size of a text document, not its content.
 *
 * NOT PORTED: the legacy delta vocabulary (`event_type` BASELINE_SNAPSHOT / ALLOWED / DISALLOWED / CHANGED /
 * NO_CHANGE) and the diff fields (`changed_permissions`, `changed_content_signals`, `llms_txt_change`).
 * Those need the previous snapshot, which the Connector contract does not hand to a connector; the router
 * exposes `delta_status` (first_seen / updated / unchanged) instead, and `status_fingerprint` /
 * `content_fingerprint` below let a consumer tell a permission flip from a content-signal / llms change.
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

import { z } from 'zod';

import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const AI_CRAWLER_SOURCE_ID = 'ai_crawler_signals';

/** Hard cap on domains per run (legacy `maxDomainsPerRun` default). */
export const MAX_DOMAINS = 200;
export const MAX_TRACKED_BOTS = 50;

/** The 18 tracked user-agent tokens listed in the legacy README ("trackedBots defaults to ..."). */
export const DEFAULT_TRACKED_BOTS: readonly string[] = [
    'GPTBot',
    'ChatGPT-User',
    'OAI-SearchBot',
    'ClaudeBot',
    'Claude-User',
    'Claude-SearchBot',
    'Google-Extended',
    'Applebot-Extended',
    'PerplexityBot',
    'Perplexity-User',
    'CCBot',
    'Bytespider',
    'Amazonbot',
    'Meta-ExternalAgent',
    'Meta-ExternalFetcher',
    'Diffbot',
    'cohere-ai',
    'omgilibot',
];

/** RFC 9309 section 2.5: a crawler must parse at least 500 KiB; anything beyond 512 KiB is ignored. */
export const ROBOTS_MAX_CHARS = 512 * 1024;

// ---------------------------------------------------------------------------
// Hostname validation (SSRF guard)
// ---------------------------------------------------------------------------

const RESERVED_TLDS = new Set([
    'localhost',
    'local',
    'localdomain',
    'internal',
    'intranet',
    'lan',
    'corp',
    'home',
    'private',
    'invalid',
    'test',
    'example',
    'onion',
    'arpa',
    'kubernetes',
    'cluster',
    'svc',
]);

const ASCII_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
/** `127.0.0.1.nip.io`, `169-254-169-254.sslip.io`, `10.0.0.1.example.com`: an IPv4 address smuggled into a name. */
const EMBEDDED_IPV4 = /(?:^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(?:[.-]|$)/u;

export type HostnameCheck = { ok: true; host: string } | { ok: false; reason: string };

/** Validates and normalises one caller-supplied domain. Pure; exported for tests. */
export function validateHostname(raw: unknown): HostnameCheck {
    if (typeof raw !== 'string') return { ok: false, reason: 'must be a string' };
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '') return { ok: false, reason: 'must not be empty' };
    if (trimmed.length > 300) return { ok: false, reason: 'is too long' };
    if (/^[a-z][a-z0-9+.-]*:\/\//u.test(trimmed) || trimmed.includes('://')) {
        return { ok: false, reason: 'must be a bare hostname, not a URL (remove the scheme)' };
    }
    if (/[/\\?#@\s]/u.test(trimmed)) return { ok: false, reason: 'must be a bare hostname (no path, query, credentials or spaces)' };
    if (/[:[\]]/u.test(trimmed)) return { ok: false, reason: 'must not contain a port or an IPv6 literal' };

    const host = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    const ascii = domainToASCII(host);
    if (ascii === '' || ascii.length > 253 || !ASCII_HOSTNAME.test(ascii)) {
        return { ok: false, reason: 'is not a valid public hostname (needs at least two dot-separated labels)' };
    }

    const labels = ascii.split('.');
    const tld = labels[labels.length - 1] ?? '';
    if (/^(?:\d+|0x[0-9a-f]*)$/u.test(tld)) return { ok: false, reason: 'looks like an IP address, which is not allowed' };
    if (RESERVED_TLDS.has(tld)) return { ok: false, reason: `uses the reserved/internal suffix ".${tld}"` };
    if (labels.includes('localhost')) return { ok: false, reason: 'must not contain a "localhost" label' };
    if (EMBEDDED_IPV4.test(ascii)) return { ok: false, reason: 'embeds an IP address, which is not allowed' };
    return { ok: true, host: ascii };
}

const domainSchema = z.string().transform((value, ctx) => {
    const checked = validateHostname(value);
    if (!checked.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `domain ${JSON.stringify(value.slice(0, 80))} ${checked.reason}` });
        return z.NEVER;
    }
    return checked.host;
});

const botTokenSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u, 'trackedBots entries must be user-agent tokens (letters, digits, ".", "_", "-"; 2-64 characters)');

export const aiCrawlerOptionsSchema = z.object({
    /** Hostnames to monitor (required). Validated against the SSRF guard above and de-duplicated. */
    domains: z
        .array(domainSchema)
        .min(1, 'Provide at least one domain.')
        .max(MAX_DOMAINS, `At most ${MAX_DOMAINS} domains per run.`)
        .transform((hosts) => [...new Set(hosts)]),
    /** AI-crawler user-agent tokens to evaluate. Empty / omitted = the 18 documented defaults. */
    trackedBots: z.array(botTokenSchema).max(MAX_TRACKED_BOTS).optional(),
    checkContentSignals: z.boolean().default(true),
    checkLlmsTxt: z.boolean().default(true),
    /** Simultaneous domains in flight (each domain makes up to 3 sequential requests). */
    concurrency: z.number().int().min(1).max(15).default(5),
    requestTimeoutSecs: z.number().int().min(1).max(60).default(15),
});
export type AiCrawlerOptions = z.output<typeof aiCrawlerOptionsSchema>;

/** Empty / absent `trackedBots` means "the defaults", never "no bots"; entries are de-duplicated case-insensitively. */
export function resolveTrackedBots(configured: readonly string[] | undefined): string[] {
    const source = configured && configured.length > 0 ? configured : DEFAULT_TRACKED_BOTS;
    const seen = new Set<string>();
    const bots: string[] = [];
    for (const token of source) {
        const key = token.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        bots.push(token);
    }
    return bots;
}

// ---------------------------------------------------------------------------
// robots.txt parsing (RFC 9309 group semantics) + Content-Signal extraction
// ---------------------------------------------------------------------------

export interface RobotsRule {
    type: 'allow' | 'disallow';
    path: string;
}

export interface RobotsGroup {
    /** Lower-cased user-agent tokens of this group. */
    agents: string[];
    rules: RobotsRule[];
    /** Raw `Content-Signal:` values that sit inside this group. */
    contentSignals: string[];
}

export interface ParsedRobots {
    groups: RobotsGroup[];
    /** `Content-Signal:` lines that appear before any `User-agent:` line. */
    orphanContentSignals: string[];
}

/**
 * Parses robots.txt into groups. Consecutive `User-agent` lines share one group; a `User-agent` line that
 * follows any directive (Allow, Disallow, Content-Signal) opens a new group. Rule lines before the first
 * `User-agent` are ignored (RFC 9309); unknown directives such as `Sitemap` are ignored and do not end a group.
 */
export function parseRobotsTxt(text: string): ParsedRobots {
    const capped = text.length > ROBOTS_MAX_CHARS ? text.slice(0, ROBOTS_MAX_CHARS) : text;
    const parsed: ParsedRobots = { groups: [], orphanContentSignals: [] };
    let current: RobotsGroup | null = null;
    let currentHasDirectives = false;

    for (const rawLine of capped.replace(/^﻿/u, '').split(/\r\n|\r|\n/u)) {
        const hash = rawLine.indexOf('#');
        const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
        if (line === '') continue;
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (key === 'user-agent') {
            if (value === '') continue;
            if (current === null || currentHasDirectives) {
                current = { agents: [], rules: [], contentSignals: [] };
                parsed.groups.push(current);
                currentHasDirectives = false;
            }
            current.agents.push(value.toLowerCase());
        } else if (key === 'allow' || key === 'disallow') {
            if (current === null) continue;
            current.rules.push({ type: key, path: value });
            currentHasDirectives = true;
        } else if (key === 'content-signal') {
            if (current === null) {
                parsed.orphanContentSignals.push(value);
            } else {
                current.contentSignals.push(value);
                currentHasDirectives = true;
            }
        }
    }
    return parsed;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** RFC 9309 path matching: prefix match from the start, `*` = any run of characters, trailing `$` = end anchor. */
export function pathMatches(pattern: string, path: string): boolean {
    if (pattern.length === 0 || pattern.length > 2048) return false;
    if (!pattern.startsWith('/') && !pattern.startsWith('*')) return false;
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body.split('*').map(escapeRegExp).join('.*');
    return new RegExp(`^${source}${anchored ? '$' : ''}`, 'u').test(path);
}

export type BotDirective = 'allow' | 'disallow' | 'not_specified';
export type BotMechanism = 'specific_group' | 'wildcard_group' | 'none';

export interface BotPermission {
    directive: BotDirective;
    /** The winning rule's path pattern for the site root, or null when no rule matched. */
    matched_pattern: string | null;
    /** Which group applied: the bot's own group, the `*` group, or none. */
    mechanism: BotMechanism;
}

const NOT_SPECIFIED: BotPermission = { directive: 'not_specified', matched_pattern: null, mechanism: 'none' };

/**
 * Effective permission of one bot token for the site root `/`:
 * the bot's own group(s) win over the `*` group; within the applicable rules the longest matching pattern
 * wins and `allow` beats `disallow` on a tie (RFC 9309 section 2.2.2). No matching rule -> `not_specified`.
 */
export function evaluateBotPermission(parsed: ParsedRobots, token: string, path = '/'): BotPermission {
    const wanted = token.toLowerCase();
    const specific = parsed.groups.filter((g) => g.agents.includes(wanted));
    const wildcard = parsed.groups.filter((g) => g.agents.includes('*'));

    let applicable: RobotsGroup[];
    let mechanism: BotMechanism;
    if (specific.length > 0) {
        applicable = specific;
        mechanism = 'specific_group';
    } else if (wildcard.length > 0) {
        applicable = wildcard;
        mechanism = 'wildcard_group';
    } else {
        return NOT_SPECIFIED;
    }

    let best: RobotsRule | null = null;
    for (const rule of applicable.flatMap((g) => g.rules)) {
        // An empty `Disallow:` / `Allow:` value is a no-op by definition.
        if (rule.path === '' || !pathMatches(rule.path, path)) continue;
        if (
            best === null ||
            rule.path.length > best.path.length ||
            (rule.path.length === best.path.length && rule.type === 'allow' && best.type === 'disallow')
        ) {
            best = rule;
        }
    }
    if (best === null) return { directive: 'not_specified', matched_pattern: null, mechanism };
    return { directive: best.type, matched_pattern: best.path, mechanism };
}

export type SignalValue = 'yes' | 'no' | null;
export type ContentSignalScope = 'wildcard_group' | 'other_group' | 'file_level';

export interface ContentSignals {
    search: SignalValue;
    ai_input: SignalValue;
    ai_train: SignalValue;
}

const SIGNAL_KEYS: Record<string, keyof ContentSignals> = { search: 'search', 'ai-input': 'ai_input', 'ai-train': 'ai_train' };

function parseSignalLines(lines: readonly string[]): ContentSignals {
    const signals: ContentSignals = { search: null, ai_input: null, ai_train: null };
    for (const line of lines) {
        for (const pair of line.split(',')) {
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const key = SIGNAL_KEYS[pair.slice(0, eq).trim().toLowerCase()];
            const value = pair.slice(eq + 1).trim().toLowerCase();
            // First occurrence of a category wins; anything other than yes/no is ignored, never coerced.
            if (key !== undefined && signals[key] === null && (value === 'yes' || value === 'no')) signals[key] = value;
        }
    }
    return signals;
}

/**
 * Content-Signal categories, preferring the `*` group, then any other group, then lines outside every group.
 * Returns the scope that produced the values so a consumer can tell "site-wide" from "inside a named bot's group".
 */
export function extractContentSignals(parsed: ParsedRobots): ContentSignals & { scope: ContentSignalScope | null } {
    const candidates: Array<[ContentSignalScope, string[]]> = [
        ['wildcard_group', parsed.groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.contentSignals)],
        ['other_group', parsed.groups.filter((g) => !g.agents.includes('*')).flatMap((g) => g.contentSignals)],
        ['file_level', parsed.orphanContentSignals],
    ];
    for (const [scope, lines] of candidates) {
        if (lines.length === 0) continue;
        const signals = parseSignalLines(lines);
        if (signals.search !== null || signals.ai_input !== null || signals.ai_train !== null) return { ...signals, scope };
    }
    return { search: null, ai_input: null, ai_train: null, scope: null };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const HTML_BODY = /^\s*<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/iu;
/** Retryable statuses in lib/http.ts: if these survive the retries they are transient, not a policy statement. */
const TRANSIENT_4XX = new Set([408, 425, 429]);

type Probe =
    | { kind: 'ok'; body: string }
    | { kind: 'absent' }
    | { kind: 'blocked'; status: number }
    | { kind: 'transient'; message: string };

function statusOf(error: unknown): number | null {
    if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = (error as { status: unknown }).status;
        if (typeof status === 'number' && Number.isFinite(status)) return status;
    }
    return null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function probe(ctx: ConnectorContext, url: string, timeoutMs: number): Promise<Probe> {
    try {
        const body = await ctx.http.getText(url, { timeoutMs, headers: { accept: 'text/plain, */*;q=0.5' } });
        if (HTML_BODY.test(body)) return { kind: 'absent' };
        return { kind: 'ok', body };
    } catch (error) {
        const status = statusOf(error);
        if (status === 404 || status === 410) return { kind: 'absent' };
        if (status !== null && status >= 400 && status < 500 && !TRANSIENT_4XX.has(status)) return { kind: 'blocked', status };
        return { kind: 'transient', message: messageOf(error) };
    }
}

export type FileStatus = 'present' | 'absent' | 'blocked' | 'not_checked';

export interface LlmsSignal {
    checked: boolean;
    /** true / false, or null when the file could not be determined (blocked) or was not checked. */
    present: boolean | null;
    status: FileStatus;
    url: string | null;
    content_sha256: string | null;
    bytes: number | null;
}

const NOT_CHECKED_LLMS: LlmsSignal = { checked: false, present: null, status: 'not_checked', url: null, content_sha256: null, bytes: null };

function sha256(text: string | Buffer): string {
    return createHash('sha256').update(text).digest('hex');
}

function llmsFromProbe(result: Exclude<Probe, { kind: 'transient' }>, url: string): LlmsSignal {
    switch (result.kind) {
        case 'ok':
            return { checked: true, present: true, status: 'present', url, content_sha256: sha256(result.body), bytes: Buffer.byteLength(result.body, 'utf8') };
        case 'absent':
            return { checked: true, present: false, status: 'absent', url: null, content_sha256: null, bytes: null };
        case 'blocked':
            return { checked: true, present: null, status: 'blocked', url: null, content_sha256: null, bytes: null };
    }
}

export interface DomainSnapshot {
    domain: string;
    robotsStatus: Exclude<FileStatus, 'not_checked'>;
    botPermissions: Record<string, BotPermission>;
    contentSignals: ContentSignals;
    contentSignalsScope: ContentSignalScope | null;
    llmsTxt: LlmsSignal;
    llmsFullTxt: LlmsSignal;
}

/** Builds the engine record for one domain snapshot. Pure; exported for tests. */
export function toDomainRecord(snapshot: DomainSnapshot, bots: readonly string[]): SourceRecord {
    const statusFingerprint = sha256(
        JSON.stringify({
            robots: snapshot.robotsStatus,
            bots: bots.map((bot) => {
                const p = snapshot.botPermissions[bot] ?? NOT_SPECIFIED;
                return [bot, p.directive, p.matched_pattern, p.mechanism];
            }),
        }),
    );
    const contentFingerprint = sha256(
        JSON.stringify({
            signals: [snapshot.contentSignals.search, snapshot.contentSignals.ai_input, snapshot.contentSignals.ai_train],
            scope: snapshot.contentSignalsScope,
            llms: [snapshot.llmsTxt.status, snapshot.llmsTxt.content_sha256],
            llmsFull: [snapshot.llmsFullTxt.status, snapshot.llmsFullTxt.content_sha256],
        }),
    );
    return {
        recordId: snapshot.domain,
        fingerprint: fingerprintOf([statusFingerprint, contentFingerprint]),
        payload: {
            domain: snapshot.domain,
            source_url: `https://${snapshot.domain}/robots.txt`,
            robots_txt_status: snapshot.robotsStatus,
            bot_permissions: snapshot.botPermissions,
            content_signals: snapshot.contentSignals,
            content_signals_scope: snapshot.contentSignalsScope,
            llms_txt: snapshot.llmsTxt,
            llms_full_txt: snapshot.llmsFullTxt,
            status_fingerprint: statusFingerprint,
            content_fingerprint: contentFingerprint,
        },
        // The domain itself, so an engine-level watchlist can flag a watched property.
        watchText: snapshot.domain,
    };
}

type DomainOutcome = { ok: true; record: SourceRecord } | { ok: false; domain: string; reason: string };

async function checkDomain(ctx: ConnectorContext, domain: string, bots: readonly string[], options: AiCrawlerOptions): Promise<DomainOutcome> {
    const timeoutMs = options.requestTimeoutSecs * 1000;
    try {
        const robots = await probe(ctx, `https://${domain}/robots.txt`, timeoutMs);
        if (robots.kind === 'transient') return { ok: false, domain, reason: `robots.txt: ${robots.message}` };

        const robotsStatus: DomainSnapshot['robotsStatus'] = robots.kind === 'ok' ? 'present' : robots.kind;
        const parsed = robots.kind === 'ok' ? parseRobotsTxt(robots.body) : null;

        const botPermissions: Record<string, BotPermission> = {};
        for (const bot of bots) botPermissions[bot] = parsed ? evaluateBotPermission(parsed, bot) : NOT_SPECIFIED;

        const signals = parsed && options.checkContentSignals ? extractContentSignals(parsed) : null;

        let llmsTxt = NOT_CHECKED_LLMS;
        let llmsFullTxt = NOT_CHECKED_LLMS;
        if (options.checkLlmsTxt) {
            const llmsUrl = `https://${domain}/llms.txt`;
            const fullUrl = `https://${domain}/llms-full.txt`;
            const first = await probe(ctx, llmsUrl, timeoutMs);
            if (first.kind === 'transient') return { ok: false, domain, reason: `llms.txt: ${first.message}` };
            const second = await probe(ctx, fullUrl, timeoutMs);
            if (second.kind === 'transient') return { ok: false, domain, reason: `llms-full.txt: ${second.message}` };
            llmsTxt = llmsFromProbe(first, llmsUrl);
            llmsFullTxt = llmsFromProbe(second, fullUrl);
        }

        return {
            ok: true,
            record: toDomainRecord(
                {
                    domain,
                    robotsStatus,
                    botPermissions,
                    contentSignals: signals ? { search: signals.search, ai_input: signals.ai_input, ai_train: signals.ai_train } : { search: null, ai_input: null, ai_train: null },
                    contentSignalsScope: signals?.scope ?? null,
                    llmsTxt,
                    llmsFullTxt,
                },
                bots,
            ),
        };
    } catch (error) {
        return { ok: false, domain, reason: messageOf(error) };
    }
}

/** Bounded-concurrency map that preserves input order. `fn` must not throw. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            results[index] = await fn(items[index] as T);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export const aiCrawlerSignalsConnector: Connector<AiCrawlerOptions> = {
    id: AI_CRAWLER_SOURCE_ID,
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'ai-crawler-content-signal-permission-monitor',
    description:
        "Per-domain AI-crawler permissions from robots.txt (RFC 9309 group matching for 18 tracked bots), Cloudflare Content-Signal categories, and /llms.txt + /llms-full.txt presence and SHA-256. " +
        'Domains are supplied by the caller (hostnames only, SSRF-guarded, max 200).',
    status: 'active',
    optionsSchema: aiCrawlerOptionsSchema,
    requiredOptions: ['domains'],

    async fetch(ctx: ConnectorContext, options: AiCrawlerOptions, run: RunParams): Promise<SourceRecord[]> {
        const bots = resolveTrackedBots(options.trackedBots);
        const domains = options.domains.slice(0, run.maxItemsPerSource);
        if (domains.length < options.domains.length) {
            ctx.log.info(`[${AI_CRAWLER_SOURCE_ID}] maxItemsPerSource=${run.maxItemsPerSource}: checking ${domains.length} of ${options.domains.length} domain(s).`);
        }

        const outcomes = await mapWithConcurrency(domains, options.concurrency, (domain) => checkDomain(ctx, domain, bots, options));

        const records: SourceRecord[] = [];
        const failures: string[] = [];
        for (const outcome of outcomes) {
            if (outcome.ok) {
                records.push(outcome.record);
            } else {
                failures.push(`${outcome.domain} (${outcome.reason})`);
                ctx.log.warning(`[${AI_CRAWLER_SOURCE_ID}] ${outcome.domain} skipped this run (transient failure, will be retried next run): ${outcome.reason}`);
            }
        }
        if (records.length === 0 && failures.length > 0) {
            throw new SourceFetchError(`Every domain failed: ${failures.slice(0, 5).join(' | ')}${failures.length > 5 ? ` | +${failures.length - 5} more` : ''}`, AI_CRAWLER_SOURCE_ID);
        }
        return records;
    },
};
