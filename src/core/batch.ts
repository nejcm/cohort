import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type { BrowserContextOptions } from 'playwright';
import { loadStorageState, sha256 } from '../config/files.ts';
import type { ResolvedEntry } from '../config/resolve.ts';
import { refreshRun, writeBatchReports, writeRunReports } from '../evidence/bundle.ts';
import { claimId, deriveClaims, validateClaim, type FrictionClaim } from '../evidence/friction.ts';
import { inventory, writeManifest } from '../evidence/manifest.ts';
import {
  accountingOf,
  browserActionCount,
  buildBatchReport,
  comparisonKey,
  type BatchReport,
  type ReplayStatus,
  type RunReport,
} from '../evidence/report.ts';
import type { StepRecord } from '../evidence/steps.ts';
import { createProviders } from '../providers/registry.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { loadSetupModule } from '../setup/load.ts';
import { redactValue, safeUrl, SecretStore } from '../setup/secrets.ts';
import type { SetupResult } from '../setup/types.ts';
import type { AgentResult } from './agent.ts';
import { CostMeter } from './cost.ts';
import { runOnce } from './engine.ts';
import type { Outcome } from './outcomes.ts';

export interface BatchRun {
  runId: string;
  entryIndex: number;
  repeat: number;
  personaId: string;
  outDir: string;
  outcome: Outcome;
  usage: AgentResult['usage'] | null;
  issues: AgentResult['issues'];
}

export interface BatchResult {
  batchId: string;
  runs: BatchRun[];
  /** Runs never started because the batch was cancelled. */
  skipped: number;
  summary: BatchReport;
  reportDir: string;
}

interface Trail {
  startedAt: number;
  steps: StepRecord[];
  secrets: SecretStore;
  replay: ReplayStatus;
  browserVersion: string | null;
  setupHash: string | null;
  resolvedConfigHash: string | null;
}

const TOOL_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version;

interface BatchOptions {
  projectRoot: string;
  entries: readonly ResolvedEntry[];
  providers: Readonly<Record<string, ProviderAdapter>>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onRunStart?: (run: { runId: string; entryIndex: number; repeat: number; personaId: string }) => void;
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/gu, '').replace('T', '_').slice(0, 15);
const newId = (prefix: string): string => `${prefix}_${stamp()}_${randomBytes(3).toString('hex')}`;
const firstLine = (text: string): string => text.split('\n')[0]!;
const MIN_SCRUB_LENGTH = 4;
const CLEANUP_BUDGET_MS = 10_000;

function settleWithin<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

// AbortSignal.timeout is unref'd: a hung setup with no other handle would end the process (exit 13) unreported.
function heldTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// Missing or malformed named states fail before any run starts.
async function loadNamedStates(projectRoot: string, entries: readonly ResolvedEntry[]) {
  const states = new Map<string, Record<string, unknown>>();
  for (const { storageState } of entries)
    if (storageState && !states.has(storageState))
      states.set(storageState, await loadStorageState(projectRoot, storageState));
  return states;
}

export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const { projectRoot, entries, signal } = options;
  const env = options.env ?? process.env;
  const keyEnvs = new Set(
    [...Object.values(createProviders(env)), ...Object.values(options.providers)].map((provider) => provider.keyEnv),
  );
  const providerKeys = [...keyEnvs].flatMap((name) => env[name] ?? []);
  const states = await loadNamedStates(projectRoot, entries);
  const batchId = newId('batch');
  const runs: BatchRun[] = [];
  const reports: RunReport[] = [];
  const total = entries.reduce((sum, entry) => sum + entry.request.repeats, 0);
  for (const entry of entries)
    for (let repeat = 0; repeat < entry.request.repeats; repeat += 1) {
      if (signal?.aborted) break;
      const run = await runEntry(entry, repeat);
      runs.push(run.run);
      if (run.report) reports.push(run.report);
    }
  await addAboveMinimumClaims(runs, reports);
  const skipped = total - runs.length;
  const summary = buildBatchReport(batchId, reports, skipped);
  const reportDir = join(projectRoot, '.lab', 'runs', batchId);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await writeBatchReports(reportDir, summary);
  return { batchId, runs, skipped, summary, reportDir };

  async function runEntry(entry: ResolvedEntry, repeat: number): Promise<{ run: BatchRun; report: RunReport | null }> {
    const runId = newId('run');
    const outDir = join(projectRoot, '.lab', 'runs', runId);
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    options.onRunStart?.({ runId, entryIndex: entry.entryIndex, repeat, personaId: entry.persona.id });
    const trail: Trail = {
      startedAt: Date.now(),
      steps: [],
      secrets: new SecretStore(),
      replay: 'unsupported',
      browserVersion: null,
      setupHash: null,
      resolvedConfigHash: null,
    };
    const run = await execute(entry, repeat, runId, outDir, trail);
    try {
      return { run, report: await finalize(entry, run, trail) };
    } catch (error) {
      const reason = `artifact finalization failed: ${trail.secrets.redact(firstLine(String((error as Error)?.message ?? error)))}`;
      run.issues.push({ code: 'artifact_error', message: reason.slice(0, 200) });
      return {
        run: { ...run, outcome: { state: 'agent_error', code: 'artifact_error', reason, evidence: [] } },
        report: null,
      };
    }
  }

  async function finalize(entry: ResolvedEntry, run: BatchRun, trail: Trail): Promise<RunReport> {
    const { request } = entry;
    const { artifacts, rejected } = await inventory(run.outDir);
    for (const path of rejected)
      run.issues.push({ code: 'artifact_rejected', message: `${path} is not a regular file and was not inventoried` });
    const shots = new Set(artifacts.map((artifact) => artifact.path));
    const present = (claim: { evidence: { screenshotId: string }[] }): boolean =>
      claim.evidence.every((ref) => shots.has(`screenshots/${ref.screenshotId}.png`));
    if (!present(run.outcome))
      run.issues.push({ code: 'evidence_missing', message: 'an outcome screenshot is missing from the bundle' });
    const friction: FrictionClaim[] = [];
    for (const claim of deriveClaims(run.runId, trail.steps)) {
      const invalid =
        validateClaim(claim, run.runId, trail.steps) ??
        (present(claim) ? null : `claim ${claim.id}: screenshot missing`);
      if (invalid) run.issues.push({ code: 'invalid_claim', message: invalid.slice(0, 200) });
      else friction.push(claim);
    }
    const usage = run.usage;
    const capEnforcement =
      usage?.capEnforcement ?? new CostMeter(request.limits.dollars, request.catalog.entry.pricesPerMTok).enforcement;
    const costs = {
      providerReportedCostUsd: usage?.providerReportedCostUsd ?? null,
      estimatedCostUsd: usage?.estimatedCostUsd ?? null,
    };
    const report = redactValue(
      {
        schemaVersion: 1,
        runId: run.runId,
        batchId,
        personaId: entry.persona.id,
        goal: entry.layers.goal ?? entry.layers.suiteNote ?? entry.layers.runNote ?? '',
        mode: request.mode,
        provider: request.provider,
        requestedModel: request.model,
        effort: request.effort,
        catalog: request.catalog,
        returnedModel: usage?.returnedModel ?? null,
        startedAt: new Date(trail.startedAt).toISOString(),
        durationMs: Date.now() - trail.startedAt,
        steps: Math.max(0, trail.steps.length - 1),
        browserActions: browserActionCount(trail.steps),
        outcome: run.outcome,
        friction,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cachedInputTokens: usage?.cachedInputTokens ?? null,
          imageInputTokens: null,
          ...costs,
          reservedUnsettledCostUsd: usage?.reservedUnsettledCostUsd ?? null,
          pricingVerifiedAt: request.catalog.entry.pricingVerifiedAt,
          accounting: accountingOf(costs),
          capEnforcement,
        },
        replay: { path: 'replay.spec.ts', status: trail.replay },
        issues: run.issues.map((issue) => ({ ...issue, evidenceUnavailable: issue.code === 'evidence_unavailable' })),
        manifestPath: 'manifest.json',
      } satisfies RunReport,
      trail.secrets,
    ) as RunReport;
    await writeRunReports(run.outDir, report, trail.steps);
    await writeManifest(run.outDir, {
      runId: run.runId,
      batchId,
      createdAt: report.startedAt,
      toolVersion: TOOL_VERSION,
      runtime: { node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: trail.browserVersion },
      configuration: {
        personaId: entry.persona.id,
        personaHash: entry.persona.hash,
        suiteId: entry.suiteId,
        resolvedConfigHash: trail.resolvedConfigHash,
        setupHash: trail.setupHash,
        mode: request.mode,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        catalog: request.catalog,
      },
    });
    return report;
  }

  // Needs every repetition of a comparison, so it runs once the batch ends and refreshes the affected bundles.
  async function addAboveMinimumClaims(batchRuns: BatchRun[], finished: RunReport[]): Promise<void> {
    const groups = new Map<string, RunReport[]>();
    for (const report of finished)
      if (report.outcome.state === 'completed')
        groups.set(comparisonKey(report), [...(groups.get(comparisonKey(report)) ?? []), report]);
    for (const group of groups.values()) {
      const baseline = group.reduce((best, report) => (report.browserActions < best.browserActions ? report : best));
      for (const report of group) {
        const excess = report.browserActions - baseline.browserActions;
        const [first, ...rest] = report.outcome.evidence;
        if (excess <= 0 || !first) continue;
        const run = batchRuns.find((candidate) => candidate.runId === report.runId)!;
        const claim: FrictionClaim = {
          schemaVersion: 1,
          id: claimId(report.friction.length),
          runId: report.runId,
          statement: `${report.browserActions} browser actions, ${excess} above the observed batch minimum of ${baseline.browserActions} (${baseline.runId}).`,
          evidence: [first, ...rest],
          source: 'harness',
          kind: 'steps_above_minimum',
          measurement: {
            actualActions: report.browserActions,
            minimumActions: baseline.browserActions,
            excessActions: excess,
            basis: 'observed_success_minimum',
            baselineRunId: baseline.runId,
          },
        };
        const updated = await refreshRun(run.outDir, (current) => ({
          ...current,
          friction: [...current.friction, claim],
        }));
        finished[finished.indexOf(report)] = updated;
      }
    }
  }

  async function execute(
    entry: ResolvedEntry,
    repeat: number,
    runId: string,
    outDir: string,
    trail: Trail,
  ): Promise<BatchRun> {
    const { request, persona } = entry;
    const { startedAt, secrets } = trail;
    const issues: AgentResult['issues'] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const base = { runId, entryIndex: entry.entryIndex, repeat, personaId: persona.id, outDir };
    const failed = (outcome: Outcome): BatchRun => {
      issues.push({ code: 'evidence_unavailable', message: 'the run ended before any screenshot' });
      return { ...base, outcome, usage: null, issues };
    };
    const envRead: string[] = [];
    // Setup and cleanup errors may echo environment values that were never registered as secrets.
    const scrub = (error: unknown): string => {
      const values = [...providerKeys, ...envRead];
      const text = secrets.redact(String((error as Error)?.message ?? error));
      // Values too short to replace safely withhold the whole message instead.
      if (values.some((value) => value.length < MIN_SCRUB_LENGTH && value.length > 0 && text.includes(value)))
        return 'error message withheld: it may contain an environment value';
      return firstLine(
        values
          .toSorted((a, b) => b.length - a.length)
          .reduce((scrubbed, value) => scrubbed.split(value).join('[env]'), text),
      );
    };
    const agentError = (code: 'setup_error' | 'browser_error', error: unknown): BatchRun =>
      failed({ state: 'agent_error', code, reason: scrub(error).slice(0, 500), evidence: [] });

    let setupResult: SetupResult | null = null;
    let startUrl = request.url!;
    let setupHash: string | null = null;
    const deadline = heldTimeout(request.limits.timeMs);
    const setupSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      if (entry.setup) {
        setupHash = sha256(await readFile(entry.setup));
        trail.setupHash = setupHash;
        setupResult = await settleWithin<SetupResult>(
          loadSetupModule(projectRoot, entry.setup).then((setup) =>
            setup({
              runId,
              scopeId: runId,
              projectRoot,
              signal: setupSignal,
              env(name) {
                const value = env[name];
                if (!value) throw new Error(`environment variable ${name} is not set`);
                envRead.push(value);
                return value;
              },
              onCleanup: (handler) => void cleanups.push(handler),
            }),
          ),
          setupSignal,
        );
        for (const [name, value] of Object.entries(setupResult.secrets ?? {})) secrets.bind(name, value);
        if (Object.keys(setupResult.tools ?? {}).length > 0)
          throw new Error('custom setup tools are not supported yet (Phase 5)');
        if (!URL.canParse(setupResult.startUrl)) throw new Error('setup returned an invalid startUrl');
      }
      startUrl = setupResult?.startUrl ?? startUrl;
      if (setupSignal.aborted) throw new Error('setup ran past its time or was cancelled');
    } catch (error) {
      deadline.clear();
      await runCleanups();
      if (signal?.aborted)
        return failed({
          state: 'agent_error',
          code: 'interrupted',
          interruptedBy: signal.reason === 'process' ? 'process' : 'user',
          reason: 'interrupted during setup',
          evidence: [],
        });
      if (deadline.signal.aborted)
        return failed({
          state: 'limit_reached',
          limit: 'time',
          reason: 'time limit reached during setup',
          observed: Date.now() - startedAt,
          maximum: request.limits.timeMs,
          evidence: [],
        });
      return agentError('setup_error', error);
    }
    deadline.clear();
    try {
      const resolvedConfig = `${JSON.stringify(
        redactValue(
          {
            schemaVersion: 1,
            runId,
            batchId,
            repeat,
            request: request.url ? { ...request, url: safeUrl(request.url, secrets) } : request,
            persona,
            suiteId: entry.suiteId,
            entryIndex: entry.entryIndex,
            task: entry.task,
            layers: entry.layers,
            setup: entry.setup ? { path: relative(projectRoot, entry.setup), hash: setupHash } : null,
            storageState: setupResult?.storageState ? 'setup' : entry.storageState,
            startUrl: safeUrl(startUrl, secrets),
            startUrlComplete: safeUrl(startUrl, secrets) === startUrl,
          },
          secrets,
        ),
        null,
        2,
      )}\n`;
      await writeFile(join(outDir, 'resolved-config.json'), resolvedConfig, { mode: 0o600 });
      trail.resolvedConfigHash = sha256(resolvedConfig);
      const storageState: BrowserContextOptions['storageState'] =
        setupResult?.storageState ?? (entry.storageState ? (states.get(entry.storageState) as never) : undefined);
      const result = await runOnce({
        runId,
        outDir,
        startedAt,
        provider: options.providers[request.provider]!,
        model: request.model,
        effort: request.effort,
        prices: request.catalog.entry.pricesPerMTok,
        task: entry.task,
        startUrl,
        allowedOrigins: entry.allowedOrigins,
        resourceOrigins: entry.resourceOrigins,
        secrets,
        limits: request.limits,
        maxWidth: entry.screenshots.maxWidth,
        maskSelectors: entry.screenshots.maskSelectors,
        device: persona.device,
        locale: persona.locale,
        timezone: persona.timezone,
        ...(storageState ? { storageState } : {}),
        ...(signal ? { signal } : {}),
      });
      issues.push(...result.issues);
      trail.steps = result.steps;
      trail.browserVersion = result.browserVersion;
      trail.replay = result.replayGaps.length > 0 ? 'unsupported' : 'not_attempted';
      if (result.replayGaps.length > 0)
        issues.push({ code: 'replay_unsupported', message: `steps ${result.replayGaps.join(', ')} cannot replay` });
      return { ...base, outcome: result.outcome, usage: result.usage, issues };
    } catch (error) {
      return agentError('browser_error', error);
    } finally {
      await runCleanups();
    }

    async function runCleanups(): Promise<void> {
      const { signal: budget, clear } = heldTimeout(Math.min(CLEANUP_BUDGET_MS, request.limits.timeMs));
      for (const cleanup of cleanups.splice(0).toReversed()) {
        if (budget.aborted) {
          issues.push({ code: 'cleanup_timeout', message: 'cleanup skipped: the cleanup time budget is spent' });
          continue;
        }
        await settleWithin(Promise.resolve().then(cleanup), budget).catch((error: unknown) =>
          budget.aborted
            ? issues.push({ code: 'cleanup_timeout', message: 'cleanup did not finish within its time budget' })
            : issues.push({ code: 'cleanup_failed', message: scrub(error).slice(0, 200) }),
        );
      }
      clear();
    }
  }
}
