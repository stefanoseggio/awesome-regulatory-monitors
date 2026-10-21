/**
 * Static ReDoS gate. Extracts every regular expression literal and every constant `RegExp("...")` from the
 * non-test TypeScript sources with the TypeScript AST and analyses each with `recheck`.
 *
 *   npm install --no-save recheck && npm run audit:redos
 *
 * Exit codes: 0 = clean, 1 = a flagged pattern is not allowlisted / an allowlist entry is stale or unenforced,
 * 2 = `recheck` is not installed, 64 = the command line is invalid (unknown flag, missing directory or file, allowlist
 * that is not a JSON array). Exit 64 is only ever reached by an explicit flag or by a broken tree, never by `npm run audit:redos`.
 *
 * Optional flags (the defaults scan this package, which is what `npm run audit:redos` does):
 *   --root=<dir>        directory scanned for .ts sources (default: the package root)
 *   --allowlist=<file>  allowlist JSON (default: scripts/redos_allowlist.json)
 *   --tests=<dir>       directory whose top-level *.test.ts files must contain each `enforcedBy` title (default: test/)
 *   test/audit.redos_gate.test.ts runs this script against temporary trees with these flags.
 *
 * A pattern may only stay flagged if scripts/redos_allowlist.json names the file, explains the bound that keeps
 * its input small (`bound`, at least 20 characters), and names a test (`enforcedBy`) whose TITLE (an it(), test() or
 * describe() title string, read from the AST, not a comment or any other text) exists in the top-level test files of
 * --tests. An empty, missing or too-short field makes the entry malformed and fails the gate.
 * A `RegExp(...)` built from non-constant input, an alias or property access of `RegExp` (`globalThis.RegExp`,
 * `const R = RegExp`), is listed so a reviewer reads it; none of the current ones takes external input. A string
 * literal passed to `.match()`, `.matchAll()` or `.search()` is a regular expression too and is analysed like a literal.
 *
 * An allowlist entry is STALE (exit 1) when its pattern no longer exists in its file, or when recheck's deterministic
 * automaton checker now PROVES it safe. A pattern that still exists and that only recheck's fuzzer rates safe is
 * reported as a note, not a failure: the fuzzer is time-budgeted, so its verdict on a borderline pattern can vary from
 * run to run and must not make the gate flaky.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(PACKAGE_ROOT, 'package.json'));
const ts = require('typescript');

const USAGE = 'usage: node scripts/redos_audit.mjs [--root=<dir>] [--allowlist=<file>] [--tests=<dir>]';

function usageError(message) {
    console.error(`${message}\n${USAGE}`);
    process.exit(64);
}

function kindOf(path) {
    try {
        const stats = statSync(path);
        return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    } catch {
        return 'missing';
    }
}

function parseArguments(argv) {
    const options = {
        root: PACKAGE_ROOT,
        allowlist: join(PACKAGE_ROOT, 'scripts', 'redos_allowlist.json'),
        tests: join(PACKAGE_ROOT, 'test'),
    };
    for (const arg of argv) {
        const match = /^--(root|allowlist|tests)=(.+)$/.exec(arg);
        if (!match) usageError(`unknown argument "${arg}"`);
        options[match[1]] = resolve(match[2]);
    }
    if (kindOf(options.root) !== 'directory') usageError(`--root is not a directory: ${options.root}`);
    if (kindOf(options.tests) !== 'directory') usageError(`--tests is not a directory: ${options.tests}`);
    if (kindOf(options.allowlist) !== 'file') usageError(`--allowlist is not a file: ${options.allowlist}`);
    return options;
}

const OPTIONS = parseArguments(process.argv.slice(2));
const ROOT = OPTIONS.root;

let check;
try {
    ({ check } = await import('recheck'));
} catch {
    console.error('recheck is not installed. Run: npm install --no-save recheck');
    process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'stage', 'storage', 'fixtures', 'docs-research', '.actor', 'test']);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
}

const TEST_CALLEE = /^(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^()]*\))?)*$/u;

function titleText(node) {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\u0000${span.literal.text}`).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = titleText(node.left);
        const right = titleText(node.right);
        return left !== undefined && right !== undefined ? left + right : undefined;
    }
    return undefined;
}

/** Every it()/test()/describe() title (including it.each(table)(title, ...)) of the top-level *.test.ts files, with its describe path. */
function allTestTitles() {
    const titles = [];
    const dir = OPTIONS.tests;
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.test.ts')) continue;
        const sf = ts.createSourceFile(name, readFileSync(join(dir, name), 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node, path) => {
            let next = path;
            if (ts.isCallExpression(node)) {
                const callee = ts.isCallExpression(node.expression) ? node.expression.expression.getText() : node.expression.getText();
                const eachForm = ts.isCallExpression(node.expression) && /\.each$/u.test(callee);
                if (TEST_CALLEE.test(callee) || eachForm) {
                    const title = titleText(node.arguments[0]);
                    if (title !== undefined) {
                        titles.push(title, [...path, title].join(' > '));
                        if (callee.startsWith('describe')) next = [...path, title];
                    }
                }
            }
            ts.forEachChild(node, (child) => visit(child, next));
        };
        visit(sf, []);
    }
    return titles;
}

/** `RegExp` used as the callee of new/call (handled above), as a type name, or as a property name, is not an alias. */
function isDirectRegExpUse(identifier) {
    const parent = identifier.parent;
    if ((ts.isNewExpression(parent) || ts.isCallExpression(parent)) && parent.expression === identifier) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
    if (ts.isTypeReferenceNode(parent) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
    // `value instanceof RegExp` tests a type; it constructs nothing.
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === identifier) return true;
    // `RegExp.prototype.exec` and similar members of the global constructor are not constructions either.
    if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) return true;
    return false;
}

const found = [];
const dynamic = [];
for (const file of walk(ROOT)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
            const text = node.getText();
            const last = text.lastIndexOf('/');
            found.push({ file: relative(ROOT, file), line, source: text.slice(1, last), flags: text.slice(last + 1) });
        } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && /^(?:[A-Za-z_$][\w$]*\.)*RegExp$/u.test(node.expression.getText())) {
            const arg = node.arguments?.[0];
            const flagsArg = node.arguments?.[1];
            if (node.expression.getText() === 'RegExp' && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
                found.push({ file: relative(ROOT, file), line, source: arg.text, flags: flagsArg && ts.isStringLiteral(flagsArg) ? flagsArg.text : '' });
            } else {
                // `new globalThis.RegExp(x)` and every non-constant argument: listed for a reviewer, never analysed.
                dynamic.push({ file: relative(ROOT, file), line, text: node.getText().slice(0, 120) });
            }
        } else if (ts.isIdentifier(node) && node.text === 'RegExp' && !isDirectRegExpUse(node)) {
            dynamic.push({ file: relative(ROOT, file), line, text: `indirect reference: ${node.parent.getText().slice(0, 100)}` });
        } else if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ['match', 'matchAll', 'search'].includes(node.expression.name.text) &&
            node.arguments.length > 0 &&
            (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
        ) {
            // A string given to match/matchAll/search is converted to a regular expression by the engine.
            found.push({ file: relative(ROOT, file), line, source: node.arguments[0].text, flags: node.expression.name.text === 'matchAll' ? 'g' : '' });
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

let allowlist;
try {
    allowlist = JSON.parse(readFileSync(OPTIONS.allowlist, 'utf8'));
} catch (error) {
    usageError(`--allowlist is not valid JSON: ${error.message}`);
}
if (!Array.isArray(allowlist)) usageError('--allowlist must contain a JSON array of { file, pattern, bound, enforcedBy } entries');
const testTitles = allTestTitles();
const MIN_BOUND_LENGTH = 20;
let malformed = false;
for (const [index, entry] of allowlist.entries()) {
    const problems = [];
    for (const field of ['file', 'pattern', 'bound', 'enforcedBy']) {
        if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') problems.push(`"${field}" is missing or empty`);
    }
    if (typeof entry?.bound === 'string' && entry.bound.trim().length > 0 && entry.bound.trim().length < MIN_BOUND_LENGTH) problems.push(`"bound" is shorter than ${MIN_BOUND_LENGTH} characters`);
    if (problems.length > 0) {
        malformed = true;
        console.error(`\nMALFORMED ALLOWLIST ENTRY #${index}: ${problems.join('; ')}\n  ${JSON.stringify(entry)?.slice(0, 160)}`);
    }
}
const flagged = [];
const verdicts = new Map();
let safe = 0;
for (const [key, lines] of unique) {
    const [file, source, flags] = key.split('\u0000');
    const result = await check(source, flags.replace(/[gdy]/g, ''), { timeout: 20000 });
    verdicts.set(key, { status: result.status, checker: result.checker });
    if (result.status === 'safe') safe += 1;
    else flagged.push({ file, source, lines, status: result.status, complexity: result.complexity?.summary ?? result.complexity?.type ?? '' });
}

console.log(`${found.length} regex occurrences, ${unique.size} distinct (file, pattern) pairs, ${dynamic.length} dynamic RegExp() calls`);
console.log(`safe: ${safe}   flagged: ${flagged.length}`);

let failed = false;
const matched = new Set();
for (const f of flagged) {
    const entry = allowlist.find((a) => a.file === f.file && a.pattern === f.source);
    if (!entry) {
        failed = true;
        console.error(`\nNOT ALLOWLISTED  ${f.status} ${f.complexity}\n  ${f.file}:${f.lines.join(',')}\n  /${f.source}/`);
        continue;
    }
    matched.add(entry);
    if (typeof entry.enforcedBy !== 'string' || entry.enforcedBy.trim() === '' || !testTitles.some((title) => title.includes(entry.enforcedBy))) {
        failed = true;
        console.error(`\nUNENFORCED  no test title contains "${entry.enforcedBy}"\n  ${f.file}  /${f.source}/`);
    } else {
        console.log(`allowlisted  ${f.complexity}  ${f.file}  (bound: ${entry.bound.slice(0, 80)}...)`);
    }
}
for (const entry of allowlist) {
    if (matched.has(entry)) continue;
    const presentKeys = [...unique.keys()].filter((key) => key.split('\u0000')[0] === entry.file && key.split('\u0000')[1] === entry.pattern);
    if (presentKeys.length > 0 && !presentKeys.some((key) => verdicts.get(key)?.checker === 'automaton')) {
        // recheck's fuzzer is time-budgeted: a borderline pattern can be rated safe on one run and polynomial on the next.
        console.log(`note  allowlist entry for a pattern that the fuzzer (not a proof) rates safe on this run; kept\n  ${entry.file}  /${entry.pattern}/`);
    } else if (presentKeys.length > 0) {
        failed = true;
        console.error(`\nSTALE ALLOWLIST ENTRY (the automaton checker now proves the pattern safe: remove the entry)\n  ${entry.file}  /${entry.pattern}/`);
    } else {
        failed = true;
        console.error(`\nSTALE ALLOWLIST ENTRY (pattern no longer present in the file)\n  ${entry.file}  /${entry.pattern}/`);
    }
}
if (malformed) failed = true;
console.log('\nDynamic RegExp() calls (read by hand: none takes external input):');
for (const d of dynamic) console.log(`  ${d.file}:${d.line}  ${d.text}`);
process.exit(failed ? 1 : 0);
