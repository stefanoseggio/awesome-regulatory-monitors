/**
 * Second opinion on the static ReDoS gate (scripts/redos_audit.mjs). Slow, so it is NOT part of the test suite.
 *
 *   npm install --no-save recheck && node scripts/redos_second_opinion.mjs
 *
 * The gate asks `recheck` with its default checker ("auto": the automaton algorithm when the pattern is small enough,
 * the fuzzer otherwise). This script asks the same question three ways for a fixed sample and prints a Markdown table:
 *
 *   gate       checker "auto", the call the gate makes
 *   fuzz       checker "fuzz" (fuzzing with static seeding: it finds attack strings, a "safe" verdict is a failure to find one)
 *   automaton  checker "automaton" (a decision procedure over the NFA: exact, but it refuses patterns it cannot model)
 *
 * The sample is every pattern the allowlist names (the ones the gate lets through) plus every 9th of the patterns the
 * gate calls safe, in file order (indexes 0, 9, 18, ... of the safe list, at most 20 of them). Patterns are extracted
 * exactly as the gate extracts them (TypeScript AST, regex literals and constant RegExp(...) calls, same skipped
 * directories, same de-duplication by file + pattern + flags, `g`, `d` and `y` removed before analysis).
 *
 * "disagree" lists the patterns on which the three verdicts are not all equal. A "contradiction" is the serious case:
 * one backend says safe and another says vulnerable. A mix with `unknown` (timeout, unsupported syntax) is only
 * inconclusive.
 *
 * Flags: --timeout=<ms> per check (default 20000, the gate's value), --json prints the data instead of the table,
 * --count prints only the gate's counts line and needs no recheck, --root=<dir> and --allowlist=<file> as in the gate.
 * Exit codes: 0 = done, 2 = recheck is not installed, 64 = invalid command line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(PACKAGE_ROOT, 'package.json'));
const ts = require('typescript');

const SAMPLE_EVERY = 9;
const SAMPLE_LIMIT = 20;
const BACKENDS = ['gate', 'fuzz', 'automaton'];
const USAGE = 'usage: node scripts/redos_second_opinion.mjs [--timeout=<ms>] [--json] [--count] [--root=<dir>] [--allowlist=<file>]';

function usageError(message) {
    console.error(`${message}\n${USAGE}`);
    process.exit(64);
}

function parseArguments(argv) {
    const options = { root: PACKAGE_ROOT, allowlist: join(PACKAGE_ROOT, 'scripts', 'redos_allowlist.json'), timeout: 20000, json: false, count: false };
    for (const arg of argv) {
        if (arg === '--json') options.json = true;
        else if (arg === '--count') options.count = true;
        else if (/^--(root|allowlist)=.+$/.test(arg)) options[arg.slice(2, arg.indexOf('='))] = resolve(arg.slice(arg.indexOf('=') + 1));
        else if (/^--timeout=[1-9]\d*$/.test(arg)) options.timeout = Number(arg.slice('--timeout='.length));
        else usageError(`unknown argument "${arg}"`);
    }
    return options;
}

const OPTIONS = parseArguments(process.argv.slice(2));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'stage', 'storage', 'fixtures', 'docs-research', '.actor', 'test']);

function walk(dir, out = []) {
    for (const name of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

const found = [];
let dynamicCount = 0;
for (const file of walk(OPTIONS.root)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
            const text = node.getText();
            const last = text.lastIndexOf('/');
            found.push({ file: relative(OPTIONS.root, file), line, source: text.slice(1, last), flags: text.slice(last + 1) });
        } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText() === 'RegExp') {
            const arg = node.arguments?.[0];
            const flagsArg = node.arguments?.[1];
            if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
                found.push({ file: relative(OPTIONS.root, file), line, source: arg.text, flags: flagsArg && ts.isStringLiteral(flagsArg) ? flagsArg.text : '' });
            } else {
                dynamicCount += 1;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

const unique = new Map();
for (const r of found) {
    const key = `${r.file}\u0000${r.source}\u0000${r.flags}`;
    unique.set(key, [...(unique.get(key) ?? []), r.line]);
}
const countsLine = `${found.length} regex occurrences, ${unique.size} distinct (file, pattern) pairs, ${dynamicCount} dynamic RegExp() calls`;

if (OPTIONS.count) {
    console.log(countsLine);
    process.exit(0);
}

let check;
let recheckVersion = 'unknown';
try {
    ({ check } = await import('recheck'));
    recheckVersion = require('recheck/package.json').version;
} catch {
    console.error('recheck is not installed. Run: npm install --no-save recheck');
    process.exit(2);
}

let allowlist;
try {
    allowlist = JSON.parse(readFileSync(OPTIONS.allowlist, 'utf8'));
} catch (error) {
    usageError(`--allowlist cannot be read: ${error.message}`);
}
if (!Array.isArray(allowlist)) usageError('--allowlist must contain a JSON array');

function summarise(result) {
    if (result.status === 'unknown') return { status: 'unknown', detail: result.error?.kind ?? 'error', checker: result.checker ?? null };
    return { status: result.status, detail: result.complexity?.summary ?? result.complexity?.type ?? '', checker: result.checker ?? null };
}

/** Safe verdicts are one class whatever the backend calls the cost; a vulnerable verdict is classed by its complexity without the "(fuzz)" tag. */
function verdictClass(verdict) {
    return verdict.status === 'vulnerable' ? verdict.detail.replace(/ \(fuzz\)$/, '') : verdict.status;
}

async function analyse(source, flags, gate) {
    const analysisFlags = flags.replace(/[gdy]/g, '');
    return {
        gate,
        fuzz: summarise(await check(source, analysisFlags, { checker: 'fuzz', timeout: OPTIONS.timeout })),
        automaton: summarise(await check(source, analysisFlags, { checker: 'automaton', timeout: OPTIONS.timeout })),
    };
}

const classified = [];
for (const [key, lines] of unique) {
    const [file, source, flags] = key.split('\u0000');
    const gate = summarise(await check(source, flags.replace(/[gdy]/g, ''), { timeout: OPTIONS.timeout }));
    classified.push({ file, source, flags, lines, gate });
}

const allowlisted = classified.filter((c) => c.gate.status !== 'safe' && allowlist.some((a) => a.file === c.file && a.pattern === c.source));
const safeOnes = classified.filter((c) => c.gate.status === 'safe');
const sampledSafe = safeOnes.filter((_, index) => index % SAMPLE_EVERY === 0).slice(0, SAMPLE_LIMIT);

const rows = [];
for (const [group, members] of [['allowlisted', allowlisted], ['safe', sampledSafe]]) {
    for (const member of members) {
        const verdicts = await analyse(member.source, member.flags, member.gate);
        const statuses = new Set(BACKENDS.map((name) => verdicts[name].status));
        const classes = new Set(BACKENDS.map((name) => verdictClass(verdicts[name])));
        rows.push({
            group,
            file: member.file,
            lines: member.lines,
            pattern: member.source,
            flags: member.flags,
            ...verdicts,
            statusAgree: statuses.size === 1,
            contradiction: statuses.has('safe') && statuses.has('vulnerable'),
            classAgree: classes.size === 1,
        });
    }
}

const disagreeing = rows.filter((row) => !row.statusAgree);
const tally = Object.fromEntries(BACKENDS.map((name) => [name, rows.reduce((acc, row) => ({ ...acc, [row[name].status]: (acc[row[name].status] ?? 0) + 1 }), {})]));
const data = {
    recheckVersion,
    timeoutMs: OPTIONS.timeout,
    countsLine,
    distinct: unique.size,
    gateSafe: safeOnes.length,
    gateSafeProvedByAutomaton: safeOnes.filter((c) => c.gate.checker === 'automaton').length,
    gateSafeByFuzzOnly: safeOnes.filter((c) => c.gate.checker === 'fuzz').length,
    gateFlagged: classified.length - safeOnes.length,
    sample: { allowlisted: allowlisted.length, safe: sampledSafe.length, everyNth: SAMPLE_EVERY, safeTotal: safeOnes.length },
    tally,
    disagree: disagreeing.map((row) => ({
        file: row.file,
        pattern: row.pattern,
        gate: row.gate.status,
        fuzz: row.fuzz.status,
        automaton: row.automaton.status,
        contradiction: row.contradiction,
    })),
    rows,
};

if (OPTIONS.json) {
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
}

const cell = (verdict) => `${verdict.status}${verdict.detail ? ` (${verdict.detail})` : ''}${verdict.checker ? ` [${verdict.checker}]` : ''}`;
const code = (text) => `\`${text.replace(/\|/g, '\\|')}\``;

console.log(`# ReDoS second opinion (recheck ${recheckVersion}, ${OPTIONS.timeout} ms per check)\n`);
console.log(`${countsLine}; the gate calls ${safeOnes.length} safe and ${classified.length - safeOnes.length} flagged.`);
console.log(`Of the ${safeOnes.length} safe verdicts, ${data.gateSafeProvedByAutomaton} come from the automaton checker (a proof) and ${data.gateSafeByFuzzOnly} from the fuzzer (no attack found).`);
console.log(`Sample: ${allowlisted.length} allowlisted + ${sampledSafe.length} safe (every ${SAMPLE_EVERY}th of ${safeOnes.length} safe patterns, file order).\n`);
console.log('| group | file:line | pattern | gate (auto) | fuzz | automaton | agree |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
    const agree = row.contradiction ? 'CONTRADICTION' : row.statusAgree ? (row.classAgree ? 'yes' : 'same status, different degree') : 'inconclusive';
    console.log(`| ${row.group} | ${row.file}:${row.lines.join(',')} | ${code(row.pattern)} | ${cell(row.gate)} | ${cell(row.fuzz)} | ${cell(row.automaton)} | ${agree} |`);
}
console.log('\n## Verdict tally per backend\n');
for (const name of BACKENDS) console.log(`- ${name}: ${Object.entries(tally[name]).map(([status, n]) => `${status} ${n}`).join(', ')}`);
console.log('\n## Patterns on which the backends disagree\n');
if (disagreeing.length === 0) console.log('None: all three backends return the same status for every pattern in the sample.');
for (const row of disagreeing) {
    console.log(`- ${row.contradiction ? 'CONTRADICTION' : 'inconclusive'}: ${row.file} ${code(row.pattern)}  gate ${row.gate.status}, fuzz ${row.fuzz.status}, automaton ${row.automaton.status}`);
}
process.exit(0);
