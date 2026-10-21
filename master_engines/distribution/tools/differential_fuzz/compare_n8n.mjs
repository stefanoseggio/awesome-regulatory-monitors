// Compares the guard section of the Code node of every n8n template with the TypeScript guard's expected outputs.
// Usage (any Node >= 20): node compare_n8n.mjs SPEC.json EXPECTED.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const [specPath, expectedPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'n8n');
const files = ['global-regtech-compliance-feed', 'latam-global-tender-intelligence', 'global-corporate-patent-intelligence'];
let totalBad = 0;
for (const file of files) {
    const workflow = JSON.parse(readFileSync(path.join(dir, `${file}.workflow.json`), 'utf8'));
    const code = workflow.nodes.find((node) => node.name === 'Build run input').parameters.jsCode;
    const section = code.slice(code.indexOf('// --- watchlist guard'), code.indexOf('// --- end watchlist guard ---'));
    const context = vm.createContext({});
    vm.runInContext(`${section}\nglobalThis.__sanitize = sanitizeKeywordList; globalThis.__normalise = normaliseKeyword;`, context);
    let bad = 0;
    const note = (kind, index, given, got, want) => {
        bad += 1;
        if (bad <= 5) console.log(`${kind} MISMATCH ${file} #${index}`, JSON.stringify(given).slice(0, 200), JSON.stringify(got).slice(0, 300), JSON.stringify(want).slice(0, 300));
    };
    spec.sanitize.forEach((input, index) => {
        const got = context.__sanitize(input);
        const want = expected.sanitize[index];
        const wantRejected = {};
        for (const item of want.rejected) wantRejected[item.reason] = (wantRejected[item.reason] ?? 0) + 1;
        const same =
            JSON.stringify(got.keywords) === JSON.stringify(want.keywords) &&
            JSON.stringify(Object.entries(got.rejected).sort()) === JSON.stringify(Object.entries(wantRejected).sort()) &&
            got.malformedContainer === want.malformedContainer;
        if (!same) note('SANITIZE', index, input, got, want);
    });
    spec.normalise.forEach((raw, index) => {
        const got = context.__normalise(raw);
        if (got !== expected.normalise[index].reject) note('NORMALISE', index, raw, got, expected.normalise[index].reject);
    });
    console.log(file, 'sanitize', spec.sanitize.length, 'normalise', spec.normalise.length, 'mismatches', bad, 'node', process.version, 'unicode', process.versions.unicode);
    totalBad += bad;
}
process.exit(totalBad ? 1 : 0);
