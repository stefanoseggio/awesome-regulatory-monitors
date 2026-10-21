/**
 * Static ReDoS gate. Extracts every regular expression literal and every constant `RegExp("...")` from the
 * non-test TypeScript sources with the TypeScript AST and analyses each with `recheck`.
 *
 *   npm install --no-save recheck && npm run audit:redos
 *
 * Exit codes: 0 = clean, 1 = a flagged pattern is not allowlisted / an allowlist entry is stale or unenforced,
 * 2 = `recheck` is not installed.
 *
 * A pattern may only stay flagged if scripts/redos_allowlist.json names the file, explains the bound that keeps
 * its input small, and names a test (`enforcedBy`) whose title exists under test/. A `RegExp(...)` built from
 * non-constant input is listed so a reviewer reads it; none of the current ones takes external input.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const ts = require('typescript');

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

function allTestTitles() {
    const titles = [];
    const dir = join(ROOT, 'test');
    for (const name of readdirSync(dir)) if (name.endsWith('.test.ts')) titles.push(readFileSync(join(dir, name), 'utf8'));
    return titles.join('\n');
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
        } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText() === 'RegExp') {
            const arg = node.arguments?.[0];
            const flagsArg = node.arguments?.[1];
            if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
                found.push({ file: relative(ROOT, file), line, source: arg.text, flags: flagsArg && ts.isStringLiteral(flagsArg) ? flagsArg.text : '' });
            } else {
                dynamic.push({ file: relative(ROOT, file), line, text: node.getText().slice(0, 120) });
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

const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts', 'redos_allowlist.json'), 'utf8'));
const testSource = allTestTitles();
const flagged = [];
let safe = 0;
for (const [key, lines] of unique) {
    const [file, source, flags] = key.split('\u0000');
    const result = await check(source, flags.replace(/[gdy]/g, ''), { timeout: 20000 });
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
    if (!testSource.includes(entry.enforcedBy)) {
        failed = true;
        console.error(`\nUNENFORCED  no test title contains "${entry.enforcedBy}"\n  ${f.file}  /${f.source}/`);
    } else {
        console.log(`allowlisted  ${f.complexity}  ${f.file}  (bound: ${entry.bound.slice(0, 80)}...)`);
    }
}
for (const entry of allowlist) {
    if (!matched.has(entry)) {
        failed = true;
        console.error(`\nSTALE ALLOWLIST ENTRY (pattern no longer flagged or no longer present)\n  ${entry.file}  /${entry.pattern}/`);
    }
}
console.log('\nDynamic RegExp() calls (read by hand: none takes external input):');
for (const d of dynamic) console.log(`  ${d.file}:${d.line}  ${d.text}`);
process.exit(failed ? 1 : 0);
