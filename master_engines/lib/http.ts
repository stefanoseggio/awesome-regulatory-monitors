/**
 * Shared HTTP client: global `fetch`, bounded retries with exponential back-off,
 * honest identification, and hard timeouts. No CAPTCHA solving, no fingerprint
 * spoofing, no WAF circumvention - a source that needs those is `held`.
 */
import type { HttpClient, HttpRequestInit, Logger } from './types.js';

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

export class HttpStatusError extends Error {
    constructor(
        readonly url: string,
        readonly status: number,
        readonly bodyPreview: string,
    ) {
        super(`HTTP ${status} for ${url}${bodyPreview ? `: ${bodyPreview}` : ''}`);
        this.name = 'HttpStatusError';
    }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    async function request(url: string, init: HttpRequestInit = {}): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? defaultTimeoutMs);
            try {
                const response = await fetchImpl(url, {
                    method: init.method ?? 'GET',
                    headers: { 'user-agent': options.userAgent, accept: '*/*', ...init.headers },
                    body: init.body,
                    signal: controller.signal,
                });
                if (response.ok) return response;
                const preview = (await response.text().catch(() => '')).slice(0, 200);
                const error = new HttpStatusError(url, response.status, preview);
                if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) throw error;
                lastError = error;
            } catch (error) {
                if (error instanceof HttpStatusError && !RETRYABLE_STATUS.has(error.status)) throw error;
                lastError = error;
                if (attempt === maxRetries) throw error;
            } finally {
                clearTimeout(timer);
            }
            const delay = baseDelayMs * 2 ** attempt;
            options.log?.debug(`retry ${attempt + 1}/${maxRetries} for ${url} in ${delay}ms: ${String(lastError)}`);
            await sleep(delay);
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return {
        async getText(url, init) {
            return (await request(url, init)).text();
        },
        async getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T> {
            const response = await request(url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
            return (await response.json()) as T;
        },
    };
}
