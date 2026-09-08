#!/usr/bin/env node
/**
 * runAll.js - unified loader for the awesome-regulatory-monitors actor fleet.
 *
 * Runs one or more actors from the directory in README.md with a shared
 * delta flag, and prints a consolidated summary across sources. Each
 * actor's own real input fields are respected - this script only sets the
 * delta flag and whatever common fields you pass via --extra-input.
 *
 * Usage:
 *   npm install apify-client
 *   export APIFY_TOKEN=your_token_here
 *   node runAll.js --actors actor-19-maritime-sanctions-monitor actor-22-drug-safety-recalls-monitor
 *   node runAll.js --all
 */

import { ApifyClient } from 'apify-client';

const OWNER = 'stefano_seggio';

// Real actor directory, actor slug -> its real delta-flag field name (NOT
// identical across the fleet - actor-18 uses skipKnownLeads (no
// content-change concept, only "seen before"); primer-actor uses
// onlyChanged (per-URL content-change tracking, not a registry listing).
const ACTOR_DELTA_FLAGS = {
    'australia-grantconnect-monitor': 'onlyNew',
    'uk-hse-enforcement-monitor': 'onlyNew',
    'florida-tenders-monitor': 'onlyNew',
    'santafe-compras-monitor': 'onlyNew',
    'tucuman-compras-monitor': 'onlyNew',
    'salta-compras-monitor': 'onlyNew',
    'mendoza-compras-monitor': 'onlyNew',
    'entrerios-compras-monitor': 'onlyNew',
    'cordoba-compras-monitor': 'onlyNew',
    'pba-tenders-monitor': 'onlyNew',
    'diario-oficial-cl-monitor': 'onlyNew',
    'primer-actor': 'onlyChanged',
    'actor-18-b2b-lead-magnet': 'skipKnownLeads',
    'actor-19-maritime-sanctions-monitor': 'onlyNew',
    'actor-20-mdb-procurement-monitor': 'onlyNew',
    'actor-21-patent-ip-enforcement-monitor': 'onlyNew',
    'actor-22-drug-safety-recalls-monitor': 'onlyNew',
};

function parseArgs(argv) {
    const args = { actors: [], all: false, extraInput: {} };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--all') args.all = true;
        else if (argv[i] === '--actors') {
            while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.actors.push(argv[++i]);
        } else if (argv[i] === '--extra-input') {
            args.extraInput = JSON.parse(argv[++i]);
        }
    }
    return args;
}

async function runOne(client, actorSlug, extraInput) {
    const deltaFlag = ACTOR_DELTA_FLAGS[actorSlug];
    const runInput = { ...extraInput };
    if (deltaFlag && !(deltaFlag in runInput)) runInput[deltaFlag] = true;

    console.log(`--- Running ${actorSlug} (input: ${JSON.stringify(runInput)}) ---`);
    const run = await client.actor(`${OWNER}/${actorSlug}`).call(runInput);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log(`    ${items.length} item(s) returned, run status: ${run.status}`);
    return { actor: actorSlug, runId: run.id, itemCount: items.length, status: run.status };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const token = process.env.APIFY_TOKEN;
    if (!token) {
        console.error('Error: set the APIFY_TOKEN environment variable first.');
        process.exit(1);
    }

    const actorsToRun = args.all ? Object.keys(ACTOR_DELTA_FLAGS) : args.actors;
    if (actorsToRun.length === 0) {
        console.error('Nothing to run - pass --actors <slug...> or --all. See README.md for the full actor directory.');
        process.exit(1);
    }

    const client = new ApifyClient({ token });
    const results = [];
    for (const slug of actorsToRun) {
        results.push(await runOne(client, slug, args.extraInput));
    }

    console.log('\n=== Summary ===');
    for (const r of results) {
        console.log(`${r.actor}: ${r.itemCount} item(s), status=${r.status}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
