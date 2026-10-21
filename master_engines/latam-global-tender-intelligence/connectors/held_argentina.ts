/**
 * held_argentina.ts - the four Argentine provincial portals that are REGISTERED but must NEVER run:
 * `ar_salta`, `ar_mendoza`, `ar_pba`, `ar_cordoba`.
 *
 * Each is built with `createHeldConnector()`: it stays in the registry so that selecting it fails
 * preflight (`resolveSources` -> FatalConfigError) with a precise, auditable reason instead of
 * "unknown source", and its `fetch` throws the same FatalConfigError if it is ever called directly. No
 * `sourceOptions` slice can unlock a held source: the held check runs BEFORE options validation.
 *
 * WHAT THE LEGACY REPOS ACTUALLY DOCUMENT (read for this file: README.md, AGENTS.md, SECURITY.md,
 * CHANGELOG.md, .actor/*, src/ of each repo)
 * ----------------------------------------------------------------------------
 * ar_pba  (pba-tenders-monitor)  DOCUMENTS A BLOCKING CONSTRAINT. AGENTS.md "CRITICAL: PBAC blocks
 *         non-residential-Argentina traffic (verified 2026-09-04)": from Apify's cloud, both no proxy and
 *         the default (datacenter) Apify Proxy "time out at 30s across 4 retries on every request to
 *         pbac.cgp.gba.gov.ar ... 0 successes across two separate cloud runs. Only Residential proxy with
 *         `countryCode: 'AR'` succeeded (3.5s, 3/3 rows). This is a geo/traffic-type block". The README
 *         repeats it ("PBAC blocks non-residential, non-Argentina traffic outright", input field
 *         `proxyConfiguration` "Required"), and AGENTS.md "CI cannot reach PBAC" records that GitHub
 *         Actions runner IPs time out too. The legacy actor works around it with a paid Residential +
 *         Argentina proxy (~$7-8/GB). The shared lib/http.ts client has no proxy support and the
 *         compliance doctrine of this package does not route around network-level access blocks, so the
 *         source is held with the legacy reason.
 *
 * ar_cordoba (cordoba-compras-monitor)  DOCUMENTS THE SAME BLOCKING CONSTRAINT AS ar_pba. AGENTS.md (lines 86-88):
 *         the portal "blocks non-Argentina/non-residential traffic, same as PBAC" - the failure is at TCP
 *         level (10 s, both resolved IPs) - and the legacy actor "fixed [it] the same way" with a hardcoded
 *         Residential + AR `Actor.createProxyConfiguration()` fallback. SECURITY.md (line 18) and README.md
 *         (lines 48 and 78) repeat it: the actor "does require a paid Residential + Argentina Apify Proxy
 *         group ... the source blocks non-residential, non-Argentina traffic at the network level".
 *         AGENTS.md (lines 179-205) additionally records that the proxied path was never independently
 *         verified from the real Linux container. Held by operator decision (the connector was first shipped
 *         active, then transitioned to held): the shared lib/http.ts has no proxy support and the compliance
 *         doctrine does not route around a network-level access block. The ported connector stays in
 *         `connectors/arCordoba.ts` as DORMANT, tested code and is deliberately not imported by the registry.
 *
 * ar_salta (salta-compras-monitor)  DOCUMENTS NO BLOCKING CONSTRAINT. Its README "Reliability" and
 *         AGENTS.md "Architecture" state the opposite: plain server-rendered PHP (Apache/2.4.18), "no
 *         proxy, no browser - verified live 2026-09-04", reachable "from a standard datacenter IP", no
 *         DevExpress / ViewState / SPA markers. The only quirks recorded are engineering ones the legacy
 *         actor already handles: the listing is ordered by bid-opening date (not by recency), adjacent
 *         pages can repeat a publication id (de-duplicated by id), the only date field is the bid-opening
 *         deadline. No CAPTCHA, WAF, ToS prohibition, login or instability is documented anywhere.
 *
 * ar_mendoza (mendoza-compras-monitor)  DOCUMENTS NO BLOCKING CONSTRAINT. AGENTS.md "Why this target was
 *         treated as high-risk, and what was actually found": it runs COMPR.AR with DevExpress controls,
 *         but they are confined to peripheral filter widgets; the results grid is a classic ASP.NET
 *         GridView, pagination is `__EVENTARGUMENT=Page$N`, "no proxy needed - reachable directly from a
 *         plain datacenter IP", no CAPTCHA / WAF / ToS / login. Operational characteristics (NOT blockers):
 *         a stateful session with two cookies (ASP.NET_SessionId + a second opaque one), a register of
 *         25,784+ processes sorted by process number (so no early stop and no CLOSED), ~1.5 s per row for
 *         the optional permalink postback against a 600 s run timeout (maxItems capped at 280 for that
 *         reason), and the sibling cordoba-compras-monitor AGENTS.md calls it "viable but the most
 *         fragile of the five".
 *
 * For ar_salta and ar_mendoza the reason is therefore the portfolio-decision text the group assignment
 * prescribes for a legacy repo that documents no blocking constraint. If the operator wants either source
 * enabled, the legacy code is sufficient to port it (the fetch / parse logic is documented and tested in
 * the legacy repos) - it is held because of the operator's designation, not because of a technical finding.
 */
import { createHeldConnector } from '../../lib/connector_helpers.js';

/** The reason for a held source whose legacy repo documents no blocking constraint. */
export const PORTFOLIO_HOLD_REASON = 'held by portfolio decision (operator-designated held source); no technical constraint documented in the legacy repo';

export const PBA_HOLD_REASON =
    'pbac.cgp.gba.gov.ar blocks non-residential, non-Argentine traffic at the network level (legacy pba-tenders-monitor AGENTS.md "CRITICAL: PBAC blocks non-residential-Argentina traffic", verified 2026-09-04: every request from Apify\'s cloud with no proxy or a datacenter proxy timed out after 30 s across 4 retries, 0 successes in two cloud runs; only a paid Residential proxy with countryCode AR succeeded, which is how the legacy actor runs). The shared HTTP client has no proxy support and the compliance doctrine does not route around a network-level access block.';

export const CORDOBA_HOLD_REASON =
    'webecommerce.cba.gov.ar blocks non-residential, non-Argentine traffic at the network level (legacy cordoba-compras-monitor AGENTS.md lines 86-88: the failure is at TCP level and the portal blocks non-Argentina/non-residential traffic, same as PBAC; SECURITY.md and README.md state the actor requires a paid Residential + Argentina Apify Proxy group, and that proxied path was never independently verified from the real container). The shared HTTP client has no proxy support and the compliance doctrine does not route around a network-level access block.';

export const arCordobaHeldConnector = createHeldConnector({
    id: 'ar_cordoba',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'cordoba-compras-monitor',
    description: 'Province of Cordoba (Argentina) Compras Publicas licitaciones, webecommerce.cba.gov.ar. HELD: cannot be selected.',
    reason: CORDOBA_HOLD_REASON,
});

export const arSaltaConnector = createHeldConnector({
    id: 'ar_salta',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'salta-compras-monitor',
    description: 'Province of Salta (Argentina) public tenders and awards, compras.salta.gob.ar. HELD: cannot be selected.',
    reason: PORTFOLIO_HOLD_REASON,
});

export const arMendozaConnector = createHeldConnector({
    id: 'ar_mendoza',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'mendoza-compras-monitor',
    description: 'Province of Mendoza (Argentina) COMPR.AR procurement processes, comprar.mendoza.gov.ar. HELD: cannot be selected.',
    reason: PORTFOLIO_HOLD_REASON,
});

export const arPbaConnector = createHeldConnector({
    id: 'ar_pba',
    engine: 'latam-global-tender-intelligence',
    legacyActor: 'pba-tenders-monitor',
    description: 'Province of Buenos Aires (Argentina) PBAC procurement portal, pbac.cgp.gba.gov.ar. HELD: cannot be selected.',
    reason: PBA_HOLD_REASON,
});
