/**
 * Stages one engine into a self-contained directory ready for `apify push` (the build context must contain
 * lib/, pricing/ and the engine, which live side by side in master_engines/).
 *
 *   npx tsx scripts/stage_actor.ts <engine-slug> [--out=<dir>]      (default out: stage/<engine-slug>)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const SLUGS = ['global-regtech-compliance-feed', 'latam-global-tender-intelligence', 'global-corporate-patent-intelligence'];
if (!slug || !SLUGS.includes(slug)) {
    console.error(`Usage: stage_actor.ts <${SLUGS.join('|')}> [--out=<dir>]`);
    process.exit(2);
}
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const out = resolve(outArg ?? join(root, 'stage', slug));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const dir of ['lib', 'pricing', slug]) await cp(join(root, dir), join(out, dir), { recursive: true });
// Pricing payloads and tests are not part of the runtime image.
await rm(join(out, 'pricing', 'payloads'), { recursive: true, force: true });
for (const file of ['package.json', 'package-lock.json']) await cp(join(root, file), join(out, file));

// The Apify build copies .actor/ from the context root.
await cp(join(root, slug, '.actor'), join(out, '.actor'), { recursive: true });
await cp(join(out, '.actor', 'Dockerfile'), join(out, 'Dockerfile'));

const tsconfig = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')) as { include: string[] };
tsconfig.include = ['lib/**/*.ts', 'pricing/**/*.ts', `${slug}/**/*.ts`];
await writeFile(join(out, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 4)}\n`);
await writeFile(join(out, '.dockerignore'), ['node_modules', 'dist', '.git', 'storage', 'apify_storage', ''].join('\n'));

console.log(`Staged ${slug} at ${out}\nNext: cd ${out} && npm install && npm run build && apify push`);
