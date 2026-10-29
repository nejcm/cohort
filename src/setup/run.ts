import { loadSetupModule } from './load.ts';
import type { SecretStore } from './secrets.ts';
import type { SetupResult } from './types.ts';

const MIN_SCRUB_LENGTH = 4;
const CLEANUP_BUDGET_MS = 10_000;

export type Cleanup = () => Promise<void>;

export function settleWithin<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

// AbortSignal.timeout is unref'd: a hung setup with no other handle would end the process (exit 13) unreported.
export function heldTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Redacts setup secrets and the given environment values; withholds the text when a too-short value appears in it. */
export function scrubEnv(text: string, secrets: SecretStore, values: readonly string[]): string {
  const redacted = secrets.redact(text);
  if (values.some((value) => value.length < MIN_SCRUB_LENGTH && value.length > 0 && redacted.includes(value)))
    return 'error message withheld: it may contain an environment value';
  return values
    .toSorted((a, b) => b.length - a.length)
    .reduce((scrubbed, value) => (value ? scrubbed.split(value).join('[env]') : scrubbed), redacted);
}

/** Loads and runs a setup module, settling by `signal`; values it reads through `ctx.env` land in `envRead`. */
export function runSetup(options: {
  projectRoot: string;
  path: string;
  runId: string;
  scopeId: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  envRead: string[];
  cleanups: Cleanup[];
}): Promise<SetupResult> {
  const { projectRoot, path, runId, scopeId, env, signal, envRead, cleanups } = options;
  return settleWithin(
    loadSetupModule(projectRoot, path).then((setup) =>
      setup({
        runId,
        scopeId,
        projectRoot,
        signal,
        env(name) {
          const value = env[name];
          if (!value) throw new Error(`environment variable ${name} is not set`);
          envRead.push(value);
          return value;
        },
        onCleanup: (handler) => void cleanups.push(handler),
      }),
    ),
    signal,
  );
}

/** Runs and drains cleanups in reverse order within min(10 s, `capMs`); returns what went wrong. */
export async function runCleanups(
  cleanups: Cleanup[],
  capMs: number,
  describe: (error: unknown) => string,
): Promise<{ code: 'cleanup_timeout' | 'cleanup_failed'; message: string }[]> {
  const issues: { code: 'cleanup_timeout' | 'cleanup_failed'; message: string }[] = [];
  const { signal: budget, clear } = heldTimeout(Math.min(CLEANUP_BUDGET_MS, capMs));
  for (const cleanup of cleanups.splice(0).toReversed()) {
    if (budget.aborted) {
      issues.push({ code: 'cleanup_timeout', message: 'cleanup skipped: the cleanup time budget is spent' });
      continue;
    }
    await settleWithin(Promise.resolve().then(cleanup), budget).catch((error: unknown) =>
      issues.push(
        budget.aborted
          ? { code: 'cleanup_timeout', message: 'cleanup did not finish within its time budget' }
          : { code: 'cleanup_failed', message: describe(error).slice(0, 200) },
      ),
    );
  }
  clear();
  return issues;
}
