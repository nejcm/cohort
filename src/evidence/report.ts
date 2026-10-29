import type { CapEnforcement } from '../core/cost.ts';
import type { Outcome } from '../core/outcomes.ts';
import type { ResolvedModel } from '../providers/catalog.ts';
import type { Effort } from '../providers/types.ts';
import { BROWSER_ACTIONS, type FrictionClaim } from './friction.ts';
import type { StepRecord } from './steps.ts';

export type ReplayStatus = 'not_attempted' | 'passed' | 'failed' | 'unsupported';

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  batchId: string;
  personaId: string;
  goal: string;
  mode: 'vision' | 'text';
  provider: string;
  requestedModel: string;
  effort: Effort;
  catalog: ResolvedModel['catalog'];
  returnedModel: string | null;
  startedAt: string;
  durationMs: number;
  steps: number;
  browserActions: number;
  outcome: Outcome;
  friction: FrictionClaim[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
    imageInputTokens: number | null;
    providerReportedCostUsd: number | null;
    estimatedCostUsd: number | null;
    reservedUnsettledCostUsd: number | null;
    pricingVerifiedAt: string | null;
    accounting: 'provider_usage' | 'estimated' | 'mixed' | 'unknown';
    capEnforcement: CapEnforcement;
  };
  replay: { path: string; status: ReplayStatus };
  issues: { code: string; message: string; evidenceUnavailable: boolean }[];
  manifestPath: string;
}

const SENSITIVITY_WARNING =
  'trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.';
const MODE_WARNINGS: Record<RunReport['mode'], string> = {
  vision:
    'Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport.',
  text: 'Text mode: the agent saw an accessibility-style text representation, not the rendered page; visual-only problems are invisible to it.',
};
const VERIFICATION_NOTE =
  'A completed outcome is an agent declaration unless marked harness_verified; it is not an automatic end-to-end assertion.';

export const browserActionCount = (steps: readonly StepRecord[]): number =>
  steps.filter((step) => BROWSER_ACTIONS.has(step.action.name) && step.result.status === 'ok').length;

export function accountingOf(
  usage: Pick<RunReport['usage'], 'estimatedCostUsd' | 'providerReportedCostUsd'>,
): RunReport['usage']['accounting'] {
  if (usage.estimatedCostUsd !== null && usage.providerReportedCostUsd !== null) return 'mixed';
  if (usage.estimatedCostUsd !== null) return 'estimated';
  return usage.providerReportedCostUsd !== null ? 'provider_usage' : 'unknown';
}

const runCostUsd = (report: RunReport): number | null =>
  report.usage.estimatedCostUsd ?? report.usage.providerReportedCostUsd;

export function costText(report: RunReport): string {
  const cost = runCostUsd(report);
  const unsettled = report.usage.reservedUnsettledCostUsd ?? 0;
  if (cost !== null) return `$${cost.toFixed(4)}${unsettled > 0 ? ` (+$${unsettled.toFixed(4)} unsettled)` : ''}`;
  if (unsettled > 0) return `$${unsettled.toFixed(4)} reserved, unsettled`;
  return `cost unknown (cap enforcement: ${report.usage.capEnforcement})`;
}

function outcomeText(outcome: Outcome): string {
  switch (outcome.state) {
    case 'completed':
      return `completed (${outcome.verification})`;
    case 'blocked':
      return `blocked: ${outcome.kind} (${outcome.detectedBy === 'agent' ? 'agent-declared, unverified' : 'harness-detected'})`;
    case 'agent_error':
      return outcome.code === 'interrupted'
        ? `cancelled by ${outcome.interruptedBy ?? 'user'} (not an agent or UX failure)`
        : `agent error: ${outcome.code} (not a UX failure)`;
    case 'limit_reached':
      return `limit reached: ${outcome.limit} (${outcome.observed} of ${outcome.maximum}; not a UX failure)`;
    default:
      return 'abandoned by the agent';
  }
}

const claimLabel = (item: FrictionClaim): string =>
  item.source === 'agent'
    ? 'Agent opinion'
    : item.kind === 'steps_above_minimum' && item.measurement.basis === 'observed_success_minimum'
      ? 'Above observed batch minimum'
      : `Harness: ${item.kind.replaceAll('_', ' ')}`;

const isShot = (id: string | null): id is string => id !== null && /^shot-[0-9]{4,}$/u.test(id);

export function md(text: unknown): string {
  return String(text)
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[\\`*[\]|<>~]/gu, '\\$&');
}

function html(text: unknown): string {
  return String(text).replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

function stepResult(step: StepRecord): string {
  return step.result.status === 'ok' ? 'ok' : `${step.result.status} ${step.result.code}: ${step.result.message}`;
}

function facts(report: RunReport): [string, string][] {
  const entry = report.catalog.entry;
  return [
    ['Run', report.runId],
    ['Batch', report.batchId],
    ['Persona', report.personaId],
    ['Goal', report.goal],
    ['Outcome', outcomeText(report.outcome)],
    ['Reason', report.outcome.reason],
    ['Mode', report.mode],
    ['Model', `${report.provider}/${report.requestedModel} (returned: ${report.returnedModel ?? 'unknown'})`],
    ['Effort', report.effort],
    ['Catalog', `${report.catalog.version} ${report.catalog.hash}; untested: ${entry.untested ? 'yes' : 'no'}`],
    ['Started', report.startedAt],
    ['Duration', `${(report.durationMs / 1000).toFixed(1)} s`],
    ['Steps', `${report.steps} attempts, ${report.browserActions} browser actions`],
    ['Cost', costText(report)],
    ['Tokens', `${report.usage.inputTokens} in, ${report.usage.outputTokens} out (${report.usage.accounting})`],
    ['Replay', `${report.replay.path}: ${report.replay.status}`],
  ];
}

export function renderRunMarkdown(report: RunReport, steps: readonly StepRecord[]): string {
  const lines = [
    `# Run ${md(report.runId)}`,
    '',
    `> ${md(SENSITIVITY_WARNING)}`,
    '',
    `> ${md(MODE_WARNINGS[report.mode])} ${md(VERIFICATION_NOTE)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...facts(report).map(([key, value]) => `| ${key} | ${md(value)} |`),
    '',
    '## Evidence',
    '',
    ...(report.outcome.evidence.length === 0
      ? ['No screenshot evidence is available for this outcome.']
      : report.outcome.evidence.map(
          (ref) => `- ${md(ref.stepId)}: [${md(ref.screenshotId)}](screenshots/${ref.screenshotId}.png)`,
        )),
    '',
    '## Friction',
    '',
    ...(report.friction.length === 0
      ? ['No friction claims.']
      : report.friction.map(
          (item) =>
            `- **${claimLabel(item)}** (${item.id}): ${md(item.statement)} Evidence: ${item.evidence
              .map((ref) => `[${md(ref.stepId)}](screenshots/${ref.screenshotId}.png)`)
              .join(', ')}`,
        )),
    '',
    '## Timeline',
    '',
    '| Step | Action | Result | Page | Screenshot |',
    '| --- | --- | --- | --- | --- |',
    ...steps.map(
      (step) =>
        `| ${md(step.id)} | ${md(`${step.action.name} ${JSON.stringify(step.action.args)}`)} | ${md(stepResult(step))} | ${md(step.pageUrl)} | ${isShot(step.afterScreenshotId) ? `[${step.afterScreenshotId}](screenshots/${step.afterScreenshotId}.png)` : 'none'} |`,
    ),
    '',
    '## Issues',
    '',
    ...(report.issues.length === 0
      ? ['None.']
      : report.issues.map((issue) => `- ${md(issue.code)}: ${md(issue.message)}`)),
    '',
  ];
  return lines.join('\n');
}

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<title>${html(title)}</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6b6b70; --line: #d9d9de; --warn: #fff4d6; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --bg: #17171a; --muted: #a0a0a8; --line: #34343a; --warn: #3a3214; } }
body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 1100px; padding: 16px; }
table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
.warn { background: var(--warn); padding: 8px 12px; border-radius: 6px; } .muted { color: var(--muted); }
img { max-width: 240px; border: 1px solid var(--line); } code { overflow-wrap: anywhere; }
.scroll { overflow-x: auto; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

const shotLink = (id: string | null): string =>
  isShot(id) ? `<a href="screenshots/${id}.png"><img src="screenshots/${id}.png" alt="${id}" loading="lazy"></a>` : '';

export function renderRunHtml(report: RunReport, steps: readonly StepRecord[]): string {
  const rows = facts(report)
    .map(([key, value]) => `<tr><th>${key}</th><td>${html(value)}</td></tr>`)
    .join('\n');
  const friction =
    report.friction.length === 0
      ? '<p>No friction claims.</p>'
      : `<ul>${report.friction
          .map(
            (item) =>
              `<li><strong>${html(claimLabel(item))}</strong> (${html(item.id)}): ${html(item.statement)} ${item.evidence
                .map((ref) => `<a href="#${html(ref.stepId)}">${html(ref.stepId)}</a>`)
                .join(', ')}</li>`,
          )
          .join('\n')}</ul>`;
  const timeline = steps
    .map(
      (step) =>
        `<tr id="${html(step.id)}"><td>${html(step.id)}</td><td><code>${html(`${step.action.name} ${JSON.stringify(step.action.args)}`)}</code></td><td>${html(stepResult(step))}</td><td><code>${html(step.pageUrl)}</code></td><td>${shotLink(step.afterScreenshotId)}</td></tr>`,
    )
    .join('\n');
  const evidence =
    report.outcome.evidence.length === 0
      ? '<p>No screenshot evidence is available for this outcome.</p>'
      : report.outcome.evidence.map((ref) => `<p>${html(ref.stepId)} ${shotLink(ref.screenshotId)}</p>`).join('\n');
  const issues =
    report.issues.length === 0
      ? '<p>None.</p>'
      : `<ul>${report.issues.map((issue) => `<li>${html(issue.code)}: ${html(issue.message)}</li>`).join('')}</ul>`;
  return page(
    `Run ${report.runId}`,
    `<h1>Run ${html(report.runId)}</h1>
<p class="warn">${html(SENSITIVITY_WARNING)}</p>
<p class="muted">${html(MODE_WARNINGS[report.mode])} ${html(VERIFICATION_NOTE)}</p>
<table>${rows}</table>
<h2>Evidence</h2>
${evidence}
<h2>Friction</h2>
${friction}
<h2>Timeline</h2>
<div class="scroll"><table><tr><th>Step</th><th>Action</th><th>Result</th><th>Page</th><th>Screenshot</th></tr>
${timeline}</table></div>
<h2>Issues</h2>
${issues}`,
  );
}

export interface BatchGroup {
  personaId: string;
  goal: string;
  mode: RunReport['mode'];
  provider: string;
  model: string;
  effort: Effort;
  catalogHash: string;
  untested: boolean;
  runs: { runId: string; outcome: string; cost: string; costUsd: number | null; reportPath: string }[];
  completion: { numerator: number; denominator: number; rate: number | null };
  blocked: { byKind: Record<string, number>; byDetector: Record<string, number> };
  userCancellations: number;
  agentErrors: Record<string, number>;
  limits: Record<string, number>;
  abandoned: number;
  costUsd: { total: number; unknownRuns: number };
}

export interface BatchReport {
  schemaVersion: 1;
  batchId: string;
  createdAt: string;
  groups: BatchGroup[];
  notStarted: number;
  totalCostUsd: number;
  unknownCostRuns: number;
  warnings: string[];
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Runs compare only when persona, goal, mode, provider, model, effort, and catalog all match. */
export const comparisonKey = (report: RunReport): string =>
  JSON.stringify([
    report.personaId,
    report.goal,
    report.mode,
    report.provider,
    report.requestedModel,
    report.effort,
    report.catalog.hash,
  ]);

export function buildBatchReport(
  batchId: string,
  reports: readonly RunReport[],
  notStarted: number,
  createdAt = new Date().toISOString(),
): BatchReport {
  const groups = new Map<string, BatchGroup>();
  for (const report of reports) {
    const key = comparisonKey(report);
    const group = groups.get(key) ?? {
      personaId: report.personaId,
      goal: report.goal,
      mode: report.mode,
      provider: report.provider,
      model: report.requestedModel,
      effort: report.effort,
      catalogHash: report.catalog.hash,
      untested: report.catalog.entry.untested,
      runs: [],
      completion: { numerator: 0, denominator: 0, rate: null },
      blocked: { byKind: {}, byDetector: {} },
      userCancellations: 0,
      agentErrors: {},
      limits: {},
      abandoned: 0,
      costUsd: { total: 0, unknownRuns: 0 },
    };
    groups.set(key, group);
    const { outcome } = report;
    const cost = runCostUsd(report);
    group.runs.push({
      runId: report.runId,
      outcome: outcomeText(outcome),
      cost: costText(report),
      costUsd: cost,
      reportPath: `${report.runId}/report.json`,
    });
    if (cost === null) group.costUsd.unknownRuns += 1;
    else group.costUsd.total += cost;
    const userCancelled =
      outcome.state === 'agent_error' && outcome.code === 'interrupted' && outcome.interruptedBy !== 'process';
    if (outcome.state === 'blocked') {
      bump(group.blocked.byKind, outcome.kind);
      bump(group.blocked.byDetector, outcome.detectedBy);
    } else if (userCancelled) group.userCancellations += 1;
    else {
      group.completion.denominator += 1;
      if (outcome.state === 'completed') group.completion.numerator += 1;
      if (outcome.state === 'agent_error') bump(group.agentErrors, outcome.code);
      if (outcome.state === 'limit_reached') bump(group.limits, outcome.limit);
      if (outcome.state === 'abandoned') group.abandoned += 1;
    }
  }
  const list = [...groups.values()];
  for (const group of list)
    group.completion.rate =
      group.completion.denominator === 0 ? null : group.completion.numerator / group.completion.denominator;
  const modes = new Set(list.map((group) => group.mode));
  return {
    schemaVersion: 1,
    batchId,
    createdAt,
    groups: list,
    notStarted,
    totalCostUsd: list.reduce((sum, group) => sum + group.costUsd.total, 0),
    unknownCostRuns: list.reduce((sum, group) => sum + group.costUsd.unknownRuns, 0),
    warnings: [
      SENSITIVITY_WARNING,
      ...[...modes].map((mode) => MODE_WARNINGS[mode]),
      'Blocked runs and user cancellations are excluded from the completion denominator; agent-declared blocks are unverified. Agent errors and limits count as non-completions but are not UX failures.',
      ...(list.some((group) => group.untested) ? ['Some runs used a catalog entry marked untested.'] : []),
    ],
  };
}

export const rateText = (completion: BatchGroup['completion']): string =>
  `${completion.rate === null ? 'N/A' : `${(completion.rate * 100).toFixed(0)}%`} (${completion.numerator}/${completion.denominator})`;

const countsText = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ') || 'none';

function groupFacts(group: BatchGroup): [string, string][] {
  return [
    ['Comparison', `${group.personaId}: ${group.provider}/${group.model} effort ${group.effort}, ${group.mode}`],
    ['Goal', group.goal],
    ['Catalog', `${group.catalogHash}; untested: ${group.untested ? 'yes' : 'no'}`],
    ['Completion rate', rateText(group.completion)],
    ['Blocked by kind', countsText(group.blocked.byKind)],
    ['Blocked by detector', countsText(group.blocked.byDetector)],
    ['User cancellations', String(group.userCancellations)],
    ['Agent errors', countsText(group.agentErrors)],
    ['Limits reached', countsText(group.limits)],
    ['Abandoned', String(group.abandoned)],
    [
      'Cost',
      `$${group.costUsd.total.toFixed(4)}${group.costUsd.unknownRuns > 0 ? ` (+${group.costUsd.unknownRuns} run(s) with unknown cost)` : ''}`,
    ],
  ];
}

export function renderBatchMarkdown(report: BatchReport): string {
  const lines = [`# Batch ${md(report.batchId)}`, '', ...report.warnings.map((warning) => `> ${md(warning)}\n`)];
  lines.push(
    `Total cost: $${report.totalCostUsd.toFixed(4)}${report.unknownCostRuns > 0 ? `, plus ${report.unknownCostRuns} run(s) with unknown cost` : ''}. Runs not started: ${report.notStarted}.`,
    '',
  );
  for (const group of report.groups)
    lines.push(
      `## ${md(group.personaId)} · ${md(`${group.provider}/${group.model}`)} · ${md(group.effort)}`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      ...groupFacts(group).map(([key, value]) => `| ${key} | ${md(value)} |`),
      '',
      '| Run | Outcome | Cost |',
      '| --- | --- | --- |',
      ...group.runs.map(
        (run) => `| [${md(run.runId)}](../${run.runId}/report.md) | ${md(run.outcome)} | ${md(run.cost)} |`,
      ),
      '',
    );
  return lines.join('\n');
}

export function renderBatchHtml(report: BatchReport): string {
  const sections = report.groups
    .map(
      (group) => `<h2>${html(`${group.personaId} · ${group.provider}/${group.model} · ${group.effort}`)}</h2>
<table>${groupFacts(group)
        .map(([key, value]) => `<tr><th>${key}</th><td>${html(value)}</td></tr>`)
        .join('')}</table>
<div class="scroll"><table><tr><th>Run</th><th>Outcome</th><th>Cost</th></tr>${group.runs
        .map(
          (run) =>
            `<tr><td><a href="../${html(run.runId)}/report.html">${html(run.runId)}</a></td><td>${html(run.outcome)}</td><td>${html(run.cost)}</td></tr>`,
        )
        .join('')}</table></div>`,
    )
    .join('\n');
  return page(
    `Batch ${report.batchId}`,
    `<h1>Batch ${html(report.batchId)}</h1>
${report.warnings.map((warning) => `<p class="warn">${html(warning)}</p>`).join('\n')}
<p>Total cost: $${report.totalCostUsd.toFixed(4)}${report.unknownCostRuns > 0 ? `, plus ${report.unknownCostRuns} run(s) with unknown cost` : ''}. Runs not started: ${report.notStarted}.</p>
${sections}`,
  );
}
