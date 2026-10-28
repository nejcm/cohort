#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { chromium, type Page } from 'playwright';
import { checkProject, ConfigError, loadProjectConfig, saveStorageState } from './config/files.ts';
import {
  DEFAULT_MASKS,
  resolveSubmission,
  validateSubmission,
  type ResolvedEntry,
  type RunSubmission,
} from './config/resolve.ts';
import { runBatch, type BatchResult } from './core/batch.ts';
import { preflight } from './core/estimate.ts';
import { replayRun } from './core/replay.ts';
import { BundleError, bundleDir, readBundleFile, readSteps } from './evidence/bundle.ts';
import {
  rateText,
  renderBatchHtml,
  renderBatchMarkdown,
  renderRunHtml,
  renderRunMarkdown,
  type BatchReport,
  type RunReport,
} from './evidence/report.ts';
import { CatalogError, loadCatalog, resolveModel } from './providers/catalog.ts';
import { createProviders } from './providers/registry.ts';
import { ProviderError, type Effort, type ProviderAdapter } from './providers/types.ts';
import { GenerateError, generatePersona } from './personas/generate.ts';
import { isLoopback, startDashboard } from './dashboard/server.ts';
import { initProject } from './config/init.ts';
import { doctor } from './doctor.ts';
import { scrubEnv } from './setup/run.ts';
import { SecretStore } from './setup/secrets.ts';

const USAGE = `Usage: lab [options]
       lab init
       lab doctor [--json]
       lab run (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options]
       lab report <run-or-batch-id> [--format json|md|html]
       lab replay <run-id> [--json]
       lab trace <run-id>
       lab login --url <url> --state <name>
       lab persona validate
       lab ui [--port <n>] [--host <address>]
       lab persona generate --url <url> --description <text> [--out <file>] [--model <provider>/<id>]
                            [--effort low|medium|high] [--dollars <n>] [--allow-untested] [--json]

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Run options:
  --mode vision|text        --model <provider>/<id>   --effort low|medium|high
  --repeats <n>             --steps <n>               --time-ms <n>   --dollars <n>
  --url <url>               --note <text>             --allow-untested   --json
`;

interface Dependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, ProviderAdapter>;
  signal?: AbortSignal;
  openTrace?: (tracePath: string) => Promise<number>;
  /** Replaces the manual step of `lab login`; tests drive a headless browser through it. */
  login?: { headless: boolean; ready: (page: Page) => Promise<void> };
}

type Write = (text: string) => void;

const RUN_OPTIONS = {
  persona: { type: 'string' },
  tag: { type: 'string' },
  suite: { type: 'string' },
  url: { type: 'string' },
  note: { type: 'string' },
  mode: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  repeats: { type: 'string' },
  steps: { type: 'string' },
  'time-ms': { type: 'string' },
  dollars: { type: 'string' },
  'allow-untested': { type: 'boolean' },
  json: { type: 'boolean' },
  format: { type: 'string' },
  description: { type: 'string' },
  out: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  state: { type: 'string' },
} as const;

const GENERATE_DOLLARS = 0.5;

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function parse(argv: string[], write: Write) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, ...RUN_OPTIONS },
      allowPositionals: true,
    });
  } catch (error) {
    if (!(error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')))
      throw error;
    write(`${error.message}\n\n${USAGE}`);
    return null;
  }
}

export async function run(
  argv: string[],
  write: Write = (text) => process.stdout.write(text),
  deps: Dependencies = {},
): Promise<number> {
  const parsed = parse(argv, write);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (values.version) {
    write(`${readVersion()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    write(USAGE);
    return 0;
  }
  const [command, id, ...extra] = positionals;
  if (command === 'init' && id === undefined) {
    try {
      const { created, kept } = await initProject(deps.cwd ?? process.cwd());
      for (const path of created) write(`created ${path}\n`);
      for (const path of kept) write(`kept ${path} (exists)\n`);
      write('next: lab doctor\n');
      return 0;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      write(`Error: ${error.message}\n`);
      return 2;
    }
  }
  if (command === 'doctor' && id === undefined) {
    const env = deps.env ?? process.env;
    const checks = await doctor(deps.cwd ?? process.cwd(), env, deps.providers ?? createProviders(env));
    if (values.json) write(`${JSON.stringify({ checks })}\n`);
    else for (const check of checks) write(`${check.level.padEnd(5)} ${check.message}\n`);
    return checks.some((check) => check.level === 'error') ? 2 : 0;
  }
  if (command === 'run' && id === undefined) return runCommand(values, write, deps);
  if (command === 'ui' && id === undefined) return uiCommand(values, write, deps);
  if (command === 'login' && id === undefined)
    return loginCommand(values, write, deps).catch((error: unknown) => {
      if (!(error instanceof ConfigError)) throw error;
      write(`Error: ${error.message}\n`);
      return 2;
    });
  if ((command === 'report' || command === 'replay' || command === 'trace') && id !== undefined && extra.length === 0) {
    try {
      if (command === 'report') return await reportCommand(id, values.format ?? 'md', write, deps);
      if (command === 'replay') return await replayCommand(id, values.json === true, write, deps);
      return await traceCommand(id, deps);
    } catch (error) {
      if (!(error instanceof BundleError || error instanceof ConfigError)) throw error;
      write(values.json ? `${JSON.stringify({ error: error.message })}\n` : `Error: ${error.message}\n`);
      return 2;
    }
  }
  if (command === 'persona' && (id === 'validate' || id === 'generate') && extra.length === 0) {
    try {
      return id === 'validate' ? await validateCommand(write, deps) : await generateCommand(values, write, deps);
    } catch (error) {
      const invalid = error instanceof ConfigError || error instanceof CatalogError;
      if (!invalid && !(error instanceof GenerateError || error instanceof ProviderError)) throw error;
      write(values.json ? `${JSON.stringify({ error: error.message })}\n` : `Error: ${error.message}\n`);
      return invalid ? 2 : 1;
    }
  }
  write(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
  return 2;
}

async function reportCommand(id: string, format: string, write: Write, deps: Dependencies): Promise<number> {
  if (!['json', 'md', 'html'].includes(format)) throw new BundleError('--format must be json, md, or html');
  const { kind, dir } = await bundleDir(deps.cwd ?? process.cwd(), id);
  const text = await readBundleFile(dir, 'report.json');
  if (text === null)
    throw new BundleError(`${id} has no report.json; it is still running, or its process stopped before finalizing`);
  if (format === 'json') write(text);
  else if (kind === 'batch') {
    const report = JSON.parse(text) as BatchReport;
    write(format === 'md' ? renderBatchMarkdown(report) : renderBatchHtml(report));
  } else {
    const report = JSON.parse(text) as RunReport;
    const steps = await readSteps(dir);
    write(format === 'md' ? renderRunMarkdown(report, steps) : renderRunHtml(report, steps));
  }
  return 0;
}

async function replayCommand(id: string, json: boolean, write: Write, deps: Dependencies): Promise<number> {
  const { report, output } = await replayRun(deps.cwd ?? process.cwd(), id, {
    env: deps.env ?? process.env,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const passed = report.replay.status === 'passed';
  write(
    json
      ? `${JSON.stringify({ runId: id, replay: report.replay })}\n`
      : `${output.trimEnd()}\nreplay ${id}: ${report.replay.status}\n`,
  );
  return passed ? 0 : 1;
}

async function validateCommand(write: Write, deps: Dependencies): Promise<number> {
  const { personas, suites, problems } = await checkProject(deps.cwd ?? process.cwd());
  for (const problem of problems) write(`error: ${problem}\n`);
  write(`${personas} valid persona(s), ${suites} suite(s), ${problems.length} problem(s)\n`);
  return problems.length === 0 ? 0 : 2;
}

async function generateCommand(
  values: Record<string, string | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
  const { url, description, out } = values as Record<string, string | undefined>;
  if (!url || !description) throw new ConfigError('persona generate requires --url and --description');
  const dollars = values.dollars === undefined ? GENERATE_DOLLARS : Number(values.dollars);
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1000)
    throw new ConfigError('--dollars must be in (0, 1000]');
  const projectRoot = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
  const effort = (values.effort as Effort | undefined) ?? project.effort;
  const resolved = resolveModel(catalog, (values.model as string | undefined) ?? project.model, {
    mode: 'vision',
    allowUntested: values['allow-untested'] === true,
    ...(effort ? { effort } : {}),
  });
  const provider = (deps.providers ?? createProviders(env))[resolved.provider];
  if (!provider?.available()) throw new ConfigError(`provider ${resolved.provider} is unavailable; set its API key`);
  const outPath = out === undefined ? null : resolvePath(projectRoot, out);
  if (outPath && !outPath.endsWith('.md')) throw new ConfigError('--out must name a .md file');
  const prices = resolved.catalog.entry.pricesPerMTok;
  if (!values.json && (prices.input === null || prices.output === null))
    write('warning: cost unknown; dollar cap unenforceable\n');
  const generated = await generatePersona({
    url,
    description,
    provider,
    model: resolved.model,
    effort: resolved.effort,
    prices,
    dollars,
    maskSelectors: project.screenshots?.maskSelectors ?? DEFAULT_MASKS,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (outPath)
    await writeFile(outPath, generated.markdown, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      throw new ConfigError(
        error.code === 'EEXIST' ? `${out} exists; not overwritten` : `cannot write ${out}: ${error.code}`,
      );
    });
  const reported = generated.usage?.reportedCostUsd ?? null;
  const cost =
    generated.estimatedCostUsd !== null
      ? `estimated $${generated.estimatedCostUsd.toFixed(4)}`
      : reported !== null
        ? `reported $${reported.toFixed(4)}`
        : 'cost unknown; dollar cap unenforceable';
  const { id, markdown, usage, capEnforcement } = generated;
  if (values.json) write(`${JSON.stringify({ id, markdown, saved: outPath, cost, capEnforcement, usage })}\n`);
  else {
    write(markdown);
    const named = !outPath || outPath.endsWith(`/${id}.md`) ? '' : `; rename it to ${id}.md to run it`;
    write(`${outPath ? `saved ${out}` : 'preview only'} (${resolved.provider}/${resolved.model}, ${cost})${named}\n`);
  }
  return 0;
}

async function uiCommand(
  values: Record<string, string | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
  const host = values.host as string | undefined;
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    write('Error: --port must be an integer in [0, 65535]\n');
    return 2;
  }
  if (host !== undefined && !isLoopback(host))
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
  write(
    `dashboard: ${dashboard.url}\nThe token in this URL grants full access; keep it private. Press Ctrl-C to stop.\n`,
  );
  await new Promise<void>((resolve) => {
    if (deps.signal?.aborted) resolve();
    deps.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  await dashboard.close();
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

async function loginCommand(
  values: Record<string, string | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
  const { url, state } = values as Record<string, string | undefined>;
  if (!url || !state) throw new ConfigError('login requires --url and --state');
  if (!/^https?:\/\//u.test(url) || !URL.canParse(url)) throw new ConfigError('--url must be an http or https URL');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(state)) throw new ConfigError(`invalid storage state name: ${state}`);
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
  write(
    `saved .lab/auth/${state}.json (${saved.cookies.length} cookie(s), ${saved.origins.length} origin(s)). It is a credential: keep .lab/auth out of git. Reference it with storageState: ${state}\n`,
  );
  return 0;
}

function showTrace(tracePath: string): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve) => {
    spawn(process.execPath, [cli, 'show-trace', tracePath], { stdio: 'inherit' }).on('exit', (code) =>
      resolve(code ?? 1),
    );
  });
}

async function traceCommand(id: string, deps: Dependencies): Promise<number> {
  const { kind, dir } = await bundleDir(deps.cwd ?? process.cwd(), id);
  if (kind !== 'run') throw new BundleError('lab trace takes a run ID, not a batch ID');
  const tracePath = join(dir, 'trace.zip');
  if (!(await lstat(tracePath).catch(() => null))?.isFile()) throw new BundleError(`${id} has no trace.zip`);
  return (deps.openTrace ?? showTrace)(tracePath);
}

function submissionFrom(values: Record<string, string | boolean | undefined>): RunSubmission {
  const selectors = (['persona', 'tag', 'suite'] as const).filter((key) => values[key] !== undefined);
  if (selectors.length > 1) throw new ConfigError('choose one of --persona, --tag, --suite');
  const number = (key: string): number | undefined =>
    values[key] === undefined ? undefined : Number(values[key] as string);
  const limits = Object.fromEntries(
    [
      ['steps', number('steps')],
      ['timeMs', number('time-ms')],
      ['dollars', number('dollars')],
    ].filter(([, value]) => value !== undefined),
  );
  const key = selectors[0];
  const selector =
    key === 'persona'
      ? { kind: 'persona', id: values.persona }
      : key === 'tag'
        ? { kind: 'tag', tag: values.tag }
        : key === 'suite'
          ? { kind: 'suite', id: values.suite }
          : { kind: 'adhoc' };
  if (selector.kind === 'adhoc' && values.url === undefined && values.note === undefined)
    throw new ConfigError('choose --persona, --tag, --suite, or --url with --note');
  const optional = {
    url: values.url,
    note: values.note,
    mode: values.mode,
    model: values.model,
    effort: values.effort,
  };
  return validateSubmission({
    selector,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    ...(values.repeats === undefined ? {} : { repeats: number('repeats') }),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  });
}

async function runCommand(
  values: Record<string, string | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
  const projectRoot = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const providers = deps.providers ?? createProviders(env);
  let entries: ResolvedEntry[];
  let batch: BatchResult;
  const fail = (error: unknown): number => {
    if (!(error instanceof ConfigError || error instanceof CatalogError)) throw error;
    write(values.json ? `${JSON.stringify({ error: error.message })}\n` : `Error: ${error.message}\n`);
    return 2;
  };
  try {
    const submission = submissionFrom(values);
    const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
    entries = await resolveSubmission(submission, {
      projectRoot,
      project,
      catalog,
      providers,
      allowUntested: values['allow-untested'] === true,
    });
  } catch (error) {
    return fail(error);
  }
  const plan = preflight(entries);
  const budget =
    plan.maxBatchUsd === null
      ? 'maximum batch budget: unenforceable (some models have unknown prices)'
      : `maximum batch budget: $${plan.maxBatchUsd.toFixed(2)}`;
  if (!values.json) write(`${plan.lines.join('\n')}\n${budget}\n`);
  try {
    batch = await runBatch({
      projectRoot,
      entries,
      providers,
      env,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onRunStart: values.json
        ? undefined
        : (started) => write(`run ${started.runId} (${started.personaId}, repeat ${started.repeat + 1})\n`),
    });
  } catch (error) {
    return fail(error);
  }
  const exitCode = batch.skipped === 0 && batch.runs.every((item) => item.outcome.state === 'completed') ? 0 : 1;
  if (values.json)
    write(
      `${JSON.stringify({
        batchId: batch.batchId,
        preflight: plan.lines,
        maxBatchUsd: plan.maxBatchUsd,
        runs: batch.runs,
        skipped: batch.skipped,
        summary: batch.summary,
        reportDir: batch.reportDir,
        exitCode,
      })}\n`,
    );
  else {
    for (const item of batch.runs) {
      const detail =
        'code' in item.outcome ? ` ${item.outcome.code}` : 'limit' in item.outcome ? ` ${item.outcome.limit}` : '';
      write(`${item.runId}: ${item.outcome.state}${detail}: ${item.outcome.reason}\n`);
    }
    if (batch.skipped > 0) write(`${batch.skipped} run(s) not started: cancelled\n`);
    for (const group of batch.summary.groups)
      write(
        `${group.personaId} ${group.provider}/${group.model} ${group.effort}: completion ${rateText(group.completion)}, blocked ${Object.values(group.blocked.byKind).reduce((a, b) => a + b, 0)}, user cancellations ${group.userCancellations}, cost $${group.costUsd.total.toFixed(4)}${group.costUsd.unknownRuns > 0 ? ` + ${group.costUsd.unknownRuns} unknown` : ''}\n`,
      );
    for (const warning of batch.summary.warnings) write(`warning: ${warning}\n`);
    write(`report: ${join(batch.reportDir, 'report.html')}\n`);
  }
  return exitCode;
}

if (import.meta.main) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort('user'));
  process.once('SIGTERM', () => controller.abort('process'));
  process.exitCode = await run(process.argv.slice(2), undefined, { signal: controller.signal }).catch(
    (error: unknown) => {
      // Bounded and key-free; LAB_DEBUG=1 adds the stack.
      const keys = Object.values(createProviders()).flatMap((provider) => process.env[provider.keyEnv] ?? []);
      const text = process.env.LAB_DEBUG === '1' ? String((error as Error)?.stack ?? error) : firstLine(error);
      process.stderr.write(`lab: unexpected error: ${scrubEnv(text, new SecretStore(), keys)}\n`);
      return 2;
    },
  );
}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .split('\n')[0]!
    .slice(0, 500);
}
