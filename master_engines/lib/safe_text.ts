/**
 * Linear-time text helpers used wherever a regular expression would be polynomial (or worse) on hostile upstream
 * text. Every function here is a single forward pass: no backtracking, no nested quantifiers.
 *
 * They exist because a static ReDoS analysis of the whole package (recheck, over every regex literal and constant
 * `RegExp(...)`) flagged patterns such as `<!--[\s\S]*?-->`, `^-+|-+$` and `\s*-\s*$`, which are quadratic when an
 * input is made of many repeated markers. Each replacement below is covered by an equivalence test against the
 * regular expression it replaces and by a timing test on adversarial input (test/review_redos.test.ts).
 */

/** `text.slice(0, max)`: a hard bound for inputs that are field-sized by contract (names, titles, dates, contacts). */
export function capLength(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) : text;
}

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch);

/**
 * Removes every `<!-- ... -->` comment in one pass. Same result as `html.replace(/<!--[\s\S]*?-->/g, '')`: a comment
 * runs from `<!--` to the first `-->` that follows it, and an unterminated `<!--` is left in place.
 */
export function stripHtmlComments(html: string): string {
    let out = '';
    let from = 0;
    for (;;) {
        const open = html.indexOf('<!--', from);
        if (open === -1) return out + html.slice(from);
        const close = html.indexOf('-->', open + 4);
        if (close === -1) return out + html.slice(from);
        out += html.slice(from, open);
        from = close + 3;
    }
}

/** Removes every leading and trailing `char` (a single character). Same result as `text.replace(/^-+|-+$/g, '')` for `'-'`. */
export function trimEdgeChar(text: string, char: string): string {
    let start = 0;
    let end = text.length;
    while (start < end && text[start] === char) start += 1;
    while (end > start && text[end - 1] === char) end -= 1;
    return text.slice(start, end);
}

/**
 * Removes ONE trailing dash together with the whitespace around it. Same result as `text.replace(/\s*-\s*$/, '')`:
 * only the last dash goes (`'abc --'` becomes `'abc -'`), and a string that does not end in `-` plus optional
 * whitespace is returned unchanged.
 */
export function stripTrailingDash(text: string): string {
    let end = text.length;
    while (end > 0 && isWhitespace(text[end - 1])) end -= 1;
    if (end === 0 || text[end - 1] !== '-') return text;
    end -= 1;
    while (end > 0 && isWhitespace(text[end - 1])) end -= 1;
    return text.slice(0, end);
}

/**
 * Splits an `application/x-www-form-urlencoded`-style URL for logging without a regular expression:
 * drops the fragment and masks the value of every query parameter whose NAME satisfies `isSecretName`.
 * Used as the fallback of `redactUrl` for strings `new URL()` cannot parse.
 */
export function redactQueryString(url: string, isSecretName: (name: string) => boolean): string {
    const noFragment = url.split('#', 1)[0] ?? url;
    const q = noFragment.indexOf('?');
    if (q === -1) return noFragment;
    const parts = noFragment
        .slice(q + 1)
        .split('&')
        .map((part) => {
            const eq = part.indexOf('=');
            if (eq === -1) return part;
            const name = part.slice(0, eq);
            return isSecretName(name) ? `${name}=***` : part;
        });
    return `${noFragment.slice(0, q)}?${parts.join('&')}`;
}

export interface PemBlock {
    /** The text between the BEGIN and END lines. */
    body: string;
    /** Index of the first character after the END line. */
    end: number;
}

/**
 * Finds `-----BEGIN <label>-----` ... `-----END <label>-----` blocks in one pass (`indexOf`, no regex).
 * Equivalent to iterating `/-----BEGIN L-----([\s\S]*?)-----END L-----/g`: a block runs from a BEGIN marker to the
 * first END marker after it, and a BEGIN with no END after it ends the scan.
 */
export function findPemBlocks(text: string, label: string): PemBlock[] {
    const begin = `-----BEGIN ${label}-----`;
    const end = `-----END ${label}-----`;
    const blocks: PemBlock[] = [];
    let from = 0;
    for (;;) {
        const open = text.indexOf(begin, from);
        if (open === -1) return blocks;
        const close = text.indexOf(end, open + begin.length);
        if (close === -1) return blocks;
        blocks.push({ body: text.slice(open + begin.length, close), end: close + end.length });
        from = close + end.length;
    }
}

/** `text` with every block returned by {@link findPemBlocks} removed. Same as `text.replace(/-----BEGIN L-----[\s\S]*?-----END L-----/g, '')`. */
export function removePemBlocks(text: string, label: string): string {
    const begin = `-----BEGIN ${label}-----`;
    let out = '';
    let from = 0;
    for (const block of findPemBlocks(text, label)) {
        const open = text.indexOf(begin, from);
        out += text.slice(from, open);
        from = block.end;
    }
    return out + text.slice(from);
}
