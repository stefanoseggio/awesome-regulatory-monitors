/**
 * Stages one engine into a self-contained directory ready for `apify push` (the build context must contain
 * lib/, pricing/ and the engine, which live side by side in master_engines/) and carrying the Store README as README.md.
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
for (const file of ['package.json', 'package-lock.json']) {
    try {
        await cp(join(root, file), join(out, file));
    } catch {
        console.error(`Missing ${file}. The image installs with \`npm ci\`, which needs the committed lockfile: run \`npm install\` in master_engines/ first.`);
        process.exit(1);
    }
}

// The Apify build copies .actor/ from the context root.
await cp(join(root, slug, '.actor'), join(out, '.actor'), { recursive: true });
await cp(join(out, '.actor', 'Dockerfile'), join(out, 'Dockerfile'));

// The Store page shows the README of the pushed build. Without this copy the Actor is published with an empty README page
// (finding F-20): the file is store_listings/<slug>.README.md, checked by test/store_readme.test.ts.
try {
    await cp(join(root, 'store_listings', `${slug}.README.md`), join(out, 'README.md'));
} catch {
    console.error(`Missing store_listings/${slug}.README.md: an Actor must not be pushed without its Store README.`);
    process.exit(1);
}

const tsconfig = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')) as { include: string[] };
tsconfig.include = ['lib/**/*.ts', 'pricing/**/*.ts', `${slug}/**/*.ts`];
await writeFile(join(out, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 4)}\n`);
await writeFile(join(out, '.dockerignore'), ['node_modules', 'dist', '.git', 'storage', 'apify_storage', ''].join('\n'));

console.log(`Staged ${slug} at ${out}\nNext: cd ${out} && npm install && npm run build && apify push`);
