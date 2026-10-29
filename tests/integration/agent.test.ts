import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { captureMasked, MASK_RGB } from '../../src/browser/observations.ts';
import { runAgent, type AgentOptions } from '../../src/core/agent.ts';
import { ProviderError, type DecideRequest, type Usage } from '../../src/providers/types.ts';
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

async function run(
  path: string,
  turns: (page: Page) => Turn | Turn[],
  overrides: Partial<AgentOptions> = {},
  usage: Partial<Usage> = {},
) {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  const secrets = new SecretStore();
  secrets.bind('email', EMAIL);
  secrets.bind('token', TOKEN);
  secrets.bind('totp', TOTP);
  const provider = fakeProvider(turns(page), usage);
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
  const pixel = png.pixel(Math.round(box.x + box.width * inset), Math.round(box.y + box.height / 2));
  return pixel.every((channel, index) => channel === MASK_RGB[index]);
}

// Every pixel of the rendered box must be mask-coloured, not just a sample.
async function fullyMasked(locator: Locator, request: DecideRequest): Promise<boolean> {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const png = decodePng(Buffer.from(request.observation.pngBase64, 'base64'));
  assert.equal(png.width, 800);
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y += 1)
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x += 1)
      if (!png.pixel(x, y).every((channel, index) => channel === MASK_RGB[index])) return false;
  return true;
}

test('masks secrets in inputs, placeholders, split text, shadow roots, frames, and fragment echoes in sent PNGs', async () => {
  const checks: Record<string, boolean> = {};
  const { result, provider } = await run(`/lab/canary#${TOKEN}`, (page) => [
    async (request) => {
      const region = (locator: Locator) => fullyMasked(locator, request);
      checks.fragmentEcho = await region(page.locator('#echo'));
      checks.splitText = await region(page.locator('#split'));
      checks.displayContents =
        (await region(page.locator('#contents-a'))) && (await region(page.locator('#contents-b')));
      checks.placeholder = await region(page.locator('#reference'));
      checks.shadowRoot = await region(page.locator('#shadow-echo b'));
      checks.frame = await region(page.frameLocator('#frame-echo').locator('#t'));
      checks.namedButton = await region(page.locator('#continue'));
      return act('fill', { target: await pointOf(page, page.getByLabel('Email'), request), value: '{{email}}' })(
        request,
        0,
      );
    },
    async (request) => {
      checks.filledInput = await fullyMasked(page.locator('#email'), request);
      checks.mirroredText = await fullyMasked(page.locator('#mirror'), request);
      checks.ordinaryText = !(await maskedAt(page, request, 'text=Nothing secret here.', 0.1));
      return act('fill', { target: await pointOf(page, page.getByLabel('One-time code'), request), value: '{{totp}}' })(
        request,
        1,
      );
    },
    async (request) => {
      checks.filledTotp = await fullyMasked(page.locator('#otp'), request);
      return act('click', { target: await pointOf(page, page.locator('#continue'), request) })(request, 2);
    },
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.deepEqual(checks, {
    fragmentEcho: true,
    splitText: true,
    displayContents: true,
    placeholder: true,
    shadowRoot: true,
    frame: true,
    namedButton: true,
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
  const click = result.steps.find((step) => step.action.name === 'click');
  assert.deepEqual(click?.target?.locator, { frames: [], target: { by: 'id', id: 'continue' } });
  assert.ok(!JSON.stringify(result.steps).includes(TOKEN), 'secret-bearing locator persisted');
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

test('a deadline timer that fires before Date.now() reaches the deadline is still a time limit', async () => {
  const realNow = Date.now;
  try {
    const { result } = await run(
      '/',
      () => async (request) => {
        // Libuv timers can run ahead of Date.now(); lag the wall clock once the call's timers are armed.
        setImmediate(() => (Date.now = () => realNow() - 5_000));
        await delay(600);
        return wait(request, 0);
      },
      { limits: { steps: 40, timeMs: 300, dollars: 2 } },
    );
    assert.equal((result.outcome as { limit?: string }).limit, 'time', JSON.stringify(result.outcome));
  } finally {
    Date.now = realNow;
  }
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

test('a capture that fails after a failed action ends the run before another provider call', async () => {
  const { result, provider } = await run(`/lab/canary#${TOKEN}`, (page) => [
    async (request) => {
      // A secret that keeps moving makes every rescan disagree with the masks just captured.
      await page.evaluate(() => {
        const echo = document.getElementById('echo')!;
        setInterval(() => (echo.style.marginLeft = `${Math.floor(Math.random() * 300)}px`), 0);
      });
      return act('fill', { target: await pointOf(page, page.locator('#continue'), request), value: 'x' })(request, 0);
    },
    done,
  ]);
  assert.equal(result.outcome.state, 'agent_error', JSON.stringify(result.outcome));
  assert.match(JSON.stringify(result.outcome), /provider calls suppressed/u);
  assert.equal(provider.requests.length, 1);
  assert.equal(result.steps.at(-1)?.result.status, 'error');
});

test('a done that arrives after the deadline is a time limit, not a completion', async () => {
  const { result } = await run(
    '/',
    () => async (request) => {
      await delay(400);
      return done(request, 0);
    },
    { limits: { steps: 40, timeMs: 300, dollars: 2 } },
  );
  assert.equal((result.outcome as { limit?: string }).limit, 'time', JSON.stringify(result.outcome));
});

test('a browser failure mid-action keeps the trail and ends as agent_error', async () => {
  const { result } = await run('/', (page) => [
    wait,
    async (request) => {
      await page.close();
      return act('press', { key: 'Enter' })(request, 1);
    },
  ]);
  assert.equal(result.outcome.state, 'agent_error');
  assert.equal(result.steps.length, 3);
  assert.deepEqual(
    [result.steps[2]?.action.name, result.steps[2]?.result.status],
    ['press', 'error'],
    'the failed attempt is recorded',
  );
});

test('history stays within its byte budget, including multi-byte text', async () => {
  const { provider } = await run('/', () => [
    ...Array.from({ length: 10 }, (): Turn => () => ({ name: 'wait', args: { ms: 100, junk: '語'.repeat(4000) } })),
    done,
  ]);
  for (const request of provider.requests) assert.ok(Buffer.byteLength(request.history.join('\n')) <= 8000);
});

test('a call that settles past the dollar cap is not acted on', async () => {
  const { result, provider } = await run('/', () => done, {}, { inputTokens: 50_000_000 });
  assert.equal(provider.requests.length, 1);
  assert.equal((result.outcome as { limit?: string }).limit, 'cost', JSON.stringify(result.outcome));
  assert.equal(result.steps.length, 1);
});

test('a control swapped in after the observation is not clicked', async () => {
  const { result } = await run('/lab/canary', (page) => [
    async (request) => {
      const target = await pointOf(page, page.locator('#continue'), request);
      await page.locator('#continue').evaluate((button) => {
        const swapped = document.createElement('button');
        swapped.id = 'continue';
        swapped.textContent = 'Delete account';
        swapped.addEventListener('click', () => (document.title = 'deleted'));
        button.replaceWith(swapped);
      });
      return act('click', { target })(request, 0);
    },
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  const click = result.steps.find((step) => step.action.name === 'click');
  assert.equal(click?.result.status === 'rejected' && click.result.code, 'stale_target');
  assert.ok(click?.afterScreenshotId, 'a fresh observation follows the rejection');
});

test('frame content re-rendered identically during capture is never sent unmasked', async () => {
  const { result, provider } = await run(`/lab/canary#${TOKEN}`, (page) => [
    async (request) => {
      // Same URL, same boxes, but the re-render drops the overlay: only change tracking can catch it.
      await page
        .frameLocator('#frame-echo')
        .locator('html')
        .evaluate((root) => {
          const original = root.innerHTML;
          new MutationObserver((_, observer) => {
            if (!root.querySelector('[data-cohort-overlay]')) return;
            observer.disconnect();
            root.innerHTML = original;
          }).observe(root, { childList: true });
        });
      return wait(request, 0);
    },
    async (request) => {
      assert.ok(await fullyMasked(page.frameLocator('#frame-echo').locator('#t'), request), 'replaced frame unmasked');
      return done(request, 1);
    },
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.equal(provider.requests.length, 2);
});

test('a navigation committing mid-capture retries on the new document instead of hanging', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const context = page.context();
  const open = context.newCDPSession.bind(context);
  let navigations = 0;
  // Chromium never answers a capture that a main-frame commit overtakes; navigate right behind the first one.
  context.newCDPSession = async (target) => {
    const session = await open(target);
    const send = session.send.bind(session) as (method: string, params?: object) => Promise<unknown>;
    session.send = ((method: string, params?: object) => {
      const sent = send(method, params);
      if (method === 'Page.captureScreenshot' && navigations++ === 0)
        void send('Page.navigate', { url: `${fixture.url}/lab/canary` }).catch(() => {});
      return sent;
    }) as typeof session.send;
    return session;
  };
  try {
    await page.goto(`${fixture.url}/`);
    const started = Date.now();
    const capture = await captureMasked(page, { secrets: [], maskSelectors: [], maxWidth: 800 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(capture.width, 800);
    assert.match(page.url(), /\/lab\/canary$/u);
  } finally {
    await page.close();
  }
});

test('a response from a disallowed origin ends the run before another provider call', async () => {
  const outside = createServer((_, response) => response.end('x'));
  await new Promise<void>((resolve) => outside.listen(0, 'localhost', resolve));
  const origin = `http://localhost:${(outside.address() as AddressInfo).port}`;
  try {
    const { result, provider } = await run('/', (page) => [
      async (request) => {
        await page.evaluate((url) => fetch(url, { mode: 'no-cors' }), `${origin}/beacon`);
        return wait(request, 0);
      },
      done,
    ]);
    assert.equal(result.outcome.state, 'agent_error');
    assert.match(JSON.stringify(result.outcome), /disallowed origin/u);
    assert.equal(provider.requests.length, 1);
  } finally {
    outside.close();
  }
});

test('start URLs with embedded credentials are rejected before navigation', async () => {
  const { result, provider } = await run('/', () => done, {
    startUrl: fixture.url.replace('http://', 'http://user:pass@'),
  });
  assert.equal(result.outcome.state, 'agent_error');
  assert.equal(provider.requests.length, 0);
});

const clickOn =
  (page: Page, selector: string): Turn =>
  async (request) => ({
    name: 'click',
    args: { observationId: request.observation.id, target: await pointOf(page, page.locator(selector), request) },
  });

test('repeated clicks with no visible effect stop as a loop agent error, not a UX outcome', async () => {
  const { result, provider } = await run('/lab/loop', (page) => clickOn(page, '#next'));
  assert.deepEqual([result.outcome.state, (result.outcome as { code: string }).code], ['agent_error', 'loop']);
  assert.equal(provider.requests.length, 3);
  assert.equal(result.steps.length, 4);
  assert.equal(result.outcome.evidence.length, 1);
});

test('repetition that changes the screen, or varies, is not a loop', async () => {
  const counting = await run('/lab/loop', (page) => [...Array<Turn>(5).fill(clickOn(page, '#count')), done]);
  assert.equal(counting.result.outcome.state, 'completed', JSON.stringify(counting.result.outcome));
  const varied = await run('/lab/loop', (page) => [clickOn(page, '#next'), wait, clickOn(page, '#next'), wait, done]);
  assert.equal(varied.result.outcome.state, 'completed', JSON.stringify(varied.result.outcome));
});

test('malformed provider turns (no tool call) repeat into a loop error', async () => {
  const { result, provider } = await run('/', () => () => []);
  assert.equal((result.outcome as { code?: string }).code, 'loop');
  assert.equal(provider.requests.length, 3);
  assert.ok(result.steps.slice(1).every((step) => step.result.status === 'rejected'));
});

test('a terminal action on the final allowed step finishes; one more step hits the cap', async () => {
  const limits = { steps: 2, timeMs: 30_000, dollars: 2 };
  const last = await run('/', () => [wait, done], { limits });
  assert.equal(last.result.outcome.state, 'completed');
  const over = await run('/', () => [wait, act('scroll', { target: null, deltaX: 0, deltaY: 10 }), done], { limits });
  assert.deepEqual(over.result.outcome, {
    ...over.result.outcome,
    state: 'limit_reached',
    limit: 'steps',
    observed: 2,
  });
  assert.equal(over.provider.requests.length, 2);
});

test('provider-reported spend enforces the dollar cap when prices are unknown', async () => {
  const { result, provider } = await run(
    '/',
    () => [wait, act('scroll', { target: null, deltaX: 0, deltaY: 10 }), done],
    { prices: { input: null, output: null, cachedInput: null }, limits: { steps: 40, timeMs: 30_000, dollars: 1 } },
    { reportedCostUsd: 0.6 },
  );
  assert.equal((result.outcome as { limit?: string }).limit, 'cost');
  assert.equal(provider.requests.length, 2);
  assert.equal(result.usage.capEnforcement, 'provider_reported_cost');
  assert.equal(result.usage.providerReportedCostUsd, 1.2);
});

for (const by of ['user', 'process'] as const)
  test(`cancellation (${by}) during a pending provider call ends as interrupted and keeps the reservation`, async () => {
    const controller = new AbortController();
    const started = Date.now();
    const { result } = await run(
      '/',
      () => () => {
        setTimeout(() => controller.abort(by), 100);
        return new Promise<never>(() => {});
      },
      { signal: controller.signal },
    );
    assert.deepEqual(result.outcome, {
      state: 'agent_error',
      code: 'interrupted',
      interruptedBy: by,
      reason: `interrupted by ${by}`,
      evidence: [{ stepId: 's0000', screenshotId: 'shot-0000' }],
    });
    assert.ok(Date.now() - started < 5000);
    assert.ok(result.usage.reservedUnsettledCostUsd > 0);
  });

test('cancellation during a pending browser action ends promptly as interrupted', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const { result } = await run(
    '/',
    () => () => {
      setTimeout(() => controller.abort('user'), 100);
      return { name: 'wait', args: { ms: 5000 } };
    },
    { signal: controller.signal },
  );
  assert.equal((result.outcome as { code?: string }).code, 'interrupted');
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.steps.at(-1)!.action.name, 'wait');
});

test('page text cannot widen navigation: an injected instruction followed by the model is still denied', async () => {
  const { result, provider } = await run('/lab/injection', () => [goto('https://exfil.invalid/collect'), done]);
  assert.equal(result.outcome.state, 'completed');
  assert.equal(result.steps[1]!.result.status === 'rejected' && result.steps[1]!.result.code, 'navigation_denied');
  assert.ok(provider.requests.every((request) => !/SYSTEM NOTICE/u.test(request.instructions)));
});

for (const [path, kind] of [
  ['/lab/captcha', 'captcha'],
  ['/lab/email-code', 'email_code'],
  ['/lab/payment', 'payment'],
] as const)
  test(`the ${kind} gate ends as an agent-declared blocker with evidence`, async () => {
    const { result } = await run(path, () => (request) => ({
      name: 'report_blocked',
      args: { kind, step: lastStepId(request), reason: 'Cannot continue.' },
    }));
    assert.deepEqual(
      [result.outcome.state, (result.outcome as { kind?: string }).kind, result.outcome.evidence.length],
      ['blocked', kind, 1],
    );
  });

const giveUp =
  (kind: string): Turn =>
  (request) => ({ name: 'give_up', args: { kind, step: lastStepId(request), reason: 'Lost.' } });

test('an agent give_up is abandonment; an uncertain give_up is an agent error', async () => {
  assert.equal((await run('/', () => giveUp('journey_abandoned'))).result.outcome.state, 'abandoned');
  assert.equal((await run('/', () => giveUp('agent_uncertain'))).result.outcome.state, 'agent_error');
});

for (const link of ['#slow-headers', '#slow-body'])
  test(`cancellation while a click (${link}) is pending ends as interrupted`, async () => {
    const controller = new AbortController();
    let clickedAt = 0;
    const { result } = await run(
      '/lab/loop',
      (page) => async (request) => {
        const call = await clickOn(page, link)(request, 0);
        clickedAt = Date.now();
        setTimeout(() => controller.abort('user'), 100);
        return call;
      },
      { signal: controller.signal },
    );
    assert.deepEqual(
      [result.outcome.state, (result.outcome as { code?: string }).code],
      ['agent_error', 'interrupted'],
      JSON.stringify(result.outcome),
    );
    assert.ok(Date.now() - clickedAt < 1200);
  });

test('cancellation while the follow-up screenshot is pending ends as interrupted', async () => {
  const controller = new AbortController();
  let loadedAt = 0;
  const { result } = await run(
    '/lab/loop',
    (page) => async (request) => {
      page.once('domcontentloaded', () => {
        loadedAt = Date.now();
        setTimeout(() => controller.abort('user'), 300);
      });
      return clickOn(page, '#busy')(request, 0);
    },
    { signal: controller.signal },
  );
  assert.deepEqual(
    [result.outcome.state, (result.outcome as { code?: string }).code],
    ['agent_error', 'interrupted'],
    JSON.stringify(result.outcome),
  );
  assert.ok(Date.now() - loadedAt < 1500);
});

test('loop detection ignores argument key order', async () => {
  const { result } = await run('/', () => [
    act('scroll', { target: null, deltaX: 0, deltaY: 0 }),
    (request) => ({
      name: 'scroll',
      args: { deltaY: 0, deltaX: 0, target: null, observationId: request.observation.id },
    }),
    act('scroll', { target: null, deltaX: 0, deltaY: 0 }),
    done,
  ]);
  assert.equal((result.outcome as { code?: string }).code, 'loop');
});
