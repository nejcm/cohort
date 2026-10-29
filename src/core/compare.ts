import { stripVTControlCharacters } from 'node:util';
import { ConfigError } from '../config/files.ts';
import { BundleError, bundleDir, readBundleFile, readBundleJson } from '../evidence/bundle.ts';
import { md } from '../evidence/report.ts';
import { executeReplay, ReplaySetupError } from './replay.ts';

export type ExecutionStatus = 'passed' | 'failed' | 'error';
export type CompareOutcome = 'unchanged' | 'fixed' | 'regression' | 'inconclusive';

interface CompareExecution {
  side: 'base' | 'head';
  status: ExecutionStatus;
  durationMs: number;
  failure: string | null;
}

export interface CompareResult {
  runId: string;
  base: string;
  head: string;
  outcome: CompareOutcome;
  reason: string;
  executions: CompareExecution[];
}

const PLAYWRIGHT_TIMEOUT_MS = 30_000;
const ENVIRONMENT_FAILURE = /net::ERR_|missing replay binding|Executable doesn't exist|browserType\.launch/u;

/** Decides from statuses in run order (base, head, base, head); null means run the next execution. */
export function classify(statuses: readonly ExecutionStatus[]): { outcome: CompareOutcome; reason: string } | null {
  const error = statuses.indexOf('error');
  if (error >= 0)
    return {
      outcome: 'inconclusive',
      reason: `${error % 2 === 0 ? 'base' : 'head'} execution ${error + 1} could not run: setup or environment error`,
    };
  if (statuses.length < 2) return null;
  const [base, head, base2, head2] = statuses;
  if (base === head)
    return base === 'passed'
      ? { outcome: 'unchanged', reason: 'the journey passed on base and head' }
      : { outcome: 'inconclusive', reason: 'the approved journey also fails on base' };
  if (statuses.length < 4) return null;
  if (base2 !== base || head2 !== head)
    return { outcome: 'inconclusive', reason: 'results changed between rounds; the journey or environment is flaky' };
  return base === 'passed'
    ? { outcome: 'regression', reason: 'the journey passed on base and failed on head in both rounds' }
    : { outcome: 'fixed', reason: 'the journey failed on base and passed on head in both rounds' };
}

function targetOrigin(flag: string, raw: string | undefined): string {
  const url = URL.canParse(raw ?? '') ? new URL(raw!) : null;
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ConfigError(
      `${flag} must be an http(s) origin such as https://preview.example.com, with no path or query`,
    );
  return url.origin;
}

function firstFailure(output: string): string {
  const lines = stripVTControlCharacters(output)
    .split('\n')
    .map((line) => line.trim());
  const step = lines.map((line) => /› (s\d{4,} [a-z_]+)/u.exec(line)?.[1]).find(Boolean);
  const error = lines.find((line) => /^\w*Error:/u.test(line)) ?? lines.find((line) => line.startsWith('Test timeout'));
  const waiting = lines.find((line) => line.startsWith('- waiting for '))?.slice(2);
  return [[step, error ?? 'replay failed'].filter(Boolean).join(': '), waiting && `(${waiting})`]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

/** Replays an approved run on base and head, repeating both once when they disagree; the bundle is not changed. */
export async function compareRun(
  projectRoot: string,
  runId: string,
  options: { base: string | undefined; head: string | undefined; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<CompareResult> {
  const origins = { base: targetOrigin('--base', options.base), head: targetOrigin('--head', options.head) };
  const { kind, dir } = await bundleDir(projectRoot, runId);
  if (kind !== 'run') throw new BundleError(`${runId} is a batch; this command takes a run ID`);
  const config = await readBundleJson<{ startUrl: string; request: { limits: { timeMs: number } } }>(
    dir,
    'resolved-config.json',
  );
  const recorded = new URL(config.startUrl).origin;
  const script = (await readBundleFile(dir, 'replay.spec.ts')) ?? '';
  if ([`"${recorded}`, `"//${new URL(config.startUrl).host}`].some((literal) => script.includes(literal)))
    throw new BundleError(
      `replay.spec.ts navigates to an absolute URL on the recorded origin; compare cannot retarget it without changing the journey`,
    );
  const executions: CompareExecution[] = [];
  let decision: ReturnType<typeof classify>;
  while (!(decision = classify(executions.map((execution) => execution.status)))) {
    const side = executions.length % 2 === 0 ? 'base' : 'head';
    const started = Date.now();
    try {
      const { passed, output } = await executeReplay(projectRoot, runId, {
        env: { ...options.env, COHORT_COMPARE_ORIGIN: origins[side] },
        origin: origins[side],
        timeoutMs: Math.min(config.request.limits.timeMs, PLAYWRIGHT_TIMEOUT_MS),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (options.signal?.aborted) throw new BundleError('compare was cancelled');
      executions.push({
        side,
        status: passed ? 'passed' : ENVIRONMENT_FAILURE.test(output) ? 'error' : 'failed',
        durationMs: Date.now() - started,
        failure: passed ? null : firstFailure(output),
      });
    } catch (error) {
      if (!(error instanceof ReplaySetupError)) throw error;
      executions.push({ side, status: 'error', durationMs: Date.now() - started, failure: error.message });
    }
  }
  return { runId, ...origins, ...decision, executions };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function renderCompareText(result: CompareResult): string {
  const rows = result.executions.map(
    (execution, index) =>
      `${index + 1}. ${execution.side} ${execution.status} ${seconds(execution.durationMs)}${execution.failure ? `  ${execution.failure}` : ''}\n`,
  );
  return `base ${result.base}\nhead ${result.head}\n${rows.join('')}compare ${result.runId}: ${result.outcome} (${result.reason})\n`;
}

/** One PR-comment body; the leading marker lets a workflow update the same comment. */
export function renderCompareMarkdown(result: CompareResult): string {
  const rows = result.executions.map(
    (execution, index) =>
      `| ${index + 1} | ${execution.side} | ${execution.status} | ${seconds(execution.durationMs)} | ${md(execution.failure ?? '')} |\n`,
  );
  return `<!-- cohort-compare:${result.runId} -->
### cohort journey check: ${result.outcome}

${md(result.reason.charAt(0).toUpperCase() + result.reason.slice(1))}.

Approved run \`${result.runId}\` replayed with no model on base ${md(result.base)} and head ${md(result.head)}. Advisory only; \`inconclusive\` is not evidence of a regression.

| # | Side | Result | Duration | First failure |
| --- | --- | --- | --- | --- |
${rows.join('')}`;
}
