import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { runOnce } from '../../src/core/engine.ts';
import { SecretStore } from '../../src/setup/secrets.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, pointOf } from '../helpers/fake-provider.ts';
import { zipEntry } from '../helpers/zip.ts';
import type { Page } from 'playwright';

const repoRoot = new URL('../..', import.meta.url).pathname;
let fixture: FixtureServer;
let dir: string;

before(async () => {
  fixture = await startFixture();
  dir = await mkdtemp(join(tmpdir(), 'lab-journey-'));
});
after(async () => {
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

test('fake-model guest journey completes on a phone, then its generated script replays', async () => {
  const secrets = new SecretStore();
  secrets.bind('guest_name', 'Ana Novak');
  secrets.bind('bearer', 'tok-secret-1234');
  let page: Page | undefined;
  const provider = fakeProvider(async (request, index) => {
    const id = request.observation.id;
    // The fake model peeks at the page only to compute coordinates; a real model sees just the screenshot.
    const p = page!;
    const at = async (role: 'link' | 'button' | 'textbox' | 'combobox', name: string) =>
      pointOf(p, p.getByRole(role, { name, exact: true }), request);
    switch (index) {
      case 0:
        return { name: 'click', args: { observationId: id, target: await at('link', 'Arrival instructions') } };
      case 1:
        return { name: 'click', args: { observationId: id, target: await at('link', 'Request early check-in') } };
      case 2:
        return {
          name: 'fill',
          args: { observationId: id, target: await at('textbox', 'Your name'), value: '{{guest_name}}' },
        };
      case 3:
        return {
          name: 'fill',
          args: { observationId: id, target: await at('combobox', 'Arrival time'), value: 'Afternoon' },
        };
      case 4:
        return { name: 'click', args: { observationId: id, target: await at('button', 'Review request') } };
      case 5:
        return { name: 'click', args: { observationId: id, target: await at('button', 'Send request') } };
      default:
        return { name: 'done', args: { step: lastStepId(request), summary: 'Request sent confirmation is shown.' } };
    }
  });
  const outDir = join(dir, 'run');
  const result = await runOnce({
    runId: 'run_test_001',
    outDir,
    provider,
    model: 'fake-model',
    effort: 'medium',
    prices: { input: 1, output: 4, cachedInput: 0.1 },
    task: 'Request an early check-in for the afternoon.',
    startUrl: `${fixture.url}/?scope=agent#tok-secret-1234`,
    allowedOrigins: [],
    secrets,
    limits: { steps: 40, timeMs: 120_000, dollars: 2 },
    device: { viewport: { width: 390, height: 844 }, touch: true },
    locale: 'sl-SI',
    timezone: 'Europe/Ljubljana',
    onPage: (created: Page) => {
      page = created;
    },
  });

  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.deepEqual(fixture.submissions('agent'), [{ name: 'Ana Novak', arrival: 'Afternoon', notes: '' }]);
  const actions = result.steps.filter((step) => step.target);
  assert.equal(actions.length, 6);
  assert.ok(actions.every((step) => step.target?.stability === 'semantic'));
  assert.equal(result.usage.providerCalls, 7);
  assert.equal(result.usage.capEnforcement, 'priced_reservations');
  assert.ok((result.usage.estimatedCostUsd ?? 0) > 0);

  const outbound = JSON.stringify(
    provider.requests.map(({ observation, ...rest }) => ({ ...rest, text: observation.text })),
  );
  const steps = await readFile(join(outDir, 'steps.jsonl'), 'utf8');
  const replay = await readFile(result.replayPath, 'utf8');
  for (const text of [outbound, steps, replay]) {
    assert.ok(!text.includes('Ana Novak'), 'secret value leaked');
    assert.ok(!text.includes('tok-secret-1234'), 'bearer fragment leaked');
  }
  assert.match(replay, /bind\("\{\{guest_name\}\}"\)/u);
  assert.match(replay, /\.tap\(/u);
  assert.ok((await stat(result.tracePath!)).size > 0);

  await symlink(join(repoRoot, 'node_modules'), join(outDir, 'node_modules'));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(repoRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=line', 'replay.spec.ts'],
    {
      cwd: outDir,
      env: {
        ...process.env,
        COHORT_START_URL: `${fixture.url}/?scope=replay#tok-secret-1234`,
        COHORT_SECRET_GUEST_NAME: 'Ana Novak',
      },
    },
  );
  assert.match(stdout, /1 passed/u);
  assert.deepEqual(fixture.submissions('replay'), [{ name: 'Ana Novak', arrival: 'Afternoon', notes: '' }]);
});

test('runOnce blocks disallowed frame navigations and records a real trace', async () => {
  const other = await startFixture({ host: 'localhost' });
  let page: Page | undefined;
  const loaded: Record<string, number> = {};
  const framed = (selector: string) =>
    page!.frameLocator(selector).getByRole('button', { name: 'Framed action' }).count();
  try {
    const provider = fakeProvider(async (request) => {
      loaded.same = await framed('#same');
      loaded.cross = await framed('#cross');
      return { name: 'done', args: { step: lastStepId(request), summary: 'Checked.' } };
    });
    const outDir = join(dir, 'frames');
    const result = await runOnce({
      runId: 'run_test_002',
      outDir,
      provider,
      model: 'fake-model',
      effort: 'low',
      prices: { input: 1, output: 4, cachedInput: 0.1 },
      task: 'Look around.',
      startUrl: `${fixture.url}/lab/targets?cross=${encodeURIComponent(`${other.url}/lab/frame`)}`,
      allowedOrigins: [],
      secrets: new SecretStore(),
      limits: { steps: 5, timeMs: 30_000, dollars: 1 },
      device: { viewport: { width: 800, height: 900 }, touch: false },
      locale: 'en-US',
      timezone: 'UTC',
      onPage: (created: Page) => {
        page = created;
      },
    });
    assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
    assert.deepEqual(loaded, { same: 1, cross: 0 });
    const trace = await readFile(result.tracePath!);
    assert.match(String(zipEntry(trace, 'trace.trace')), /"method":"goto"/u);
    assert.match(String(zipEntry(trace, 'trace.network')), /\/lab\/targets/u);
  } finally {
    await other.close();
  }
});

async function recorder(): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end('x');
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}`, hits };
}

test('runOnce keeps requests and redirect hops inside the allowlist and keeps artifacts when tracing fails', async () => {
  const blocked = await recorder();
  const resource = await recorder();
  let page: Page | undefined;
  const secrets = new SecretStore();
  secrets.bind('token', 'tok-trace-5678');
  try {
    const provider = fakeProvider([
      async () => {
        await page!.evaluate(
          async ({ blockedOrigin, resourceOrigin }) => {
            for (const src of [`${blockedOrigin}/image`, `${resourceOrigin}/image`])
              await new Promise((resolve) => {
                const image = new Image();
                image.addEventListener('load', resolve);
                image.addEventListener('error', resolve);
                image.src = src;
              });
            await fetch(`/lab/redirect?to=${encodeURIComponent(`${blockedOrigin}/hop`)}`).catch(() => {});
          },
          { blockedOrigin: blocked.origin, resourceOrigin: resource.origin },
        );
        return { name: 'goto', args: { url: `/lab/redirect?to=${encodeURIComponent(`${resource.origin}/nav`)}` } };
      },
      (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Checked.' } }),
    ]);
    const outDir = join(dir, 'guard');
    const result = await runOnce({
      runId: 'run_test_003',
      outDir,
      provider,
      model: 'fake-model',
      effort: 'low',
      prices: { input: 1, output: 4, cachedInput: 0.1 },
      task: 'Look around.',
      startUrl: `${fixture.url}/`,
      allowedOrigins: [],
      resourceOrigins: [resource.origin],
      secrets,
      limits: { steps: 5, timeMs: 30_000, dollars: 1 },
      device: { viewport: { width: 800, height: 900 }, touch: false },
      locale: 'en-US',
      timezone: 'UTC',
      onPage: (created: Page) => {
        page = created;
        created.context().tracing.stop = () => Promise.reject(new Error('disk full at /runs/tok-trace-5678'));
      },
    });
    assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
    assert.deepEqual(blocked.hits, []);
    assert.deepEqual(new Set(resource.hits), new Set(['/image']), 'resource origins serve subresources only');
    const goto = result.steps.find((step) => step.action.name === 'goto');
    assert.equal(goto?.result.status, 'error', 'a navigation redirected to a resource-only origin is blocked');
    assert.equal(result.tracePath, null);
    const traceIssue = result.issues.find((issue) => issue.code === 'trace_failed');
    assert.equal(traceIssue?.message, 'disk full at /runs/{{token}}');
    assert.ok((await stat(join(outDir, 'steps.jsonl'))).size > 0);
    assert.ok((await stat(result.replayPath)).size > 0);
  } finally {
    blocked.server.close();
    resource.server.close();
  }
});

test('a type replay waits for focus that arrives late inside a frame', async () => {
  let page: Page | undefined;
  const provider = fakeProvider([
    async () => {
      await page!.waitForFunction(
        () => document.querySelector('iframe')?.contentDocument?.activeElement?.id === 'pane-name',
      );
      return { name: 'type', args: { observationId: 'o0000', text: 'Mia Kranjc' } };
    },
    (request) => ({ name: 'press', args: { observationId: request.observation.id, key: 'Enter' } }),
    async (request) => {
      const sent = page!.frameLocator('#pane').getByRole('heading', { name: 'Request sent' });
      await sent.waitFor();
      // Clicking the confirmation makes the replay wait for the submission instead of racing it.
      return {
        name: 'click',
        args: { observationId: request.observation.id, target: await pointOf(page!, sent, request) },
      };
    },
    (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Sent.' } }),
  ]);
  const outDir = join(dir, 'delayed-focus');
  const result = await runOnce({
    runId: 'run_test_004',
    outDir,
    provider,
    model: 'fake-model',
    effort: 'low',
    prices: { input: 1, output: 4, cachedInput: 0.1 },
    task: 'Send your name.',
    startUrl: `${fixture.url}/lab/delayed-focus?scope=delayed-agent`,
    allowedOrigins: [],
    secrets: new SecretStore(),
    limits: { steps: 5, timeMs: 30_000, dollars: 1 },
    device: { viewport: { width: 800, height: 900 }, touch: false },
    locale: 'en-US',
    timezone: 'UTC',
    onPage: (created: Page) => {
      page = created;
    },
  });
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.deepEqual(fixture.submissions('delayed-agent'), [{ name: 'Mia Kranjc', arrival: '', notes: '' }]);
  const typed = result.steps.find((step) => step.action.name === 'type');
  assert.equal(typed?.recipient?.frames.length, 1, JSON.stringify(typed?.recipient));
  assert.deepEqual(typed?.recipient?.target, { by: 'role', role: 'textbox', name: 'Your name' });
  assert.equal(result.steps.find((step) => step.action.name === 'click')?.result.status, 'ok');

  await symlink(join(repoRoot, 'node_modules'), join(outDir, 'node_modules'));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(repoRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=line', 'replay.spec.ts'],
    { cwd: outDir, env: { ...process.env, COHORT_START_URL: `${fixture.url}/lab/delayed-focus?scope=delayed-replay` } },
  );
  assert.match(stdout, /1 passed/u);
  assert.deepEqual(fixture.submissions('delayed-replay'), [{ name: 'Mia Kranjc', arrival: '', notes: '' }]);
});
