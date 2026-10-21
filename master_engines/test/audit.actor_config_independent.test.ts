/**
 * INDEPENDENT AUDIT of the committed Actor configuration (<engine>/.actor/actor.json, input_schema.json, Dockerfile).
 *
 * The files are read as plain text and checked against rules typed in this file. The test never calls
 * scripts/actor_files.ts. What is imported is only the thing being audited: the engine registries (active/held
 * connectors, credentialFields, option schemas), pricing/event_catalog.ts (memory) and lib/router_core.ts
 * (EngineInputSchema, the zod schema the input form must agree with).
 *
 * Rules typed from the official schemas https://apify.com/schemas/v1/actor.ide.json and .../input.ide.json
 * (fetched 2026-10-21): editor-per-type tables, memory enum, version pattern, the closed key set of actor.json.
 * The Dockerfile is audited both as text and, through scripts/stage_actor.ts into a temporary directory, as the
 * build context the platform really receives (that script is what makes "copies only lib, pricing and the engine"
 * true, because the Dockerfile itself runs `COPY . ./`).
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { regtechEngine } from '../global-regtech-compliance-feed/index.js';
import { patentsEngine } from '../global-corporate-patent-intelligence/index.js';
import { tendersEngine } from '../latam-global-tender-intelligence/index.js';
import { EngineInputSchema, type EngineDefinition, mergeCredentialFields, resolveSources } from '../lib/router_core.js';
import { PATENTS_PRICING, REGTECH_PRICING, TENDERS_PRICING } from '../pricing/event_catalog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

interface Case {
    slug: string;
    engine: EngineDefinition;
    memoryMbytes: number;
    /** Hand-typed expectation of engine.credentialFields: top-level key -> [source, option]. */
    credentials: Record<string, [string, string]>;
}

const CASES: Case[] = [
    { slug: 'global-regtech-compliance-feed', engine: regtechEngine, memoryMbytes: REGTECH_PRICING.memoryMbytes, credentials: { fdaApiKey: ['fda_ema_recalls', 'fdaApiKey'] } },
    { slug: 'latam-global-tender-intelligence', engine: tendersEngine, memoryMbytes: TENDERS_PRICING.memoryMbytes, credentials: { socrataAppToken: ['it_lombardia_grants', 'socrataAppToken'] } },
    {
        slug: 'global-corporate-patent-intelligence',
        engine: patentsEngine,
        memoryMbytes: PATENTS_PRICING.memoryMbytes,
        credentials: {
            usptoOdpApiKey: ['uspto_ptab', 'usptoOdpApiKey'],
            epoOpsConsumerKey: ['epo_opposition', 'epoOpsConsumerKey'],
            epoOpsConsumerSecret: ['epo_opposition', 'epoOpsConsumerSecret'],
            fdaApiKey: ['clinicaltrials_orange_book', 'fdaApiKey'],
        },
    },
];

/** Top-level keys of actor.json in the official schema (additionalProperties: false there). */
const ACTOR_JSON_OFFICIAL_KEYS = [
    '$schema',
    'actorSpecification',
    'buildTag',
    'changelog',
    'defaultMemoryMbytes',
    'description',
    'dockerContextDir',
    'dockerfile',
    'environmentVariables',
    'input',
    'inputSchema',
    'maxMemoryMbytes',
    'meta',
    'minMemoryMbytes',
    'name',
    'output',
    'outputSchema',
    'readme',
    'storages',
    'title',
    'usesStandbyMode',
    'version',
    'webServerMcpPath',
    'webServerSchema',
];
/**
 * No deviation from the official actor.json schema is tolerated. `categories` used to be written by the generator even
 * though it is NOT an actor.json property (the Store category is set in the Console or the API); it was removed, and
 * this test now fails if it, or any other unknown key, comes back.
 */
const KNOWN_REPORTED_ACTOR_JSON_DEVIATIONS: string[] = [];
/** Keys every committed actor.json must carry. */
const REQUIRED_ACTOR_JSON_KEYS = ['$schema', 'actorSpecification', 'buildTag', 'description', 'inputSchema', 'maxMemoryMbytes', 'minMemoryMbytes', 'name', 'title', 'version'];
/**
 * Keys an actor.json may carry besides the required ones: the reported deviation and an explicit Dockerfile path.
 * Anything else (usesStandbyMode, storages, defaultMemoryMbytes, readme, output schemas, web server keys, ...) changes how
 * the platform builds or runs the Actor and needs a deliberate audit update.
 */
const TOLERATED_OPTIONAL_ACTOR_JSON_KEYS = [...KNOWN_REPORTED_ACTOR_JSON_DEVIATIONS, 'dockerfile'];
const OFFICIAL_MEMORY_VALUES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const OFFICIAL_EDITORS: Record<string, string[]> = {
    string: ['javascript', 'python', 'textfield', 'textarea', 'datepicker', 'select', 'fileupload', 'hidden'],
    array: ['json', 'requestListSources', 'pseudoUrls', 'globs', 'keyValue', 'stringList', 'fileupload', 'select', 'schemaBased', 'hidden'],
    object: ['json', 'proxy', 'schemaBased', 'hidden'],
    integer: ['number', 'hidden'],
    number: ['number', 'hidden'],
    boolean: ['checkbox', 'hidden'],
};
const OFFICIAL_ITEMS_SELECT_KEYS = ['type', 'enum', 'enumTitles', 'enumSuggestedValues'];
/** Top-level keys of an input schema in the official schema (additionalProperties: false there). */
const OFFICIAL_INPUT_SCHEMA_KEYS = ['$schema', 'additionalProperties', 'description', 'properties', 'required', 'schemaVersion', 'title', 'type'];
/**
 * Keys a property definition may use (union over the property types of the official input schema). The platform does not
 * reject other keys, it silently ignores them, so a typo such as "defualt" or "isSecert" would drop the setting unnoticed.
 */
const INPUT_PROPERTY_KEYS = [
    'title',
    'type',
    'description',
    'editor',
    'default',
    'prefill',
    'example',
    'enum',
    'enumTitles',
    'items',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
    'isSecret',
    'nullable',
    'unit',
    'sectionCaption',
    'sectionDescription',
    'errorMessage',
    'uniqueItems',
    'properties',
    'required',
];

const COMMON_KEYS = ['sources', 'sourceOptions', 'deltaMode', 'stateNamespace', 'maxItemsPerSource', 'watchlistNames', 'maxWatchlistHitsPerRun', 'maxWatchlistSpendUsd'];
const SHARED_VERBATIM_KEYS = ['sourceOptions', 'deltaMode', 'stateNamespace', 'maxItemsPerSource', 'watchlistNames', 'maxWatchlistHitsPerRun', 'maxWatchlistSpendUsd'];
const DELTA_MODES = ['all', 'onlyChanged', 'onlyNew'];

const SECRET_PATTERNS: Array<[string, RegExp]> = [
    ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
    ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u],
    ['apify token', /\bapify_api_[A-Za-z0-9]{16,}/u],
    ['sk- style key', /\bsk-[A-Za-z0-9_-]{20,}/u],
    ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}/u],
    ['aws access key id', /\bAKIA[0-9A-Z]{16}\b/u],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
    ['long hex string', /\b[a-f0-9]{32,}\b/iu],
    ['long base64-like run', /[A-Za-z0-9+/]{40,}={0,2}/u],
];

/** Words that mean "unfinished text". The two task markers are assembled so a repository scan for them does not match this file. */
const UNFINISHED_TEXT = new RegExp(`\\b(${['TO' + 'DO', 'FIX' + 'ME', 'TBD', 'lorem', 'placeholder'].join('|')})\\b`, 'iu');

const SECRET_WORDS = new Set(['key', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'bearer']);

/** True when a camelCase / snake_case identifier contains a whole secret-like word (so `keywords` is not a secret). */
function looksSecret(name: string): boolean {
    return name
        .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .toLowerCase()
        .split(/[\s_-]+/u)
        .some((word) => SECRET_WORDS.has(word));
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Files {
    actorText: string;
    schemaText: string;
    dockerText: string;
    indexText: string;
    actor: Json;
    schema: Json;
}

async function loadFiles(slug: string): Promise<Files> {
    const dir = join(ROOT, slug, '.actor');
    const actorText = await readFile(join(dir, 'actor.json'), 'utf8');
    const schemaText = await readFile(join(dir, 'input_schema.json'), 'utf8');
    return {
        actorText,
        schemaText,
        dockerText: await readFile(join(dir, 'Dockerfile'), 'utf8'),
        indexText: await readFile(join(ROOT, slug, 'index.ts'), 'utf8'),
        actor: JSON.parse(actorText),
        schema: JSON.parse(schemaText),
    };
}

const FILES = new Map<string, Files>();
for (const c of CASES) FILES.set(c.slug, await loadFiles(c.slug));
const filesOf = (slug: string): Files => {
    const files = FILES.get(slug);
    if (!files) throw new Error(`no files for ${slug}`);
    return files;
};
const PACKAGE_JSON = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; engines: { node: string } };

interface Instruction {
    keyword: string;
    args: string;
}

/** Minimal Dockerfile parser: comments dropped, backslash continuations joined. */
function parseDockerfile(text: string): Instruction[] {
    const out: Instruction[] = [];
    let buffer = '';
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/u, '');
        if (buffer === '' && (line.trim() === '' || line.trim().startsWith('#'))) continue;
        if (line.endsWith('\\')) {
            buffer += `${line.slice(0, -1).trim()} `;
            continue;
        }
        buffer += line.trim();
        const m = /^([A-Za-z]+)\s+(.*)$/u.exec(buffer.trim());
        if (!m) throw new Error(`unparseable Dockerfile line: ${buffer}`);
        out.push({ keyword: (m[1] ?? '').toUpperCase(), args: m[2] ?? '' });
        buffer = '';
    }
    if (buffer !== '') throw new Error('Dockerfile ends inside a line continuation');
    return out;
}

function optionKeys(schema: unknown): string[] | undefined {
    const candidate = schema as { shape?: Record<string, unknown>; _def?: { typeName?: string; schema?: unknown; innerType?: unknown; in?: unknown } };
    switch (candidate._def?.typeName) {
        case 'ZodObject':
            return Object.keys(candidate.shape ?? {});
        case 'ZodEffects':
            return optionKeys(candidate._def.schema);
        case 'ZodOptional':
        case 'ZodNullable':
        case 'ZodDefault':
            return optionKeys(candidate._def.innerType);
        case 'ZodPipeline':
            return optionKeys(candidate._def.in);
        default:
            return undefined;
    }
}

const accepts = (patch: Record<string, unknown>): boolean => EngineInputSchema.safeParse({ sources: ['probe'], ...patch }).success;

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: actor.json', (slug, c) => {
    const f = filesOf(slug);

    it('names the engine slug and declares version, buildTag, a resolvable input schema path and a resolvable Dockerfile', async () => {
        expect(f.actorText.endsWith('\n')).toBe(true);
        expect(f.actor.name).toBe(slug);
        expect(f.actor.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
        expect(f.actor.name.length).toBeGreaterThanOrEqual(3);
        expect(f.actor.name.length).toBeLessThanOrEqual(63);
        expect(f.actor.$schema).toBe('https://apify.com/schemas/v1/actor.ide.json');
        expect(f.actor.actorSpecification).toBe(1);
        expect(f.actor.version).toMatch(/^([0-9]+)\.([0-9]+)(\.[0-9]+)?$/u);
        expect(typeof f.actor.buildTag).toBe('string');
        expect(f.actor.buildTag.length).toBeGreaterThan(0);
        expect(typeof f.actor.title).toBe('string');
        expect(f.actor.title.trim().length).toBeGreaterThan(10);
        expect(typeof f.actor.description).toBe('string');
        expect(f.actor.description.trim().length).toBeGreaterThan(50);
        expect(`${f.actor.title} ${f.actor.description}`).not.toMatch(UNFINISHED_TEXT);

        const actorDir = join(ROOT, slug, '.actor');
        const inputPath = resolve(actorDir, f.actor.inputSchema ?? f.actor.input);
        expect(inputPath.startsWith(actorDir + sep)).toBe(true);
        expect(await readFile(inputPath, 'utf8')).toBe(f.schemaText);
        // The Dockerfile: the platform default (official schema: "../Dockerfile") or an explicit path.
        const dockerPath = resolve(actorDir, f.actor.dockerfile ?? 'Dockerfile');
        await access(dockerPath);
        expect(await readFile(dockerPath, 'utf8')).toBe(f.dockerText);
    });

    it('uses only keys of the official actor.json schema (the one reported deviation excepted) and no environment variables', () => {
        const unknown = Object.keys(f.actor).filter((key) => !ACTOR_JSON_OFFICIAL_KEYS.includes(key));
        expect(unknown.filter((key) => !KNOWN_REPORTED_ACTOR_JSON_DEVIATIONS.includes(key))).toEqual([]);
        expect(f.actor.environmentVariables).toBeUndefined();
        expect(f.actor.dockerContextDir).toBeUndefined();
        // The closed key set: every required key is present and nothing outside the tolerated optional keys appears.
        const keys = Object.keys(f.actor);
        expect(REQUIRED_ACTOR_JSON_KEYS.filter((key) => !keys.includes(key))).toEqual([]);
        expect(keys.filter((key) => !REQUIRED_ACTOR_JSON_KEYS.includes(key) && !TOLERATED_OPTIONAL_ACTOR_JSON_KEYS.includes(key))).toEqual([]);
        expect(f.actor.usesStandbyMode).toBeUndefined();
        expect(f.actor.defaultMemoryMbytes).toBeUndefined();
    });

    it('pins the memory to the value the pricing was computed for, using only memory sizes the platform offers', () => {
        expect(f.actor.minMemoryMbytes).toBe(c.memoryMbytes);
        expect(f.actor.maxMemoryMbytes).toBe(c.memoryMbytes);
        expect(OFFICIAL_MEMORY_VALUES).toContain(f.actor.minMemoryMbytes);
    });

    it('contains nothing that looks like a secret, a custom CA bundle or an environment override', () => {
        for (const [label, pattern] of SECRET_PATTERNS) expect(f.actorText, `actor.json ${label}`).not.toMatch(pattern);
        expect(f.actorText).not.toContain('NODE_EXTRA_CA_CERTS');
    });
});

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: input_schema.json', (slug, c) => {
    const f = filesOf(slug);
    const props: Record<string, Json> = f.schema.properties;
    const active = c.engine.connectors.filter((x) => x.status === 'active');
    const held = c.engine.connectors.filter((x) => x.status === 'held');

    it('is valid JSON, an object schema of version 1, and every property has a title, a type and a description', () => {
        expect(f.schemaText.endsWith('\n')).toBe(true);
        expect(f.schemaText.charCodeAt(0)).not.toBe(0xfeff);
        expect(f.schema.type).toBe('object');
        expect(f.schema.schemaVersion).toBe(1);
        expect(f.schema.$schema).toBe('https://apify.com/schemas/v1/input.ide.json');
        expect(f.schema.title).toBe(`${slug} configuration`);
        expect(f.schema.required).toEqual(['sources']);
        expect(Object.keys(f.schema).filter((key) => !OFFICIAL_INPUT_SCHEMA_KEYS.includes(key))).toEqual([]);
        for (const [key, prop] of Object.entries(props)) {
            expect(Object.keys(prop).filter((name) => !INPUT_PROPERTY_KEYS.includes(name)), `${key} uses a key no input schema property defines`).toEqual([]);
            expect(typeof prop.title, `${key}.title`).toBe('string');
            expect(prop.title.trim().length, `${key}.title`).toBeGreaterThan(0);
            expect(Object.keys(OFFICIAL_EDITORS), `${key}.type`).toContain(prop.type);
            expect(typeof prop.description, `${key}.description`).toBe('string');
            expect(prop.description.trim().length, `${key}.description`).toBeGreaterThan(0);
            expect(`${prop.title} ${prop.description}`, key).not.toMatch(UNFINISHED_TEXT);
        }
        for (const key of f.schema.required as string[]) expect(props[key], key).toBeDefined();
    });

    it('uses an editor the official schema allows for each type, and an items object with only select keys', () => {
        for (const [key, prop] of Object.entries(props)) {
            if (prop.type === 'string' && prop.enum !== undefined) {
                expect(prop.editor, key).toBe('select');
            } else if (prop.type === 'string' || prop.type === 'array' || prop.type === 'object') {
                expect(prop.editor, `${key} needs an editor`).toBeDefined();
            }
            if (prop.editor !== undefined) expect(OFFICIAL_EDITORS[prop.type as string], `${key}: editor ${prop.editor} for ${prop.type}`).toContain(prop.editor);
            if (prop.type === 'array' && prop.editor === 'select') {
                expect(Object.keys(prop.items).every((k) => OFFICIAL_ITEMS_SELECT_KEYS.includes(k)), key).toBe(true);
                expect(prop.items.type).toBe('string');
                expect(Array.isArray(prop.items.enum)).toBe(true);
            }
        }
        // A hidden field cannot be filled in from the form, and the wrong editor drops the select / JSON / text behaviour the field needs.
        for (const [key, prop] of Object.entries(props)) expect(prop.editor, `${key} must stay visible in the input form`).not.toBe('hidden');
        expect(props.sources.editor).toBe('select');
        expect(props.sourceOptions.editor).toBe('json');
        expect(props.stateNamespace.editor).toBe('textfield');
        expect(['stringList', 'json']).toContain(props.watchlistNames.editor);
        expect(Object.keys(props).slice(0, COMMON_KEYS.length)).toEqual(COMMON_KEYS);
    });

    it('offers exactly the ACTIVE connector ids as sources, names the held ones in the description, and aligns the titles', () => {
        const enumIds: string[] = props.sources.items.enum;
        expect([...enumIds].sort()).toEqual(active.map((x) => x.id).sort());
        expect(new Set(enumIds).size).toBe(enumIds.length);
        expect(enumIds).toEqual(active.map((x) => x.id));
        for (const h of held) expect(enumIds, h.id).not.toContain(h.id);
        const heldList = held.map((x) => x.id).join(', ') || 'none';
        expect(props.sources.description).toContain(`Held sources are not selectable: ${heldList}.`);
        for (const h of held) expect(props.sources.description, h.id).toContain(h.id);
        const titles: string[] = props.sources.items.enumTitles;
        expect(titles).toHaveLength(enumIds.length);
        titles.forEach((title, i) => {
            const connector = must(active[i], `connector ${i}`);
            expect(title.trim().length, connector.id).toBeGreaterThan(0);
            expect(title.length, connector.id).toBeLessThanOrEqual(90);
            expect(connector.description.startsWith(title.replace(/\u2026$/u, '').slice(0, 40)), `${connector.id} title is not its own description`).toBe(true);
        });
        expect(props.sources.minItems).toBe(1);
        const defaults: string[] = props.sources.default;
        expect(Array.isArray(defaults)).toBe(true);
        expect(defaults).toHaveLength(1);
        for (const id of defaults) expect(enumIds, `default source ${id} is not selectable`).toContain(id);
        // The default is the first active source that needs no mandatory option: a bring-your-own-key source must never be
        // pre-selected, because the Store re-runs a published Actor on its default input and that run would fail preflight.
        const firstKeyless = must(active.find((connector) => (connector.requiredOptions ?? []).length === 0), 'a keyless active source');
        expect(defaults).toEqual([firstKeyless.id]);
    });

    it('ships a default source that passes preflight with the schema defaults alone (no credential needed to start)', () => {
        const input = EngineInputSchema.parse({ sources: props.sources.default });
        expect(() => resolveSources(c.engine, input)).not.toThrow();
        expect(resolveSources(c.engine, input).length).toBe(1);
    });

    it('keeps the engine description honest about its sources', () => {
        const description: string = f.actor.description;
        if (slug === 'global-regtech-compliance-feed') expect(description).toContain('six regulatory delta sources');
        expect(active).toHaveLength(slug === 'global-regtech-compliance-feed' ? 6 : slug === 'latam-global-tender-intelligence' ? 8 : 5);
        if (slug === 'latam-global-tender-intelligence') {
            for (const h of held) expect(description.includes(h.id) || description.includes(h.id.split('_')[0]?.toUpperCase() ?? '?'), h.id).toBe(true);
        }
    });

    it('declares deltaMode with exactly the three modes, aligned titles, and the zod default', () => {
        const modes = EngineInputSchema.shape.deltaMode.removeDefault().options as string[];
        expect(props.deltaMode.enum).toEqual(DELTA_MODES);
        expect(props.deltaMode.enum).toEqual(modes);
        expect(props.deltaMode.default).toBe('onlyChanged');
        const titles: string[] = props.deltaMode.enumTitles;
        expect(titles).toHaveLength(3);
        expect(titles[0]).toMatch(/^All records/u);
        expect(titles[1]).toMatch(/changed/iu);
        expect(titles[2]).toMatch(/^New records only/u);
        for (const mode of DELTA_MODES) expect(accepts({ deltaMode: mode }), mode).toBe(true);
        expect(accepts({ deltaMode: 'bogus' })).toBe(false);
    });

    it('declares defaults and limits for the common fields that agree with EngineInputSchema (probed, not copied)', () => {
        const parsed = EngineInputSchema.parse({ sources: ['probe'] });
        expect(props.sourceOptions.default).toEqual(parsed.sourceOptions);
        expect(props.sourceOptions.type).toBe('object');
        expect(props.maxItemsPerSource.default).toBe(parsed.maxItemsPerSource);
        expect(props.maxWatchlistHitsPerRun.default).toBe(parsed.maxWatchlistHitsPerRun);
        expect(props.maxWatchlistSpendUsd.default).toBe(parsed.maxWatchlistSpendUsd);
        expect([props.maxItemsPerSource.default, props.maxWatchlistHitsPerRun.default, props.maxWatchlistSpendUsd.default]).toEqual([500, 200, 50]);
        // No default in zod -> no default in the form for these two, and the declared ones are accepted by zod.
        expect(parsed.stateNamespace).toBeUndefined();
        expect(props.stateNamespace.default).toBeUndefined();
        expect(parsed.watchlistNames).toBeUndefined();
        expect(props.watchlistNames.default).toEqual([]);
        expect(props.watchlistNames.type).toBe('array');
        expect(accepts({ watchlistNames: props.watchlistNames.default })).toBe(true);
        expect(accepts({ sources: props.sources.default })).toBe(true);
        expect(accepts({ sources: [] })).toBe(false);
        expect(EngineInputSchema.safeParse({}).success).toBe(false);

        for (const key of ['maxItemsPerSource', 'maxWatchlistHitsPerRun', 'maxWatchlistSpendUsd']) {
            const p = props[key];
            const { minimum, maximum } = p as { minimum: number; maximum: number };
            expect(accepts({ [key]: minimum }), `${key} at minimum`).toBe(true);
            expect(accepts({ [key]: maximum }), `${key} at maximum`).toBe(true);
            expect(accepts({ [key]: minimum - 1 }), `${key} below minimum`).toBe(false);
            expect(accepts({ [key]: maximum + 1 }), `${key} above maximum`).toBe(false);
            expect(accepts({ [key]: minimum + 0.5 }), `${key} fractional (${p.type})`).toBe(p.type === 'number');
            expect(['integer', 'number']).toContain(p.type);
            expect(p.default >= minimum && p.default <= maximum, `${key} default inside its limits`).toBe(true);
        }
        expect(props.stateNamespace.type).toBe('string');
        expect(accepts({ stateNamespace: 'weekly-eu' })).toBe(true);
        expect(accepts({ stateNamespace: 'a'.repeat(40) })).toBe(true);
        expect(accepts({ stateNamespace: 'a'.repeat(41) })).toBe(false);
        expect(accepts({ stateNamespace: 'Not Valid' })).toBe(false);
        // The form text says "Leave empty": an empty field must not fail the run (an empty string and null mean "not set").
        expect(accepts({ stateNamespace: '' })).toBe(true);
        expect(accepts({ stateNamespace: null })).toBe(true);
        expect(EngineInputSchema.parse({ sources: ['probe'], stateNamespace: '' }).stateNamespace).toBeUndefined();
        expect(props.stateNamespace.description).toContain('1-40 characters');
        // Any string constraint the form declares for the namespace must agree with zod on the same probes (none is required).
        const ns = props.stateNamespace as { pattern?: string; minLength?: number; maxLength?: number };
        if (ns.pattern !== undefined || ns.minLength !== undefined || ns.maxLength !== undefined) {
            const formAccepts = (value: string): boolean =>
                (ns.pattern === undefined || new RegExp(ns.pattern, 'u').test(value)) && (ns.minLength === undefined || value.length >= ns.minLength) && (ns.maxLength === undefined || value.length <= ns.maxLength);
            for (const probe of ['a', 'default', 'weekly-eu', '0-9', 'a'.repeat(40), 'a'.repeat(41), 'Not Valid', 'UPPER', 'under_score']) {
                expect(formAccepts(probe), `form constraint vs zod for "${probe}"`).toBe(accepts({ stateNamespace: probe }));
            }
        }
    });

    it('exposes every BYOK credential as a TOP-LEVEL isSecret text field, matches engine.credentialFields, and nests none in sourceOptions', () => {
        expect(Object.fromEntries(Object.entries(c.engine.credentialFields ?? {}).map(([k, v]) => [k, [v.source, v.option]]))).toEqual(c.credentials);
        // The registry source text declares exactly these credentials and no other.
        for (const [key, [source, option]] of Object.entries(c.credentials)) expect(f.indexText, key).toContain(`${key}: { source: '${source}', option: '${option}' }`);
        expect((f.indexText.match(/option: '/gu) ?? []).length).toBe(Object.keys(c.credentials).length);

        const secretProps = Object.entries(props).filter(([, p]) => p.isSecret !== undefined);
        expect(secretProps.map(([k]) => k).sort()).toEqual(Object.keys(c.credentials).sort());
        for (const [key, [source]] of Object.entries(c.credentials)) {
            const p = props[key];
            expect(p, key).toBeDefined();
            expect(p.isSecret, key).toBe(true);
            expect(p.type, key).toBe('string');
            expect(['textfield', 'textarea'], key).toContain(p.editor);
            expect(p.description, key).toContain(source);
            expect(active.map((x) => x.id), `${key} targets a source that is not selectable`).toContain(source);
        }
        expect(Object.keys(props).slice(COMMON_KEYS.length)).toEqual(Object.keys(c.credentials));
        expect(props.sourceOptions.properties).toBeUndefined();
        expect(props.sourceOptions.isSecret).toBeUndefined();
        expect(props.sourceOptions.description).toMatch(/credentials in the secret fields/u);
        // No secret-looking property name outside the declared credential set.
        for (const key of Object.keys(props)) expect(looksSecret(key) ? Object.keys(c.credentials).includes(key) : true, `${key} looks secret but is not a declared credential`).toBe(true);
    });

    it('covers every secret-looking connector option and every required option with a top-level credential field', () => {
        const declared = new Set(Object.values(c.credentials).map(([source, option]) => `${source}.${option}`));
        const secretOptions = new Set<string>();
        for (const connector of active) {
            const keys = optionKeys(connector.optionsSchema);
            expect(keys, `${connector.id}: cannot introspect the options schema`).toBeDefined();
            for (const key of keys ?? []) if (looksSecret(key)) secretOptions.add(`${connector.id}.${key}`);
            for (const required of connector.requiredOptions ?? []) {
                if (looksSecret(required)) secretOptions.add(`${connector.id}.${required}`);
            }
        }
        expect([...secretOptions].sort()).toEqual([...declared].sort());
    });

    it('routes each top-level credential into its source option end to end (schema field -> router -> connector options)', () => {
        const bySource = new Map<string, string[]>();
        for (const [key, [source]] of Object.entries(c.credentials)) bySource.set(source, [...(bySource.get(source) ?? []), key]);
        for (const [source, keys] of bySource) {
            const raw = { sources: [source], ...Object.fromEntries(keys.map((k) => [k, `probe-${k}-value`])) };
            const parsed = EngineInputSchema.parse(mergeCredentialFields(c.engine, raw));
            const options = parsed.sourceOptions[source] ?? {};
            for (const key of keys) expect(options[must(c.credentials[key], key)[1]], `${source}.${key}`).toBe(`probe-${key}-value`);
            // The connector must know the option names: no issue may point at a credential key (a missing sibling option is fine).
            const connector = must(active.find((x) => x.id === source), source);
            const verdict = connector.optionsSchema.safeParse(options);
            const options2 = keys.map((k) => must(c.credentials[k], k)[1]);
            const offending = verdict.success
                ? []
                : verdict.error.issues.filter((issue) => issue.path.some((part) => options2.includes(String(part))) || (issue.code === 'unrecognized_keys' && issue.keys.some((k) => options2.includes(k))));
            expect(offending, `${source} rejects its own credential option`).toEqual([]);
        }
    });

    it('lets a caller supply the credentials a default-selected source requires (the default source is not unreachable)', () => {
        const defaultId = String(props.sources.default[0]);
        const connector = must(active.find((x) => x.id === defaultId), defaultId);
        for (const required of connector.requiredOptions ?? []) {
            expect(Object.keys(c.credentials).includes(required), `${defaultId} requires ${required} but no top-level field carries it`).toBe(true);
        }
    });

    it('has no default, prefill or example on any credential, and no secret-looking value anywhere in the schema', () => {
        for (const [key, p] of Object.entries(props)) {
            if (p.isSecret === true || looksSecret(key)) for (const field of ['default', 'prefill', 'example']) expect(p[field], `${key}.${field}`).toBeUndefined();
        }
        const values: string[] = [];
        const walk = (node: unknown): void => {
            if (typeof node === 'string') values.push(node);
            else if (Array.isArray(node)) node.forEach(walk);
            else if (node && typeof node === 'object') Object.values(node).forEach(walk);
        };
        walk(f.schema);
        expect(values.length).toBeGreaterThan(20);
        for (const [label, pattern] of SECRET_PATTERNS) {
            for (const value of values) expect(value, `${label} in a schema string`).not.toMatch(pattern);
        }
        for (const label of ['default', 'prefill', 'example']) {
            for (const [key, p] of Object.entries(props)) {
                const v = p[label];
                if (typeof v === 'string') expect(v.length, `${key}.${label}`).toBeLessThanOrEqual(80);
            }
        }
        expect(f.schemaText).not.toContain('NODE_EXTRA_CA_CERTS');
    });
});

describe('the three input schemas share their common parts byte for byte', () => {
    const [a, b, d] = CASES.map((c) => filesOf(c.slug));
    const all = [must(a, 'regtech'), must(b, 'tenders'), must(d, 'patents')];
    /**
     * The one part of the shared text that may be engine-specific: the example options object quoted in the sourceOptions
     * description. It is masked for the byte comparison (so an engine can name one of its own sources) and checked on its own.
     */
    const EXAMPLE = /e\.g\. (\{.*\})\. Each source/u;
    const withoutExample = (text: string): string => text.replace(EXAMPLE, 'e.g. <example>. Each source');

    it('keeps sourceOptions through maxWatchlistSpendUsd identical in the raw file text', () => {
        const slices = all.map((x) => {
            const start = x.schemaText.indexOf('        "sourceOptions": {');
            const marker = x.schemaText.indexOf('        "maxWatchlistSpendUsd": {');
            const end = x.schemaText.indexOf('\n        }', marker);
            expect(start).toBeGreaterThan(0);
            expect(marker).toBeGreaterThan(start);
            expect(end).toBeGreaterThan(marker);
            return withoutExample(x.schemaText.slice(start, end + '\n        }'.length));
        });
        expect(slices[0]?.length).toBeGreaterThan(1500);
        expect(slices[1]).toBe(slices[0]);
        expect(slices[2]).toBe(slices[0]);
    });

    it('keeps every shared property, the sources scaffolding and the schema envelope identical when parsed', () => {
        for (const key of SHARED_VERBATIM_KEYS) expect(new Set(all.map((x) => withoutExample(JSON.stringify(x.schema.properties[key])))).size, key).toBe(1);
        for (const x of all) {
            const example = EXAMPLE.exec(x.schema.properties.sourceOptions.description)?.[1];
            expect(example, `${x.schema.title}: sourceOptions description has no example object`).toBeDefined();
            const parsedExample = JSON.parse(must(example, 'example')) as Record<string, unknown>;
            expect(Object.keys(parsedExample).length).toBeGreaterThan(0);
            for (const value of Object.values(parsedExample)) expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(true);
        }
        const scaffold = (x: Files): unknown => {
            const { title, type, editor, minItems, items } = x.schema.properties.sources;
            return { title, type, editor, minItems, itemsType: items.type };
        };
        expect(new Set(all.map((x) => JSON.stringify(scaffold(x)))).size).toBe(1);
        const descriptionPrefix = (x: Files): string => x.schema.properties.sources.description.split(':')[0];
        expect(new Set(all.map(descriptionPrefix)).size).toBe(1);
        for (const key of ['$schema', 'type', 'schemaVersion', 'required']) expect(new Set(all.map((x) => JSON.stringify(x.schema[key]))).size, key).toBe(1);
        expect(new Set(all.map((x) => x.schema.title)).size).toBe(3);
    });

    it('keeps the credential field template identical across every credential of every engine', () => {
        const templates = new Set<string>();
        for (const c of CASES) {
            const f = filesOf(c.slug);
            for (const [key, [source]] of Object.entries(c.credentials)) {
                const p = f.schema.properties[key];
                templates.add(JSON.stringify({ type: p.type, editor: p.editor, isSecret: p.isSecret, description: String(p.description).replace(source, '<source>'), keys: Object.keys(p) }));
            }
        }
        expect(templates.size).toBe(1);
    });

    it('keeps the shared actor.json fields and the Dockerfile identical except for the slug', () => {
        for (const key of ['$schema', 'actorSpecification', 'version', 'buildTag', 'inputSchema']) expect(new Set(all.map((x) => JSON.stringify(x.actor[key]))).size, key).toBe(1);
        expect(new Set(all.map((x) => x.actor.name)).size).toBe(3);
        expect(new Set(all.map((x) => x.actor.title)).size).toBe(3);
        const generic = CASES.map((c) => filesOf(c.slug).dockerText.replaceAll(c.slug, '<slug>'));
        expect(new Set(generic).size).toBe(1);
        expect(Object.keys(must(a, 'regtech').actor)).toEqual(Object.keys(must(b, 'tenders').actor));
        expect(Object.keys(must(a, 'regtech').actor)).toEqual(Object.keys(must(d, 'patents').actor));
    });
});

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: Dockerfile', (slug, c) => {
    const f = filesOf(slug);
    const instructions = parseDockerfile(f.dockerText);
    const minNodeMajor = Number((/^[<>=^~\s]*(\d+)/u.exec(PACKAGE_JSON.engines.node) ?? [])[1]);

    it('builds on a pinned Node major version of the Apify base image, in two stages with the same major', () => {
        const froms = instructions.filter((i) => i.keyword === 'FROM');
        expect(froms).toHaveLength(2);
        const majors = froms.map((i) => {
            const m = /^apify\/actor-node:(\d+)(?: AS ([a-z][a-z0-9_-]*))?$/iu.exec(i.args);
            expect(m, `FROM ${i.args} is not apify/actor-node:<major>`).not.toBeNull();
            return Number(m?.[1]);
        });
        expect(new Set(majors).size).toBe(1);
        expect(majors[0]).toBeGreaterThanOrEqual(minNodeMajor);
        expect(f.dockerText).not.toMatch(/:latest\b|@sha256:?$/mu);
        expect(froms[0]?.args).toMatch(/ AS builder$/u);
        expect(instructions[0]?.keyword).toBe('FROM');
    });

    it('installs from the lockfile with npm ci (dev deps only in the builder), builds, and never uses npm install or force flags', () => {
        const runs = instructions.filter((i) => i.keyword === 'RUN').map((i) => i.args);
        const builderCi = runs.findIndex((r) => /\bnpm ci --include=dev\b/u.test(r));
        const build = runs.findIndex((r) => /\bnpm run build\b/u.test(r));
        const runtimeCi = runs.findIndex((r) => /\bnpm ci --omit=dev\b/u.test(r));
        expect(builderCi).toBeGreaterThanOrEqual(0);
        expect(build).toBeGreaterThan(builderCi);
        expect(runtimeCi).toBeGreaterThan(build);
        for (const r of runs) {
            expect(r).not.toMatch(/\bnpm (install|i)\b/u);
            expect(r).not.toMatch(/--force|--legacy-peer-deps|--unsafe-perm/u);
            expect(r).not.toMatch(/\bsudo\b|\bchmod\b|\bcurl\b|\bwget\b|\|\s*(sh|bash)\b/u);
        }
        // Within each stage, `COPY package*.json` precedes the `npm ci` that needs it.
        const stages: Instruction[][] = [];
        for (const instruction of instructions) {
            if (instruction.keyword === 'FROM') stages.push([]);
            stages[stages.length - 1]?.push(instruction);
        }
        expect(stages).toHaveLength(2);
        for (const stage of stages) {
            const copyIndex = stage.findIndex((i) => i.keyword === 'COPY' && i.args.includes('package*.json'));
            const ciIndex = stage.findIndex((i) => i.keyword === 'RUN' && /\bnpm ci\b/u.test(i.args));
            expect(copyIndex).toBeGreaterThanOrEqual(0);
            expect(ciIndex).toBeGreaterThan(copyIndex);
        }
    });

    it('uses only FROM, COPY, RUN and CMD (plus a USER or WORKDIR that keeps the image defaults) and runs only npm, node, echo and rm', () => {
        for (const instruction of instructions) {
            expect(['FROM', 'COPY', 'RUN', 'CMD', 'USER', 'WORKDIR'], `${instruction.keyword} is not an allowed instruction`).toContain(instruction.keyword);
            if (instruction.keyword === 'USER') expect(instruction.args).toBe('myuser');
            if (instruction.keyword === 'WORKDIR') expect(instruction.args).toBe('/usr/src/app');
        }
        for (const command of instructions.filter((i) => i.keyword === 'RUN').map((i) => i.args)) {
            expect(command, 'a redirect can write files the audit does not see').not.toMatch(/[<>]/u);
            for (const segment of command.split(/&&|\|\||;|\|/u).map((part) => part.trim()).filter((part) => part !== '')) {
                expect(['npm', 'node', 'echo', 'rm'], `RUN segment "${segment}"`).toContain(segment.split(/\s+/u)[0]);
            }
        }
        expect(f.dockerText).not.toMatch(/\bchmod\b/u);
    });

    it('runs as the non-root user of the Apify image: no USER switch, every COPY chowned to myuser, no privileged tooling', () => {
        const users = instructions.filter((i) => i.keyword === 'USER').map((i) => i.args);
        for (const user of users) expect(user).toBe('myuser');
        expect(f.dockerText).not.toMatch(/USER\s+(root|0)\b/iu);
        const copies = instructions.filter((i) => i.keyword === 'COPY');
        expect(copies.length).toBe(5);
        for (const copy of copies) expect(copy.args, `COPY ${copy.args}`).toContain('--chown=myuser:myuser');
        expect(instructions.some((i) => i.keyword === 'ADD')).toBe(false);
        expect(instructions.some((i) => i.keyword === 'EXPOSE')).toBe(false);
    });

    it('sets no ENV or ARG at all, so no key, token, secret or password can be baked into the image, and no custom CA bundle', () => {
        const envArg = instructions.filter((i) => i.keyword === 'ENV' || i.keyword === 'ARG' || i.keyword === 'LABEL');
        expect(envArg).toEqual([]);
        for (const i of instructions) expect(`${i.keyword} ${i.args}`, i.args).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u);
        expect(f.dockerText).not.toContain('NODE_EXTRA_CA_CERTS');
        for (const [label, pattern] of SECRET_PATTERNS) expect(f.dockerText, `Dockerfile ${label}`).not.toMatch(pattern);
    });

    it('copies only the build context (package files, the context, the builder dist), never a host path outside it', () => {
        const allowed = new Set(['package*.json', '.', '/usr/src/app/dist']);
        for (const copy of instructions.filter((i) => i.keyword === 'COPY')) {
            const tokens = copy.args.split(/\s+/u).filter((t) => !t.startsWith('--'));
            const sources = tokens.slice(0, -1);
            const destination = tokens[tokens.length - 1] ?? '';
            for (const source of sources) {
                expect(allowed.has(source), `COPY source ${source}`).toBe(true);
                expect(source).not.toContain('..');
                expect(source).not.toMatch(/^https?:/u);
            }
            expect(destination.startsWith('/'), `COPY destination ${destination}`).toBe(false);
            expect(destination).not.toContain('..');
            if (copy.args.includes('--from')) expect(copy.args).toContain('--from=builder');
        }
    });

    it('starts the compiled engine entrypoint with node in exec form, and that entrypoint exists', async () => {
        const cmd = instructions.filter((i) => i.keyword === 'CMD');
        expect(cmd).toHaveLength(1);
        expect(JSON.parse(must(cmd[0], 'CMD').args)).toEqual(['node', `dist/${slug}/main.js`]);
        await access(join(ROOT, slug, 'main.ts'));
        const tsconfig = JSON.parse(await readFile(join(ROOT, 'tsconfig.json'), 'utf8')) as { compilerOptions: { outDir: string; rootDir: string } };
        expect(tsconfig.compilerOptions.outDir).toBe('dist');
        expect(tsconfig.compilerOptions.rootDir).toBe('.');
        expect(f.dockerText.endsWith('\n')).toBe(true);
        expect(f.dockerText).not.toMatch(/[ \t]+$/mu);
        expect(c.slug).toBe(slug);
    });
});

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: staged build context (scripts/stage_actor.ts)', (slug) => {
    const f = filesOf(slug);
    let staged = '';

    beforeAll(async () => {
        staged = await mkdtemp(join(tmpdir(), 'audit-stage-'));
        await run(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'stage_actor.ts'), slug, `--out=${staged}`], { cwd: ROOT, timeout: 90_000 });
    }, 120_000);

    afterAll(async () => {
        if (staged !== '') await rm(staged, { recursive: true, force: true });
    });

    async function walk(dir: string): Promise<string[]> {
        const out: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) out.push(...(await walk(full)));
            else out.push(relative(staged, full).split(sep).join('/'));
        }
        return out.sort();
    }

    it('contains lib, pricing (without payloads) and this engine only, plus the package files and the Actor definition', async () => {
        expect((await readdir(staged)).sort()).toEqual(['.actor', '.dockerignore', 'Dockerfile', 'lib', 'package-lock.json', 'package.json', 'pricing', slug, 'tsconfig.json'].sort());
        const files = await walk(staged);
        expect(files.filter((p) => p.startsWith('pricing/')).every((p) => /^pricing\/[a-z_]+\.ts$/u.test(p))).toBe(true);
        expect(files.some((p) => p.startsWith('pricing/payloads'))).toBe(false);
        for (const other of CASES.map((x) => x.slug).filter((s) => s !== slug)) expect(files.some((p) => p.startsWith(`${other}/`)), other).toBe(false);
        for (const forbidden of ['test/', 'scripts/', 'docs-research/', 'storage/', 'node_modules/', 'stage/']) expect(files.some((p) => p.startsWith(forbidden)), forbidden).toBe(false);
        expect(files.some((p) => /(^|\/)\.env|\.pem$|\.key$|id_rsa|credentials\.json$/u.test(p))).toBe(false);
        expect(files.filter((p) => p.startsWith('.actor/')).sort()).toEqual(['.actor/Dockerfile', '.actor/actor.json', '.actor/input_schema.json']);
    });

    it('ships the committed Dockerfile at both locations the platform looks (.actor/ and ../Dockerfile) and the committed Actor files', async () => {
        expect(await readFile(join(staged, 'Dockerfile'), 'utf8')).toBe(f.dockerText);
        expect(await readFile(join(staged, '.actor', 'Dockerfile'), 'utf8')).toBe(f.dockerText);
        expect(await readFile(join(staged, '.actor', 'actor.json'), 'utf8')).toBe(f.actorText);
        expect(await readFile(join(staged, '.actor', 'input_schema.json'), 'utf8')).toBe(f.schemaText);
        const ignore = (await readFile(join(staged, '.dockerignore'), 'utf8')).split('\n');
        for (const entry of ['node_modules', 'dist', '.git', 'storage']) expect(ignore, entry).toContain(entry);
        const tsconfig = JSON.parse(await readFile(join(staged, 'tsconfig.json'), 'utf8')) as { include: string[]; compilerOptions: { outDir: string; rootDir: string } };
        expect(tsconfig.include).toEqual(['lib/**/*.ts', 'pricing/**/*.ts', `${slug}/**/*.ts`]);
        expect(tsconfig.compilerOptions.outDir).toBe('dist');
        expect(tsconfig.compilerOptions.rootDir).toBe('.');
        expect(JSON.parse(await readFile(join(staged, 'package.json'), 'utf8')).scripts.build).toBe('tsc -p tsconfig.json');
    });

    it('is closed under imports: every relative import resolves inside the staged tree and every package import is a production dependency', async () => {
        const files = (await walk(staged)).filter((p) => p.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(20);
        expect(files).toContain(`${slug}/main.ts`);
        const dependencies = new Set(Object.keys(PACKAGE_JSON.dependencies));
        // Real import statements only: they start in column 0, so words inside comments and strings are not matched.
        const importPatterns = [/^(?:import|export)\s[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gmu, /^import\s+['"]([^'"]+)['"]/gmu, /(?<![\w.])import\(\s*['"]([^'"]+)['"]\s*\)/gu];
        let relativeImports = 0;
        const packageImports = new Set<string>();
        for (const file of files) {
            const text = await readFile(join(staged, file), 'utf8');
            for (const [, specifier] of importPatterns.flatMap((pattern) => [...text.matchAll(pattern)])) {
                const target = must(specifier, 'specifier');
                if (target.startsWith('.')) {
                    relativeImports += 1;
                    const resolved = resolve(dirname(join(staged, file)), target.replace(/\.js$/u, '.ts'));
                    expect(resolved.startsWith(staged + sep), `${file} imports ${target}, outside the staged tree`).toBe(true);
                    expect((await stat(resolved)).isFile(), `${file} imports ${target}, which is not staged`).toBe(true);
                } else if (!target.startsWith('node:')) {
                    const name = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : (target.split('/')[0] ?? target);
                    packageImports.add(name);
                    expect(dependencies.has(name), `${file} imports ${name}, which is not a production dependency`).toBe(true);
                }
            }
        }
        expect(relativeImports).toBeGreaterThan(20);
        expect(packageImports.has('zod')).toBe(true);
    });
});

function must<T>(value: T | undefined | null, what: string): T {
    if (value === undefined || value === null) throw new Error(`missing ${what}`);
    return value;
}

describe.each(CASES.map((c) => [c.slug, c] as const))('%s: the sourceOptions example in the form', (slug, c) => {
    const f = filesOf(slug);

    it('names one of the engine own active sources and options that source really accepts', () => {
        const example = /e\.g\. (\{.*\})\. Each source/u.exec(f.schema.properties.sourceOptions.description)?.[1];
        expect(example, 'no example object in the description').toBeDefined();
        const parsed = JSON.parse(must(example, 'example')) as Record<string, unknown>;
        const sourceIds = Object.keys(parsed);
        expect(sourceIds.length).toBeGreaterThan(0);
        for (const id of sourceIds) {
            const connector = c.engine.connectors.find((candidate) => candidate.id === id);
            expect(connector, `${id} is not a source of ${slug}`).toBeDefined();
            expect(connector?.status, `${id} is not active`).toBe('active');
            const options = connector?.optionsSchema.safeParse(parsed[id]);
            expect(options?.success, `${id}: ${JSON.stringify(options && !options.success ? options.error.issues : [])}`).toBe(true);
        }
    });
});
