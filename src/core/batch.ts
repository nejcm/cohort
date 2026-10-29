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
import { heldTimeout, runCleanups, runSetup, scrubEnv, type Cleanup } from '../setup/run.ts';
import { redactValue, safeUrl, SecretStore } from '../setup/secrets.ts';
import { customToolDefinitions } from '../setup/tools.ts';
import type { SetupResult } from '../setup/types.ts';
import type { AgentEvent, AgentResult } from './agent.ts';
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

export const TOOL_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
export const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('playwright/package.json') as { version: string })
  .version;

interface BatchOptions {
  projectRoot: string;
  entries: readonly ResolvedEntry[];
  providers: Readonly<Record<string, ProviderAdapter>>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onRunStart?: (run: { runId: string; entryIndex: number; repeat: number; personaId: string }) => void;
  /** Preassigned IDs, run IDs in entry then repeat order; the dashboard indexes runs before they start. */
  ids?: { batchId: string; runIds: readonly string[] };
  /** Per-run cancellation; a run already aborted when its turn comes is skipped. */
  runSignal?: (runId: string) => AbortSignal | undefined;
  onEvent?: (runId: string, type: BatchEvent, payload: Record<string, unknown>) => void;
}

export type BatchEvent = AgentEvent | 'run.started' | 'friction.created' | 'run.finished';

const stamp = (): string => new Date().toISOString().replace(/[-:]/gu, '').replace('T', '_').slice(0, 15);
export const newId = (prefix: string): string => `${prefix}_${stamp()}_${randomBytes(3).toString('hex')}`;
const firstLine = (text: string): string => text.split('\n')[0]!;

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
  const batchId = options.ids?.batchId ?? newId('batch');
  const runs: BatchRun[] = [];
  const reports: RunReport[] = [];
  const total = entries.reduce((sum, entry) => sum + entry.request.repeats, 0);
  if (options.ids && options.ids.runIds.length !== total) throw new Error('one preassigned run ID per repetition');
  let position = 0;
  for (const entry of entries)
    for (let repeat = 0; repeat < entry.request.repeats; repeat += 1) {
      const runId = options.ids?.runIds[position++] ?? newId('run');
      if (signal?.aborted) break;
      const runSignal = options.runSignal?.(runId);
      if (runSignal?.aborted) continue;
      const run = await runEntry(
        entry,
        repeat,
        runId,
        runSignal ? AbortSignal.any([runSignal, ...(signal ? [signal] : [])]) : signal,
      );
      runs.push(run.run);
      reports.push(run.report);
    }
  await addAboveMinimumClaims(runs, reports);
  const skipped = total - runs.length;
  const summary = buildBatchReport(batchId, reports, skipped);
  const reportDir = join(projectRoot, '.cohort', 'runs', batchId);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await writeBatchReports(reportDir, summary);
  return { batchId, runs, skipped, summary, reportDir };

  async function runEntry(
    entry: ResolvedEntry,
    repeat: number,
    runId: string,
    runSignal: AbortSignal | undefined,
  ): Promise<{ run: BatchRun; report: RunReport }> {
    const outDir = join(projectRoot, '.cohort', 'runs', runId);
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    options.onRunStart?.({ runId, entryIndex: entry.entryIndex, repeat, personaId: entry.persona.id });
    options.onEvent?.(runId, 'run.started', { entryIndex: entry.entryIndex, repeat, personaId: entry.persona.id });
    const trail: Trail = {
      startedAt: Date.now(),
      steps: [],
      secrets: new SecretStore(),
      replay: 'unsupported',
      browserVersion: null,
      setupHash: null,
      resolvedConfigHash: null,
    };
    const run = await execute(entry, repeat, runId, outDir, trail, runSignal);
    try {
      const report = await finalize(entry, run, trail);
      for (const claim of report.friction)
        options.onEvent?.(runId, 'friction.created', { claimId: claim.id, kind: claim.kind });
      options.onEvent?.(runId, 'run.finished', { state: report.outcome.state });
      return { run, report };
    } catch (error) {
      const reason = `artifact finalization failed: ${trail.secrets.redact(firstLine(String((error as Error)?.message ?? error)))}`;
      run.issues.push({ code: 'artifact_error', message: reason.slice(0, 200) });
      const failed: BatchRun = {
        ...run,
        outcome: { state: 'agent_error', code: 'artifact_error', reason, evidence: [] },
      };
      options.onEvent?.(runId, 'run.finished', { state: 'agent_error' });
      return { run: failed, report: reportOf(entry, failed, trail, []) };
    }
  }

  function reportOf(entry: ResolvedEntry, run: BatchRun, trail: Trail, friction: FrictionClaim[]): RunReport {
    const { request } = entry;
    const usage = run.usage;
    const capEnforcement =
      usage?.capEnforcement ?? new CostMeter(request.limits.dollars, request.catalog.entry.pricesPerMTok).enforcement;
    const costs = {
      providerReportedCostUsd: usage?.providerReportedCostUsd ?? null,
      estimatedCostUsd: usage?.estimatedCostUsd ?? null,
    };
    return redactValue(
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
    const report = reportOf(entry, run, trail, friction);
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
        options.onEvent?.(report.runId, 'friction.created', { claimId: claim.id, kind: claim.kind });
      }
    }
  }

  async function execute(
    entry: ResolvedEntry,
    repeat: number,
    runId: string,
    outDir: string,
    trail: Trail,
    runSignal: AbortSignal | undefined,
  ): Promise<BatchRun> {
    const { request, persona } = entry;
    const { startedAt, secrets } = trail;
    const issues: AgentResult['issues'] = [];
    const cleanups: Cleanup[] = [];
    const base = { runId, entryIndex: entry.entryIndex, repeat, personaId: persona.id, outDir };
    const unavailable = { code: 'evidence_unavailable', message: 'the run ended before any screenshot' };
    const failed = (outcome: Outcome): BatchRun => {
      issues.push(unavailable);
      return { ...base, outcome, usage: null, issues };
    };
    const envRead: string[] = [];
    // Setup and cleanup errors may echo environment values that were never registered as secrets.
    const scrub = (error: unknown): string =>
      firstLine(scrubEnv(String((error as Error)?.message ?? error), secrets, [...providerKeys, ...envRead]));
    const agentError = (code: 'setup_error' | 'browser_error', error: unknown): BatchRun =>
      failed({ state: 'agent_error', code, reason: scrub(error).slice(0, 500), evidence: [] });

    let setupResult: SetupResult | null = null;
    let startUrl = request.url!;
    let setupHash: string | null = null;
    const deadline = heldTimeout(request.limits.timeMs);
    const setupSignal = runSignal ? AbortSignal.any([runSignal, deadline.signal]) : deadline.signal;
    try {
      if (entry.setup) {
        setupHash = sha256(await readFile(entry.setup));
        trail.setupHash = setupHash;
        setupResult = await runSetup({
          projectRoot,
          path: entry.setup,
          runId,
          scopeId: runId,
          env,
          signal: setupSignal,
          envRead,
          cleanups,
        });
        for (const [name, value] of Object.entries(setupResult.secrets ?? {})) secrets.bind(name, value);
        customToolDefinitions(setupResult.tools);
        if (!URL.canParse(setupResult.startUrl)) throw new Error('setup returned an invalid startUrl');
      }
      startUrl = setupResult?.startUrl ?? startUrl;
      if (setupSignal.aborted) throw new Error('setup ran past its time or was cancelled');
    } catch (error) {
      deadline.clear();
      await cleanUp();
      if (runSignal?.aborted)
        return failed({
          state: 'agent_error',
          code: 'interrupted',
          interruptedBy: runSignal.reason === 'process' ? 'process' : 'user',
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
            customTools: Object.keys(setupResult?.tools ?? {}),
            routes: entry.routes,
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
        routes: entry.routes,
        ...(setupResult?.tools ? { customTools: setupResult.tools } : {}),
        scrub: (text) => scrubEnv(text, secrets, [...providerKeys, ...envRead]),
        secrets,
        limits: request.limits,
        maxWidth: entry.screenshots.maxWidth,
        maskSelectors: entry.screenshots.maskSelectors,
        device: persona.device,
        ...(persona.input ? { input: persona.input } : {}),
        locale: persona.locale,
        timezone: persona.timezone,
        ...(storageState ? { storageState } : {}),
        ...(runSignal ? { signal: runSignal } : {}),
        ...(options.onEvent ? { onEvent: (type, payload) => options.onEvent!(runId, type, payload) } : {}),
      });
      issues.push(...result.issues);
      trail.steps = result.steps;
      trail.browserVersion = result.browserVersion;
      trail.replay = result.replayGaps.length > 0 || result.steps.length === 0 ? 'unsupported' : 'not_attempted';
      if (result.steps.length === 0) issues.push(unavailable);
      if (result.replayGaps.length > 0)
        issues.push({ code: 'replay_unsupported', message: `steps ${result.replayGaps.join(', ')} cannot replay` });
      return { ...base, outcome: result.outcome, usage: result.usage, issues };
    } catch (error) {
      return agentError('browser_error', error);
    } finally {
      await cleanUp();
    }

    async function cleanUp(): Promise<void> {
      issues.push(...(await runCleanups(cleanups, request.limits.timeMs, scrub)));
    }
  }
}
