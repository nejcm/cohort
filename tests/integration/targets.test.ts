import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { resolvePoint, toLocator } from '../../src/browser/targets.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';

let fixture: FixtureServer;
let other: FixtureServer;
let browser: Browser;
let page: Page;

before(async () => {
  fixture = await startFixture();
  other = await startFixture({ host: 'localhost' });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.goto(`${fixture.url}/lab/targets?cross=${encodeURIComponent(`${other.url}/lab/frame`)}`);
  await page.frameLocator('#cross').getByRole('button', { name: 'Framed action' }).waitFor();
});
after(async () => {
  await browser.close();
  await fixture.close();
  await other.close();
});

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  assert.ok(box, 'target has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function resolveAndReplay(locator: Locator, log: Locator, expected: string) {
  const resolution = await resolvePoint(page, await center(locator));
  assert.ok(resolution.ok, JSON.stringify(resolution));
  await log.evaluate((element) => (element.textContent = ''));
  await toLocator(page, resolution.descriptor).click({ position: resolution.position });
  assert.equal(await log.textContent(), expected);
  return resolution;
}

test('resolves and replays a button inside nested open shadow roots', async () => {
  const resolution = await resolveAndReplay(
    page.getByRole('button', { name: 'Shadow action' }),
    page.locator('#log'),
    'clicked: shadow',
  );
  assert.equal(resolution.stability, 'semantic');
  assert.deepEqual(resolution.descriptor.frames, []);
});

test('resolves and replays inside a bordered, padded same-origin frame', async () => {
  const frame = page.frameLocator('#same');
  const resolution = await resolveAndReplay(
    frame.getByRole('button', { name: 'Framed action' }),
    frame.locator('#log'),
    'clicked: framed',
  );
  assert.equal(resolution.descriptor.frames.length, 1);
});

test('resolves and replays an open shadow root inside a frame', async () => {
  const frame = page.frameLocator('#same');
  await resolveAndReplay(
    frame.getByRole('button', { name: 'Framed shadow action' }),
    frame.locator('#log'),
    'clicked: framed shadow',
  );
});

test('cross-origin frame on another site resolves and replays', async () => {
  const frame = page.frameLocator('#cross');
  await resolveAndReplay(
    frame.getByRole('button', { name: 'Framed action' }),
    frame.locator('#log'),
    'clicked: framed',
  );
});

test('closed shadow roots, canvas, and transformed frames are explicit unsupported errors', async () => {
  for (const [selector, reason] of [
    ['#closed', 'closed_shadow_root'],
    ['#canvas', 'canvas'],
    ['#scaled', 'transformed_frame'],
  ] as const) {
    const resolution = await resolvePoint(page, await center(page.locator(selector)));
    assert.deepEqual(resolution, { ok: false, reason }, selector);
  }
});

test('locator candidates holding a JSON-escaped secret are skipped in frame chains and targets', async () => {
  const secret = 'say "hi"\\4242';
  const scratch = await browser.newPage();
  try {
    await scratch.evaluate(async (value) => {
      const frame = document.createElement('iframe');
      frame.id = `frame ${value}`;
      frame.srcdoc = '<button id="go"></button>';
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      document.body.append(frame);
      await loaded;
      frame.contentDocument!.getElementById('go')!.textContent = `Pay ${value}`;
    }, secret);
    const resolution = await resolvePoint(scratch, await center(scratch.frameLocator('iframe').locator('#go')), {
      unsafe: (text) => text.includes(secret),
    });
    assert.ok(resolution.ok, JSON.stringify(resolution));
    const persisted = JSON.stringify(resolution.descriptor);
    assert.ok(!persisted.includes(JSON.stringify(secret).slice(1, -1)), persisted);
    assert.deepEqual(resolution.descriptor.target, { by: 'id', id: 'go' });
  } finally {
    await scratch.close();
  }
});
