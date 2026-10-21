/**
 * portalHttp.ts - the OPTIONAL transport capability the tenders-a connectors probe `ctx.http` for.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The shared `HttpClient` port (lib/types.ts) exposes exactly `getText` / `getJson`. That is enough
 * for JSON and UTF-8 HTML sources, but three of the legacy Argentine portals need something it does
 * not offer:
 *
 *   - ar_entrerios  serves Windows-1252 BYTES under a `Content-Type: ...charset=UTF-8` header
 *                   (legacy decode.ts, verified at byte level; re-verified live 2026-10-21 in this
 *                   port session: the POST response contained raw 0xF3 / 0xED / 0xFA / 0x93 / 0x94
 *                   bytes). `getText` decodes UTF-8, so every accented character becomes U+FFFD and is
 *                   unrecoverable. The raw bytes are required.
 *   - ar_tucuman    serves `Content-Type: text/html;charset=ISO-8859-1`. The legacy actor decodes the
 *                   raw bytes explicitly. (Its field data is HTML-entity-encoded in practice, so a UTF-8
 *                   `getText` degrades gracefully there - see arTucuman.ts.)
 *   - ar_cordoba    is a stateful ASP.NET postback chain: every POST must carry the
 *                   `ASP.NET_SessionId` cookie the previous response set, so the connector needs the
 *                   response's `Set-Cookie` headers.
 *
 * Nothing in lib/ may be modified by a connector group, so this module defines the capability as a
 * structural extension (`getRaw`) that a richer HttpClient MAY implement, plus the helpers that use
 * it. The matching lib change request is recorded in the group report ("libChangeRequests"): add
 * `getRaw` to `HttpClient` in lib/types.ts and implement it in lib/http.ts with the same retry /
 * timeout policy as `getText` (a non-2xx status must throw, exactly like `getText`; the response body
 * is returned as bytes together with every `Set-Cookie` header from `Headers.getSetCookie()`).
 *
 * Until that lands, `hasRawHttp(ctx.http)` is false at runtime and each connector applies its own
 * explicit, documented policy (fail closed for ar_entrerios and for ar_cordoba pagination, graceful
 * degradation for ar_tucuman). No connector ever silently emits text it knows is corrupted.
 *
 * `tlsExtraCaPem` on {@link RawRequestInit} is a transport HINT: an HttpClient that supports it must
 * ADD the PEM certificates to (not replace) its trust store for that request. Today's lib/http.ts
 * ignores unknown init fields, so the hint is inert until the same lib change lands; the working
 * alternative today is the process-level `NODE_EXTRA_CA_CERTS` environment variable.
 */
import type { ConnectorContext, HttpClient, HttpRequestInit } from '../../lib/types.js';
import { SourceFetchError } from '../../lib/types.js';

export interface RawHttpResponse {
    status: number;
    /** Undecoded response body. */
    body: Uint8Array;
    /** Every `Set-Cookie` header of the response, one array element per header. */
    setCookies: readonly string[];
}

export interface RawRequestInit extends HttpRequestInit {
    /** PEM-encoded CERTIFICATE blocks to add to the trust store for this request (never a private key). */
    tlsExtraCaPem?: string;
}

export interface RawHttpCapability {
    getRaw(url: string, init?: RawRequestInit): Promise<RawHttpResponse>;
}

export type RawCapableHttpClient = HttpClient & RawHttpCapability;

/** True when `http` also implements the optional {@link RawHttpCapability}. */
export function hasRawHttp(http: HttpClient): http is RawCapableHttpClient {
    return typeof (http as Partial<RawHttpCapability>).getRaw === 'function';
}

export type PortalCharset = 'utf-8' | 'windows-1252' | 'iso-8859-1';

/** Decodes raw response bytes with an explicit charset. Never throws on malformed input. */
export function decodePortalBytes(body: Uint8Array, charset: PortalCharset): string {
    return new TextDecoder(charset).decode(body);
}

/**
 * Returns the `NAME=value` pair of the first `Set-Cookie` header whose cookie name is exactly `name`,
 * or null. Attributes (`Path`, `HttpOnly`, ...) are dropped, as a browser's cookie jar would when
 * replaying the cookie on the next request.
 */
export function cookiePairFromSetCookies(setCookies: readonly string[], name: string): string | null {
    for (const header of setCookies) {
        const pair = header.split(';', 1)[0]?.trim() ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq) === name && pair.length > eq + 1) return pair;
    }
    return null;
}

export type MissingRawPolicy = 'fail' | 'utf8-fallback';

export interface FetchDecodedOptions {
    charset: PortalCharset;
    /**
     * What to do when `ctx.http` cannot return raw bytes:
     *   'fail'          throw SourceFetchError (the text would be irreversibly corrupted);
     *   'utf8-fallback' use `getText` and warn when U+FFFD shows up in the result.
     */
    onMissingRaw: MissingRawPolicy;
    sourceId: string;
    init?: RawRequestInit;
}

/** GET/POST `url` and return the body decoded with the portal's REAL charset. */
export async function fetchDecoded(ctx: ConnectorContext, url: string, options: FetchDecodedOptions): Promise<string> {
    const { charset, onMissingRaw, sourceId, init } = options;
    if (hasRawHttp(ctx.http)) {
        const response = await ctx.http.getRaw(url, init);
        return decodePortalBytes(response.body, charset);
    }
    if (onMissingRaw === 'fail') {
        throw new SourceFetchError(
            `${sourceId}: ctx.http cannot return raw response bytes (HttpClient.getRaw is not implemented) and this portal serves ${charset} bytes; ` +
                'decoding them as UTF-8 would irreversibly replace every accented character with U+FFFD, so the source is not fetched. ' +
                'Requires the lib change request "HttpClient.getRaw".',
            sourceId,
        );
    }
    const text = await ctx.http.getText(url, init);
    // HTML comments are ignored on purpose: ar_tucuman's only raw high bytes sit inside dead comments (verified live), and a
    // replacement character there loses no data.
    if (text.replace(/<!--[\s\S]*?-->/g, '').includes('�')) {
        ctx.log.warning(
            `[${sourceId}] response contains U+FFFD after UTF-8 decoding; the portal declares ${charset}. ` +
                'Some accented characters may be lost until HttpClient.getRaw is available.',
        );
    }
    return text;
}

/** Collapses every whitespace run (including NBSP) to one space and trims. */
export function collapseWhitespace(text: string): string {
    return text.replace(/[\s ]+/g, ' ').trim();
}

/** Argentina has used a fixed UTC-3 offset (no DST) since 2009, so a constant offset is exact. */
export const ARGENTINA_UTC_OFFSET_MINUTES = -3 * 60;

/** Argentine wall-clock -> UTC instant. */
export function argentinaLocalToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - ARGENTINA_UTC_OFFSET_MINUTES * 60_000);
}

/** The error message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
