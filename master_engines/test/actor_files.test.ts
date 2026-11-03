import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { ALL_PRICING, PATENTS_PRICING, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';
import { EngineInputSchema, resolveSources } from '../lib/router_core.js';
import { buildActorJson, buildDockerfile, buildInputSchema, buildOutputSchema, ENGINE_META, STORE_TEST_MAX_ITEMS } from '../scripts/actor_files.js';

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

    it('prefills the input of the Store daily test: the default source, a small snapshot, no credential (F-23)', () => {
        const prefill = { sources: schema.properties.sources.prefill, deltaMode: schema.properties.deltaMode.prefill, maxItemsPerSource: schema.properties.maxItemsPerSource.prefill };
        expect(prefill.sources).toEqual(schema.properties.sources.default);
        expect(prefill.deltaMode).toBe('all');
        expect(prefill.maxItemsPerSource).toBe(STORE_TEST_MAX_ITEMS);
        expect(STORE_TEST_MAX_ITEMS).toBeLessThanOrEqual(25);
        for (const [key, property] of Object.entries(schema.properties)) {
            if (!['sources', 'deltaMode', 'maxItemsPerSource'].includes(key)) expect(property.prefill, `${key} must not be prefilled`).toBeUndefined();
        }
        // the prefilled input is a valid run input and resolves to exactly the default source, which needs no credential
        const input = EngineInputSchema.parse(prefill);
        expect(resolveSources(engine, input).map((r) => r.connector.id)).toEqual(prefill.sources);
        // and the field defaults are still what a scheduled Task needs
        expect(schema.properties.deltaMode.default).toBe('onlyChanged');
        expect(schema.properties.maxItemsPerSource.default).toBe(500);
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
        expect(JSON.parse(await readFile(`${dir}output_schema.json`, 'utf8'))).toEqual(buildOutputSchema(engine));
    });

    it('declares an output schema, which the platform requires before it lets an Actor be published (F-27)', () => {
        const actor = buildActorJson(engine, pricing) as Record<string, unknown>;
        expect(actor.output).toBe('./output_schema.json');
        const output = buildOutputSchema(engine) as { actorOutputSchemaVersion: number; title: string; properties: Record<string, { type: string; title: string; template: string }> };
        expect(output.actorOutputSchemaVersion).toBe(1);
        expect(output.title.length).toBeGreaterThan(0);
        expect(Object.keys(output.properties)).toEqual(['records', 'runSummary']);
        for (const [key, property] of Object.entries(output.properties)) {
            expect(property.title.length, key).toBeGreaterThan(0);
            expect(property.type, key).toBe('string');
        }
        // the templates point at what the engines really write: the default dataset and the RUN_SUMMARY record
        expect(output.properties.records?.template).toBe('{{links.apiDefaultDatasetUrl}}/items');
        expect(output.properties.runSummary?.template).toBe('{{links.apiDefaultKeyValueStoreUrl}}/records/RUN_SUMMARY');
    });
});

describe('engine-specific build details', () => {
    it('no engine image adds a trust anchor: the only source that needed one (ar_cordoba) is held', () => {
        for (const { engine } of TARGETS) expect(buildDockerfile(engine)).not.toContain('NODE_EXTRA_CA_CERTS');
    });

    it('installs reproducibly from the lockfile (npm ci)', () => {
        for (const { engine } of TARGETS) {
            const docker = buildDockerfile(engine);
            expect(docker).toContain('npm ci --include=dev');
            expect(docker).toContain('npm ci --omit=dev');
            expect(docker).not.toContain('npm install');
        }
    });

    it('offers the stateNamespace input', () => {
        for (const { engine } of TARGETS) {
            expect((buildInputSchema(engine) as { properties: Record<string, unknown> }).properties.stateNamespace).toMatchObject({ type: 'string' });
        }
    });

    it('has metadata and pricing for every engine', () => {
        expect(Object.keys(ENGINE_META).sort()).toEqual(ALL_PRICING.map((p) => p.engine).sort());
    });
});
