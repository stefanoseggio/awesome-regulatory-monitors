/**
 * Evaluates the TypeScript guard on a generated spec (see generate_spec.py) and writes the expected outputs.
 * Usage (from master_engines/): npx tsx distribution/tools/differential_fuzz/evaluate_ts.ts SPEC.json EXPECTED.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { describeSanitization, findKeywordMatch, normaliseKeyword, sanitizeKeywordList, type SanitizedKeywordList } from '../../../lib/_guards.js';

const [specPath, outPath] = process.argv.slice(2) as [string, string];
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
    sanitize: unknown[];
    normalise: string[];
    match: Array<{ keywords: string[]; haystack: unknown; forged: string[] | null }>;
};

const sanitize = spec.sanitize.map((input) => {
    const list = sanitizeKeywordList(input);
    return { ...list, description: describeSanitization(list) };
});
const normalise = spec.normalise.map((raw) => ({ reject: normaliseKeyword(raw), cut: normaliseKeyword(raw, 'cut') }));
const match = spec.match.map((item) => {
    const list = sanitizeKeywordList(item.keywords);
    const forged: SanitizedKeywordList | null = item.forged ? { keywords: item.forged, needles: item.forged, rejected: [], malformedContainer: false } : null;
    return { list, hit: findKeywordMatch(item.haystack, list), forgedHit: forged ? findKeywordMatch(item.haystack, forged) : null };
});

writeFileSync(outPath, JSON.stringify({ sanitize, normalise, match }));
console.log('ts evaluated', spec.sanitize.length, spec.normalise.length, spec.match.length, 'node', process.version, 'unicode', (process.versions as Record<string, string>).unicode);
