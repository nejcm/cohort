import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../config/files.ts';
import type { ResolvedEntry } from '../config/resolve.ts';
import { newId, PLAYWRIGHT_VERSION, runBatch, TOOL_VERSION, type BatchEvent } from '../core/batch.ts';
import {
  BundleError,
  bundleDir,
  readBundleFile,
  readBundleJson,
  readSteps,
  writeRunReports,
} from '../evidence/bundle.ts';
import { writeManifest, type RunManifest } from '../evidence/manifest.ts';
import { browserActionCount, type RunReport } from '../evidence/report.ts';
import type { StepRecord } from '../evidence/steps.ts';
import type { ModelCatalogEntry } from '../providers/catalog.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { reportColumns, type LabDb, type RunEvent, type RunRow } from './db.ts';

const MAX_QUEUED_RUNS = 100;
const MAX_EVENT_BYTES = 4096;

export class QueueError extends Error {
  override name = 'QueueError';
}

type Listener = (event: RunEvent) => void;

interface QueueOptions {
  projectRoot: string;
  db: LabDb;
  providers: Readonly<Record<string, ProviderAdapter>>;
  env: NodeJS.ProcessEnv;
}

interface QueuedBatch {
  batchId: string;
  entries: readonly ResolvedEntry[];
  runIds: string[];
}

interface ResolvedConfigFile {
  entryIndex?: number;
  repeat?: number;
  suiteId?: string | null;
  persona?: { hash?: string };
}

const now = (): string => new Date().toISOString();
const relativeDir = (runId: string): string => `.cohort/runs/${runId}`;

/** In-process FIFO over runBatch: one batch at a time, every lifecycle event persisted before it is broadcast. */
export class RunQueue {
  private readonly pending: QueuedBatch[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private active: Promise<void> | null = null;
  private closed = false;

  private readonly options: QueueOptions;

  constructor(options: QueueOptions) {
    this.options = options;
  }

  get queuedRuns(): number {
    return this.options.db.runsWithStatus('queued').length;
  }

  enqueue(entries: readonly ResolvedEntry[], request: unknown): { batchId: string; runIds: string[] } {
    if (this.closed) throw new QueueError('the dashboard is shutting down');
    const total = entries.reduce((sum, entry) => sum + entry.request.repeats, 0);
    if (this.queuedRuns + total > MAX_QUEUED_RUNS)
      throw new QueueError(`the queue holds at most ${MAX_QUEUED_RUNS} runs; wait or cancel some`);
    const { db } = this.options;
    const batchId = newId('batch');
    const runIds: string[] = [];
    const createdAt = now();
    db.transaction(() => {
      db.insertBatch(batchId, request, createdAt);
      for (const entry of entries)
        for (let repeat = 0; repeat < entry.request.repeats; repeat += 1) {
          const runId = newId('run');
          runIds.push(runId);
          db.insertRun(queuedRow(batchId, runId, entry, repeat, createdAt));
        }
    });
    for (const runId of runIds) {
      this.controllers.set(runId, new AbortController());
      this.emit(runId, 'run.queued', { batchId });
    }
    this.pending.push({ batchId, entries, runIds });
    this.pump();
    return { batchId, runIds };
  }

  /** Returns false when the run already ended. */
  cancel(runId: string): boolean {
    const row = this.options.db.run(runId);
    const controller = this.controllers.get(runId);
    if (!row || !controller || (row.status !== 'queued' && row.status !== 'running')) return false;
    controller.abort('user');
    if (row.status === 'queued') {
      this.options.db.updateRun(runId, { status: 'cancelled', finished_at: now(), interrupted_by: 'user' });
      this.emit(runId, 'run.finished', { status: 'cancelled' });
    }
    return true;
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  /** Resolves once nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.active) await this.active;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const batch of this.pending.splice(0)) for (const runId of batch.runIds) this.cancel(runId);
    for (const controller of this.controllers.values()) controller.abort('process');
    await this.idle();
  }

  private emit(runId: string, type: BatchEvent | 'run.queued', payload: Record<string, unknown>): void {
    const bounded =
      Buffer.byteLength(JSON.stringify(payload)) > MAX_EVENT_BYTES ? { truncated: true } : { runId, ...payload };
    const event = this.options.db.appendEvent(runId, type, bounded);
    for (const listener of this.listeners.get(runId) ?? []) listener(event);
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const next = this.pending.shift();
    if (!next) return;
    this.active = this.execute(next).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  private async execute(batch: QueuedBatch): Promise<void> {
    const { db, projectRoot } = this.options;
    const finishing: Promise<void>[] = [];
    try {
      await runBatch({
        projectRoot,
        entries: batch.entries,
        providers: this.options.providers,
        env: this.options.env,
        ids: { batchId: batch.batchId, runIds: batch.runIds },
        runSignal: (runId) => this.controllers.get(runId)?.signal,
        onEvent: (runId, type, payload) => {
          if (type === 'run.started') db.updateRun(runId, { status: 'running', started_at: now() });
          if (type === 'step.completed') db.updateRun(runId, { steps: (db.run(runId)?.steps ?? 0) + 1 });
          if (type === 'run.finished') return void finishing.push(this.finish(runId, payload));
          this.emit(runId, type, payload);
        },
      });
    } catch (error) {
      for (const runId of batch.runIds) {
        const row = db.run(runId);
        if (row?.status !== 'queued' && row?.status !== 'running') continue;
        db.updateRun(runId, { status: 'interrupted', finished_at: now() });
        this.emit(runId, 'run.finished', { status: 'interrupted', error: (error as Error).name ?? 'Error' });
      }
    } finally {
      await Promise.all(finishing);
      for (const runId of batch.runIds) this.controllers.delete(runId);
    }
  }

  private finish(runId: string, payload: Record<string, unknown>): Promise<void> {
    const { db, projectRoot } = this.options;
    return bundleDir(projectRoot, runId)
      .then(({ dir }) => readBundleJson<RunReport>(dir, 'report.json'))
      .then((report) => reportColumns(report))
      .catch(() => ({ outcome_state: String(payload.state ?? 'agent_error') }))
      .then((columns) => {
        db.updateRun(runId, { ...columns, status: 'finished', finished_at: now() });
        this.emit(runId, 'run.finished', { status: 'finished', ...payload });
      });
  }
}

function queuedRow(batchId: string, runId: string, entry: ResolvedEntry, repeat: number, createdAt: string) {
  const { request, layers } = entry;
  return {
    id: runId,
    batch_id: batchId,
    entry_index: entry.entryIndex,
    repeat_index: repeat,
    persona_id: entry.persona.id,
    goal: layers.goal ?? layers.suiteNote ?? layers.runNote ?? '',
    mode: request.mode,
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    catalog_version: request.catalog.version,
    catalog_hash: request.catalog.hash,
    catalog_entry_json: JSON.stringify(request.catalog.entry),
    model_untested: request.catalog.entry.untested ? 1 : 0,
    status: 'queued' as const,
    outcome_state: null,
    blocked_kind: null,
    blocked_detected_by: null,
    outcome_code: null,
    interrupted_by: null,
    created_at: createdAt,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    estimated_cost_usd: null,
    cap_enforcement:
      request.catalog.entry.pricesPerMTok.input !== null && request.catalog.entry.pricesPerMTok.output !== null
        ? 'priced_reservations'
        : 'step_time_only',
    artifact_dir: relativeDir(runId),
    report_path: null,
    config_hash: sha256(JSON.stringify({ request, task: entry.task, layers })),
  };
}

/** Marks runs a crashed process left behind as interrupted; a started run gets a bounded agent_error report. Nothing resumes. */
export async function recoverInterrupted(projectRoot: string, db: LabDb): Promise<string[]> {
  const recovered: string[] = [];
  for (const row of db.runsWithStatus('queued', 'running')) {
    recovered.push(row.id);
    if (row.status === 'queued') {
      db.updateRun(row.id, { status: 'interrupted', interrupted_by: 'process', finished_at: now() });
      db.appendEvent(row.id, 'run.finished', { runId: row.id, status: 'interrupted' });
      continue;
    }
    const dir = await plainRunDir(projectRoot, row.id).catch(() => null);
    const finalized = dir ? await readBundleJson<RunReport>(dir, 'report.json').catch(() => null) : null;
    const steps = dir ? await readSteps(dir).catch(() => []) : [];
    const report = finalized ?? interruptedReport(row, steps);
    // A crash between report.json and manifest.json leaves a bundle without downloadable artifacts.
    if (dir && !(finalized && (await readBundleFile(dir, 'manifest.json').catch(() => null))))
      await writeRecovered(dir, row, report, steps);
    const status = finalized && dir ? 'finished' : 'interrupted';
    db.updateRun(row.id, { ...reportColumns(report), status, finished_at: now() });
    db.appendEvent(row.id, 'run.finished', { runId: row.id, status });
  }
  return recovered;
}

async function plainRunDir(projectRoot: string, runId: string): Promise<string> {
  for (const path of [
    join(projectRoot, '.cohort'),
    join(projectRoot, '.cohort', 'runs'),
    join(projectRoot, relativeDir(runId)),
  ]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await lstat(path)).isDirectory()) throw new BundleError(`${runId}: artifact path is not a plain directory`);
  }
  return join(projectRoot, relativeDir(runId));
}

function interruptedReport(row: RunRow, steps: StepRecord[]): RunReport {
  const entry = JSON.parse(row.catalog_entry_json) as ModelCatalogEntry;
  return {
    schemaVersion: 1,
    runId: row.id,
    batchId: row.batch_id,
    personaId: row.persona_id,
    goal: row.goal,
    mode: row.mode as RunReport['mode'],
    provider: row.provider,
    requestedModel: row.model,
    effort: row.effort as RunReport['effort'],
    catalog: { version: row.catalog_version, hash: row.catalog_hash, entry },
    returnedModel: null,
    startedAt: row.started_at ?? row.created_at,
    durationMs: 0,
    steps: Math.max(0, steps.length - 1),
    browserActions: browserActionCount(steps),
    outcome: {
      state: 'agent_error',
      code: 'interrupted',
      interruptedBy: 'process',
      reason: 'the dashboard process stopped during this run; it was not resumed',
      evidence: [],
    },
    friction: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: null,
      imageInputTokens: null,
      providerReportedCostUsd: null,
      estimatedCostUsd: null,
      reservedUnsettledCostUsd: null,
      pricingVerifiedAt: entry.pricingVerifiedAt,
      accounting: 'unknown',
      capEnforcement: row.cap_enforcement as RunReport['usage']['capEnforcement'],
    },
    replay: { path: 'replay.spec.ts', status: 'unsupported' },
    issues: [
      {
        code: 'evidence_unavailable',
        message: 'report reconstructed after a process crash; usage and cost are unknown',
        evidenceUnavailable: true,
      },
    ],
    manifestPath: 'manifest.json',
  };
}

async function writeRecovered(dir: string, row: RunRow, report: RunReport, steps: StepRecord[]): Promise<void> {
  const resolved = await readBundleJson<ResolvedConfigFile>(dir, 'resolved-config.json').catch(() => null);
  await writeRunReports(dir, report, steps);
  await writeManifest(dir, {
    runId: row.id,
    batchId: row.batch_id,
    createdAt: report.startedAt,
    toolVersion: TOOL_VERSION,
    runtime: { node: process.version, playwright: PLAYWRIGHT_VERSION, chromium: null },
    configuration: {
      personaId: row.persona_id,
      personaHash: resolved?.persona?.hash ?? 'unknown',
      suiteId: resolved?.suiteId ?? null,
      resolvedConfigHash: null,
      setupHash: null,
      mode: report.mode,
      provider: row.provider,
      model: row.model,
      effort: report.effort,
      catalog: report.catalog,
    },
  });
}

/** Adds finalized run bundles on disk (for example from `cohort run`) that the index does not know yet. */
export async function indexRuns(projectRoot: string, db: LabDb): Promise<number> {
  let added = 0;
  const names = await readdir(join(projectRoot, '.cohort', 'runs')).catch(() => []);
  for (const name of names.filter((candidate) => candidate.startsWith('run_')).toSorted()) {
    if (db.hasRun(name)) continue;
    try {
      const { dir } = await bundleDir(projectRoot, name);
      const report = await readBundleJson<RunReport>(dir, 'report.json');
      if (report.runId !== name) continue;
      const resolvedText = await readBundleFile(dir, 'resolved-config.json');
      const resolved = resolvedText ? (JSON.parse(resolvedText) as ResolvedConfigFile) : null;
      const manifest = await readBundleJson<RunManifest>(dir, 'manifest.json').catch(() => null);
      db.insertBatch(report.batchId, { source: 'files' }, report.startedAt);
      const inserted = db.insertRun({
        id: name,
        batch_id: report.batchId,
        entry_index: resolved?.entryIndex ?? 0,
        repeat_index: resolved?.repeat ?? 0,
        persona_id: report.personaId,
        goal: report.goal,
        mode: report.mode,
        provider: report.provider,
        model: report.requestedModel,
        effort: report.effort,
        catalog_version: report.catalog.version,
        catalog_hash: report.catalog.hash,
        catalog_entry_json: JSON.stringify(report.catalog.entry),
        model_untested: report.catalog.entry.untested ? 1 : 0,
        status: 'finished',
        created_at: report.startedAt,
        started_at: report.startedAt,
        finished_at: null,
        artifact_dir: relativeDir(name),
        config_hash: manifest?.configuration.resolvedConfigHash ?? sha256(resolvedText ?? name),
        outcome_state: null,
        blocked_kind: null,
        blocked_detected_by: null,
        outcome_code: null,
        interrupted_by: null,
        duration_ms: null,
        estimated_cost_usd: null,
        cap_enforcement: report.usage.capEnforcement,
        report_path: null,
        ...reportColumns(report),
      });
      if (inserted) added += 1;
    } catch (error) {
      if (!(error instanceof BundleError || error instanceof SyntaxError)) throw error;
    }
  }
  return added;
}
