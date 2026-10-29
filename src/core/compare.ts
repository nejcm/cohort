import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { ConfigError, sha256 } from '../config/files.ts';
import { BundleError, bundleDir, readBundleFile, readBundleJson, verifyBundle } from '../evidence/bundle.ts';
import { md } from '../evidence/report.ts';
import { loadSetupModule } from '../setup/load.ts';
import { heldTimeout, settleWithin } from '../setup/run.ts';
import { executeReplay, ReplaySetupError } from './replay.ts';

export type ExecutionStatus = 'passed' | 'failed' | 'error';
export type CompareOutcome = 'regression' | 'no_regression' | 'inconclusive';

interface CompareExecution {
  side: 'base' | 'head';
  status: ExecutionStatus;
  durationMs: number;
  failure: string | null;
}

export interface Provenance {
  repository: string | null;
  pullRequest: number | null;
  baseSha: string | null;
  headSha: string | null;
  deployment: string | null;
  approved: string | null;
}

export interface CompareResult {
  runId: string;
  base: string;
  head: string;
  provenance: Provenance;
  outcome: CompareOutcome;
  reason: string;
  executions: CompareExecution[];
}

/** Trusted module in .cohort/setup/ run before each execution; it resets the scope and reports what it verified. */
type CompareHooks = (ctx: {
  side: 'base' | 'head';
  origin: string;
  scopeId: string;
  signal: AbortSignal;
  env: (name: string) => string;
}) => Promise<{
  revision: string;
  deployment: string;
  reset: { scopeId: string; verified: boolean };
  cleanup?: () => Promise<void>;
}>;

const PLAYWRIGHT_TIMEOUT_MS = 30_000;
const ENVIRONMENT_FAILURE = /net::ERR_|missing replay binding|Executable doesn't exist|browserType\.launch/u;
export const PROVENANCE_PATTERNS = {
  repository: /^[\w-][\w.-]*\/[\w-][\w.-]*$/u,
  pullRequest: /^[1-9]\d{0,9}$/u,
  baseSha: /^[0-9a-f]{40}([0-9a-f]{24})?$/u,
  headSha: /^[0-9a-f]{40}([0-9a-f]{24})?$/u,
  deployment: /^[\w.:/@-]{1,200}$/u,
  approved: /^sha256:[0-9a-f]{64}$/u,
} as const;

const STEP = /^(s\d{4,}) /u;
const inconclusive = (reason: string) => ({ outcome: 'inconclusive' as const, reason });

/** Decides from statuses in run order (base, head, base, head); null means run the next execution. */
export function classify(statuses: readonly ExecutionStatus[]): { outcome: CompareOutcome; reason: string } | null {
  for (const [index, status] of statuses.entries()) {
    const side = index % 2 === 0 ? 'base' : 'head';
    if (status === 'error') return inconclusive(`${side} execution ${index + 1} could not run`);
    if (side === 'base' && status === 'failed')
      return inconclusive(
        index === 0 ? 'the approved journey fails on base' : 'base failed on confirmation; the journey is flaky',
      );
  }
  if (statuses[1] === 'passed') return { outcome: 'no_regression', reason: 'the journey passed on base and head' };
  if (statuses[3] === 'passed') return inconclusive('head passed on confirmation; the journey is flaky');
  if (statuses.length === 4)
    return { outcome: 'regression', reason: 'the journey passed on base and failed on head in both rounds' };
  return null;
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

function readProvenance(flags: Record<keyof Provenance, string | undefined>): Provenance {
  const provenance = {} as Record<keyof Provenance, string | number | null>;
  for (const [name, pattern] of Object.entries(PROVENANCE_PATTERNS) as [keyof Provenance, RegExp][]) {
    const value = flags[name];
    if (value !== undefined && !pattern.test(value))
      throw new ConfigError(`--${FLAG_OF[name]} is not valid: expected ${pattern.source}`);
    provenance[name] = value === undefined ? null : name === 'pullRequest' ? Number(value) : value;
  }
  return provenance as unknown as Provenance;
}

const FLAG_OF: Record<keyof Provenance, string> = {
  repository: 'repo',
  pullRequest: 'pr',
  baseSha: 'base-sha',
  headSha: 'head-sha',
  deployment: 'deployment',
  approved: 'approved',
};

function preparedProblem(
  prepared: Awaited<ReturnType<CompareHooks>>,
  side: 'base' | 'head',
  scopeId: string,
  provenance: Provenance,
): string | null {
  if (prepared?.reset?.scopeId !== scopeId) return 'reset verification is not scoped to this execution';
  if (prepared.reset.verified !== true) return 'reset verification failed';
  if (prepared.revision !== provenance[side === 'base' ? 'baseSha' : 'headSha'])
    return 'the deployment serves a different revision';
  if (side === 'head' && prepared.deployment !== provenance.deployment)
    return 'the deployment identity does not match --deployment';
  return null;
}

/** Replays an approved run on base and head, confirming a head failure once; the bundle is not changed. */
export async function compareRun(
  projectRoot: string,
  runId: string,
  options: {
    base: string | undefined;
    head: string | undefined;
    provenance: Record<keyof Provenance, string | undefined>;
    hooks: string | undefined;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<CompareResult> {
  const origins = { base: targetOrigin('--base', options.base), head: targetOrigin('--head', options.head) };
  const provenance = readProvenance(options.provenance);
  const { kind, dir } = await bundleDir(projectRoot, runId);
  if (kind !== 'run') throw new BundleError(`${runId} is a batch; this command takes a run ID`);
  await verifyBundle(dir);
  if (provenance.approved && sha256((await readBundleFile(dir, 'manifest.json'))!) !== provenance.approved)
    throw new BundleError('manifest.json does not match the approved hash (--approved)');
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
  const result = (decision: { outcome: CompareOutcome; reason: string }, executions: CompareExecution[] = []) => ({
    runId,
    ...origins,
    provenance,
    ...decision,
    executions,
  });
  const missing = (Object.keys(FLAG_OF) as (keyof Provenance)[]).filter((name) => provenance[name] === null);
  if (missing.length > 0)
    return result(inconclusive(`missing provenance: ${missing.map((name) => `--${FLAG_OF[name]}`).join(', ')}`));
  if (!options.hooks) return result(inconclusive('no --hooks module, so deployment identity and reset are unverified'));
  const hooks = (await loadSetupModule(projectRoot, resolve(projectRoot, options.hooks)).catch((error: Error) => {
    throw new ConfigError(`--hooks: ${error.message}`);
  })) as unknown as CompareHooks;
  const capMs = config.request.limits.timeMs;
  const hookEnvRead: string[] = [];
  const executions: CompareExecution[] = [];
  let decision: ReturnType<typeof classify>;
  while (!(decision = classify(executions.map((execution) => execution.status)))) {
    const side = executions.length % 2 === 0 ? 'base' : 'head';
    const started = Date.now();
    const record = (status: ExecutionStatus, failure: string | null): void =>
      void executions.push({ side, status, durationMs: Date.now() - started, failure });
    const scopeId = `compare_${randomBytes(3).toString('hex')}`;
    const deadline = heldTimeout(capMs);
    let prepared: Awaited<ReturnType<CompareHooks>> | null = null;
    try {
      prepared = await settleWithin(
        hooks({
          side,
          origin: origins[side],
          scopeId,
          signal: deadline.signal,
          env: (name) => {
            const value = options.env[name];
            if (!value) throw new Error(`environment variable ${name} is not set`);
            hookEnvRead.push(value);
            return value;
          },
        }),
        deadline.signal,
      );
    } catch {
      record('error', 'the compare hooks failed or timed out');
      continue;
    } finally {
      deadline.clear();
    }
    let status: ExecutionStatus = 'error';
    let failure = preparedProblem(prepared, side, scopeId, provenance);
    try {
      if (failure === null) {
        const { passed, output } = await executeReplay(projectRoot, runId, {
          env: { ...options.env, COHORT_COMPARE_ORIGIN: origins[side] },
          origin: origins[side],
          scrubValues: hookEnvRead,
          timeoutMs: Math.min(capMs, PLAYWRIGHT_TIMEOUT_MS),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (options.signal?.aborted) throw new BundleError('compare was cancelled');
        status = passed ? 'passed' : ENVIRONMENT_FAILURE.test(output) ? 'error' : 'failed';
        failure = passed ? null : firstFailure(output);
      }
    } catch (error) {
      if (!(error instanceof ReplaySetupError)) throw error;
      failure = error.message;
    } finally {
      const cleanup = heldTimeout(capMs);
      try {
        if (prepared?.cleanup) await settleWithin(prepared.cleanup(), cleanup.signal);
      } catch {
        [status, failure] = ['error', 'cleanup failed; the scope may be contaminated'];
      } finally {
        cleanup.clear();
      }
    }
    record(status, failure);
  }
  const last = executions.at(-1);
  const failedSteps = [executions[1], executions[3]].map((execution) => STEP.exec(execution?.failure ?? '')?.[1]);
  if (decision.outcome === 'regression' && (!failedSteps[0] || failedSteps[0] !== failedSteps[1]))
    decision = inconclusive('head failed at different or unknown steps in the two rounds; the journey is flaky');
  if (decision.outcome === 'inconclusive' && last?.status === 'error')
    decision = inconclusive(`${decision.reason}: ${last.failure ?? 'setup or environment error'}`);
  return result(decision, executions);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function renderCompareText(result: CompareResult): string {
  const rows = result.executions.map(
    (execution, index) =>
      `${index + 1}. ${execution.side} ${execution.status} ${seconds(execution.durationMs)}${execution.failure ? `  ${execution.failure}` : ''}\n`,
  );
  return `base ${result.base}\nhead ${result.head}\n${rows.join('')}compare ${result.runId}: ${result.outcome} (${result.reason})\n`;
}

const short = (sha: string | null): string => (sha ? `\`${sha.slice(0, 12)}\`` : 'unknown');

/** One PR-comment body; the leading marker lets the publisher update the same comment for this PR and journey. */
export function renderCompareMarkdown(result: CompareResult, evidenceUrl?: string): string {
  const rows = result.executions.map(
    (execution, index) =>
      `| ${index + 1} | ${execution.side} | ${execution.status} | ${seconds(execution.durationMs)} | ${md(execution.failure ?? '')} |\n`,
  );
  const { provenance: p } = result;
  return `<!-- cohort-compare:${result.runId} -->
### cohort journey check: ${result.outcome}

${md(result.reason.charAt(0).toUpperCase() + result.reason.slice(1))}.

Approved run \`${result.runId}\` replayed with no model on base ${md(result.base)} (${short(p.baseSha)}) and head ${md(result.head)} (${short(p.headSha)}, deployment ${md(p.deployment ?? 'unknown')}). Advisory only: \`no_regression\` means no approved regression was detected in this script, and \`inconclusive\` is not evidence of a regression.

| # | Side | Result | Duration | First failure |
| --- | --- | --- | --- | --- |
${rows.join('')}
${evidenceUrl ? `[Evidence](${evidenceUrl}) is a private workflow artifact` : 'Evidence is in private workflow artifacts'}, visible only to people with read access to this repository and deleted when its retention period ends. Compare saves no raw traces or screenshots.
`;
}
