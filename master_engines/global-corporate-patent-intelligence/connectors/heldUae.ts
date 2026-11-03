/**
 * heldUae.ts - the UAE corporate registers, HELD (finding F-28, 2026-11-03).
 *
 * `ae_registers` (ADGM) was active in the first release. Every search of ADGM's Aura service answers a server-side error, so no row
 * has ever been obtained: the connector's own header records the outage from 2026-09-17 and again on 2026-10-21, and a platform run and a
 * local run on 2026-11-03 gave the same answer. The registry therefore carries this held connector; the connector itself stays in
 * connectors/aeRegisters.ts as dormant, tested code.
 */
import { createHeldConnector } from '../../lib/connector_helpers.js';

export const AE_REGISTERS_HOLD_REASON =
    "ADGM's public register (newreg.adgm.com, Aura RPC) answers every search with a server-side error, System.NullPointerException 'null input to JSON parser' at Class.RASearchUtil.getSearchResponseForPR line 2889: recorded from 2026-09-17 (legacy outage playbook), on 2026-10-21 and again on 2026-11-03, both from Apify's cloud and from Argentina. No row has ever been obtained, so the row parser is unproven. The DIFC register is disallowed by robots.txt (decision G4) and Dubai mainland licences are held (unverified wire protocol, access approval). Lift the hold when a search returns rows.";

export const aeRegistersHeldConnector = createHeldConnector({
    id: 'ae_registers',
    engine: 'global-corporate-patent-intelligence',
    legacyActor: 'uae-corporate-registry-monitor',
    description: 'UAE corporate registers (ADGM, DIFC, Dubai mainland). HELD: cannot be selected.',
    reason: AE_REGISTERS_HOLD_REASON,
});
