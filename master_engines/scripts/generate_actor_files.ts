/**
 * Writes <engine>/.actor/{actor.json,input_schema.json,Dockerfile} for the three engines from their registries.
 *   npx tsx scripts/generate_actor_files.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { PATENTS_PRICING, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';
import { buildActorJson, buildDockerfile, buildInputSchema } from './actor_files.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
    { engine: regtechEngine, pricing: REGTECH_PRICING },
    { engine: tendersEngine, pricing: TENDERS_PRICING },
    { engine: patentsEngine, pricing: PATENTS_PRICING },
];

for (const { engine, pricing } of targets) {
    const dir = join(root, engine.slug, '.actor');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'actor.json'), `${JSON.stringify(buildActorJson(engine, pricing), null, 4)}\n`);
    await writeFile(join(dir, 'input_schema.json'), `${JSON.stringify(buildInputSchema(engine), null, 4)}\n`);
    await writeFile(join(dir, 'Dockerfile'), buildDockerfile(engine));
    console.log(`${engine.slug}: wrote ${dir}`);
}
