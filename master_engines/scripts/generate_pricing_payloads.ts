/**
 * Writes pricing/payloads/<engine>.put.json (the exact PUT body) and <engine>.notice.json (the 14-day notice
 * metadata) from pricing/event_catalog.ts. It never calls the Apify API.
 *
 *   npx tsx scripts/generate_pricing_payloads.ts --now=2026-10-21T00:00:00.000Z [--paying-users=false] [--strict]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPricingPutBody } from '../pricing/build_put_payloads.js';
import { ALL_PRICING } from '../pricing/event_catalog.js';

function arg(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const now = arg('now');
if (!now || Number.isNaN(Date.parse(now))) {
    console.error('Usage: generate_pricing_payloads.ts --now=<ISO-8601 instant> [--paying-users=true|false] [--strict]');
    process.exit(2);
}
const hasPayingUsers = arg('paying-users') !== 'false';
const strict = process.argv.includes('--strict');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'pricing', 'payloads');
await mkdir(outDir, { recursive: true });

for (const pricing of ALL_PRICING) {
    const { body, notice } = buildPricingPutBody(pricing, { now, hasPayingUsers, strict });
    await writeFile(join(outDir, `${pricing.engine}.put.json`), `${JSON.stringify(body, null, 4)}\n`);
    await writeFile(join(outDir, `${pricing.engine}.notice.json`), `${JSON.stringify(notice, null, 4)}\n`);
    console.log(`${pricing.engine}: ${Object.keys(body.pricingInfos[0]?.pricingPerEvent.actorChargeEvents ?? {}).length} events, effective ${notice.effectiveAt}`);
}
