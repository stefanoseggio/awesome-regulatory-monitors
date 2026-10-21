/**
 * Multilateral development bank procurement sources researched and DEFERRED by the legacy
 * `actor-20-mdb-procurement-monitor` (live evidence in that actor's src/sources/deferredSources.ts, checked
 * 2026-09-07). Registered as `held` so selecting one fails preflight with the documented reason.
 */
import { createHeldConnector } from '../../lib/connector_helpers.js';

const ENGINE = 'latam-global-tender-intelligence' as const;
const LEGACY = 'actor-20-mdb-procurement-monitor';

export const adbProcurementConnector = createHeldConnector({
    id: 'adb_procurement',
    engine: ENGINE,
    legacyActor: LEGACY,
    description: 'Asian Development Bank procurement notices.',
    reason:
        'adb.org sits behind a Cloudflare bot-detection/WAF challenge on every path tested, including robots.txt and its RSS feeds (HTTP 403). Working around it is forbidden by the compliance doctrine (no WAF bypass, no fingerprint spoofing).',
});

export const idbProcurementConnector = createHeldConnector({
    id: 'idb_procurement',
    engine: ENGINE,
    legacyActor: LEGACY,
    description: 'Inter-American Development Bank procurement notices.',
    reason:
        'The IDB notices page renders only through an embedded Power BI report, and the structured CKAN API at data.iadb.org is disallowed by that host\'s own robots.txt (/api/, /datastore/dump/, /file/download/, /dataset/download/). Neither route is compliant for a robots-respecting plain-fetch connector.',
});
