import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { MASK_RGB } from '../../src/browser/observations.ts';
import { runAgent, type AgentOptions } from '../../src/core/agent.ts';
import { ProviderError, type DecideRequest } from '../../src/providers/types.ts';
import { SecretStore } from '../../src/setup/secrets.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, pointOf, type Turn } from '../helpers/fake-provider.ts';
import { decodePng } from '../helpers/png.ts';

const EMAIL = 'ana.canary@example.test';
const TOKEN = 'tok-canary-98765';
const TOTP = '482913';

let fixture: FixtureServer;
let browser: Browser;
let dir: string;

before(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  dir = await mkdtemp(join(tmpdir(), 'lab-agent-'));
});
after(async () => {
  await browser.close();
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

async function run(path: string, turns: (page: Page) => Turn | Turn[], overrides: Partial<AgentOptions> = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const secrets = new SecretStore();
  secrets.bind('email', EMAIL);
  secrets.bind('token', TOKEN);
  secrets.bind('totp', TOTP);
  const provider = fakeProvider(turns(page));
  try {
    const result = await runAgent({
      runId: 'run_agent_test',
      page,
      hasTouch: false,
      provider,
      model: 'fake-model',
      effort: 'low',
      prices: { input: 1, output: 4, cachedInput: 0.1 },
      task: 'Explore the page.',
      startUrl: `${fixture.url}${path}`,
      allowedOrigins: [],
      secrets,
      limits: { steps: 40, timeMs: 30_000, dollars: 2 },
      screenshotsDir: await mkdtemp(join(dir, 'shots-')),
      ...overrides,
    });
    return { result, provider };
  } finally {
    await page.close();
  }
}

const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });
const act =
  (name: string, extra: Record<string, unknown> = {}): Turn =>
  (request) => ({
    name,
    args: { observationId: request.observation.id, ...extra },
  });
const wait: Turn = () => ({ name: 'wait', args: { ms: 100 } });
const goto =
  (url: string): Turn =>
  () => ({ name: 'goto', args: { url } });

async function maskedAt(page: Page, request: DecideRequest, selector: string, inset: number): Promise<boolean> {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, selector);
  const png = decodePng(Buffer.from(request.observation.pngBase64, 'base64'));
  assert.equal(png.width, 800);
  const pixel = png.pixel(Math.round(box.x + box.width * inset), Math.round(box.y + box.height / 2));
  return pixel.every((channel, index) => channel === MASK_RGB[index]);
}

test('masks secrets in email and one-time-code inputs, DOM echoes, and fragment echoes in the PNGs sent to the provider', async () => {
  const checks: Record<string, boolean> = {};
  const { result, provider } = await run(`/lab/canary#${TOKEN}`, (page) => [
    async (request) => {
      checks.fragmentEcho = await maskedAt(page, request, '#echo', 0.5);
      return act('fill', { target: await pointOf(page, page.getByLabel('Email'), request), value: '{{email}}' })(
        request,
        0,
      );
    },
    async (request) => {
      checks.filledInput = await maskedAt(page, request, '#email', 0.1);
      checks.mirroredText = await maskedAt(page, request, '#mirror', 0.05);
      checks.ordinaryText = !(await maskedAt(page, request, 'text=Nothing secret here.', 0.1));
      return act('fill', { target: await pointOf(page, page.getByLabel('One-time code'), request), value: '{{totp}}' })(
        request,
        1,
      );
    },
    async (request) => {
      checks.filledTotp = await maskedAt(page, request, '#otp', 0.05);
      return done(request, 2);
    },
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.deepEqual(checks, {
    fragmentEcho: true,
    filledInput: true,
    mirroredText: true,
    ordinaryText: true,
    filledTotp: true,
  });
  const outbound = JSON.stringify(
    provider.requests.map((request) => [request.instructions, request.history, request.observation.text]),
  );
  assert.ok(![EMAIL, TOKEN, TOTP].some((secret) => outbound.includes(secret)));
  assert.ok(!outbound.includes('#'), 'fragment reached outbound text');
  assert.match(outbound, /\{\{email\}\}/u);
});

test('an unsafe capture fails closed and suppresses every provider call', async () => {
  const { result, provider } = await run('/lab/canary', () => done, { maskSelectors: ['::not-a-selector('] });
  assert.equal(result.outcome.state, 'agent_error');
  assert.match(JSON.stringify(result.outcome), /provider calls suppressed/u);
  assert.equal(provider.requests.length, 0);
});

test('a secret in outbound text suppresses the provider call', async () => {
  const { result, provider } = await run('/lab/canary', () => done, { task: `Sign in as ${EMAIL}.` });
  assert.equal(result.outcome.state, 'agent_error');
  assert.equal(provider.requests.length, 0);
});

test('native select, keyboard, dialog, and file chooser are handled explicitly', async () => {
  let selected = '';
  let afterKey = '';
  const { result } = await run('/lab/native', (page) => [
    async (request) =>
      act('fill', { target: await pointOf(page, page.getByLabel('Arrival time'), request), value: 'Evening' })(
        request,
        0,
      ),
    async (request) => {
      selected = (await page.locator('#log').textContent()) ?? '';
      return act('click', { target: await pointOf(page, page.getByLabel('Arrival time'), request) })(request, 1);
    },
    act('press', { key: 'ArrowDown' }),
    act('press', { key: 'Enter' }),
    async (request) => {
      afterKey = await page.locator('#time').inputValue();
      return act('click', { target: await pointOf(page, page.getByRole('button', { name: 'Show alert' }), request) })(
        request,
        2,
      );
    },
    async (request) => act('click', { target: await pointOf(page, page.locator('#upload'), request) })(request, 3),
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.equal(selected, 'selected: Evening');
  assert.equal(afterKey, 'After midnight');
  const fill = result.steps.find((step) => step.action.name === 'fill');
  assert.equal(fill?.target?.tag, 'select');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['dialog_dismissed', 'file_chooser_cancelled'],
  );
  assert.ok(result.steps.every((step) => step.result.status === 'ok'));
});

test('step cap stops the run', async () => {
  const { result, provider } = await run('/', () => wait, { limits: { steps: 3, timeMs: 30_000, dollars: 2 } });
  assert.equal(result.outcome.state, 'limit_reached');
  assert.equal((result.outcome as { limit: string }).limit, 'steps');
  assert.equal(provider.requests.length, 3);
});

test('time cap stops the run after a slow provider call', async () => {
  const { result } = await run(
    '/',
    () => async (request) => {
      await delay(400);
      return wait(request, 0);
    },
    { limits: { steps: 40, timeMs: 300, dollars: 2 } },
  );
  assert.equal((result.outcome as { limit?: string }).limit, 'time', JSON.stringify(result.outcome));
});

test('cost cap refuses a call whose reservation does not fit', async () => {
  const { result, provider } = await run('/', () => done, { prices: { input: 1000, output: 1000, cachedInput: 0 } });
  assert.equal((result.outcome as { limit?: string }).limit, 'cost');
  assert.equal(provider.requests.length, 0);
  assert.equal(result.usage.capEnforcement, 'priced_reservations');
});

test('unpriced models fall back to step/time caps without counting cost as zero', async () => {
  const { result } = await run('/', () => done, { prices: { input: null, output: null, cachedInput: null } });
  assert.equal(result.outcome.state, 'completed');
  assert.equal(result.usage.capEnforcement, 'step_time_only');
  assert.equal(result.usage.estimatedCostUsd, null);
});

test('parallel, invalid, stale, and out-of-image calls are rejected without acting', async () => {
  const { result } = await run('/', () => [
    () => [
      { name: 'wait', args: { ms: 100 } },
      { name: 'wait', args: { ms: 100 } },
    ],
    () => ({ name: 'click', args: { observationId: 'o0001' } }),
    () => ({ name: 'press', args: { observationId: 'o9999', key: 'Enter' } }),
    act('click', { target: { kind: 'point', x: 5000, y: 5 } }),
    act('click', { target: { kind: 'ref', ref: 'e1' } }),
    done,
  ]);
  assert.equal(result.outcome.state, 'completed');
  assert.deepEqual(
    result.steps.slice(1, -1).map((step) => (step.result.status === 'ok' ? 'ok' : step.result.code)),
    ['invalid_tool', 'invalid_tool', 'stale_observation', 'point_outside_screenshot', 'reference_in_vision_mode'],
  );
});

const flaky = (failures: number): Turn => {
  let left = failures;
  return (request) => {
    if (left-- > 0) throw new ProviderError('HTTP 503', { status: 503, retryable: true, possiblyBilled: true });
    return done(request, 0);
  };
};

test('a retryable provider failure is retried once; a second failure ends the run', async () => {
  const once = await run('/', () => flaky(1));
  assert.equal(once.result.outcome.state, 'completed');
  assert.equal(once.result.usage.providerCalls, 2);
  assert.ok(once.result.usage.reservedUnsettledCostUsd > 0);
  const twice = await run('/', () => flaky(2));
  assert.equal(twice.result.outcome.state, 'agent_error');
  assert.equal((twice.result.outcome as { code: string }).code, 'provider_error');
});

test('goto enforces the origin allowlist and rejects secrets', async () => {
  const { result } = await run('/', () => [
    goto('https://elsewhere.test/'),
    goto(`/arrival?t=${TOKEN}`),
    goto('{{token}}'),
    goto('javascript:alert(1)'),
    goto('/arrival'),
    done,
  ]);
  assert.equal(result.outcome.state, 'completed');
  const codes = result.steps.slice(1, -1).map((step) => (step.result.status === 'ok' ? 'ok' : step.result.code));
  assert.deepEqual(codes, ['navigation_denied', 'secret_in_goto', 'secret_in_goto', 'navigation_denied', 'ok']);
  assert.ok(!JSON.stringify(result.steps).includes(TOKEN));
});
