import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { run } from '../../src/cli.ts';
import { startFixture, type FixtureServer } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId } from '../helpers/fake-provider.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
const CANARY = 'compare-canary-5150';
const KEY = 'sk-compare-provider-9';
let root: string;
let base: FixtureServer;
let healthy: FixtureServer;
let broken: FixtureServer;
let runId: string;
let runDir: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await run(argv, (text) => void (out += text), {
    cwd: root,
    env: { OPENAI_API_KEY: KEY, COHORT_FIXTURE_ORIGIN: base.url },
    providers: { openai: provider } as never,
  });
  return { code, out };
}

let linkAt: { kind: 'point'; x: number; y: number };
const provider = fakeProvider((request) =>
  request.history.some((line) => line.split(' ')[1] === 'click')
    ? { name: 'done', args: { step: lastStepId(request), summary: 'Arrival page is shown.' } }
    : { name: 'click', args: { observationId: request.observation.id, target: linkAt } },
);

// Sends the first start-page visit to `first`, every later one to `then`, so one side changes between rounds.
async function switching(first: string, then: string): Promise<{ server: Server; url: string }> {
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

before(async () => {
  [base, healthy, broken] = await Promise.all([
    startFixture(),
    startFixture(),
    startFixture({ mutations: ['confusing_label'] }),
  ]);
  root = await mkdtemp(join(tmpdir(), 'lab-compare-'));
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
    '.cohort/suites/journey.yml',
    'schemaVersion: 1\nid: journey\nname: journey\ndefaults:\n  setup: ../setup/token.ts\nentries:\n  - persona: guest\n',
  );
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(`${base.url}/`);
    const box = (await page.getByRole('link', { name: 'Arrival instructions' }).boundingBox())!;
    linkAt = { kind: 'point', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } finally {
    await browser.close();
  }
  const recorded = await cli(['run', '--suite', 'journey', '--json']);
  assert.equal(recorded.code, 0, recorded.out);
  ({ runId, outDir: runDir } = JSON.parse(recorded.out).runs[0]);
});

after(async () => {
  await Promise.all([base.close(), healthy.close(), broken.close()]);
  await rm(root, { recursive: true, force: true });
});

const bundleState = async () =>
  Promise.all(['report.json', 'manifest.json'].map((name) => readFile(join(runDir, name), 'utf8')));

test('a head that breaks the approved journey is a confirmed regression in four executions', async () => {
  const original = await bundleState();
  const { code, out } = await cli([
    'compare',
    runId,
    '--base',
    base.url,
    '--head',
    `${broken.url}/`,
    '--json',
    '--markdown',
    'comment.md',
  ]);
  const result = JSON.parse(out);
  assert.equal(code, 1, out);
  assert.equal(result.outcome, 'regression');
  assert.deepEqual(
    result.executions.map((execution: { side: string; status: string }) => `${execution.side} ${execution.status}`),
    ['base passed', 'head failed', 'base passed', 'head failed'],
  );
  assert.match(result.executions[1].failure, /^s0001 click: .*(Error|Test timeout)/u);
  const markdown = await readFile(join(root, 'comment.md'), 'utf8');
  assert.ok(markdown.startsWith(`<!-- cohort-compare:${runId} -->\n`));
  assert.match(markdown, /journey check: regression/u);
  for (const text of [out, markdown]) {
    assert.ok(!text.includes(CANARY), 'setup secret leaked');
    assert.ok(!text.includes(KEY), 'provider key leaked');
  }
  assert.deepEqual(await bundleState(), original, 'compare does not touch the approved run');
  assert.equal(JSON.parse(original[0]!).replay.status, 'not_attempted');
});

test('an identical head is unchanged after one round and exits 0', async () => {
  const { code, out } = await cli(['compare', runId, '--base', base.url, '--head', healthy.url]);
  assert.equal(code, 0, out);
  assert.match(out, /^1\. base passed .*\n2\. head passed .*\ncompare run_\S+: unchanged \(/mu);
  assert.ok(!out.includes(CANARY));
});

test('a result that flips between rounds is inconclusive, never a regression', async () => {
  const flaky = await switching(broken.url, healthy.url);
  try {
    const { code, out } = await cli(['compare', runId, '--base', base.url, '--head', flaky.url, '--json']);
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.deepEqual([result.outcome, result.executions.length], ['inconclusive', 4]);
    assert.match(result.reason, /flaky/u);
  } finally {
    flaky.server.close();
  }
});

test('compare refuses bad origins and journeys pinned to the recorded origin', async () => {
  for (const argv of [
    ['--base', base.url],
    ['--base', `${base.url}/app`, '--head', base.url],
    ['--base', `http://user:pw@127.0.0.1:1`, '--head', base.url],
    ['--base', `${base.url}/?token=x`, '--head', base.url],
  ]) {
    const { code, out } = await cli(['compare', runId, ...argv]);
    assert.equal(code, 2, out);
    assert.match(out, /must be an http\(s\) origin/u);
  }
  const script = join(runDir, 'replay.spec.ts');
  const original = await readFile(script, 'utf8');
  for (const url of [`${base.url}/arrival`, `${base.url.replace(/^http:/u, '')}/arrival`]) {
    await appendFile(script, `// await page.goto(${JSON.stringify(url)});\n`);
    try {
      const pinned = await cli(['compare', runId, '--base', base.url, '--head', base.url]);
      assert.equal(pinned.code, 2, url);
      assert.match(pinned.out, /replay\.spec\.ts navigates to an absolute URL/u);
    } finally {
      await writeFile(script, original);
    }
  }
});
