import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenshotToCss, renderLocator } from '../../src/browser/targets.ts';
import { CostMeter, estimateCostUsd } from '../../src/core/cost.ts';
import { BUILTIN_TOOLS, validateToolCall } from '../../src/core/tools.ts';
import { generateReplay } from '../../src/evidence/replay.ts';
import type { StepRecord } from '../../src/evidence/steps.ts';
import type { Usage } from '../../src/providers/types.ts';
import { redactValue, safeUrl, SecretStore } from '../../src/setup/secrets.ts';

const usage = (inputTokens: number, outputTokens: number, extra: Partial<Usage> = {}): Usage => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: null,
  imageInputTokens: null,
  reportedCostUsd: null,
  source: 'provider',
  ...extra,
});

test('tool schemas accept canonical calls and reject drift', () => {
  assert.equal(BUILTIN_TOOLS.length, 10);
  const point = { kind: 'point', x: 10, y: 20 };
  assert.equal(validateToolCall({ name: 'click', args: { observationId: 'o0001', target: point } }), null);
  assert.equal(
    validateToolCall({ name: 'fill', args: { observationId: 'o0001', target: point, value: '{{email}}' } }),
    null,
  );
  assert.equal(validateToolCall({ name: 'press', args: { observationId: 'o0001', key: 'Enter' } }), null);
  assert.equal(validateToolCall({ name: 'done', args: { step: 's0003', summary: 'Shown.' } }), null);
  assert.match(validateToolCall({ name: 'hover', args: {} }) ?? '', /unknown tool/u);
  assert.notEqual(validateToolCall({ name: 'click', args: { observationId: 'o0001', target: point, extra: 1 } }), null);
  assert.notEqual(validateToolCall({ name: 'click', args: { observationId: 'x', target: point } }), null);
  assert.notEqual(validateToolCall({ name: 'press', args: { observationId: 'o0001', key: 'Meta+Q' } }), null);
  assert.notEqual(
    validateToolCall({ name: 'report_blocked', args: { kind: 'magic', step: 's0001', reason: 'r' } }),
    null,
  );
  assert.notEqual(
    validateToolCall({ name: 'click', args: { observationId: 'o0001', target: { kind: 'point', x: -1, y: 2 } } }),
    null,
  );
});

test('cost estimates never treat an unknown price as zero', () => {
  const prices = { input: 2, output: 10, cachedInput: 0.2 };
  assert.equal(estimateCostUsd(usage(1_000_000, 100_000), prices), 3);
  assert.equal(estimateCostUsd(usage(1_000_000, 0, { cachedInputTokens: 500_000 }), prices), 1.1);
  assert.equal(estimateCostUsd(usage(10, 10), { input: null, output: 10, cachedInput: 0 }), null);
  assert.equal(
    estimateCostUsd(usage(10, 10, { cachedInputTokens: 5 }), { input: 1, output: 1, cachedInput: null }),
    null,
  );
});

test('cost meter reserves before calls and keeps unsettled reservations', () => {
  const meter = new CostMeter(0.01, { input: 1, output: 4, cachedInput: 0.1 });
  assert.equal(meter.enforcement, 'priced_reservations');
  const reserved = meter.reserve(4000, 500);
  assert.equal(reserved, 0.006);
  meter.settle(reserved!, null);
  assert.equal(meter.spentUsd, 0.006);
  assert.equal(meter.reserve(4000, 500), null);
  meter.settle(0, usage(4000, 0));
  assert.ok(meter.exhausted);

  const unpriced = new CostMeter(1, { input: null, output: null, cachedInput: null });
  assert.equal(unpriced.enforcement, 'step_time_only');
  assert.equal(unpriced.reserve(1e9, 1e9), 0);
  unpriced.settle(0, usage(1, 1, { reportedCostUsd: 1.5 }));
  assert.equal(unpriced.enforcement, 'provider_reported_cost');
  assert.equal(unpriced.reserve(1, 1), null);
  assert.ok(unpriced.exhausted);
});

test('secret store binds, substitutes, and redacts longest first', () => {
  const secrets = new SecretStore();
  assert.equal(secrets.bind('email', 'ana@example.test'), '{{email}}');
  secrets.bind('user', 'ana@example');
  assert.throws(() => secrets.bind('Bad', 'value'), /invalid secret name/u);
  assert.throws(() => secrets.bind('pin', '123'), /shorter/u);
  assert.equal(secrets.substitute('to {{email}}'), 'to ana@example.test');
  assert.throws(() => secrets.substitute('{{missing}}'), /unknown secret placeholder/u);
  assert.equal(secrets.redact('mail ana@example.test now'), 'mail {{email}} now');
  assert.ok(secrets.contains('xx ana@example yy'));
  assert.ok(secrets.hasPlaceholder('{{user}}'));
});

test('safe URLs drop queries and fragments and redact path secrets', () => {
  const secrets = new SecretStore();
  secrets.bind('token', 'tok-abc-123');
  assert.equal(safeUrl('https://a.test/p/tok-abc-123?x=1#tok-abc-123', secrets), 'https://a.test/p/{{token}}');
  assert.equal(safeUrl('not a url', secrets), '[invalid url]');
});

test('screenshot points scale to CSS pixels and reject out-of-image points', () => {
  const image = { width: 1024, height: 2216 };
  const viewport = { width: 390, height: 844 };
  assert.deepEqual(screenshotToCss({ x: 512, y: 1108 }, image, viewport), { x: 195, y: 422 });
  assert.deepEqual(screenshotToCss({ x: 0, y: 0 }, image, viewport), { x: 0, y: 0 });
  assert.equal(screenshotToCss({ x: 1024, y: 0 }, image, viewport), null);
  assert.equal(screenshotToCss({ x: -1, y: 5 }, image, viewport), null);
});

test('rendered locators keep model-influenced strings as JSON literals', () => {
  const hostile = 'Pay"); process.exit(1); ("';
  const source = renderLocator({
    frames: [{ by: 'id', id: 'pay"frame' }],
    target: { by: 'role', role: 'button', name: hostile },
  });
  assert.equal(
    source,
    `page.locator(${JSON.stringify('[id="pay\\"frame"]')}).contentFrame().getByRole("button", { name: ${JSON.stringify(hostile)}, exact: true })`,
  );
  assert.equal(renderLocator({ frames: [], target: { by: 'css', selector: 'a >> b' } }), 'page.locator("a >> b")');
});

const step = (id: string, action: StepRecord['action'], extra: Partial<StepRecord> = {}): StepRecord => ({
  schemaVersion: 1,
  runId: 'run_1',
  id,
  sequence: Number(id.slice(1)),
  startedAt: '2026-10-28T00:00:00.000Z',
  elapsedMs: 0,
  durationMs: 0,
  observationId: 'o0000',
  action,
  result: { status: 'ok' },
  beforeScreenshotId: null,
  afterScreenshotId: null,
  pageUrl: 'http://localhost/',
  ...extra,
});

const target = (tag: string): StepRecord['target'] => ({
  locator: { frames: [], target: { by: 'label', text: 'Email' } },
  stability: 'semantic',
  position: { x: 4, y: 5.5 },
  tag,
});

test('generated replay binds secrets from the environment and skips failed steps', () => {
  const script = generateReplay(
    {
      runId: 'run_1',
      viewport: { width: 390, height: 844 },
      hasTouch: false,
      locale: 'sl-SI',
      timezone: 'Europe/Ljubljana',
    },
    [
      step('s0000', { name: 'navigate', args: {} }),
      step('s0001', { name: 'fill', args: { value: '{{email}}' } }, { target: target('input') }),
      step('s0002', { name: 'fill', args: { value: 'Evening' } }, { target: target('select') }),
      step('s0003', { name: 'click', args: {} }, { target: target('button') }),
      step('s0004', { name: 'press', args: { key: 'Enter' } }),
      step(
        's0005',
        { name: 'click', args: {} },
        { target: target('button'), result: { status: 'error', code: 'tool_error', message: 'x' } },
      ),
    ],
  );
  assert.match(script, /page\.goto\(binding\('LAB_START_URL'\)\)/u);
  assert.match(script, /getByLabel\("Email", \{ exact: true \}\)\.fill\(bind\("\{\{email\}\}"\)\)/u);
  assert.match(script, /selectOption\(\{ label: "Evening" \}\)/u);
  assert.match(script, /\.click\(\{ position: \{"x":4,"y":5\.5\} \}\)/u);
  assert.match(script, /keyboard\.press\("Enter"\)/u);
  assert.ok(!script.includes('s0005'));
  assert.ok(!script.includes('screenshot'), 'replay must not write unmasked images');
  assert.match(
    script,
    /locale: "sl-SI",\n  timezoneId: "Europe\/Ljubljana",\n  \.\.\.\(process.env.LAB_STORAGE_STATE/u,
  );
});

test('a priced call whose cached rate is unknown keeps its reservation', () => {
  const meter = new CostMeter(1, { input: 1, output: 1, cachedInput: null });
  const reserved = meter.reserve(1000, 100)!;
  meter.settle(reserved, usage(1000, 100, { cachedInputTokens: 500 }));
  assert.equal(meter.unsettledUsd, reserved);
  assert.equal(meter.spentUsd, reserved);
});

test('rebinding a secret keeps redacting and masking the old value', () => {
  const secrets = new SecretStore();
  secrets.bind('totp', '111111');
  secrets.bind('totp', '222222');
  assert.equal(secrets.substitute('{{totp}}'), '222222');
  assert.deepEqual(secrets.values, ['111111', '222222']);
  assert.equal(secrets.redact('old 111111'), 'old {{totp}}');
});

test('structured redaction handles numeric secrets without breaking JSON', () => {
  const secrets = new SecretStore();
  secrets.bind('code', '1234');
  assert.deepEqual(redactValue({ ms: 1234, target: { x: 12345, y: 7 }, note: 'pin 1234' }, secrets), {
    ms: '{{code}}',
    target: { x: '{{code}}5', y: 7 },
    note: 'pin {{code}}',
  });
});

test('structured redaction covers keys, and a redacted number never replays as NaN', () => {
  const secrets = new SecretStore();
  secrets.bind('code', '1234');
  assert.deepEqual(redactValue({ 'key-1234': 'x' }, secrets), { 'key-{{code}}': 'x' });
  const args = redactValue({ ms: 1234 }, secrets) as Record<string, unknown>;
  const script = generateReplay(
    { runId: 'run_1', viewport: { width: 390, height: 844 }, hasTouch: false, locale: 'en', timezone: 'UTC' },
    [step('s0001', { name: 'wait', args })],
  );
  assert.ok(!script.includes('NaN'), script);
  assert.match(script, /throw new Error\("s0001: argument ms was redacted/u);
});

test('cached tokens above input tokens are not priced as negative spend', () => {
  const prices = { input: 1, output: 1, cachedInput: 0.1 };
  assert.equal(estimateCostUsd(usage(100, 0, { cachedInputTokens: 1000 }), prices), null);
  const meter = new CostMeter(1, prices);
  const reserved = meter.reserve(1000, 100)!;
  meter.settle(reserved, usage(100, 0, { cachedInputTokens: 1000 }));
  assert.equal(meter.spentUsd, reserved);
});
