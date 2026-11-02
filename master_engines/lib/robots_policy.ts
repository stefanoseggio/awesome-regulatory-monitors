/**
 * robots.txt policy of the three engines: decision G4, taken on 2026-11-02 by the delegate of the owner (the owner's written mandate of that day granted the authority to
 * settle G1 to G5; see docs/deployment/production_deployment_runbook.md section 0).
 *
 * THE RULE. An active connector requests only URLs that the host's robots.txt does not disallow for `User-agent: *`. A part of a source that would break the rule is HELD:
 * it is recognised only to be refused at preflight with its reason (the way `dubai_pulse` is), its transport and parser code stays in the repository, and it is re-enabled
 * only by changing this file, its tests and the captured robots.txt together. The policy is the one already applied to `idb_procurement` (the CKAN API is
 * robots.txt-disallowed) and `imo_gisis` (robots.txt disallows `/Members/`, `/Secretariat/`, `/WebServices/`), both held for exactly this reason; it replaces the
 * inconsistent state in which DIFC, six Diario Oficial sections and the ClinicalTrials.gov API were requested although disallowed.
 *
 * EVIDENCE. The robots.txt of each host was fetched on 2026-11-02 and is kept byte for byte in test/fixtures/robots/. `test/robots.policy.test.ts` evaluates every endpoint
 * of the active connectors against those captures with the engines' own matcher (`parseRobotsTxt`, `evaluateBotPermission`), so the policy cannot drift from the code:
 *
 *   host                              captured rule that decides                                        endpoints requested                                decision
 *   newreg.adgm.com                   Allow: /  (only a forgot-password page is disallowed)             /s/search-results, /s/sfsites/aura                  allowed (ADGM stays active)
 *   www.diariooficial.interior.gob.cl Disallow: /edicionelectronica/  Allow: /edicionelectronica/index.php   index.php (normas_generales)                   allowed
 *                                                                                                        avisos_destacados, marcas_patentes, normas_particulares,
 *                                                                                                        publicaciones_judiciales, empresas_cooperativas, bom   HELD (disallowed)
 *   www.difc.com                      Disallow: /api/                                                   POST /api/handleRequest                             HELD (disallowed)
 *   clinicaltrials.gov                Disallow: /api/  Crawl-delay: 1                                   /api/v2/studies, /api/v2/version                    the ONE exception, below
 *
 * THE ONE EXCEPTION: the ClinicalTrials.gov API v2. Its robots.txt disallows `/api/` for every crawler (and allows `/api/int/` and `/api/seo/` for the site's own pages), but
 * the endpoint is the public, keyless, versioned data API of the registry that the connector exists to read; a crawler policy that excluded it would exclude the only machine
 * interface of the source. The exception is granted for exactly these endpoints and under the conditions below, and it is the only one: a second entry needs a new decision.
 *
 * WHAT IS NOT VERIFIED. The text of the operator's terms of use and API documentation could not be read in the 2026-11-02 pass (clinicaltrials.gov serves them from a
 * single-page application that returns no text to a plain fetch). The exception rests on the facts above (public, keyless, documented version endpoint answering HTTP 200
 * with {"apiVersion":"2.0.5"} on 2026-11-02), not on a reading of those terms. If they forbid automated use, remove the entry from ROBOTS_EXCEPTIONS and hold the
 * ClinicalTrials leg of `clinicaltrials_orange_book` the way DIFC is held; the Orange Book leg (openFDA) is unaffected.
 */

export const ROBOTS_POLICY_DECIDED_ON = '2026-11-02';

export const ROBOTS_RULE =
    "An active connector requests only URLs that the host's robots.txt does not disallow for `User-agent: *`; a part of a source that would break the rule is held and refused at preflight with its reason.";

export interface RobotsException {
    host: string;
    /** The only paths of the host that may be requested although robots.txt disallows them. */
    endpoints: readonly string[];
    why: string;
    /** Conditions that the connector must keep meeting; `test/robots.policy.test.ts` checks the ones it can check. */
    conditions: readonly string[];
}

export const ROBOTS_EXCEPTIONS: readonly RobotsException[] = [
    {
        host: 'clinicaltrials.gov',
        endpoints: ['/api/v2/studies', '/api/v2/version'],
        why: 'public, keyless, versioned data API of the registry the connector reads; robots.txt disallows /api/ for every crawler',
        conditions: [
            'only /api/v2/studies and /api/v2/version are requested',
            'the Crawl-delay of 1 second declared in robots.txt is honoured (CT_CRAWL_DELAY_MS >= 1000)',
            'the requests carry the shared HTTP client user agent, never a browser identity',
            'a 403 answer ends the leg at once (the shared client does not retry it); a 429 is retried by the shared client with back-off, honouring Retry-After up to 120 s, and ends the leg when the retries are spent',
        ],
    },
];

/** The sections of the Chilean Diario Oficial that robots.txt allows: `Allow: /edicionelectronica/index.php` (normas generales). */
export const DIARIO_ROBOTS_ALLOWED_SECTIONS = ['normas_generales'] as const;

export function diarioSectionHeldReason(section: string): string {
    return (
        `section "${section}" of the Chilean Diario Oficial is held by the robots.txt policy (decision G4, ${ROBOTS_POLICY_DECIDED_ON}): ` +
        'https://www.diariooficial.interior.gob.cl/robots.txt disallows /edicionelectronica/ and allows only /edicionelectronica/index.php (normas_generales). ' +
        'Only "normas_generales" can be selected. Re-enable a section only by changing the policy, its tests and the captured robots.txt together.'
    );
}

export const DIFC_ROBOTS_HELD_REASON =
    `sub-source "difc" is held by the robots.txt policy (decision G4, ${ROBOTS_POLICY_DECIDED_ON}): https://www.difc.com/robots.txt disallows /api/ for every crawler ` +
    'and the DIFC register is read through POST https://www.difc.com/api/handleRequest. The ADGM register stays active. Re-enable DIFC only by changing the policy, ' +
    'its tests and the captured robots.txt together.';
