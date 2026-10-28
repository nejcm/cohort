import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { BrowserContextOptions } from 'playwright';
import { loadStorageState, sha256 } from '../config/files.ts';
import type { ResolvedEntry } from '../config/resolve.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { loadSetupModule } from '../setup/load.ts';
import { redactValue, safeUrl, SecretStore } from '../setup/secrets.ts';
import type { SetupResult } from '../setup/types.ts';
import type { AgentResult } from './agent.ts';
import { runOnce } from './engine.ts';
import type { Outcome } from './outcomes.ts';

interface BatchRun {
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
}

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
const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split('\n')[0]!;

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
  const states = await loadNamedStates(projectRoot, entries);
  const batchId = newId('batch');
  const runs: BatchRun[] = [];
  const total = entries.reduce((sum, entry) => sum + entry.request.repeats, 0);
  for (const entry of entries)
    for (let repeat = 0; repeat < entry.request.repeats; repeat += 1) {
      if (signal?.aborted) return { batchId, runs, skipped: total - runs.length };
      runs.push(await runEntry(entry, repeat));
    }
  return { batchId, runs, skipped: 0 };

  async function runEntry(entry: ResolvedEntry, repeat: number): Promise<BatchRun> {
    const { request, persona } = entry;
    const startedAt = Date.now();
    const runId = newId('run');
    const outDir = join(projectRoot, '.lab', 'runs', runId);
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    options.onRunStart?.({ runId, entryIndex: entry.entryIndex, repeat, personaId: persona.id });
    const secrets = new SecretStore();
    const issues: AgentResult['issues'] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const base = { runId, entryIndex: entry.entryIndex, repeat, personaId: persona.id, outDir };
    const failed = (outcome: Outcome): BatchRun => {
      issues.push({ code: 'evidence_unavailable', message: 'the run ended before any screenshot' });
      return { ...base, outcome, usage: null, issues };
    };
    const agentError = (code: 'setup_error' | 'browser_error', error: unknown): BatchRun =>
      failed({ state: 'agent_error', code, reason: secrets.redact(firstLine(error)).slice(0, 500), evidence: [] });

    let setupResult: SetupResult | null = null;
    let startUrl = request.url!;
    let setupHash: string | null = null;
    const deadline = AbortSignal.timeout(request.limits.timeMs);
    const setupSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      if (entry.setup) {
        setupHash = sha256(await readFile(entry.setup));
        const setup = await loadSetupModule(projectRoot, entry.setup);
        setupResult = await setup({
          runId,
          scopeId: runId,
          projectRoot,
          signal: setupSignal,
          env(name) {
            const value = env[name];
            if (!value) throw new Error(`environment variable ${name} is not set`);
            return value;
          },
          onCleanup: (handler) => void cleanups.push(handler),
        });
        for (const [name, value] of Object.entries(setupResult.secrets ?? {})) secrets.bind(name, value);
        if (Object.keys(setupResult.tools ?? {}).length > 0)
          throw new Error('custom setup tools are not supported yet (Phase 5)');
        if (!URL.canParse(setupResult.startUrl)) throw new Error('setup returned an invalid startUrl');
      }
      startUrl = setupResult?.startUrl ?? startUrl;
      if (setupSignal.aborted) throw new Error('setup ran past its time or was cancelled');
    } catch (error) {
      await runCleanups();
      if (signal?.aborted)
        return failed({
          state: 'agent_error',
          code: 'interrupted',
          interruptedBy: signal.reason === 'process' ? 'process' : 'user',
          reason: 'interrupted during setup',
          evidence: [],
        });
      return agentError('setup_error', error);
    }
    try {
      await writeFile(
        join(outDir, 'resolved-config.json'),
        `${JSON.stringify(
          redactValue(
            {
              schemaVersion: 1,
              runId,
              batchId,
              repeat,
              request,
              persona,
              suiteId: entry.suiteId,
              entryIndex: entry.entryIndex,
              task: entry.task,
              layers: entry.layers,
              setup: entry.setup ? { path: relative(projectRoot, entry.setup), hash: setupHash } : null,
              storageState: setupResult?.storageState ? 'setup' : entry.storageState,
              startUrl: safeUrl(startUrl, secrets),
            },
            secrets,
          ),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
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
      return { ...base, outcome: result.outcome, usage: result.usage, issues };
    } catch (error) {
      return agentError('browser_error', error);
    } finally {
      await runCleanups();
    }

    async function runCleanups(): Promise<void> {
      for (const cleanup of cleanups.splice(0).toReversed())
        await cleanup().catch((error: unknown) =>
          issues.push({ code: 'cleanup_failed', message: secrets.redact(firstLine(error)).slice(0, 200) }),
        );
    }
  }
}
