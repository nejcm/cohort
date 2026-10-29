import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before } from 'node:test';
import { chromium } from 'playwright';
import { run } from '../../src/cli.ts';
import { sha256 } from '../../src/config/files.ts';
import { startFixture, type FixtureServer } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId } from './fake-provider.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
export const CANARY = 'compare-canary-5150';
export const KEY = 'sk-compare-provider-9';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

interface CompareFixture {
  root: string;
  base: FixtureServer;
  healthy: FixtureServer;
  broken: FixtureServer;
  runId: string;
  runDir: string;
  provenance(): string[];
  cli(argv: string[], env?: Record<string, string>): Promise<{ code: number; out: string }>;
  bundleState(): Promise<string[]>;
}

export function compareFixture(): CompareFixture {
  let approved: string;
  let linkAt: { kind: 'point'; x: number; y: number };
  const provider = fakeProvider((request) =>
    request.history.some((line) => line.split(' ')[1] === 'click')
      ? { name: 'done', args: { step: lastStepId(request), summary: 'Arrival page is shown.' } }
      : { name: 'click', args: { observationId: request.observation.id, target: linkAt } },
  );
  const f = {
    provenance: () => [
      '--repo',
      'acme/shop',
      '--pr',
      '42',
      '--base-sha',
      BASE_SHA,
      '--head-sha',
      HEAD_SHA,
      '--deployment',
      'dpl_42',
      '--approved',
      approved,
      '--hooks',
      '.cohort/setup/hooks.ts',
    ],
    async cli(argv: string[], env: Record<string, string> = {}) {
      let out = '';
      const code = await run(argv, (text) => void (out += text), {
        cwd: f.root,
        env: {
          OPENAI_API_KEY: KEY,
          COHORT_FIXTURE_ORIGIN: f.base.url,
          HOOK_MODE: 'ok',
          HOOK_TOKEN: 'unused-hook-value',
          ...env,
        },
        providers: { openai: provider } as never,
      });
      return { code, out };
    },
    bundleState: () =>
      Promise.all(['report.json', 'manifest.json'].map((name) => readFile(join(f.runDir, name), 'utf8'))),
  } as CompareFixture;

  const put = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(f.root, path)), { recursive: true });
    await writeFile(join(f.root, path), content);
  };

  before(async () => {
    [f.base, f.healthy, f.broken] = await Promise.all([
      startFixture(),
      startFixture(),
      startFixture({ mutations: ['confusing_label'] }),
    ]);
    f.root = await mkdtemp(join(tmpdir(), 'lab-compare-'));
    await put(
      '.cohort/config.yml',
      'schemaVersion: 1\nmodel: openai/test-model\nrepeats: 1\nlimits: { steps: 10, timeMs: 8000 }\n',
    );
    await put(
      '.cohort/models.yml',
      'version: test\nmodels:\n  - id: test-model\n    provider: openai\n    label: test-model\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n',
    );
    await put(
      '.cohort/personas/guest.md',
      '---\nschemaVersion: 1\nid: guest\nname: Guest\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\ngoal: Find the arrival instructions.\n---\n\nYou are a guest.\n',
    );
    await put(
      '.cohort/setup/token.ts',
      `export default async (ctx) => ({ startUrl: ctx.env('COHORT_FIXTURE_ORIGIN') + '/?scope=' + ctx.scopeId + '&t=${CANARY}', secrets: { token: '${CANARY}' } });\n`,
    );
    await put(
      '.cohort/setup/hooks.ts',
      `export default async (ctx) => {
  const mode = ctx.env('HOOK_MODE');
  ctx.env('HOOK_TOKEN');
  if (mode === 'throw') throw new Error('hook ${CANARY}');
  return {
    revision: ctx.side === 'base' ? '${BASE_SHA}' : '${HEAD_SHA}',
    deployment: mode === 'wrong-deployment' ? 'dpl_other' : 'dpl_42',
    reset: { scopeId: mode === 'contaminated' ? 'compare_other' : ctx.scopeId, verified: mode !== 'unverified' },
    cleanup: async () => { if (mode === 'cleanup-fails') throw new Error('${CANARY}'); },
  };
};\n`,
    );
    await put(
      '.cohort/suites/journey.yml',
      'schemaVersion: 1\nid: journey\nname: journey\ndefaults:\n  setup: ../setup/token.ts\nentries:\n  - persona: guest\n',
    );
    await symlink(join(repoRoot, 'node_modules'), join(f.root, 'node_modules'));

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.goto(`${f.base.url}/`);
      const box = (await page.getByRole('link', { name: 'Arrival instructions' }).boundingBox())!;
      linkAt = { kind: 'point', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    } finally {
      await browser.close();
    }
    const recorded = await f.cli(['run', '--suite', 'journey', '--json']);
    assert.equal(recorded.code, 0, recorded.out);
    ({ runId: f.runId, outDir: f.runDir } = JSON.parse(recorded.out).runs[0]);
    approved = sha256(await readFile(join(f.runDir, 'manifest.json')));
  });

  after(async () => {
    await Promise.all([f.base.close(), f.healthy.close(), f.broken.close()]);
    await rm(f.root, { recursive: true, force: true });
  });

  return f;
}

// Sends the first start-page visit to `first`, every later one to `then`, so one side changes between rounds.
export async function switching(first: string, then: string): Promise<{ server: Server; url: string }> {
  let visits = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/?')) visits += 1;
    const upstream = await fetch(`${visits <= 1 ? first : then}${request.url}`, { redirect: 'manual' });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
