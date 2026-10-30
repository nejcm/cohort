import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { checkProject, loadProjectConfig } from './config/files.ts';
import { playwrightTestCliPath } from './core/replay.ts';
import { loadCatalog, resolveModel } from './providers/catalog.ts';
import { createProviders } from './providers/registry.ts';
import type { ProviderAdapter } from './providers/types.ts';

type Level = 'ok' | 'warn' | 'error';
export interface Check {
  level: Level;
  message: string;
}

const MIN_NODE = [24, 2, 0];
const UNFINALIZED_SHOWN = 10;
export const REPLAY_MISSING =
  'cohort replay needs @playwright/test; run: npm install --save-dev @playwright/test (same version as playwright)';

const firstLine = (error: unknown): string =>
  String((error as Error)?.message ?? error)
    .split('\n')[0]!
    .slice(0, 300);

/** Checks runtime, browser, configuration, catalog, key presence and paths; never calls a model or prints a key. */
export async function doctor(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  providers: Record<string, ProviderAdapter> = createProviders(env),
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (level: Level, message: string): void => void checks.push({ level, message });

  const version = process.versions.node.split('.').map(Number);
  add(atLeast(version, MIN_NODE) ? 'ok' : 'error', `node ${process.version} (needs >= ${MIN_NODE.join('.')})`);
  await import('node:sqlite').then(
    () => add('ok', 'node:sqlite available (dashboard index)'),
    (error: unknown) => add('warn', `node:sqlite unavailable; cohort ui will not start: ${firstLine(error)}`),
  );
  const browser = chromium.executablePath();
  if (await lstat(browser).catch(() => null)) add('ok', `chromium installed at ${browser}`);
  else add('error', 'chromium is not installed; run: npx playwright install chromium');
  if (playwrightTestCliPath(projectRoot) === null) add('warn', `${REPLAY_MISSING}; runs work without it`);
  else add('ok', '@playwright/test installed (cohort replay)');

  if (!(await lstat(join(projectRoot, '.cohort')).catch(() => null))) {
    add('error', 'no .cohort directory here; run: cohort init');
    return checks;
  }
  let model: string | null = null;
  try {
    const project = await loadProjectConfig(projectRoot);
    model = project.model;
    add('ok', '.cohort/config.yml is valid');
    const catalog = await loadCatalog(projectRoot);
    add(
      'ok',
      `model catalog ${catalog.version}: ${catalog.models.length} entr${catalog.models.length === 1 ? 'y' : 'ies'}`,
    );
    try {
      const resolved = resolveModel(catalog, model, { mode: project.mode ?? 'vision', allowUntested: true });
      const prices = resolved.catalog.entry.pricesPerMTok;
      add(
        resolved.catalog.entry.untested ? 'warn' : 'ok',
        `default model ${model} (${resolved.effort})${resolved.catalog.entry.untested ? ' is untested; runs need --allow-untested' : ''}`,
      );
      if (prices.input === null || prices.output === null)
        add('warn', `${model} has no prices: cost unknown; dollar cap unenforceable`);
    } catch (error) {
      add('error', `default model: ${firstLine(error)}; add a verified entry to .cohort/models.yml`);
    }
  } catch (error) {
    add('error', firstLine(error));
  }
  for (const [id, provider] of Object.entries(providers)) {
    const needed = model?.startsWith(`${id}/`) === true;
    add(
      provider.available() ? 'ok' : needed ? 'error' : 'warn',
      `${provider.keyEnv} ${provider.available() ? 'is set' : 'is not set'} (${id})`,
    );
  }

  const { personas, suites, problems } = await checkProject(projectRoot);
  for (const problem of problems) add('error', problem);
  add(problems.length === 0 ? 'ok' : 'error', `${personas} valid persona(s), ${suites} suite(s)`);

  for (const [name, probe] of [
    ['runs', 'runs/probe'],
    ['auth', 'auth/probe'],
    ['index.sqlite', 'index.sqlite-wal'],
  ]) {
    const ignored = await gitIgnored(projectRoot, `.cohort/${probe}`);
    if (ignored === false) add('error', `.cohort/${name} is not gitignored; it holds private evidence or credentials`);
    if (ignored === true) add('ok', `.cohort/${name} is gitignored`);
  }
  const auth = await lstat(join(projectRoot, '.cohort', 'auth')).catch(() => null);
  if (auth && (auth.mode & 0o077) !== 0)
    add('warn', '.cohort/auth is readable by other users; run: chmod 700 .cohort/auth');

  const unfinalized: string[] = [];
  for (const name of (await readdir(join(projectRoot, '.cohort', 'runs')).catch(() => [])).toSorted())
    if (
      name.startsWith('run_') &&
      !(await lstat(join(projectRoot, '.cohort', 'runs', name, 'manifest.json')).catch(() => null))
    )
      unfinalized.push(name);
  if (unfinalized.length > 0)
    add(
      'warn',
      `${unfinalized.length} run(s) without manifest.json (still running, or the process stopped; cohort ui marks indexed ones interrupted): ${unfinalized.slice(0, UNFINALIZED_SHOWN).join(', ')}${unfinalized.length > UNFINALIZED_SHOWN ? ', ...' : ''}`,
    );
  return checks;
}

function atLeast(actual: number[], minimum: number[]): boolean {
  for (const [index, part] of minimum.entries()) if ((actual[index] ?? 0) !== part) return (actual[index] ?? 0) > part;
  return true;
}

// null when git is missing or the project is not a repository.
async function gitIgnored(projectRoot: string, path: string): Promise<boolean | null> {
  try {
    await promisify(execFile)('git', ['-C', projectRoot, 'check-ignore', '-q', '--no-index', path]);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? false : null;
  }
}
