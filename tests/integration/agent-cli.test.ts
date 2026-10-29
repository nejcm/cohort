import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { run } from '../../src/cli.ts';
import { LabDb } from '../../src/dashboard/db.ts';
import { processStart, startBatch, type DetachedBatch } from '../../src/dashboard/runner.ts';
import { startDashboard } from '../../src/dashboard/server.ts';
import { startFixture, type FixtureServer } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const KEY = 'sk-agent-cli-canary-5150';
const SETUP_SECRET = 'setup-secret-canary-6262';
const URL_SECRET = 'url-token-canary-7373';
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;
const MODELS = `version: test
models:
  - id: test-model
    provider: openai
    label: test
    visionCapable: true
    supportedEffortLevels: [low]
    defaultEffort: low
    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 }
    pricingVerifiedAt: 2026-10-01
    untested: false
  - id: unpriced-model
    provider: openai
    label: unpriced
    visionCapable: true
    supportedEffortLevels: [low]
    defaultEffort: low
    pricesPerMTok: { input: null, output: null, cachedInput: null, cacheWrite: null }
    pricingVerifiedAt: null
    untested: false
`;
const persona = (id: string, extra = ''): string =>
  `---\nschemaVersion: 1\nid: ${id}\nname: ${id}\ntags: [agent]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\n${extra}goal: Look around.\n---\n\nYou are a careful first-time visitor.\n`;

let fixture: FixtureServer;
let root: string;
let env: NodeJS.ProcessEnv;
let turn: Turn;
const provider = fakeProvider((request, index) => turn(request, index));
const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });
const workers: Promise<void>[] = [];
const outputs: string[] = [];

// The detached batch runs in this process so the scripted model can serve it; entries still cross a JSON boundary.
async function worker(batch: DetachedBatch) {
  const started = await startBatch(
    { projectRoot: root, providers: { openai: provider }, env },
    JSON.parse(JSON.stringify(batch)) as DetachedBatch,
  );
  workers.push(started.done);
  return { batchId: started.batchId, runIds: started.runIds };
}

async function cli(argv: string[], options: { stdin?: string; cwd?: string } = {}) {
  let out = '';
  const code = await run(argv, (text) => void (out += text), {
    cwd: options.cwd ?? root,
    env,
    providers: { openai: provider } as never,
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    worker,
  });
  // `suite show` echoes the authored file verbatim so edits round-trip; anything a user typed into it is theirs.
  if (!(argv[0] === 'suite' && argv[1] === 'show')) outputs.push(out);
  return { code, out, json: argv.includes('--json') ? (JSON.parse(out) as any) : null };
}

function gate(): { turn: Turn; release: () => void; reached: Promise<void> } {
  let release!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return {
    turn: async (request, index) => {
      reach();
      await opened;
      return done(request, index);
    },
    release,
    reached,
  };
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// Types only, three levels deep: deeper objects belong to the report schema, which carries its own version.
function shape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0], depth + 1)];
  if (typeof value !== 'object') return typeof value;
  if (depth >= 3) return 'object';
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, shape(item, depth + 1)]),
  );
}

function exec(argv: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.once('exit', (code) => resolve({ code, out }));
  });
}

before(async () => {
  fixture = await startFixture();
  root = await mkdtemp(join(tmpdir(), 'lab-agent-'));
  env = { OPENAI_API_KEY: KEY, COHORT_FIXTURE_ORIGIN: fixture.url };
});

after(async () => {
  await Promise.all(workers);
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});

test('an agent drives the whole lifecycle through the CLI with no dashboard process', async (t) => {
  turn = done;
  const shapes: Record<string, unknown> = {};
  const step = async (name: string, argv: string[], stdin?: string) => {
    const result = await cli([...argv, '--json'], stdin === undefined ? {} : { stdin });
    shapes[name] = shape(result.json);
    return result;
  };
  const init = await step('init', ['init']);
  assert.equal(init.code, 0);
  assert.deepEqual((await step('models show', ['models', 'show'])).json.source, null);
  assert.equal((await step('models edit', ['models', 'edit', '--file', '-'], MODELS)).code, 0);
  const config = await cli(['config', 'show', '--json']);
  const nextConfig = 'schemaVersion: 1\nmodel: openai/test-model\nrepeats: 1\nlimits: { steps: 5, timeMs: 30000 }\n';
  const edited = await step(
    'config edit',
    ['config', 'edit', '--revision', config.json.revision, '--file', '-'],
    nextConfig,
  );
  assert.deepEqual([edited.code, edited.json.action], [0, 'saved']);
  assert.equal(await readFile(join(root, '.cohort/config.yml'), 'utf8'), nextConfig);
  assert.equal((await step('doctor', ['doctor'])).json.checks.length > 0, true);
  const shownConfig = await step('config show', ['config', 'show']);
  assert.deepEqual([shownConfig.json.defaults.model, shownConfig.json.source], ['openai/test-model', nextConfig]);
  const models = await step('models list', ['models', 'list']);
  assert.deepEqual(
    models.json.models.map((model: { id: string }) => model.id),
    ['openai/test-model', 'openai/unpriced-model'],
  );
  assert.equal((await step('persona schema', ['persona', 'schema'])).json.schema.type, 'object');
  assert.ok((await step('persona templates', ['persona', 'templates'])).json.templates.length > 0);

  const added = await step('persona add', ['persona', 'add', '--file', '-'], persona('agent-visitor'));
  assert.deepEqual([added.code, added.json.path], [0, '.cohort/personas/agent-visitor.md']);
  const suite = `schemaVersion: 1\nid: agent-suite\nname: Agent suite\ndefaults:\n  url: ${fixture.url}/?token=${URL_SECRET}\nentries:\n  - persona: agent-visitor\n`;
  await writeFile(join(root, 'suite.yml'), suite);
  assert.equal((await step('suite add', ['suite', 'add', '--file', 'suite.yml'])).code, 0);
  const entry = await step('suite add-entry', [
    'suite',
    'add-entry',
    'agent-suite',
    '--persona',
    'agent-visitor',
    '--goal',
    'Find the help page.',
  ]);
  assert.equal(entry.code, 0);
  const shown = await step('suite show', ['suite', 'show', 'agent-suite']);
  assert.equal(shown.json.parsed.entries.length, 2);
  assert.match(shown.json.source, /Find the help page/u);
  assert.ok((await step('persona list', ['persona', 'list'])).json.personas.some((p: any) => p.id === 'agent-visitor'));
  assert.equal((await step('suite list', ['suite', 'list'])).json.suites[0].entries, 2);
  assert.equal((await step('persona show', ['persona', 'show', 'agent-visitor'])).json.error, null);
  assert.equal((await step('persona validate', ['persona', 'validate'])).code, 0);

  const estimate = await step('estimate', ['estimate', '--suite', 'agent-suite']);
  assert.equal(estimate.code, 0);
  assert.deepEqual([estimate.json.plans.length, estimate.json.refusal, estimate.json.maxUsd], [2, null, 10]);
  assert.equal(estimate.json.maxBatchUsd, 4);
  const sent = provider.requests.length;
  const started = await step('run --detach', ['run', '--suite', 'agent-suite', '--detach']);
  assert.equal(started.code, 0, started.out);
  assert.equal(started.json.runIds.length, 2);
  const waited = await step('runs wait', ['runs', 'wait', started.json.batchId, '--timeout-ms', '60000']);
  assert.equal(waited.code, 0, waited.out);
  assert.equal(waited.json.done, true);
  assert.ok(waited.json.runs.every((item: any) => item.outcome === 'completed'));
  assert.equal(provider.requests.length - sent, 2);
  const report = await cli(['report', started.json.batchId, '--json']);
  assert.equal(report.json.batchId, started.json.batchId);
  const runShown = await step('runs show', ['runs', 'show', started.json.runIds[0]]);
  assert.equal(runShown.json.report.outcome.state, 'completed');
  assert.ok(runShown.json.artifacts.some((artifact: any) => artifact.id === 'report.json'));
  const listed = await step('runs list', ['runs', 'list', '--limit', '5', '--sort', 'id', '--asc']);
  assert.deepEqual(
    listed.json.runs.map((item: any) => item.id),
    started.json.runIds.toSorted(),
  );
  const searched = await cli(['runs', 'list', '--search', 'help page', '--json']);
  assert.deepEqual(
    searched.json.runs.map((item: any) => item.goal),
    ['Find the help page.'],
  );
  assert.equal((await step('runs show batch', ['runs', 'show', started.json.batchId])).json.runs.length, 2);
  const trace = await step('trace', ['trace', started.json.runIds[0]]);
  assert.equal(trace.json.path, join(root, '.cohort/runs', started.json.runIds[0], 'trace.zip'));

  const removeSuite = await step('suite remove', ['suite', 'remove', 'agent-suite', '--yes']);
  assert.equal(removeSuite.code, 0);
  assert.equal((await step('persona remove', ['persona', 'remove', 'agent-visitor', '--yes'])).code, 0);
  assert.deepEqual(await readdir(join(root, '.cohort/suites')), []);
  assert.ok(!(await readdir(join(root, '.cohort/personas'))).includes('agent-visitor.md'));

  const failures: Record<string, unknown> = {};
  for (const [name, argv] of Object.entries({
    usage: ['nope'],
    not_found: ['persona', 'show', 'missing'],
    confirmation_required: ['persona', 'remove', 'first-time-host'],
    cap_unenforceable: [
      'run',
      '--persona',
      'first-time-host',
      '--url',
      `${fixture.url}/`,
      '--model',
      'openai/unpriced-model',
    ],
  }))
    failures[name] = shape((await cli([...argv, '--json'])).json);
  t.assert.snapshot({ commands: shapes, errors: failures });
});

test('errors carry stable codes and exit codes, and every problem at once', async () => {
  const cases: [string[], string, number][] = [
    [['nope'], 'usage', 2],
    [['--bogus'], 'usage', 2],
    [['persona', 'show', 'missing'], 'not_found', 2],
    [['report', 'run_20260101_000000_abcdef', '--format', 'md'], 'usage', 2],
    [['config', 'edit', '--file', '-'], 'invalid', 2],
    [['models', 'edit', '--file', '-'], 'invalid', 2],
    [['runs', 'list', '--sort', 'cost; drop'], 'invalid', 2],
    [['persona', 'show', '../x'], 'invalid', 2],
    [['persona', 'add', '--file', 'no-such-file.md'], 'not_found', 2],
    [['persona', 'remove', 'first-time-host'], 'confirmation_required', 2],
    [['runs', 'show', 'run_20260101_000000_abcdef'], 'not_found', 2],
    [['runs', 'cancel', 'batch_20260101_000000_abcdef'], 'not_found', 2],
    [['report', 'run_20260101_000000_abcdef'], 'not_found', 2],
    [['report', 'nope'], 'not_found', 2],
    [['runs', 'list', '--filter', 'everything'], 'invalid', 2],
    [['run', '--persona', 'first-time-host', '--url', `${fixture.url}/`, '--max-usd', '0.5'], 'over_budget', 2],
    [['run', '--persona', 'first-time-host', '--url', `${fixture.url}/`, '--max-usd', 'x'], 'usage', 2],
    [
      ['run', '--persona', 'first-time-host', '--url', `${fixture.url}/`, '--model', 'openai/unpriced-model'],
      'cap_unenforceable',
      2,
    ],
    [['login', '--url', `${fixture.url}/login?code=${URL_SECRET}`, '--state', 'host'], 'blocked', 2],
  ];
  for (const [argv, code, exit] of cases) {
    const result = await cli([...argv, '--json']);
    assert.deepEqual([result.json.code, result.code], [code, exit], argv.join(' '));
    assert.equal(typeof result.json.error, 'string');
    assert.equal(result.json.schemaVersion, 1);
  }
  const blocked = await cli(['login', '--url', `${fixture.url}/login?code=${URL_SECRET}`, '--state', 'host', '--json']);
  assert.equal(blocked.json.command, `cohort login --url '${fixture.url}/login' --state host`);
  const overBudget = await cli([
    'run',
    '--persona',
    'first-time-host',
    '--url',
    `${fixture.url}/`,
    '--max-usd',
    '0.5',
    '--json',
  ]);
  assert.equal(overBudget.json.estimate.maxBatchUsd, 2);
  const bad = persona('bad-one').replace('locale: en-US', 'locale: 7').replace('width: 800', 'width: 1');
  const invalid = await cli(['persona', 'add', '--file', '-', '--json'], { stdin: bad.replace('name: bad-one\n', '') });
  assert.equal(invalid.json.code, 'invalid');
  assert.ok(invalid.json.problems.length >= 3, invalid.out);
  assert.ok(invalid.json.problems.some((problem: string) => problem.includes('.name: required')));
  assert.ok(invalid.json.problems.some((problem: string) => problem.includes('width: below minimum')));
  const text = await cli(['persona', 'remove', 'first-time-host']);
  assert.deepEqual(
    [text.code, text.out],
    [2, 'Error: this deletes .cohort/personas/first-time-host.md; pass --yes to confirm\n'],
  );
});

test('add refuses to overwrite without --force, edits are revision-checked, and suites guard their personas', async () => {
  const path = join(root, '.cohort/personas/keeper.md');
  assert.equal((await cli(['persona', 'add', '--file', '-'], { stdin: persona('keeper') })).code, 0);
  const changed = persona('keeper', 'tags: [changed]\n').replace('tags: [agent]\n', '');
  const refused = await cli(['persona', 'add', '--file', '-', '--json'], { stdin: changed });
  assert.equal(refused.json.code, 'conflict');
  assert.equal(await readFile(path, 'utf8'), persona('keeper'));
  const forced = await cli(['persona', 'add', '--file', '-', '--force', '--json'], { stdin: changed });
  assert.deepEqual([forced.code, forced.json.action], [0, 'replaced']);
  assert.equal(await readFile(path, 'utf8'), changed);
  const stale = await cli(['persona', 'edit', 'keeper', '--file', '-', '--revision', 'sha256:00', '--json'], {
    stdin: persona('keeper'),
  });
  assert.equal(stale.json.code, 'conflict');
  const renamed = await cli(['persona', 'edit', 'keeper', '--file', '-', '--json'], { stdin: persona('other') });
  assert.equal(renamed.json.code, 'invalid');
  assert.equal(await readFile(path, 'utf8'), changed);
  const suite = 'schemaVersion: 1\nid: keeps\nname: Keeps\nentries:\n  - persona: keeper\n';
  assert.equal((await cli(['suite', 'add', '--file', '-'], { stdin: suite })).code, 0);
  const inUse = await cli(['persona', 'remove', 'keeper', '--yes', '--json']);
  assert.deepEqual([inUse.json.code, inUse.json.error], ['conflict', 'persona keeper is used by suite(s) keeps']);
  const dangling = await cli(['suite', 'add', '--file', '-', '--json'], {
    stdin: 'schemaVersion: 1\nid: dangling\nname: D\nentries:\n  - persona: ghost\n  - persona: phantom\n',
  });
  assert.deepEqual(dangling.json.problems, [
    'entries[0]: unknown persona ghost',
    'entries[1]: unknown persona phantom',
  ]);
  const setup = await cli(['suite', 'add', '--file', '-', '--json'], {
    stdin: 'schemaVersion: 1\nid: sneaky\nname: S\ndefaults:\n  setup: ../setup/x.ts\nentries:\n  - persona: keeper\n',
  });
  assert.match(setup.json.error, /cannot reference setup code/u);
  assert.equal((await cli(['suite', 'remove', 'keeps', '--yes'])).code, 0);
  assert.equal((await cli(['persona', 'remove', 'keeper', '--yes'])).code, 0);
});

test('detach, wait, and cancel stay consistent when they race', async () => {
  const blocker = gate();
  turn = blocker.turn;
  const started = await cli([
    'run',
    '--persona',
    'first-time-host',
    '--url',
    `${fixture.url}/`,
    '--repeats',
    '2',
    '--detach',
    '--json',
  ]);
  assert.equal(started.code, 0, started.out);
  const [first, second] = started.json.runIds as string[];
  await blocker.reached;
  const timedOut = await cli(['runs', 'wait', started.json.batchId, '--timeout-ms', '0', '--json']);
  assert.deepEqual([timedOut.code, timedOut.json.code], [1, 'timeout']);
  const queued = await cli(['runs', 'cancel', second!, '--json']);
  assert.deepEqual(queued.json.cancelling, [second]);
  const running = await cli(['runs', 'cancel', started.json.batchId, '--json']);
  assert.ok(running.json.cancelling.includes(first));
  const waits = Promise.all([
    cli(['runs', 'wait', started.json.batchId, '--timeout-ms', '60000', '--json']),
    cli(['runs', 'wait', first!, '--timeout-ms', '60000', '--json']),
  ]);
  setTimeout(blocker.release, 300);
  const [batchWait, runWait] = await waits;
  assert.equal(batchWait.code, 1, 'cancelled runs do not complete');
  const byId = Object.fromEntries(batchWait.json.runs.map((item: any) => [item.id, item]));
  assert.equal(byId[second!].status, 'cancelled');
  assert.deepEqual([byId[first!].status, byId[first!].interruptedBy], ['finished', 'user']);
  assert.equal(runWait.json.report.outcome.interruptedBy, 'user');
  assert.equal(
    (await cli(['report', started.json.batchId, '--format', 'json'])).code,
    0,
    'the batch report exists once wait returns',
  );
  const again = await cli(['runs', 'cancel', first!, '--json']);
  assert.deepEqual([again.code, again.json.code], [2, 'conflict']);
  turn = done;
});

function queuedRow(batchId: string, runId: string, status: 'queued' | 'finished' = 'queued') {
  return {
    id: runId,
    batch_id: batchId,
    entry_index: 0,
    repeat_index: 0,
    persona_id: 'first-time-host',
    goal: 'x',
    mode: 'vision',
    provider: 'openai',
    model: 'test-model',
    effort: 'low',
    catalog_version: 'test',
    catalog_hash: 'sha256:x',
    catalog_entry_json: '{}',
    model_untested: 0,
    status,
    outcome_state: status === 'finished' ? 'completed' : null,
    blocked_kind: null,
    blocked_detected_by: null,
    outcome_code: null,
    interrupted_by: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    duration_ms: null,
    estimated_cost_usd: null,
    cap_enforcement: 'step_time_only',
    artifact_dir: `.cohort/runs/${runId}`,
    report_path: null,
    config_hash: 'sha256:x',
  } as const;
}

test('batches whose owner died or whose PID was reused are finalized by wait, batch report included', async () => {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid!;
  await new Promise((resolve) => child.once('exit', resolve));
  const db = new LabDb(join(root, '.cohort/index.sqlite'));
  db.insertBatch('batch_20260102_000000_dddddd', {}, new Date().toISOString(), { pid, start: null });
  db.insertRun(queuedRow('batch_20260102_000000_dddddd', 'run_20260102_000000_ddddd1'));
  // A live process that is not the recorded owner: what a reused PID looks like (Linux has /proc to tell).
  const reused = processStart(process.pid) === null ? null : { pid: process.pid, start: 'boot:0' };
  if (reused) {
    db.insertBatch('batch_20260102_000000_eeeeee', {}, new Date().toISOString(), reused);
    db.insertRun(queuedRow('batch_20260102_000000_eeeeee', 'run_20260102_000000_eeeee1', 'finished'));
  }
  db.close();
  const waited = await cli(['runs', 'wait', 'batch_20260102_000000_dddddd', '--timeout-ms', '10000', '--json']);
  assert.deepEqual([waited.code, waited.json.done, waited.json.runs[0].status], [1, true, 'interrupted']);
  assert.equal(waited.json.summary.batchId, 'batch_20260102_000000_dddddd');
  assert.equal((await cli(['report', 'batch_20260102_000000_dddddd', '--json'])).code, 0);
  if (reused) {
    const finished = await cli(['runs', 'wait', 'batch_20260102_000000_eeeeee', '--timeout-ms', '10000', '--json']);
    assert.deepEqual([finished.json.done, finished.json.summary?.batchId], [true, 'batch_20260102_000000_eeeeee']);
  }
});

test('runs commands read the index even when the current config is broken', async () => {
  const config = await readFile(join(root, '.cohort/config.yml'), 'utf8');
  await writeFile(join(root, '.cohort/config.yml'), 'schemaVersion: [');
  try {
    assert.equal((await cli(['runs', 'list', '--json'])).code, 0);
    const cancel = await cli(['runs', 'cancel', 'run_20260102_000000_ddddd1', '--json']);
    assert.equal(cancel.json.code, 'conflict');
  } finally {
    await writeFile(join(root, '.cohort/config.yml'), config);
  }
  const elsewhere = await mkdtemp(join(tmpdir(), 'lab-empty-'));
  const outside = await cli(['runs', 'list', '--json'], { cwd: elsewhere });
  assert.equal(outside.json.code, 'not_found');
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(elsewhere, { recursive: true });
});

test('the dashboard cancels and streams runs that a detached process owns', async () => {
  const blocker = gate();
  turn = blocker.turn;
  const dashboard = await startDashboard({ projectRoot: root, env, providers: { openai: provider } as never, port: 0 });
  try {
    const started = await cli([
      'run',
      '--persona',
      'first-time-host',
      '--url',
      `${fixture.url}/`,
      '--detach',
      '--json',
    ]);
    const [runId] = started.json.runIds as string[];
    await blocker.reached;
    const api = (method: string, path: string) =>
      fetch(new URL(path, dashboard.origin), {
        method,
        headers: {
          authorization: `Bearer ${dashboard.token}`,
          ...(method === 'POST' ? { origin: dashboard.origin, 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    const events = await api('GET', `/api/runs/${runId}/events`);
    assert.equal((await api('POST', `/api/runs/${runId}/cancel`)).status, 202);
    setTimeout(blocker.release, 400);
    const text = await events.text();
    assert.match(text, /event: run\.finished/u);
    const detail = (await (await api('GET', `/api/runs/${runId}`)).json()) as any;
    assert.equal(detail.run.interruptedBy, 'user');
  } finally {
    turn = done;
    await Promise.all(workers);
    await dashboard.close();
  }
});

test('separate processes editing the same revision cannot both win', async () => {
  await put('.cohort/personas/shared.md', persona('shared'));
  const revision = (await cli(['persona', 'show', 'shared', '--json'])).json.revision as string;
  const edit = (tag: string) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'persona', 'edit', 'shared', '--revision', revision, '--file', '-'], {
        cwd: root,
        env: {},
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.stdin.end(persona('shared', `tags: [${tag}]\n`).replace('tags: [agent]\n', ''));
      child.once('exit', resolve);
    });
  const codes = await Promise.all(['one', 'two', 'three'].map(edit));
  assert.deepEqual(codes.toSorted(), [0, 2, 2]);
});

test('an edit lock held by a killed process is released at once', async () => {
  await put('.cohort/personas/locked.md', persona('locked'));
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const db = new (require('node:sqlite').DatabaseSync)('.cohort/index.sqlite-edit-lock'); db.exec('BEGIN EXCLUSIVE'); console.log('held'); setInterval(() => {}, 1000);`,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  let settled = false;
  const edit = cli(['persona', 'edit', 'locked', '--file', '-', '--json'], {
    stdin: persona('locked', 'tags: [after]\n').replace('tags: [agent]\n', ''),
  }).finally(() => (settled = true));
  await delay(300);
  assert.equal(settled, false, 'the edit waits for the holder');
  holder.kill('SIGKILL');
  const result = await edit;
  assert.deepEqual([result.code, result.json.action], [0, 'saved']);
});

function startUi(cwd = root) {
  const controller = new AbortController();
  let out = '';
  let ready!: (shown: { origin: string; urlFile: string }) => void;
  const shown = new Promise<{ origin: string; urlFile: string }>((resolve) => (ready = resolve));
  const finished = run(
    ['ui', '--json'],
    (text) => {
      out += text;
      ready(JSON.parse(text));
    },
    { cwd, env, providers: { openai: provider } as never, signal: controller.signal },
  );
  return { shown, finished, stop: () => controller.abort(), output: () => out };
}

const listeners = (): number => process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;

test('JSON output never carries the dashboard token, and each dashboard owns its own URL file', async () => {
  const first = startUi();
  const second = startUi();
  const [one, two] = await Promise.all([first.shown, second.shown]);
  assert.notEqual(one.urlFile, two.urlFile);
  for (const shown of [one, two]) {
    const path = join(root, shown.urlFile);
    assert.ok(readFileSync(path, 'utf8').startsWith(`${shown.origin}/#token=`));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.deepEqual(Object.keys(JSON.parse(first.output())).toSorted(), ['origin', 'pid', 'schemaVersion', 'urlFile']);
  assert.doesNotMatch(first.output() + second.output(), /token/u);
  first.stop();
  assert.equal(await first.finished, 0);
  await assert.rejects(readFile(join(root, one.urlFile)), 'the URL file goes away with its dashboard');
  assert.match(await readFile(join(root, two.urlFile), 'utf8'), /#token=/u, "another dashboard's file stays");
  second.stop();
  assert.equal(await second.finished, 0);
  assert.deepEqual([(await cli(['--json'])).json.usage.length > 0, (await cli(['--help', '--json'])).code], [true, 0]);
});

test('a dashboard whose URL file cannot be written is closed again', async () => {
  const blocked = await mkdtemp(join(tmpdir(), 'lab-ui-'));
  await mkdir(join(blocked, '.cohort'));
  await writeFile(join(blocked, '.cohort/auth'), 'not a directory');
  const open = listeners();
  await assert.rejects(startUi(blocked).finished);
  await delay(10);
  assert.equal(listeners(), open);
  await rm(blocked, { recursive: true });
});

async function withKey(key: string, argv: string[]): Promise<string> {
  let out = '';
  await run([...argv, '--json'], (text) => void (out += text), { cwd: root, env: { OPENAI_API_KEY: key } });
  return out;
}

const loginArgs = (state: string): string[] => ['login', '--url', `${fixture.url}/`, '--state', state];

test('provider keys are redacted from every output, escaped too, without touching field names', async () => {
  assert.ok(!(await withKey(KEY, loginArgs(KEY))).includes(KEY));
  const escaped = 'sk-"quote\\canary-4242';
  const decoded = JSON.parse(await withKey(escaped, loginArgs(escaped)));
  assert.deepEqual(
    [decoded.error, decoded.problems],
    ['invalid storage state name: [env]', ['invalid storage state name: [env]']],
  );
  const version = JSON.parse(await withKey('schemaVersion', ['--version']));
  assert.deepEqual(Object.keys(version).toSorted(), ['schemaVersion', 'version']);
});

test('a real detached process outlives its parent, and no JSON output carries a secret', async () => {
  await put(
    '.cohort/setup/leaky.ts',
    `export default async (ctx) => { throw new Error('setup failed for ${SETUP_SECRET}'); };\n`,
  );
  await put(
    '.cohort/suites/leaky.yml',
    'schemaVersion: 1\nid: leaky\nname: Leaky\ndefaults:\n  setup: ../setup/leaky.ts\nentries:\n  - persona: first-time-host\n',
  );
  let out = '';
  // No injected worker or providers: a background `cohort _worker` process runs the batch with the real adapters.
  const code = await run(['run', '--suite', 'leaky', '--detach', '--json'], (text) => void (out += text), {
    cwd: root,
    env: { ...env, PATH: process.env.PATH },
  });
  outputs.push(out);
  assert.equal(code, 0, out);
  const { batchId } = JSON.parse(out);
  const waited = await cli(['runs', 'wait', batchId, '--timeout-ms', '60000', '--json']);
  assert.equal(waited.code, 1, waited.out);
  assert.equal(waited.json.runs[0].outcome, 'agent_error');
  const leaks = outputs.filter((text) => [KEY, SETUP_SECRET, URL_SECRET].some((secret) => text.includes(secret)));
  assert.deepEqual(leaks, []);
  const index = await readFile(join(root, '.cohort/index.sqlite'));
  assert.ok(![KEY, SETUP_SECRET, URL_SECRET].some((secret) => index.includes(secret)));
});

test('with stdin closed, nothing waits for input', async () => {
  const login = await exec(['login', '--url', `${fixture.url}/`, '--state', 'host']);
  assert.equal(login.code, 2);
  assert.match(login.out, /^Error: cohort login needs a person/mu);
  assert.match(login.out, /^run: cohort login --url /mu);
  const added = await exec(['persona', 'add', '--file', '-', '--json']);
  assert.deepEqual([added.code, JSON.parse(added.out).code], [2, 'invalid']);
  const removed = await exec(['persona', 'remove', 'first-time-host', '--json']);
  assert.deepEqual([removed.code, JSON.parse(removed.out).code], [2, 'confirmation_required']);
});

test('a write killed mid-flight leaves the old file or the new one, never a torn one', async () => {
  const versions = [persona('torn'), persona('torn', 'tags: [rewritten, many, more]\n').replace('tags: [agent]\n', '')];
  await put('.cohort/personas/torn.md', versions[0]!);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const child = spawn(process.execPath, [CLI, 'persona', 'edit', 'torn', '--file', '-'], { cwd: root, env: {} });
    child.stdin.end(versions[(attempt + 1) % 2]);
    setTimeout(() => child.kill('SIGKILL'), 50 + attempt * 40);
    await new Promise((resolve) => child.once('exit', resolve));
    assert.ok(versions.includes(await readFile(join(root, '.cohort/personas/torn.md'), 'utf8')), `attempt ${attempt}`);
  }
  const listed = await cli(['persona', 'list', '--json']);
  assert.ok(listed.json.personas.every((item: any) => item.error === null));
});

test('runs list --since sets where "today" starts for the headline counts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'lab-since-'));
  await mkdir(join(project, '.cohort'));
  const db = new LabDb(join(project, '.cohort/index.sqlite'));
  const batch = 'batch_20260301_000000_ffffff';
  db.insertBatch(batch, {}, '2026-03-01T00:00:00.000Z', { pid: process.pid, start: processStart(process.pid) });
  for (const [index, createdAt] of [
    '2026-03-01T23:30:00.000Z',
    '2026-03-02T00:00:00.000Z',
    '2026-03-02T05:00:00.000Z',
  ].entries())
    db.insertRun({
      ...queuedRow(batch, `run_20260301_000000_fffff${index}`, 'finished'),
      entry_index: index,
      created_at: createdAt,
    });
  db.close();
  const today = async (since: string) =>
    (await cli(['runs', 'list', '--since', since, '--json'], { cwd: project })).json.counts.finishedToday;
  assert.equal(await today('2026-03-02'), 2, 'a date is UTC midnight, inclusive');
  assert.equal(await today('2026-03-01T20:00:00-04:00'), 2, 'an offset is normalized, not compared as text');
  assert.equal(await today('2026-03-01T23:00:00+00:00'), 3);
  const invalid = await cli(['runs', 'list', '--since', 'yesterday', '--json'], { cwd: project });
  assert.deepEqual([invalid.code, invalid.json.code], [2, 'invalid']);
  await rm(project, { recursive: true });
});

test('a short provider key refuses provider commands but never blocks cancelling or reading runs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'lab-short-'));
  await mkdir(join(project, '.cohort'));
  const db = new LabDb(join(project, '.cohort/index.sqlite'));
  const batch = 'batch_20260401_000000_aaaaaa';
  db.insertBatch(batch, {}, new Date().toISOString(), { pid: process.pid, start: processStart(process.pid) });
  db.insertRun(queuedRow(batch, 'run_20260401_000000_aaaaa1'));
  db.close();
  const short = async (argv: string[]) => {
    let out = '';
    const code = await run([...argv, '--json'], (text) => void (out += text), {
      cwd: project,
      env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: 'x' },
    });
    return { code, json: JSON.parse(out) };
  };
  const cancelled = await short(['runs', 'cancel', 'run_20260401_000000_aaaaa1']);
  assert.equal(cancelled.code, 0, JSON.stringify(cancelled.json));
  assert.equal((await short(['runs', 'list'])).code, 0);
  assert.equal((await short(['--version'])).json.version.length > 0, true);
  const refused = await short(['run', '--persona', 'first-time-host', '--url', `${fixture.url}/`]);
  assert.deepEqual(
    [refused.code, refused.json.code, refused.json.problems],
    [2, 'invalid', ['ANTHROPIC_API_KEY is shorter than 8 characters']],
  );
  await rm(project, { recursive: true });
});
