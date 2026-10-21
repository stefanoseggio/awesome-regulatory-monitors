import type { EngineDefinition } from '../lib/router_core.js';
import { aiCrawlerSignalsConnector } from './connectors/aiCrawlerSignals.js';
import { fdaEmaRecallsConnector } from './connectors/fdaEmaRecalls.js';
import { imoGisisConnector, parisMouConnector, tokyoMouConnector } from './connectors/heldMaritime.js';
import { ofacConnector } from './connectors/ofac.js';
import { secEnforcementConnector } from './connectors/secEnforcement.js';
import { ukModernSlaveryConnector } from './connectors/ukModernSlavery.js';
import { worldBankDebarredConnector } from './connectors/worldBankDebarred.js';

export const REGTECH_USER_AGENT = 'global-regtech-compliance-feed/0.1 (+https://github.com/stefanoseggio/awesome-regulatory-monitors)';

export const regtechEngine: EngineDefinition = {
    slug: 'global-regtech-compliance-feed',
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
};
