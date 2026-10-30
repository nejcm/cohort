import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Outcome } from '../../src/core/outcomes.ts';
import {
  BundleError,
  bundleDir,
  readBundleFile,
  readSteps,
  refreshRun,
  writeBundle,
} from '../../src/evidence/bundle.ts';
import { deriveClaims, recurrenceKey, validateClaim, type FrictionClaim } from '../../src/evidence/friction.ts';
import { inventory, writeAtomic, writeManifest } from '../../src/evidence/manifest.ts';
import { generateReplay, replayGaps } from '../../src/evidence/replay.ts';
import {
  buildBatchReport,
  costText,
  rateText,
  renderBatchHtml,
  renderBatchMarkdown,
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

const focus = (css: string, visible = true, document = 1) => ({
  tag: 'a',
  role: 'link',
  name: css,
  css,
  visible,
  document,
});

test('focus traps, invisible keyboard focus, and horizontal overflow are measured from step evidence', () => {
  const tab = { observationId: 'o0001', key: 'Tab' };
  const keyboard: StepRecord[] = [
    step(0, 'navigate', { url: 'http://app.test/' }, { focus: null, overflowX: 0 }),
    step(1, 'press', tab, { focus: focus('skip', false), overflowX: 40 }),
    step(2, 'press', tab, { focus: focus('trap'), overflowX: 40 }),
    step(3, 'press', tab, { focus: focus('trap'), overflowX: 40 }),
    step(4, 'press', { ...tab, key: 'Shift+Tab' }, { focus: focus('trap'), overflowX: 40 }),
    step(5, 'click', click, { focus: focus('hidden', false), overflowX: 12, pageUrl: 'http://app.test/b' }),
    step(6, 'press', tab, { focus: focus('hidden', false), overflowX: 12, pageUrl: 'http://app.test/b' }),
    step(7, 'press', tab, { focus: focus('hidden', false), overflowX: 0, pageUrl: 'http://app.test/c' }),
    step(8, 'press', tab, { focus: focus('trap'), overflowX: 0, pageUrl: 'http://app.test/d' }),
    step(9, 'press', tab, { focus: focus('trap'), overflowX: 0, pageUrl: 'http://app.test/e' }),
    step(10, 'press', tab, { focus: focus('trap', true, 2), overflowX: 0, pageUrl: 'http://app.test/e' }),
    step(11, 'press', tab, { focus: focus('hidden', false, 2), overflowX: 0, pageUrl: 'http://app.test/e' }),
    step(12, 'goto', { url: '?stage=2' }, { pageUrl: 'http://app.test/e' }),
    step(13, 'press', tab, { focus: focus('hidden', false, 3), overflowX: 0, pageUrl: 'http://app.test/e' }),
  ];
  const claims = deriveClaims('run_a', keyboard) as any[];
  for (const claim of claims) assert.equal(validateClaim(claim, 'run_a', keyboard), null, claim.id);
  const of = (kind: string) => claims.filter((claim) => claim.kind === kind);
  assert.deepEqual(
    of('focus_trap').map((claim) => [claim.measurement, claim.evidence.map((ref: any) => ref.stepId)]),
    [[{ element: 'link "trap"', presses: 3 }, ['s0002', 's0003', 's0004']]],
  );
  assert.deepEqual(
    of('focus_not_visible').map((claim) => [claim.measurement, claim.evidence[0].stepId]),
    [
      [{ element: 'link "skip"' }, 's0001'],
      [{ element: 'link "hidden"' }, 's0007'],
      [{ element: 'link "hidden"' }, 's0011'],
      [{ element: 'link "hidden"' }, 's0013'],
    ],
  );
  assert.deepEqual(
    of('horizontal_overflow').map((claim) => [claim.measurement, claim.evidence[0].stepId]),
    [
      [{ overflowPx: 40 }, 's0001'],
      [{ overflowPx: 12 }, 's0005'],
    ],
  );
  assert.equal(
    of('horizontal_overflow')[1].statement,
    'The page at http://app.test/b is 12 px wider than the viewport at s0005.',
  );
  const trap = of('focus_trap')[0];
  assert.match(
    validateClaim({ ...trap, measurement: { ...trap.measurement, presses: 1 } }, 'run_a', keyboard) ?? '',
    /exactly one schema/u,
  );
  assert.match(
    validateClaim({ ...trap, measurement: { ...trap.measurement, keys: 'Tab' } }, 'run_a', keyboard) ?? '',
    /exactly one schema/u,
  );
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
    pricesPerMTok: { input: 1, output: 4, cachedInput: null, cacheWrite: 1 },
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
      cacheWriteInputTokens: null,
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
    new Map(),
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
  const summary = buildBatchReport(
    'batch_x',
    [report('r1', blocked('harness')), report('r2', interrupted('user'))],
    new Map(),
    0,
  );
  assert.deepEqual(summary.groups[0]!.completion, { numerator: 0, denominator: 0, rate: null });
  assert.equal(rateText(summary.groups[0]!.completion), 'N/A (0/0)');
});

function trail(runId: string, x: number, label: string): StepRecord[] {
  const at = (sequence: number) =>
    step(
      sequence,
      'click',
      { observationId: `o000${sequence}`, target: { kind: 'point', x, y: 20 } },
      {
        runId,
        target: {
          locator: { frames: [], target: { by: 'role', role: 'button', name: label } },
          stability: 'semantic',
          position: { x, y: 20 },
          tag: 'button',
        },
      },
    );
  return [
    step(0, 'navigate', { url: 'http://app.test/' }, { runId }),
    at(1),
    at(2),
    step(3, 'report_friction', { step: 's0002', reason: 'Slow | [form] <b>x</b>' }, { runId, afterScreenshotId: null }),
  ];
}

const runReport = (runId: string, runSteps: StepRecord[]): RunReport =>
  report(runId, completed, {
    friction: deriveClaims(runId, runSteps).map((claim) =>
      runId === 'run_a' && claim.kind === 'repeated_action'
        ? { ...claim, statement: `${claim.statement} a|b [c]` }
        : claim,
    ),
  });

test('batch clusters measured claims across runs by page and resolved target; opinions stay separate', () => {
  const trails = new Map([
    ['run_a', trail('run_a', 10, 'Book')],
    ['run_b', trail('run_b', 12, 'Book')],
    ['run_c', trail('run_c', 10, 'Cancel')],
  ]);
  const reports = [...trails].map(([runId, runSteps]) => runReport(runId, runSteps));
  reports.push(runReport('run_d', trail('run_d', 10, 'Book')));
  const [a, b] = reports.map((item) => item.friction.find((claim) => claim.kind === 'repeated_action') as any);
  assert.notEqual(a.measurement.actionFingerprint, b.measurement.actionFingerprint, 'pixel jitter differs');
  const summary = buildBatchReport('batch_x', reports, trails, 0);
  const group = summary.groups[0]!;
  assert.deepEqual(
    group.friction!.measured.map((cluster) => [cluster.kind, cluster.runs.map((run) => run.runId)]),
    [
      ['repeated_action', ['run_a', 'run_b']],
      ['repeated_action', ['run_c']],
      ['repeated_action', ['run_d']],
    ],
    'same target merges, a different locator or unknown steps stay separate',
  );
  assert.deepEqual(group.friction!.measured[0]!.runs[0], { runId: 'run_a', claimIds: [a.id], evidence: a.evidence });
  assert.deepEqual(
    group.friction!.opinions.map((item) => item.runId),
    ['run_a', 'run_b', 'run_c', 'run_d'],
    'identical opinions are never merged',
  );
  assert.ok(summary.warnings.some((warning) => /Agent opinions are listed one by one/u.test(warning)));

  const markdown = renderBatchMarkdown(summary);
  assert.match(markdown, /\| 2 of 4 runs \|/u);
  assert.ok(markdown.includes('(../run_a/screenshots/shot-0002.png)'));
  assert.ok(markdown.includes('a\\|b \\[c\\]'));
  assert.ok(markdown.includes('### Agent opinions (unverified, not grouped)'));
  const page = renderBatchHtml(summary);
  assert.ok(page.includes('<img src="../run_a/screenshots/shot-0002.png"'));
  assert.ok(page.includes('&lt;b&gt;x&lt;/b&gt;') && !page.includes('<b>x'));

  delete group.friction;
  assert.doesNotMatch(renderBatchMarkdown(summary), /Friction across runs/u, 'older batch reports still render');
  assert.doesNotMatch(renderBatchHtml(summary), /Friction across runs/u);
});

const visibleError = (text: string): FrictionClaim => ({
  schemaVersion: 1,
  id: 'c0000',
  runId: 'run_a',
  statement: text,
  evidence: [{ stepId: 's0001', screenshotId: shot(1) }],
  source: 'harness',
  kind: 'visible_error',
  measurement: { text, detector: 'visible_alert' },
});

test('visible error claims recur on detector and whitespace-normalized text', () => {
  assert.equal(
    recurrenceKey(visibleError('Card  declined\n'), new Map()),
    recurrenceKey(visibleError('Card declined'), new Map()),
  );
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

test('an atomic write replaces the target by rename and leaves no temp file when it fails', async () => {
  await assert.rejects(writeAtomic(join(dir, 'missing-dir', 'report.json'), 'x'));
  const target = join(dir, 'ok.json');
  await writeAtomic(target, 'one');
  await link(target, join(dir, 'held.json'));
  await writeAtomic(target, 'two');
  assert.deepEqual(
    [await readFile(join(dir, 'held.json'), 'utf8'), await readFile(target, 'utf8')],
    ['one', 'two'],
    'a reader of the old file never sees the new content written into it',
  );
  const occupied = join(dir, 'blocked');
  await mkdir(join(occupied, 'inner'), { recursive: true });
  await assert.rejects(writeAtomic(occupied, 'x'));
  assert.deepEqual(await readdir(occupied), ['inner']);
  assert.deepEqual(
    (await readdir(dir)).filter((name) => /^(ok\.json|blocked)/u.test(name)),
    ['blocked', 'ok.json'],
  );
});

test('a failed bundle write degrades once and writes manifest.json only after that pass wrote report.json', async () => {
  const identity = {
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
      mode: 'vision' as const,
      provider: 'openai',
      model: 'm',
      effort: 'low' as const,
      catalog,
    },
  };
  const failedReport = (failed: { path: string }[]): RunReport =>
    report('run_a', {
      state: 'agent_error',
      code: 'artifact_error',
      reason: failed.map((failure) => failure.path).join(', '),
      evidence: [],
    });
  const kept = join(dir, 'degraded-html');
  await mkdir(join(kept, 'report.html', 'blocker'), { recursive: true });
  const partial = await writeBundle(kept, identity, report('run_a', completed), [], failedReport);
  assert.deepEqual(
    [partial.report.outcome.state, partial.written, partial.failed.map((failure) => failure.path)],
    ['agent_error', ['report.json', 'report.md', 'manifest.json'], ['report.html']],
  );
  assert.equal(JSON.parse(await readFile(join(kept, 'report.json'), 'utf8')).outcome.code, 'artifact_error');

  const lost = join(dir, 'degraded-json');
  await mkdir(join(lost, 'report.html', 'blocker'), { recursive: true });
  const unwritable = await writeBundle(lost, identity, report('run_a', completed), [], (failed) => {
    rmSync(join(lost, 'report.json'));
    mkdirSync(join(lost, 'report.json', 'blocker'), { recursive: true });
    return failedReport(failed);
  });
  assert.deepEqual(
    unwritable.failed.map((failure) => failure.path),
    ['report.json'],
  );
  assert.deepEqual(
    (await readdir(lost)).toSorted(),
    ['report.html', 'report.json'],
    'no manifest, and the first pass report.md is removed rather than left describing a completed run',
  );

  const unrendered = join(dir, 'degraded-md');
  await mkdir(join(unrendered, 'report.html', 'blocker'), { recursive: true });
  const stale = await writeBundle(unrendered, identity, report('run_a', completed), [], (failed) => ({
    ...failedReport(failed),
    friction: null as never,
  }));
  assert.deepEqual(stale.written, ['report.json', 'manifest.json']);
  const listed = JSON.parse(await readFile(join(unrendered, 'manifest.json'), 'utf8')).artifacts.map(
    (artifact: { path: string }) => artifact.path,
  );
  assert.deepEqual(listed, ['report.json'], 'the stale report.md is removed before the manifest inventories the run');
  assert.deepEqual((await readdir(unrendered)).toSorted(), ['manifest.json', 'report.html', 'report.json']);

  const unlisted = join(dir, 'degraded-manifest');
  await mkdir(join(unlisted, 'manifest.json', 'blocker'), { recursive: true });
  const nomanifest = await writeBundle(unlisted, identity, report('run_a', completed), [], failedReport);
  assert.deepEqual(
    [nomanifest.written, nomanifest.failed.map((failure) => failure.path)],
    [['report.json', 'report.md', 'report.html'], ['manifest.json']],
  );
  assert.equal(JSON.parse(await readFile(join(unlisted, 'report.json'), 'utf8')).outcome.reason, 'manifest.json');
});

test('bundle readers refuse symlinked artifact files and treat missing ones as absent', async () => {
  const run = join(dir, 'linked-run');
  await mkdir(run);
  await writeFile(join(dir, 'secret.env'), 'TOKEN=leak');
  for (const name of ['report.json', 'steps.jsonl']) await symlink(join(dir, 'secret.env'), join(run, name));
  await assert.rejects(readBundleFile(run, 'report.json'), /not a regular file/u);
  await assert.rejects(readSteps(run), BundleError);
  await assert.rejects(
    refreshRun(run, (current) => current),
    BundleError,
  );
  assert.equal(await readBundleFile(run, 'missing.json'), null);
});

test('bundle lookup accepts only generated IDs and plain directories', async () => {
  const project = join(dir, 'project');
  const id = 'run_20261028_090000_abcdef';
  await mkdir(join(project, '.cohort', 'runs', id), { recursive: true });
  assert.deepEqual(await bundleDir(project, id), { kind: 'run', dir: join(project, '.cohort', 'runs', id) });
  for (const bad of ['../x', `${id}/../..`, 'run_20261028_090000_ABCDEF', ''])
    await assert.rejects(bundleDir(project, bad), BundleError, bad);
  await symlink(join(project, '.cohort', 'runs', id), join(project, '.cohort', 'runs', 'batch_20261028_090000_abcdef'));
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
