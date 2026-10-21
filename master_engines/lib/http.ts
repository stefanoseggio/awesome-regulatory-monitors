/**
 * Shared HTTP client: global `fetch`, bounded retries with exponential back-off, honest identification, hard
 * timeouts, response-size caps and per-hop redirect handling. No CAPTCHA solving, no fingerprint spoofing, no WAF
 * circumvention - a source that needs those is `held`.
 *
 * REDIRECTS are always resolved here, never by the platform. On every hop the target scheme must be http(s), an
 * https -> http downgrade is refused, the optional `validate` callback must approve the host, and when the ORIGIN
 * changes every request header except a short allow-list is dropped - so a BYOK credential sent as `x-api-key`,
 * `x-app-token` or `authorization` can never be delivered to another host. 301/302 on a POST and 303 turn into a
 * body-less GET, as browsers and `fetch` do.
 */
import { capLength, redactQueryString } from './safe_text.js';
import type { HttpClient, HttpRequestInit, Logger, RawHttpResponse } from './types.js';

export interface HttpClientOptions {
    userAgent: string;
    maxRetries?: number;
    baseDelayMs?: number;
    defaultTimeoutMs?: number;
    log?: Logger;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 120_000;
const ERROR_PREVIEW_BYTES = 1024;
const ERROR_PREVIEW_CHARS = 200;
/** Headers that are safe to send to a different origin after a redirect. Everything else is dropped. */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'content-type']);
const SECRET_QUERY_KEY = /key|token|secret|passw|auth|sig|credential|session|jwt|bearer/i;

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) to ms, or 0 when absent/invalid. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now)) : 0;
}

/** Masks credential-looking query parameters, userinfo and the fragment so a log line or error never carries them. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        parsed.hash = '';
        for (const key of [...parsed.searchParams.keys()]) {
            if (SECRET_QUERY_KEY.test(key)) parsed.searchParams.set(key, '***');
        }
        return parsed.toString();
    } catch {
        // Not a parseable URL: mask the query string with a linear scan (no backtracking regex on an unvalidated string).
        return redactQueryString(capLength(url, 4096), (name) => SECRET_QUERY_KEY.test(name));
    }
}

/** Replaces every occurrence of a request-header value (>= 6 chars) in `text`, so a header-validation error cannot echo it. */
function scrubHeaderValues(text: string, headers: Record<string, string> | undefined): string {
    let out = text;
    for (const value of Object.values(headers ?? {})) {
        if (typeof value === 'string' && value.length >= 6) out = out.split(value).join('***');
    }
    return out;
}

export class HttpStatusError extends Error {
    constructor(
        readonly url: string,
        readonly status: number,
        readonly bodyPreview: string,
    ) {
        super(`HTTP ${status} for ${redactUrl(url)}${bodyPreview ? `: ${bodyPreview}` : ''}`);
        this.name = 'HttpStatusError';
    }
}

export class HttpBodyTooLargeError extends Error {
    constructor(
        readonly url: string,
        readonly maxBytes: number,
    ) {
        super(`Response from ${redactUrl(url)} exceeded the ${maxBytes}-byte limit.`);
        this.name = 'HttpBodyTooLargeError';
    }
}

export class HttpRedirectError extends Error {
    constructor(
        readonly url: string,
        reason: string,
    ) {
        super(`Redirect from ${redactUrl(url)} refused: ${reason}`);
        this.name = 'HttpRedirectError';
    }
}

/** Reads a response body as bytes, aborting once `maxBytes` is exceeded. */
async function readBytes(response: Response, url: string, maxBytes: number | undefined): Promise<Uint8Array> {
    if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpBodyTooLargeError(url, maxBytes);
    }
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new HttpBodyTooLargeError(url, maxBytes);
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/**
 * A short preview of a NON-2xx body. Reads at most ERROR_PREVIEW_BYTES and then cancels the stream, so a hostile host
 * answering 403/404/5xx with an endless or compressed-bomb body cannot exhaust memory (and the connection is released
 * before a retry).
 */
async function readErrorPreview(response: Response): Promise<string> {
    const body = response.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < ERROR_PREVIEW_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
        }
    } catch {
        // No preview is better than a failed request.
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged).slice(0, ERROR_PREVIEW_CHARS);
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
    return out;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let warnedAboutCaHint = false;

    /** One logical request, following redirects hop by hop under the policy described in the file header. */
    async function fetchOnce(url: string, init: HttpRequestInit, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
        const maxRedirects = init.redirects?.max ?? DEFAULT_MAX_REDIRECTS;
        let headers = lowerCaseKeys({ 'user-agent': options.userAgent, accept: '*/*', ...init.headers });
        let method = init.method ?? 'GET';
        let body = init.body;
        let current = url;

        for (let hop = 0; hop <= maxRedirects; hop += 1) {
            const response = await fetchImpl(current, { method, headers, body, signal, redirect: 'manual' });
            if (!REDIRECT_STATUS.has(response.status)) return { response, finalUrl: current };

            const location = response.headers.get('location');
            await response.body?.cancel().catch(() => undefined);
            if (hop === maxRedirects) throw new HttpRedirectError(url, `more than ${maxRedirects} redirects`);
            if (!location) throw new HttpRedirectError(current, 'missing Location header');

            let target: URL;
            try {
                target = new URL(location, current);
            } catch {
                throw new HttpRedirectError(current, 'unparseable Location header');
            }
            const from = new URL(current);
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new HttpRedirectError(current, `unsupported scheme ${target.protocol}`);
            if (from.protocol === 'https:' && target.protocol === 'http:') throw new HttpRedirectError(current, 'https to http downgrade');
            if (init.redirects?.validate && !init.redirects.validate(target)) throw new HttpRedirectError(current, `target host ${target.hostname} not allowed`);

            if (target.origin !== from.origin) {
                headers = Object.fromEntries(Object.entries(headers).filter(([key]) => CROSS_ORIGIN_SAFE_HEADERS.has(key)));
            }
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
                method = 'GET';
                body = undefined;
                delete headers['content-type'];
            }
            current = target.toString();
        }
        throw new HttpRedirectError(url, `more than ${maxRedirects} redirects`);
    }

    async function request(url: string, init: HttpRequestInit = {}): Promise<{ bytes: Uint8Array; response: Response; finalUrl: string }> {
        if (init.tlsExtraCaPem !== undefined && !warnedAboutCaHint) {
            warnedAboutCaHint = true;
            options.log?.warning('tlsExtraCaPem was supplied but the default HTTP client cannot add trust anchors per request; set NODE_EXTRA_CA_CERTS on the Actor process instead.');
        }
        let lastError: unknown;
        let retryAfterMs = 0;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            retryAfterMs = 0;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? defaultTimeoutMs);
            try {
                const { response, finalUrl } = await fetchOnce(url, init, controller.signal);
                if (response.ok) return { bytes: await readBytes(response, finalUrl, init.maxBytes), response, finalUrl };
                const preview = await readErrorPreview(response);
                const error = new HttpStatusError(finalUrl, response.status, preview);
                if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) throw error;
                retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
                lastError = error;
            } catch (error) {
                if (error instanceof HttpStatusError && !RETRYABLE_STATUS.has(error.status)) throw error;
                if (error instanceof HttpBodyTooLargeError || error instanceof HttpRedirectError) throw error;
                lastError = error;
                if (attempt === maxRetries) throw error;
            } finally {
                clearTimeout(timer);
            }
            const delay = Math.max(baseDelayMs * 2 ** attempt, init.minRetryDelayMs ?? 0, retryAfterMs);
            options.log?.debug(`retry ${attempt + 1}/${maxRetries} for ${redactUrl(url)} in ${delay}ms: ${scrubHeaderValues(String(lastError), init.headers)}`);
            await sleep(delay);
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return {
        async getText(url, init) {
            return new TextDecoder('utf-8').decode((await request(url, init)).bytes);
        },
        async getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T> {
            const { bytes } = await request(url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
            return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as T;
        },
        async getRaw(url, init): Promise<RawHttpResponse> {
            const { bytes, response } = await request(url, init);
            const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
            return { status: response.status, body: bytes, setCookies };
        },
    };
}
