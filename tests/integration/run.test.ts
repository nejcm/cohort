import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { run } from '../../src/cli.ts';
import { createAnthropicAdapter } from '../../src/providers/anthropic.ts';
import { validateClaim } from '../../src/evidence/friction.ts';
import { createOpenAIAdapter } from '../../src/providers/openai.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
const CANARY = 'cleanup-canary-4242';
let fixture: FixtureServer;
let root: string;
let turn: Turn;
const provider = fakeProvider((request, index) => turn(request, index));

const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });

const model = (id: string, untested: boolean, prices: string, owner = 'openai'): string =>
  `  - id: ${id}\n    provider: ${owner}\n    label: ${id}\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: ${prices}\n    pricingVerifiedAt: ${prices.includes('null') ? 'null' : '2026-10-01'}\n    untested: ${untested}\n`;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

before(async () => {
  fixture = await startFixture();
  root = await mkdtemp(join(tmpdir(), 'lab-run-'));
  await put(
    '.lab/config.yml',
    'schemaVersion: 1\nmodel: openai/test-model\nrepeats: 1\nlimits: { steps: 10, timeMs: 30000 }\n',
  );
  await put(
    '.lab/models.yml',
    `version: test\nmodels:\n${model('test-model', false, '{ input: 1, output: 4, cachedInput: 0.1 }')}${model('fresh-model', true, '{ input: null, output: null, cachedInput: null }')}${model('test-claude', false, '{ input: 1, output: 4, cachedInput: 0.1 }', 'anthropic')}`,
  );
  await put(
    '.lab/personas/guest.md',
    '---\nschemaVersion: 1\nid: guest\nname: Guest\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\ngoal: Look around.\n---\n\nYou are a guest.\n',
  );
  await mkdir(join(root, '.lab/setup'), { recursive: true });
  await copyFile(join(repoRoot, 'examples/setup/fixture.ts'), join(root, '.lab/setup/fixture.ts'));
  await put(
    '.lab/setup/secret.ts',
    `export default async (ctx) => {
  ctx.onCleanup(async () => { throw new Error('cleanup failed for ${CANARY}'); });
  return { startUrl: ctx.env('LAB_FIXTURE_ORIGIN') + '/?scope=' + ctx.scopeId, secrets: { email: '${CANARY}' } };
};
`,
  );
  await put('.lab/setup/broken.ts', "export default async () => { throw new Error('setup exploded'); };\n");
  const suite = (id: string, defaults: string): Promise<void> =>
    put(
      `.lab/suites/${id}.yml`,
      `schemaVersion: 1\nid: ${id}\nname: ${id}\ndefaults:\n${defaults}entries:\n  - persona: guest\n`,
    );
  await suite('healthy', '  setup: ../setup/fixture.ts\n  repeats: 2\n');
  await suite('secret', '  setup: ../setup/secret.ts\n');
  await suite('broken', '  setup: ../setup/broken.ts\n');
  await put(
    '.lab/setup/leaky.ts',
    "export default async (ctx) => { throw new Error('login failed for ' + ctx.env('LAB_TEST_PASSWORD') + ' with sk-inline-key-123'); };\n",
  );
  await suite('leaky', '  setup: ../setup/leaky.ts\n');
  await put(
    '.lab/setup/leaky-env.ts',
    "export default async (ctx) => { throw new Error('bad ' + ctx.env('LAB_LEAK')); };\n",
  );
  await suite('leakyenv', '  setup: ../setup/leaky-env.ts\n');
  await put('.lab/setup/hang.ts', 'export default () => new Promise(() => {});\n');
  await suite('hang', '  setup: ../setup/hang.ts\n');
  await put('.lab/setup/hang-load.ts', 'await new Promise(() => {});\nexport default () => ({});\n');
  await suite('hangload', '  setup: ../setup/hang-load.ts\n');
  await put(
    '.lab/setup/stuck-fail.ts',
    "export default async (ctx) => { ctx.onCleanup(() => new Promise(() => {})); throw new Error('nope'); };\n",
  );
  await suite('stuckfail', '  setup: ../setup/stuck-fail.ts\n');
  await put(
    '.lab/setup/stuck-cleanup.ts',
    "export default async (ctx) => { ctx.onCleanup(() => new Promise(() => {})); return { startUrl: ctx.env('LAB_FIXTURE_ORIGIN') + '/' }; };\n",
  );
  await suite('stuckcleanup', '  setup: ../setup/stuck-cleanup.ts\n');
  await suite('badshape', `  url: ${fixture.url}/\n  storageState: badshape\n`);
  await put('.lab/auth/badshape.json', '{ "cookies": [null], "origins": [] }');
  await suite('authed', `  url: ${fixture.url}/lab/state?scope=authed\n  storageState: host\n`);
  await suite('badstate', `  url: ${fixture.url}/\n  storageState: corrupt\n`);
  await put(
    '.lab/auth/host.json',
    JSON.stringify({
      cookies: [
        {
          name: 'lab_auth',
          value: 'yes',
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
  await put('.lab/auth/corrupt.json', '{ nope');
});
after(async () => {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});

type LabOptions = {
  env?: NodeJS.ProcessEnv;
  fake?: boolean;
  signal?: AbortSignal;
  providers?: object;
  openTrace?: (path: string) => Promise<number>;
};

const lab = (argv: string[], options: LabOptions = {}) => cli(['run', ...argv], options);

async function cli(argv: string[], options: LabOptions = {}): Promise<{ code: number; out: string; json: any }> {
  let out = '';
  const code = await run(
    argv,
    (text) => {
      out += text;
    },
    {
      cwd: root,
      env: options.env ?? { OPENAI_API_KEY: 'test-key', LAB_FIXTURE_ORIGIN: fixture.url },
      ...(options.fake === false ? {} : { providers: (options.providers ?? { openai: provider }) as never }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.openTrace ? { openTrace: options.openTrace } : {}),
    },
  );
  let json: unknown = null;
  if (argv.includes('--json')) json = JSON.parse(out);
  return { code, out, json };
}

const runCount = async (): Promise<number> => (await readdir(join(root, '.lab/runs')).catch(() => [])).length;

test('a suite run repeats with one frozen request, fresh artifacts, and exit 0', async () => {
  turn = done;
  const sentBefore = provider.requests.length;
  const { code, json } = await lab(['--suite', 'healthy', '--json']);
  assert.equal(code, 0);
  assert.equal(json.runs.length, 2);
  assert.ok(json.runs.every((item: any) => item.outcome.state === 'completed'));
  assert.notEqual(json.runs[0].runId, json.runs[1].runId);
  const configs = [];
  for (const item of json.runs) {
    for (const name of ['resolved-config.json', 'steps.jsonl', 'trace.zip', 'replay.spec.ts', 'screenshots'])
      await stat(join(item.outDir, name));
    configs.push(JSON.parse(await readFile(join(item.outDir, 'resolved-config.json'), 'utf8')));
  }
  assert.deepEqual(configs[0].request, configs[1].request);
  assert.equal(configs[0].request.catalog.entry.id, 'test-model');
  assert.equal(configs[0].setup.path, '.lab/setup/fixture.ts');
  const sent = provider.requests.slice(sentBefore);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((request) => request.model === 'test-model' && request.effort === 'low'));
});

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory()) found.push(...(await walk(join(dir, entry.name), `${prefix}${entry.name}/`)));
    else found.push(`${prefix}${entry.name}`);
  return found.toSorted();
}

test('runs finalize into a manifest-inventoried bundle with reports, claims, and a batch summary', async () => {
  let runNo = 0;
  turn = (request) => {
    const last = lastStepId(request);
    if (last === 's0000') runNo += 1;
    const id = request.observation.id;
    if (runNo === 1 && last === 's0000')
      return { name: 'scroll', args: { observationId: id, target: null, deltaX: 0, deltaY: 200 } };
    if (runNo === 1 && last === 's0001')
      return {
        name: 'report_friction',
        args: { step: 's0001', reason: 'The <b>page</b> [x](javascript:alert(1)) was confusing' },
      };
    return done(request, 0);
  };
  const { code, json } = await lab(['--suite', 'healthy', '--json']);
  assert.equal(code, 0);
  const [first, second] = json.runs;
  assert.deepEqual(json.summary.groups[0].completion, { numerator: 2, denominator: 2, rate: 1 });

  for (const item of json.runs) {
    const manifest = JSON.parse(await readFile(join(item.outDir, 'manifest.json'), 'utf8'));
    const files = (await walk(item.outDir)).filter((path) => path !== 'manifest.json');
    assert.deepEqual(manifest.artifacts.map((artifact: { path: string }) => artifact.path).toSorted(), files);
    assert.equal(manifest.artifacts.find((artifact: any) => artifact.path === 'trace.zip').sensitivity, 'private_raw');
    assert.equal(manifest.runtime.playwright, '1.64.1');
    assert.match(manifest.runtime.chromium, /^\d+\./u);
    assert.equal(
      manifest.configuration.resolvedConfigHash,
      `sha256:${createHash('sha256')
        .update(await readFile(join(item.outDir, 'resolved-config.json')))
        .digest('hex')}`,
    );
    assert.match(manifest.configuration.personaHash, /^sha256:/u);
    const report = JSON.parse(await readFile(join(item.outDir, 'report.json'), 'utf8'));
    const steps = (await readFile(join(item.outDir, 'steps.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const claim of report.friction) {
      assert.equal(validateClaim(claim, item.runId, steps), null);
      for (const ref of claim.evidence) await stat(join(item.outDir, 'screenshots', `${ref.screenshotId}.png`));
    }
    assert.equal(report.replay.status, 'not_attempted');
    assert.equal(report.usage.accounting, 'estimated');
    assert.match(await readFile(join(item.outDir, 'report.md'), 'utf8'), /trace\.zip is private raw evidence/u);
  }
  const report = JSON.parse(await readFile(join(first.outDir, 'report.json'), 'utf8'));
  assert.deepEqual([report.steps, report.browserActions], [3, 1]);
  assert.deepEqual(
    report.friction.map((claim: any) => claim.kind),
    ['opinion', 'steps_above_minimum'],
  );
  assert.deepEqual(report.friction[1].measurement, {
    actualActions: 1,
    minimumActions: 0,
    excessActions: 1,
    basis: 'observed_success_minimum',
    baselineRunId: second.runId,
  });
  const page = await readFile(join(first.outDir, 'report.html'), 'utf8');
  assert.ok(!page.includes('<b>page'));
  assert.match(page, /&lt;b&gt;page&lt;\/b&gt;/u);
  assert.match(await readFile(join(first.outDir, 'report.md'), 'utf8'), /\\\[x\\\]\(javascript/u);

  const batch = JSON.parse(await readFile(join(json.reportDir, 'report.json'), 'utf8'));
  assert.equal(batch.batchId, json.batchId);
  assert.match((await cli(['report', json.batchId, '--format', 'md'])).out, /Completion rate \| 100% \(2\/2\)/u);
  assert.equal((await cli(['report', first.runId, '--format', 'json'])).json, null);
  assert.equal(JSON.parse((await cli(['report', first.runId, '--format', 'json'])).out).runId, first.runId);
  assert.match((await cli(['report', first.runId, '--format', 'html'])).out, /^<!doctype html>/u);
  for (const bad of ['../../etc', 'run_x', `${first.runId}/..`])
    assert.equal((await cli(['report', bad])).code, 2, bad);

  const opened: string[] = [];
  const openTrace = async (path: string) => opened.push(path) && 0;
  assert.equal((await cli(['trace', first.runId], { openTrace })).code, 0);
  assert.deepEqual(opened, [join(first.outDir, 'trace.zip')]);
  assert.equal((await cli(['trace', json.batchId], { openTrace })).code, 2);

  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  const bundled = await walk(first.outDir);
  const replayed = await cli(['replay', first.runId, '--json']);
  assert.equal(replayed.code, 0, replayed.out);
  assert.equal(replayed.json.replay.status, 'passed');
  const refreshed = JSON.parse(await readFile(join(first.outDir, 'manifest.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(first.outDir, 'report.json'), 'utf8')).replay.status, 'passed');
  assert.deepEqual(
    refreshed.artifacts.map((artifact: { path: string }) => artifact.path).toSorted(),
    (await walk(first.outDir)).filter((path) => path !== 'manifest.json'),
  );
  assert.deepEqual(
    await walk(first.outDir),
    bundled,
    'replay writes nothing into the bundle but its refreshed reports',
  );
  assert.match((await cli(['replay', json.batchId])).out, /takes a run ID/u);
});

test('each repeat gets a fresh browser context; named storage state is loaded', async () => {
  turn = done;
  const visitsBefore = fixture.stateVisits().length;
  const { code } = await lab(['--persona', 'guest', '--url', `${fixture.url}/lab/state?scope=iso`, '--repeats', '2']);
  assert.equal(code, 0);
  const visits = fixture.stateVisits().slice(visitsBefore);
  assert.deepEqual(
    visits.map((visit) => visit.cookie),
    ['', ''],
  );
  assert.equal((await lab(['--suite', 'authed'])).code, 0);
  assert.equal(fixture.stateVisits().at(-1)!.cookie, 'lab_auth=yes');
});

test('preflight prints model, untested status, cost estimate, and batch budget; untested needs confirmation', async () => {
  turn = done;
  const priced = await lab(['--persona', 'guest', '--url', `${fixture.url}/`, '--repeats', '2']);
  assert.equal(priced.code, 0);
  assert.match(
    priced.out,
    /guest x2: openai\/test-model effort low \(model from project, effort from catalog_default\)/u,
  );
  assert.match(priced.out, /untested: no; estimated \$\d+\.\d\d-\$\d+\.\d\d per run/u);
  assert.match(priced.out, /maximum batch budget: \$4\.00/u);

  const runs = await runCount();
  const refused = await lab(['--persona', 'guest', '--url', `${fixture.url}/`, '--model', 'openai/fresh-model']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /untested; confirm explicitly/u);
  assert.equal(await runCount(), runs);
  const confirmed = await lab([
    '--persona',
    'guest',
    '--url',
    `${fixture.url}/`,
    '--model',
    'openai/fresh-model',
    '--allow-untested',
  ]);
  assert.equal(confirmed.code, 0);
  assert.match(confirmed.out, /untested: yes; cost unknown; dollar cap unenforceable/u);
  assert.match(confirmed.out, /maximum batch budget: unenforceable/u);
});

test('a missing provider key or broken named state fails preflight with exit 2 and no runs', async () => {
  const runs = await runCount();
  const missing = await lab(['--persona', 'guest', '--url', `${fixture.url}/`], { env: {}, fake: false });
  assert.equal(missing.code, 2);
  assert.match(missing.out, /provider openai is unavailable; set OPENAI_API_KEY/u);
  const corrupt = await lab(['--suite', 'badstate', '--json']);
  assert.equal(corrupt.code, 2);
  assert.match(corrupt.json.error, /storage state corrupt: invalid JSON/u);
  const badShape = await lab(['--suite', 'badshape', '--json']);
  assert.equal(badShape.code, 2);
  assert.match(badShape.json.error, /storage state badshape\.cookies\[0\]: must be an object/u);
  const cookie = { name: 'a', value: 'b', domain: 'x.test', path: '/' };
  for (const [state, field] of [
    [{ cookies: [{ ...cookie, partitionKey: null }], origins: [] }, 'cookies[0].partitionKey'],
    [
      { cookies: [], origins: [{ origin: 'https://x.test', localStorage: [], indexedDB: null }] },
      'origins[0].indexedDB',
    ],
  ] as const) {
    await put('.lab/auth/badshape.json', JSON.stringify(state));
    const nulled = await lab(['--suite', 'badshape', '--json']);
    assert.equal(nulled.code, 2);
    assert.match(nulled.json.error, new RegExp(`badshape\\.${field.replace(/[.[\]]/gu, '\\$&')}:`, 'u'));
  }
  await put('.lab/auth/badshape.json', '{ "cookies": [null], "origins": [] }');
  assert.equal(await runCount(), runs);
});

test('cancellation interrupts the pending run, skips the remaining repeats, and exits 1', async () => {
  const controller = new AbortController();
  turn = () => {
    setTimeout(() => controller.abort('user'), 50);
    return new Promise<never>(() => {});
  };
  const { code, json } = await lab(['--persona', 'guest', '--url', `${fixture.url}/`, '--repeats', '3', '--json'], {
    signal: controller.signal,
  });
  assert.equal(code, 1);
  assert.equal(json.runs.length, 1);
  assert.deepEqual([json.runs[0].outcome.code, json.runs[0].outcome.interruptedBy], ['interrupted', 'user']);
  assert.equal(json.skipped, 2);
});

test('setup secrets stay out of resolved config and cleanup-failure issues; a failing setup is a setup error', async () => {
  turn = done;
  const { code, json } = await lab(['--suite', 'secret', '--json']);
  assert.equal(code, 0);
  const [item] = json.runs;
  assert.deepEqual(
    item.issues.map((issue: { code: string }) => issue.code),
    ['cleanup_failed'],
  );
  assert.match(item.issues[0].message, /cleanup failed for \{\{email\}\}/u);
  assert.doesNotMatch(JSON.stringify(json), new RegExp(CANARY, 'u'));
  for (const name of ['report.json', 'report.md', 'report.html', 'manifest.json'])
    assert.doesNotMatch(await readFile(join(item.outDir, name), 'utf8'), new RegExp(CANARY, 'u'), name);

  // A run note holding the setup secret reaches persisted task and request fields only as its placeholder.
  const noted = await lab(['--suite', 'secret', '--note', `Sign in as ${CANARY}.`, '--json']);
  const config = await readFile(join(noted.json.runs[0].outDir, 'resolved-config.json'), 'utf8');
  assert.doesNotMatch(config, new RegExp(CANARY, 'u'));
  const persisted = JSON.parse(config);
  assert.equal(persisted.request.note, 'Sign in as {{email}}.');
  assert.match(persisted.task, /Run note: Sign in as \{\{email\}\}\./u);
  assert.match(noted.json.runs[0].outcome.reason, /secret appeared in outbound text/u);

  const broken = await lab(['--suite', 'broken', '--json']);
  assert.equal(broken.code, 1);
  assert.deepEqual(
    [broken.json.runs[0].outcome.code, broken.json.runs[0].outcome.reason],
    ['setup_error', 'setup exploded'],
  );
  const failedReport = JSON.parse(await readFile(join(broken.json.runs[0].outDir, 'report.json'), 'utf8'));
  assert.deepEqual(
    [failedReport.outcome.evidence, failedReport.issues.map((issue: any) => [issue.code, issue.evidenceUnavailable])],
    [[], [['evidence_unavailable', true]]],
  );
  assert.equal(failedReport.replay.status, 'unsupported');
  assert.match(await readFile(join(broken.json.runs[0].outDir, 'report.md'), 'utf8'), /No screenshot evidence/u);
});

test('the OAuth fault page cannot leave the allowlist; the agent reports the blocker', async () => {
  let calls = 0;
  turn = (request) =>
    calls++ === 0
      ? { name: 'goto', args: { url: 'https://accounts.identity.invalid/authorize' } }
      : { name: 'report_blocked', args: { kind: 'oauth', step: lastStepId(request), reason: 'Login provider.' } };
  const { code, json } = await lab(['--persona', 'guest', '--url', `${fixture.url}/lab/oauth`, '--json']);
  assert.equal(code, 1);
  assert.deepEqual([json.runs[0].outcome.state, json.runs[0].outcome.kind], ['blocked', 'oauth']);
});

test('both production adapters drive the same harness against local wire-format servers', async () => {
  const doneArgs = { step: 's0000', summary: 'Done.' };
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          request.url!.includes('/messages')
            ? {
                model: 'test-claude',
                content: [{ type: 'tool_use', id: 't1', name: 'done', input: doneArgs }],
                usage: { input_tokens: 100, output_tokens: 10 },
              }
            : {
                model: 'test-model',
                output: [{ type: 'function_call', call_id: 'c1', name: 'done', arguments: JSON.stringify(doneArgs) }],
                usage: { input_tokens: 100, output_tokens: 10 },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { OPENAI_API_KEY: 'sk-local', ANTHROPIC_API_KEY: 'sk-local' };
  const providers = {
    openai: createOpenAIAdapter({ baseUrl, env }),
    anthropic: createAnthropicAdapter({ baseUrl, env }),
  };
  try {
    for (const qualified of ['openai/test-model', 'anthropic/test-claude']) {
      const { code, json } = await lab(
        ['--persona', 'guest', '--url', `${fixture.url}/`, '--model', qualified, '--json'],
        {
          env,
          providers,
        },
      );
      assert.equal(code, 0, qualified);
      assert.equal(json.runs[0].usage.returnedModel, qualified.split('/')[1]);
    }
  } finally {
    server.close();
  }
});

test('bearer URLs are reduced to origin and path in resolved config', async () => {
  turn = done;
  const { json } = await lab([
    '--persona',
    'guest',
    '--url',
    `${fixture.url}/?token=bearer-canary-777#frag-canary-888`,
    '--json',
  ]);
  const config = await readFile(join(json.runs[0].outDir, 'resolved-config.json'), 'utf8');
  assert.doesNotMatch(config, /bearer-canary|frag-canary/u);
  assert.equal(JSON.parse(config).request.url, `${fixture.url}/`);
});

test('setup errors never echo environment values or provider keys', async () => {
  const env = { OPENAI_API_KEY: 'sk-inline-key-123', LAB_TEST_PASSWORD: 'pw-canary-5151' };
  const { code, out, json } = await lab(['--suite', 'leaky', '--json'], { env });
  assert.equal(code, 1);
  assert.doesNotMatch(out, /pw-canary|sk-inline/u);
  assert.equal(json.runs[0].outcome.reason, 'login failed for [env] with [env]');
  for (const [value, reason] of [
    ['line-one-77\nline-two-88', 'bad [env]'],
    ['42', 'error message withheld: it may contain an environment value'],
  ]) {
    const leak = await lab(['--suite', 'leakyenv', '--json'], { env: { LAB_LEAK: value } });
    assert.equal(leak.json.runs[0].outcome.reason, reason);
  }
});

test('a CLI process with nothing else pending still reports hanging setup, module load, and cleanup', async () => {
  const entry = join(repoRoot, 'src/cli.ts');
  const outcomes = await Promise.all(
    ['hang', 'hangload', 'stuckfail'].map(async (id) => {
      const child = await promisify(execFile)(
        process.execPath,
        [entry, 'run', '--suite', id, '--time-ms', '1000', '--json'],
        {
          cwd: root,
          env: { PATH: process.env.PATH, OPENAI_API_KEY: 'test-key' },
        },
      ).catch((error: { code: number; stdout: string }) => error);
      const { runs } = JSON.parse(child.stdout || '{"runs":[]}');
      return [
        (child as { code?: number }).code ?? 0,
        runs[0]?.outcome.state,
        runs[0]?.issues.map((issue: { code: string }) => issue.code),
      ];
    }),
  );
  assert.deepEqual(outcomes, [
    [1, 'limit_reached', ['evidence_unavailable']],
    [1, 'limit_reached', ['evidence_unavailable']],
    [1, 'agent_error', ['cleanup_timeout', 'evidence_unavailable']],
  ]);
});

test('a hanging setup ends at the time cap and a hanging cleanup is cut off', async () => {
  turn = done;
  let started = Date.now();
  const hung = await lab(['--suite', 'hang', '--time-ms', '1000', '--json']);
  assert.equal(hung.code, 1);
  assert.deepEqual(
    [hung.json.runs[0].outcome.state, hung.json.runs[0].outcome.limit, hung.json.runs[0].outcome.maximum],
    ['limit_reached', 'time', 1000],
  );
  assert.ok(Date.now() - started < 3000);

  started = Date.now();
  const stuck = await lab(['--suite', 'stuckcleanup', '--time-ms', '3000', '--json']);
  assert.equal(stuck.code, 0);
  assert.deepEqual(
    stuck.json.runs[0].issues.map((issue: { code: string }) => issue.code),
    ['cleanup_timeout'],
  );
  assert.ok(Date.now() - started < 6000);
});
