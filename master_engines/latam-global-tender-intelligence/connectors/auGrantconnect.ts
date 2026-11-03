/**
 * auGrantconnect.ts - Australian GrantConnect "Grant Awards" register (grants.gov.au). HELD.
 *
 * Legacy actor: `australia-grantconnect-monitor`. It is registered here, disabled, so that selecting
 * `au_grantconnect` fails preflight with this precise reason instead of "unknown source".
 *
 * WHY IT IS HELD
 * --------------
 * The host sits behind CloudFront and answers HTTP 403 "ERROR: The request could not be satisfied" to every request
 * that is honestly identified, including `/robots.txt`. The legacy actor gets through only by presenting itself as a
 * desktop Chrome browser: its src/http.ts sends a Chrome `User-Agent` and (since 2026-09-19) routes every request
 * through `impit` with a Chrome TLS/HTTP2 fingerprint, and its AGENTS.md states that "a request with only a normal
 * browser User-Agent succeeds". That is a request filter being satisfied by impersonation, i.e. the fingerprint
 * spoofing / access-gate bypass this engine's compliance doctrine forbids (lib/http.ts identifies itself honestly and
 * says a source that needs more is `held`). The legacy author calls it "a compatibility requirement, not a
 * circumvention"; under this engine's stricter rule it is held regardless.
 *
 * There is no sanctioned alternative channel: the legacy README says GrantConnect "has no API, no CSV feed, no RSS and
 * no email alert for awards" (the RSS at /public_data/rss/rss.xml covers grant OPPORTUNITIES, not awards). The only
 * other route the legacy AGENTS.md mentions is the `/Ga/DownloadResult` XLSX export, which is behind the same gate.
 * A search of data.gov.au found only agency-specific grant datasets (for example "Grants Awarded Data" from DISR and
 * "Grant Reporting" from Health), not the whole-of-government GrantConnect register, so they are not a substitute and
 * are not wired in.
 *
 * WHAT WOULD UNBLOCK IT (any one of):
 *   - written permission from the GrantConnect operator (Department of Finance) for automated access under an honest
 *     User-Agent, or an allow-listing of this engine's User-Agent;
 *   - an official bulk/API channel for Grant Awards that answers an honestly identified client.
 * Then: port src/urls.ts (listingPath), src/parsers/listing.ts, src/parsers/detail.ts, src/normalize.ts and the
 * record builder of src/fetchGrantAwards.ts, keep the legacy fixtures under the legacy repo's test/fixtures, and flip
 * the status. Nothing was ported speculatively: parsers that cannot be exercised against the live site are not
 * evidence.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION (this port session, 2026-10-21, curl through the sandbox egress proxy)
 * ============================================================================
 *   GET https://www.grants.gov.au/Ga/ListResult?Type=Ga&AgencyStatus=-1&DateType=Publish%20Date&DateStart=01-Oct-2026
 *       &DateEnd=31-Dec-2099&orderBy=Last%20Updated&page=1   (the legacy actor's own listing URL shape)
 *     User-Agent "awesome-regulatory-monitors/0.1 (+https://github.com/stefanoseggio)" -> HTTP 403 text/html, 919 bytes
 *     User-Agent "curl/8.5.0"                                                          -> HTTP 403 text/html, 919 bytes
 *     no User-Agent                                                                    -> HTTP 403 text/html, 919 bytes
 *     body: "ERROR: The request could not be satisfied" (the CloudFront error page)
 *   GET https://www.grants.gov.au/robots.txt (honest User-Agent) -> HTTP 403.
 *   No request with a spoofed browser identity was made in this session.
 *   GET https://data.gov.au/data/api/3/action/package_search?q=grantconnect -> HTTP 200, count 0;
 *   ?q=grant%20awards -> count 1803 (agency-specific datasets, none the GrantConnect register).
 * ============================================================================
 *
 * OVERLAP NOTE: `emerging-market-sovereign-debt-auction-monitor` does not overlap this source.
 */
import { createHeldConnector } from '../../lib/connector_helpers.js';
import type { Connector } from '../../lib/types.js';

export const AU_GRANTCONNECT_HELD_REASON =
    'grants.gov.au (CloudFront) answers HTTP 403 to every honestly identified request, including /robots.txt (live-verified 2026-10-21); the legacy actor only gets through by presenting a Chrome User-Agent and a Chrome TLS fingerprint (impit), which the compliance doctrine forbids as fingerprint spoofing. GrantConnect has no API, CSV feed or RSS for awards. Unblock with written permission or an official channel for automated access.';

export const auGrantconnectConnector: Connector<Record<string, unknown>> = createHeldConnector({
    id: 'au_grantconnect',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'australia-grantconnect-monitor',
    description: 'Australian Government GrantConnect Grant Awards register (grants.gov.au). HELD: the site only serves browser-impersonating clients.',
    reason: AU_GRANTCONNECT_HELD_REASON,
});
