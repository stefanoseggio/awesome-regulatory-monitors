/**
 * Central credential scrubbing. Connectors keep their own redaction, but no connector is trusted to be the only line of
 * defence: the router scrubs every log line, warning and error it prints or stores with the credentials of the sources
 * selected for the run (their own option values, plus URL-encoded and base64 forms).
 */

const CREDENTIAL_KEY = /key|token|secret|passw|credential|auth|pem/i;
const MIN_SECRET_LENGTH = 6;

/** Credential-looking string values (and their common encodings) found in a source's validated options. */
export function collectSecrets(options: Record<string, unknown>): string[] {
    const found = new Set<string>();
    const add = (value: string): void => {
        if (value.length < MIN_SECRET_LENGTH) return;
        found.add(value);
        found.add(encodeURIComponent(value));
        found.add(Buffer.from(value, 'utf8').toString('base64'));
    };
    for (const [key, value] of Object.entries(options)) {
        if (!CREDENTIAL_KEY.test(key)) continue;
        if (typeof value === 'string') add(value.trim());
    }
    return [...found];
}

/** Returns a function that replaces every secret (longest first) with `***`. A no-op when there are no secrets. */
export function createScrubber(secrets: Iterable<string>): (text: string) => string {
    const ordered = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
    if (ordered.length === 0) return (text) => text;
    return (text) => {
        let out = text;
        for (const secret of ordered) out = out.split(secret).join('***');
        return out;
    };
}
