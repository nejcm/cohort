import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStorageState } from '../config/files.ts';
import { BundleError, bundleDir, refreshRun } from '../evidence/bundle.ts';
import type { RunReport } from '../evidence/report.ts';
import { loadSetupModule } from '../setup/load.ts';

interface ResolvedConfig {
  setup: { path: string } | null;
  storageState: string | null;
  startUrl: string;
  startUrlComplete?: boolean;
}

interface ReplayOptions {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function playwrightTestCli(projectRoot: string): string {
  try {
    return createRequire(join(projectRoot, 'package.json')).resolve('@playwright/test/cli');
  } catch {
    throw new BundleError('lab replay needs @playwright/test installed in the project (same version as playwright)');
  }
}

/** Prepares bindings (setup module or documented environment variables) and runs the generated script; no model is called. */
export async function replayRun(
  projectRoot: string,
  runId: string,
  options: ReplayOptions,
): Promise<{ report: RunReport; output: string }> {
  const { kind, dir } = await bundleDir(projectRoot, runId);
  if (kind !== 'run') throw new BundleError('lab replay takes a run ID, not a batch ID');
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport;
  if (report.replay.status === 'unsupported')
    throw new BundleError(`run ${runId} has no faithful replay script; see its report issues`);
  const config = JSON.parse(await readFile(join(dir, 'resolved-config.json'), 'utf8')) as ResolvedConfig;
  const cli = playwrightTestCli(projectRoot);
  const scratch = await mkdtemp(join(tmpdir(), 'lab-replay-'));
  const env: NodeJS.ProcessEnv = { ...options.env };
  const cleanups: (() => Promise<void>)[] = [];
  const bound: string[] = [];
  try {
    let storageState: unknown =
      config.storageState && config.storageState !== 'setup'
        ? await loadStorageState(projectRoot, config.storageState)
        : null;
    if (config.setup) {
      const setup = await loadSetupModule(projectRoot, join(projectRoot, config.setup.path));
      const scopeId = `replay_${randomBytes(3).toString('hex')}`;
      const result = await setup({
        runId: scopeId,
        scopeId,
        projectRoot,
        signal: options.signal ?? new AbortController().signal,
        env(name) {
          const value = options.env[name];
          if (!value) throw new BundleError(`environment variable ${name} is not set`);
          return value;
        },
        onCleanup: (handler) => void cleanups.push(handler),
      });
      env.LAB_START_URL = result.startUrl;
      for (const [name, value] of Object.entries(result.secrets ?? {})) env[`LAB_SECRET_${name.toUpperCase()}`] = value;
      storageState = result.storageState ?? storageState;
    } else if (!env.LAB_START_URL) {
      if (config.startUrlComplete !== true)
        throw new BundleError('the recorded start URL was reduced to origin and path; set LAB_START_URL');
      env.LAB_START_URL = config.startUrl;
    }
    if (storageState) {
      env.LAB_STORAGE_STATE = join(scratch, 'state.json');
      await writeFile(env.LAB_STORAGE_STATE, JSON.stringify(storageState), { mode: 0o600 });
    }
    for (const [name, value] of Object.entries(env))
      if (value && value.length >= 4 && (name === 'LAB_START_URL' || name.startsWith('LAB_SECRET_'))) bound.push(value);
    const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        process.execPath,
        [cli, 'test', '--reporter=line', `--output=${join(scratch, 'results')}`, 'replay.spec.ts'],
        { cwd: dir, env, ...(options.signal ? { signal: options.signal } : {}) },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, output: `${stdout}${stderr}` }),
      );
    });
    const scrubbed = bound
      .toSorted((a, b) => b.length - a.length)
      .reduce((text, value) => text.split(value).join('[binding]'), output);
    const status = code === 0 ? 'passed' : 'failed';
    const updated = await refreshRun(dir, (current) => ({ ...current, replay: { ...current.replay, status } }));
    return { report: updated, output: scrubbed };
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}
