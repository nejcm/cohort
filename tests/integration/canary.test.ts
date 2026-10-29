import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { run } from '../../src/cli.ts';
import { startDashboard } from '../../src/dashboard/server.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId } from '../helpers/fake-provider.ts';
import { zipEntry } from '../helpers/zip.ts';

// Values arrive only through the environment, so no project file contains them literally.
const EMAIL = 'canary-mail-7d1e@example.test';
const TOKEN = 'canaryTok9b3f5a';
const KEY = 'sk-canary-provider-key-5c2e81';
const ENV_ONLY = 'env-canary-value-30af';

let fixture: FixtureServer;
let root: string;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])),
  );
  return nested.flat();
}

before(async () => {
  fixture = await startFixture();
  root = await mkdtemp(join(tmpdir(), 'lab-canary-'));
  await put(
    '.cohort/config.yml',
    'schemaVersion: 1\nmodel: openai/test-model\nrepeats: 1\nlimits: { steps: 10, timeMs: 60000 }\n',
  );
  await put(
    '.cohort/models.yml',
    'version: test\nmodels:\n  - id: test-model\n    provider: openai\n    label: t\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n',
  );
  await put(
    '.cohort/personas/guest.md',
    '---\nschemaVersion: 1\nid: guest\nname: Guest\ntags: [guest]\ndevice: { viewport: { width: 800, height: 900 }, touch: false }\nlocale: en-US\ntimezone: UTC\n---\n\nYou are a guest.\n',
  );
  await put(
    '.cohort/setup/canary.ts',
    `export default async (ctx) => {
  const email = ctx.env('COHORT_CANARY_EMAIL');
  const token = ctx.env('COHORT_CANARY_TOKEN');
  const echo = ctx.env('COHORT_CANARY_ENV');
  ctx.onCleanup(async () => { throw new Error('cleanup saw ' + process.env.OPENAI_API_KEY + ' and ' + echo); });
  return {
    startUrl: ctx.env('COHORT_FIXTURE_ORIGIN') + '/lab/canary#' + token,
    secrets: { email, token },
    tools: {
      lookup: {
        description: 'Look up the account.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        async execute() {
          return { text: 'account ' + email + ' token ' + token + ' key ' + process.env.OPENAI_API_KEY + ' env ' + echo };
        },
      },
    },
  };
};
`,
  );
  await put(
    '.cohort/suites/canary.yml',
    'schemaVersion: 1\nid: canary\nname: canary\ndefaults:\n  setup: ../setup/canary.ts\nentries:\n  - persona: guest\n    goal: Sign in.\n',
  );
});

after(() => fixture.close());

test('known secrets and the provider key stay out of every output and artifact except the private trace', async () => {
  const probe = await chromium.launch();
  let emailAt: { kind: 'point'; x: number; y: number };
  try {
    const page = await (await probe.newContext({ viewport: { width: 800, height: 900 } })).newPage();
    await page.goto(`${fixture.url}/lab/canary#${TOKEN}`);
    const box = (await page.locator('#email').boundingBox())!;
    emailAt = { kind: 'point', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } finally {
    await probe.close();
  }
  const fake = fakeProvider([
    () => ({ name: 'lookup', args: {} }),
    (request) => ({
      name: 'fill',
      args: { observationId: request.observation.id, target: emailAt, value: '{{email}}' },
    }),
    // A model that somehow learned a secret must not get it into reports.
    (request) => ({
      name: 'done',
      args: { step: lastStepId(request), summary: `Signed in as ${EMAIL} with ${TOKEN}` },
    }),
  ]);
  const provider = { ...fake, id: 'openai', keyEnv: 'OPENAI_API_KEY' };
  const env = {
    COHORT_FIXTURE_ORIGIN: fixture.url,
    COHORT_CANARY_EMAIL: EMAIL,
    COHORT_CANARY_TOKEN: TOKEN,
    COHORT_CANARY_ENV: ENV_ONLY,
    OPENAI_API_KEY: KEY,
  };
  let out = '';
  const cli = (argv: string[]) =>
    run(argv, (text) => void (out += text), { cwd: root, env, providers: { openai: provider } });

  const code = await cli(['run', '--suite', 'canary', '--json']);
  const result = JSON.parse(out.trim()) as { batchId: string; runs: { runId: string; outcome: { state: string } }[] };
  assert.equal(code, 0, out);
  const runId = result.runs[0]!.runId;
  for (const format of ['json', 'md', 'html']) {
    await cli(['report', runId, '--format', format]);
    await cli(['report', result.batchId, '--format', format]);
  }
  await cli(['persona', 'validate']);
  // An index left by an older version under a loose umask.
  const index = join(root, '.cohort', 'index.sqlite');
  await chmod(join(root, '.cohort'), 0o755);
  await writeFile(index, '', { mode: 0o644 });
  await chmod(index, 0o644);
  const dashboard = await startDashboard({ projectRoot: root, env, providers: { openai: provider } });
  try {
    const listed = await fetch(`${dashboard.origin}/api/runs`, {
      headers: { authorization: `Bearer ${dashboard.token}` },
    });
    assert.match(await listed.text(), new RegExp(runId, 'u'));
    assert.equal((await lstat(join(root, '.cohort'))).mode & 0o777, 0o700, '.cohort is owner-only');
    for (const suffix of ['', '-wal', '-shm'])
      assert.equal((await lstat(`${index}${suffix}`)).mode & 0o777, 0o600, `index.sqlite${suffix} is owner-only`);
  } finally {
    await dashboard.close();
  }

  const outbound = JSON.stringify(
    fake.requests.map(({ observation, ...rest }) => ({ ...rest, text: observation.text })),
  );
  assert.match(outbound, /\{\{email\}\}/u, 'the model saw the placeholder');
  const canaries = [EMAIL, TOKEN, KEY, ENV_ONLY];
  const scanned: string[] = [];
  for (const path of await files(join(root, '.cohort'))) {
    if (path.endsWith('trace.zip')) continue;
    const bytes = await readFile(path);
    for (const canary of canaries)
      for (const form of [canary, Buffer.from(canary).toString('base64')])
        assert.ok(!bytes.includes(form), `${relative(root, path)} contains ${canary}`);
    scanned.push(relative(join(root, '.cohort', 'runs'), path));
  }
  for (const canary of canaries) {
    assert.ok(!out.includes(canary), `CLI output contains ${canary}`);
    assert.ok(!outbound.includes(canary), `provider payload contains ${canary}`);
  }
  for (const name of [
    'steps.jsonl',
    'replay.spec.ts',
    'report.json',
    'report.html',
    'manifest.json',
    'resolved-config.json',
  ])
    assert.ok(scanned.includes(join(runId, name)), `${name} was scanned`);
  assert.ok(scanned.some((path) => path.startsWith(join(runId, 'screenshots'))));
  assert.match(out, /\[redacted:email\]|\{\{email\}\}/u, 'the echoed secret was replaced, not dropped silently');

  const runDir = join(root, '.cohort', 'runs', runId);
  const trace = await readFile(join(runDir, 'trace.zip'));
  assert.ok(
    zipEntry(trace, 'trace.trace')!.includes(EMAIL),
    'positive control: the private trace holds the filled value',
  );
  for (const dir of [runDir, join(root, '.cohort', 'runs', result.batchId)]) {
    assert.equal((await lstat(dir)).mode & 0o777, 0o700, `${relative(root, dir)} is owner-only`);
    for (const path of await files(dir))
      assert.equal((await lstat(path)).mode & 0o077, 0, `${relative(root, path)} is owner-only`);
  }
  assert.match(await readFile(join(runDir, 'report.html'), 'utf8'), /trace\.zip/u);
  assert.match(await readFile(join(runDir, 'report.md'), 'utf8'), /secret/iu);
});
