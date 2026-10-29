import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { LabDb } from '../../src/dashboard/db.ts';
import { startDashboard, type Dashboard } from '../../src/dashboard/server.ts';
import { startFixture, type FixtureServer } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const KEY = 'sk-dashboard-ui-canary-5150';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });
let turn: Turn = done;
const provider = fakeProvider((request, index) => turn(request, index));
const providers = { openai: provider, anthropic: { ...provider, id: 'anthropic', available: () => false } };
let fixture: FixtureServer;
let root: string;
let assets: string;
let dashboard: Dashboard;
let browser: Browser;
let page: Page;
const violations: string[] = [];
const bodies: string[] = [];

const PERSONA = (id: string, name: string, extra = ''): string =>
  `---\nschemaVersion: 1\nid: ${id}\nname: '${name}'\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\n${extra}goal: Look around.\n---\n\nYou are a guest.\n`;
const model = (id: string, vision: boolean, input: number | null, untested: boolean, owner = 'openai'): string =>
  `  - id: ${id}\n    provider: ${owner}\n    label: ${id}\n    visionCapable: ${vision}\n    supportedEffortLevels: [low, medium]\n    defaultEffort: medium\n    pricesPerMTok: { input: ${input}, output: ${input === null ? null : 4}, cachedInput: ${input === null ? null : 0.1} }\n    pricingVerifiedAt: ${input === null ? null : '2026-10-01'}\n    untested: ${untested}\n`;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
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

const focused = (): Promise<string> =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || '');

async function tabTo(target: string, limit = 40): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if ((await focused()) === target) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`Tab never reached ${target}; stuck on ${await focused()}`);
}

before(async () => {
  assets = await mkdtemp(join(tmpdir(), 'lab-ui-assets-'));
  await build({
    configFile: join(repo, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: assets, emptyOutDir: true },
  });
  fixture = await startFixture();
  root = await mkdtemp(join(tmpdir(), 'lab-ui-'));
  await put(
    '.cohort/config.yml',
    'schemaVersion: 1\nmodel: openai/priced\nrepeats: 1\nlimits: { steps: 5, timeMs: 30000 }\n',
  );
  await put(
    '.cohort/models.yml',
    `version: test\nmodels:\n${[
      model('priced', true, 1, false),
      model('unpriced', true, null, false),
      model('fresh', true, 1, true),
      model('blind', false, 1, false),
      model('claude', true, 1, false, 'anthropic'),
    ].join('')}`,
  );
  await put('.cohort/personas/guest.md', PERSONA('guest', 'Guest'));
  await put('.cohort/personas/hostile.md', PERSONA('hostile', '<img src=x onerror="window.pwned=1">'));
  await put('.cohort/setup/fixture.ts', 'export default async () => ({});\n');
  await put('.cohort/personas/scripted.md', PERSONA('scripted', 'Scripted', 'setup: ../setup/fixture.ts\n'));
  await put('.cohort/suites/smoke.yml', 'schemaVersion: 1\nid: smoke\nname: Smoke\nentries:\n  - persona: guest\n');
  await put('.cohort/personas/trial.md', PERSONA('trial', 'Trial', 'model: openai/fresh\n'));
  await put(
    '.cohort/suites/layered.yml',
    'schemaVersion: 1\nid: layered\nname: Layered\ndefaults:\n  model: openai/unpriced\nentries:\n  - persona: guest\n  - persona: guest\n    model: openai/priced\n',
  );
  dashboard = await startDashboard({
    projectRoot: root,
    env: { FAKE_API_KEY: KEY, OPENAI_API_KEY: KEY },
    providers: providers as never,
    assetsDir: assets,
  });
  browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`csp-violation ${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (/csp-violation|Content Security Policy/u.test(message.text())) violations.push(message.text());
  });
  page.on('response', async (response) => {
    if (response.url().includes('/api/') && !response.url().includes('/events'))
      bodies.push(await response.text().catch(() => ''));
  });
  await page.goto(dashboard.url);
});

after(async () => {
  await browser?.close();
  await dashboard?.close();
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
  await rm(assets, { recursive: true, force: true });
});

test('the built assets load under the CSP with no inline code and the token leaves the URL', async () => {
  const html = await readFile(join(assets, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son\w+=/u);
  for (const name of await readdir(join(assets, 'assets')))
    if (name.endsWith('.js'))
      assert.doesNotMatch(await readFile(join(assets, 'assets', name), 'utf8'), /\beval\(|new Function\(/u);
  await page.getByRole('heading', { name: 'Runs' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/runs');
  assert.ok(!page.url().includes(dashboard.token));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('cohort-token')), dashboard.token);

  const stranger = await browser.newPage();
  await stranger.goto(dashboard.origin);
  await stranger.getByRole('heading', { name: 'Open the launch URL' }).waitFor();
  await stranger.close();
});

test('the run dialog is keyboard-operable, hides keyless providers, and shows estimates or unknown cost', async () => {
  await page.getByRole('button', { name: 'New run' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await dialog.waitFor();
  await tabTo('run-url');
  await page.keyboard.type(`${fixture.url}/`);
  await dialog.getByText('from project').waitFor();
  await dialog.getByText(/estimate \$0\.\d+–\$/u).waitFor();
  await dialog.getByText(/Batch budget: at most \$/u).waitFor();

  const options = await page.locator('#run-model option').evaluateAll((items) =>
    items.map((item) => ({
      value: (item as HTMLOptionElement).value,
      disabled: (item as HTMLOptionElement).disabled,
      text: item.textContent!.trim(),
    })),
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ['', 'openai/priced', 'openai/unpriced', 'openai/fresh', 'openai/blind'],
  );
  assert.ok(
    options.find((option) => option.value === 'openai/blind')!.disabled,
    'non-vision model disabled in vision mode',
  );
  assert.match(options.find((option) => option.value === 'openai/fresh')!.text, /untested/u);
  await dialog.getByText('Hidden (no API key in the environment): anthropic').waitFor();

  await tabTo('run-model');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#run-model').inputValue(), 'openai/unpriced');
  await dialog.getByText('from run').waitFor();
  await dialog.getByText('cost unknown; dollar cap unenforceable', { exact: true }).waitFor();
  await dialog.getByText(/Batch budget: unknown/u).waitFor();

  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#run-model').inputValue(), 'openai/fresh');
  await dialog.getByLabel('Allow the untested model').waitFor();
  assert.equal(await dialog.getByRole('button', { name: /^Start \d+ runs?$/u }).isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await focused(), 'run-effort');
  const efforts = await page
    .locator('#run-effort option')
    .evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  assert.deepEqual(efforts, ['', 'low', 'medium']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await dialog.getByText(/estimate \$/u).waitFor();

  await tabTo('run-mode');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#run-mode').inputValue(), 'text');
  assert.equal(
    await page.locator('#run-model option[value="openai/blind"]').isDisabled(),
    false,
    'text mode allows non-vision models',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
});

test('inherited models drive effort choices and untested consent; tag and suite dispatch show every layer', async () => {
  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await page.locator('#run-url').fill(`${fixture.url}/`);
  await dialog.getByText('from project').first().waitFor();
  await dialog.getByText(/unmeasured estimate \$/u).waitFor();
  const efforts = () =>
    page.locator('#run-effort option').evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  assert.deepEqual(await efforts(), ['', 'low', 'medium'], 'only efforts the inherited model supports');

  await page.locator('#run-target').selectOption('trial');
  await dialog.getByText('from persona').waitFor();
  const consent = dialog.getByLabel('Allow the untested model');
  await consent.waitFor();
  assert.equal(await dialog.getByRole('button', { name: /^Start 1 run$/u }).isDisabled(), true);
  await consent.check();
  await dialog.getByRole('button', { name: /^Start 1 run$/u, disabled: false }).waitFor();

  await page.locator('#run-kind').selectOption('tag');
  await page.locator('#run-target').selectOption('guest');
  await consent.check();
  for (const persona of ['guest', 'hostile', 'scripted', 'trial'])
    await dialog.getByRole('cell', { name: persona, exact: true }).waitFor();

  await page.locator('#run-kind').selectOption('suite');
  await page.locator('#run-target').selectOption('layered');
  await dialog.getByText('from suite_default').waitFor();
  await dialog.getByText('from suite_entry').waitFor();
  await dialog.getByRole('button', { name: /^Start 2 runs$/u }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
});

test('a dispatched run streams live steps, cancels nothing finished, and offers authenticated downloads', async () => {
  const blocker = gate();
  turn = blocker.turn;
  await page.getByRole('button', { name: 'New run' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await page.locator('#run-url').fill(`${fixture.url}/`);
  await dialog.getByText(/estimate \$/u).waitFor();
  await page.locator('#run-url').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/runs\/run_/u, { waitUntil: 'commit' });
  await blocker.reached;
  await page.getByRole('button', { name: 'Cancel run' }).waitFor();
  const timeline = page.getByRole('toolbar', { name: /Screenshots/u });
  await timeline.getByRole('button', { name: 'shot-0000' }).waitFor();
  blocker.release();
  turn = done;
  await page.getByRole('heading', { name: 'Outcome: completed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cancel run' }).count(), 0);
  await page.getByText(/^s0001 done ok/u).waitFor();

  await timeline.getByRole('button', { name: 'shot-0000' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('img', { name: 'Masked screenshot shot-0000' }).waitFor();
  assert.match((await page.getByRole('img').getAttribute('src')) ?? '', /^blob:/u);

  const trace = page.getByRole('button', { name: 'Trace (private)' });
  await trace.focus();
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  assert.equal(download.suggestedFilename(), 'trace.zip');
  assert.ok((await readFile((await download.path())!)).subarray(0, 2).equals(Buffer.from('PK')));

  await page.goto(`${dashboard.origin}/runs`);
  const row = page.getByRole('row').filter({ hasText: 'guest' }).first();
  await row.getByText('completed').waitFor();
  await row.getByText('openai/priced · medium').waitFor();
  await row.getByText(/^\$0\.\d+$/u).waitFor();
});

test('queued and running runs cancel from the run view', async () => {
  const blocker = gate();
  turn = blocker.turn;
  const started = await page.evaluate(async (url) => {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionStorage.getItem('cohort-token')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ submission: { selector: { kind: 'persona', id: 'guest' }, url } }),
    });
    return (await response.json()) as { runIds: string[] };
  }, `${fixture.url}/`);
  await page.goto(`${dashboard.origin}/runs/${started.runIds[0]}`);
  await blocker.reached;
  await page.getByRole('button', { name: 'Cancel run' }).focus();
  await page.keyboard.press('Enter');
  // Releasing before the cancel request lands lets the run complete first.
  await page.getByText('Cancellation requested.').waitFor();
  blocker.release();
  turn = done;
  await page.getByRole('heading', { name: 'Outcome: agent error' }).waitFor();
  await page.getByText('(interrupted by user)').waitFor();
});

test('persona edits keep the user text on a revision conflict and keep setup read-only', async () => {
  await page.goto(`${dashboard.origin}/personas/guest`);
  const source = page.locator('#editor-source');
  await source.waitFor();
  await page.waitForFunction(() =>
    (document.querySelector('#editor-source') as HTMLTextAreaElement).value.includes('You are a guest.'),
  );
  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Edited in the dashboard.');
  await page.locator('#personas-default-effort').focus();
  await page.keyboard.press('ArrowDown');
  assert.match(await source.inputValue(), /^effort: low$/mu);
  const disk = PERSONA('guest', 'Guest').replace('Look around.', 'Changed outside.');
  await writeFile(join(root, '.cohort/personas/guest.md'), disk);
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('changed on disk since you opened it').waitFor();
  assert.match(await source.inputValue(), /Edited in the dashboard\./u);
  assert.equal(await readFile(join(root, '.cohort/personas/guest.md'), 'utf8'), disk);
  await page.getByRole('button', { name: 'Reload from disk (discard my edits)' }).click();
  await page.waitForFunction(() =>
    (document.querySelector('#editor-source') as HTMLTextAreaElement).value.includes('Changed outside.'),
  );

  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Saved now.');
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('Saved .cohort/personas/guest.md.').waitFor();
  assert.match(await readFile(join(root, '.cohort/personas/guest.md'), 'utf8'), /Saved now\./u);

  await page.goto(`${dashboard.origin}/personas/scripted`);
  await page.getByText('is read-only here').waitFor();
  await page.waitForFunction(() =>
    (document.querySelector('#editor-source') as HTMLTextAreaElement).value.includes('setup:'),
  );
  await source.fill((await source.inputValue()).replace('setup: ../setup/fixture.ts\n', ''));
  await page.getByRole('button', { name: 'Validate and save' }).click();
  await page
    .getByRole('alert')
    .getByText(/read-only/u)
    .waitFor();

  await page.goto(`${dashboard.origin}/personas/hostile`);
  await page.getByRole('link', { name: '<img src=x onerror="window.pwned=1">' }).waitFor();
  assert.equal(await page.evaluate(() => (window as { pwned?: number }).pwned), undefined);
});

test('suite pickers write model and effort into the YAML; ad-hoc runs save to a suite', async () => {
  await page.goto(`${dashboard.origin}/suites/smoke`);
  await page.locator('#entry-0-model').waitFor();
  await page.locator('#entry-0-model').focus();
  await page.keyboard.press('ArrowDown');
  const source = await page.locator('#editor-source').inputValue();
  assert.match(source, /- persona: guest\n {4}model: openai\/priced/u);
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('Saved .cohort/suites/smoke.yml.').waitFor();

  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await page.locator('#run-kind').selectOption('adhoc');
  await page.locator('#run-url').fill(`${fixture.url}/`);
  await page.locator('#run-note').fill('Find the menu.');
  await dialog.getByText('adhoc-first-time-user').waitFor();
  await dialog.getByRole('button', { name: /^Start 1 run$/u }).click();
  await page.getByRole('heading', { name: 'Outcome: completed' }).waitFor();
  await page.locator('#adhoc-suite').selectOption('smoke');
  await page.getByRole('button', { name: 'Preview entry' }).click();
  await page.getByText('It also creates .cohort/personas/adhoc-first-time-user.md').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved to .cohort/suites/smoke.yml.').waitFor();
  const suite = await readFile(join(root, '.cohort/suites/smoke.yml'), 'utf8');
  assert.match(suite, /- persona: adhoc-first-time-user\n {4}goal: Find the menu\./u);
  assert.match(
    await readFile(join(root, '.cohort/personas/adhoc-first-time-user.md'), 'utf8'),
    /^id: adhoc-first-time-user$/mu,
  );

  assert.deepEqual(violations, []);
  assert.ok(!bodies.some((body) => body.includes(KEY)), 'no key in any API response the UI received');
  assert.ok(!(await page.content()).includes(KEY));
});

test('picking a template fills the new-persona draft', async () => {
  await page.goto(`${dashboard.origin}/personas/new`);
  await page.locator('#draft-template').selectOption({ label: 'Template: Mobile shopper on a budget' });
  assert.match(await page.locator('#draft-source').inputValue(), /^id: mobile-shopper$/mu);
  await page.locator('#draft-template').selectOption('');
  assert.match(await page.locator('#draft-source').inputValue(), /^id: new-persona$/mu);
});

test('the persona generator form previews a draft without saving it', async () => {
  turn = () => ({ name: 'write_persona', args: { markdown: PERSONA('drafted', 'Drafted') } });
  await page.goto(`${dashboard.origin}/personas/new`);
  await page.locator('#gen-url').fill(`${fixture.url}/`);
  await page.locator('#gen-description').fill('A first-time visitor.');
  await page.locator('#gen-model').selectOption('openai/priced');
  await page.getByRole('button', { name: 'Generate preview' }).click();
  await page.getByText(/^Draft from openai\/priced; cost \$/u).waitFor();
  assert.match(await page.locator('#draft-source').inputValue(), /^id: drafted$/mu);
  await assert.rejects(readFile(join(root, '.cohort/personas/drafted.md')));
  turn = done;
});

test('typing during a save is kept as unsaved text', async () => {
  await page.goto(`${dashboard.origin}/personas/trial`);
  const source = page.locator('#editor-source');
  await page.waitForFunction(() =>
    (document.querySelector('#editor-source') as HTMLTextAreaElement | null)?.value.includes('You are a guest.'),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/personas/trial', async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.continue();
  });
  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('First part.');
  const sent = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Validate and save' }).click();
  await sent;
  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Second part.');
  release();
  await page.getByText('Saved .cohort/personas/trial.md.').waitFor();
  await page.unroute('**/api/personas/trial');
  assert.match(await source.inputValue(), /First part\. Second part\.$/u);
  const disk = await readFile(join(root, '.cohort/personas/trial.md'), 'utf8');
  assert.ok(disk.endsWith('First part.'), disk);
  await page.getByRole('heading', { name: '.cohort/personas/trial.md (unsaved)' }).waitFor();
});

test('a run view picks up comparison claims added after its own run finished', async () => {
  let runNo = 0;
  const blocker = gate();
  turn = (request, index) => {
    const last = lastStepId(request);
    if (last === 's0000') runNo += 1;
    if (runNo === 1 && last === 's0000')
      return { name: 'scroll', args: { observationId: request.observation.id, target: null, deltaX: 0, deltaY: 200 } };
    return runNo === 2 ? blocker.turn(request, index) : done(request, index);
  };
  const started = await page.evaluate(async (url) => {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionStorage.getItem('cohort-token')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ submission: { selector: { kind: 'persona', id: 'guest' }, url, repeats: 2 } }),
    });
    return (await response.json()) as { runIds: string[] };
  }, `${fixture.url}/`);
  await page.goto(`${dashboard.origin}/runs/${started.runIds[0]}`);
  await blocker.reached;
  await page.getByRole('heading', { name: 'Outcome: completed' }).waitFor();
  await page.getByRole('heading', { name: 'Friction claims (0)' }).waitFor();
  blocker.release();
  await page.getByRole('heading', { name: 'Friction claims (1)' }).waitFor({ timeout: 15_000 });
  turn = done;
});

test('polling while a run is active keeps rows loaded through Load more', async () => {
  const side = new LabDb(join(root, '.cohort/index.sqlite'));
  const template = side.run(side.listRuns(1)[0]!.id);
  side.insertBatch('batch_20260101_000000_pagepg', {});
  const ids = Array.from({ length: 60 }, (_, index) => `run_20260101_000000_p${String(index).padStart(5, '0')}`);
  for (const [index, id] of ids.entries())
    side.insertRun({
      ...template!,
      id,
      batch_id: 'batch_20260101_000000_pagepg',
      entry_index: 0,
      repeat_index: index,
      status: index === 0 ? 'running' : 'finished',
      created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      artifact_dir: `.cohort/runs/${id}`,
    });
  try {
    await page.goto(`${dashboard.origin}/runs`);
    await page.getByRole('button', { name: 'Load more' }).click();
    const rows = page.locator('table.runs tbody tr');
    await page.waitForFunction(() => document.querySelectorAll('table.runs tbody tr').length > 50);
    const loaded = await rows.count();
    await page.waitForResponse((response) => response.url().includes('/api/runs?limit=50&since='));
    await page.waitForTimeout(100);
    assert.equal(await rows.count(), loaded);
  } finally {
    side.updateRun(ids[0]!, { status: 'finished' });
    side.close();
  }
});

test('run headers sort on the server and the filter box narrows rows', async () => {
  await page.goto(`${dashboard.origin}/runs`);
  const cost = page.getByRole('columnheader', { name: 'Cost' });
  assert.equal(await page.getByRole('combobox', { name: 'Sort runs' }).inputValue(), 'created:desc');
  assert.equal(await page.locator('th[aria-sort]').count(), 0);
  const sorted = page.waitForResponse((response) => response.url().includes('sort=cost'));
  await cost.getByRole('button').click();
  await sorted;
  assert.equal(await cost.getAttribute('aria-sort'), 'descending');
  await cost.getByRole('button').click();
  assert.equal(await cost.getAttribute('aria-sort'), 'ascending');
  await page.getByRole('combobox', { name: 'Sort runs' }).selectOption('Mode, descending');
  await page.locator('th[aria-sort="descending"]', { hasText: 'Mode' }).waitFor();
  await page.getByRole('searchbox', { name: 'Search runs' }).fill('no-such-run');
  await page.getByText('No runs match.').waitFor();
});

test('a slow failed response from an abandoned filter does not overwrite the current one', async () => {
  await page.goto(`${dashboard.origin}/runs`);
  await page.locator('table.runs tbody tr').first().waitFor();
  await page.route('**/api/runs?*f=active*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"stale"}' });
  });
  try {
    const settled = page.waitForResponse((response) => response.url().includes('f=active'));
    await page.getByRole('link', { name: /^Active/u }).click();
    await page.getByRole('link', { name: /^All/u }).click();
    await settled;
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.ok((await page.locator('table.runs tbody tr a.rid').count()) > 0);
  } finally {
    await page.unrouteAll();
  }
});

test('polling after Load more drops rows that left the active filter', async () => {
  const side = new LabDb(join(root, '.cohort/index.sqlite'));
  const template = side.run(side.listRuns(1)[0]!.id);
  side.insertBatch('batch_20260101_000000_activf', {});
  const ids = Array.from({ length: 55 }, (_, index) => `run_20260101_000000_a${String(index).padStart(5, '0')}`);
  for (const [index, id] of ids.entries())
    side.insertRun({
      ...template!,
      id,
      batch_id: 'batch_20260101_000000_activf',
      entry_index: 0,
      repeat_index: index,
      status: 'running',
      created_at: `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
      artifact_dir: `.cohort/runs/${id}`,
    });
  try {
    await page.goto(`${dashboard.origin}/runs?f=active`);
    await page.getByRole('button', { name: 'Load more' }).click();
    const rows = page.locator('table.runs tbody tr');
    await page.waitForFunction(() => document.querySelectorAll('table.runs tbody tr').length === 55);
    side.updateRun(ids[0]!, { status: 'finished' });
    await page.waitForFunction(() => document.querySelectorAll('table.runs tbody tr').length === 54);
    assert.equal(await rows.filter({ hasText: ids[0]! }).count(), 0);
  } finally {
    for (const id of ids) side.updateRun(id, { status: 'finished' });
    side.close();
  }
});

test('slow polls never overlap and pagination waits for the pending refresh', async () => {
  const side = new LabDb(join(root, '.cohort/index.sqlite'));
  const template = side.run(side.listRuns(1)[0]!.id);
  const id = 'run_20260101_000000_slowp0';
  side.insertBatch('batch_20260101_000000_slowpl', {});
  side.insertRun({
    ...template!,
    id,
    batch_id: 'batch_20260101_000000_slowpl',
    status: 'running',
    created_at: '2099-01-01T00:00:00.000Z',
    artifact_dir: `.cohort/runs/${id}`,
  });
  let inFlight = 0;
  let peak = 0;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => (started = resolve));
  try {
    await page.goto(`${dashboard.origin}/runs`);
    await page.getByRole('button', { name: 'Load more' }).waitFor();
    await page.route('**/api/runs?*', async (route) => {
      peak = Math.max(peak, ++inFlight);
      started();
      await new Promise((resolve) => setTimeout(resolve, 3500));
      inFlight -= 1;
      await route.continue();
    });
    await pending;
    assert.ok(await page.getByRole('button', { name: 'Load more' }).isDisabled());
    side.updateRun(id, { status: 'finished' });
    await page
      .locator('table.runs tbody tr', { hasText: id })
      .getByText('running', { exact: true })
      .waitFor({ state: 'detached', timeout: 15_000 });
    assert.equal(peak, 1);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    side.updateRun(id, { status: 'finished' });
    side.close();
  }
});

test('narrow layouts keep column headers for screen readers without hidden sort buttons', async () => {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 800 });
  try {
    await page.goto(`${dashboard.origin}/runs`);
    await page.getByRole('combobox', { name: 'Sort runs' }).waitFor();
    assert.equal(await page.getByRole('columnheader', { name: 'Cost' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /^Cost/u }).count(), 0);
  } finally {
    if (size) await page.setViewportSize(size);
  }
});
