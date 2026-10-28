import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Outcome } from '../../src/core/outcomes.ts';
import { BundleError, bundleDir } from '../../src/evidence/bundle.ts';
import { deriveClaims, validateClaim } from '../../src/evidence/friction.ts';
import { inventory, writeAtomic, writeManifest } from '../../src/evidence/manifest.ts';
import { generateReplay, replayGaps } from '../../src/evidence/replay.ts';
import {
  buildBatchReport,
  costText,
  rateText,
  renderRunHtml,
  renderRunMarkdown,
  type RunReport,
} from '../../src/evidence/report.ts';
import type { StepRecord } from '../../src/evidence/steps.ts';
import { redactValue, SecretStore } from '../../src/setup/secrets.ts';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-report-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const shot = (n: number): string => `shot-${String(n).padStart(4, '0')}`;
function step(
  sequence: number,
  name: string,
  args: Record<string, unknown>,
  extra: Partial<StepRecord> = {},
): StepRecord {
  return {
    schemaVersion: 1,
    runId: 'run_a',
    id: `s${String(sequence).padStart(4, '0')}`,
    sequence,
    startedAt: '2026-10-28T09:00:00.000Z',
    elapsedMs: sequence * 1000,
    durationMs: 200,
    observationId: `o${String(sequence).padStart(4, '0')}`,
    action: { name, args },
    result: { status: 'ok' },
    beforeScreenshotId: sequence === 0 ? null : shot(sequence - 1),
    afterScreenshotId: shot(sequence),
    pageUrl: 'http://app.test/',
    ...extra,
  };
}

const click = { observationId: 'o0001', target: { kind: 'point', x: 10, y: 20 } };
const steps: StepRecord[] = [
  step(0, 'navigate', { url: 'http://app.test/' }),
  step(1, 'click', click, { pageUrl: 'http://app.test/a' }),
  step(
    2,
    'click',
    { target: { y: 20, kind: 'point', x: 10 }, observationId: 'o0002' },
    { pageUrl: 'http://app.test/' },
  ),
  step(3, 'fill', { observationId: 'o0003', target: click.target, value: 'x' }, { durationMs: 6200 }),
  step(4, 'report_friction', { step: 's0003', reason: 'Slow form.' }, { afterScreenshotId: null }),
  step(5, 'wait', { ms: 5000 }, { durationMs: 5100 }),
];

test('harness claims measure observed events; agent claims stay opinions with cited evidence', () => {
  const claims = deriveClaims('run_a', steps);
  assert.deepEqual(
    claims.map((claim) => claim.kind),
    ['opinion', 'long_pause', 'repeated_action', 'backtrack'],
  );
  for (const claim of claims) assert.equal(validateClaim(claim, 'run_a', steps), null, claim.id);
  const [opinion, pause, repeated, backtrack] = claims as any[];
  assert.deepEqual(opinion.opinion, { reportingStepId: 's0004', reason: 'Slow form.' });
  assert.deepEqual(opinion.evidence, [{ stepId: 's0003', screenshotId: shot(3) }]);
  assert.deepEqual(pause.measurement, { durationMs: 6200, thresholdMs: 5000, basis: 'page_wait' });
  assert.equal(repeated.measurement.count, 2);
  assert.deepEqual(backtrack.measurement, { fromStepId: 's0002', toStepId: 's0000', count: 1 });
});

test('claim validation rejects unknown fields, missing evidence, cross-run references, and unknown screenshots', () => {
  const [claim] = deriveClaims('run_a', steps);
  const cases: [unknown, RegExp][] = [
    [{ ...claim, severity: 3 }, /must match exactly one schema/u],
    [{ ...claim, evidence: [] }, /must match exactly one schema/u],
    [claim, /belongs to run run_a/u],
    [
      { ...claim, evidence: [{ stepId: 's0003', screenshotId: shot(9) }] },
      /screenshot shot-0009 is not part of step s0003/u,
    ],
    [{ ...claim, evidence: [{ stepId: 's0042', screenshotId: shot(1) }] }, /unknown step s0042/u],
    [{ ...claim, opinion: { reportingStepId: 's0099', reason: 'x' } }, /unknown step s0099/u],
  ];
  for (const [value, expected] of cases)
    assert.match(validateClaim(value, value === claim ? 'run_b' : 'run_a', steps) ?? '', expected);
});

const catalog = {
  version: 'v1',
  hash: 'sha256:abc',
  entry: {
    id: 'm',
    provider: 'openai',
    label: 'm',
    visionCapable: true,
    supportedEffortLevels: ['low'],
    defaultEffort: 'low',
    pricesPerMTok: { input: 1, output: 4, cachedInput: null },
    pricingVerifiedAt: null,
    untested: false,
  },
} as unknown as RunReport['catalog'];

function report(runId: string, outcome: Outcome, overrides: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    runId,
    batchId: 'batch_x',
    personaId: 'guest',
    goal: 'Book a stay.',
    mode: 'vision',
    provider: 'openai',
    requestedModel: 'm',
    effort: 'low',
    catalog,
    returnedModel: null,
    startedAt: '2026-10-28T09:00:00.000Z',
    durationMs: 1000,
    steps: 2,
    browserActions: 1,
    outcome,
    friction: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: null,
      imageInputTokens: null,
      providerReportedCostUsd: null,
      estimatedCostUsd: 0.5,
      reservedUnsettledCostUsd: 0,
      pricingVerifiedAt: null,
      accounting: 'estimated',
      capEnforcement: 'priced_reservations',
    },
    replay: { path: 'replay.spec.ts', status: 'not_attempted' },
    issues: [],
    manifestPath: 'manifest.json',
    ...overrides,
  };
}

const evidence = [{ stepId: 's0001', screenshotId: shot(1) }];
const completed: Outcome = { state: 'completed', reason: 'ok', evidence, verification: 'agent_reported' };
const blocked = (detectedBy: 'agent' | 'harness'): Outcome => ({
  state: 'blocked',
  kind: 'captcha',
  detectedBy,
  reason: 'captcha',
  evidence,
});
const interrupted = (by: 'user' | 'process'): Outcome => ({
  state: 'agent_error',
  code: 'interrupted',
  interruptedBy: by,
  reason: 'stop',
  evidence: [],
});

test('batch completion excludes blocked runs and user cancellations; process interruption is an agent error', () => {
  const summary = buildBatchReport(
    'batch_x',
    [
      report('r1', completed),
      report('r2', blocked('agent')),
      report('r3', blocked('harness')),
      report('r4', interrupted('user')),
      report('r5', interrupted('process')),
      report('r6', { state: 'limit_reached', limit: 'steps', reason: 'x', observed: 40, maximum: 40, evidence }),
      report('r7', completed, { requestedModel: 'other' }),
      report(
        'r8',
        { state: 'abandoned', reason: 'x', initiatedBy: 'agent', evidence },
        {
          usage: { ...report('r', completed).usage, estimatedCostUsd: null, capEnforcement: 'step_time_only' },
        },
      ),
    ],
    1,
  );
  const [main, other] = summary.groups;
  assert.equal(summary.groups.length, 2, 'different models never share a comparison');
  assert.deepEqual(main!.completion, { numerator: 1, denominator: 4, rate: 0.25 });
  assert.equal(rateText(main!.completion), '25% (1/4)');
  assert.deepEqual(main!.blocked, { byKind: { captcha: 2 }, byDetector: { agent: 1, harness: 1 } });
  assert.equal(main!.userCancellations, 1);
  assert.deepEqual([main!.agentErrors, main!.limits, main!.abandoned], [{ interrupted: 1 }, { steps: 1 }, 1]);
  assert.deepEqual(main!.costUsd, { total: 3, unknownRuns: 1 });
  assert.equal(main!.runs.length, 7, 'individual repetitions are preserved');
  assert.deepEqual(other!.completion, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual([summary.totalCostUsd, summary.unknownCostRuns, summary.notStarted], [3.5, 1, 1]);
  assert.ok(summary.warnings.some((warning) => /trace\.zip is private/u.test(warning)));
  assert.ok(summary.warnings.some((warning) => warning.startsWith('Vision mode')));
});

test('a batch with only blocked and cancelled runs reports N/A, never a rate', () => {
  const summary = buildBatchReport('batch_x', [report('r1', blocked('harness')), report('r2', interrupted('user'))], 0);
  assert.deepEqual(summary.groups[0]!.completion, { numerator: 0, denominator: 0, rate: null });
  assert.equal(rateText(summary.groups[0]!.completion), 'N/A (0/0)');
});

test('reports print cost, unsettled reservations, or cost unknown with the enforcement limit', () => {
  assert.equal(costText(report('r', completed)), '$0.5000');
  const usage = report('r', completed).usage;
  assert.equal(
    costText(report('r', completed, { usage: { ...usage, estimatedCostUsd: null, reservedUnsettledCostUsd: 0.25 } })),
    '$0.2500 reserved, unsettled',
  );
  assert.equal(
    costText(report('r', completed, { usage: { ...usage, estimatedCostUsd: null, capEnforcement: 'step_time_only' } })),
    'cost unknown (cap enforcement: step_time_only)',
  );
});

test('rendered reports escape model-controlled text and link only harness screenshot IDs', () => {
  const hostile = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) | `code`';
  const item = report('run_a', { ...completed, reason: hostile });
  const timeline = [
    step(0, 'navigate', { url: 'http://app.test/' }, { afterScreenshotId: '../../etc/passwd' as never }),
  ];
  const html = renderRunHtml(item, timeline);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.ok(!html.includes('etc/passwd"'));
  assert.match(html, /Content-Security-Policy/u);
  const markdown = renderRunMarkdown(item, timeline);
  assert.match(markdown, /\\<img src=x onerror=alert\(1\)\\> \\\[click\\\]\(javascript:alert\(1\)\) \\\| \\`code\\`/u);
  assert.ok(!markdown.includes('](../../etc'));
});

test('the manifest inventories regular files only, skips temp files, and never lists itself', async () => {
  const run = join(dir, 'run');
  await mkdir(join(run, 'screenshots'), { recursive: true });
  await writeFile(join(run, 'steps.jsonl'), '{}\n');
  await writeFile(join(run, 'screenshots', 'shot-0000.png'), 'png');
  await writeFile(join(run, 'report.json.tmp-0a1b2c3d'), 'partial');
  await symlink('/etc/hostname', join(run, 'trace.zip'));
  await symlink(join(dir), join(run, 'linked'));
  const { manifest, rejected } = await writeManifest(run, {
    runId: 'run_a',
    batchId: 'batch_x',
    createdAt: '2026-10-28T09:00:00.000Z',
    toolVersion: '0.0.0',
    runtime: { node: process.version, playwright: '1.64.1', chromium: null },
    configuration: {
      personaId: 'guest',
      personaHash: 'sha256:p',
      suiteId: null,
      resolvedConfigHash: null,
      setupHash: null,
      mode: 'vision',
      provider: 'openai',
      model: 'm',
      effort: 'low',
      catalog,
    },
  });
  assert.deepEqual(
    manifest.artifacts.map((artifact) => [artifact.path, artifact.mediaType, artifact.bytes, artifact.sensitivity]),
    [
      ['screenshots/shot-0000.png', 'image/png', 3, 'redacted_sensitive'],
      ['steps.jsonl', 'application/jsonl', 3, 'redacted'],
    ],
  );
  assert.deepEqual(rejected.toSorted(), ['linked', 'trace.zip']);
  assert.ok((await inventory(run)).artifacts.every((artifact) => artifact.path !== 'manifest.json'));
  assert.ok(!(await readdir(run)).some((name) => name.startsWith('manifest.json.tmp-')));
});

test('an atomic write that fails leaves neither the target nor a temp file', async () => {
  const target = join(dir, 'missing-dir', 'report.json');
  await assert.rejects(writeAtomic(target, 'x'));
  await writeAtomic(join(dir, 'ok.json'), 'one');
  await writeAtomic(join(dir, 'ok.json'), 'two');
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.startsWith('ok.json')),
    ['ok.json'],
  );
});

test('bundle lookup accepts only generated IDs and plain directories', async () => {
  const project = join(dir, 'project');
  const id = 'run_20261028_090000_abcdef';
  await mkdir(join(project, '.lab', 'runs', id), { recursive: true });
  assert.deepEqual(await bundleDir(project, id), { kind: 'run', dir: join(project, '.lab', 'runs', id) });
  for (const bad of ['../x', `${id}/../..`, 'run_20261028_090000_ABCDEF', ''])
    await assert.rejects(bundleDir(project, bad), BundleError, bad);
  await symlink(join(project, '.lab', 'runs', id), join(project, '.lab', 'runs', 'batch_20261028_090000_abcdef'));
  await assert.rejects(bundleDir(project, 'batch_20261028_090000_abcdef'), /not a plain directory/u);
});

test('a literal secret typed by the agent replays only through its placeholder binding', () => {
  const secrets = new SecretStore();
  secrets.bind('email', 'ana@example.test');
  const args = redactValue({ observationId: 'o0001', target: click.target, value: 'ana@example.test' }, secrets);
  const filled = step(1, 'fill', args as Record<string, unknown>, {
    target: {
      locator: { frames: [], target: { by: 'label', text: 'Email' } },
      stability: 'semantic',
      position: { x: 1, y: 1 },
      tag: 'input',
    },
  });
  const script = generateReplay(
    { runId: 'run_a', viewport: { width: 800, height: 600 }, hasTouch: false, locale: 'en-US', timezone: 'UTC' },
    [steps[0]!, filled],
  );
  assert.ok(!script.includes('ana@example.test'));
  assert.match(script, /\.fill\(bind\("\{\{email\}\}"\)\)/u);
  assert.deepEqual(replayGaps([filled, step(2, 'scroll', { target: null, deltaX: '[redacted]', deltaY: 1 })]), [
    's0002',
  ]);
});
