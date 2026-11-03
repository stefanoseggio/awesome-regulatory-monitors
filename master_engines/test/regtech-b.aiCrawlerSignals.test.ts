/**
 * ai_crawler_signals connector tests. No network.
 *
 * Fixtures: the Cloudflare, Apify and OpenAI robots.txt bodies are the real files captured live on 2026-10-21.
 * The NYT body is an EXCERPT: only the eight AI-bot groups whose `Disallow: /` lines were observed live (the real
 * file is 8.5 KB and also has a `*` group, which the excerpt deliberately omits). Cases marked SYNTHETIC are
 * hand-written robots.txt text that exercises a specific RFC 9309 rule; they do not pretend to be a real site.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    aiCrawlerOptionsSchema,
    aiCrawlerSignalsConnector,
    DEFAULT_TRACKED_BOTS,
    evaluateBotPermission,
    extractContentSignals,
    MAX_DOMAINS,
    parseRobotsTxt,
    pathMatches,
    resolveTrackedBots,
    toDomainRecord,
    validateHostname,
} from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { FatalConfigError, SourceFetchError } from '../lib/types.js';
import { createStubHttp, httpError, makeCtx, must, ROUTER_OWNED_KEYS, type StubBody, type StubRoute } from './regtech-b.helpers.js';

const RUN = { maxItemsPerSource: 500 };

// --- real captures (2026-10-21) -------------------------------------------------------------------------------

const CLOUDFLARE_ROBOTS = [
    '# Robots.txt for www.cloudflare.com',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# Sitemap',
    'Sitemap: https://www.cloudflare.com/sitemap.xml',
    '',
    '# AI/LLM friendly content',
    '# See https://llmstxt.org for the llms.txt specification',
    '# llms.txt provides curated content for AI assistants and LLMs',
    '',
    '# Allow AI crawlers to access markdown versions of pages',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: ChatGPT-User',
    'Allow: /',
    '',
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    'User-agent: Anthropic-AI',
    'Allow: /',
    '',
    'User-agent: Claude-Web',
    'Allow: /',
    '',
    'User-agent: CCBot',
    'Allow: /',
    '',
    'User-agent: PerplexityBot',
    'Allow: /',
    '',
    'User-agent: Cohere-ai',
    'Allow: /',
    '',
    '# Content Signals — declare AI content usage preferences',
    '# See https://contentsignals.org/ and https://datatracker.ietf.org/doc/draft-romm-aipref-contentsignals/',
    'Content-Signal: ai-train=yes, search=yes, ai-input=yes',
    '',
    '# AI-friendly content locations',
    '# - /llms.txt - Curated overview for AI/LLMs (markdown)',
    '# - /llms-full.txt - Full expanded content for larger context windows',
    '',
].join('\n');

const APIFY_ROBOTS = [
    'User-agent: *',
    'Content-Signal: search=yes, ai-input=yes, ai-train=yes',
    'Allow: /',
    '',
    'Sitemap: https://apify.com/sitemap.xml',
    'Agentmap: https://apify.com/.well-known/ai-catalog.json',
    '',
].join('\n');

const OPENAI_ROBOTS = ['User-agent: *', 'Allow: /', 'Disallow: /microsoft-for-startups/', '', 'Sitemap: https://openai.com/sitemap.xml'].join('\n');

/** EXCERPT of nytimes.com/robots.txt: the AI-bot groups seen live, each `Disallow: /`. No `*` group included. */
const NYT_EXCERPT = ['anthropic-ai', 'Bytespider', 'CCBot', 'ClaudeBot', 'Google-Extended', 'GPTBot', 'PerplexityBot', 'Perplexity-User']
    .map((bot) => `User-agent: ${bot}\nDisallow: /`)
    .join('\n\n');

const CLOUDFLARE_LLMS = '# Cloudflare\n\n> Cloudflare is a global cloud connectivity company.\n';

// --- helpers --------------------------------------------------------------------------------------------------

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

interface DomainFixture {
    robots?: StubBody | undefined;
    llms?: StubBody | undefined;
    llmsFull?: StubBody | undefined;
}

/** Missing entries answer 404 (the "absent" signal), exactly like the live sites do. */
function domainRoutes(domain: string, fixture: DomainFixture): Record<string, StubRoute> {
    const route = (path: string, body: StubBody | undefined): StubBody => body ?? httpError(`https://${domain}${path}`, 404, 'Not Found');
    return {
        [`https://${domain}/robots.txt`]: route('/robots.txt', fixture.robots),
        [`https://${domain}/llms.txt`]: route('/llms.txt', fixture.llms),
        [`https://${domain}/llms-full.txt`]: route('/llms-full.txt', fixture.llmsFull),
    };
}

function opts(raw: Record<string, unknown>) {
    return aiCrawlerOptionsSchema.parse(raw);
}

// --- hostname validation / SSRF guard -------------------------------------------------------------------------

describe('validateHostname (SSRF guard)', () => {
    const accepted: Array<[string, string]> = [
        ['openai.com', 'openai.com'],
        ['  WWW.Example.COM  ', 'www.example.com'],
        ['example.com.', 'example.com'],
        ['sub.domain.co.uk', 'sub.domain.co.uk'],
        ['bücher.de', 'xn--bcher-kva.de'],
        ['xn--bcher-kva.de', 'xn--bcher-kva.de'],
        ['a-b.example.org', 'a-b.example.org'],
    ];
    it.each(accepted)('accepts %j as %j', (raw, host) => {
        expect(validateHostname(raw)).toEqual({ ok: true, host });
    });

    const rejected: Array<[string, unknown]> = [
        ['a URL with a scheme', 'https://example.com'],
        ['a scheme-relative-looking URL', 'http://example.com/robots.txt'],
        ['a path', 'example.com/robots.txt'],
        ['a query', 'example.com?x=1'],
        ['a fragment', 'example.com#x'],
        ['credentials', 'user@example.com'],
        ['a port', 'example.com:8080'],
        ['a bracketed IPv6 literal', '[::1]'],
        ['a bare IPv6 literal', '::1'],
        ['IPv4 loopback', '127.0.0.1'],
        ['IPv4 private 10/8', '10.0.0.1'],
        ['IPv4 private 192.168/16', '192.168.1.1'],
        ['cloud metadata IP', '169.254.169.254'],
        ['decimal IPv4', '2130706433'],
        ['hex IPv4', '0x7f.0.0.1'],
        ['shorthand IPv4', '127.1'],
        ['octal-ish IPv4', '0177.0.0.1'],
        ['localhost', 'localhost'],
        ['localhost with trailing dot', 'localhost.'],
        ['a *.localhost name', 'app.localhost'],
        ['a localhost label', 'localhost.example.com'],
        ['a .local name', 'printer.local'],
        ['a .internal name', 'db.internal'],
        ['a .lan name', 'router.lan'],
        ['a .corp name', 'wiki.corp'],
        ['a .home.arpa name', 'nas.home.arpa'],
        ['a single-label name', 'intranet'],
        ['an embedded IPv4 (nip.io style)', '127.0.0.1.nip.io'],
        ['an embedded IPv4 (dashed, sslip.io style)', '169-254-169-254.sslip.io'],
        ['an underscore', 'a_b.example.com'],
        ['a leading hyphen', '-bad.example.com'],
        ['a trailing hyphen label', 'bad-.example.com'],
        ['an over-long label', `${'a'.repeat(64)}.com`],
        ['whitespace inside', 'exa mple.com'],
        ['an empty string', ''],
        ['a blank string', '   '],
        ['a number', 42],
        ['null', null],
        ['an object', { host: 'example.com' }],
    ];
    it.each(rejected)('rejects %s', (_label, raw) => {
        const result = validateHostname(raw);
        expect(result.ok).toBe(false);
    });
});

describe('aiCrawlerOptionsSchema', () => {
    it('requires domains', () => {
        expect(aiCrawlerOptionsSchema.safeParse({}).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: [] }).success).toBe(false);
    });

    it(`caps the list at ${MAX_DOMAINS} domains`, () => {
        const many = Array.from({ length: MAX_DOMAINS + 1 }, (_, i) => `site${i}.example.org`);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: many }).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: many.slice(0, MAX_DOMAINS) }).success).toBe(true);
    });

    it('normalises and de-duplicates domains', () => {
        expect(opts({ domains: ['OpenAI.com', 'openai.com', ' openai.com. ', 'apify.com'] }).domains).toEqual(['openai.com', 'apify.com']);
    });

    it('names the offending entry when a domain is unsafe', () => {
        const result = aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com', 'http://169.254.169.254/latest/meta-data/'] });
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = must(result.error.issues[0]);
            expect(issue.path).toEqual(['domains', 1]);
            expect(issue.message).toMatch(/bare hostname/u);
        }
    });

    it('validates trackedBots tokens and treats an empty list as "use the defaults"', () => {
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], trackedBots: ['GPT Bot'] }).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], trackedBots: ['x'] }).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], trackedBots: ['*'] }).success).toBe(false);
        expect(resolveTrackedBots([])).toEqual([...DEFAULT_TRACKED_BOTS]);
        expect(resolveTrackedBots(undefined)).toHaveLength(18);
        expect(resolveTrackedBots(['GPTBot', 'gptbot', 'ClaudeBot'])).toEqual(['GPTBot', 'ClaudeBot']);
    });

    it('bounds concurrency and timeout', () => {
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], concurrency: 0 }).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], concurrency: 16 }).success).toBe(false);
        expect(aiCrawlerOptionsSchema.safeParse({ domains: ['openai.com'], requestTimeoutSecs: 61 }).success).toBe(false);
    });

    it('is enforced by the router preflight: missing domains is a FatalConfigError before any network call', () => {
        const engine = { slug: 'global-regtech-compliance-feed' as const, connectors: [aiCrawlerSignalsConnector] };
        expect(aiCrawlerSignalsConnector.requiredOptions).toEqual(['domains']);
        expect(() => resolveSources(engine, EngineInputSchema.parse({ sources: ['ai_crawler_signals'] }))).toThrow(FatalConfigError);
        expect(() =>
            resolveSources(engine, EngineInputSchema.parse({ sources: ['ai_crawler_signals'], sourceOptions: { ai_crawler_signals: { domains: ['http://169.254.169.254/'] } } })),
        ).toThrow(/Invalid options for "ai_crawler_signals"/u);
        const ok = resolveSources(engine, EngineInputSchema.parse({ sources: ['ai_crawler_signals'], sourceOptions: { ai_crawler_signals: { domains: ['openai.com'] } } }));
        expect(ok).toHaveLength(1);
    });
});

// --- robots.txt parsing --------------------------------------------------------------------------------------

describe('robots.txt parsing on real captures', () => {
    it('Cloudflare: bot-specific Allow groups, wildcard fallback, Content-Signal after the last group', () => {
        const parsed = parseRobotsTxt(CLOUDFLARE_ROBOTS);
        expect(evaluateBotPermission(parsed, 'GPTBot')).toEqual({ directive: 'allow', matched_pattern: '/', mechanism: 'specific_group' });
        expect(evaluateBotPermission(parsed, 'cohere-ai')).toEqual({ directive: 'allow', matched_pattern: '/', mechanism: 'specific_group' });
        // ClaudeBot has no group of its own on this site, so the `*` group applies.
        expect(evaluateBotPermission(parsed, 'ClaudeBot')).toEqual({ directive: 'allow', matched_pattern: '/', mechanism: 'wildcard_group' });
        expect(extractContentSignals(parsed)).toEqual({ search: 'yes', ai_input: 'yes', ai_train: 'yes', scope: 'other_group' });
    });

    it('Apify: Content-Signal inside the * group is reported with the wildcard scope', () => {
        const parsed = parseRobotsTxt(APIFY_ROBOTS);
        expect(extractContentSignals(parsed)).toEqual({ search: 'yes', ai_input: 'yes', ai_train: 'yes', scope: 'wildcard_group' });
        expect(evaluateBotPermission(parsed, 'GPTBot').mechanism).toBe('wildcard_group');
    });

    it('OpenAI: a partial Disallow does not block the site root, and no Content-Signal is reported', () => {
        const parsed = parseRobotsTxt(OPENAI_ROBOTS);
        expect(evaluateBotPermission(parsed, 'GPTBot')).toEqual({ directive: 'allow', matched_pattern: '/', mechanism: 'wildcard_group' });
        expect(extractContentSignals(parsed)).toEqual({ search: null, ai_input: null, ai_train: null, scope: null });
    });

    it('NYT excerpt: explicit Disallow: / for named bots; a bot with no group and no * group is not_specified', () => {
        const parsed = parseRobotsTxt(NYT_EXCERPT);
        expect(evaluateBotPermission(parsed, 'GPTBot')).toEqual({ directive: 'disallow', matched_pattern: '/', mechanism: 'specific_group' });
        expect(evaluateBotPermission(parsed, 'anthropic-ai').directive).toBe('disallow');
        expect(evaluateBotPermission(parsed, 'Claude-User')).toEqual({ directive: 'not_specified', matched_pattern: null, mechanism: 'none' });
    });
});

describe('RFC 9309 group semantics (SYNTHETIC robots.txt text)', () => {
    it('a bot-specific group wins over the * group', () => {
        const parsed = parseRobotsTxt('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n');
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('allow');
        expect(evaluateBotPermission(parsed, 'ClaudeBot')).toEqual({ directive: 'disallow', matched_pattern: '/', mechanism: 'wildcard_group' });
    });

    it('consecutive User-agent lines share one group', () => {
        const parsed = parseRobotsTxt('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n');
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('disallow');
        expect(evaluateBotPermission(parsed, 'ClaudeBot').directive).toBe('disallow');
    });

    it('the longest matching pattern wins and allow beats disallow on a tie', () => {
        expect(evaluateBotPermission(parseRobotsTxt('User-agent: *\nDisallow: /\nAllow: /$\n'), 'GPTBot')).toMatchObject({ directive: 'allow', matched_pattern: '/$' });
        expect(evaluateBotPermission(parseRobotsTxt('User-agent: *\nDisallow: /\nAllow: /\n'), 'GPTBot')).toMatchObject({ directive: 'allow', matched_pattern: '/' });
        expect(evaluateBotPermission(parseRobotsTxt('User-agent: *\nAllow: /\nDisallow: /*\n'), 'GPTBot')).toMatchObject({ directive: 'disallow', matched_pattern: '/*' });
    });

    it('matches user-agent tokens case-insensitively', () => {
        const parsed = parseRobotsTxt('User-Agent: GPTBOT\nDISALLOW: /\n');
        expect(evaluateBotPermission(parsed, 'gptbot').directive).toBe('disallow');
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('disallow');
    });

    it('an empty Disallow is a no-op: the group applies but no rule matched', () => {
        const parsed = parseRobotsTxt('User-agent: GPTBot\nDisallow:\n');
        expect(evaluateBotPermission(parsed, 'GPTBot')).toEqual({ directive: 'not_specified', matched_pattern: null, mechanism: 'specific_group' });
    });

    it('a User-agent line after directives opens a new group; rules before any User-agent are ignored', () => {
        const parsed = parseRobotsTxt('Disallow: /\nUser-agent: GPTBot\nAllow: /\nUser-agent: ClaudeBot\nDisallow: /\n');
        expect(parsed.groups).toHaveLength(2);
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('allow');
        expect(evaluateBotPermission(parsed, 'ClaudeBot').directive).toBe('disallow');
    });

    it('survives BOM, CRLF, CR-only newlines, comments and junk lines', () => {
        const parsed = parseRobotsTxt('﻿User-agent: GPTBot # the bot\r\nDisallow: / # all\r\nthis line has no colon\r\n:novalue\rSitemap: https://x.example/s.xml\r');
        expect(evaluateBotPermission(parsed, 'GPTBot')).toMatchObject({ directive: 'disallow', matched_pattern: '/' });
    });

    it('does not let an unknown directive such as Sitemap close a group', () => {
        const parsed = parseRobotsTxt('User-agent: GPTBot\nSitemap: https://x.example/s.xml\nDisallow: /\n');
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('disallow');
    });

    it('ignores everything beyond the 512 KiB parse cap', () => {
        const padding = `${'# padding\n'.repeat(60_000)}`;
        const parsed = parseRobotsTxt(`User-agent: GPTBot\nAllow: /\n${padding}User-agent: ClaudeBot\nDisallow: /\n`);
        expect(evaluateBotPermission(parsed, 'ClaudeBot').directive).toBe('not_specified');
        expect(evaluateBotPermission(parsed, 'GPTBot').directive).toBe('allow');
    });
});

describe('pathMatches', () => {
    it('implements prefix, * wildcard and $ anchor semantics', () => {
        expect(pathMatches('/', '/')).toBe(true);
        expect(pathMatches('/*', '/')).toBe(true);
        expect(pathMatches('/$', '/')).toBe(true);
        expect(pathMatches('/private/', '/')).toBe(false);
        expect(pathMatches('/*.json$', '/')).toBe(false);
        expect(pathMatches('*', '/')).toBe(true);
        expect(pathMatches('/a*b', '/axxb')).toBe(true);
        expect(pathMatches('/a$', '/ab')).toBe(false);
    });

    it('rejects patterns that are empty, do not start with "/" or "*", or are absurdly long', () => {
        expect(pathMatches('', '/')).toBe(false);
        expect(pathMatches('private', '/')).toBe(false);
        expect(pathMatches(`/${'a*'.repeat(2000)}`, '/')).toBe(false);
    });

    it('does not backtrack catastrophically on adversarial patterns', () => {
        const started = Date.now();
        expect(pathMatches(`/${'*a'.repeat(900)}b`, '/')).toBe(false);
        expect(Date.now() - started).toBeLessThan(500);
    });
});

describe('extractContentSignals', () => {
    it('first occurrence of a category wins; invalid values and unknown categories are ignored, never coerced (SYNTHETIC)', () => {
        const parsed = parseRobotsTxt('User-agent: *\nContent-Signal: search=yes, ai-train=maybe, ai-input=NO, bogus=yes, search=no\nContent-Signal: ai-train=no\n');
        expect(extractContentSignals(parsed)).toEqual({ search: 'yes', ai_input: 'no', ai_train: 'no', scope: 'wildcard_group' });
    });

    it('reports file_level scope for a Content-Signal line before any group (SYNTHETIC)', () => {
        const parsed = parseRobotsTxt('Content-Signal: ai-train=no\nUser-agent: *\nAllow: /\n');
        expect(extractContentSignals(parsed)).toEqual({ search: null, ai_input: null, ai_train: 'no', scope: 'file_level' });
    });

    it('prefers the * group over other groups (SYNTHETIC)', () => {
        const parsed = parseRobotsTxt('User-agent: GPTBot\nContent-Signal: ai-train=yes\n\nUser-agent: *\nContent-Signal: ai-train=no\n');
        expect(extractContentSignals(parsed)).toMatchObject({ ai_train: 'no', scope: 'wildcard_group' });
    });
});

// --- connector.fetch -----------------------------------------------------------------------------------------

describe('aiCrawlerSignalsConnector.fetch', () => {
    it('builds the documented record for each domain from real-capture robots.txt bodies', async () => {
        const routes = {
            ...domainRoutes('cloudflare.com', { robots: CLOUDFLARE_ROBOTS, llms: CLOUDFLARE_LLMS }),
            ...domainRoutes('apify.com', { robots: APIFY_ROBOTS, llms: '# Apify\n' }),
        };
        const { http } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const records = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['cloudflare.com', 'apify.com'] }), RUN);

        expect(records.map((r) => r.recordId)).toEqual(['cloudflare.com', 'apify.com']);
        const cloudflare = must(records[0]);
        expect(cloudflare.watchText).toBe('cloudflare.com');
        expect(cloudflare.payload).toMatchObject({
            domain: 'cloudflare.com',
            source_url: 'https://cloudflare.com/robots.txt',
            robots_txt_status: 'present',
            content_signals: { search: 'yes', ai_input: 'yes', ai_train: 'yes' },
            content_signals_scope: 'other_group',
            llms_txt: { checked: true, present: true, status: 'present', url: 'https://cloudflare.com/llms.txt', content_sha256: sha256(CLOUDFLARE_LLMS), bytes: Buffer.byteLength(CLOUDFLARE_LLMS) },
            llms_full_txt: { checked: true, present: false, status: 'absent', url: null, content_sha256: null, bytes: null },
        });
        const permissions = cloudflare.payload.bot_permissions as Record<string, unknown>;
        expect(Object.keys(permissions)).toEqual([...DEFAULT_TRACKED_BOTS]);
        expect(permissions.GPTBot).toEqual({ directive: 'allow', matched_pattern: '/', mechanism: 'specific_group' });
        for (const key of ROUTER_OWNED_KEYS) expect(cloudflare.payload).not.toHaveProperty(key);
    });

    it('reports a deterministic 403 on llms.txt as blocked (never bypassed) and a 404 as absent', async () => {
        const routes = {
            ...domainRoutes('openai.com', {
                robots: OPENAI_ROBOTS,
                llms: httpError('https://openai.com/llms.txt', 403, '<html>Just a moment...</html>'),
                llmsFull: httpError('https://openai.com/llms-full.txt', 403, '<html>Just a moment...</html>'),
            }),
            ...domainRoutes('nytimes.com', { robots: NYT_EXCERPT }),
        };
        const { http, calls } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const records = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['openai.com', 'nytimes.com'] }), RUN);

        const openai = must(records[0]);
        expect(openai.payload.llms_txt).toMatchObject({ checked: true, present: null, status: 'blocked', url: null });
        expect(must(records[1]).payload.llms_txt).toMatchObject({ present: false, status: 'absent' });
        // One attempt per URL: a 403 is not retried with different headers by the connector.
        expect(calls.filter((c) => c.url === 'https://openai.com/llms.txt')).toHaveLength(1);
    });

    it('classifies robots.txt 404 as absent and 403 as blocked, with every bot not_specified', async () => {
        const routes = {
            ...domainRoutes('norobots.example.org', { robots: httpError('https://norobots.example.org/robots.txt', 404) }),
            ...domainRoutes('waf.example.org', { robots: httpError('https://waf.example.org/robots.txt', 403, 'blocked') }),
        };
        const { http } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const [absent, blocked] = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['norobots.example.org', 'waf.example.org'] }), RUN);

        expect(must(absent).payload).toMatchObject({ robots_txt_status: 'absent', content_signals: { search: null, ai_input: null, ai_train: null }, content_signals_scope: null });
        expect(must(blocked).payload.robots_txt_status).toBe('blocked');
        for (const record of [must(absent), must(blocked)]) {
            for (const permission of Object.values(record.payload.bot_permissions as Record<string, unknown>)) {
                expect(permission).toEqual({ directive: 'not_specified', matched_pattern: null, mechanism: 'none' });
            }
        }
    });

    it('treats a 200 HTML page at /llms.txt as absent (SYNTHETIC soft-404 body; this guard is the connector\'s own addition)', async () => {
        const routes = domainRoutes('spa.example.org', { robots: 'User-agent: *\nAllow: /\n', llms: '<!DOCTYPE html><html><body>app shell</body></html>', llmsFull: '  <html lang="en"><head></head></html>' });
        const { http } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const [record] = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['spa.example.org'] }), RUN);
        expect(must(record).payload.llms_txt).toMatchObject({ present: false, status: 'absent' });
        expect(must(record).payload.llms_full_txt).toMatchObject({ present: false, status: 'absent' });
    });

    it('skips a domain on a transient failure instead of emitting a guess, and logs it', async () => {
        const routes = {
            ...domainRoutes('good.example.org', { robots: 'User-agent: *\nAllow: /\n' }),
            ...domainRoutes('flaky.example.org', { robots: httpError('https://flaky.example.org/robots.txt', 503, 'busy') }),
            ...domainRoutes('timeout.example.org', { robots: new Error('The operation was aborted due to timeout') }),
            ...domainRoutes('llmsflaky.example.org', { robots: 'User-agent: *\nAllow: /\n', llms: httpError('https://llmsflaky.example.org/llms.txt', 500, 'oops') }),
            ...domainRoutes('ratelimited.example.org', { robots: httpError('https://ratelimited.example.org/robots.txt', 429, 'slow down') }),
        };
        const { http } = createStubHttp(routes);
        const { ctx, logs } = makeCtx(http);
        const records = await aiCrawlerSignalsConnector.fetch(
            ctx,
            opts({ domains: ['good.example.org', 'flaky.example.org', 'timeout.example.org', 'llmsflaky.example.org', 'ratelimited.example.org'] }),
            RUN,
        );
        expect(records.map((r) => r.recordId)).toEqual(['good.example.org']);
        expect(logs.filter((l) => l.level === 'warning')).toHaveLength(4);
    });

    it('throws SourceFetchError (with the source id) when every domain fails', async () => {
        const routes = {
            ...domainRoutes('a.example.org', { robots: httpError('https://a.example.org/robots.txt', 503) }),
            ...domainRoutes('b.example.org', { robots: new Error('getaddrinfo ENOTFOUND b.example.org') }),
        };
        const { http } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const failure = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['a.example.org', 'b.example.org'] }), RUN).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(SourceFetchError);
        expect((failure as SourceFetchError).source).toBe('ai_crawler_signals');
        expect((failure as SourceFetchError).message).toMatch(/a\.example\.org/u);
    });

    it('honours maxItemsPerSource: later domains are never requested', async () => {
        const routes = {
            ...domainRoutes('one.example.org', { robots: 'User-agent: *\nAllow: /\n' }),
            ...domainRoutes('two.example.org', { robots: 'User-agent: *\nAllow: /\n' }),
            ...domainRoutes('three.example.org', { robots: 'User-agent: *\nAllow: /\n' }),
        };
        const { http, calls } = createStubHttp(routes);
        const { ctx } = makeCtx(http);
        const records = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['one.example.org', 'two.example.org', 'three.example.org'] }), { maxItemsPerSource: 2 });
        expect(records.map((r) => r.recordId)).toEqual(['one.example.org', 'two.example.org']);
        expect(calls.some((c) => c.url.includes('three.example.org'))).toBe(false);
    });

    it('never has more than `concurrency` domains in flight', async () => {
        const domains = Array.from({ length: 8 }, (_, i) => `d${i}.example.org`);
        let inFlight = 0;
        let peak = 0;
        const routes: Record<string, StubRoute> = {};
        for (const domain of domains) {
            routes[`https://${domain}/robots.txt`] = async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 8));
                inFlight -= 1;
                return 'User-agent: *\nAllow: /\n';
            };
        }
        const { http } = createStubHttp({ ...routes });
        const { ctx } = makeCtx(http);
        const records = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains, checkLlmsTxt: false, concurrency: 3 }), RUN);
        expect(records).toHaveLength(8);
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
    });

    it('skips llms requests and nulls content signals when those checks are switched off', async () => {
        const { http, calls } = createStubHttp(domainRoutes('cloudflare.com', { robots: CLOUDFLARE_ROBOTS }));
        const { ctx } = makeCtx(http);
        const [record] = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['cloudflare.com'], checkLlmsTxt: false, checkContentSignals: false }), RUN);
        expect(calls.map((c) => c.url)).toEqual(['https://cloudflare.com/robots.txt']);
        expect(must(record).payload).toMatchObject({
            content_signals: { search: null, ai_input: null, ai_train: null },
            llms_txt: { checked: false, present: null, status: 'not_checked' },
            llms_full_txt: { checked: false, present: null, status: 'not_checked' },
        });
    });

    it('passes the configured timeout and an accept header to the shared client', async () => {
        const { http, calls } = createStubHttp(domainRoutes('apify.com', { robots: APIFY_ROBOTS }));
        const { ctx } = makeCtx(http);
        await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['apify.com'], checkLlmsTxt: false, requestTimeoutSecs: 7 }), RUN);
        expect(must(calls[0]).init?.timeoutMs).toBe(7000);
    });

    it('only emits parsed signals: the raw robots.txt body never reaches the payload', async () => {
        const marker = 'SECRET-INTERNAL-MARKER-12345';
        const { http } = createStubHttp(domainRoutes('leak.example.org', { robots: `# ${marker}\nUser-agent: *\nAllow: /\nSitemap: https://x.example/${marker}.xml\n`, llms: `${marker}\n` }));
        const { ctx } = makeCtx(http);
        const [record] = await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['leak.example.org'] }), RUN);
        expect(JSON.stringify(must(record).payload)).not.toContain(marker);
    });
});

// --- recordId stability and delta detection ------------------------------------------------------------------

describe('delta detection: recordId stable, fingerprint changes iff a consumer-visible field changes', () => {
    async function snapshot(robots: string, llms?: string) {
        const { http } = createStubHttp(domainRoutes('watched.example.org', { robots, llms }));
        const { ctx } = makeCtx(http);
        return must((await aiCrawlerSignalsConnector.fetch(ctx, opts({ domains: ['watched.example.org'] }), RUN))[0]);
    }
    const base = 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\n';

    it('identical upstream state gives an identical recordId and fingerprint', async () => {
        const a = await snapshot(base, '# llms\n');
        const b = await snapshot(base, '# llms\n');
        expect(a.recordId).toBe('watched.example.org');
        expect(b.fingerprint).toBe(a.fingerprint);
    });

    it('a permission flip changes the status fingerprint only', async () => {
        const before = await snapshot(base, '# llms\n');
        // GPTBot flips from Allow to Disallow; the * group is unchanged.
        const after = await snapshot('User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n', '# llms\n');
        expect(after.recordId).toBe(before.recordId);
        expect(after.fingerprint).not.toBe(before.fingerprint);
        expect(after.payload.status_fingerprint).not.toBe(before.payload.status_fingerprint);
        expect(after.payload.content_fingerprint).toBe(before.payload.content_fingerprint);
    });

    it('a Content-Signal change changes the content fingerprint only', async () => {
        const before = await snapshot(`${base}\nContent-Signal: ai-train=yes\n`, '# llms\n');
        const after = await snapshot(`${base}\nContent-Signal: ai-train=no\n`, '# llms\n');
        expect(after.fingerprint).not.toBe(before.fingerprint);
        expect(after.payload.status_fingerprint).toBe(before.payload.status_fingerprint);
        expect(after.payload.content_fingerprint).not.toBe(before.payload.content_fingerprint);
    });

    it('an llms.txt edit, addition or removal changes the content fingerprint only', async () => {
        const present = await snapshot(base, '# llms v1\n');
        const edited = await snapshot(base, '# llms v2\n');
        const removed = await snapshot(base, undefined);
        expect(edited.payload.content_fingerprint).not.toBe(present.payload.content_fingerprint);
        expect(removed.payload.content_fingerprint).not.toBe(present.payload.content_fingerprint);
        for (const changed of [edited, removed]) expect(changed.payload.status_fingerprint).toBe(present.payload.status_fingerprint);
    });

    it('edits that change no consumer-visible field (a comment, a sitemap line) leave the fingerprint untouched', async () => {
        const before = await snapshot(base, '# llms\n');
        const after = await snapshot(`# edited comment\n${base}\nSitemap: https://watched.example.org/sitemap.xml\n`, '# llms\n');
        expect(after.fingerprint).toBe(before.fingerprint);
    });

    it('toDomainRecord changes the fingerprint when the tracked bot list changes, even for the same robots.txt', () => {
        const parsed = parseRobotsTxt(base);
        const snap = (bots: string[]) =>
            toDomainRecord(
                {
                    domain: 'watched.example.org',
                    robotsStatus: 'present',
                    botPermissions: Object.fromEntries(bots.map((bot) => [bot, evaluateBotPermission(parsed, bot)])),
                    contentSignals: { search: null, ai_input: null, ai_train: null },
                    contentSignalsScope: null,
                    llmsTxt: { checked: false, present: null, status: 'not_checked', url: null, content_sha256: null, bytes: null },
                    llmsFullTxt: { checked: false, present: null, status: 'not_checked', url: null, content_sha256: null, bytes: null },
                },
                bots,
            );
        expect(snap(['GPTBot']).fingerprint).not.toBe(snap(['GPTBot', 'ClaudeBot']).fingerprint);
        expect(snap(['GPTBot']).fingerprint).toBe(snap(['GPTBot']).fingerprint);
    });
});
