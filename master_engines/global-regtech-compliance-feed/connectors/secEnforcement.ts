/**
 * sec_enforcement - SEC litigation releases + administrative proceedings.
 *
 * Absorbs the legacy actor `sec-enforcement-litigation-delta-feed`. That legacy
 * repository is README-ONLY (no `src/`; its parsers are proprietary), so this
 * connector implements ONLY what is either documented precisely in its README
 * or verified live in this session. Nothing is reconstructed from memory.
 *
 * LIVE SOURCE VERIFICATION (2026-10-21, plain GET, descriptive User-Agent with a
 * contact string as SEC's fair-access policy requires, no proxy tricks):
 *   - https://www.sec.gov/enforcement-litigation/litigation-releases/rss
 *       HTTP/2 200, content-type application/rss+xml; charset=utf-8, 25 <item>s.
 *   - https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss
 *       HTTP/2 200, content-type application/rss+xml; charset=utf-8, 25 <item>s.
 *   Item shape (identical in both feeds), copied from the live capture:
 *       <title>   the RESPONDENT NAME(S), e.g. "Terrance P. Berland and David Michael Scalzo".
 *                 It is NOT a press headline. It may carry a trailing newline.
 *       <link>    litigation releases -> https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26675
 *                 administrative proceedings -> a PDF, https://www.sec.gov/files/litigation/admin/2026/ia-7027.pdf
 *                 The element text ends with a newline, so it must be trimmed.
 *       <description> repeats <title> (occasionally without the trailing newline).
 *       <pubDate> RFC 822, e.g. "Tue, 20 Oct 2026 14:55:51 -0400".
 *       <dc:creator> the SEC release number, e.g. "LR-26675", "IA-7027", "34-106674", "33-11450".
 *       <guid isPermaLink="false"> an opaque UUID.
 *   Titles seen live include ';'-separated lists, "A and B", "A, B, and C", "a/k/a" and
 *   "f/k/a" aliases, "(Deceased)" and "(Dba ...)" parentheticals, "et al.", and
 *   comma-suffixed entities ("Silver Star Properties REIT, Inc.", "Carlos Lopez, CPA").
 *   The litigation-release HTML page was also probed (HTTP 200) but is NOT parsed here.
 *   SEC does not paginate either feed: it is a ~25-item recent window, so this is a
 *   recency monitor, not a historical backfill (the legacy README says the same).
 *
 * WHAT IS DELIBERATELY NOT PORTED (the legacy parsers are not available and their
 * outputs cannot be reproduced honestly from the feed alone):
 *   page headline `title`, `summary_text`, `statutes_or_rules_cited`, `monetary_sanctions`,
 *   `sanction_status`, `court_or_forum`, `docket_or_case_number`, and the EDGAR CIK
 *   linking fields (`linked_edgar_cik`, `cik_match_*`, `edgar_*`). Those require
 *   parsing release HTML / order PDFs and an EDGAR name search; none of that was
 *   verified. They are omitted rather than emitted empty so a consumer never mistakes
 *   "not extracted" for "extracted and absent".
 *
 * WATCHLIST / GHOST-BILLING NOTE
 *   The legacy actor matched `watchlistNames` as a raw case-insensitive substring, so
 *   an empty, blank or one-character entry matched every respondent and every record
 *   was billed as a watchlist hit. In the Master Engine the match and the charge are
 *   owned by router_core (`findKeywordMatch` over `watchText`, billed through
 *   `WatchlistHitBiller`). This connector only supplies `watchText`: the cleaned
 *   respondent text. A legacy-style `watchlistNames` placed under
 *   `sourceOptions.sec_enforcement` is read ONLY through sanitizeKeywordList(), logged,
 *   and otherwise ignored - it can neither match nor bill.
 */
import { load } from 'cheerio';
import { z } from 'zod';

import { describeSanitization, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const SEC_SOURCE_ID = 'sec_enforcement';

export const SEC_FEED_KEYS = ['litigation_releases', 'administrative_proceedings'] as const;
export type SecFeedKey = (typeof SEC_FEED_KEYS)[number];

export const SEC_FEEDS: Record<SecFeedKey, { url: string; releaseType: 'litigation_release' | 'administrative_proceeding' }> = {
    litigation_releases: {
        url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss',
        releaseType: 'litigation_release',
    },
    administrative_proceedings: {
        url: 'https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss',
        releaseType: 'administrative_proceeding',
    },
};

/** Legacy default User-Agent (README input table). Callers should supply their own organisation + contact. */
export const SEC_DEFAULT_USER_AGENT = 'DeltaRegistrySECMonitor/1.0 (+https://apify.com/stefano_seggio/sec-enforcement-litigation-delta-feed)';

export const secEnforcementOptionsSchema = z.object({
    /** Which of the two official SEC feeds to poll (legacy input `sources`). */
    sources: z.array(z.enum(SEC_FEED_KEYS)).min(1).max(SEC_FEED_KEYS.length).default([...SEC_FEED_KEYS]),
    /**
     * Descriptive User-Agent identifying the caller to SEC (fair-access policy). Printable ASCII only:
     * it becomes an HTTP header value, so control characters and CR/LF are rejected outright.
     */
    userAgent: z
        .string()
        .trim()
        .min(8, 'userAgent must identify your organisation (min 8 characters)')
        .max(200)
        .regex(/^[\x20-\x7e]+$/, 'userAgent must be printable ASCII (no control characters or newlines)')
        .default(SEC_DEFAULT_USER_AGENT),
    /**
     * Legacy-compat only. Deliberately `unknown` (the ghost-billing bug lived in trusting this field's type).
     * It is read through sanitizeKeywordList() and NEVER used to match or bill; the engine-level
     * `watchlistNames` is the only watchlist the router honours.
     */
    watchlistNames: z.unknown().optional(),
});
export type SecEnforcementOptions = z.output<typeof secEnforcementOptionsSchema>;

export interface SecFeedItem {
    releaseType: 'litigation_release' | 'administrative_proceeding';
    releaseNumber: string;
    /** Verbatim, whitespace-collapsed RSS title (the respondent text SEC publishes). */
    feedTitle: string;
    /** https://www.sec.gov/... URL, or null when the feed's link was not an SEC https URL. */
    sourceUrl: string | null;
    /** Calendar date exactly as written in the feed's own UTC offset (SEC publishes in US Eastern time). */
    releaseDate: string | null;
    /** The same instant as an ISO-8601 UTC timestamp. */
    publishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** RFC 822 zone names (RSS 2.0 allows them); numeric offsets are handled separately. */
const ZONE_OFFSET_MINUTES: Record<string, number> = {
    gmt: 0,
    ut: 0,
    utc: 0,
    z: 0,
    est: -300,
    edt: -240,
    cst: -360,
    cdt: -300,
    mst: -420,
    mdt: -360,
    pst: -480,
    pdt: -420,
};

const RFC822 = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,3})?$/u;

/**
 * Parses an RSS `pubDate`. Returns the calendar date as written (in the feed's own offset) plus the UTC
 * instant. Returns `null` for anything that is not a valid RFC 822 date (never throws, never guesses).
 */
export function parseRfc822Date(value: string | null | undefined): { releaseDate: string; publishedAt: string } | null {
    if (!value) return null;
    const m = RFC822.exec(value.trim());
    if (!m) return null;
    const day = Number(m[1]);
    const month = MONTHS[(m[2] ?? '').toLowerCase()];
    const year = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] === undefined ? 0 : Number(m[6]);
    if (month === undefined || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    const zone = m[7];
    let offsetMinutes = 0;
    if (zone !== undefined) {
        if (/^[+-]\d{4}$/u.test(zone)) {
            const sign = zone.startsWith('-') ? -1 : 1;
            offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
        } else {
            const known = ZONE_OFFSET_MINUTES[zone.toLowerCase()];
            if (known === undefined) return null;
            offsetMinutes = known;
        }
    }

    const local = new Date(Date.UTC(year, month, day, hour, minute, second));
    // Reject roll-overs such as "31 Feb": the components must survive a round trip.
    if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day) return null;

    const releaseDate = local.toISOString().slice(0, 10);
    const publishedAt = new Date(local.getTime() - offsetMinutes * 60_000).toISOString();
    return { releaseDate, publishedAt };
}

// ---------------------------------------------------------------------------
// Respondent parsing (best effort; the full cleaned title is what the watchlist sees)
// ---------------------------------------------------------------------------

/** Fragments that are a legal-form / honorific suffix and must stay attached to the preceding name. */
const NAME_SUFFIX = /^(?:inc|incorporated|llc|l\.l\.c|ltd|limited|lp|l\.p|llp|l\.l\.p|plc|corp|corporation|co|company|na|n\.a|sa|s\.a|ag|gmbh|jr|sr|ii|iii|iv|v|cpa|esq|md|phd|dba)\.?$/iu;

const WHITESPACE = /\s+/gu;

/** Collapses internal whitespace and trims; the SEC feed carries stray trailing newlines. */
export function cleanFeedText(value: string | null | undefined): string {
    return (value ?? '').replace(WHITESPACE, ' ').trim();
}

/** Masks parenthesised segments so "(Dba the Putney Financial Group and Registered Investment Advisors)" is never split. */
function maskParentheses(text: string): { masked: string; restore: (s: string) => string } {
    const segments: string[] = [];
    let depth = 0;
    let out = '';
    let current = '';
    for (const ch of text) {
        if (ch === '(') {
            if (depth === 0) current = '';
            depth += 1;
            current += ch;
            continue;
        }
        if (ch === ')' && depth > 0) {
            current += ch;
            depth -= 1;
            if (depth === 0) {
                out += `\u0001${segments.length}\u0002`;
                segments.push(current);
                current = '';
            }
            continue;
        }
        if (depth > 0) current += ch;
        else out += ch;
    }
    // An unbalanced "(" is kept verbatim rather than swallowed.
    if (depth > 0) out += current;
    return {
        masked: out,
        restore: (s: string) => s.replace(/\u0001(\d+)\u0002/gu, (_, index: string) => segments[Number(index)] ?? ''),
    };
}

/**
 * Best-effort split of an SEC respondent title into individual names.
 *
 *   "A; B; and C"                       -> ["A", "B", "C"]
 *   "A and B"                           -> ["A", "B"]
 *   "A, B, and C"                       -> ["A", "B", "C"]
 *   "Silver Star Properties REIT, Inc." -> ["Silver Star Properties REIT, Inc."]
 *   "Carlos Lopez, CPA"                 -> ["Carlos Lopez, CPA"]
 *   "X, as Administrator of the Estate of Y (Deceased)" -> one name
 *   "David Reichman et al."             -> ["David Reichman"]
 *
 * Splitting company names that themselves contain " and " ("Johnson and Johnson") is the known limit of any
 * title-based split; that is why the watchlist is matched against the whole cleaned title, not this list.
 */
export function splitRespondents(title: string): string[] {
    const cleaned = cleanFeedText(title).replace(/\s+et\s+al\.?$/iu, '');
    if (cleaned === '') return [];
    const { masked, restore } = maskParentheses(cleaned);

    let parts: string[];
    if (masked.includes(';')) {
        parts = masked.split(';');
    } else {
        parts = [];
        for (const chunk of masked.split(/\s+and\s+/iu)) {
            chunk.split(/\s*,\s*/u).forEach((fragment, index) => {
                const bare = fragment.replace(/^and\s+/iu, '').trim();
                if (bare === '') return;
                // A legal-form/honorific suffix ("Inc.", "LLC", "CPA", "III") or a capacity ("as Administrator of ...")
                // stays attached to the name before it - but only within the same " and " chunk (index > 0).
                const attaches = index > 0 && (NAME_SUFFIX.test(bare) || /^as\s/iu.test(bare));
                const previous = parts[parts.length - 1];
                if (attaches && previous !== undefined) parts[parts.length - 1] = `${previous}, ${bare}`;
                else parts.push(bare);
            });
        }
    }

    const seen = new Set<string>();
    const names: string[] = [];
    for (const part of parts) {
        const name = restore(part.replace(/^and\s+/iu, '').trim());
        const key = name.toLowerCase();
        if (name === '' || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

// ---------------------------------------------------------------------------
// RSS parsing
// ---------------------------------------------------------------------------

/** `https://www.sec.gov/...` only; anything else (or unparsable) becomes null so no off-site URL is ever emitted. */
function normaliseSecUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== 'https:') return null;
        if (url.hostname !== 'www.sec.gov' && url.hostname !== 'sec.gov') return null;
        return url.toString();
    } catch {
        return null;
    }
}

/** Fallback when `dc:creator` is absent: derive the release number from the link, using only patterns seen live. */
function releaseNumberFromLink(link: string | null, releaseType: SecFeedItem['releaseType']): string | null {
    if (!link) return null;
    if (releaseType === 'litigation_release') {
        const m = /\/litigation-releases\/(lr-\d+)\/?$/iu.exec(link);
        return m?.[1] ? m[1].toUpperCase() : null;
    }
    const m = /\/files\/litigation\/admin\/\d{4}\/([a-z0-9-]+)\.pdf$/iu.exec(link);
    return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * Parses one SEC RSS document. Throws when the body is not an RSS document at all (for example an HTML
 * block page); an RSS document with zero items is a legitimate empty result.
 */
export function parseSecRss(xml: string, feed: SecFeedKey): SecFeedItem[] {
    const releaseType = SEC_FEEDS[feed].releaseType;
    if (!/<rss[\s>]/iu.test(xml) || !/<channel[\s>]/iu.test(xml)) {
        throw new Error(`response is not an RSS document (${xml.length} bytes, starts with ${JSON.stringify(xml.slice(0, 60))})`);
    }
    const $ = load(xml, { xml: true });
    const items: SecFeedItem[] = [];
    $('item').each((_index, element) => {
        const node = $(element);
        const feedTitle = cleanFeedText(node.find('title').first().text() || node.find('description').first().text());
        const sourceUrl = normaliseSecUrl(node.find('link').first().text());
        const creator = cleanFeedText(node.find('dc\\:creator').first().text());
        const releaseNumber = creator !== '' ? creator : releaseNumberFromLink(sourceUrl, releaseType);
        // No release number means no stable identity: such an item cannot be delta-tracked, so it is skipped.
        if (!releaseNumber || feedTitle === '') return;
        const date = parseRfc822Date(node.find('pubDate').first().text());
        items.push({
            releaseType,
            releaseNumber,
            feedTitle,
            sourceUrl,
            releaseDate: date?.releaseDate ?? null,
            publishedAt: date?.publishedAt ?? null,
        });
    });
    return items;
}

/** Turns a parsed feed item into the engine record. Pure; exported for tests. */
export function toSecRecord(item: SecFeedItem): SourceRecord {
    const respondents = splitRespondents(item.feedTitle);
    const primaryRespondent = respondents[0] ?? item.feedTitle;
    return {
        recordId: item.releaseNumber,
        fingerprint: fingerprintOf([item.releaseType, item.releaseNumber, item.feedTitle, item.publishedAt, item.sourceUrl]),
        payload: {
            source_url: item.sourceUrl,
            release_type: item.releaseType,
            release_number: item.releaseNumber,
            release_date: item.releaseDate,
            published_at: item.publishedAt,
            /** Verbatim RSS title: the respondent text, not a press headline (see header comment). */
            feed_title: item.feedTitle,
            respondents,
            primary_respondent: primaryRespondent,
        },
        // The whole cleaned title, so aliases ("a/k/a ...") and every co-respondent are searchable.
        watchText: item.feedTitle,
    };
}

function compareNewestFirst(a: SecFeedItem, b: SecFeedItem): number {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY;
    if (at !== bt) return bt - at;
    return b.releaseNumber.localeCompare(a.releaseNumber);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const secEnforcementConnector: Connector<SecEnforcementOptions> = {
    id: SEC_SOURCE_ID,
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'sec-enforcement-litigation-delta-feed',
    description:
        "SEC litigation releases and administrative proceedings from SEC.gov's own RSS feeds (25-item recency window each): release number, date, link and parsed respondent(s). " +
        'Statute/sanction extraction and EDGAR CIK linking of the legacy actor are not ported (see connector header).',
    status: 'active',
    optionsSchema: secEnforcementOptionsSchema,

    async fetch(ctx: ConnectorContext, options: SecEnforcementOptions, run: RunParams): Promise<SourceRecord[]> {
        if (options.watchlistNames !== undefined) {
            const legacy = sanitizeKeywordList(options.watchlistNames);
            ctx.log.warning(
                `[${SEC_SOURCE_ID}] sourceOptions.watchlistNames is ignored by this connector (${describeSanitization(legacy, 'sourceOptions.watchlistNames')}) ` +
                    'Use the engine-level watchlistNames; matching and billing are owned by the router.',
            );
        }

        const collected: SecFeedItem[] = [];
        const failures: string[] = [];
        for (const key of options.sources) {
            const feed = SEC_FEEDS[key];
            try {
                const xml = await ctx.http.getText(feed.url, {
                    headers: { 'user-agent': options.userAgent, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
                    timeoutMs: 30_000,
                });
                const items = parseSecRss(xml, key);
                ctx.log.info(`[${SEC_SOURCE_ID}] ${key}: ${items.length} item(s) in feed.`);
                collected.push(...items);
            } catch (error) {
                const message = `${key}: ${messageOf(error)}`;
                failures.push(message);
                ctx.log.warning(`[${SEC_SOURCE_ID}] feed failed - ${message}`);
            }
        }

        if (failures.length === options.sources.length) {
            throw new SourceFetchError(`All selected SEC feeds failed: ${failures.join(' | ')}`, SEC_SOURCE_ID);
        }

        // Feeds are tiny and unpaginated, so both are always read; the cap is applied newest-first across them.
        collected.sort(compareNewestFirst);
        return collected.slice(0, run.maxItemsPerSource).map(toSecRecord);
    },
};
