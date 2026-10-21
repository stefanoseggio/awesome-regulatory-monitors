/**
 * _guards.ts - input guards that stand between caller-supplied strings and
 * anything that can bill, match or throw.
 *
 * ROOT CAUSE THIS FILE REMEDIATES ("ghost billing", zero-match inversion)
 * ----------------------------------------------------------------------
 * The legacy `sec-enforcement-litigation-delta-feed` documents `watchlistNames`
 * as "case-insensitive substrings matched against parsed respondents; a hit
 * sets is_watchlist_match: true". A substring test against an EMPTY needle is
 * vacuously true in every language: `"anything".includes("")` and
 * `"anything".toLowerCase().indexOf("") === 0`. So any of these inputs turned
 * a *no-watchlist* run into an *everything-matches* run:
 *
 *   watchlistNames: [""]            // empty string element
 *   watchlistNames: [" "]           // whitespace-only element (blank after trim)
 *   watchlistNames: ""              // a bare empty STRING where an array is expected
 *   watchlistNames: "a"             // a bare string iterated char-by-char by Array.from
 *   watchlistNames: ["a"]           // single-letter needle matches most respondents
 *
 * Every record then carried `is_watchlist_match: true`, and every such record
 * was billed as a `watchlist-hit` event. The caller paid per record for a
 * watchlist that did not exist. `clinicaltrials-orange-book-delta` shares the
 * same pattern for its keyword list.
 *
 * The remediation is deliberately layered so that no single bug can re-open it:
 *   1. {@link sanitizeKeywordList}  - normalises ANY input shape into a clean list.
 *   2. {@link findKeywordMatch}     - structurally cannot match on an empty list.
 *   3. router_core / charging.ts    - only bills when (1) produced >= 1 keyword
 *                                     AND (2) returned a concrete match.
 *
 * VALIDATION CRITERIA (applied per keyword, in this order)
 * --------------------------------------------------------
 *   - must be a string                       (numbers/objects/null are rejected, never coerced)
 *   - Unicode NFKC normalised, then every run of whitespace collapsed to one
 *     space and the ends stripped              (so "  Acme   Corp " === "Acme Corp")
 *   - control / zero-width / bidi characters removed before measuring length
 *     (so a keyword made only of U+200B cannot pass as "length 2")
 *   - length >= {@link MIN_KEYWORD_LENGTH} (2) *after* normalisation
 *   - length <= {@link MAX_KEYWORD_LENGTH} (200)
 *   - contains at least one letter or digit  (so "--", "..", "()" cannot match everything
 *                                             punctuated)
 *   - de-duplicated case-insensitively; the first spelling wins
 *   - at most {@link MAX_KEYWORDS} (500) accepted; the rest are rejected as `over_limit`
 */

export const MIN_KEYWORD_LENGTH = 2;
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_KEYWORDS = 500;

export type KeywordRejectionReason =
    | 'not_a_string'
    | 'empty_after_normalisation'
    | 'too_short'
    | 'too_long'
    | 'no_letter_or_digit'
    | 'duplicate'
    | 'over_limit';

export interface RejectedKeyword {
    /** The original value (stringified and truncated for logging; never used for matching). */
    value: string;
    reason: KeywordRejectionReason;
}

export interface SanitizedKeywordList {
    /** Clean keywords, original casing preserved, safe to match with {@link findKeywordMatch}. */
    keywords: string[];
    /** Lower-cased, matching-ready twin of `keywords` (same order). */
    needles: string[];
    rejected: RejectedKeyword[];
    /** True when the caller supplied a non-array, non-string value (e.g. an object or number). */
    malformedContainer: boolean;
}

const WHITESPACE_RUN = /\s+/gu;
/** C0/C1 controls, zero-width space/joiners, BOM, bidi embeddings/isolates, soft hyphen. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿]/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Truncates a value for safe inclusion in a log line. */
function preview(value: unknown): string {
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
        text = Object.prototype.toString.call(value);
    }
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** NFKC + invisible-character removal + whitespace collapse + trim. Pure; exported for tests. */
export function normaliseKeyword(raw: string): string {
    return raw.normalize('NFKC').replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Turns whatever the caller sent for a watchlist / keyword field into a clean list.
 *
 * Accepts:
 *   - `string[]` (the documented shape)
 *   - a single `string`, split on newlines, commas and semicolons (a legitimate
 *     Apify UI paste) - NEVER iterated per character
 *   - `undefined` / `null` -> empty result, not an error
 * Anything else yields an empty list with `malformedContainer: true`.
 *
 * This function never throws and never returns an element that could match the
 * empty string.
 */
export function sanitizeKeywordList(input: unknown): SanitizedKeywordList {
    const result: SanitizedKeywordList = { keywords: [], needles: [], rejected: [], malformedContainer: false };

    if (input === undefined || input === null) return result;

    let candidates: unknown[];
    if (Array.isArray(input)) {
        candidates = input;
    } else if (typeof input === 'string') {
        // A bare string is split on separators. An empty/blank string yields one blank
        // candidate that is then rejected, which is exactly the point.
        candidates = input.split(/[\n\r,;]+/u);
    } else {
        result.malformedContainer = true;
        return result;
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
            result.rejected.push({ value: preview(candidate), reason: 'not_a_string' });
            continue;
        }
        const cleaned = normaliseKeyword(candidate);
        if (cleaned.length === 0) {
            result.rejected.push({ value: preview(candidate), reason: 'empty_after_normalisation' });
            continue;
        }
        if (cleaned.length < MIN_KEYWORD_LENGTH) {
            result.rejected.push({ value: preview(candidate), reason: 'too_short' });
            continue;
        }
        if (cleaned.length > MAX_KEYWORD_LENGTH) {
            result.rejected.push({ value: preview(candidate), reason: 'too_long' });
            continue;
        }
        if (!HAS_LETTER_OR_DIGIT.test(cleaned)) {
            result.rejected.push({ value: preview(candidate), reason: 'no_letter_or_digit' });
            continue;
        }
        const needle = cleaned.toLowerCase();
        if (seen.has(needle)) {
            result.rejected.push({ value: preview(candidate), reason: 'duplicate' });
            continue;
        }
        if (result.keywords.length >= MAX_KEYWORDS) {
            result.rejected.push({ value: preview(candidate), reason: 'over_limit' });
            continue;
        }
        seen.add(needle);
        result.keywords.push(cleaned);
        result.needles.push(needle);
    }
    return result;
}

/**
 * Returns the first accepted keyword found in `haystack` (case-insensitive,
 * NFKC-normalised substring match), or `null`.
 *
 * Structural guarantees:
 *   - an empty `list.needles` returns `null` immediately - there is no code path
 *     on which an empty list matches;
 *   - an empty / non-string haystack returns `null`;
 *   - the loop re-checks `needle.length >= MIN_KEYWORD_LENGTH` so a hand-built
 *     {@link SanitizedKeywordList} that bypassed {@link sanitizeKeywordList}
 *     (for example in a test or a future caller) still cannot match on "".
 */
export function findKeywordMatch(haystack: unknown, list: SanitizedKeywordList): string | null {
    if (list.needles.length === 0) return null;
    if (typeof haystack !== 'string' || haystack.length === 0) return null;

    const text = normaliseKeyword(haystack).toLowerCase();
    if (text.length === 0) return null;

    for (let i = 0; i < list.needles.length; i += 1) {
        const needle = list.needles[i];
        if (needle === undefined || needle.length < MIN_KEYWORD_LENGTH) continue;
        if (text.includes(needle)) return list.keywords[i] ?? needle;
    }
    return null;
}

/** Convenience boolean form of {@link findKeywordMatch}. */
export function matchesAnyKeyword(haystack: unknown, list: SanitizedKeywordList): boolean {
    return findKeywordMatch(haystack, list) !== null;
}

/** One-line, log-safe description of what the guard did to the caller's list. */
export function describeSanitization(list: SanitizedKeywordList, fieldName = 'watchlistNames'): string {
    if (list.malformedContainer) {
        return `${fieldName}: unsupported value type; watchlist disabled (0 keywords).`;
    }
    if (list.rejected.length === 0) {
        return `${fieldName}: ${list.keywords.length} keyword(s) accepted.`;
    }
    const byReason = new Map<KeywordRejectionReason, number>();
    for (const r of list.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    const detail = [...byReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ');
    return `${fieldName}: ${list.keywords.length} accepted, ${list.rejected.length} rejected (${detail}).`;
}

/** Guards for numeric run knobs so a hostile or mistyped limit cannot unbound a billable loop. */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
