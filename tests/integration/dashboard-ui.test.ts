import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { startDashboard, type Dashboard } from '../../src/dashboard/server.ts';
import { startFixture, type FixtureServer } from '../../fixtures/friction-app/server.ts';
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
    '.lab/config.yml',
    'schemaVersion: 1\nmodel: openai/priced\nrepeats: 1\nlimits: { steps: 5, timeMs: 30000 }\n',
  );
  await put(
    '.lab/models.yml',
    `version: test\nmodels:\n${[
      model('priced', true, 1, false),
      model('unpriced', true, null, false),
      model('fresh', true, 1, true),
      model('blind', false, 1, false),
      model('claude', true, 1, false, 'anthropic'),
    ].join('')}`,
  );
  await put('.lab/personas/guest.md', PERSONA('guest', 'Guest'));
  await put('.lab/personas/hostile.md', PERSONA('hostile', '<img src=x onerror="window.pwned=1">'));
  await put('.lab/setup/fixture.ts', 'export default async () => ({});\n');
  await put('.lab/personas/scripted.md', PERSONA('scripted', 'Scripted', 'setup: ../setup/fixture.ts\n'));
  await put('.lab/suites/smoke.yml', 'schemaVersion: 1\nid: smoke\nname: Smoke\nentries:\n  - persona: guest\n');
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
  assert.equal(new URL(page.url()).hash, '#/runs');
  assert.ok(!page.url().includes(dashboard.token));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('lab-token')), dashboard.token);

  const stranger = await browser.newPage();
  await stranger.goto(dashboard.origin);
  await stranger.getByText('Open the launch URL').waitFor();
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
  await dialog
    .getByRole('alert')
    .getByText(/untested/u)
    .waitFor();
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
  await page.waitForURL(/#\/runs\/run_/u);
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

  await page.goto(`${dashboard.origin}/#/runs`);
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
      headers: { authorization: `Bearer ${sessionStorage.getItem('lab-token')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: { selector: { kind: 'persona', id: 'guest' }, url } }),
    });
    return (await response.json()) as { runIds: string[] };
  }, `${fixture.url}/`);
  await page.goto(`${dashboard.origin}/#/runs/${started.runIds[0]}`);
  await blocker.reached;
  await page.getByRole('button', { name: 'Cancel run' }).focus();
  await page.keyboard.press('Enter');
  blocker.release();
  turn = done;
  await page.getByRole('heading', { name: 'Outcome: agent_error' }).waitFor();
  await page.getByText('(interrupted by user)').waitFor();
});

test('persona edits keep the user text on a revision conflict and keep setup read-only', async () => {
  await page.goto(`${dashboard.origin}/#/personas/guest`);
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
  await writeFile(join(root, '.lab/personas/guest.md'), disk);
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('changed on disk since you opened it').waitFor();
  assert.match(await source.inputValue(), /Edited in the dashboard\./u);
  assert.equal(await readFile(join(root, '.lab/personas/guest.md'), 'utf8'), disk);
  await page.getByRole('button', { name: 'Reload from disk (discard my edits)' }).click();
  await page.waitForFunction(() =>
    (document.querySelector('#editor-source') as HTMLTextAreaElement).value.includes('Changed outside.'),
  );

  await source.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Saved now.');
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('Saved .lab/personas/guest.md.').waitFor();
  assert.match(await readFile(join(root, '.lab/personas/guest.md'), 'utf8'), /Saved now\./u);

  await page.goto(`${dashboard.origin}/#/personas/scripted`);
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

  await page.goto(`${dashboard.origin}/#/personas/hostile`);
  await page.getByRole('link', { name: '<img src=x onerror="window.pwned=1">' }).waitFor();
  assert.equal(await page.evaluate(() => (window as { pwned?: number }).pwned), undefined);
});

test('suite pickers write model and effort into the YAML; ad-hoc runs save to a suite', async () => {
  await page.goto(`${dashboard.origin}/#/suites/smoke`);
  await page.locator('#entry-0-model').waitFor();
  await page.locator('#entry-0-model').focus();
  await page.keyboard.press('ArrowDown');
  const source = await page.locator('#editor-source').inputValue();
  assert.match(source, /- persona: guest\n {4}model: openai\/priced/u);
  await tabTo('Validate and save');
  await page.keyboard.press('Enter');
  await page.getByText('Saved .lab/suites/smoke.yml.').waitFor();

  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByRole('dialog', { name: 'New run' });
  await page.locator('#run-kind').selectOption('adhoc');
  await page.locator('#run-url').fill(`${fixture.url}/`);
  await page.locator('#run-note').fill('Find the menu.');
  await dialog.getByText('adhoc-first-time-user').waitFor();
  await dialog.getByRole('button', { name: /^Start 1 run$/u }).click();
  await page.getByRole('heading', { name: 'Outcome: completed' }).waitFor();
  await page.getByRole('button', { name: 'Preview entry' }).click();
  await page.getByText('It also creates .lab/personas/adhoc-first-time-user.md').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Saved to .lab/suites/smoke.yml.').waitFor();
  const suite = await readFile(join(root, '.lab/suites/smoke.yml'), 'utf8');
  assert.match(suite, /- persona: adhoc-first-time-user\n {4}goal: Find the menu\./u);
  assert.match(
    await readFile(join(root, '.lab/personas/adhoc-first-time-user.md'), 'utf8'),
    /^id: adhoc-first-time-user$/mu,
  );

  assert.deepEqual(violations, []);
  assert.ok(!bodies.some((body) => body.includes(KEY)), 'no key in any API response the UI received');
  assert.ok(!(await page.content()).includes(KEY));
});
