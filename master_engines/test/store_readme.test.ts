/**
 * Finding F-20 of the pre-publication review of 2026-11-02: the staged build context carried no README, so every pushed Actor
 * would have shown an empty README page. The Store READMEs live in `store_listings/<slug>.README.md`, `scripts/stage_actor.ts`
 * copies the one of the staged engine to `<stage>/README.md`, and this file checks that each README says what the code does:
 * the sources, the held sources, the credentials, the billed events (by the titles of the Pricing tab), the defaults and the
 * memory behind the start event. It also keeps price figures and off-platform links out (Terms 2.2.4.2(i); a price written
 * into a README goes stale at the first price change).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { PATENTS_PRICING, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';
import { buildInputSchema } from '../scripts/actor_files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARGETS = [
    { engine: regtechEngine, pricing: REGTECH_PRICING },
    { engine: tendersEngine, pricing: TENDERS_PRICING },
    { engine: patentsEngine, pricing: PATENTS_PRICING },
];

const readmeOf = (slug: string): string => readFileSync(join(ROOT, 'store_listings', `${slug}.README.md`), 'utf8');

describe.each(TARGETS.map((t) => [t.engine.slug, t] as const))('%s Store README', (slug, { engine, pricing }) => {
    const readme = readmeOf(slug);
    const schema = buildInputSchema(engine) as { properties: Record<string, { default?: unknown; minimum?: number; maximum?: number; isSecret?: boolean }> };
    const covered = readme.slice(readme.indexOf('## What is covered'), readme.indexOf('## How to use it'));

    it('starts with the product name and has the sections a buyer needs', () => {
        expect(readme.startsWith('# ')).toBe(true);
        for (const heading of ['## What is covered', '## How to use it', '## Delta modes', '## Output', '## Watchlist', '## Pricing', '### Control your spend', '## Credentials', '## Data sources and licences', '## Disclaimer', '## Support']) {
            expect(readme, heading).toContain(heading);
        }
    });

    it('has one row in the coverage table for each active source and for nothing else', () => {
        const rows = [...covered.matchAll(/^\| `([a-z_]+)` \|/gmu)].map((m) => m[1]);
        expect(rows.sort()).toEqual(engine.connectors.filter((c) => c.status === 'active').map((c) => c.id).sort());
    });

    it('names every held source, and says that selecting one stops the run before any request or charge', () => {
        for (const held of engine.connectors.filter((c) => c.status === 'held')) expect(readme, held.id).toContain(`\`${held.id}\``);
        if (engine.connectors.some((c) => c.status === 'held')) expect(readme).toMatch(/before any request to a source is made and before any record is billed/u);
        if (engine.connectors.some((c) => c.status === 'held')) expect(readme).toContain('the platform still charges the start event of a run that has started');
    });

    it('names every credential field of the engine, and no secret the engine does not have', () => {
        for (const key of Object.keys(engine.credentialFields ?? {})) expect(readme, key).toContain(`\`${key}\``);
        for (const key of Object.keys(schema.properties).filter((k) => schema.properties[k]?.isSecret)) expect(readme, key).toContain(`\`${key}\``);
        expect(readme).not.toMatch(/\b(?:apiKey|api_key|token|password)\s*[:=]\s*["'][^"']{6,}/iu);
    });

    it('names every pay-per-event title of the engine except the start event, by the title the Pricing tab shows', () => {
        for (const event of pricing.events) expect(readme, `${slug}/${event.name}`).toContain(event.title);
        expect(readme).toContain('Actor start');
        expect(readme).toContain('Pricing** tab');
    });

    it('states the memory behind the start event as the catalogue pins it', () => {
        const gb = pricing.memoryMbytes / 1024;
        expect(readme).toContain(`This Actor uses ${gb} GB`);
    });

    it('quotes the input defaults and limits of the input schema, not other numbers', () => {
        expect(schema.properties.maxItemsPerSource).toMatchObject({ default: 500, minimum: 1, maximum: 10000 });
        expect(schema.properties.maxWatchlistHitsPerRun?.default).toBe(200);
        expect(schema.properties.maxWatchlistSpendUsd?.default).toBe(50);
        expect(readme).toContain('records (default 500, range 1 to 10,000)');
        expect(readme).toContain('`maxWatchlistHitsPerRun` (default 200)');
        expect(readme).toContain('`maxWatchlistSpendUsd` (default 50)');
    });

    it('says what the prefilled form does and what a scheduled Task should use instead (F-23)', () => {
        expect(readme).toContain('The form is prefilled with a small snapshot (`deltaMode: "all"`, 10 records per source)');
        expect(readme).toContain('for a scheduled Task set `deltaMode` to `onlyChanged` and raise `maxItemsPerSource`');
    });

    it('discloses what the first run, the full-snapshot mode and the watchlist bill', () => {
        expect(readme).toMatch(/first run of a source delivers up to `maxItemsPerSource` records[^.]*and bills each one/u);
        expect(readme).toMatch(/With `deltaMode: "all"` every delivered record is billed/u);
        expect(readme).toContain('billed a **Watchlist hit** event on top of its row event');
    });

    it('writes no price figure, no real-time claim and no off-platform link or contact', () => {
        expect(readme).not.toMatch(/[$€£]\s?\d|\bUSD\s?\d|\d\s?(?:USD|dollars?|cents?)\b/iu);
        expect(readme).not.toMatch(/real[- ]?time|(?<!consistency\s)guaranteed?\b|error-free/iu);
        const urls = readme.match(/https?:\/\/[^\s)]+/gu) ?? [];
        expect(urls).toEqual([`https://apify.com/stefano_seggio/${slug}/issues/open`]);
        expect(readme).not.toMatch(/linkedin|github\.com|pypi|n8n|langchain|@\w+\.\w+/iu);
    });

    it('does not describe a hold-released or unverified source as available', () => {
        // The World Bank source reads the "Other Sanctions" table only (F-18): the README must say so next to its row.
        if (slug === 'global-regtech-compliance-feed') {
            expect(readme).toMatch(/not the World Bank debarment register/iu);
            expect(readme).toMatch(/never means "not debarred"/u);
        }
        if (slug === 'global-corporate-patent-intelligence') expect(readme).toContain('`ae_registers` (ADGM');
        if (slug === 'latam-global-tender-intelligence') expect(readme).toMatch(/normas generales/u);
    });
});

describe.each(TARGETS.map((t) => t.engine.slug))('%s staged build context', (slug) => {
    let staged = '';

    beforeAll(() => {
        staged = mkdtempSync(join(tmpdir(), 'store-readme-'));
        const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'stage_actor.ts'), slug, `--out=${staged}`], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
        if (result.status !== 0) throw new Error(`stage_actor failed (${result.status}): ${result.stderr}`);
    }, 120_000);

    afterAll(() => {
        if (staged !== '') rmSync(staged, { recursive: true, force: true });
    });

    it('carries README.md at the root, byte for byte the committed Store README', () => {
        expect(readFileSync(join(staged, 'README.md'), 'utf8')).toBe(readmeOf(slug));
    });
});
