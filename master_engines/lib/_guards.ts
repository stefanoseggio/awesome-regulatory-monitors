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
 *   - at most {@link MAX_RAW_KEYWORD_UNITS} (4,096) UTF-16 units BEFORE any Unicode work
 *     (String.prototype.normalize is quadratic on adversarial combining marks: 80,000 units take
 *     seconds, and the 200 code point cap below is only meaningful after normalisation)
 *   - well-formed Unicode: a lone surrogate is rejected as `invalid_unicode` (it would match half
 *     of an astral character, so a hit could be billed for text that does not contain the keyword)
 *   - no run of more than {@link MAX_COMBINING_RUN} (16) consecutive combining marks: NFKC reorders marks by combining
 *     class, which is quadratic in the length of a run (a 4,090-mark run costs 16 ms, so a list of 5,000 of them
 *     would cost 82 s). Real text never has such a run (Vietnamese stacks 3, Hebrew with cantillation 4, Tibetan
 *     about 10). A keyword with one is rejected; a haystack has the run cut to 16 marks.
 *   - NFKC must not expand a text by more than 4x (plus 16 units): the Arabic ligature U+FDFA becomes 18 characters, and
 *     a text made of it costs 12 ms per 4,096 units to clean. Such a text counts as empty.
 *   - cleaned to a FIXED POINT of: NFKC, whitespace controls to a space, removal of every
 *     Default_Ignorable_Code_Point and Bidi_Control character plus the C0/C1 controls (zero-width
 *     characters, soft hyphen, bidi marks, variation selectors, Hangul fillers, tag characters...),
 *     whitespace runs collapsed to one space, ends stripped. Repeating the pass is required: removal
 *     can expose a composable sequence, so one pass is not idempotent. A text that has not settled
 *     after {@link MAX_NORMALISE_PASSES} passes is treated as empty (hostile), never matched.
 *   - length >= {@link MIN_KEYWORD_LENGTH} (2) *after* cleaning, so a keyword made only of U+200B,
 *     or a letter plus an invisible character, cannot pass as "length 2"
 *   - length <= {@link MAX_KEYWORD_LENGTH} (200)
 *   - contains at least TWO letters or digits (so "--", "..", "()", "c.", "a |", "-0" cannot match everything
 *                                             punctuated: one alphanumeric character padded with punctuation is the
 *                                             one-letter needle of the original bug in disguise; "BP", "GE", "3M" pass)
 *   - at least 2 visible code points BEFORE normalisation (one glyph that NFKC expands, such as the circled
 *     number twenty or the numero sign, is a single character, not a two-character keyword)
 *   - de-duplicated case-insensitively; the first spelling wins
 *   - at most {@link MAX_KEYWORDS} (500) accepted; the rest are rejected as `over_limit`
 *   - at most {@link MAX_CANDIDATES} (5,000) entries are inspected, and the string entries of at most
 *     {@link MAX_RAW_KEYWORD_UNITS} units that are inspected add up to at most
 *     {@link MAX_TOTAL_RAW_UNITS} (200,000) UTF-16 units (longer entries are rejected at once and cost nothing); the remainder is not read and is reported as ONE
 *     `over_limit` entry (a 9 MB list of 2-character entries, or 5,000 entries of 4,096 units, cannot burn CPU or
 *     memory: the per-entry, per-list and per-haystack caps alone do not bound their product)
 *
 * A bare string is split on the ASCII line feed, carriage return, comma and semicolon only; their
 * fullwidth look-alikes are not separators. If it is longer than {@link MAX_BARE_STRING_UNITS} it is cut there and the
 * last piece, which the cut may have truncated ("Pfizer Inc" -> "Pfizer In"), is dropped and reported.
 *
 * A haystack longer than {@link MAX_HAYSTACK_UNITS} is searched only up to the last whitespace character inside that
 * window: nothing composes across whitespace, so the searched text is exactly a prefix of what the whole text cleans
 * to (a cut in the middle of a word could drop a combining accent and create a hit the full text would not give).
 *
 * `sanitizeKeywordList`, `findKeywordMatch`, `matchesAnyKeyword` and `describeSanitization` never throw, even for a revoked
 * or hostile Proxy or a malformed list; `findKeywordMatch` re-checks every needle (a string with at least 2 code points
 * and 2 letters or digits) and reads at most {@link MAX_KEYWORDS} of them, so a hand-built list cannot match "..".
 * `rejected[].value` is a bounded, log-safe preview: a string is cut at 57 units and control, invisible and lone
 * surrogate characters are replaced by U+FFFD; a non-string is a constant tag such as "[object]" (never serialised).
 *
 * Containers: undefined and null give an empty result; an array is read; a string is split; anything else (a number,
 * boolean, Set, Map, typed array, String object...) is `malformedContainer: true` with no keywords.
 *
 * A haystack with a run of more than {@link MAX_COMBINING_RUN} combining marks is searched with that run cut to
 * {@link MAX_COMBINING_RUN} marks (one hostile field must not hide a whole record), while a KEYWORD with such a run
 * is rejected.
 */

export const MIN_KEYWORD_LENGTH = 2;
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_KEYWORDS = 500;
/** A raw keyword longer than this (UTF-16 units) is rejected before normalisation, whose cost is quadratic in the worst case. */
export const MAX_RAW_KEYWORD_UNITS = 4096;
/** Entries inspected per list; the rest are not read. */
export const MAX_CANDIDATES = 5000;
/** A bare-string watchlist is cut here before it is split (about 20 average entries per accepted keyword slot). */
export const MAX_BARE_STRING_UNITS = 200_000;
/** The string entries of one list may add up to this many UTF-16 units; later entries are not inspected. */
export const MAX_TOTAL_RAW_UNITS = 200_000;
/** Haystacks (record text) are cut to this many UTF-16 units before normalisation. Names and titles are far shorter. */
export const MAX_HAYSTACK_UNITS = 8192;
/** Cleaning passes before a text is declared unstable (hostile). Real text settles in at most 3. */
export const MAX_NORMALISE_PASSES = 8;
/** Longest run of consecutive combining marks a text may contain (see COMBINING_RUN_TOO_LONG). */
export const MAX_COMBINING_RUN = 16;

export type KeywordRejectionReason =
    | 'not_a_string'
    | 'empty_after_normalisation'
    | 'too_short'
    | 'too_long'
    | 'invalid_unicode'
    | 'no_letter_or_digit'
    | 'single_letter_or_digit'
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
/** Line breaks, tabs and the other whitespace controls that INVISIBLE would otherwise delete and fuse words across. */
const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
/**
 * Everything that renders as nothing: the C0/C1 controls, every Unicode Default_Ignorable_Code_Point (soft hyphen,
 * combining grapheme joiner, Arabic letter mark, Hangul fillers, Mongolian and variation selectors, zero-width
 * characters, bidi marks and isolates, invisible operators, BOM, interlinear annotation, tag characters, ...) and
 * every Bidi_Control character. Property escapes, not a hand-typed list: a hand-typed list missed 4,146 code points.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/gu;
const LONE_SURROGATE = /\p{Surrogate}/u;
/** Non-global twins of INVISIBLE and of White_Space, for testing single code points. */
const INVISIBLE_ONE = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
const WHITE_SPACE_ONE = /\p{White_Space}/u;
/** What a log line must not carry: controls, invisible characters and lone surrogates. */
const PREVIEW_UNSAFE = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\p{Surrogate}]/gu;
/** Marks beyond the {@link MAX_COMBINING_RUN}th of a run (MAX_COMBINING_RUN, written out so the ReDoS gate analyses it). */
const MARK_RUN_EXCESS = /(\p{M}{16})\p{M}+/gu;
/** MAX_COMBINING_RUN + 1 consecutive combining marks. A literal (not built from the constant) so the ReDoS gate analyses it. */
const COMBINING_RUN_TOO_LONG = /\p{M}{17}/u;
const WHITE_SPACE_UNIT = /\p{White_Space}/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const BARE_STRING_SEPARATORS = /[\n\r,;]+/u;

function codePointLength(text: string): number {
    let n = 0;
    for (const _ of text) n += 1;
    return n;
}

/** Letters and digits in `text`, counted up to `atLeast` (then it stops). */
function countLettersOrDigits(text: string, atLeast: number): number {
    let n = 0;
    for (const ch of text) {
        if (HAS_LETTER_OR_DIGIT.test(ch)) {
            n += 1;
            if (n >= atLeast) return n;
        }
    }
    return n;
}

/** Code points of `text` that are neither invisible nor whitespace, counted up to `atLeast`: the glyphs a reader sees. */
function countVisible(text: string, atLeast: number): number {
    let n = 0;
    for (const ch of text) {
        if (INVISIBLE_ONE.test(ch) || WHITE_SPACE_ONE.test(ch)) continue;
        n += 1;
        if (n >= atLeast) return n;
    }
    return n;
}

/**
 * A bounded, log-safe description of a rejected value. Never throws and never serialises: a string is cut at 57 units
 * (never inside a surrogate pair) and its control, invisible and lone surrogate characters become U+FFFD; anything else
 * is a constant tag (JSON.stringify of a deeply nested value costs about 7 ms per entry, 9 s for a 9 MB input).
 */
function preview(value: unknown): string {
    try {
        if (typeof value === 'string') return (value.length > 60 ? `${cutUnits(value, 57)}...` : value).replace(PREVIEW_UNSAFE, '\ufffd');
        if (value === null) return '[null]';
        if (Array.isArray(value)) return '[array]';
        return `[${typeof value}]`;
    } catch {
        return '[unreadable value]';
    }
}

function cleanOnce(input: string, hostileRuns: 'reject' | 'cut'): string {
    let text = input;
    // Before normalize: reordering a long run of marks is quadratic, and no real text contains one. A keyword with one is
    // empty; a haystack keeps the first MAX_COMBINING_RUN marks of the run, so one hostile field cannot hide a record.
    if (COMBINING_RUN_TOO_LONG.test(text)) {
        if (hostileRuns === 'reject') return '';
        text = text.replace(MARK_RUN_EXCESS, '$1');
    }
    const normalised = text.normalize('NFKC');
    // No real text grows 4x under NFKC; one that does (U+FDFA becomes 18 characters) is made to burn the passes below.
    if (normalised.length > text.length * 4 + 16) return '';
    return normalised.replace(WHITESPACE_CONTROLS, ' ').replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * NFKC + whitespace-control mapping + invisible-character removal + whitespace collapse + trim, repeated until the
 * text no longer changes, so `normaliseKeyword(normaliseKeyword(x)) === normaliseKeyword(x)` for every input.
 * Returns '' for a text that does not settle within {@link MAX_NORMALISE_PASSES} passes (never matched, never billed).
 * The caller bounds the length first ({@link MAX_RAW_KEYWORD_UNITS}, {@link MAX_HAYSTACK_UNITS}): normalisation is
 * quadratic in the worst case. `hostileRuns` says what a run of more than {@link MAX_COMBINING_RUN} combining marks
 * does: `reject` (the default, for keywords) makes the whole text empty, `cut` (for haystacks) keeps the first
 * {@link MAX_COMBINING_RUN} marks of the run. Pure; exported for tests.
 */
export function normaliseKeyword(raw: string, hostileRuns: 'reject' | 'cut' = 'reject'): string {
    let current = raw;
    for (let pass = 0; pass < MAX_NORMALISE_PASSES; pass += 1) {
        const next = cleanOnce(current, hostileRuns);
        if (next === current) return next;
        current = next;
    }
    return '';
}

/**
 * The part of a haystack that is searched: all of it up to {@link MAX_HAYSTACK_UNITS} units, otherwise the text up to
 * the last whitespace character inside that window (nothing composes across whitespace, so the result is exactly a
 * prefix of what the whole text would clean to). A window without any whitespace is not searched at all.
 */
function cutHaystack(haystack: string): string {
    if (haystack.length <= MAX_HAYSTACK_UNITS) return haystack;
    for (let end = MAX_HAYSTACK_UNITS; end > 0; end -= 1) {
        if (WHITE_SPACE_UNIT.test(haystack.charAt(end))) return haystack.slice(0, end);
    }
    return '';
}

/** `text` cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cutUnits(text: string, max: number): string {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
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
    try {
        return sanitizeUnchecked(input);
    } catch {
        // A hostile in-process value (a revoked Proxy, a getter that throws) must disable the watchlist, not the run.
        return { keywords: [], needles: [], rejected: [{ value: '[unreadable value]', reason: 'not_a_string' }], malformedContainer: true };
    }
}

function sanitizeUnchecked(input: unknown): SanitizedKeywordList {
    const result: SanitizedKeywordList = { keywords: [], needles: [], rejected: [], malformedContainer: false };

    if (input === undefined || input === null) return result;

    let candidates: unknown[];
    let bareStringCut = false;
    if (Array.isArray(input)) {
        candidates = input;
    } else if (typeof input === 'string') {
        // A bare string is split on separators. An empty/blank string yields one blank
        // candidate that is then rejected, which is exactly the point.
        const window = cutUnits(input, MAX_BARE_STRING_UNITS);
        candidates = window.split(BARE_STRING_SEPARATORS);
        if (window.length < input.length) {
            // The cut may have truncated the last piece ("Pfizer Inc" -> "Pfizer In"), which would be accepted as a
            // different keyword: drop it.
            candidates.pop();
            bareStringCut = true;
        }
    } else {
        result.malformedContainer = true;
        return result;
    }

    const seen = new Set<string>();
    const limit = Math.min(candidates.length, MAX_CANDIDATES);
    let inspected = 0;
    let totalRawUnits = 0;
    for (let index = 0; index < limit; index += 1) {
        const candidate = candidates[index];
        // Only entries that proceed to Unicode work cost budget: one over the raw cap is rejected in constant time below.
        if (typeof candidate === 'string' && candidate.length <= MAX_RAW_KEYWORD_UNITS) {
            totalRawUnits += candidate.length;
            if (totalRawUnits > MAX_TOTAL_RAW_UNITS) break;
        }
        inspected += 1;
        if (typeof candidate !== 'string') {
            result.rejected.push({ value: preview(candidate), reason: 'not_a_string' });
            continue;
        }
        // Bounded BEFORE any Unicode work: normalisation is quadratic on adversarial combining marks.
        if (candidate.length > MAX_RAW_KEYWORD_UNITS) {
            result.rejected.push({ value: preview(candidate), reason: 'too_long' });
            continue;
        }
        if (LONE_SURROGATE.test(candidate)) {
            result.rejected.push({ value: preview(candidate), reason: 'invalid_unicode' });
            continue;
        }
        const cleaned = normaliseKeyword(candidate);
        if (cleaned.length === 0) {
            result.rejected.push({ value: preview(candidate), reason: 'empty_after_normalisation' });
            continue;
        }
        // Length in code points, not UTF-16 units: one astral-plane letter is ONE character, not two.
        if (codePointLength(cleaned) < MIN_KEYWORD_LENGTH) {
            result.rejected.push({ value: preview(candidate), reason: 'too_short' });
            continue;
        }
        // One glyph that NFKC expands (a circled number, the numero sign, a ligature) is one character typed, not two.
        if (countVisible(candidate, MIN_KEYWORD_LENGTH) < MIN_KEYWORD_LENGTH) {
            result.rejected.push({ value: preview(candidate), reason: 'too_short' });
            continue;
        }
        const lettersOrDigits = countLettersOrDigits(cleaned, 2);
        if (lettersOrDigits === 0) {
            result.rejected.push({ value: preview(candidate), reason: 'no_letter_or_digit' });
            continue;
        }
        // One letter or digit padded with punctuation ("c.", "a |", "-0") matches almost everything: the one-letter needle in disguise.
        if (lettersOrDigits === 1) {
            result.rejected.push({ value: preview(candidate), reason: 'single_letter_or_digit' });
            continue;
        }
        if (codePointLength(cleaned) > MAX_KEYWORD_LENGTH) {
            result.rejected.push({ value: preview(candidate), reason: 'too_long' });
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
    if (candidates.length > inspected) {
        result.rejected.push({ value: `(${candidates.length - inspected} further entries not inspected)`, reason: 'over_limit' });
    }
    if (bareStringCut) {
        result.rejected.push({ value: `(bare string cut at ${MAX_BARE_STRING_UNITS} units; its last entry was dropped)`, reason: 'over_limit' });
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
 *   - only the first {@link MAX_HAYSTACK_UNITS} UTF-16 units of the haystack are searched (cut at whitespace).
 */
export function findKeywordMatch(haystack: unknown, list: SanitizedKeywordList): string | null {
    try {
        return findUnchecked(haystack, list);
    } catch {
        // A malformed or hostile list argument (undefined, a revoked Proxy...) matches nothing and bills nothing.
        return null;
    }
}

function findUnchecked(haystack: unknown, list: SanitizedKeywordList): string | null {
    if (list.needles.length === 0) return null;
    if (typeof haystack !== 'string' || haystack.length === 0) return null;

    // Cut before normalising (quadratic in the worst case); text beyond the cut is simply not searched.
    const text = normaliseKeyword(cutHaystack(haystack), 'cut').toLowerCase();
    if (text.length === 0) return null;

    const count = Math.min(list.needles.length, MAX_KEYWORDS);
    for (let i = 0; i < count; i += 1) {
        const needle = list.needles[i];
        // Defence in depth for a hand-built list that bypassed sanitizeKeywordList: the same floor as the sanitiser.
        if (typeof needle !== 'string' || codePointLength(needle) < MIN_KEYWORD_LENGTH || countLettersOrDigits(needle, 2) < 2) continue;
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
    try {
        return describeUnchecked(list, fieldName);
    } catch {
        return `${fieldName}: unreadable keyword list; watchlist disabled.`;
    }
}

function describeUnchecked(list: SanitizedKeywordList, fieldName: string): string {
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
