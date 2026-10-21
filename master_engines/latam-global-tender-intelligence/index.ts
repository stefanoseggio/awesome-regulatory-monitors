import type { EngineDefinition } from '../lib/router_core.js';
import { applyCatalogBilling } from '../pricing/apply_billing.js';
import { TENDERS_PRICING } from '../pricing/event_catalog.js';
import { arEntreRiosConnector } from './connectors/arEntreRios.js';
import { arSantaFeConnector } from './connectors/arSantaFe.js';
import { arTucumanConnector } from './connectors/arTucuman.js';
import { auGrantconnectConnector } from './connectors/auGrantconnect.js';
import { clDiarioOficialConnector } from './connectors/clDiarioOficial.js';
import { euTedConnector } from './connectors/euTed.js';
import { arCordobaHeldConnector, arMendozaConnector, arPbaConnector, arSaltaConnector } from './connectors/held_argentina.js';
import { adbProcurementConnector, idbProcurementConnector } from './connectors/heldMdb.js';
import { itLombardiaGrantsConnector } from './connectors/itLombardiaGrants.js';
import { usFloridaConnector } from './connectors/usFlorida.js';
import { worldBankNoticesConnector } from './connectors/worldBankNotices.js';

export const TENDERS_USER_AGENT = 'latam-global-tender-intelligence/0.1 (+https://github.com/stefanoseggio/awesome-regulatory-monitors)';

/**
 * Explicit registry - never glob the connectors directory. The three Argentine portals designated HELD by the
 * operator (`ar_salta`, `ar_mendoza`, `ar_pba`, `ar_cordoba`) must stay registered so that selecting one yields the held
 * reason instead of "unknown source".
 */
export const tendersEngine: EngineDefinition = applyCatalogBilling(
    {
        slug: 'latam-global-tender-intelligence',
        credentialFields: { socrataAppToken: { source: 'it_lombardia_grants', option: 'socrataAppToken' } },
        connectors: [
            arSantaFeConnector,
            arTucumanConnector,
            arEntreRiosConnector,
            clDiarioOficialConnector,
            euTedConnector,
            usFloridaConnector,
            worldBankNoticesConnector,
            itLombardiaGrantsConnector,
            auGrantconnectConnector,
            adbProcurementConnector,
            idbProcurementConnector,
            arCordobaHeldConnector,
            arSaltaConnector,
            arMendozaConnector,
            arPbaConnector,
        ],
    },
    TENDERS_PRICING,
);
