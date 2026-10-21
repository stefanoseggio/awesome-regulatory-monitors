/**
 * Pure builders for each engine's `.actor/actor.json`, `.actor/input_schema.json` and `Dockerfile`, derived from the
 * engine registry so the source list, option keys and credential fields can never drift from the code.
 * The JSON shapes mirror the deployed legacy actors (e.g. actor-21-patent-ip-enforcement-monitor/.actor/).
 */
import type { EngineDefinition } from '../lib/router_core.js';
import { DELTA_MODES } from '../lib/types.js';
import type { EnginePricing } from '../pricing/event_catalog.js';

export interface EngineMeta {
    title: string;
    description: string;
    /**
     * The `sourceOptions` example shown in the input form: JSON keyed by a source id of THIS engine, with options that
     * source really accepts (a test parses it against the source's own options schema).
     */
    sourceOptionsExample: string;
}

export const ENGINE_META: Record<string, EngineMeta> = {
    'global-regtech-compliance-feed': {
        title: 'Global RegTech Compliance Feed - sanctions, enforcement, debarment, recalls',
        description:
            'One Actor, six regulatory delta sources: OFAC sanctioned vessels, World Bank sanctions, UK Modern Slavery statements, SEC enforcement releases, AI-crawler permission signals and FDA/EMA drug-safety records. Choose sources per run, keep per-source options, and receive only new or changed records.',
        sourceOptionsExample: '{"fda_ema_recalls": {"subSources": ["fda"]}}',
    },
    'latam-global-tender-intelligence': {
        title: 'LatAm & Global Tender Intelligence - public procurement delta feed',
        description:
            'One Actor for public tenders and grants: Argentine provincial portals (Santa Fe, Tucuman, Entre Rios), Chile Diario Oficial, EU TED, Florida MFMP, World Bank notices and Regione Lombardia grants. Held sources (ar_cordoba, ar_salta, ar_mendoza, ar_pba, au_grantconnect, ADB, IDB) are refused with their reason.',
        sourceOptionsExample: '{"us_florida": {"includeContactDetails": true}}',
    },
    'global-corporate-patent-intelligence': {
        title: 'Global Corporate & Patent Intelligence - PTAB, EPO, trials, company registers',
        description:
            'One Actor for corporate and IP change monitoring: USPTO PTAB trials and EPO opposition watch (bring your own keys), ClinicalTrials.gov + FDA Orange Book, Singapore ACRA and UAE (ADGM/DIFC) registers. Receive only new or changed records.',
        sourceOptionsExample: '{"clinicaltrials_orange_book": {"sponsors": ["Pfizer"]}}',
    },
};

const SOURCE_TITLE_MAX = 90;

function firstSentence(text: string): string {
    const cut = text.split(/(?<=\.)\s/u)[0] ?? text;
    return cut.length > SOURCE_TITLE_MAX ? `${cut.slice(0, SOURCE_TITLE_MAX - 1)}…` : cut;
}

const CREDENTIAL_TITLES: Record<string, string> = {
    fdaApiKey: 'openFDA API key (optional)',
    socrataAppToken: 'Socrata app token (optional)',
    usptoOdpApiKey: 'USPTO Open Data Portal API key',
    epoOpsConsumerKey: 'EPO OPS consumer key',
    epoOpsConsumerSecret: 'EPO OPS consumer secret',
};

/**
 * The source the form pre-selects, and the one a run started with no input uses: the first active source that needs no
 * mandatory option. Pre-selecting a bring-your-own-key source would make the default input fail preflight, and the
 * Apify Store re-runs a published Actor on its default input to check that it works.
 */
export function defaultSourceFor(engine: EngineDefinition): string {
    const active = engine.connectors.filter((c) => c.status === 'active');
    const keyless = active.find((c) => (c.requiredOptions ?? []).length === 0);
    const chosen = keyless ?? active[0];
    if (!chosen) throw new Error(`${engine.slug} has no active source`);
    return chosen.id;
}

export function buildInputSchema(engine: EngineDefinition): Record<string, unknown> {
    const active = engine.connectors.filter((c) => c.status === 'active');
    const held = engine.connectors.filter((c) => c.status === 'held');
    const meta = ENGINE_META[engine.slug];
    if (!meta) throw new Error(`No ENGINE_META for ${engine.slug}`);
    const properties: Record<string, unknown> = {
        sources: {
            title: 'Sources to run',
            type: 'array',
            description: `Source ids to run in this execution. Held sources are not selectable: ${held.map((c) => c.id).join(', ') || 'none'}.`,
            editor: 'select',
            items: { type: 'string', enum: active.map((c) => c.id), enumTitles: active.map((c) => firstSentence(c.description)) },
            default: [defaultSourceFor(engine)],
            minItems: 1,
        },
        sourceOptions: {
            title: 'Per-source options',
            type: 'object',
            description:
                `Options keyed by source id, e.g. ${meta.sourceOptionsExample}. Each source validates its own slice and rejects unknown keys. Put credentials in the secret fields below, not here.`,
            editor: 'json',
            default: {},
        },
        deltaMode: {
            title: 'Delta mode',
            type: 'string',
            description: 'onlyChanged = new and changed records (default). onlyNew = new records only. all = every record, unchanged ones included.',
            editor: 'select',
            enum: [...DELTA_MODES],
            enumTitles: ['All records (snapshot)', 'New and changed records', 'New records only'],
            default: 'onlyChanged',
        },
        stateNamespace: {
            title: 'Delta memory namespace',
            type: 'string',
            description:
                'Keeps delta memory separate between Tasks (different watchlists, filters or delta modes would otherwise consume each other\'s "new" records). Leave empty to use one namespace per Task, or "default" for ad-hoc runs. 1-40 characters: a-z, 0-9, "-".',
            editor: 'textfield',
        },
        maxItemsPerSource: { title: 'Max records per source', type: 'integer', description: 'Upper bound on records taken from each source in one run.', minimum: 1, maximum: 10000, default: 500 },
        watchlistNames: {
            title: 'Watchlist keywords',
            type: 'array',
            description:
                'Case-insensitive substrings matched against each record\'s names. Entries shorter than 2 characters, blank or punctuation-only entries are ignored. With no valid keyword nothing matches and the watchlist-hit event is never charged.',
            editor: 'stringList',
            default: [],
        },
        maxWatchlistHitsPerRun: { title: 'Max billable watchlist hits per run', type: 'integer', description: 'Hard ceiling on watchlist-hit events charged in one run.', minimum: 0, maximum: 100000, default: 200 },
        maxWatchlistSpendUsd: { title: 'Max watchlist-hit spend per run (USD)', type: 'number', description: 'Hard ceiling on USD charged for watchlist-hit in one run.', minimum: 0, maximum: 10000, default: 50 },
    };
    for (const [key, target] of Object.entries(engine.credentialFields ?? {})) {
        properties[key] = {
            title: CREDENTIAL_TITLES[key] ?? key,
            type: 'string',
            description: `Bring-your-own credential for ${target.source}. Stored encrypted by Apify and never logged.`,
            editor: 'textfield',
            isSecret: true,
        };
    }
    return {
        $schema: 'https://apify.com/schemas/v1/input.ide.json',
        title: `${engine.slug} configuration`,
        type: 'object',
        schemaVersion: 1,
        properties,
        required: ['sources'],
    };
}

export function buildActorJson(engine: EngineDefinition, pricing: EnginePricing): Record<string, unknown> {
    const meta = ENGINE_META[engine.slug];
    if (!meta) throw new Error(`No ENGINE_META for ${engine.slug}`);
    return {
        $schema: 'https://apify.com/schemas/v1/actor.ide.json',
        actorSpecification: 1,
        name: engine.slug,
        title: meta.title,
        description: meta.description,
        version: '0.1',
        buildTag: 'latest',
        // Pinned: apify-actor-start is charged once per GB of memory, so the run's start cost is only what pricing says
        // if memory cannot be raised above the value the pricing was computed for.
        minMemoryMbytes: pricing.memoryMbytes,
        maxMemoryMbytes: pricing.memoryMbytes,
        inputSchema: './input_schema.json',
    };
}

export function buildDockerfile(engine: EngineDefinition): string {
    const meta = ENGINE_META[engine.slug];
    if (!meta) throw new Error(`No ENGINE_META for ${engine.slug}`);
    return `FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./

RUN npm ci --include=dev

COPY --chown=myuser:myuser . ./

RUN npm run build

FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \\
    && npm ci --omit=dev --omit=optional \\
    && echo "Node.js version:" \\
    && node --version \\
    && rm -r ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

COPY --chown=myuser:myuser . ./

CMD ["node", "dist/${engine.slug}/main.js"]
`;
}
