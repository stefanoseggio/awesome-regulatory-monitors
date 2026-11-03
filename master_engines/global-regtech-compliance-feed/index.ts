import type { EngineDefinition } from '../lib/router_core.js';
import { applyCatalogBilling } from '../pricing/apply_billing.js';
import { REGTECH_PRICING } from '../pricing/event_catalog.js';
import { aiCrawlerSignalsConnector } from './connectors/aiCrawlerSignals.js';
import { fdaEmaRecallsConnector } from './connectors/fdaEmaRecalls.js';
import { imoGisisConnector, parisMouConnector, tokyoMouConnector } from './connectors/heldMaritime.js';
import { ofacConnector } from './connectors/ofac.js';
import { secEnforcementConnector } from './connectors/secEnforcement.js';
import { ukModernSlaveryConnector } from './connectors/ukModernSlavery.js';
import { worldBankDebarredConnector } from './connectors/worldBankDebarred.js';

export const REGTECH_USER_AGENT = 'global-regtech-compliance-feed/0.1 (+https://github.com/stefanoseggio/awesome-regulatory-monitors)';

/** Explicit registry - never glob the connectors directory. Held maritime registries stay registered so selecting one yields its reason. */
export const regtechEngine: EngineDefinition = applyCatalogBilling(
    {
        slug: 'global-regtech-compliance-feed',
        credentialFields: { fdaApiKey: { source: 'fda_ema_recalls', option: 'fdaApiKey' } },
        connectors: [
            ofacConnector,
            worldBankDebarredConnector,
            ukModernSlaveryConnector,
            secEnforcementConnector,
            aiCrawlerSignalsConnector,
            fdaEmaRecallsConnector,
            parisMouConnector,
            tokyoMouConnector,
            imoGisisConnector,
        ],
    },
    REGTECH_PRICING,
);
