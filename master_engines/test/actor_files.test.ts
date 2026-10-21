import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { ALL_PRICING, PATENTS_PRICING, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';
import { buildActorJson, buildDockerfile, buildInputSchema, ENGINE_META } from '../scripts/actor_files.js';

const TARGETS = [
    { engine: regtechEngine, pricing: REGTECH_PRICING },
    { engine: tendersEngine, pricing: TENDERS_PRICING },
    { engine: patentsEngine, pricing: PATENTS_PRICING },
];

describe.each(TARGETS.map((t) => [t.engine.slug, t] as const))('%s actor files', (slug, { engine, pricing }) => {
    const schema = buildInputSchema(engine) as { properties: Record<string, any>; required: string[] };

    it('offers exactly the active sources and none of the held ones', () => {
        const offered = schema.properties.sources.items.enum as string[];
        expect(offered.sort()).toEqual(engine.connectors.filter((c) => c.status === 'active').map((c) => c.id).sort());
        for (const held of engine.connectors.filter((c) => c.status === 'held')) expect(offered).not.toContain(held.id);
        expect(schema.properties.sources.items.enumTitles).toHaveLength(offered.length);
        expect(schema.properties.sources.default.every((id: string) => offered.includes(id))).toBe(true);
        expect(schema.required).toEqual(['sources']);
    });

    it('declares every router input with the router\'s own limits and defaults', () => {
        expect(schema.properties.deltaMode).toMatchObject({ enum: ['all', 'onlyChanged', 'onlyNew'], default: 'onlyChanged' });
        expect(schema.properties.maxItemsPerSource).toMatchObject({ minimum: 1, maximum: 10000, default: 500 });
        expect(schema.properties.watchlistNames).toMatchObject({ type: 'array', default: [] });
        expect(schema.properties.maxWatchlistHitsPerRun).toMatchObject({ default: 200 });
        expect(schema.properties.maxWatchlistSpendUsd).toMatchObject({ default: 50 });
    });

    it('exposes every credential as a top-level isSecret string field', () => {
        for (const key of Object.keys(engine.credentialFields ?? {})) {
            expect(schema.properties[key], key).toMatchObject({ type: 'string', isSecret: true, editor: 'textfield' });
        }
    });

    it('pins memory so the per-GB start event cost matches the pricing', () => {
        const actor = buildActorJson(engine, pricing) as Record<string, unknown>;
        expect(actor.name).toBe(slug);
        expect(actor.minMemoryMbytes).toBe(pricing.memoryMbytes);
        expect(actor.maxMemoryMbytes).toBe(pricing.memoryMbytes);
        expect(actor.inputSchema).toBe('./input_schema.json');
    });

    it('builds from the engine entrypoint', () => {
        expect(buildDockerfile(engine)).toContain(`CMD ["node", "dist/${slug}/main.js"]`);
    });

    it('committed .actor files match the generators', async () => {
        const dir = fileURLToPath(new URL(`../${slug}/.actor/`, import.meta.url));
        expect(JSON.parse(await readFile(`${dir}actor.json`, 'utf8'))).toEqual(buildActorJson(engine, pricing));
        expect(JSON.parse(await readFile(`${dir}input_schema.json`, 'utf8'))).toEqual(buildInputSchema(engine));
        expect(await readFile(`${dir}Dockerfile`, 'utf8')).toBe(buildDockerfile(engine));
    });
});

describe('engine-specific build details', () => {
    it('only the tenders image trusts the Cordoba CA bundle', () => {
        expect(buildDockerfile(tendersEngine)).toContain('NODE_EXTRA_CA_CERTS=/usr/src/app/certs/cordoba-sectigo-chain.pem');
        expect(buildDockerfile(regtechEngine)).not.toContain('NODE_EXTRA_CA_CERTS');
        expect(buildDockerfile(patentsEngine)).not.toContain('NODE_EXTRA_CA_CERTS');
    });

    it('has metadata and pricing for every engine', () => {
        expect(Object.keys(ENGINE_META).sort()).toEqual(ALL_PRICING.map((p) => p.engine).sort());
    });
});
