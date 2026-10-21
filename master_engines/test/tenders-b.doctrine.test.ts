/**
 * Registry and compliance-doctrine checks over the five tenders-b connector files.
 *
 * The static scans read each connector's SOURCE with comments stripped (the headers legitimately discuss `impit`,
 * `Date.now()` and User-Agents) and assert the rules the port brief makes non-negotiable: network access only through
 * `ctx.http`, no impersonation, deterministic time through `ctx.now()`, keyword lists only through the guard, and no
 * placeholder markers. They are lint-grade (regex) checks, deliberately simple, and complement the behavioural tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENGINE_SLUGS } from '../lib/types.js';
import { auGrantconnectConnector } from '../latam-global-tender-intelligence/connectors/auGrantconnect.js';
import { euTedConnector } from '../latam-global-tender-intelligence/connectors/euTed.js';
import { itLombardiaGrantsConnector } from '../latam-global-tender-intelligence/connectors/itLombardiaGrants.js';
import { usFloridaConnector } from '../latam-global-tender-intelligence/connectors/usFlorida.js';
import { worldBankNoticesConnector } from '../latam-global-tender-intelligence/connectors/worldBankNotices.js';

const here = dirname(fileURLToPath(import.meta.url));
const connectorsDir = join(here, '..', 'latam-global-tender-intelligence', 'connectors');
const FILES = ['euTed.ts', 'usFlorida.ts', 'auGrantconnect.ts', 'worldBankNotices.ts', 'itLombardiaGrants.ts'] as const;

/** Removes block comments and whole-line / trailing `//` comments (a `//` inside a URL is preceded by `:` so it is kept). */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const code = Object.fromEntries(FILES.map((f) => [f, stripComments(readFileSync(join(connectorsDir, f), 'utf-8'))])) as Record<(typeof FILES)[number], string>;
const raw = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(connectorsDir, f), 'utf-8')])) as Record<(typeof FILES)[number], string>;

describe('registry of the tenders-b connectors', () => {
    const all = [euTedConnector, usFloridaConnector, auGrantconnectConnector, worldBankNoticesConnector, itLombardiaGrantsConnector];

    it('has unique ids that match the brief and belong to the tender engine', () => {
        expect(all.map((c) => c.id)).toEqual(['eu_ted', 'us_florida', 'au_grantconnect', 'world_bank_notices', 'it_lombardia_grants']);
        expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
        expect(ENGINE_SLUGS).toContain('latam-global-tender-intelligence');
        for (const c of all) expect(c.engine, c.id).toBe('latam-global-tender-intelligence');
    });

    it('names the legacy actor each one absorbs', () => {
        expect(all.map((c) => c.legacyActor)).toEqual([
            'eu-ted-procurement-delta-monitor',
            'florida-tenders-monitor',
            'australia-grantconnect-monitor',
            'actor-20-mdb-procurement-monitor',
            'regione-lombardia-grants-registry-monitor',
        ]);
    });

    it('only au_grantconnect is held, and a held connector is the only one with a heldReason', () => {
        expect(all.filter((c) => c.status === 'held').map((c) => c.id)).toEqual(['au_grantconnect']);
        for (const c of all) {
            expect(c.description.length, c.id).toBeGreaterThan(40);
            if (c.status === 'held') expect(c.heldReason, c.id).toEqual(expect.any(String));
            else expect(c.heldReason, c.id).toBeUndefined();
        }
    });

    it('none of the active connectors needs a credential: every one runs with empty options', () => {
        for (const c of all.filter((x) => x.status === 'active')) {
            expect(c.requiredOptions, c.id).toBeUndefined();
            expect(c.optionsSchema.safeParse({}).success, c.id).toBe(true);
        }
    });

    it('every active connector rejects an unknown option key (strict schema), so a legacy option is never silently dropped', () => {
        for (const c of all.filter((x) => x.status === 'active')) {
            expect(c.optionsSchema.safeParse({ definitelyNotAnOption: true }).success, c.id).toBe(false);
        }
    });
});

describe('compliance doctrine (static scan of connector source, comments stripped)', () => {
    it('imports no HTTP stack other than the shared one (no impit / crawlee / got / axios / node-fetch / undici / apify)', () => {
        for (const file of FILES) {
            const imports = [...code[file].matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1] as string);
            for (const spec of imports) {
                expect(spec, `${file} imports ${spec}`).not.toMatch(/^(impit|crawlee|got|axios|node-fetch|undici|apify|playwright|puppeteer|@crawlee\/.*)$/);
            }
        }
    });

    it('never calls the global fetch directly', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/(\bawait\s+|\breturn\s+|=\s*|\(\s*)fetch\(/);
            expect(code[file], file).not.toMatch(/\bglobalThis\.fetch\b/);
        }
    });

    it('takes time from ctx.now(), never from new Date() / Date.now()', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/new Date\(\s*\)/);
            expect(code[file], file).not.toMatch(/Date\.now\(\)/);
        }
    });

    it('sets no User-Agent and no browser identity (honest identification is lib/http.ts\'s job)', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/['"]user-agent['"]\s*:/i);
            expect(code[file], file).not.toMatch(/Mozilla\/5\.0/);
            expect(code[file], file).not.toMatch(/\bsec-ch-ua\b/i);
            expect(code[file], file).not.toMatch(/accept-language/i);
        }
    });

    it('hard-codes no credential: the only secret option is the optional Socrata token, read from options', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/Bearer\s/);
            expect(code[file], file).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
            expect(code[file], file).not.toMatch(/app[_-]?token\s*[:=]\s*['"][A-Za-z0-9]{6,}['"]/i);
        }
        expect(code['itLombardiaGrants.ts']).toMatch(/options\.socrataAppToken/);
    });

    it('reads every keyword / watch-list style option through sanitizeKeywordList()', () => {
        for (const file of ['usFlorida.ts', 'worldBankNotices.ts', 'itLombardiaGrants.ts'] as const) {
            expect(code[file], file).toMatch(/sanitizeKeywordList\(/);
            expect(code[file], file).toMatch(/_guards\.js/);
        }
        // The exact-match filter of the World Bank connector must be built on the guard's normaliser, not on `includes('')`.
        expect(code['worldBankNotices.ts']).toMatch(/normaliseKeyword\(/);
        // No bare substring test against a caller-supplied needle outside the guard.
        for (const file of FILES) expect(code[file], file).not.toMatch(/\.includes\(\s*(filter|needle|keyword|options\.[A-Za-z]+)\s*\)/);
    });

    it('does not set the keys the router owns inside a payload literal', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/\bis_new\s*:/);
            expect(code[file], file).not.toMatch(/\bscraped_at\s*:/);
            expect(code[file], file).not.toMatch(/\bdelta_status\s*:/);
            expect(code[file], file).not.toMatch(/\brecord_id\s*:/);
            expect(code[file], file).not.toMatch(/\bis_watchlist_match\s*:/);
        }
    });

    it('does not port delta state, pushData or charging', () => {
        for (const file of FILES) {
            expect(code[file], file).not.toMatch(/Actor\.(pushData|charge|setValue|getValue|openKeyValueStore)/);
            expect(code[file], file).not.toMatch(/from\s+'\.\.\/\.\.\/lib\/(state|charging|router_core)\.js'/);
        }
    });

    it('contains no placeholder markers', () => {
        for (const file of FILES) {
            expect(raw[file], file).not.toMatch(/\b(TODO|FIXME|XXX|HACK)\b/);
            expect(raw[file], file).not.toMatch(/implement later|not implemented yet|placeholder|lorem ipsum/i);
        }
    });

    it('keeps the LIVE SOURCE VERIFICATION provenance block in every connector header', () => {
        for (const file of FILES) expect(raw[file], file).toMatch(/LIVE SOURCE VERIFICATION/);
    });

    it('uses relative ESM imports with the .js extension', () => {
        for (const file of FILES) {
            const relative = [...code[file].matchAll(/from\s+'(\.[^']*)'/g)].map((m) => m[1] as string);
            expect(relative.length, file).toBeGreaterThan(0);
            for (const spec of relative) expect(spec, `${file}: ${spec}`).toMatch(/\.js$/);
        }
    });
});
