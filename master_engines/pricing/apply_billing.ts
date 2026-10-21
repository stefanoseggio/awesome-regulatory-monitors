import type { EngineDefinition } from '../lib/router_core.js';
import type { Connector } from '../lib/types.js';
import { type EnginePricing, RECORD_LEVEL_EVENTS } from './event_catalog.js';

/**
 * Returns a copy of `engine` whose active connectors carry the `billing` mapping from the catalog.
 * A held connector is left untouched; an active connector with no catalog entry is an error, so a new source
 * can never ship silently billing the default `result` event.
 */
export function applyCatalogBilling(engine: EngineDefinition, pricing: EnginePricing): EngineDefinition {
    if (engine.slug !== pricing.engine) throw new Error(`Pricing for ${pricing.engine} applied to ${engine.slug}.`);
    const connectors: Array<Connector<any>> = engine.connectors.map((connector) => {
        if (connector.status === 'held') return connector;
        const billing = pricing.sourceBilling[connector.id];
        if (!billing) throw new Error(`Active connector "${connector.id}" has no entry in the ${pricing.engine} pricing catalog.`);
        return { ...connector, billing };
    });
    return { ...engine, connectors, extraBillingEvents: RECORD_LEVEL_EVENTS[engine.slug] };
}
