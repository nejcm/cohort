import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { run } from '../../src/cli.ts';
import { sha256 } from '../../src/config/files.ts';
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

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
let approved: string;
const provenance = (): string[] => [
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
];

async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await run(argv, (text) => void (out += text), {
    cwd: root,
    env: {
      OPENAI_API_KEY: KEY,
      COHORT_FIXTURE_ORIGIN: base.url,
      HOOK_MODE: 'ok',
      HOOK_TOKEN: 'unused-hook-value',
      ...env,
    },
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
  approved = sha256(await readFile(join(runDir, 'manifest.json')));
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
    ...provenance(),
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

test('an identical head is no_regression after one round and exits 0', async () => {
  const { code, out } = await cli(['compare', runId, '--base', base.url, '--head', healthy.url, ...provenance()]);
  assert.equal(code, 0, out);
  assert.match(out, /^1\. base passed .*\n2\. head passed .*\ncompare run_\S+: no_regression \(/mu);
  assert.ok(!out.includes(CANARY));
});

test('a result that flips between rounds is inconclusive, never a regression', async () => {
  const flaky = await switching(broken.url, healthy.url);
  try {
    const { code, out } = await cli([
      'compare',
      runId,
      '--base',
      base.url,
      '--head',
      flaky.url,
      ...provenance(),
      '--json',
    ]);
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
  const manifest = await readFile(join(runDir, 'manifest.json'), 'utf8');
  for (const url of [`${base.url}/arrival`, `${base.url.replace(/^http:/u, '')}/arrival`]) {
    await appendFile(script, `// await page.goto(${JSON.stringify(url)});\n`);
    await writeFile(join(runDir, 'manifest.json'), manifest.replace(sha256(original), sha256(await readFile(script))));
    try {
      const pinned = await cli(['compare', runId, '--base', base.url, '--head', base.url]);
      assert.equal(pinned.code, 2, url);
      assert.match(pinned.out, /replay\.spec\.ts navigates to an absolute URL/u);
    } finally {
      await writeFile(script, original);
      await writeFile(join(runDir, 'manifest.json'), manifest);
    }
  }
});

test('missing provenance or hooks is inconclusive without opening a browser', async () => {
  const all = provenance();
  for (const drop of ['--deployment', '--head-sha', '--approved', '--hooks']) {
    const index = all.indexOf(drop);
    const argv = [...all.slice(0, index), ...all.slice(index + 2)];
    const { code, out } = await cli(['compare', runId, '--base', base.url, '--head', broken.url, ...argv, '--json']);
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.deepEqual([result.outcome, result.executions.length], ['inconclusive', 0], drop);
    assert.match(
      result.reason,
      drop === '--hooks' ? /no --hooks module/u : new RegExp(`missing provenance: ${drop}`, 'u'),
    );
  }
  const bad = await cli(['compare', runId, '--base', base.url, '--head', broken.url, '--repo', '../x', '--json']);
  assert.equal(bad.code, 2, bad.out);
});

test('unverified resets, contaminated scopes, wrong deployments, and failing hooks are inconclusive', async () => {
  for (const [mode, executions, reason] of [
    ['unverified', ['base error'], /base execution 1 could not run: reset verification failed/u],
    ['contaminated', ['base error'], /not scoped to this execution/u],
    ['wrong-deployment', ['base passed', 'head error'], /deployment identity does not match --deployment/u],
    ['cleanup-fails', ['base error'], /cleanup failed; the scope may be contaminated/u],
    ['throw', ['base error'], /compare hooks failed/u],
  ] as const) {
    const { code, out } = await cli(
      ['compare', runId, '--base', base.url, '--head', broken.url, ...provenance(), '--json'],
      { HOOK_MODE: mode },
    );
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.equal(result.outcome, 'inconclusive', mode);
    assert.deepEqual(
      result.executions.map((execution: { side: string; status: string }) => `${execution.side} ${execution.status}`),
      executions,
      mode,
    );
    assert.match(result.reason, reason);
    assert.ok(!out.includes(CANARY), mode);
  }
});

test('a tampered bundle, a planted file, or a script that is not the approved one is refused', async () => {
  const script = join(runDir, 'replay.spec.ts');
  const original = await readFile(script, 'utf8');
  const compare = () => cli(['compare', runId, '--base', base.url, '--head', healthy.url, ...provenance(), '--json']);
  await writeFile(script, original.replace('expect', 'expect '));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.equal(JSON.parse(out).code, 'invalid');
    assert.match(out, /replay\.spec\.ts does not match its SHA-256 hash/u);
  } finally {
    await writeFile(script, original);
  }
  const configPath = join(runDir, 'resolved-config.json');
  const [config, manifest] = await Promise.all([
    readFile(configPath, 'utf8'),
    readFile(join(runDir, 'manifest.json'), 'utf8'),
  ]);
  const forged = config.replace('"timeMs": 8000', '"timeMs": 7000');
  assert.notEqual(forged, config);
  await writeFile(configPath, forged);
  await writeFile(join(runDir, 'manifest.json'), manifest.replaceAll(sha256(config), sha256(forged)));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /manifest\.json does not match the approved hash/u);
  } finally {
    await writeFile(configPath, config);
    await writeFile(join(runDir, 'manifest.json'), manifest);
  }
  await writeFile(join(runDir, 'playwright.config.ts'), 'process.exit(0);\n');
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /playwright\.config\.ts is not a file a run writes/u);
  } finally {
    await rm(join(runDir, 'playwright.config.ts'));
  }
  await rename(join(runDir, 'trace.zip'), join(root, 'trace.zip'));
  await rename(join(runDir, 'steps.jsonl'), join(root, 'steps.jsonl'));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /steps\.jsonl is listed in manifest\.json but missing/u);
    await rename(join(root, 'steps.jsonl'), join(runDir, 'steps.jsonl'));
    const withoutTrace = await cli(['compare', runId, '--base', base.url, '--head', healthy.url, '--json']);
    assert.equal(withoutTrace.code, 0, 'an uploaded bundle without trace.zip still verifies');
  } finally {
    await rename(join(root, 'trace.zip'), join(runDir, 'trace.zip'));
    await rename(join(root, 'steps.jsonl'), join(runDir, 'steps.jsonl')).catch(() => {});
  }
  const other = provenance();
  other[other.indexOf('--approved') + 1] = `sha256:${'0'.repeat(64)}`;
  const { code, out } = await cli(['compare', runId, '--base', base.url, '--head', healthy.url, ...other]);
  assert.equal(code, 2, out);
  assert.match(out, /does not match the approved hash/u);
});

test('values the hooks read are redacted from failure text', async () => {
  const { out } = await cli(['compare', runId, '--base', base.url, '--head', broken.url, ...provenance(), '--json'], {
    HOOK_TOKEN: 'Arrival instructions',
  });
  const result = JSON.parse(out);
  assert.equal(result.executions[1].status, 'failed', out);
  assert.match(result.executions[1].failure, /\[env\]/u);
  assert.ok(!out.includes('Arrival instructions'));
});
