import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { run } from '../../src/cli.ts';
import { LabDb } from '../../src/dashboard/db.ts';
import { saveEditable, type EditError } from '../../src/dashboard/files.ts';
import { CSP, startDashboard, type Dashboard } from '../../src/dashboard/server.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const KEY = 'sk-dashboard-canary-7731';
const ENV = { FAKE_API_KEY: KEY, OPENAI_API_KEY: KEY };
let fixture: FixtureServer;
let root: string;
let assets: string;
let turn: Turn;
const provider = fakeProvider((request, index) => turn(request, index));
const providers = { openai: provider, anthropic: { ...provider, id: 'anthropic', available: () => false } };
const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });
let dashboard: Dashboard;
const seen: string[] = [];

const PERSONA = (id: string, extra = ''): string =>
  `---\nschemaVersion: 1\nid: ${id}\nname: ${id}\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\n${extra}goal: Look around.\n---\n\nYou are a guest.\n`;
const model = (id: string, extra: string, owner = 'openai'): string =>
  `  - id: ${id}\n    provider: ${owner}\n    label: ${id}\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    ${extra}\n`;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => Record<string, any>;
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; auth?: boolean; target?: Dashboard } = {},
): Promise<Reply> {
  const target = options.target ?? dashboard;
  const url = new URL(path, target.origin);
  const mutation = method !== 'GET';
  const headers: Record<string, string> = {
    ...(options.auth === false ? {} : { authorization: `Bearer ${target.token}` }),
    ...(mutation ? { origin: target.origin, 'content-type': 'application/json' } : {}),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        seen.push(text, JSON.stringify(response.headers));
        resolve({ status: response.statusCode!, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

const submit = (submission: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/runs', { body: { submission, ...extra } });
const guestRun = (repeats = 1) =>
  submit({ selector: { kind: 'persona', id: 'guest' }, url: `${fixture.url}/`, repeats });

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

before(async () => {
  fixture = await startFixture();
  root = await mkdtemp(join(tmpdir(), 'lab-dashboard-'));
  assets = await mkdtemp(join(tmpdir(), 'lab-assets-'));
  await writeFile(
    join(assets, 'index.html'),
    '<!doctype html><title>lab</title><script type="module" src="/app.js"></script>',
  );
  await writeFile(join(assets, 'app.js'), 'export {};\n');
  await put(
    '.cohort/config.yml',
    'schemaVersion: 1\nmodel: openai/test-model\nrepeats: 1\nlimits: { steps: 5, timeMs: 30000 }\n',
  );
  await put(
    '.cohort/models.yml',
    `version: test\nmodels:\n${[
      model(
        'test-model',
        'visionCapable: true\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false',
      ),
      model(
        'unpriced-model',
        'visionCapable: true\n    pricesPerMTok: { input: null, output: null, cachedInput: null }\n    pricingVerifiedAt: null\n    untested: false',
      ),
      model(
        'fresh-model',
        'visionCapable: true\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: true',
      ),
      model(
        'blind-model',
        'visionCapable: false\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false',
      ),
      model(
        'test-claude',
        'visionCapable: true\n    pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false',
        'anthropic',
      ),
    ].join('')}`,
  );
  await put('.cohort/personas/guest.md', PERSONA('guest'));
  await put('.cohort/setup/fixture.ts', 'export default async (ctx) => ({ startUrl: ctx.env("X") });\n');
  await put('.cohort/personas/scripted.md', PERSONA('scripted', 'setup: ../setup/fixture.ts\n'));
  await put(
    '.cohort/suites/smoke.yml',
    'schemaVersion: 1\nid: smoke\nname: Smoke\n# keep this comment\nentries:\n  - persona: guest\n',
  );
  turn = done;
  // A run finished by the CLI before the dashboard starts must show up in its index.
  assert.equal(
    await run(['run', '--persona', 'guest', '--url', `${fixture.url}/`, '--json'], () => {}, {
      cwd: root,
      env: ENV,
      providers: providers as never,
    }),
    0,
  );
  dashboard = await startDashboard({ projectRoot: root, env: ENV, providers: providers as never, assetsDir: assets });
});

after(async () => {
  await dashboard.close();
  await fixture.close();
  const leaks: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name !== 'trace.zip' && (await readFile(path)).includes(KEY)) leaks.push(path);
    }
  }
  await scan(join(root, '.cohort'));
  await rm(root, { recursive: true, force: true });
  await rm(assets, { recursive: true, force: true });
  assert.deepEqual(leaks, [], 'no key in the database, events, or artifacts');
  assert.ok(!seen.some((text) => text.includes(KEY)), 'no key in any API or SSE response');
});

test('the database migrates once, enforces foreign keys, and indexes CLI runs', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'lab-db-')), 'lab.db');
  const db = new LabDb(path);
  assert.equal(db.schemaVersion, 1);
  db.close();
  const reopened = new LabDb(path);
  assert.equal(reopened.schemaVersion, 1);
  assert.throws(() => reopened.appendEvent('run_missing', 'run.queued', {}), /FOREIGN KEY/u);
  reopened.close();
  const { runs } = (await call('GET', '/api/runs')).json();
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].personaId, runs[0].status, runs[0].outcome], ['guest', 'finished', 'completed']);
});

test('every API route requires the bearer token; static assets carry the CSP', async () => {
  assert.equal((await call('GET', '/api/runs', { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/runs', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call('GET', `/api/runs?token=${dashboard.token}`, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/runs', { auth: false, body: {} })).status, 401);
  const page = await call('GET', '/', { auth: false });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(
    (await call('GET', '/app.js', { auth: false })).headers['content-type'],
    'text/javascript; charset=utf-8',
  );
  assert.match(
    (await call('GET', '/../config.yml', { auth: false })).headers['content-type'] as string,
    /^text\/html/u,
  );
  assert.equal((await call('GET', '/missing.js', { auth: false })).status, 404);
  const route = await call('GET', '/runs/abc', { auth: false });
  assert.equal(route.status, 200);
  assert.match(route.headers['content-type'] as string, /^text\/html/u);
  assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{43}$/u);
});

test('cross-origin requests and DNS-rebinding Host headers are refused', async () => {
  const port = new URL(dashboard.origin).port;
  const evil = { origin: 'http://evil.example' };
  assert.equal((await call('POST', '/api/runs', { body: {}, headers: evil })).status, 403);
  assert.equal((await call('GET', '/api/runs', { headers: evil })).status, 403);
  assert.equal(
    (await call('POST', '/api/runs', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403,
  );
  const noOrigin = await new Promise<number>((resolve) => {
    const req = httpRequest(new URL('/api/runs', dashboard.origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${dashboard.token}`, 'content-type': 'application/json' },
    });
    req.on('response', (response) => resolve(response.statusCode!));
    req.end('{}');
  });
  assert.equal(noOrigin, 403);
  assert.equal((await call('POST', '/api/runs', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('GET', '/api/runs', { headers: { host: `rebind.example:${port}` } })).status, 421);
  assert.equal((await call('GET', '/', { auth: false, headers: { host: `rebind.example:${port}` } })).status, 421);
  assert.equal((await call('GET', '/api/runs', { headers: { host: '127.0.0.1:1' } })).status, 421);
  assert.equal(
    (await call('GET', '/api/runs', { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } }))
      .status,
    200,
  );
  const options = await call('OPTIONS', '/api/runs', { headers: { origin: 'http://evil.example' } });
  assert.equal(options.headers['access-control-allow-origin'], undefined);
});

test('models hide unavailable providers and expose capability, price, and untested flags without keys', async () => {
  const body = (await call('GET', '/api/models')).json();
  assert.deepEqual(body.providers, [
    { id: 'openai', available: true },
    { id: 'anthropic', available: false },
  ]);
  const ids = body.models.map((entry: { id: string }) => entry.id);
  assert.ok(ids.includes('openai/test-model'));
  assert.ok(!ids.some((id: string) => id.startsWith('anthropic/')));
  const byId = Object.fromEntries(body.models.map((entry: { id: string }) => [entry.id, entry]));
  assert.equal(byId['openai/blind-model'].visionCapable, false);
  assert.equal(byId['openai/fresh-model'].untested, true);
  assert.equal(byId['openai/unpriced-model'].pricesPerMTok.input, null);
  assert.match(body.catalog.hash, /^sha256:/u);
  const config = (await call('GET', '/api/config')).json();
  assert.deepEqual(config.providers, { openai: true, anthropic: false });
  assert.equal(config.defaults.model, 'openai/test-model');
});

test('run previews resolve pickers server-side with estimate or unknown-cost ranges', async () => {
  const base = { selector: { kind: 'persona', id: 'guest' }, url: `${fixture.url}/` };
  const priced = (await submit(base, { preview: true })).json();
  assert.equal(priced.plans[0].model, 'test-model');
  assert.equal(priced.plans[0].modelFrom, 'project');
  assert.ok(priced.plans[0].estimatePerRun.minUsd > 0);
  assert.equal(priced.plans[0].estimatePerRun.basis, 'unmeasured');
  for (const limits of [{ steps: 1 }, { steps: 1, dollars: 0.001 }, { steps: 40 }]) {
    const { minUsd, maxUsd } = (await submit({ ...base, limits }, { preview: true })).json().plans[0].estimatePerRun;
    assert.ok(minUsd <= maxUsd, `${JSON.stringify(limits)}: ${minUsd} <= ${maxUsd}`);
  }
  assert.ok(typeof priced.maxBatchUsd === 'number');
  const unpriced = (await submit({ ...base, model: 'openai/unpriced-model' }, { preview: true })).json();
  assert.deepEqual(
    [unpriced.plans[0].estimatePerRun, unpriced.maxBatchUsd, unpriced.plans[0].modelFrom],
    [null, null, 'run'],
  );
  assert.match(
    (await submit({ ...base, model: 'openai/blind-model' }, { preview: true })).json().error,
    /not vision-capable/u,
  );
  assert.equal(
    (await submit({ ...base, model: 'openai/fresh-model' }, { preview: true })).json().plans[0].untested,
    true,
  );
  assert.match((await submit({ ...base, model: 'openai/fresh-model' })).json().error, /untested/u);
  assert.match(
    (await submit({ ...base, model: 'anthropic/test-claude' }, { preview: true })).json().error,
    /unavailable/u,
  );
  assert.match((await submit({ ...base, provider: 'openai' })).json().error, /resolved server-side/u);
  assert.equal((await call('GET', '/api/runs')).json().runs.length, 1, 'previews enqueue nothing');
});

test('dispatch indexes queued runs, streams persisted events, and supports reconnect', async () => {
  const blocker = gate();
  turn = blocker.turn;
  const accepted = await guestRun();
  assert.equal(accepted.status, 202, accepted.text);
  const [runId] = accepted.json().runIds as string[];
  await blocker.reached;
  const live: string[] = [];
  const stream = new Promise<string>((resolve) => {
    const req = httpRequest(new URL(`/api/runs/${runId}/events`, dashboard.origin), {
      headers: { authorization: `Bearer ${dashboard.token}` },
    });
    req.on('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        live.push(chunk);
      });
      response.on('end', () => resolve(text));
    });
    req.end();
  });
  const running = (await call('GET', `/api/runs/${runId}`)).json();
  assert.equal(running.run.status, 'running');
  assert.equal(running.report, null);
  blocker.release();
  const text = await stream;
  seen.push(text);
  const types = [...text.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(types.slice(0, 3), ['run.queued', 'run.started', 'observation.created']);
  assert.ok(types.includes('step.started') && types.includes('step.completed') && types.includes('usage.updated'));
  assert.equal(types.at(-1), 'run.finished');
  const ids = [...text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
  assert.deepEqual(
    ids,
    ids.map((_, index) => index + 1),
  );
  assert.ok(live.length > 1, 'events arrived while the run was active');

  const resumed = await call('GET', `/api/runs/${runId}/events`, { headers: { 'last-event-id': '3' } });
  assert.deepEqual([...resumed.text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))[0], 4);
  assert.equal((await call('GET', `/api/runs/${runId}/events`, { headers: { 'last-event-id': 'x' } })).status, 400);
  const detail = (await call('GET', `/api/runs/${runId}`)).json();
  assert.deepEqual(
    [detail.run.status, detail.run.outcome, detail.report.outcome.state],
    ['finished', 'completed', 'completed'],
  );
  assert.equal(detail.lastEventId, ids.at(-1));
  assert.equal(detail.run.costUsd, detail.report.usage.estimatedCostUsd);
  const batch = (await call('GET', `/api/batches/${accepted.json().batchId}`)).json();
  assert.deepEqual(
    batch.runs.map((item: { id: string }) => item.id),
    [runId],
  );
  assert.equal(batch.summary.batchId, accepted.json().batchId);
});

test('artifacts are served only by manifest ID, traces as authenticated attachments', async () => {
  const [latest] = (await call('GET', '/api/runs?limit=1')).json().runs;
  const detail = (await call('GET', `/api/runs/${latest.id}`)).json();
  const ids = detail.artifacts.map((artifact: { id: string }) => artifact.id);
  assert.ok(ids.includes('trace.zip') && ids.includes('report.json'));
  const artifact = (id: string, auth = true) =>
    call('GET', `/api/runs/${latest.id}/artifacts/${encodeURIComponent(id)}`, { auth });
  const trace = await artifact('trace.zip');
  assert.equal(trace.status, 200);
  assert.equal(trace.headers['content-disposition'], 'attachment; filename="trace.zip"');
  assert.match(String(trace.headers['content-security-policy']), /sandbox/u);
  assert.equal((await artifact('trace.zip', false)).status, 401);
  const html = await artifact('report.html');
  assert.equal(html.headers['content-disposition'], 'attachment; filename="report.html"');
  assert.equal((await artifact('report.json')).json().runId, latest.id);
  for (const forged of ['../../config.yml', '/etc/passwd', 'manifest.json', '../run_x/report.json'])
    assert.equal((await artifact(forged)).status, 404, forged);
  const [shot] = detail.screenshots as string[];
  const image = await call('GET', `/api/runs/${latest.id}/screenshots/${shot}`);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal((await call('GET', `/api/runs/${latest.id}/screenshots/..%2F..%2Fconfig`)).status, 404);
  assert.equal((await call('GET', '/api/runs/run_20260101_000000_abcdef')).status, 404);
  const page = (await call('GET', '/api/runs?limit=1')).json();
  assert.ok(page.nextCursor);
  const next = (await call('GET', `/api/runs?limit=1&cursor=${page.nextCursor}`)).json();
  assert.notEqual(next.runs[0].id, latest.id);
});

test('queued and active runs cancel; finished runs cannot; the queue is bounded', async () => {
  const blocker = gate();
  turn = blocker.turn;
  const first = (await guestRun()).json().runIds[0] as string;
  const second = (await guestRun()).json().runIds[0] as string;
  await blocker.reached;
  assert.equal((await call('POST', `/api/runs/${second}/cancel`, { body: {} })).status, 202);
  assert.equal((await call('GET', `/api/runs/${second}`)).json().run.status, 'cancelled');
  const overflow: number[] = [];
  for (let index = 0; index < 6; index += 1) overflow.push((await guestRun(20)).status);
  assert.deepEqual(overflow, [202, 202, 202, 202, 202, 429]);
  for (const item of (await call('GET', '/api/runs?limit=100')).json().runs)
    if (item.status === 'queued') await call('POST', `/api/runs/${item.id}/cancel`, { body: {} });
  assert.equal((await call('POST', `/api/runs/${first}/cancel`, { body: {} })).status, 202);
  blocker.release();
  await dashboard.queue.idle();
  const cancelled = (await call('GET', `/api/runs/${first}`)).json();
  assert.equal(cancelled.run.status, 'finished');
  assert.deepEqual([cancelled.report.outcome.code, cancelled.report.outcome.interruptedBy], ['interrupted', 'user']);
  assert.equal((await call('POST', `/api/runs/${first}/cancel`, { body: {} })).status, 409);
  const events = await call('GET', `/api/runs/${second}/events`);
  assert.deepEqual(
    [...events.text.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]),
    ['run.queued', 'run.finished'],
  );
  turn = done;
});

test('file edits use revisions, refuse setup changes, and never overwrite external edits', async () => {
  const read = (await call('GET', '/api/personas/guest')).json();
  assert.match(read.revision, /^sha256:/u);
  const edited = read.source.replace('Look around.', 'Find the menu.');
  await writeFile(join(root, '.cohort/personas/guest.md'), read.source.replace('You are a guest.', 'Edited outside.'));
  const stale = await call('PUT', '/api/personas/guest', { body: { source: edited, revision: read.revision } });
  assert.equal(stale.status, 409);
  assert.match(await readFile(join(root, '.cohort/personas/guest.md'), 'utf8'), /Edited outside/u);
  const fresh = (await call('GET', '/api/personas/guest')).json();
  const saved = await call('PUT', '/api/personas/guest', {
    body: { source: fresh.source.replace('Look around.', 'Find the menu.'), revision: fresh.revision },
  });
  assert.equal(saved.status, 200, saved.text);
  const current = saved.json();
  const withSetup = current.source.replace('goal:', 'setup: ../setup/fixture.ts\ngoal:');
  assert.match(
    (await call('PUT', '/api/personas/guest', { body: { source: withSetup, revision: current.revision } })).json()
      .error,
    /read-only/u,
  );
  const scripted = (await call('GET', '/api/personas/scripted')).json();
  assert.equal(scripted.parsed.setup, '../setup/fixture.ts');
  const kept = await call('PUT', '/api/personas/scripted', {
    body: { source: scripted.source.replace('Look around.', 'Browse.'), revision: scripted.revision },
  });
  assert.equal(kept.status, 200, kept.text);
  const dropped = kept.json().source.replace('setup: ../setup/fixture.ts\n', '');
  assert.equal(
    (await call('PUT', '/api/personas/scripted', { body: { source: dropped, revision: kept.json().revision } })).status,
    400,
  );
  assert.equal(
    (await call('PUT', '/api/personas/guest', { body: { source: PERSONA('other'), revision: current.revision } }))
      .status,
    400,
  );
  assert.equal((await call('GET', '/api/personas/..%2Fconfig')).status, 400);

  assert.equal((await call('POST', '/api/personas', { body: { source: PERSONA('newcomer') } })).status, 201);
  assert.equal((await call('POST', '/api/personas', { body: { source: PERSONA('newcomer') } })).status, 409);
  assert.equal(
    (await call('POST', '/api/personas', { body: { source: PERSONA('rigged', 'setup: ../setup/fixture.ts\n') } }))
      .status,
    400,
  );
  assert.equal((await call('POST', '/api/personas', { body: { source: 'nope' } })).status, 400);
  const list = (await call('GET', '/api/personas')).json().personas.map((item: { id: string }) => item.id);
  assert.deepEqual(list, ['guest', 'newcomer', 'scripted']);

  const suite = (await call('GET', '/api/suites/smoke')).json();
  const rigged = suite.source.replace('entries:', 'defaults:\n  setup: ../setup/fixture.ts\nentries:');
  assert.match(
    (await call('PUT', '/api/suites/smoke', { body: { source: rigged, revision: suite.revision } })).json().error,
    /read-only/u,
  );
  const unknown = suite.source.replace('persona: guest', 'persona: ghost');
  assert.match(
    (await call('PUT', '/api/suites/smoke', { body: { source: unknown, revision: suite.revision } })).json().error,
    /unknown persona ghost/u,
  );
  const entry = { persona: 'newcomer', goal: 'Book a table.', note: 'From an ad-hoc run.' };
  const appended = await call('POST', '/api/suites/smoke/entries', { body: { entry, revision: suite.revision } });
  assert.equal(appended.status, 200, appended.text);
  const yaml = await readFile(join(root, '.cohort/suites/smoke.yml'), 'utf8');
  assert.match(yaml, /# keep this comment/u);
  assert.equal(appended.json().parsed.entries.length, 2);
  assert.equal(
    (await call('POST', '/api/suites/smoke/entries', { body: { entry, revision: suite.revision } })).status,
    409,
  );
  assert.equal(
    (
      await call('POST', '/api/suites/smoke/entries', {
        body: { entry: { persona: 'ghost' }, revision: appended.json().revision },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('POST', '/api/suites/smoke/entries', {
        body: { entry: { persona: 'guest', setup: 'x' }, revision: appended.json().revision },
      })
    ).status,
    400,
  );
  assert.deepEqual((await call('GET', '/api/suites')).json().suites, [
    { id: 'smoke', name: 'Smoke', entries: 2, error: null },
  ]);
});

test('tag and suite dispatch go through the same resolution as the CLI', async () => {
  const tag = await submit({ selector: { kind: 'tag', tag: 'guest' }, url: `${fixture.url}/` }, { preview: true });
  assert.deepEqual(
    tag.json().plans.map((plan: { personaId: string }) => plan.personaId),
    ['guest', 'newcomer', 'scripted'],
  );
  const suite = (
    await submit({ selector: { kind: 'suite', id: 'smoke' }, url: `${fixture.url}/` }, { preview: true })
  ).json();
  assert.equal(suite.plans.length, 2);
  const adhoc = await submit(
    { selector: { kind: 'adhoc' }, url: `${fixture.url}/`, note: 'Find the menu.' },
    { preview: true },
  );
  assert.equal(adhoc.json().plans[0].personaId, 'adhoc-first-time-user');
  assert.match(
    (await submit({ selector: { kind: 'tag', tag: 'nobody' } }, { preview: true })).json().error,
    /known tags/u,
  );
  assert.match(
    (await call('POST', '/api/personas/generate', { body: { url: fixture.url, description: 'x' } })).json().error,
    /explicit cap/u,
  );
});

test('a forged manifest cannot reach files outside the bundle, directly or through a symlinked directory', async () => {
  turn = done;
  const latest = { id: (await guestRun()).json().runIds[0] as string };
  await dashboard.queue.idle();
  const dir = join(root, '.cohort/runs', latest.id);
  const outside = await mkdtemp(join(tmpdir(), 'lab-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside-canary-5512');
  await symlink(outside, join(dir, 'linked'));
  const original = await readFile(join(dir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(original);
  const forged = ['../../config.yml', 'linked/secret.txt', '/etc/hostname'];
  manifest.artifacts.push(
    ...forged.map((path) => ({ path, mediaType: 'text/plain', bytes: 1, sensitivity: 'normal' })),
  );
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  try {
    for (const path of forged) {
      const reply = await call('GET', `/api/runs/${latest.id}/artifacts/${encodeURIComponent(path)}`);
      assert.equal(reply.status, 404, path);
      assert.ok(!reply.text.includes('outside-canary') && !reply.text.includes('schemaVersion'), path);
    }
  } finally {
    await writeFile(join(dir, 'manifest.json'), original);
    await rm(join(dir, 'linked'));
    await rm(outside, { recursive: true, force: true });
  }
});

test('events stored after run.finished do not break a replayed stream', async () => {
  turn = done;
  const runId = (await guestRun()).json().runIds[0] as string;
  await dashboard.queue.idle();
  const side = new LabDb(join(root, '.cohort/index.sqlite'));
  side.appendEvent(runId, 'friction.created', { runId, late: true });
  side.close();
  const replay = await call('GET', `/api/runs/${runId}/events`);
  const types = [...replay.text.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]);
  assert.equal(types.at(-1), 'run.finished');
  assert.equal((await call('GET', '/api/runs?limit=1')).status, 200, 'the server survived');
});

test("the queue bound counts the active batch's waiting repetitions", async () => {
  const blocker = gate();
  turn = blocker.turn;
  assert.equal((await guestRun(20)).status, 202);
  await blocker.reached;
  for (let index = 0; index < 4; index += 1) assert.equal((await guestRun(20)).status, 202);
  assert.equal(dashboard.queue.queuedRuns, 99);
  assert.equal((await guestRun(2)).status, 429);
  for (const item of (await call('GET', '/api/runs?limit=200')).json().runs)
    if (item.status === 'queued' || item.status === 'running')
      await call('POST', `/api/runs/${item.id}/cancel`, { body: {} });
  blocker.release();
  await dashboard.queue.idle();
  turn = done;
});

test('concurrent saves from one revision let exactly one win', async () => {
  const current = (await call('GET', '/api/personas/guest')).json();
  // Started in one tick, so without serialization every save reads the file before any writes it.
  const saves = Array.from({ length: 8 }, (_, index) =>
    saveEditable(root, 'personas', 'guest', `${current.source}Writer ${index}.\n`, current.revision),
  );
  const results = await Promise.allSettled(saves);
  const won = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  assert.equal(won.length, 1);
  assert.ok(results.every((result) => result.status === 'fulfilled' || (result.reason as EditError).status === 409));
  assert.equal(await readFile(join(root, '.cohort/personas/guest.md'), 'utf8'), won[0]!.source);
});

test('batch snapshots keep no URL query or fragment credentials', async () => {
  turn = done;
  const accepted = await submit({
    selector: { kind: 'persona', id: 'guest' },
    url: `${fixture.url}/?token=query-canary-3141#key=fragment-canary-2718`,
  });
  assert.equal(accepted.status, 202, accepted.text);
  await dashboard.queue.idle();
  const { batchId } = accepted.json();
  const batch = await call('GET', `/api/batches/${batchId}`);
  const side = new LabDb(join(root, '.cohort/index.sqlite'));
  const stored = side.batch(batchId)!.request_json;
  side.close();
  for (const text of [batch.text, stored]) assert.ok(!/query-canary|fragment-canary/u.test(text), text);
});

const orphan = (id: string, status: 'queued' | 'running', entry: number) => ({
  id,
  batch_id: 'batch_20260101_000000_aaaaaa',
  entry_index: entry,
  repeat_index: 0,
  persona_id: 'guest',
  goal: 'Look around.',
  mode: 'vision',
  provider: 'openai',
  model: 'test-model',
  effort: 'low',
  catalog_version: 'test',
  catalog_hash: 'sha256:x',
  catalog_entry_json: JSON.stringify({ id: 'test-model', untested: false, pricingVerifiedAt: null }),
  model_untested: 0,
  status,
  outcome_state: null,
  blocked_kind: null,
  blocked_detected_by: null,
  outcome_code: null,
  interrupted_by: null,
  created_at: '2026-01-01T00:00:00.000Z',
  started_at: status === 'running' ? '2026-01-01T00:00:01.000Z' : null,
  finished_at: null,
  duration_ms: null,
  estimated_cost_usd: null,
  cap_enforcement: 'priced_reservations',
  artifact_dir: `.cohort/runs/${id}`,
  report_path: null,
  config_hash: 'sha256:y',
});

test('a restart marks orphaned runs interrupted with a bounded report and never resumes them', async () => {
  const restartRoot = await mkdtemp(join(tmpdir(), 'lab-restart-'));
  await mkdir(join(restartRoot, '.cohort'), { recursive: true });
  await writeFile(join(restartRoot, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/test-model\n');
  const db = new LabDb(join(restartRoot, '.cohort/index.sqlite'));
  db.insertBatch('batch_20260101_000000_aaaaaa', {});
  const calls = provider.requests.length;
  db.insertRun(orphan('run_20260101_000000_aaaaa1', 'running', 0));
  db.insertRun(orphan('run_20260101_000000_aaaaa2', 'queued', 1));
  db.close();
  const restarted = await startDashboard({
    projectRoot: restartRoot,
    env: ENV,
    providers: providers as never,
    assetsDir: assets,
  });
  try {
    const active = (await call('GET', '/api/runs/run_20260101_000000_aaaaa1', { target: restarted })).json();
    assert.deepEqual([active.run.status, active.run.outcome, active.run.costUsd], ['interrupted', 'agent_error', null]);
    assert.deepEqual([active.report.outcome.code, active.report.outcome.interruptedBy], ['interrupted', 'process']);
    assert.equal(active.report.usage.accounting, 'unknown');
    assert.ok(active.artifacts.some((artifact: { id: string }) => artifact.id === 'report.json'));
    const queued = (await call('GET', '/api/runs/run_20260101_000000_aaaaa2', { target: restarted })).json();
    assert.deepEqual([queued.run.status, queued.report], ['interrupted', null]);
    assert.equal(provider.requests.length, calls, 'nothing resumed');
    assert.equal(restarted.queue.queuedRuns, 0);
  } finally {
    await restarted.close();
    await rm(restartRoot, { recursive: true, force: true });
  }
});

test('recovery repairs a missing manifest and never writes through a symlinked run directory', async () => {
  const restartRoot = await mkdtemp(join(tmpdir(), 'lab-repair-'));
  const outside = await mkdtemp(join(tmpdir(), 'lab-outside-'));
  const [latest] = (await call('GET', '/api/runs?limit=1')).json().runs;
  const partial = 'run_20260101_000000_bbbbb1';
  const linked = 'run_20260101_000000_bbbbb2';
  const report = JSON.parse(await readFile(join(root, '.cohort/runs', latest.id, 'report.json'), 'utf8'));
  await mkdir(join(restartRoot, '.cohort/runs', partial), { recursive: true });
  await writeFile(
    join(restartRoot, '.cohort/runs', partial, 'report.json'),
    JSON.stringify({ ...report, runId: partial, batchId: 'batch_20260101_000000_aaaaaa' }),
  );
  await symlink(outside, join(restartRoot, '.cohort/runs', linked));
  await writeFile(join(restartRoot, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/test-model\n');
  const db = new LabDb(join(restartRoot, '.cohort/index.sqlite'));
  db.insertBatch('batch_20260101_000000_aaaaaa', {});
  db.insertRun(orphan(partial, 'running', 0));
  db.insertRun(orphan(linked, 'running', 1));
  db.close();
  const restarted = await startDashboard({
    projectRoot: restartRoot,
    env: ENV,
    providers: providers as never,
    assetsDir: assets,
  });
  try {
    const repaired = (await call('GET', `/api/runs/${partial}`, { target: restarted })).json();
    assert.equal(repaired.run.status, 'finished');
    assert.ok(repaired.artifacts.some((artifact: { id: string }) => artifact.id === 'report.json'));
    const redirected = (await call('GET', `/api/runs/${linked}`, { target: restarted })).json();
    assert.deepEqual([redirected.run.status, redirected.run.outcome], ['interrupted', 'agent_error']);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await restarted.close();
    await rm(restartRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('cohort ui binds loopback by default and warns before an explicit host override', async () => {
  const start = async (args: string[]): Promise<string> => {
    const controller = new AbortController();
    let out = '';
    const finished = run(
      ['ui', ...args],
      (chunk) => {
        out += chunk;
        if (chunk.startsWith('dashboard:')) controller.abort();
      },
      { cwd: root, env: ENV, providers: providers as never, signal: controller.signal },
    );
    assert.equal(await finished, 0);
    return out;
  };
  const local = await start([]);
  assert.match(local, /^dashboard: http:\/\/127\.0\.0\.1:\d+\/#token=/u);
  assert.doesNotMatch(local, /warning/u);
  const exposed = await start(['--host', '0.0.0.0']);
  assert.match(
    exposed,
    /^warning: listening on 0\.0\.0\.0 over plain HTTP\. This service holds your LLM provider keys and launches browsers/u,
  );
  assert.ok(!local.includes(KEY) && !exposed.includes(KEY));
  assert.equal(await run(['ui', '--port', 'x'], () => {}, { cwd: root }), 2);
});
