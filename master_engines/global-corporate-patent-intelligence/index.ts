import type { EngineDefinition } from '../lib/router_core.js';
import { applyCatalogBilling } from '../pricing/apply_billing.js';
import { PATENTS_PRICING } from '../pricing/event_catalog.js';
import { aeRegistersConnector } from './connectors/aeRegisters.js';
import { clinicaltrialsOrangeBookConnector } from './connectors/clinicaltrialsOrangeBook.js';
import { epoOppositionConnector } from './connectors/epoOpposition.js';
import { sgAcraConnector } from './connectors/sgAcra.js';
import { usptoPtabConnector } from './connectors/usptoPtab.js';

export const PATENTS_USER_AGENT = 'global-corporate-patent-intelligence/0.1 (+https://github.com/stefanoseggio/awesome-regulatory-monitors)';

/** Explicit registry - never glob the connectors directory. */
export const patentsEngine: EngineDefinition = applyCatalogBilling(
    {
        slug: 'global-corporate-patent-intelligence',
        credentialFields: {
            usptoOdpApiKey: { source: 'uspto_ptab', option: 'usptoOdpApiKey' },
            epoOpsConsumerKey: { source: 'epo_opposition', option: 'epoOpsConsumerKey' },
            epoOpsConsumerSecret: { source: 'epo_opposition', option: 'epoOpsConsumerSecret' },
            fdaApiKey: { source: 'clinicaltrials_orange_book', option: 'fdaApiKey' },
        },
        connectors: [usptoPtabConnector, epoOppositionConnector, clinicaltrialsOrangeBookConnector, sgAcraConnector, aeRegistersConnector],
    },
    PATENTS_PRICING,
);
