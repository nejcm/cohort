import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStorageState } from '../config/files.ts';
import { BundleError, bundleDir, readBundleFile, readBundleJson, refreshRun } from '../evidence/bundle.ts';
import type { RunReport } from '../evidence/report.ts';
import { createProviders } from '../providers/registry.ts';
import { heldTimeout, runCleanups, runSetup, scrubEnv, type Cleanup } from '../setup/run.ts';
import { SecretStore } from '../setup/secrets.ts';
import { customToolDefinitions, runCustomTool } from '../setup/tools.ts';
import type { CustomTool } from '../setup/types.ts';

interface ResolvedConfig {
  setup: { path: string } | null;
  storageState: string | null;
  startUrl: string;
  startUrlComplete?: boolean;
  request: { limits: { timeMs: number } };
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
  const report = await readBundleJson<RunReport>(dir, 'report.json');
  if (report.replay.status === 'unsupported')
    throw new BundleError(`run ${runId} has no faithful replay script; see its report issues`);
  const config = await readBundleJson<ResolvedConfig>(dir, 'resolved-config.json');
  if ((await readBundleFile(dir, 'replay.spec.ts')) === null)
    throw new BundleError(`run ${runId} has no replay.spec.ts`);
  const cli = playwrightTestCli(projectRoot);
  const scratch = await mkdtemp(join(tmpdir(), 'lab-replay-'));
  const env: NodeJS.ProcessEnv = { ...options.env };
  const cleanups: Cleanup[] = [];
  const secrets = new SecretStore();
  const envRead: string[] = [];
  const providerKeys = Object.values(createProviders(options.env)).flatMap(({ keyEnv }) => options.env[keyEnv] ?? []);
  const scrub = (text: string): string =>
    scrubEnv(text, secrets, [
      ...providerKeys,
      ...envRead,
      ...Object.entries(env).flatMap(([name, value]) =>
        value && (name === 'LAB_START_URL' || name === 'LAB_TOOL_TOKEN' || name.startsWith('LAB_SECRET_'))
          ? [value]
          : [],
      ),
    ]);
  const capMs = config.request.limits.timeMs;
  let bridge: { close: () => void } | null = null;
  try {
    let storageState: unknown =
      config.storageState && config.storageState !== 'setup'
        ? await loadStorageState(projectRoot, config.storageState)
        : null;
    if (config.setup) {
      const deadline = heldTimeout(capMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
      const scopeId = `replay_${randomBytes(3).toString('hex')}`;
      try {
        const result = await runSetup({
          projectRoot,
          path: join(projectRoot, config.setup.path),
          runId: scopeId,
          scopeId,
          env: options.env,
          signal,
          envRead,
          cleanups,
        });
        for (const [name, value] of Object.entries(result.secrets ?? {})) {
          secrets.bind(name, value);
          env[`LAB_SECRET_${name.toUpperCase()}`] = value;
        }
        env.LAB_START_URL = result.startUrl;
        storageState = result.storageState ?? storageState;
        if (Object.keys(result.tools ?? {}).length > 0) {
          customToolDefinitions(result.tools);
          bridge = await serveTools(result.tools!, secrets, scrub, capMs, env);
        }
      } catch (error) {
        const reason = options.signal?.aborted
          ? 'cancelled'
          : deadline.signal.aborted
            ? 'it ran past the run time limit'
            : scrub(String((error as Error)?.message ?? error)).split('\n')[0]!;
        throw new BundleError(`replay setup failed: ${reason}`);
      } finally {
        deadline.clear();
      }
    } else if (!env.LAB_START_URL) {
      if (config.startUrlComplete !== true)
        throw new BundleError('the recorded start URL was reduced to origin and path; set LAB_START_URL');
      env.LAB_START_URL = config.startUrl;
    }
    if (storageState) {
      env.LAB_STORAGE_STATE = join(scratch, 'state.json');
      await writeFile(env.LAB_STORAGE_STATE, JSON.stringify(storageState), { mode: 0o600 });
    }
    const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        process.execPath,
        [cli, 'test', '--reporter=line', `--output=${join(scratch, 'results')}`, 'replay.spec.ts'],
        { cwd: dir, env, ...(options.signal ? { signal: options.signal } : {}) },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, output: `${stdout}${stderr}` }),
      );
    });
    const status = code === 0 ? 'passed' : 'failed';
    const updated = await refreshRun(dir, (current) => ({ ...current, replay: { ...current.replay, status } }));
    return { report: updated, output: scrub(output) };
  } finally {
    bridge?.close();
    await runCleanups(cleanups, capMs, () => '');
    await rm(scratch, { recursive: true, force: true });
  }
}

// Loopback only, one random token, alive just for this replay: the script calls trusted tools as the run did.
export async function serveTools(
  tools: Record<string, CustomTool>,
  secrets: SecretStore,
  scrub: (text: string) => string,
  capMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ close: () => void }> {
  const token = randomBytes(24).toString('hex');
  const deadline = Date.now() + capMs;
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: object): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body), () => {
        if (status !== 200 && status !== 500) request.socket.destroy();
      });
    };
    const loopback = ['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    if (!loopback || request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`)
      return reply(403, { error: 'forbidden' });
    let raw = '';
    for await (const chunk of request) {
      raw += String(chunk);
      if (raw.length > 65_536) return reply(413, { error: 'request too large' });
    }
    let call: { name: string; args: Record<string, unknown> };
    try {
      call = JSON.parse(raw) as typeof call;
    } catch {
      return reply(400, { error: 'invalid JSON' });
    }
    if (typeof call?.name !== 'string' || !Object.hasOwn(tools, call.name))
      return reply(404, { error: 'unknown tool' });
    const timeoutMs = Math.min(30_000, deadline - Date.now());
    if (timeoutMs <= 0) return reply(500, { error: 'tool_timeout: the replay ran past its time limit' });
    const result = await runCustomTool(call.name, tools[call.name]!, call, secrets, timeoutMs, scrub);
    return result.status === 'ok'
      ? reply(200, { bound: result.bound })
      : reply(500, { error: `${result.code}: ${result.message}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  env.LAB_TOOL_BRIDGE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  env.LAB_TOOL_TOKEN = token;
  return {
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
