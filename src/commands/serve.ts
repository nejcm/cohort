import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium, type Page } from 'playwright';
import { ConfigError, saveStorageState } from '../config/files.ts';
import { isLoopback, startDashboard } from '../dashboard/server.ts';
import { writeAtomic } from '../evidence/manifest.ts';
import { safeUrl, SecretStore } from '../setup/secrets.ts';
import { CliError, emit, type Dependencies, type Values, type Write } from './context.ts';

export async function uiCommand(values: Values, write: Write, deps: Dependencies): Promise<number> {
  const host = values.host as string | undefined;
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new CliError('usage', '--port must be an integer in [0, 65535]');
  if (host !== undefined && !isLoopback(host) && !values.json)
    write(
      `warning: listening on ${host} over plain HTTP. This service holds your LLM provider keys and launches browsers; anyone who can reach it and has the token can spend on your keys. This is not a secure remote deployment.\n`,
    );
  const dashboard = await startDashboard({
    projectRoot: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    ...(deps.providers ? { providers: deps.providers } : {}),
    ...(host === undefined ? {} : { host }),
    port,
  });
  // The tokened URL is a credential, so JSON callers (often agents) get a private file for a person to open instead.
  const urlFile = `.cohort/auth/dashboard-${randomUUID()}.url`;
  const urlPath = join(deps.cwd ?? process.cwd(), urlFile);
  try {
    if (values.json) {
      await mkdir(dirname(urlPath), { recursive: true, mode: 0o700 });
      await writeAtomic(urlPath, `${dashboard.url}\n`);
      emit(write, { origin: dashboard.origin, pid: process.pid, urlFile });
    } else
      write(
        `dashboard: ${dashboard.url}\nThe token in this URL grants full access; keep it private. Press Ctrl-C to stop.\n`,
      );
    await new Promise<void>((resolve) => {
      if (deps.signal?.aborted) resolve();
      deps.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    try {
      if (values.json) await rm(urlPath, { force: true });
    } finally {
      await dashboard.close();
    }
  }
  return 0;
}

function waitForEnter(page: Page): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  return Promise.race([
    prompt.question('Log in in the browser window, then press Enter here to save the session. ').then(() => {}),
    new Promise<never>((_, reject) =>
      page.once('close', () => reject(new ConfigError('the browser window closed before the session was saved'))),
    ),
  ]).finally(() => prompt.close());
}

export async function loginCommand(values: Values, write: Write, deps: Dependencies): Promise<number> {
  const { url, state } = values as Record<string, string | undefined>;
  if (!url || !state) throw new ConfigError('login requires --url and --state');
  if (!/^https?:\/\//u.test(url) || !URL.canParse(url)) throw new ConfigError('--url must be an http or https URL');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(state)) throw new ConfigError(`invalid storage state name: ${state}`);
  if (!deps.login && (values.json || !(deps.stdin ?? process.stdin).isTTY))
    throw new CliError('blocked', 'cohort login needs a person at a headed browser and terminal; ask one to run it', {
      command: `cohort login --url '${safeUrl(url, new SecretStore())}' --state ${state}`,
    });
  const browser = await chromium.launch({ headless: deps.login?.headless ?? false });
  let saved: { cookies: unknown[]; origins: unknown[] };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(url);
    await (deps.login?.ready ?? waitForEnter)(page);
    saved = await context.storageState();
  } finally {
    await browser.close();
  }
  await saveStorageState(deps.cwd ?? process.cwd(), state, saved);
  if (values.json)
    emit(write, {
      state,
      path: `.cohort/auth/${state}.json`,
      cookies: saved.cookies.length,
      origins: saved.origins.length,
    });
  else
    write(
      `saved .cohort/auth/${state}.json (${saved.cookies.length} cookie(s), ${saved.origins.length} origin(s)). It is a credential: keep .cohort/auth out of git. Reference it with storageState: ${state}\n`,
    );
  return 0;
}
