import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { runOnce, type RunOnceOptions } from '../../src/core/engine.ts';
import type { DecideRequest } from '../../src/providers/types.ts';
import { SecretStore } from '../../src/setup/secrets.ts';
import { startFixture, type FixtureServer } from '../fixtures/friction-app/server.ts';
import { fakeProvider, lastStepId, type Turn } from '../helpers/fake-provider.ts';

const repoRoot = new URL('../..', import.meta.url).pathname;
const EMAIL = 'ana.canary@example.test';
const TOKEN = 'tok-canary-98765';
const TOTP = '482913';
const QUOTED = 'K"9\\z';
const CONTROL = 'Ctl\x01Key9';
let fixture: FixtureServer;
let dir: string;

before(async () => {
  fixture = await startFixture();
  dir = await mkdtemp(join(tmpdir(), 'lab-text-'));
});
after(async () => {
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
});

// The fake model reads refs from the snapshot text, as a real text-mode model would.
function ref(request: DecideRequest, role: string, name: string): { kind: 'ref'; ref: string } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*?\\[ref=((?:f\\d+)?e\\d+)\\]`, 'u').exec(
    request.observation.text,
  );
  if (!match?.[1]) throw new Error(`no ${role} "${name}" in snapshot:\n${request.observation.text}`);
  return { kind: 'ref', ref: match[1] };
}

const act =
  (name: string, extra: (request: DecideRequest) => Record<string, unknown> = () => ({})): Turn =>
  (request) => ({ name, args: { observationId: request.observation.id, ...extra(request) } });
const done: Turn = (request) => ({ name: 'done', args: { step: lastStepId(request), summary: 'Done.' } });

async function textRun(name: string, path: string, turns: Turn[], overrides: Partial<RunOnceOptions> = {}) {
  const secrets = new SecretStore();
  secrets.bind('guest_name', 'Ana Novak');
  secrets.bind('email', EMAIL);
  secrets.bind('token', TOKEN);
  secrets.bind('totp', TOTP);
  secrets.bind('quoted', QUOTED);
  secrets.bind('control', CONTROL);
  const provider = fakeProvider(turns);
  const outDir = join(dir, name);
  const result = await runOnce({
    runId: `run_text_${name}`,
    outDir,
    mode: 'text',
    provider,
    model: 'fake-model',
    effort: 'low',
    prices: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 },
    task: 'Do the task.',
    startUrl: `${fixture.url}${path}`,
    allowedOrigins: [],
    secrets,
    limits: { steps: 30, timeMs: 60_000, dollars: 2 },
    device: { viewport: { width: 800, height: 1000 }, touch: false },
    locale: 'en-US',
    timezone: 'UTC',
    ...overrides,
  });
  const outbound = JSON.stringify(
    provider.requests.map((request) => [request.instructions, request.history, request.observation]),
  );
  const steps = await readFile(join(outDir, 'steps.jsonl'), 'utf8');
  const replay = await readFile(result.replayPath, 'utf8');
  return { result, provider, outDir, outbound, steps, replay };
}

async function replays(outDir: string, startUrl: string, env: Record<string, string> = {}): Promise<string> {
  await symlink(join(repoRoot, 'node_modules'), join(outDir, 'node_modules'));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(repoRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=line', 'replay.spec.ts'],
    { cwd: outDir, env: { ...process.env, COHORT_START_URL: startUrl, ...env } },
  );
  return stdout;
}

test('a text-mode journey acts by ref, never sends an image or a secret, and its replay passes', async () => {
  const { result, provider, outDir, outbound, steps, replay } = await textRun('journey', '/?scope=text', [
    act('click', (r) => ({ target: ref(r, 'link', 'Arrival instructions') })),
    act('click', (r) => ({ target: ref(r, 'link', 'Request early check-in') })),
    act('fill', (r) => ({ target: ref(r, 'textbox', 'Your name'), value: '{{guest_name}}' })),
    act('fill', (r) => ({ target: ref(r, 'combobox', 'Arrival time'), value: 'Afternoon' })),
    act('click', (r) => ({ target: ref(r, 'button', 'Review request') })),
    act('click', (r) => ({ target: ref(r, 'button', 'Send request') })),
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.deepEqual(fixture.submissions('text'), [{ name: 'Ana Novak', arrival: 'Afternoon', notes: '' }]);
  assert.ok(provider.requests.every((request) => request.observation.kind === 'text'));
  assert.ok(!outbound.includes('pngBase64'));
  assert.ok(provider.requests.some((request) => request.observation.text.includes('option "Afternoon"')));
  const targeted = result.steps.filter((step) => step.target);
  assert.equal(targeted.length, 6);
  assert.ok(targeted.every((step) => step.target?.stability === 'semantic' && !step.target.screenshotPoint));
  for (const text of [outbound, steps, replay]) assert.ok(!text.includes('Ana Novak'), 'secret value leaked');
  assert.match(
    await replays(outDir, `${fixture.url}/?scope=text-replay`, { COHORT_SECRET_GUEST_NAME: 'Ana Novak' }),
    /1 passed/u,
  );
  assert.deepEqual(fixture.submissions('text-replay'), [{ name: 'Ana Novak', arrival: 'Afternoon', notes: '' }]);
});

test('text mode lists and selects options, answers dialogs, reports file choosers, and rejects points', async () => {
  const seen: string[] = [];
  const note: Turn = (request) => {
    seen.push(request.observation.text);
    return { name: 'wait', args: { ms: 100 } };
  };
  const { result, outDir, replay } = await textRun('native', '/lab/native', [
    act('click', () => ({ target: { kind: 'point', x: 10, y: 10 } })),
    act('fill', (r) => ({ target: ref(r, 'combobox', 'Arrival time'), value: 'Evening' })),
    act('click', (r) => ({ target: ref(r, 'button', 'Show alert') })),
    note,
    act('click', () => ({ target: { kind: 'ref', ref: 'e1' } })),
    act('dialog', () => ({ action: 'accept' })),
    act('click', (r) => ({ target: ref(r, 'button', 'Upload ID') })),
    note,
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  const codes = result.steps.map(
    (step) => `${step.action.name}:${step.result.status === 'ok' ? 'ok' : step.result.code}`,
  );
  assert.deepEqual(codes, [
    'navigate:ok',
    'click:point_in_text_mode',
    'fill:ok',
    'click:ok',
    'wait:dialog_open',
    'click:dialog_open',
    'dialog:ok',
    'click:ok',
    'wait:ok',
    'done:ok',
  ]);
  assert.match(seen[0]!, /alert dialog is open: "Alert text"/u);
  assert.match(seen[1]!, /file chooser opened and was cancelled/u);
  assert.match(seen[1]!, /alert closed/u);
  assert.equal(result.steps.find((step) => step.action.name === 'fill')?.target?.tag, 'select');
  assert.match(replay, /selectOption\(\{ label: "Evening" \}\)/u);
  assert.match(replay, /\{"step":"s0003","type":"alert","message":"Alert text","accept":true,"text":null\}/u);
  assert.match(await replays(outDir, `${fixture.url}/lab/native`), /1 passed/u);
});

test('text snapshots hide secrets, filled fields, masked selectors, and frame contents', async () => {
  const { result, outbound, steps } = await textRun(
    'canary',
    `/lab/canary#${TOKEN}`,
    [
      act('fill', (r) => ({ target: ref(r, 'textbox', 'Email'), value: '{{email}}' })),
      act('fill', (r) => ({ target: ref(r, 'textbox', 'One-time code'), value: '{{totp}}' })),
      done,
    ],
    { maskSelectors: ['#reference'] },
  );
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  for (const text of [outbound, steps]) for (const secret of [EMAIL, TOKEN, TOTP]) assert.ok(!text.includes(secret));
  assert.match(outbound, /textbox \[ref=(f\d+)?e\d+\]: \[masked\]/u);
  assert.match(outbound, /iframe: \[frame content is not shown in text mode\]/u);
  assert.match(outbound, /Nothing secret here/u);
});

test('text-mode dialogs: confirm, prompt, and timer dialogs are answered in order and replay keyed to their steps', async () => {
  const { result, provider, outDir, outbound, steps, replay } = await textRun(
    'dialogs',
    '/lab/dialogs?scope=text-dialogs',
    [
      act('click', (r) => ({ target: ref(r, 'button', 'Ask confirm') })),
      act('dialog', () => ({ action: 'dismiss' })),
      act('click', (r) => ({ target: ref(r, 'button', 'Ask prompt') })),
      act('dialog', () => ({ action: 'accept', text: '{{email}}' })),
      act('click', (r) => ({ target: ref(r, 'button', 'Alert later') })),
      act('dialog', () => ({ action: 'accept' })),
      act('click', () => ({ target: { kind: 'ref', ref: 'e999' } })),
      done,
    ],
  );
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  const codes = result.steps.map(
    (step) => `${step.action.name}:${step.result.status === 'ok' ? 'ok' : step.result.code}`,
  );
  assert.deepEqual(codes, [
    'navigate:ok',
    'click:ok',
    'dialog:ok',
    'click:ok',
    'dialog:ok',
    'click:ok',
    'dialog:ok',
    'click:unknown_ref',
    'done:ok',
  ]);
  const texts = provider.requests.map((request) => request.observation.text);
  assert.match(texts[1]!, /confirm dialog is open: "Proceed\?"/u);
  assert.match(texts[2]!, /confirm: false/u);
  assert.match(texts[3]!, /prompt dialog is open/u);
  assert.match(texts[4]!, /prompt: \[redacted\]/u);
  assert.match(texts[5]!, /alert dialog is open: "Later"/u);
  assert.match(texts[0]!, /button "Key \[redacted\]"/u);
  assert.deepEqual(
    result.steps.filter((step) => step.dialog).map((step) => step.dialog),
    [
      { type: 'confirm', message: 'Proceed?', openedBy: 's0001' },
      { type: 'prompt', message: 'Your email?', openedBy: 's0003' },
      { type: 'alert', message: 'Later', openedBy: 's0005' },
    ],
  );
  assert.deepEqual(fixture.dialogResults('text-dialogs'), ['confirm: false', `prompt: ${EMAIL}`, 'later closed']);
  for (const leak of [EMAIL, QUOTED, JSON.stringify(QUOTED).slice(1, -1), 'Ctl', 'abc12345', 'frag-xyz', 'Sentinel'])
    for (const text of [outbound, texts.join('\n'), steps, replay]) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.match(outbound, /\/url: \/lab\/dialogs\\n/u);
  assert.match(replay, /"text":"\{\{email\}\}"/u);
  assert.match(
    await replays(outDir, `${fixture.url}/lab/dialogs?scope=text-dialogs-replay`, { COHORT_SECRET_EMAIL: EMAIL }),
    /1 passed/u,
  );
  assert.deepEqual(fixture.dialogResults('text-dialogs-replay'), [
    'confirm: false',
    `prompt: ${EMAIL}`,
    'later closed',
  ]);
});

test('masked text that reaches another name through aria-labelledby is masked everywhere', async () => {
  const inline = await textRun('labelledby-inline', '/lab/dialogs', [done], { maskSelectors: ['#code-label'] });
  assert.equal(inline.result.outcome.state, 'completed', JSON.stringify(inline.result.outcome));
  assert.ok(!inline.provider.requests[0]!.observation.text.includes('7731'));
  assert.match(inline.provider.requests[0]!.observation.text, /button "\[masked\]"/u);
  const short = await textRun('labelledby-short', '/lab/dialogs', [done], { maskSelectors: ['#tip'] });
  assert.equal(short.result.outcome.state, 'completed', JSON.stringify(short.result.outcome));
  assert.ok(!short.provider.requests[0]!.observation.text.includes('Tip'));
  const { result, provider } = await textRun('labelledby', '/lab/dialogs', [done], { maskSelectors: ['#note'] });
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.ok(!provider.requests[0]!.observation.text.includes('5512'));
});

test('short masked text that also appears elsewhere does not refuse the snapshot', async () => {
  const { result, provider } = await textRun('short', '/lab/dialogs', [done], { maskSelectors: ['#short'] });
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.match(provider.requests[0]!.observation.text, /button "Ask confirm"/u);
  assert.ok(!provider.requests[0]!.observation.text.includes('Pay'));
  assert.match(provider.requests[0]!.observation.text, /button "\[masked\]Pal"/u);
});

test('a control changed after the observation is rejected as a stale target', async () => {
  let page: Page | undefined;
  const { result } = await textRun(
    'stale',
    '/lab/dialogs?scope=text-stale',
    [
      async (request, index) => {
        const target = ref(request, 'button', 'Ask confirm');
        await page!.getByRole('button', { name: 'Ask confirm' }).evaluate((button) => {
          button.textContent = 'Delete everything';
        });
        return act('click', () => ({ target }))(request, index);
      },
      done,
    ],
    { onPage: (created) => (page = created) },
  );
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.equal(result.steps[1]?.result.status === 'ok' ? 'ok' : result.steps[1]?.result.code, 'stale_target');
  assert.deepEqual(fixture.dialogResults('text-stale'), []);
});

test('an alert that opens during the first page load is surfaced and answered', async () => {
  const { result, provider } = await textRun('onload', '/lab/onload-alert', [
    act('dialog', () => ({ action: 'accept' })),
    done,
  ]);
  assert.equal(result.outcome.state, 'completed', JSON.stringify(result.outcome));
  assert.match(provider.requests[0]!.observation.text, /alert dialog is open: "Welcome aboard"/u);
  assert.match(provider.requests[1]!.observation.text, /Loaded after the alert/u);
  assert.deepEqual(result.steps[1]?.dialog, { type: 'alert', message: 'Welcome aboard', openedBy: 's0000' });
});
