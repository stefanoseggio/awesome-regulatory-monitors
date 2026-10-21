/**
 * Proof that the static ReDoS gate (scripts/redos_audit.mjs) detects vulnerable patterns, refuses to be talked out of
 * them, and that the six patterns it lets through are really bounded.
 *
 *   1. GATE       - the real script runs as a child process (`node scripts/redos_audit.mjs --root=... --allowlist=...
 *                   --tests=...`) against temporary source trees, allowlists and test directories built here:
 *                   exponential and quadratic patterns exit 1 and are named, safe code exits 0, an allowlist entry is only
 *                   honoured while its pattern is still flagged and its `enforcedBy` title exists, constant RegExp()
 *                   calls are analysed while dynamic ones are listed, test and vendor directories are ignored, and the
 *                   real package scan exits 0.
 *   2. EMPIRICAL  - an independent cross-check that does not use recheck at all: for each allowlisted pattern the worst
 *                   input its documented bound permits is fed to the real exported function and must finish inside a
 *                   fixed time budget, the cap is probed at its exact boundary, and an input 100 times the cap must be
 *                   neither slow nor read past the cap (observable in the return value).
 *
 * The gate scenarios need the optional dependency `recheck`; the empirical cross-check does not.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { buildUnImoIndex } from '../global-regtech-compliance-feed/connectors/ofac.js';
import { secEnforcementOptionsSchema } from '../global-regtech-compliance-feed/connectors/secEnforcement.js';
import { parseWorldBankSanctionDate } from '../global-regtech-compliance-feed/connectors/worldBankDebarred.js';
import { extractEmails, extractPhones, MAX_CONTACT_TEXT, MAX_TITLE_PARSE_LENGTH, parseTitle, resolveDate } from '../latam-global-tender-intelligence/connectors/arSantaFe.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = join(dirname(THIS_FILE), '..');
const AUDIT_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'redos_audit.mjs');
const SECOND_OPINION_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'redos_second_opinion.mjs');
const ALLOWLIST_PATH = join(PACKAGE_ROOT, 'scripts', 'redos_allowlist.json');
const REAL_TESTS_DIR = join(PACKAGE_ROOT, 'test');

interface AllowlistEntry {
    file: string;
    pattern: string;
    bound: string;
    enforcedBy: string;
}

const REAL_ALLOWLIST = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as AllowlistEntry[];

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recheckInstalled(): boolean {
    try {
        createRequire(AUDIT_SCRIPT).resolve('recheck');
        return true;
    } catch {
        return false;
    }
}

const RECHECK_INSTALLED = recheckInstalled();
const CHILD_TIMEOUT_MS = 120_000;
const SCENARIO_TIMEOUT_MS = 130_000;

interface AuditRun {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Runs a script of this package in a child process; resolves with its exit code and both streams. */
function runScript(script: string, args: readonly string[], options: { cwd?: string; nodeArgs?: readonly string[] } = {}): Promise<AuditRun> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [...(options.nodeArgs ?? []), script, ...args], {
            cwd: options.cwd ?? PACKAGE_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${script} did not finish within ${CHILD_TIMEOUT_MS} ms`));
        }, CHILD_TIMEOUT_MS);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolvePromise({ status, stdout, stderr });
        });
    });
}

/** Runs the real audit script. */
function runAudit(args: readonly string[], options: { cwd?: string; nodeArgs?: readonly string[] } = {}): Promise<AuditRun> {
    return runScript(AUDIT_SCRIPT, args, options);
}

const WORK_DIR = mkdtempSync(join(tmpdir(), 'redos-gate-'));
afterAll(() => {
    rmSync(WORK_DIR, { recursive: true, force: true });
});

interface CaseSpec {
    /** Source files, keyed by path relative to the scanned root. */
    sources: Readonly<Record<string, string>>;
    /** Files of the tests directory, keyed by relative path. */
    tests?: Readonly<Record<string, string>>;
    /** Content of the allowlist file (default: an empty array). */
    allowlist?: unknown;
}

interface AuditCase {
    base: string;
    root: string;
    testsDir: string;
    allowlistFile: string;
    args: string[];
}

let caseCounter = 0;

function writeTree(directory: string, files: Readonly<Record<string, string>>): void {
    for (const [name, content] of Object.entries(files)) {
        const target = join(directory, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
    }
}

/** The directory names the gate never descends into (scripts/redos_audit.mjs, SKIP_DIRS); scenario g pins each of them separately. */
const SKIPPED_DIRECTORY_NAMES: readonly string[] = ['node_modules', 'dist', 'stage', 'storage', 'fixtures', 'docs-research', '.actor', 'test'];

/** Every directory under `root` (relative, '/'-separated, '' for the root itself) that holds a .ts file and is not below a skipped directory. */
function sourceDirectories(root: string, relativeDirectory = ''): string[] {
    const nested: string[] = [];
    let holdsSources = false;
    for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORY_NAMES.includes(entry.name)) nested.push(...sourceDirectories(root, relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`));
        } else if (entry.name.endsWith('.ts')) {
            holdsSources = true;
        }
    }
    return holdsSources ? [relativeDirectory, ...nested] : nested;
}

function buildCase(spec: CaseSpec): AuditCase {
    caseCounter += 1;
    const base = join(WORK_DIR, `case-${caseCounter}`);
    const root = join(base, 'scan');
    const testsDir = join(base, 'tests');
    const allowlistFile = join(base, 'allowlist.json');
    mkdirSync(root, { recursive: true });
    mkdirSync(testsDir, { recursive: true });
    writeTree(root, spec.sources);
    writeTree(testsDir, spec.tests ?? {});
    writeFileSync(allowlistFile, JSON.stringify(spec.allowlist ?? [], null, 4), 'utf8');
    return { base, root, testsDir, allowlistFile, args: [`--root=${root}`, `--allowlist=${allowlistFile}`, `--tests=${testsDir}`] };
}

interface VulnerableSample {
    name: string;
    file: string;
    pattern: string;
    line: number;
    complexity: RegExp;
    code: string;
}

const VULNERABLE: readonly VulnerableSample[] = [
    {
        name: 'nested quantifier (a+)+$',
        file: 'src/nested_quantifier.ts',
        pattern: String.raw`(a+)+$`,
        line: 2,
        complexity: /exponential/,
        code: String.raw`// Classic catastrophic backtracking.
export const allA = /(a+)+$/;
export const isAllA = (value: string): boolean => allA.test(value);
`,
    },
    {
        name: 'overlapping alternation ^(a|aa)+$',
        file: 'src/overlapping_alternation.ts',
        pattern: String.raw`^(a|aa)+$`,
        line: 3,
        complexity: /exponential/,
        code: String.raw`// Two alternatives that can both consume the same characters.

export const runOfA = /^(a|aa)+$/;
`,
    },
    {
        name: 'unbounded trailing dash \\s*-\\s*$',
        file: 'src/trailing_dash.ts',
        pattern: String.raw`\s*-\s*$`,
        line: 3,
        complexity: /polynomial/,
        code: String.raw`// Applied to text of any length: quadratic on a long run of whitespace.
export function stripTrailingDash(value: string): string {
    return value.replace(/\s*-\s*$/, '');
}
`,
    },
];

const [NESTED, , TRAILING_DASH] = VULNERABLE as readonly [VulnerableSample, VulnerableSample, VulnerableSample];

const SAFE_SOURCE = [
    'export const isSlug = /^[a-z0-9-]+$/;',
    'export const isoDate = /^\\d{4}-\\d{2}-\\d{2}$/;',
    'export const keyword = /foo|bar/i;',
    "export const fromString = new RegExp('^[A-Z]{3}-\\\\d+$');",
    'export const fromTemplate = RegExp(`^v\\\\d+\\\\.\\\\d+$`);',
    '',
].join('\n');

function allowlistEntry(sample: VulnerableSample, enforcedBy: string, overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
    return { file: sample.file, pattern: sample.pattern, bound: 'The caller never passes more than 64 characters to the pattern.', enforcedBy, ...overrides };
}

function reportNames(run: AuditRun, sample: VulnerableSample): void {
    expect(run.stderr, `report for ${sample.file}`).toContain(`${sample.file}:`);
    expect(run.stderr, `report for ${sample.file}`).toContain(`/${sample.pattern}/`);
}

// recheck is an optional --no-save tool (npm install --no-save recheck): without it the gate cannot analyse anything.
describe.skipIf(!RECHECK_INSTALLED)('redos gate: scripts/redos_audit.mjs run as a child process against temporary trees', () => {
    describe('a) vulnerable patterns exit 1 and are named', () => {
        it.each(VULNERABLE.map((sample) => [sample.name, sample] as const))(
            '%s alone exits 1, with the file, the line and the pattern in the report',
            async (_name, sample) => {
                const auditCase = buildCase({ sources: { [sample.file]: sample.code } });
                const run = await runAudit(auditCase.args);
                expect(run.status, run.stderr).toBe(1);
                expect(run.stderr).toContain('NOT ALLOWLISTED  vulnerable');
                expect(run.stderr).toMatch(sample.complexity);
                expect(run.stderr).toContain(`${sample.file}:${sample.line}\n`);
                reportNames(run, sample);
                expect(run.stdout).toContain('safe: 0   flagged: 1');
            },
            SCENARIO_TIMEOUT_MS,
        );

        it('all three together exit 1 and each one is reported', async () => {
            const sources = Object.fromEntries(VULNERABLE.map((sample) => [sample.file, sample.code]));
            const run = await runAudit(buildCase({ sources }).args);
            expect(run.status, run.stderr).toBe(1);
            for (const sample of VULNERABLE) reportNames(run, sample);
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(3);
            expect(run.stderr).not.toContain('STALE ALLOWLIST ENTRY');
            expect(run.stdout).toContain('3 regex occurrences, 3 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 0   flagged: 3');
        }, SCENARIO_TIMEOUT_MS);

        it('a pattern recheck cannot decide (status unknown) fails closed instead of being counted safe', async () => {
            const sources = {
                'src/unicode_sets.ts': 'export const letters = /[\\p{L}--[a-z]]+/v;\n',
                'src/broken.ts': "export const broken = new RegExp('[');\n",
            };
            const run = await runAudit(buildCase({ sources }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr.match(/NOT ALLOWLISTED {2}unknown/g)).toHaveLength(2);
            expect(run.stderr).toContain('src/unicode_sets.ts:1\n  /[\\p{L}--[a-z]]+/');
            expect(run.stderr).toContain('src/broken.ts:1\n  /[/');
            expect(run.stdout).toContain('safe: 0   flagged: 2');
        }, SCENARIO_TIMEOUT_MS);

        it('a vulnerable pattern hidden among safe ones is still found and the safe ones are counted', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/safe.ts': SAFE_SOURCE, [TRAILING_DASH.file]: TRAILING_DASH.code } }).args);
            expect(run.status, run.stderr).toBe(1);
            reportNames(run, TRAILING_DASH);
            expect(run.stdout).toContain('safe: 5   flagged: 1');
            expect(run.stderr).not.toContain('src/safe.ts');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('b) safe patterns exit 0', () => {
        it('a tree of safe patterns, literal and constant RegExp() alike, exits 0 with an empty error stream', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/safe.ts': SAFE_SOURCE } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('5 regex occurrences, 5 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 5   flagged: 0');
        }, SCENARIO_TIMEOUT_MS);

        it('a tree without any regular expression exits 0', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/plain.ts': 'export const answer = 42;\n' } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toContain('0 regex occurrences, 0 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('c) an allowlisted pattern with a bound and an existing test title exits 0', () => {
        const title = 'stripTrailingDash is only called on capped values';

        it('the flagged pattern passes and is reported as allowlisted with its bound', async () => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
                tests: { 'trailing_dash.test.ts': `import { it } from 'vitest';\n\nit('${title}', () => {});\n` },
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('safe: 0   flagged: 1');
            expect(run.stdout).toMatch(/^allowlisted {2}[^\n]*polynomial[^\n]* {2}src\/trailing_dash\.ts {2}\(bound: The caller never passes more than 64 characters/m);
        }, SCENARIO_TIMEOUT_MS);

        it('an allowlisted entry does not excuse a second, unlisted vulnerable pattern', async () => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code, [NESTED.file]: NESTED.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
                tests: { 'trailing_dash.test.ts': `it('${title}', () => {});\n` },
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            reportNames(run, NESTED);
            expect(run.stderr).not.toContain(`${TRAILING_DASH.file}:`);
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('d) the same entry without an existing test title exits 1', () => {
        const title = 'stripTrailingDash is only called on capped values';
        const cases: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
            ['the tests directory is empty', {}],
            ['the tests directory has only other titles', { 'other.test.ts': "it('something unrelated', () => {});\n" }],
            ['the title only appears in a helper that is not a .test.ts file', { 'helper.ts': `export const name = '${title}';\n` }],
            ['the title only appears in a .spec.ts file', { 'trailing_dash.spec.ts': `it('${title}', () => {});\n` }],
            ['the title only appears in a subdirectory of the tests directory (only top-level *.test.ts files count)', { 'nested/deep.test.ts': `it('${title}', () => {});\n` }],
            ['the title only differs in letter case', { 'case.test.ts': `it('${title.toUpperCase()}', () => {});\n` }],
        ];

        it.each(cases)('%s', async (_name, tests) => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
                tests,
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain(`UNENFORCED  no test title contains "${title}"`);
            expect(run.stderr).toContain(`${TRAILING_DASH.file}  /${TRAILING_DASH.pattern}/`);
            expect(run.stdout).not.toContain('allowlisted');
        }, SCENARIO_TIMEOUT_MS);

        it('the control with the title in a .test.ts file exits 0, so the exit 1 above is caused by the missing title', async () => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
                tests: { 'trailing_dash.test.ts': `it('${title}', () => {});\n` },
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(0);
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('d2) an allowlist entry must be well formed and its enforcedBy must be a real test title', () => {
        const title = 'stripTrailingDash is only called on capped values';
        const goodTests = { 'trailing_dash.test.ts': `it('${title}', () => {});\n` };

        it.each([
            ['an empty enforcedBy (the empty string is a substring of everything)', { enforcedBy: '' }, 'enforcedBy'],
            ['a blank enforcedBy', { enforcedBy: '   ' }, 'enforcedBy'],
            ['an empty bound', { bound: '' }, 'bound'],
            ['a blank bound', { bound: '    ' }, 'bound'],
            ['a bound shorter than 20 characters', { bound: 'capped at 64' }, 'bound'],
        ])('%s makes the entry malformed and exits 1, even when the tests directory holds the title', async (_name, override, field) => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title, override)],
                tests: goodTests,
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('MALFORMED ALLOWLIST ENTRY #0');
            expect(run.stderr).toContain(`"${field}"`);
        }, SCENARIO_TIMEOUT_MS);

        it('a missing field and a non-string field make the entry malformed', async () => {
            const missing = { file: TRAILING_DASH.file, pattern: TRAILING_DASH.pattern, bound: 'The caller never passes more than 64 characters to the pattern.' };
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: TRAILING_DASH.code }, allowlist: [missing, { ...allowlistEntry(TRAILING_DASH, title), bound: 64 }], tests: goodTests }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('MALFORMED ALLOWLIST ENTRY #0');
            expect(run.stderr).toContain('MALFORMED ALLOWLIST ENTRY #1');
        }, SCENARIO_TIMEOUT_MS);

        it('a title that appears only in a comment or in an ordinary string is not a test title: exit 1', async () => {
            const tests = {
                'comments.test.ts': `// ${title}\n/* ${title} */\nconst name = '${title}';\nconsole.log('${title}');\nit('something else', () => {});\n`,
            };
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: TRAILING_DASH.code }, allowlist: [allowlistEntry(TRAILING_DASH, title)], tests }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain(`UNENFORCED  no test title contains "${title}"`);
        }, SCENARIO_TIMEOUT_MS);

        it.each([
            ['an it() title', `it('${title}', () => {});\n`],
            ['a test() title', `test('${title}', () => {});\n`],
            ['a describe() title', `describe('${title}', () => {});\n`],
            ['a nested it() title found through its describe path', `describe('outer', () => { describe('stripTrailingDash', () => { it('is only called on capped values', () => {}); }); });\n`],
            ['an it.each(table)(title) title', `it.each([[1]])('${title} %s', () => {});\n`],
            ['a describe.skipIf(cond)(title) title', `describe.skipIf(false)('${title}', () => {});\n`],
            ['a title built with + concatenation', `it('stripTrailingDash is only ' + 'called on capped values', () => {});\n`],
            ['a title in a template literal without substitutions', `it(\`${title}\`, () => {});\n`],
        ])('%s is accepted as the enforcing test', async (_name, body) => {
            const tests = { 'x.test.ts': body };
            const enforcedBy = body.includes('outer') ? 'stripTrailingDash > is only called on capped values' : title;
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: TRAILING_DASH.code }, allowlist: [allowlistEntry(TRAILING_DASH, enforcedBy)], tests }).args);
            expect(run.status, run.stderr).toBe(0);
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('d3) indirect regular expressions are analysed or listed, never invisible', () => {
        it.each([
            ['a string passed to .match()', "export const hit = (v: string) => v.match('(a+)+$');\n", /NOT ALLOWLISTED[^\n]*\n[^\n]*\n {2}\/\(a\+\)\+\$\//],
            ['a string passed to .search()', "export const hit = (v: string) => v.search('(a+)+$');\n", /\/\(a\+\)\+\$\//],
            ['a string passed to .matchAll()', "export const hit = (v: string) => [...v.matchAll('(a+)+$')];\n", /\/\(a\+\)\+\$\//],
        ])('%s that is exponential exits 1 and is named', async (_name, code, expected) => {
            const run = await runAudit(buildCase({ sources: { 'src/indirect.ts': code } }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toMatch(expected);
        }, SCENARIO_TIMEOUT_MS);

        it('a safe string passed to .match() is analysed and counted as safe', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/indirect.ts': "export const hit = (v: string) => v.match('^[a-z]+$');\n" } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toContain('safe: 1   flagged: 0');
        }, SCENARIO_TIMEOUT_MS);

        it.each([
            ['new globalThis.RegExp(x)', 'declare const x: string;\nexport const r = new globalThis.RegExp(x);\n', /src\/indirect\.ts:2 {2}new globalThis\.RegExp\(x\)/],
            ['an alias of RegExp', 'declare const x: string;\nconst R = RegExp;\nexport const r = new R(x);\n', /indirect reference: R = RegExp/],
            ['RegExp passed as an argument', 'declare const apply: (f: unknown) => void;\napply(RegExp);\n', /indirect reference: apply\(RegExp\)/],
        ])('%s is listed under the dynamic constructions for a reviewer', async (_name, code, expected) => {
            const run = await runAudit(buildCase({ sources: { 'src/indirect.ts': code } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toMatch(expected);
        }, SCENARIO_TIMEOUT_MS);

        it('ordinary uses of the RegExp name are not reported as aliases: a type, instanceof, a static member', async () => {
            const code = 'export const isRe = (v: unknown): v is RegExp => v instanceof RegExp;\nexport const proto = RegExp.prototype;\nexport const make = (): RegExp => new RegExp("^a$");\n';
            const run = await runAudit(buildCase({ sources: { 'src/indirect.ts': code } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).not.toContain('indirect reference');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('e) a stale allowlist entry exits 1', () => {
        const title = 'stripTrailingDash is only called on capped values';
        const tests = { 'trailing_dash.test.ts': `it('${title}', () => {});\n` };

        it('the pattern no longer exists anywhere in the tree', async () => {
            const auditCase = buildCase({ sources: { 'src/safe.ts': SAFE_SOURCE }, allowlist: [allowlistEntry(TRAILING_DASH, title)], tests });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('STALE ALLOWLIST ENTRY');
            expect(run.stderr).toContain(`${TRAILING_DASH.file}  /${TRAILING_DASH.pattern}/`);
            expect(run.stdout).toContain('safe: 5   flagged: 0');
        }, SCENARIO_TIMEOUT_MS);

        it('the pattern is still there but has been fixed and is no longer flagged', async () => {
            const fixed = "export function stripTrailingDash(value: string): string {\n    return value.replace(/-$/, '');\n}\n";
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: fixed },
                allowlist: [allowlistEntry(TRAILING_DASH, title, { pattern: '-$' })],
                tests,
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('STALE ALLOWLIST ENTRY');
            expect(run.stderr).toContain('/-$/');
        }, SCENARIO_TIMEOUT_MS);

        it('the entry names the right pattern in the wrong file: the real site is unlisted and the entry is stale', async () => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title, { file: 'src/moved_elsewhere.ts' })],
                tests,
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('NOT ALLOWLISTED');
            expect(run.stderr).toContain(`${TRAILING_DASH.file}:`);
            expect(run.stderr).toContain('STALE ALLOWLIST ENTRY');
            expect(run.stderr).toContain('src/moved_elsewhere.ts');
        }, SCENARIO_TIMEOUT_MS);

        it('one good entry and one stale entry: the stale one alone fails the run', async () => {
            const auditCase = buildCase({
                sources: { [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title), allowlistEntry(NESTED, title)],
                tests,
            });
            const run = await runAudit(auditCase.args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr.match(/STALE ALLOWLIST ENTRY/g)).toHaveLength(1);
            expect(run.stderr).toContain(`${NESTED.file}  /${NESTED.pattern}/`);
            expect(run.stderr).not.toContain('NOT ALLOWLISTED');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('f) RegExp() built from a constant string is analysed, a dynamic one is listed', () => {
        const constantSource = [
            "export const fromString = new RegExp('(a+)+$');",
            'export const fromCall = RegExp("^(a|aa)+$", "i");',
            'export const fromTemplate = new RegExp(`\\\\s*-\\\\s*$`);',
            '',
        ].join('\n');
        const dynamicSource = [
            'export const fromVariable = (userInput: string): RegExp => new RegExp(userInput);',
            "export const fromConcatenation = (prefix: string): RegExp => RegExp(prefix + '(a+)+$');",
            'export const fromNothing = new RegExp();',
            '',
        ].join('\n');

        it('constant string, constant call with flags and constant template are all analysed and flagged', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/constant_regexp.ts': constantSource } }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('src/constant_regexp.ts:1\n  /(a+)+$/');
            expect(run.stderr).toContain('src/constant_regexp.ts:2\n  /^(a|aa)+$/');
            expect(run.stderr).toContain('src/constant_regexp.ts:3\n  /\\s*-\\s*$/');
            expect(run.stdout).toContain('3 regex occurrences, 3 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 0   flagged: 3');
        }, SCENARIO_TIMEOUT_MS);

        it('a dynamic RegExp(variable) is counted and listed with file, line and text, and is not analysed', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/dynamic_regexp.ts': dynamicSource } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toContain('0 regex occurrences, 0 distinct (file, pattern) pairs, 3 dynamic RegExp() calls');
            expect(run.stdout).toContain('Dynamic RegExp() calls (read by hand: none takes external input):');
            expect(run.stdout).toContain('  src/dynamic_regexp.ts:1  new RegExp(userInput)');
            expect(run.stdout).toContain("  src/dynamic_regexp.ts:2  RegExp(prefix + '(a+)+$')");
            expect(run.stdout).toContain('  src/dynamic_regexp.ts:3  new RegExp()');
            expect(run.stdout).toContain('safe: 0   flagged: 0');
        }, SCENARIO_TIMEOUT_MS);

        it('constant and dynamic calls in one tree: the constant one fails the run, the dynamic one is still listed', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/constant_regexp.ts': constantSource, 'src/dynamic_regexp.ts': dynamicSource } }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stdout).toContain('3 dynamic RegExp() calls');
            expect(run.stdout).toContain('  src/dynamic_regexp.ts:1  new RegExp(userInput)');
            expect(run.stderr).toContain('src/constant_regexp.ts:1');
            expect(run.stderr).not.toContain('dynamic_regexp');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('g) files under the skipped directories are ignored', () => {
        const skipped = [
            'test/vulnerable.ts',
            'node_modules/package/index.ts',
            'dist/index.ts',
            'stage/index.ts',
            'storage/index.ts',
            'fixtures/sample.ts',
            'docs-research/sample.ts',
            '.actor/sample.ts',
            'src/connectors/fixtures/nested.ts',
            'src/test/helper.ts',
        ];
        const skippedSources = Object.fromEntries(skipped.map((name) => [name, NESTED.code]));

        it('a vulnerable pattern in each of them does not fail the run and is not counted', async () => {
            const run = await runAudit(buildCase({ sources: { 'src/ok.ts': 'export const ok = /^[a-z]+$/;\n', ...skippedSources } }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('1 regex occurrences, 1 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 1   flagged: 0');
        }, SCENARIO_TIMEOUT_MS);

        it('the control: the same pattern in a directory that is not skipped fails the run, and no skipped path is reported', async () => {
            const run = await runAudit(
                buildCase({ sources: { 'src/ok.ts': 'export const ok = /^[a-z]+$/;\n', 'src/connectors/live.ts': NESTED.code, ...skippedSources } }).args,
            );
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toContain('src/connectors/live.ts:2');
            for (const name of skipped) expect(run.stderr, name).not.toContain(name);
            expect(run.stdout).toContain('safe: 1   flagged: 1');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('i) an allowlist entry excuses exactly the one (file, pattern) it names', () => {
        const title = 'stripTrailingDash is only called on capped values';
        const tests = { 'trailing_dash.test.ts': `it('${title}', () => {});\n` };
        const allowlist = [allowlistEntry(TRAILING_DASH, title)];

        it('a second vulnerable pattern in the allowlisted file is reported while the listed one stays excused', async () => {
            const code = `${TRAILING_DASH.code}export const second = /(a+)+$/;\n`;
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: code }, allowlist, tests }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(1);
            expect(run.stderr).toContain(`${TRAILING_DASH.file}:5\n  /(a+)+$/`);
            expect(run.stderr).not.toContain('STALE ALLOWLIST ENTRY');
            expect(run.stdout).toMatch(/^allowlisted {2}[^\n]*polynomial[^\n]* {2}src\/trailing_dash\.ts /m);
            expect(run.stdout).toContain('safe: 0   flagged: 2');
        }, SCENARIO_TIMEOUT_MS);

        it('a vulnerable pattern that starts with, or wraps, the listed pattern is a different pattern and is reported', async () => {
            const code = `${TRAILING_DASH.code}export const prefixed = /${TRAILING_DASH.pattern}|(a+)+$/;\nexport const wrapped = /(?:${TRAILING_DASH.pattern})+/;\n`;
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: code }, allowlist, tests }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(2);
            expect(run.stderr).toContain(`${TRAILING_DASH.file}:5\n  /${TRAILING_DASH.pattern}|(a+)+$/`);
            expect(run.stderr).toContain(`${TRAILING_DASH.file}:6\n  /(?:${TRAILING_DASH.pattern})+/`);
            expect(run.stdout.match(/^allowlisted /gm)).toHaveLength(1);
        }, SCENARIO_TIMEOUT_MS);

        it('the same pattern in a file of the same name under another directory is not excused', async () => {
            const sources = { [TRAILING_DASH.file]: TRAILING_DASH.code, [`vendor/${TRAILING_DASH.file}`]: TRAILING_DASH.code };
            const run = await runAudit(buildCase({ sources, allowlist, tests }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(1);
            expect(run.stderr).toContain(`vendor/${TRAILING_DASH.file}:3\n`);
            expect(run.stdout.match(/^allowlisted /gm)).toHaveLength(1);
        }, SCENARIO_TIMEOUT_MS);

        it('one entry covers every line on which its pattern occurs in that file', async () => {
            const code = `${TRAILING_DASH.code}export const again = /${TRAILING_DASH.pattern}/;\n`;
            const run = await runAudit(buildCase({ sources: { [TRAILING_DASH.file]: code }, allowlist, tests }).args);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stderr).toBe('');
            expect(run.stdout).toContain('2 regex occurrences, 1 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout.match(/^allowlisted /gm)).toHaveLength(1);
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('j) occurrences are de-duplicated per (file, pattern, flags) and the flags are analysed with the pattern', () => {
        it('the same pattern on several lines is one report that lists every line, and the same pattern in another file is a second report', async () => {
            const sources = {
                'src/a.ts': 'export const one = /(a+)+$/;\nexport const gap = 1;\nexport const two = /(a+)+$/;\n',
                'src/b.ts': 'export const three = /(a+)+$/;\n',
            };
            const run = await runAudit(buildCase({ sources }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stdout).toContain('3 regex occurrences, 2 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 0   flagged: 2');
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(2);
            expect(run.stderr).toContain('src/a.ts:1,3\n  /(a+)+$/');
            expect(run.stderr).toContain('src/b.ts:1\n  /(a+)+$/');
        }, SCENARIO_TIMEOUT_MS);

        it('/^(a|A)+$/i is exponential, the same source without the i flag is safe, and the g flag does not hide a pattern', async () => {
            const sources = {
                'src/flags.ts': "export const viaLiteral = /^(a|A)+$/i;\nexport const viaCall = new RegExp('^(a|A)+$', 'i');\nexport const global = /(a+)+$/g;\n",
                'src/plain.ts': 'export const sameWithoutFlag = /^(a|A)+$/;\n',
            };
            const run = await runAudit(buildCase({ sources }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stdout).toContain('4 regex occurrences, 3 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(run.stdout).toContain('safe: 1   flagged: 2');
            expect(run.stderr.match(/NOT ALLOWLISTED {2}vulnerable exponential/g)).toHaveLength(2);
            expect(run.stderr).toContain('src/flags.ts:1,2\n  /^(a|A)+$/');
            expect(run.stderr).toContain('src/flags.ts:3\n  /(a+)+$/');
            expect(run.stderr).not.toContain('src/plain.ts');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('k) the real package scan reaches every directory that holds sources', () => {
        it('a vulnerable pattern planted in a mirror of each real source directory is reported once per directory, so no real directory name is skipped', async () => {
            const directories = sourceDirectories(PACKAGE_ROOT);
            expect(directories).toEqual(expect.arrayContaining(['', 'lib', 'scripts', 'global-regtech-compliance-feed/connectors', 'latam-global-tender-intelligence/connectors']));
            const planted = directories.map((directory) => (directory === '' ? 'redos_canary.ts' : `${directory}/redos_canary.ts`));
            const run = await runAudit(buildCase({ sources: Object.fromEntries(planted.map((name) => [name, 'export const canary = /(a+)+$/;\n'])) }).args);
            expect(run.status, run.stderr).toBe(1);
            expect(run.stdout).toContain(`${planted.length} regex occurrences, ${planted.length} distinct (file, pattern) pairs, 0 dynamic RegExp() calls`);
            expect(run.stderr.match(/NOT ALLOWLISTED/g)).toHaveLength(planted.length);
            for (const name of planted) expect(run.stderr, name).toContain(`  ${name}:1\n`);
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('command line', () => {
        it('relative flag values are resolved against the working directory', async () => {
            const auditCase = buildCase({ sources: { [NESTED.file]: NESTED.code } });
            const run = await runAudit(['--root=scan', '--allowlist=allowlist.json', '--tests=tests'], { cwd: auditCase.base });
            expect(run.status, run.stderr).toBe(1);
            reportNames(run, NESTED);
        }, SCENARIO_TIMEOUT_MS);

        it('an unknown flag, a missing directory and a missing allowlist are usage errors (64), not a clean or flagged result', async () => {
            const auditCase = buildCase({ sources: { 'src/safe.ts': SAFE_SOURCE } });
            const unknown = await runAudit([...auditCase.args, '--strict']);
            expect(unknown.status, unknown.stderr).toBe(64);
            expect(unknown.stderr).toContain('unknown argument "--strict"');
            const noRoot = await runAudit([`--root=${join(auditCase.base, 'absent')}`, `--allowlist=${auditCase.allowlistFile}`, `--tests=${auditCase.testsDir}`]);
            expect(noRoot.status, noRoot.stderr).toBe(64);
            expect(noRoot.stderr).toContain('--root is not a directory');
            const noTests = await runAudit([`--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`, `--tests=${join(auditCase.base, 'absent')}`]);
            expect(noTests.status, noTests.stderr).toBe(64);
            expect(noTests.stderr).toContain('--tests is not a directory');
            const noAllowlist = await runAudit([`--root=${auditCase.root}`, `--allowlist=${join(auditCase.base, 'absent.json')}`, `--tests=${auditCase.testsDir}`]);
            expect(noAllowlist.status, noAllowlist.stderr).toBe(64);
            expect(noAllowlist.stderr).toContain('--allowlist is not a file');
            for (const run of [unknown, noRoot, noTests, noAllowlist]) expect(run.stdout).toBe('');
        }, SCENARIO_TIMEOUT_MS);

        it('an allowlist that is not valid JSON, or not an array, is a usage error (64)', async () => {
            const auditCase = buildCase({ sources: { 'src/safe.ts': SAFE_SOURCE } });
            writeFileSync(auditCase.allowlistFile, '[{"file": ', 'utf8');
            const broken = await runAudit(auditCase.args);
            expect(broken.status, broken.stderr).toBe(64);
            expect(broken.stderr).toContain('--allowlist is not valid JSON');
            writeFileSync(auditCase.allowlistFile, '{"file": "src/safe.ts"}', 'utf8');
            const notArray = await runAudit(auditCase.args);
            expect(notArray.status, notArray.stderr).toBe(64);
            expect(notArray.stderr).toContain('must contain a JSON array');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('second opinion script (scripts/redos_second_opinion.mjs) on small trees', () => {
        const title = 'stripTrailingDash is only called on capped values';
        const manyPatterns = `${Array.from({ length: 190 }, (_, index) => `export const k${index} = /^k${index}$/;`).join('\n')}\n`;

        it('extracts exactly what the gate extracts: the same counts line on a tree with literals, constant and dynamic calls, and skipped directories', async () => {
            const auditCase = buildCase({
                sources: {
                    'src/safe.ts': SAFE_SOURCE,
                    [TRAILING_DASH.file]: TRAILING_DASH.code,
                    'src/constant_regexp.ts': ['export const a = new RegExp(\'(a+)+$\');', 'export const b = RegExp("^(a|aa)+$", "i");', ''].join('\n'),
                    'src/dynamic_regexp.ts': 'export const c = (v: string): RegExp => new RegExp(v);\n',
                    'fixtures/ignored.ts': NESTED.code,
                    'src/test/ignored.ts': NESTED.code,
                },
            });
            const gate = await runAudit(auditCase.args);
            const secondOpinion = await runScript(SECOND_OPINION_SCRIPT, ['--count', `--root=${auditCase.root}`]);
            expect(secondOpinion.status, secondOpinion.stderr).toBe(0);
            const countsLine = /^\d+ regex occurrences, \d+ distinct \(file, pattern\) pairs, \d+ dynamic RegExp\(\) calls$/m.exec(gate.stdout)?.[0];
            expect(countsLine, gate.stdout).toBe('8 regex occurrences, 8 distinct (file, pattern) pairs, 1 dynamic RegExp() calls');
            expect(secondOpinion.stdout.trim()).toBe(countsLine);
        }, SCENARIO_TIMEOUT_MS);

        it('samples every allowlisted pattern and every 9th safe pattern in file order, capped at 20, and nothing else', async () => {
            const auditCase = buildCase({
                sources: { 'src/many.ts': manyPatterns, [TRAILING_DASH.file]: TRAILING_DASH.code, [NESTED.file]: NESTED.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
            });
            const run = await runScript(SECOND_OPINION_SCRIPT, ['--json', '--timeout=15000', `--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`]);
            expect(run.status, run.stderr).toBe(0);
            const data = JSON.parse(run.stdout) as {
                sample: { allowlisted: number; safe: number; everyNth: number; safeTotal: number };
                rows: Array<{ group: string; pattern: string; gate: { status: string }; fuzz: { status: string }; automaton: { status: string } }>;
            };
            expect(data.sample).toEqual({ allowlisted: 1, safe: 20, everyNth: 9, safeTotal: 190 });
            const sampledSafe = data.rows.filter((row) => row.group === 'safe').map((row) => row.pattern);
            expect(sampledSafe).toEqual(Array.from({ length: 20 }, (_, n) => `^k${n * 9}$`));
            const allowlisted = data.rows.filter((row) => row.group === 'allowlisted');
            expect(allowlisted.map((row) => row.pattern)).toEqual([TRAILING_DASH.pattern]);
            expect(data.rows.some((row) => row.pattern === NESTED.pattern), 'a flagged pattern that is not allowlisted is not part of the sample').toBe(false);
            for (const row of data.rows) {
                for (const backend of [row.gate, row.fuzz, row.automaton]) expect(['safe', 'vulnerable', 'unknown']).toContain(backend.status);
            }
            expect(allowlisted[0]?.gate.status).toBe('vulnerable');
        }, SCENARIO_TIMEOUT_MS);

        it('prints a Markdown table with one row per sampled pattern and a disagreement section', async () => {
            const auditCase = buildCase({
                sources: { 'src/safe.ts': SAFE_SOURCE, [TRAILING_DASH.file]: TRAILING_DASH.code },
                allowlist: [allowlistEntry(TRAILING_DASH, title)],
            });
            const run = await runScript(SECOND_OPINION_SCRIPT, ['--timeout=15000', `--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`]);
            expect(run.status, run.stderr).toBe(0);
            expect(run.stdout).toContain('| group | file:line | pattern | gate (auto) | fuzz | automaton | agree |');
            expect(run.stdout).toMatch(/^\| allowlisted \| src\/trailing_dash\.ts:3 \| `\\s\*-\\s\*\$` \| vulnerable/m);
            expect(run.stdout).toMatch(/^\| safe \| src\/safe\.ts:1 \| `\^\[a-z0-9-\]\+\$` \| safe/m);
            expect(run.stdout).toContain('## Patterns on which the backends disagree');
        }, SCENARIO_TIMEOUT_MS);

        interface BackendVerdict {
            status: string;
            detail: string;
            checker: string | null;
        }
        interface SecondOpinionRow {
            group: string;
            file: string;
            pattern: string;
            gate: BackendVerdict;
            fuzz: BackendVerdict;
            automaton: BackendVerdict;
            statusAgree: boolean;
            classAgree: boolean;
            contradiction: boolean;
        }
        interface SecondOpinionData {
            countsLine: string;
            distinct: number;
            gateSafe: number;
            gateSafeProvedByAutomaton: number;
            gateSafeByFuzzOnly: number;
            gateFlagged: number;
            tally: Record<'gate' | 'fuzz' | 'automaton', Record<string, number>>;
            disagree: unknown[];
            rows: SecondOpinionRow[];
        }

        // The OFAC IMO pattern is the one pattern of the real package on which the backends contradict each other: the
        // automaton checker proves the bounded repetition safe, the fuzzer (and so the gate, which falls back to it) flags it.
        const imoPattern = String.raw`IMO[^0-9]{0,40}?(\d{7})\b`;
        function contradictionCase(): AuditCase {
            return buildCase({
                sources: {
                    'src/imo.ts': `export const imo = /${imoPattern}/gi;\n`,
                    [TRAILING_DASH.file]: TRAILING_DASH.code,
                    [`vendor/${TRAILING_DASH.file}`]: TRAILING_DASH.code,
                    'src/safe.ts': 'export const slug = /^[a-z0-9-]+$/;\n',
                },
                allowlist: [{ file: 'src/imo.ts', pattern: imoPattern, bound: 'At most 41 characters are scanned per start position.', enforcedBy: 'not read by this script' }, allowlistEntry(TRAILING_DASH, title)],
            });
        }

        it('records every backend verdict and its checker, flags the contradiction, and counts the verdicts per backend', async () => {
            const auditCase = contradictionCase();
            const run = await runScript(SECOND_OPINION_SCRIPT, ['--json', '--timeout=15000', `--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`]);
            expect(run.status, run.stderr).toBe(0);
            const data = JSON.parse(run.stdout) as SecondOpinionData;
            // The copy under vendor/ names the same pattern in another file: it is flagged but not allowlisted, so it is not sampled.
            expect(data.rows.map((row) => `${row.group}:${row.file}`)).toEqual(['allowlisted:src/imo.ts', `allowlisted:${TRAILING_DASH.file}`, 'safe:src/safe.ts']);
            const [imo, dash, slug] = data.rows as [SecondOpinionRow, SecondOpinionRow, SecondOpinionRow];
            expect(imo).toMatchObject({ statusAgree: false, classAgree: false, contradiction: true });
            expect([imo.gate.status, imo.fuzz.status, imo.automaton.status]).toEqual(['vulnerable', 'vulnerable', 'safe']);
            // Same status and, once the "(fuzz)" tag is removed, the same degree: the three backends agree completely.
            expect(dash).toMatchObject({ statusAgree: true, classAgree: true, contradiction: false });
            expect([dash.gate.status, dash.fuzz.status, dash.automaton.status]).toEqual(['vulnerable', 'vulnerable', 'vulnerable']);
            expect(slug).toMatchObject({ statusAgree: true, classAgree: true, contradiction: false });
            expect([slug.gate.status, slug.fuzz.status, slug.automaton.status]).toEqual(['safe', 'safe', 'safe']);
            for (const row of data.rows) {
                expect(row.fuzz.checker, `fuzz backend of ${row.file}`).toBe('fuzz');
                expect(row.automaton.checker, `automaton backend of ${row.file}`).toBe('automaton');
            }
            expect(data.disagree).toEqual([{ file: 'src/imo.ts', pattern: imoPattern, gate: 'vulnerable', fuzz: 'vulnerable', automaton: 'safe', contradiction: true }]);
            for (const name of ['gate', 'fuzz', 'automaton'] as const) {
                const recount: Record<string, number> = {};
                for (const row of data.rows) recount[row[name].status] = (recount[row[name].status] ?? 0) + 1;
                expect(data.tally[name], `tally of ${name}`).toEqual(recount);
            }
            expect(data.tally.automaton).toEqual({ safe: 2, vulnerable: 1 });
            expect(data.tally.gate).toEqual({ vulnerable: 2, safe: 1 });
            expect(data.countsLine).toBe('4 regex occurrences, 4 distinct (file, pattern) pairs, 0 dynamic RegExp() calls');
            expect(data).toMatchObject({ distinct: 4, gateSafe: 1, gateSafeProvedByAutomaton: 1, gateSafeByFuzzOnly: 0, gateFlagged: 3 });
        }, SCENARIO_TIMEOUT_MS);

        it('marks the contradiction in the Markdown table, lists it under the disagreements and states where the safe verdicts come from', async () => {
            const auditCase = contradictionCase();
            const run = await runScript(SECOND_OPINION_SCRIPT, ['--timeout=15000', `--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`]);
            expect(run.status, run.stderr).toBe(0);
            const lines = run.stdout.split('\n');
            const rowOf = (prefix: string): string => lines.find((line) => line.startsWith(prefix)) ?? '';
            expect(rowOf('| allowlisted | src/imo.ts:1 |')).toMatch(/\| CONTRADICTION \|$/);
            expect(rowOf(`| allowlisted | ${TRAILING_DASH.file}:3 |`)).toMatch(/\| yes \|$/);
            expect(rowOf('| safe | src/safe.ts:1 |')).toMatch(/\| yes \|$/);
            expect(run.stdout).toContain(`- CONTRADICTION: src/imo.ts \`${imoPattern}\`  gate vulnerable, fuzz vulnerable, automaton safe`);
            expect(run.stdout).toContain('Of the 1 safe verdicts, 1 come from the automaton checker (a proof) and 0 from the fuzzer (no attack found).');
            expect(run.stdout).toContain('- automaton: safe 2, vulnerable 1');
            expect(run.stdout).toContain('- gate: vulnerable 2, safe 1');
        }, SCENARIO_TIMEOUT_MS);

        it('samples in sorted file order whatever order the files were created in', async () => {
            // 7 is coprime with 25, so the creation order is a fixed permutation that is neither ascending nor descending.
            // On Linux fs.readdirSync already returns sorted names (libuv scandir), so this pins the documented order of the sample,
            // not the .sort() call in the script: removing that call is invisible on this platform.
            const creationOrder = Array.from({ length: 25 }, (_, index) => (index * 7) % 25);
            const sources = Object.fromEntries(creationOrder.map((n) => [`src/p${String(n).padStart(2, '0')}.ts`, `export const p${n} = /^p${n}$/;\n`]));
            const auditCase = buildCase({ sources });
            const run = await runScript(SECOND_OPINION_SCRIPT, ['--json', '--timeout=15000', `--root=${auditCase.root}`, `--allowlist=${auditCase.allowlistFile}`]);
            expect(run.status, run.stderr).toBe(0);
            const data = JSON.parse(run.stdout) as SecondOpinionData;
            expect(data.rows.map((row) => row.file)).toEqual(['src/p00.ts', 'src/p09.ts', 'src/p18.ts']);
            expect(data.rows.map((row) => row.pattern)).toEqual(['^p0$', '^p9$', '^p18$']);
        }, SCENARIO_TIMEOUT_MS);

        it('rejects an unknown flag and a malformed timeout with exit 64', async () => {
            const unknown = await runScript(SECOND_OPINION_SCRIPT, ['--everything']);
            expect(unknown.status, unknown.stderr).toBe(64);
            const timeout = await runScript(SECOND_OPINION_SCRIPT, ['--timeout=soon']);
            expect(timeout.status, timeout.stderr).toBe(64);
            expect(unknown.stdout + timeout.stdout).toBe('');
        }, SCENARIO_TIMEOUT_MS);
    });

    describe('h) the real package scan', () => {
        it('exits 0 with and without explicit flags, prints its counts line, and lists every real allowlist entry as allowlisted', async () => {
            const [byDefault, explicit] = await Promise.all([
                runAudit([]),
                runAudit([`--root=${PACKAGE_ROOT}`, `--allowlist=${ALLOWLIST_PATH}`, `--tests=${REAL_TESTS_DIR}`]),
            ]);
            for (const run of [byDefault, explicit]) {
                expect(run.status, run.stderr).toBe(0);
                expect(run.stderr).toBe('');
                const counts = /^(\d+) regex occurrences, (\d+) distinct \(file, pattern\) pairs, (\d+) dynamic RegExp\(\) calls$/m.exec(run.stdout);
                const verdict = /^safe: (\d+) {3}flagged: (\d+)$/m.exec(run.stdout);
                expect(counts, run.stdout).not.toBeNull();
                expect(verdict, run.stdout).not.toBeNull();
                const [, occurrences, distinct] = (counts ?? []).map(Number);
                const [, safe, flagged] = (verdict ?? []).map(Number);
                expect(occurrences).toBeGreaterThanOrEqual(distinct ?? Infinity);
                expect((safe ?? 0) + (flagged ?? 0)).toBe(distinct);
                expect(flagged).toBe(REAL_ALLOWLIST.length);
                const allowlistedLines = run.stdout.split('\n').filter((line) => line.startsWith('allowlisted'));
                expect(allowlistedLines).toHaveLength(REAL_ALLOWLIST.length);
                for (const entry of REAL_ALLOWLIST) expect(allowlistedLines.some((line) => line.includes(entry.file)), entry.file).toBe(true);
            }
            // The complexity text of the OFAC IMO line comes from recheck's fuzzer, which works against a time budget: on a loaded machine the
            // same pattern is reported as "2nd degree" in one run and "3rd degree" in the next. The two runs are therefore compared by file and
            // bound; the degree is dropped from each line.
            const withoutDegree = (line: string): string => line.replace(/^allowlisted {2}.+? {2}(?=\S+\.ts {2}\(bound: )/, 'allowlisted  ');
            const allowlisted = (run: AuditRun): string[] => run.stdout.split('\n').filter((line) => line.startsWith('allowlisted')).map(withoutDegree);
            expect(allowlisted(byDefault)).toHaveLength(REAL_ALLOWLIST.length);
            for (const line of allowlisted(byDefault)) expect(line, 'the degree must have been removed, leaving file and bound').toMatch(/^allowlisted {2}\S+\.ts {2}\(bound: /);
            expect(allowlisted(explicit)).toEqual(allowlisted(byDefault));
        }, SCENARIO_TIMEOUT_MS);
    });
});

describe('redos gate: it cannot be satisfied by this test file, and it exits 2 without recheck', () => {
    it('this file does not itself contain any real `enforcedBy` title, so it cannot satisfy the real gate on its own', () => {
        const source = readFileSync(THIS_FILE, 'utf8');
        for (const entry of REAL_ALLOWLIST) expect(source.includes(entry.enforcedBy), entry.enforcedBy).toBe(false);
    });

    it('every real `enforcedBy` names an it()/describe() title in some other test file, not just a mention in a comment', () => {
        const others = readdirSync(REAL_TESTS_DIR)
            .filter((name) => name.endsWith('.test.ts') && join(REAL_TESTS_DIR, name) !== THIS_FILE)
            .map((name) => readFileSync(join(REAL_TESTS_DIR, name), 'utf8'));
        const titleLine = (title: string): RegExp => new RegExp(`^\\s*(?:it|test|describe)(?:\\.\\w+)?\\(\\s*(['"\`])[^\\n]*${escapeRegExp(title)}`, 'm');
        for (const entry of REAL_ALLOWLIST) {
            expect(others.some((text) => titleLine(entry.enforcedBy).test(text)), entry.enforcedBy).toBe(true);
        }
    });

    it('exits 2 and says how to install recheck when recheck cannot be imported', async () => {
        const hook = `export async function resolve(specifier, context, nextResolve) { if (specifier === 'recheck') throw new Error('blocked by the test'); return nextResolve(specifier, context); }`;
        const hookUrl = `data:text/javascript,${encodeURIComponent(hook)}`;
        const preload = `import { register } from 'node:module'; register(${JSON.stringify(hookUrl)});`;
        const run = await runAudit([], { nodeArgs: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] });
        expect(run.status, run.stderr).toBe(2);
        expect(run.stderr).toContain('recheck is not installed. Run: npm install --no-save recheck');
        expect(run.stdout).toBe('');
    }, SCENARIO_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------------------
// Independent empirical cross-check of the six allowlisted patterns (no recheck involved).
// ---------------------------------------------------------------------------------------------------------------------

const BUDGET_MS = 250;
const NOW = new Date('2026-10-21T00:00:00Z');

function timed<T>(fn: () => T): { value: T; ms: number } {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
}

/** Best of `runs` executions, so a scheduling hiccup on a busy machine cannot fail a bound that is met by a wide margin. */
function bestOf<T>(runs: number, fn: () => T): { value: T; ms: number } {
    let best = timed(fn);
    for (let i = 1; i < runs; i += 1) {
        const next = timed(fn);
        if (next.ms < best.ms) best = next;
    }
    return best;
}

function unRecord(comments: string): string {
    return `<CONSOLIDATED_LIST><INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>X</FIRST_NAME><COMMENTS1>${comments}</COMMENTS1></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;
}

function dateOutcome(value: string): string {
    try {
        return resolveDate(value, NOW, 'openingFrom');
    } catch (error) {
        return (error as Error).message.length < 400 ? 'invalid' : 'invalid (the message echoes the input)';
    }
}

function titleOutcome(title: string): string {
    const parts = parseTitle(title);
    return parts.numero === null ? 'unparsed' : `${parts.numero}/${parts.anio}`;
}

function userAgentOutcome(userAgent: string): string {
    const result = secEnforcementOptionsSchema.safeParse({ userAgent });
    return result.success ? 'accepted' : `rejected: ${[...new Set(result.error.issues.map((issue) => issue.code))].join('+')}`;
}

interface PatternCase {
    file: string;
    pattern: string;
    /** The narrowest exported function through which the pattern is applied. */
    caller: string;
    /** The number the allowlist `bound` text states for this pattern. */
    documentedLimit: number;
    /** The longest input the cap lets reach the pattern, or null when the bound is a scanning window, not an input cap. */
    maxInputLength: number | null;
    run: (input: string) => unknown;
    /** Inputs the bound permits that drive the pattern into its worst case. */
    worst: readonly string[];
    /** What `run` returns for every worst-case input: nothing matches, so the pattern ran to failure. */
    worstResult: unknown;
    /** An input whose match ends exactly at the cap: it is processed in full. */
    atCap: readonly [input: string, result: unknown];
    /** The same input one character beyond the cap: the match is cut off or the pattern is never applied. */
    overCap: readonly [input: string, result: unknown];
    /** 100 times the cap: a benign input whose match lies beyond the cap, and a hostile one. */
    hundredfold: { benign: string; benignResult: unknown; hostile: string; hostileResult: unknown };
}

const PATTERN_CASES: readonly PatternCase[] = [
    {
        file: 'global-regtech-compliance-feed/connectors/ofac.ts',
        pattern: String.raw`IMO[^0-9]{0,40}?(\d{7})\b`,
        caller: 'buildUnImoIndex',
        documentedLimit: 41,
        maxInputLength: null,
        run: (comments) => [...buildUnImoIndex(unRecord(comments)).keys()],
        worst: ['IMO'.repeat(14), 'IMO'.repeat(33_334), `IMO${' '.repeat(40)}123456 `.repeat(2_000)],
        worstResult: [],
        atCap: [`IMO${' '.repeat(40)}1234567`, ['1234567']],
        overCap: [`IMO${' '.repeat(41)}1234567`, []],
        hundredfold: { benign: `IMO${' '.repeat(4_100)}1234567`, benignResult: [], hostile: 'IMO'.repeat(1_400), hostileResult: [] },
    },
    {
        file: 'global-regtech-compliance-feed/connectors/secEnforcement.ts',
        pattern: String.raw`(?:https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+)`,
        caller: 'secEnforcementOptionsSchema.userAgent',
        documentedLimit: 200,
        maxInputLength: 200,
        run: userAgentOutcome,
        worst: ['a'.repeat(200), 'a.'.repeat(100), `${'a'.repeat(199)}@`, `${'a'.repeat(150)}@${'a'.repeat(49)}`],
        worstResult: 'rejected: custom',
        atCap: [`${'x'.repeat(184)} ops@example.org`, 'accepted'],
        overCap: [`${'x'.repeat(185)} ops@example.org`, 'rejected: too_big+custom'],
        hundredfold: {
            benign: `${'x'.repeat(19_984)} ops@example.org`,
            benignResult: 'rejected: too_big+custom',
            hostile: `${'a'.repeat(19_999)}@`,
            hostileResult: 'rejected: too_big+custom',
        },
    },
    {
        file: 'global-regtech-compliance-feed/connectors/worldBankDebarred.ts',
        pattern: String.raw`([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})`,
        caller: 'parseWorldBankSanctionDate',
        documentedLimit: 256,
        maxInputLength: 256,
        run: (value) => parseWorldBankSanctionDate(value)?.toISOString() ?? null,
        worst: ['A'.repeat(256), `${'A'.repeat(128)}${' '.repeat(128)}`, 'A '.repeat(128)],
        worstResult: null,
        atCap: [`${' '.repeat(239)}February 12, 2026`, '2026-02-12T00:00:00.000Z'],
        overCap: [`${' '.repeat(240)}February 12, 2026`, null],
        hundredfold: { benign: `${' '.repeat(25_600)}February 12, 2026`, benignResult: null, hostile: 'A'.repeat(25_600), hostileResult: null },
    },
    {
        file: 'latam-global-tender-intelligence/connectors/arSantaFe.ts',
        pattern: String.raw`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`,
        caller: 'extractEmails',
        documentedLimit: 1000,
        maxInputLength: MAX_CONTACT_TEXT,
        run: extractEmails,
        worst: ['.'.repeat(1000), 'a'.repeat(1000), `${'a'.repeat(500)}@${'.'.repeat(499)}`, `${'a'.repeat(500)}@${'a.'.repeat(250)}`.slice(0, 1000)],
        worstResult: [],
        atCap: [`${' '.repeat(984)}soon@example.org`, ['soon@example.org']],
        overCap: [`${' '.repeat(985)}soon@example.org`, ['soon@example.or']],
        hundredfold: { benign: `${' '.repeat(100_000)}late@example.org`, benignResult: [], hostile: '.'.repeat(100_000), hostileResult: [] },
    },
    {
        file: 'latam-global-tender-intelligence/connectors/arSantaFe.ts',
        pattern: String.raw`^(.*?)\s+N[º°o.]*\s*(\S+?)\/(\d{4})\s*$`,
        caller: 'parseTitle',
        documentedLimit: 200,
        maxInputLength: MAX_TITLE_PARSE_LENGTH,
        run: titleOutcome,
        worst: [`${'\t'.repeat(60)}N${'o'.repeat(135)}/000`, `${'\t'.repeat(60)}\nN${'.'.repeat(60)}0\nN//0000`, `${' '.repeat(100)}N${' '.repeat(95)}/12x`],
        worstResult: 'unparsed',
        atCap: [`LICITACION PUBLICA N 18/2026${' '.repeat(172)}`, '18/2026'],
        overCap: [`LICITACION PUBLICA N 18/2026${' '.repeat(173)}`, 'unparsed'],
        hundredfold: {
            benign: `LICITACION PUBLICA N 18/2026${' '.repeat(19_972)}`,
            benignResult: 'unparsed',
            hostile: `${'\t'.repeat(6_000)}N${'o'.repeat(13_995)}/000`,
            hostileResult: 'unparsed',
        },
    },
    {
        file: 'latam-global-tender-intelligence/connectors/arSantaFe.ts',
        pattern: String.raw`^(?:(\+|-|in\s+)\s*)?(\d+)\s*(day|week|month|year)s?(?:\s+ago)?$`,
        caller: 'resolveDate',
        documentedLimit: 64,
        maxInputLength: 64,
        run: dateOutcome,
        worst: [`in${' '.repeat(61)}x`, `+${' '.repeat(62)}x`, `in${' '.repeat(30)}1${' '.repeat(29)}x`],
        worstResult: 'invalid',
        atCap: [`+${' '.repeat(57)}7 days`, dateOutcome('+7 days')],
        overCap: [`+${' '.repeat(58)}7 days`, 'invalid'],
        hundredfold: { benign: `+${' '.repeat(6_393)}7 days`, benignResult: 'invalid', hostile: `in${' '.repeat(6_400)}x`, hostileResult: 'invalid' },
    },
];

const patternKey = (file: string, pattern: string): string => `${file}\u0000${pattern}`;

describe('empirical cross-check: the allowlisted patterns are bounded by their documented caps', () => {
    it('has a case for every allowlist entry and none for a pattern that is not allowlisted', () => {
        expect(PATTERN_CASES.map((c) => patternKey(c.file, c.pattern)).sort()).toEqual(REAL_ALLOWLIST.map((e) => patternKey(e.file, e.pattern)).sort());
    });

    it('the expected values the cases rely on are real: the plain relative date resolves, the Santa Fe caps are the documented numbers', () => {
        expect(dateOutcome('+7 days')).toMatch(/^2026-10-\d{2}$/);
        expect(MAX_CONTACT_TEXT).toBe(1000);
        expect(MAX_TITLE_PARSE_LENGTH).toBe(200);
    });

    describe.each(PATTERN_CASES.map((c) => [`${c.caller}  /${c.pattern}/`, c] as const))('%s', (_label, c) => {
        it('is the pattern the allowlist documents, applied in that file, with the limit the bound text states', () => {
            const entry = REAL_ALLOWLIST.find((e) => e.file === c.file && e.pattern === c.pattern);
            expect(entry, 'allowlist entry').toBeDefined();
            expect(entry?.bound, 'bound text').toMatch(new RegExp(`(?:^|[^0-9])${c.documentedLimit}(?:[^0-9]|$)`));
            expect(readFileSync(join(PACKAGE_ROOT, c.file), 'utf8')).toContain(`/${c.pattern}/`);
        });

        it(`the worst input the bound permits finishes within ${BUDGET_MS} ms`, () => {
            for (const input of c.worst) {
                if (c.maxInputLength !== null) expect(input.length, 'worst-case input must respect the cap').toBeLessThanOrEqual(c.maxInputLength);
                const { value, ms } = bestOf(3, () => c.run(input));
                expect(ms, `${c.caller} on ${input.length} characters took ${ms.toFixed(3)} ms (budget ${BUDGET_MS} ms)`).toBeLessThan(BUDGET_MS);
                expect(value, `${c.caller} on ${input.length} characters: the pattern must have run to failure`).toEqual(c.worstResult);
            }
        });

        it('enforces the cap exactly: the match at the cap is processed, one character further is not', () => {
            const [accepted, acceptedResult] = c.atCap;
            const [rejected, rejectedResult] = c.overCap;
            expect(rejected.length, 'the over-cap input is exactly one character longer').toBe(accepted.length + 1);
            expect(c.run(accepted)).toEqual(acceptedResult);
            expect(c.run(rejected)).toEqual(rejectedResult);
        });

        it(`an input 100 times the cap neither hangs (${BUDGET_MS} ms) nor is read beyond the cap`, () => {
            const { benign, benignResult, hostile, hostileResult } = c.hundredfold;
            expect(benign.length).toBeGreaterThanOrEqual(100 * c.documentedLimit);
            expect(hostile.length).toBeGreaterThanOrEqual(100 * c.documentedLimit);
            expect(c.run(benign), 'nothing beyond the cap may be processed').toEqual(benignResult);
            const { value, ms } = timed(() => c.run(hostile));
            expect(ms, `${c.caller} on ${hostile.length} characters took ${ms.toFixed(3)} ms (budget ${BUDGET_MS} ms)`).toBeLessThan(BUDGET_MS);
            expect(value).toEqual(hostileResult);
        });
    });

    it('extractPhones, the second caller of the e-mail pattern, is capped the same way on 100 KB of dots', () => {
        const hostile = '.'.repeat(100 * MAX_CONTACT_TEXT);
        const { value, ms } = timed(() => extractPhones(hostile));
        expect(ms, `extractPhones on ${hostile.length} characters took ${ms.toFixed(3)} ms (budget ${BUDGET_MS} ms)`).toBeLessThan(BUDGET_MS);
        expect(value).toEqual([]);
        expect(extractPhones('+54 9 342 4519632')).toHaveLength(1);
        expect(extractPhones(`${' '.repeat(MAX_CONTACT_TEXT)}+54 9 342 4519632`)).toEqual([]);
    });
});
