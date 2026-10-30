import { loadSetupModule } from './load.ts';
import { runCleanups, scrubEnv, settleWithin, type Cleanup } from './run.ts';
import type { SecretStore } from './secrets.ts';
import { customToolDefinitions } from './tools.ts';
import type { SetupResult } from './types.ts';

const MAX_DESCRIPTION_LENGTH = 500;

type CleanupIssue = { code: 'cleanup_timeout' | 'cleanup_failed'; message: string };

export interface SetupSession {
  /** Loads and runs the module under `signal`; validates tools and startUrl, then binds returned secrets. */
  run(options: { path: string; runId: string; scopeId: string; signal: AbortSignal }): Promise<SetupResult>;
  /** Redacts bound secrets, provider keys, every env value the module read, and `alsoScrub()` values. */
  scrub(text: string): string;
  /** First line of an error, scrubbed and bounded; what callers put in outcomes and issues. */
  describe(error: unknown): string;
  /** Runs registered cleanups in reverse within min(10 s, capMs); returns cleanup issues. Idempotent. */
  close(capMs: number): Promise<CleanupIssue[]>;
}

/** One setup module's lifecycle: env values it reads and cleanups it registers survive a throw for scrub and close. */
export function createSetupSession(options: {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  secrets: SecretStore;
  providerKeys: readonly string[];
  alsoScrub?: () => readonly string[];
}): SetupSession {
  const { projectRoot, env, secrets, providerKeys, alsoScrub } = options;
  const envRead: string[] = [];
  const cleanups: Cleanup[] = [];
  const scrub = (text: string): string =>
    scrubEnv(text, secrets, [...providerKeys, ...envRead, ...(alsoScrub?.() ?? [])]);
  const describe = (error: unknown): string =>
    scrub(String((error as Error)?.message ?? error))
      .split('\n')[0]!
      .slice(0, MAX_DESCRIPTION_LENGTH);
  return {
    async run({ path, runId, scopeId, signal }) {
      // Reads and cleanups are recorded as they happen, so a module that throws afterwards still scrubs and cleans up.
      const result = await settleWithin(
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
      customToolDefinitions(result.tools);
      if (!URL.canParse(result.startUrl)) throw new Error('setup returned an invalid startUrl');
      for (const [name, value] of Object.entries(result.secrets ?? {})) secrets.bind(name, value);
      return result;
    },
    scrub,
    describe,
    close: (capMs) => runCleanups(cleanups, capMs, describe),
  };
}
