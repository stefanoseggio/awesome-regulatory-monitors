/**
 * The robots.txt policy of the engines (decision G4, 2026-11-02; lib/robots_policy.ts), checked against the captured robots.txt of each host with the engines' own matcher.
 *
 * ONE RULE: an active connector requests only URLs that the host's robots.txt does not disallow for `User-agent: *`; what would break it is held and refused at preflight;
 * the ClinicalTrials.gov API is the single recorded exception. If a robots.txt changes, re-capture it into test/fixtures/robots/ and let these tests say what moved.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluateBotPermission, parseRobotsTxt } from '../global-regtech-compliance-feed/connectors/aiCrawlerSignals.js';
import { ADGM_AURA_ENDPOINT, ADGM_SEARCH_PAGE_URL, AE_ACTIVE_SUB_SOURCES, aeRegistersOptionsSchema, DIFC_HANDLE_REQUEST_URL } from '../global-corporate-patent-intelligence/connectors/aeRegisters.js';
import { CLINICALTRIALS_STUDIES_URL, CT_CRAWL_DELAY_MS } from '../global-corporate-patent-intelligence/connectors/clinicaltrialsOrangeBook.js';
import { buildSectionUrl, SECTION_NAMES } from '../latam-global-tender-intelligence/connectors/clDiarioOficial.js';
import { DIARIO_ROBOTS_ALLOWED_SECTIONS, DIFC_ROBOTS_HELD_REASON, ROBOTS_EXCEPTIONS, ROBOTS_POLICY_DECIDED_ON } from '../lib/robots_policy.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'robots');
const capture = (name: string): string => readFileSync(join(FIXTURES, `${name}.robots.txt`), 'utf8');

/** Whether the captured robots.txt of the URL's host disallows the URL for `User-agent: *` (RFC 9309 longest match, Allow wins a tie). */
function disallowed(fixture: string, url: string): boolean {
    const parsed = parseRobotsTxt(capture(fixture));
    const target = new URL(url);
    return evaluateBotPermission(parsed, '*', `${target.pathname}${target.search}`).directive === 'disallow';
}

describe('robots.txt policy (decision G4)', () => {
    it('the decision is dated and the captures are the ones it was taken on', () => {
        expect(ROBOTS_POLICY_DECIDED_ON).toBe('2026-11-02');
        // the four hosts of the decision, byte for byte as fetched on 2026-11-02
        expect(capture('clinicaltrials.gov')).toContain('Disallow: /api/');
        expect(capture('diariooficial.interior.gob.cl')).toContain('Allow: /edicionelectronica/index.php');
        expect(capture('difc.com')).toContain('Disallow: /api/');
        expect(capture('newreg.adgm.com')).toContain('Allow: /');
    });

    it('ADGM stays active: the two URLs of the ADGM register are not disallowed', () => {
        expect(disallowed('newreg.adgm.com', ADGM_SEARCH_PAGE_URL)).toBe(false);
        expect(disallowed('newreg.adgm.com', ADGM_AURA_ENDPOINT)).toBe(false);
        expect(AE_ACTIVE_SUB_SOURCES).toEqual(['adgm']);
    });

    it('DIFC is held: its API path is disallowed, it is not an active sub-source, and a caller who selects it gets the policy as the reason', () => {
        expect(disallowed('difc.com', DIFC_HANDLE_REQUEST_URL)).toBe(true);
        expect(AE_ACTIVE_SUB_SOURCES).not.toContain('difc');
        const refused = aeRegistersOptionsSchema.safeParse({ subSources: ['difc'] });
        expect(refused.success).toBe(false);
        expect(refused.success ? '' : refused.error.issues.map((issue) => issue.message).join(' | ')).toContain(DIFC_ROBOTS_HELD_REASON);
    });

    it('Diario Oficial: exactly the sections that robots.txt disallows are the ones that are held; normas_generales (index.php) is allowed', () => {
        const disallowedSections = SECTION_NAMES.filter((name) => disallowed('diariooficial.interior.gob.cl', buildSectionUrl(name)));
        const allowedSections = SECTION_NAMES.filter((name) => !disallowedSections.includes(name));
        expect(allowedSections).toEqual([...DIARIO_ROBOTS_ALLOWED_SECTIONS]);
        expect(disallowedSections).toHaveLength(6);
        expect(disallowedSections).toEqual(SECTION_NAMES.filter((name) => name !== 'normas_generales'));
    });

    it('the ClinicalTrials.gov API is disallowed by robots.txt and is the ONE recorded exception, with its conditions', () => {
        expect(disallowed('clinicaltrials.gov', CLINICALTRIALS_STUDIES_URL)).toBe(true);
        expect(ROBOTS_EXCEPTIONS).toHaveLength(1);
        const [exception] = ROBOTS_EXCEPTIONS;
        expect(exception?.host).toBe('clinicaltrials.gov');
        expect(exception?.endpoints).toContain(new URL(CLINICALTRIALS_STUDIES_URL).pathname);
        // every exception endpoint stays under the documented versioned API, never the site's own pages
        for (const endpoint of exception?.endpoints ?? []) expect(endpoint.startsWith('/api/v2/')).toBe(true);
        // the condition that the code can meet: the Crawl-delay declared in robots.txt is honoured
        const declared = /^Crawl-delay:\s*(\d+)/mu.exec(capture('clinicaltrials.gov'));
        expect(declared).not.toBeNull();
        expect(CT_CRAWL_DELAY_MS).toBeGreaterThanOrEqual(Number(declared?.[1]) * 1000);
        expect(exception?.conditions.some((condition) => condition.includes('Crawl-delay'))).toBe(true);
    });

    it('the rule, as one assertion: every endpoint an active connector requests is allowed by its host\'s robots.txt, or is the recorded exception', () => {
        const requested: Array<[string, string]> = [
            ['newreg.adgm.com', ADGM_SEARCH_PAGE_URL],
            ['newreg.adgm.com', ADGM_AURA_ENDPOINT],
            ['diariooficial.interior.gob.cl', buildSectionUrl('normas_generales')],
            ['clinicaltrials.gov', CLINICALTRIALS_STUDIES_URL],
        ];
        const breaking = requested.filter(([fixture, url]) => disallowed(fixture, url) && !ROBOTS_EXCEPTIONS.some((e) => e.host === new URL(url).host && e.endpoints.includes(new URL(url).pathname)));
        expect(breaking, 'an active endpoint that robots.txt disallows and no decision covers').toEqual([]);
    });

    it('the matcher agrees with the captured rules on cases that decide the policy (so the checks above cannot pass by accident)', () => {
        expect(disallowed('diariooficial.interior.gob.cl', 'https://www.diariooficial.interior.gob.cl/edicionelectronica/index.php?')).toBe(false);
        expect(disallowed('diariooficial.interior.gob.cl', 'https://www.diariooficial.interior.gob.cl/edicionelectronica/bom.php?')).toBe(true);
        expect(disallowed('diariooficial.interior.gob.cl', 'https://www.diariooficial.interior.gob.cl/media/x.pdf')).toBe(true);
        expect(disallowed('clinicaltrials.gov', 'https://clinicaltrials.gov/api/int/studies')).toBe(false);
        expect(disallowed('clinicaltrials.gov', 'https://clinicaltrials.gov/study/NCT00000102')).toBe(false);
        expect(disallowed('difc.com', 'https://www.difc.com/business/public-register')).toBe(false);
    });
});
