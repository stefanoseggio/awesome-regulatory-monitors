/**
 * deployment_runbook.test.ts - the deployment runbook (docs/deployment/production_deployment_runbook.md) is executed, not trusted.
 *
 * The fenced blocks marked `deploy:<name>` are extracted from the document and run by bash against a local HTTP server that plays the
 * parts of the Apify API they call (users/me, Actor get and put, run start, run status, dataset items). What this proves, and what it
 * does not:
 *   - the commands are syntactically and logically what the document says, with the real payload generator behind them;
 *   - the pricing request is a PUT to /v2/actors/<owner>~<slug> with a bearer token, a JSON content type and the generated file as the
 *     body, byte for byte, and nothing is sent before the preflight has read every Actor;
 *   - the guards refuse a stale body, a wrong notice period, a changed price and an Actor that already has pricing history, and the
 *     confirmation is required;
 *   - the numbers the document states (events, prices, memory, credentials, sources) equal the committed artefacts.
 * It does not prove that api.apify.com accepts the body: that was checked against Apify's published OpenAPI schema, outside this test
 * (docs/deployment/production_deployment_runbook.md, section 8), and has never been tried with an account token.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPricingPutBody } from '../pricing/build_put_payloads.js';
import { ALL_PRICING } from '../pricing/event_catalog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // master_engines/
const REPO = join(ROOT, '..');
const RUNBOOK = join(REPO, 'docs', 'deployment', 'production_deployment_runbook.md');
const PAYLOAD_DIR = join(ROOT, 'stage', 'payloads');
const TOKEN = 'test-token-0123456789';
const OWNER = 'rehearsal';
const SLUGS = ALL_PRICING.map((pricing) => pricing.engine);
const DAY_S = 86_400;

// ---------------------------------------------------------------------------------------------------------------------------------
// The runbook's blocks
// ---------------------------------------------------------------------------------------------------------------------------------

const markdown = readFileSync(RUNBOOK, 'utf8');
const BLOCK = /^```bash (deploy|deploy-manual):([a-z0-9-]+)\n([\s\S]*?)^```$/gmu;
const executable = new Map<string, string>();
const manual = new Map<string, string>();
for (const match of markdown.matchAll(BLOCK)) (match[1] === 'deploy' ? executable : manual).set(match[2] as string, match[3] as string);

// ---------------------------------------------------------------------------------------------------------------------------------
// A local stand-in for the part of the Apify API the blocks call
// ---------------------------------------------------------------------------------------------------------------------------------

interface Recorded {
    method: string;
    path: string;
    query: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

class FakeApify {
    readonly requests: Recorded[] = [];
    /** Actor name -> pricing records it already has. Absent name: 404. */
    readonly actors = new Map<string, unknown[]>(SLUGS.map((slug) => [slug, []]));
    /** Slugs whose PUT answers 500. */
    failPut = new Set<string>();
    private server: Server | undefined;
    url = '';

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const [path = '', query = ''] = (req.url ?? '').split('?');
                const body = Buffer.concat(chunks);
                this.requests.push({ method: req.method ?? '', path, query, headers: req.headers, body });
                const send = (status: number, payload: unknown): void => {
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(payload));
                };
                if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { type: 'token-not-provided', message: 'bad token' } });
                const actorMatch = /^\/v2\/actors\/([^/~]+)~([a-z0-9-]+)$/u.exec(path);
                if (req.method === 'GET' && path === '/v2/users/me') return send(200, { data: { username: OWNER } });
                if (actorMatch) {
                    const [, owner, slug] = actorMatch as unknown as [string, string, string];
                    const pricing = this.actors.get(slug);
                    if (owner !== OWNER || pricing === undefined) return send(404, { error: { type: 'record-not-found', message: 'Actor not found' } });
                    const actor = (): unknown => ({ data: { id: `id-${slug}`, name: slug, username: OWNER, isPublic: false, stats: { totalUsers: 0 }, pricingInfos: pricing } });
                    if (req.method === 'GET') return send(200, actor());
                    if (req.method === 'PUT') {
                        if (this.failPut.has(slug)) return send(500, { error: { type: 'internal-error', message: 'boom' } });
                        if (!/^application\/json/u.test(String(req.headers['content-type'] ?? ''))) return send(400, { error: { type: 'invalid-content-type', message: 'JSON required' } });
                        const parsed = JSON.parse(body.toString('utf8')) as { pricingInfos?: unknown[] };
                        this.actors.set(slug, parsed.pricingInfos ?? []);
                        return send(200, { data: { id: `id-${slug}`, name: slug, username: OWNER, isPublic: false, stats: { totalUsers: 0 }, pricingInfos: parsed.pricingInfos ?? [] } });
                    }
                }
                const runStart = /^\/v2\/actors\/([^/~]+)~([a-z0-9-]+)\/runs$/u.exec(path);
                if (req.method === 'POST' && runStart) return send(201, { data: { id: `run-${runStart[2]}`, status: 'RUNNING', defaultDatasetId: `ds-${runStart[2]}` } });
                const runGet = /^\/v2\/actor-runs\/run-([a-z0-9-]+)$/u.exec(path);
                if (req.method === 'GET' && runGet) return send(200, { data: { id: `run-${runGet[1]}`, status: 'SUCCEEDED', defaultDatasetId: `ds-${runGet[1]}` } });
                if (req.method === 'GET' && /^\/v2\/datasets\/ds-[a-z0-9-]+\/items$/u.test(path)) return send(200, [{ record_id: 'a' }, { record_id: 'b' }, { record_id: 'c' }]);
                return send(404, { error: { type: 'mock-not-implemented', message: `${req.method} ${path}` } });
            });
        });
        await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    }

    puts(): Recorded[] {
        return this.requests.filter((r) => r.method === 'PUT');
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Running blocks
// ---------------------------------------------------------------------------------------------------------------------------------

interface Outcome {
    code: number;
    stdout: string;
    stderr: string;
}

/** No proxy variables: curl would send a request for 127.0.0.1 to the sandbox proxy. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', ...extra };
}

function bash(script: string, env: NodeJS.ProcessEnv, cwd: string = REPO): Promise<Outcome> {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-c', script], { cwd, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

function block(name: string): string {
    const code = executable.get(name);
    if (code === undefined) throw new Error(`the runbook has no deploy:${name} block`);
    return code;
}

const created: string[] = [];
const known = (): Set<string> => new Set(existsSync(PAYLOAD_DIR) ? readdirSync(PAYLOAD_DIR) : []);
let before = new Set<string>();

/** The directory the `payloads` block reported writing to (it prints `payloads written to <dir>`). */
function payloadDirOf(result: Outcome): string {
    const match = /payloads written to (\S+)/u.exec(result.stdout);
    if (!match) throw new Error(`the payloads block did not report its directory:\n${result.stdout}\n${result.stderr}`);
    const name = (match[1] as string).replace(/^stage\/payloads\//u, '');
    if (!created.includes(name)) created.push(name);
    return join(PAYLOAD_DIR, name);
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function generate(outDir: string, args: string[]): void {
    const result = spawnSync('npx', ['tsx', 'scripts/generate_pricing_payloads.ts', ...args, `--out=${outDir}`], { cwd: ROOT, env: cleanEnv({}), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`generator failed: ${result.stderr}`);
}

let api: FakeApify;
beforeAll(async () => {
    for (const tool of ['curl', 'jq', 'bash']) {
        const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' });
        if (probe.status !== 0) throw new Error(`the runbook rehearsal needs ${tool} on the PATH`);
    }
    mkdirSync(PAYLOAD_DIR, { recursive: true });
    before = known();
});
afterAll(() => {
    for (const name of [...known()].filter((n) => !before.has(n))) rmSync(join(PAYLOAD_DIR, name), { recursive: true, force: true });
});

async function freshApi(): Promise<FakeApify> {
    api = new FakeApify();
    await api.start();
    return api;
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => cleanEnv({ APIFY_TOKEN: TOKEN, APIFY_API_BASE: api.url, ...extra });

// ---------------------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------------------

describe('the runbook is made of blocks the test can run', () => {
    it('has the executable and the manual blocks it documents, each non-empty', () => {
        expect([...executable.keys()].sort()).toEqual(['env', 'identify', 'payload-guard', 'payloads', 'preflight', 'put', 'smoke', 'verify']);
        expect([...manual.keys()].sort()).toEqual(['abort', 'builds', 'docker', 'held-check', 'push', 'stage']);
        for (const code of [...executable.values(), ...manual.values()]) expect(code.trim().length).toBeGreaterThan(20);
    });

    it('never puts the token on a command line: the requests carry it through a header file read from a pipe', () => {
        const text = [...executable.values(), ...manual.values()].join('\n');
        expect(text).toContain('-H @<(printf');
        expect(text).not.toMatch(/-H\s+["']Authorization/u);
        expect(text).not.toMatch(/--header\s+["']Authorization/u);
        expect(text).not.toMatch(/apify login[^\n]*\bapify_api_/u);
    });

    it('names every flag of the Apify CLI it uses with the spelling the CLI documents (apify-cli 1.10.0: login --token, push --wait-for-finish, validate-schema)', () => {
        const text = [...manual.values()].join('\n');
        expect(text).toContain('apify login --token "$APIFY_TOKEN"');
        expect(text).toContain('apify push --wait-for-finish 900');
        expect(text).toContain('apify validate-schema');
        expect(text).toContain('apify info');
    });
});

describe('the pricing steps, rehearsed against a local stand-in for the Apify API', () => {
    it('variant A (14-day notice): payloads, guard, preflight, PUT and read-back succeed, and the three PUTs are exactly what section 6 says', async () => {
        const server = await freshApi();
        try {
            const script = ['env', 'identify', 'payloads', 'payload-guard', 'preflight', 'put', 'verify'].map(block).join('\n');
            const result = await bash(script, env({ CONFIRM_PRICING: 'send-pricing-to-production' }));
            expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
            expect(result.stdout).toContain('owner: rehearsal');
            expect(result.stdout).toContain('pass the deployment checks');
            expect(result.stdout.match(/pricing read back matches/gu)).toHaveLength(3);

            const outDir = payloadDirOf(result);
            const puts = server.puts();
            expect(puts.map((r) => r.path)).toEqual(SLUGS.map((slug) => `/v2/actors/${OWNER}~${slug}`));
            // nothing is sent before every Actor has been read by the preflight, and the first request asks who the owner is
            const firstPut = server.requests.findIndex((r) => r.method === 'PUT');
            expect(server.requests[0]?.path).toBe('/v2/users/me');
            expect(server.requests.slice(0, firstPut).filter((r) => r.method === 'GET' && r.path.includes('~')).map((r) => r.path)).toEqual(SLUGS.map((slug) => `/v2/actors/${OWNER}~${slug}`));
            for (const request of server.requests) expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);

            for (const [index, slug] of SLUGS.entries()) {
                const put = puts[index] as Recorded;
                expect(put.headers['content-type']).toBe('application/json');
                // the body is the generated file, byte for byte
                expect(put.body.equals(readFileSync(join(outDir, `${slug}.put.json`)))).toBe(true);
                const sent = JSON.parse(put.body.toString('utf8')) as ReturnType<typeof buildPricingPutBody>['body'];
                const info = sent.pricingInfos[0]!;
                // an independent expectation: the builder, called with the instant the file itself carries
                const pricing = ALL_PRICING.find((p) => p.engine === slug)!;
                expect(sent).toEqual(buildPricingPutBody(pricing, { now: info.createdAt, hasPayingUsers: true }).body);
                expect(sent.pricingInfos).toHaveLength(1);
                expect(info.pricingModel).toBe('PAY_PER_EVENT');
                expect(Date.parse(info.startedAt) - Date.parse(info.createdAt)).toBe(14 * DAY_S * 1000);
                expect(info.pricingPerEvent.actorChargeEvents['apify-actor-start']).toMatchObject({ eventPriceUsd: 0.005, isOneTimeEvent: true });
                expect(Object.keys(info.pricingPerEvent.actorChargeEvents)).not.toContain('apify-default-dataset-item');
                expect(Math.abs(Date.parse(info.createdAt) - Date.now())).toBeLessThan(5 * 60_000);
                // the notice file travels with it
                const notice = readJson<{ noticeDays: number; effectiveAt: string }>(join(outDir, `${slug}.notice.json`));
                expect(notice).toMatchObject({ noticeDays: 14, effectiveAt: info.startedAt });
            }
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('variant B (PAYING_USERS=false): the pricing is effective at once and the guard accepts it', async () => {
        const server = await freshApi();
        try {
            const script = ['env', 'identify', 'payloads', 'payload-guard', 'preflight', 'put', 'verify'].map(block).join('\n');
            const result = await bash(script, env({ CONFIRM_PRICING: 'send-pricing-to-production', PAYING_USERS: 'false' }));
            expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
            payloadDirOf(result);
            for (const put of server.puts()) {
                const info = (JSON.parse(put.body.toString('utf8')) as { pricingInfos: Array<{ startedAt: string; createdAt: string }> }).pricingInfos[0]!;
                expect(info.startedAt).toBe(info.createdAt);
            }
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the guard refuses a body that is hours old (the reference files carry the day they were generated)', async () => {
        const server = await freshApi();
        try {
            const outDir = join(PAYLOAD_DIR, 'rehearsal-stale');
            generate(outDir, [`--now=${iso(Date.now() - 2 * 3_600_000)}`]);
            created.push('rehearsal-stale');
            const result = await bash([block('env'), `OUT="stage/payloads/rehearsal-stale"`, block('payload-guard')].join('\n'), env());
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain('fails the deployment checks');
            expect(server.puts()).toHaveLength(0);
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the guard refuses the wrong notice period for the chosen variant, both ways', async () => {
        const server = await freshApi();
        try {
            const immediate = join(PAYLOAD_DIR, 'rehearsal-immediate');
            const delayed = join(PAYLOAD_DIR, 'rehearsal-delayed');
            generate(immediate, [`--now=${iso(Date.now())}`, '--paying-users=false']);
            generate(delayed, [`--now=${iso(Date.now())}`]);
            created.push('rehearsal-immediate', 'rehearsal-delayed');
            // an immediate body while the variant says 14 days
            const a = await bash([block('env'), 'OUT="stage/payloads/rehearsal-immediate"', block('payload-guard')].join('\n'), env());
            expect(a.code).not.toBe(0);
            // a 14-day body while the variant says "no paying users"
            const b = await bash([block('env'), 'OUT="stage/payloads/rehearsal-delayed"', block('payload-guard')].join('\n'), env({ PAYING_USERS: 'false' }));
            expect(b.code).not.toBe(0);
            // an unknown value is refused, not defaulted
            const c = await bash([block('env'), 'OUT="stage/payloads/rehearsal-delayed"', block('payload-guard')].join('\n'), env({ PAYING_USERS: 'maybe' }));
            expect(c.code).not.toBe(0);
            expect(c.stdout + c.stderr).toContain('PAYING_USERS must be true or false');
            // and each is accepted by its own variant
            const ok1 = await bash([block('env'), 'OUT="stage/payloads/rehearsal-delayed"', block('payload-guard')].join('\n'), env());
            expect(ok1.code, ok1.stderr).toBe(0);
            const ok2 = await bash([block('env'), 'OUT="stage/payloads/rehearsal-immediate"', block('payload-guard')].join('\n'), env({ PAYING_USERS: 'false' }));
            expect(ok2.code, ok2.stderr).toBe(0);
        } finally {
            await server.stop();
        }
    }, 180_000);

    it('the guard refuses a changed start price, a changed event price and a priced dataset-item event', async () => {
        const server = await freshApi();
        try {
            const tampered: Array<[string, (info: { pricingPerEvent: { actorChargeEvents: Record<string, Record<string, unknown>> } }) => void]> = [
                ['start', (info) => (info.pricingPerEvent.actorChargeEvents['apify-actor-start']!.eventPriceUsd = 0.05)],
                ['event', (info) => (info.pricingPerEvent.actorChargeEvents['watchlist-hit']!.eventPriceUsd = 0.5)],
                ['dataset', (info) => (info.pricingPerEvent.actorChargeEvents['apify-default-dataset-item'] = { eventTitle: 't', eventDescription: 'd', eventPriceUsd: 0.001 })],
                ['one-time', (info) => (info.pricingPerEvent.actorChargeEvents['apify-actor-start']!.isOneTimeEvent = false)],
            ];
            for (const [label, change] of tampered) {
                const outDir = join(PAYLOAD_DIR, `rehearsal-tamper-${label}`);
                generate(outDir, [`--now=${iso(Date.now())}`]);
                created.push(`rehearsal-tamper-${label}`);
                const file = join(outDir, `${SLUGS[0]}.put.json`);
                const body = readJson<{ pricingInfos: Array<{ pricingPerEvent: { actorChargeEvents: Record<string, Record<string, unknown>> } }> }>(file);
                change(body.pricingInfos[0]!);
                writeFileSync(file, `${JSON.stringify(body, null, 4)}\n`);
                const result = await bash([block('env'), `OUT="stage/payloads/rehearsal-tamper-${label}"`, block('payload-guard')].join('\n'), env());
                expect(result.code, label).not.toBe(0);
                expect(result.stdout + result.stderr, label).toContain(SLUGS[0]);
            }
        } finally {
            await server.stop();
        }
    }, 240_000);

    it('each explicit check fires on its own, even when the reviewed reference was changed together with the body (a catalog change that went through review)', async () => {
        const server = await freshApi();
        type Info = { pricingPerEvent: { actorChargeEvents: Record<string, Record<string, unknown>> } };
        const cases: Array<[string, (info: Info) => void]> = [
            ['start price', (info) => (info.pricingPerEvent.actorChargeEvents['apify-actor-start']!.eventPriceUsd = 0.05)],
            ['start event not one-time', (info) => (info.pricingPerEvent.actorChargeEvents['apify-actor-start']!.isOneTimeEvent = false)],
            ['dataset-item event priced', (info) => (info.pricingPerEvent.actorChargeEvents['apify-default-dataset-item'] = { eventTitle: 't', eventDescription: 'd', eventPriceUsd: 0.001 })],
            ['watchlist-hit price', (info) => (info.pricingPerEvent.actorChargeEvents['watchlist-hit']!.eventPriceUsd = 0.5)],
            ['two primary events', (info) => (info.pricingPerEvent.actorChargeEvents['watchlist-hit']!.isPrimaryEvent = true)],
            ['no primary event', (info) => Object.values(info.pricingPerEvent.actorChargeEvents).forEach((event) => delete event.isPrimaryEvent)],
        ];
        const tmpRoots: string[] = [];
        try {
            for (const [label, change] of [['control (nothing changed)', undefined] as const, ...cases]) {
                const tmp = mkdtempSync(join(tmpdir(), 'runbook-guard-'));
                tmpRoots.push(tmp);
                const reference = join(tmp, 'master_engines', 'pricing', 'payloads');
                const outDir = join(tmp, 'master_engines', 'stage', 'payloads', 'x');
                mkdirSync(reference, { recursive: true });
                generate(outDir, [`--now=${iso(Date.now())}`]);
                for (const slug of SLUGS) {
                    const file = join(outDir, `${slug}.put.json`);
                    if (change !== undefined && slug === SLUGS[0]) {
                        const body = readJson<{ pricingInfos: Info[] }>(file);
                        change(body.pricingInfos[0]!);
                        writeFileSync(file, `${JSON.stringify(body, null, 4)}\n`);
                    }
                    copyFileSync(file, join(reference, `${slug}.put.json`));
                }
                const result = await bash([block('env'), 'OUT="stage/payloads/x"', block('payload-guard')].join('\n'), env(), tmp);
                if (change === undefined) {
                    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
                } else {
                    expect(result.code, label).not.toBe(0);
                    expect(result.stdout + result.stderr, label).toContain(`${SLUGS[0]}: the payload fails the deployment checks`);
                }
            }
        } finally {
            for (const tmp of tmpRoots) rmSync(tmp, { recursive: true, force: true });
            await server.stop();
        }
    }, 240_000);

    it('a changed event price that nothing but the reviewed reference knows about is refused', async () => {
        const server = await freshApi();
        try {
            const outDir = join(PAYLOAD_DIR, 'rehearsal-drift');
            generate(outDir, [`--now=${iso(Date.now())}`]);
            created.push('rehearsal-drift');
            const file = join(outDir, `${SLUGS[0]}.put.json`);
            const body = readJson<{ pricingInfos: Array<{ pricingPerEvent: { actorChargeEvents: Record<string, Record<string, unknown>> } }> }>(file);
            body.pricingInfos[0]!.pricingPerEvent.actorChargeEvents['recall-record']!.eventPriceUsd = 0.002;
            writeFileSync(file, `${JSON.stringify(body, null, 4)}\n`);
            const result = await bash([block('env'), 'OUT="stage/payloads/rehearsal-drift"', block('payload-guard')].join('\n'), env());
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain(`${SLUGS[0]}: events or prices differ from the reviewed reference`);
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the notice file travels with the body: a notice that disagrees with the effective date, or that states another period, is refused', async () => {
        const server = await freshApi();
        try {
            for (const [label, change] of [
                ['effective date', (notice: Record<string, unknown>) => (notice.effectiveAt = '2030-01-01T00:00:00.000Z')],
                ['notice period', (notice: Record<string, unknown>) => (notice.noticeDays = 7)],
            ] as const) {
                const name = `rehearsal-notice-${label.replace(' ', '-')}`;
                const outDir = join(PAYLOAD_DIR, name);
                generate(outDir, [`--now=${iso(Date.now())}`]);
                created.push(name);
                const file = join(outDir, `${SLUGS[2]}.notice.json`);
                const notice = readJson<Record<string, unknown>>(file);
                change(notice);
                writeFileSync(file, `${JSON.stringify(notice, null, 4)}\n`);
                const result = await bash([block('env'), `OUT="stage/payloads/${name}"`, block('payload-guard')].join('\n'), env());
                expect(result.code, label).not.toBe(0);
                expect(result.stdout + result.stderr, label).toContain(`${SLUGS[2]}: the notice file does not match the payload`);
            }
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the preflight stops when an Actor already has pricing records, and nothing is sent', async () => {
        const server = await freshApi();
        try {
            server.actors.set('latam-global-tender-intelligence', [{ pricingModel: 'PAY_PER_EVENT' }]);
            const script = ['env', 'identify', 'payloads', 'payload-guard', 'preflight', 'put'].map(block).join('\n');
            const result = await bash(script, env({ CONFIRM_PRICING: 'send-pricing-to-production' }));
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain('latam-global-tender-intelligence already has pricing records');
            payloadDirOf(result);
            expect(server.puts()).toHaveLength(0);
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the preflight stops when an Actor was not pushed (404), and nothing is sent', async () => {
        const server = await freshApi();
        try {
            server.actors.delete('global-corporate-patent-intelligence');
            const script = ['env', 'identify', 'payloads', 'payload-guard', 'preflight', 'put'].map(block).join('\n');
            const result = await bash(script, env({ CONFIRM_PRICING: 'send-pricing-to-production' }));
            expect(result.code).not.toBe(0);
            payloadDirOf(result);
            expect(server.puts()).toHaveLength(0);
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('the PUT block refuses to run without the written confirmation, and with a wrong one', async () => {
        const server = await freshApi();
        try {
            const outDir = join(PAYLOAD_DIR, 'rehearsal-confirm');
            generate(outDir, [`--now=${iso(Date.now())}`]);
            created.push('rehearsal-confirm');
            for (const value of [undefined, '', 'yes', 'send-pricing-to-production ']) {
                const extra: Record<string, string> = { ...(value === undefined ? {} : { CONFIRM_PRICING: value }) };
                const result = await bash([block('env'), 'USERNAME=rehearsal', 'OUT="stage/payloads/rehearsal-confirm"', block('put')].join('\n'), env(extra));
                expect(result.code, JSON.stringify(value)).not.toBe(0);
                expect(result.stdout + result.stderr).toContain('CONFIRM_PRICING=send-pricing-to-production');
            }
            expect(server.puts()).toHaveLength(0);
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('a platform error on the second Actor stops the run: the third is never sent', async () => {
        const server = await freshApi();
        try {
            server.failPut.add('latam-global-tender-intelligence');
            const script = ['env', 'identify', 'payloads', 'payload-guard', 'preflight', 'put', 'verify'].map(block).join('\n');
            const result = await bash(script, env({ CONFIRM_PRICING: 'send-pricing-to-production' }));
            expect(result.code).not.toBe(0);
            payloadDirOf(result);
            expect(server.puts().map((r) => r.path)).toEqual([`/v2/actors/${OWNER}~global-regtech-compliance-feed`, `/v2/actors/${OWNER}~latam-global-tender-intelligence`]);
            expect(result.stdout).not.toContain('pricing read back matches');
        } finally {
            await server.stop();
        }
    }, 120_000);

    it('a wrong token is refused by the platform on the very first request, and nothing else is attempted', async () => {
        const server = await freshApi();
        try {
            const result = await bash(['env', 'identify', 'payloads'].map(block).join('\n'), env({ APIFY_TOKEN: 'someone-elses-token' }));
            expect(result.code).not.toBe(0);
            expect(server.requests).toHaveLength(1);
        } finally {
            await server.stop();
        }
    }, 60_000);

    it('without APIFY_TOKEN the shared definitions stop before any request', async () => {
        const server = await freshApi();
        try {
            const result = await bash(block('env'), cleanEnv({ APIFY_API_BASE: server.url }));
            expect(result.code).not.toBe(0);
            expect(result.stdout + result.stderr).toContain('set APIFY_TOKEN');
            expect(server.requests).toHaveLength(0);
        } finally {
            await server.stop();
        }
    }, 60_000);

    it('the smoke test starts one capped run per Actor with a keyless source and reads the items back', async () => {
        const server = await freshApi();
        try {
            const result = await bash(['env', 'identify', 'smoke'].map(block).join('\n'), env({ POLL_SECONDS: '0.1' }));
            expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
            const starts = server.requests.filter((r) => r.method === 'POST');
            expect(starts.map((r) => r.path)).toEqual(SLUGS.map((slug) => `/v2/actors/${OWNER}~${slug}/runs`));
            for (const start of starts) {
                expect(start.query).toContain('maxTotalChargeUsd=0.5');
                expect(start.headers['content-type']).toBe('application/json');
            }
            expect(starts.map((r) => JSON.parse(r.body.toString('utf8')))).toEqual([
                { sources: ['ofac'], maxItemsPerSource: 5 },
                { sources: ['world_bank_notices'], maxItemsPerSource: 5 },
                { sources: ['sg_acra'], maxItemsPerSource: 5 },
            ]);
            expect(result.stdout.match(/SUCCEEDED, 3 items/gu)).toHaveLength(3);
        } finally {
            await server.stop();
        }
    }, 60_000);
});

describe('the payload generator keeps the reviewed reference files out of a deployment', () => {
    it('--out writes the six files to the given directory and does not touch pricing/payloads', () => {
        const reference = join(ROOT, 'pricing', 'payloads');
        const snapshot = (): Record<string, string> => Object.fromEntries(readdirSync(reference).map((name) => [name, readFileSync(join(reference, name), 'utf8')]));
        const beforeFiles = snapshot();
        const outDir = join(PAYLOAD_DIR, 'rehearsal-out');
        generate(outDir, [`--now=${iso(Date.now())}`]);
        created.push('rehearsal-out');
        expect(readdirSync(outDir).sort()).toEqual(SLUGS.flatMap((slug) => [`${slug}.notice.json`, `${slug}.put.json`]).sort());
        expect(snapshot()).toEqual(beforeFiles);
    }, 60_000);

    it('an empty --out is refused, and a missing --now still is', () => {
        const empty = spawnSync('npx', ['tsx', 'scripts/generate_pricing_payloads.ts', `--now=${iso(Date.now())}`, '--out='], { cwd: ROOT, env: cleanEnv({}), encoding: 'utf8' });
        expect(empty.status).toBe(2);
        const noNow = spawnSync('npx', ['tsx', 'scripts/generate_pricing_payloads.ts', '--out=stage/payloads/never'], { cwd: ROOT, env: cleanEnv({}), encoding: 'utf8' });
        expect(noNow.status).toBe(2);
        expect(existsSync(join(PAYLOAD_DIR, 'never'))).toBe(false);
    }, 60_000);

    it('the committed reference files are what the generator produces for their own instant (nothing was hand-edited)', () => {
        for (const pricing of ALL_PRICING) {
            const reference = readJson<ReturnType<typeof buildPricingPutBody>['body']>(join(ROOT, 'pricing', 'payloads', `${pricing.engine}.put.json`));
            const now = reference.pricingInfos[0]!.createdAt;
            expect(reference).toEqual(buildPricingPutBody(pricing, { now, hasPayingUsers: true }).body);
        }
    });
});

describe('what the runbook states equals the committed artefacts', () => {
    const actorJson = (slug: string): { name: string; minMemoryMbytes: number; maxMemoryMbytes: number } => readJson(join(ROOT, slug, '.actor', 'actor.json'));
    const schema = (slug: string): { properties: Record<string, { isSecret?: boolean; items?: { enum?: string[] } }> } => readJson(join(ROOT, slug, '.actor', 'input_schema.json'));
    const section1 = markdown.slice(markdown.indexOf('## 1. What is deployed'), markdown.indexOf('## 2. Prerequisites'));

    it('section 1 lists, for each Actor, its pinned memory, its sources, its secret credentials and every event with its price', () => {
        for (const pricing of ALL_PRICING) {
            const row = section1.split('\n').find((line) => line.startsWith(`| \`${pricing.engine}\``));
            expect(row, pricing.engine).toBeDefined();
            const actor = actorJson(pricing.engine);
            expect(actor.name).toBe(pricing.engine);
            expect(actor.minMemoryMbytes).toBe(actor.maxMemoryMbytes);
            expect(row).toContain(`${actor.minMemoryMbytes.toLocaleString('en-US')} MB`);
            const properties = schema(pricing.engine).properties;
            for (const source of properties.sources?.items?.enum ?? []) expect(row, `${pricing.engine} source ${source}`).toContain(`\`${source}\``);
            const secrets = Object.entries(properties).filter(([, value]) => value.isSecret === true).map(([key]) => key);
            expect(secrets.length).toBeGreaterThan(0);
            for (const secret of secrets) expect(row, `${pricing.engine} secret ${secret}`).toContain(`\`${secret}\``);
            for (const event of pricing.events) {
                // the table writes a price as 0.0005 or 0.02; 0.003 as 0.003
                const written = String(event.priceUsd);
                expect(row, `${pricing.engine} ${event.name}`).toMatch(new RegExp(`\`${event.name}\` ${written.replace('.', '\\.')}[ ;(]|\`${event.name}\` ${written.replace('.', '\\.')}$`, 'u'));
            }
            expect(row).toContain(`start ${pricing.startPriceUsd} per GB`);
        }
    });

    it('the sources of the input schema are exactly the active connectors: held ones are not offered', () => {
        const held = ['ar_cordoba', 'ar_salta', 'ar_mendoza', 'ar_pba'];
        const tenders = schema('latam-global-tender-intelligence').properties.sources?.items?.enum ?? [];
        for (const source of held) expect(tenders).not.toContain(source);
        expect(markdown).toContain('`ar_cordoba` is not in the input schema');
    });

    it('states the three corrections and the gates with the numbers the code uses', () => {
        expect(markdown).toContain('$0.005 per GB');
        expect(markdown).toContain('`PUT /v2/actors/{actorId}`');
        expect(markdown).toContain('section 9.4');
        expect(markdown).toContain('14 days');
        expect(markdown).toContain('cannot be cancelled or edited');
        for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5']) expect(markdown).toContain(`| ${gate} |`);
        for (const event of ['crawler-signal', 'grant-updated', 'uae-entity-updated', 'sg-entity-updated']) expect(markdown).toContain(event);
        // the provisional and operator-stated events named in the gates are the ones the notice files report
        const provisional = SLUGS.flatMap((slug) => readJson<{ provisionalEvents: string[] }>(join(ROOT, 'pricing', 'payloads', `${slug}.notice.json`)).provisionalEvents).sort();
        expect(provisional).toEqual(['crawler-signal', 'grant-updated', 'sg-entity-updated', 'uae-entity-updated']);
    });
});
