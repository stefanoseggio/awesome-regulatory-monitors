/**
 * Shared HTTP client: global `fetch`, bounded retries with exponential back-off,
 * honest identification, hard timeouts, response-size caps and (opt-in) per-hop
 * redirect validation. No CAPTCHA solving, no fingerprint spoofing, no WAF
 * circumvention - a source that needs those is `held`.
 */
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
const SECRET_QUERY_KEY = /key|token|secret|passw|auth|sig|credential/i;

/** Masks credential-looking query parameters so an error message or log line never carries them. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        for (const key of [...parsed.searchParams.keys()]) {
            if (SECRET_QUERY_KEY.test(key)) parsed.searchParams.set(key, '***');
        }
        return parsed.toString();
    } catch {
        return url.replace(/([?&][^=&]*(?:key|token|secret|passw|auth|sig|credential)[^=&]*=)[^&]*/gi, '$1***');
    }
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

export function createHttpClient(options: HttpClientOptions): HttpClient {
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    /** One fetch, following redirects hop by hop only when `init.redirects` is set. */
    async function fetchOnce(url: string, init: HttpRequestInit, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
        const base: RequestInit = {
            method: init.method ?? 'GET',
            headers: { 'user-agent': options.userAgent, accept: '*/*', ...init.headers },
            body: init.body,
            signal,
        };
        if (!init.redirects) return { response: await fetchImpl(url, base), finalUrl: url };

        let current = url;
        for (let hop = 0; hop <= init.redirects.max; hop += 1) {
            const response = await fetchImpl(current, { ...base, redirect: 'manual' });
            if (!REDIRECT_STATUS.has(response.status)) return { response, finalUrl: current };
            const location = response.headers.get('location');
            await response.body?.cancel().catch(() => undefined);
            if (!location) throw new HttpRedirectError(current, 'missing Location header');
            let target: URL;
            try {
                target = new URL(location, current);
            } catch {
                throw new HttpRedirectError(current, 'unparseable Location header');
            }
            if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new HttpRedirectError(current, `unsupported scheme ${target.protocol}`);
            if (init.redirects.validate && !init.redirects.validate(target)) throw new HttpRedirectError(current, `target host ${target.hostname} not allowed`);
            current = target.toString();
        }
        throw new HttpRedirectError(url, `more than ${init.redirects.max} redirects`);
    }

    let warnedAboutCaHint = false;

    async function request(url: string, init: HttpRequestInit = {}): Promise<{ bytes: Uint8Array; response: Response; finalUrl: string }> {
        if (init.tlsExtraCaPem !== undefined && !warnedAboutCaHint) {
            warnedAboutCaHint = true;
            options.log?.warning('tlsExtraCaPem was supplied but the default HTTP client cannot add trust anchors per request; set NODE_EXTRA_CA_CERTS on the Actor process instead.');
        }
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? defaultTimeoutMs);
            try {
                const { response, finalUrl } = await fetchOnce(url, init, controller.signal);
                if (response.ok) return { bytes: await readBytes(response, finalUrl, init.maxBytes), response, finalUrl };
                const preview = (await response.text().catch(() => '')).slice(0, 200);
                const error = new HttpStatusError(finalUrl, response.status, preview);
                if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) throw error;
                lastError = error;
            } catch (error) {
                if (error instanceof HttpStatusError && !RETRYABLE_STATUS.has(error.status)) throw error;
                if (error instanceof HttpBodyTooLargeError || error instanceof HttpRedirectError) throw error;
                lastError = error;
                if (attempt === maxRetries) throw error;
            } finally {
                clearTimeout(timer);
            }
            const delay = baseDelayMs * 2 ** attempt;
            options.log?.debug(`retry ${attempt + 1}/${maxRetries} for ${redactUrl(url)} in ${delay}ms: ${String(lastError)}`);
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
