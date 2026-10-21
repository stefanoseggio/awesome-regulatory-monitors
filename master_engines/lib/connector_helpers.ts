/** Small pure helpers shared by connectors. Kept dependency-free. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { type Connector, type EngineSlug, FatalConfigError } from './types.js';

/** Stable short fingerprint of the consumer-visible fields of a record. `null`/`undefined` collapse to the same token. */
export function fingerprintOf(parts: ReadonlyArray<unknown>): string {
    const canonical = parts.map((p) => (p === null || p === undefined ? '' : typeof p === 'string' ? p : JSON.stringify(p))).join('␟');
    return createHash('sha1').update(canonical).digest('hex').slice(0, 20);
}

export const DATE_RANGES = ['24h', '7d', '30d', '90d', '365d'] as const;
export type DateRange = (typeof DATE_RANGES)[number];

/** `YYYY-MM-DD` for `now - range`, or `undefined` when no range is requested. */
export function dateRangeToFrom(range: DateRange | undefined, now: Date): string | undefined {
    if (!range) return undefined;
    const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range];
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export interface HeldConnectorSpec {
    id: string;
    engine: EngineSlug;
    legacyActor: string;
    description: string;
    reason: string;
}

/**
 * A registered-but-disabled source. It stays in the registry so that selecting it
 * fails preflight with a precise, auditable reason instead of "unknown source".
 */
export function createHeldConnector(spec: HeldConnectorSpec): Connector<Record<string, unknown>> {
    return {
        id: spec.id,
        engine: spec.engine,
        legacyActor: spec.legacyActor,
        description: spec.description,
        status: 'held',
        heldReason: spec.reason,
        optionsSchema: z.record(z.unknown()),
        async fetch() {
            throw new FatalConfigError(`Source "${spec.id}" is held: ${spec.reason}`);
        },
    };
}
