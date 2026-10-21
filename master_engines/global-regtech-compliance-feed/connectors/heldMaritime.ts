/**
 * Maritime registries evaluated and REJECTED by the legacy `actor-19-maritime-sanctions-monitor`
 * (live verification log in that actor's src/http.ts, items 3-4 and "NOT USED"). They stay in the registry as
 * `held` so selecting one fails preflight with the documented reason instead of "unknown source".
 */
import { createHeldConnector } from '../../lib/connector_helpers.js';

const ENGINE = 'global-regtech-compliance-feed' as const;
const LEGACY = 'actor-19-maritime-sanctions-monitor';

export const parisMouConnector = createHeldConnector({
    id: 'paris_mou_thetis',
    engine: ENGINE,
    legacyActor: LEGACY,
    description: 'Paris MoU / EMSA THETIS port-state-control detentions.',
    reason:
        'THETIS (portal.emsa.europa.eu) redirects every request, including its robots.txt, to a Keycloak OpenID Connect login. A login wall: rejected by the no-login-bypass rule (legacy verification 2026-09).',
});

export const tokyoMouConnector = createHeldConnector({
    id: 'tokyo_mou_apcis',
    engine: ENGINE,
    legacyActor: LEGACY,
    description: 'Tokyo MoU APCIS port-state-control database.',
    reason:
        'The public APCIS search form contains a CAPTCHA input (name="captcha"). Rejected by the no-CAPTCHA-solving rule (legacy verification 2026-09).',
});

export const imoGisisConnector = createHeldConnector({
    id: 'imo_gisis',
    engine: ENGINE,
    legacyActor: LEGACY,
    description: 'IMO GISIS public module.',
    reason:
        'Not used: gisis.imo.org robots.txt disallows /Members/, /Secretariat/ and /WebServices/, and the Public module is session/registration-gated for actual search. No open bulk feed was verified.',
});
