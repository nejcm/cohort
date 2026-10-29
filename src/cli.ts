#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { chromium, type Page } from 'playwright';
import { checkProject, ConfigError, loadProjectConfig, saveStorageState } from './config/files.ts';
import { DEFAULT_MASKS, validateSubmission, type RunSubmission } from './config/resolve.ts';
import type { preflight } from './core/estimate.ts';
import { EXPLORE_GOAL, saveSuggestion, suggest, SUGGEST_DOLLARS, type ExploreSummary } from './core/explore.ts';
import { compareRun, renderCompareMarkdown, renderCompareText } from './core/compare.ts';
import { parseCompareReport, publishCompare, PublishError } from './core/publish.ts';
import { replayRun } from './core/replay.ts';
import { BundleError, bundleDir, readBundleFile, readSteps } from './evidence/bundle.ts';
import { writeAtomic } from './evidence/manifest.ts';
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
import { GenerateError, generatePersona, urlSecrets } from './personas/generate.ts';
import { EditError } from './dashboard/files.ts';
import { estimate } from './dashboard/operations.ts';
import { openIndex, QueueError, runOwnedBatch, startBatch, type DetachedBatch } from './dashboard/runner.ts';
import { isLoopback, startDashboard } from './dashboard/server.ts';
import { initProject } from './config/init.ts';
import { doctor } from './doctor.ts';
import { scrubEnv } from './setup/run.ts';
import { safeUrl, SecretStore } from './setup/secrets.ts';
import {
  CliError,
  configCommand,
  emit,
  fileCommand,
  modelsCommand,
  readInput,
  runsCommand,
  type Context,
  type Input,
  type Values,
  type Write,
} from './commands.ts';

export const DEFAULT_MAX_USD = 10;

const USAGE = `Usage: cohort [options]
       cohort init [--template <id>]...
       cohort doctor
       cohort config show | edit --file <path>|- [--revision <sha256>]
       cohort models list | show | edit --file <path>|- [--revision <sha256>]
       cohort estimate (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options]
       cohort run (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options] [--detach]
       cohort explore --url <url> [--mode|--model|--effort|--steps|--time-ms|--dollars|--max-usd] [--detach]
       cohort explore suggest <run-id>
       cohort explore save <run-id> (--persona <id> | --suite <id>) [--revision <sha256>] --yes
       cohort runs list [--limit <n>] [--filter active|look|finished] [--sort <key>] [--asc] [--search <text>]
                        [--since <iso-date>] [--cursor <c>]
       cohort runs show|wait|cancel <run-or-batch-id> [--timeout-ms <n>]
       cohort report <run-or-batch-id> [--format json|md|html]  (--json implies json)
       cohort replay <run-id>
       cohort compare <run-id> --base <origin> --head <origin> --repo <owner/name> --pr <n> --base-sha <sha>
                      --head-sha <sha> --deployment <id> --approved <sha256> --hooks <module> [--markdown <file>]
       cohort publish <compare-report.json> [--evidence <https-url>]  (token from GITHUB_TOKEN)
       cohort trace <run-id>
       cohort login --url <url> --state <name>
       cohort persona list | schema | templates | validate
       cohort persona show|remove <id> [--yes]
       cohort persona add [--force] | edit <id> [--revision <sha256>]  --file <path>|-
       cohort persona generate --url <url> --description <text> [--out <file>] [--model <provider>/<id>]
                            [--effort low|medium|high] [--dollars <n>] [--allow-untested]
       cohort suite list | show|remove <id> [--yes] | add [--force] | edit <id>  --file <path>|-
       cohort suite add-entry <suite-id> --persona <id> [--goal <text>] [--url <url>] [--note <text>]
       cohort ui [--port <n>] [--host <address>]

Options:
  -h, --help     Show this help
  -v, --version  Show the version
  --json         One JSON document on stdout, errors included; never prompts (docs/agents.md)

Run options:
  --mode vision|text        --model <provider>/<id>   --effort low|medium|high
  --repeats <n>             --steps <n>               --time-ms <n>   --dollars <n>
  --url <url>               --note <text>             --allow-untested
  --max-usd <n>             batch ceiling, default $${DEFAULT_MAX_USD}
  --allow-unpriced          run models with unknown prices (no enforceable dollar cap)
`;

interface Dependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, ProviderAdapter>;
  signal?: AbortSignal;
  openTrace?: (tracePath: string) => Promise<number>;
  /** Replaces the manual step of `cohort login`; tests drive a headless browser through it. */
  login?: { headless: boolean; ready: (page: Page) => Promise<void> };
  stdin?: Input;
  /** Starts a detached batch; defaults to a background `cohort` process, tests run it in-process with a fake model. */
  worker?: (batch: DetachedBatch) => Promise<{ batchId: string; runIds: string[] }>;
  fetch?: typeof fetch;
}

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
  template: { type: 'string', multiple: true },
  base: { type: 'string' },
  head: { type: 'string' },
  markdown: { type: 'string' },
  repo: { type: 'string' },
  pr: { type: 'string' },
  'base-sha': { type: 'string' },
  'head-sha': { type: 'string' },
  deployment: { type: 'string' },
  approved: { type: 'string' },
  hooks: { type: 'string' },
  evidence: { type: 'string' },
  'max-usd': { type: 'string' },
  'allow-unpriced': { type: 'boolean' },
  detach: { type: 'boolean' },
  yes: { type: 'boolean' },
  force: { type: 'boolean' },
  file: { type: 'string' },
  revision: { type: 'string' },
  goal: { type: 'string' },
  limit: { type: 'string' },
  filter: { type: 'string' },
  sort: { type: 'string' },
  asc: { type: 'boolean' },
  search: { type: 'string' },
  since: { type: 'string' },
  cursor: { type: 'string' },
  'timeout-ms': { type: 'string' },
} as const;

const GENERATE_DOLLARS = 0.5;
const WORKER = '_worker';
// Shorter key values cannot be told apart from ordinary text, so commands that hand keys to a provider refuse them.
const MIN_SECRET_LENGTH = 8;
// Exit 1 means the command ran and the result is a failure; every other refusal exits 2.
const FAILURE_CODES = new Set(['provider_error', 'timeout', 'publish_failed']);

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
    if (argv.includes('--json')) emit(write, { error: error.message, code: 'usage' });
    else write(`${error.message}\n\n${USAGE}`);
    return null;
  }
}

export async function run(
  argv: string[],
  write: Write = (text) => process.stdout.write(text),
  deps: Dependencies = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const keys = [...Object.values(createProviders(env)), ...Object.values(deps.providers ?? {})]
    .flatMap((provider) => env[provider.keyEnv] ?? [])
    .filter((key) => key.length >= MIN_SECRET_LENGTH);
  return main(argv, (text) => write(redactOutput(text, keys)), deps);
}

function refuseShortKeys(env: NodeJS.ProcessEnv, providers: Record<string, ProviderAdapter>): void {
  const problems = Object.values(providers)
    .filter((provider) => (env[provider.keyEnv] ?? '').length > 0)
    .filter((provider) => (env[provider.keyEnv] ?? '').length < MIN_SECRET_LENGTH)
    .map((provider) => `${provider.keyEnv} is shorter than ${MIN_SECRET_LENGTH} characters`);
  if (problems.length > 0) throw new CliError('invalid', problems[0]!, { problems });
}

// Values are redacted inside parsed JSON so escaped keys are caught and field names stay intact.
function redactOutput(text: string, keys: readonly string[]): string {
  const present = keys.filter((key) => text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1)));
  if (present.length === 0) return text;
  const json = text.trimStart().startsWith('{');
  const redact = (value: unknown): unknown =>
    typeof value === 'string'
      ? present.reduce((out, key) => out.split(key).join('[env]'), value)
      : Array.isArray(value)
        ? value.map(redact)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item)]))
          : value;
  if (json)
    try {
      return `${JSON.stringify(redact(JSON.parse(text)))}\n`;
    } catch {}
  return redact(text) as string;
}

async function main(argv: string[], write: Write, deps: Dependencies): Promise<number> {
  const parsed = parse(argv, write);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (values.version) {
    if (values.json) emit(write, { version: readVersion() });
    else write(`${readVersion()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    if (values.json) emit(write, { usage: USAGE });
    else write(USAGE);
    return 0;
  }
  try {
    return await dispatch(positionals, values, write, deps);
  } catch (error) {
    const failure = classify(error);
    if (!failure) throw error;
    if (values.json) emit(write, { error: (error as Error).message, ...failure.detail });
    else {
      write(`Error: ${(error as Error).message}\n`);
      if (typeof failure.detail.command === 'string') write(`run: ${failure.detail.command}\n`);
    }
    return failure.exit;
  }
}

const of = (code: string, extra: Record<string, unknown> = {}) => ({
  exit: FAILURE_CODES.has(code) ? 1 : 2,
  detail: { code, ...extra },
});

function classify(error: unknown): { exit: number; detail: Record<string, unknown> } | null {
  if (error instanceof CliError) return of(error.code, error.detail);
  if (error instanceof EditError)
    return of(error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict' : 'invalid', {
      problems: error.problems,
    });
  if (error instanceof ConfigError) return of('invalid', { problems: error.problems });
  if (error instanceof CatalogError) return of('invalid');
  if (error instanceof BundleError) return of(error.code);
  if (error instanceof QueueError) return of('queue_full');
  if (error instanceof PublishError) return of('publish_failed');
  if (error instanceof GenerateError || error instanceof ProviderError) return of('provider_error');
  return null;
}

async function dispatch(positionals: string[], values: Values, write: Write, deps: Dependencies): Promise<number> {
  const [command, id, ...extra] = positionals;
  const json = values.json === true;
  const ctx: Context = {
    root: deps.cwd ?? process.cwd(),
    values,
    write,
    json,
    providers: deps.providers ?? createProviders(deps.env ?? process.env),
    stdin: deps.stdin ?? process.stdin,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  if (['run', 'explore', 'ui', WORKER].includes(command!) || (command === 'persona' && id === 'generate'))
    refuseShortKeys(deps.env ?? process.env, ctx.providers);
  if (command === 'init' && id === undefined) {
    const { created, kept } = await initProject(ctx.root, values.template as string[] | undefined);
    if (json) emit(write, { created, kept });
    else {
      for (const path of created) write(`created ${path}\n`);
      for (const path of kept) write(`kept ${path} (exists)\n`);
      write('next: cohort doctor\n');
    }
    return 0;
  }
  if (command === 'doctor' && id === undefined) {
    const env = deps.env ?? process.env;
    const checks = await doctor(ctx.root, env, ctx.providers);
    if (json) emit(write, { checks });
    else for (const check of checks) write(`${check.level.padEnd(5)} ${check.message}\n`);
    return checks.some((check) => check.level === 'error') ? 2 : 0;
  }
  if (command === WORKER && id === undefined) return workerCommand(ctx, deps);
  if (command === 'run' && id === undefined) return runCommand(values, write, deps, ctx);
  if (command === 'explore' && id === undefined) return runCommand(values, write, deps, ctx, true);
  if (command === 'explore' && id === 'suggest' && extra.length === 1) return suggestCommand(extra[0]!, ctx, deps);
  if (command === 'explore' && id === 'save' && extra.length === 1) return saveCommand(extra[0]!, ctx);
  if (command === 'estimate' && id === undefined) return estimateCommand(ctx);
  if (command === 'ui' && id === undefined) return uiCommand(values, write, deps);
  if (command === 'login' && id === undefined) return loginCommand(values, write, deps);
  if (command === 'config' && ['show', 'edit'].includes(id!) && extra.length === 0) return configCommand(id!, ctx);
  if (command === 'models' && ['list', 'show', 'edit'].includes(id!) && extra.length === 0)
    return modelsCommand(id!, ctx);
  if (command === 'publish' && id !== undefined && extra.length === 0) return publishCommand(id, values, write, deps);
  if (command === 'runs' && extra.length <= 1) return runsCommand(id, extra[0], ctx);
  if (['report', 'replay', 'compare', 'trace'].includes(command!) && id !== undefined && extra.length === 0) {
    if (command === 'report') {
      if (json && (values.format ?? 'json') !== 'json')
        throw new CliError('usage', '--json prints the report as JSON; drop --format or use --format json');
      return reportCommand(id, (values.format as string | undefined) ?? (json ? 'json' : 'md'), write, deps);
    }
    if (command === 'replay') return replayCommand(id, json, write, deps);
    if (command === 'compare') return compareCommand(id, values, write, deps);
    return traceCommand(id, json, write, deps);
  }
  if (command === 'persona' && (id === 'validate' || id === 'generate') && extra.length === 0)
    return id === 'validate' ? validateCommand(json, write, deps) : generateCommand(values, write, deps);
  if ((command === 'persona' || command === 'suite') && extra.length <= 1)
    return fileCommand(command, id, extra[0], ctx);
  if (json) throw new CliError('usage', `unknown command: ${positionals.join(' ')}`);
  write(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
  return 2;
}

async function reportCommand(id: string, format: string, write: Write, deps: Dependencies): Promise<number> {
  if (!['json', 'md', 'html'].includes(format)) throw new CliError('usage', '--format must be json, md, or html');
  const { kind, dir } = await bundleDir(deps.cwd ?? process.cwd(), id);
  const text = await readBundleFile(dir, 'report.json');
  if (text === null)
    throw new CliError(
      'not_ready',
      `${id} has no report.json; it is still running, or its process stopped before finalizing`,
    );
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
  if (json) emit(write, { runId: id, replay: report.replay });
  else write(`${output.trimEnd()}\nreplay ${id}: ${report.replay.status}\n`);
  return passed ? 0 : 1;
}

async function compareCommand(id: string, flags: Values, write: Write, deps: Dependencies): Promise<number> {
  const values = flags as Record<string, string | undefined>;
  const cwd = deps.cwd ?? process.cwd();
  const result = await compareRun(cwd, id, {
    base: values.base,
    head: values.head,
    provenance: {
      repository: values.repo,
      pullRequest: values.pr,
      baseSha: values['base-sha'],
      headSha: values['head-sha'],
      deployment: values.deployment,
      approved: values.approved,
    },
    hooks: values.hooks,
    env: deps.env ?? process.env,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (values.markdown) await writeFile(resolvePath(cwd, values.markdown), renderCompareMarkdown(result));
  if (values.json) emit(write, result);
  else write(renderCompareText(result));
  return result.outcome === 'regression' ? 1 : 0;
}

async function publishCommand(path: string, values: Values, write: Write, deps: Dependencies): Promise<number> {
  const env = deps.env ?? process.env;
  const evidence = values.evidence as string | undefined;
  if (evidence !== undefined && !/^https:\/\/[^\s()<>[\]]+$/u.test(evidence))
    throw new CliError('usage', '--evidence must be an https URL without spaces, parentheses, or angle brackets');
  if (!env.GITHUB_TOKEN) throw new ConfigError('cohort publish needs GITHUB_TOKEN, a token that can comment');
  const text = await readFile(resolvePath(deps.cwd ?? process.cwd(), path), 'utf8').catch(() => {
    throw new CliError('not_found', `cannot read ${path}`);
  });
  const result = await publishCompare(parseCompareReport(text), {
    token: env.GITHUB_TOKEN,
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
    ...(evidence ? { evidenceUrl: evidence } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (values.json) emit(write, result);
  else write(`publish: ${result.action}${result.reason ? ` (${result.reason})` : ''}\n`);
  return 0;
}

async function validateCommand(json: boolean, write: Write, deps: Dependencies): Promise<number> {
  const { personas, suites, problems } = await checkProject(deps.cwd ?? process.cwd());
  if (json) emit(write, { personas, suites, problems });
  else {
    for (const problem of problems) write(`error: ${problem}\n`);
    write(`${personas} valid persona(s), ${suites} suite(s), ${problems.length} problem(s)\n`);
  }
  return problems.length === 0 ? 0 : 2;
}

async function generateCommand(values: Values, write: Write, deps: Dependencies): Promise<number> {
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
  if (values.json) emit(write, { id, markdown, saved: outPath, cost, capEnforcement, usage });
  else {
    write(markdown);
    const named = !outPath || outPath.endsWith(`/${id}.md`) ? '' : `; rename it to ${id}.md to run it`;
    write(`${outPath ? `saved ${out}` : 'preview only'} (${resolved.provider}/${resolved.model}, ${cost})${named}\n`);
  }
  return 0;
}

async function uiCommand(
  values: Record<string, string | string[] | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
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

async function loginCommand(
  values: Record<string, string | string[] | boolean | undefined>,
  write: Write,
  deps: Dependencies,
): Promise<number> {
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

function showTrace(tracePath: string): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve) => {
    spawn(process.execPath, [cli, 'show-trace', tracePath], { stdio: 'inherit' }).on('exit', (code) =>
      resolve(code ?? 1),
    );
  });
}

async function traceCommand(id: string, json: boolean, write: Write, deps: Dependencies): Promise<number> {
  const { kind, dir } = await bundleDir(deps.cwd ?? process.cwd(), id);
  if (kind !== 'run') throw new BundleError('cohort trace takes a run ID, not a batch ID');
  const tracePath = join(dir, 'trace.zip');
  if (!(await lstat(tracePath).catch(() => null))?.isFile())
    throw new BundleError(`${id} has no trace.zip`, 'not_found');
  // The viewer is a desktop window; JSON callers get the private file's path instead.
  if (json) {
    emit(write, { runId: id, path: tracePath });
    return 0;
  }
  return (deps.openTrace ?? showTrace)(tracePath);
}

function submissionFrom(values: Values): RunSubmission {
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

type Plan = ReturnType<typeof preflight>;

function budgetLine(plan: Plan): string {
  return plan.maxBatchUsd === null
    ? 'maximum batch budget: unenforceable (some models have unknown prices)'
    : `maximum batch budget: $${plan.maxBatchUsd.toFixed(2)}`;
}

function costRefusal(plan: Plan, values: Values): { maxUsd: number; refusal: CliError | null } {
  const maxUsd = values['max-usd'] === undefined ? DEFAULT_MAX_USD : Number(values['max-usd']);
  if (!(Number.isFinite(maxUsd) && maxUsd > 0 && maxUsd <= 1000))
    throw new CliError('usage', '--max-usd must be in (0, 1000]');
  const preview = { preflight: plan.lines, plans: plan.plans, maxBatchUsd: plan.maxBatchUsd, maxUsd };
  if (plan.maxBatchUsd === null && values['allow-unpriced'] !== true)
    return {
      maxUsd,
      refusal: new CliError(
        'cap_unenforceable',
        'a model has unknown prices, so the dollar cap cannot be enforced; add dated prices to .cohort/models.yml or pass --allow-unpriced',
        { estimate: preview },
      ),
    };
  if (plan.maxBatchUsd !== null && plan.maxBatchUsd > maxUsd)
    return {
      maxUsd,
      refusal: new CliError(
        'over_budget',
        `maximum batch budget $${plan.maxBatchUsd.toFixed(2)} exceeds the $${maxUsd} ceiling; lower --repeats or --dollars, or raise --max-usd`,
        { estimate: preview },
      ),
    };
  return { maxUsd, refusal: null };
}

async function estimateCommand(ctx: Context): Promise<number> {
  const { plan } = await estimate(
    ctx.root,
    ctx.providers,
    submissionFrom(ctx.values),
    ctx.values['allow-untested'] === true,
  );
  const { maxUsd, refusal } = costRefusal(plan, ctx.values);
  if (ctx.json)
    emit(ctx.write, {
      preflight: plan.lines,
      plans: plan.plans,
      maxBatchUsd: plan.maxBatchUsd,
      maxUsd,
      refusal: refusal ? { code: refusal.code, error: refusal.message } : null,
    });
  else {
    ctx.write(`${plan.lines.join('\n')}\n${budgetLine(plan)}\n`);
    ctx.write(refusal ? `cohort run would refuse: ${refusal.message}\n` : `within the $${maxUsd} ceiling\n`);
  }
  return 0;
}

async function workerCommand(ctx: Context, deps: Dependencies): Promise<number> {
  const batch = JSON.parse(await readInput({ ...ctx, values: { file: '-' } })) as DetachedBatch;
  const started = await startBatch(
    {
      projectRoot: ctx.root,
      providers: ctx.providers,
      env: deps.env ?? process.env,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    batch,
  );
  ctx.write(`${JSON.stringify({ batchId: started.batchId, runIds: started.runIds })}\n`);
  await started.done;
  return 0;
}

// A detached batch needs a process that outlives this one; the child owns the batch in the index and exits when done.
function spawnWorker(projectRoot: string, env: NodeJS.ProcessEnv, batch: DetachedBatch) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), WORKER, '--json'], {
    cwd: projectRoot,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // Entries travel over a pipe, never argv or the index, because a start URL may carry credentials.
  child.stdin.end(JSON.stringify(batch));
  return new Promise<{ batchId: string; runIds: string[] }>((resolve, reject) => {
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      child.stdout.destroy();
      child.unref();
      const reply = JSON.parse(text.slice(0, end)) as {
        batchId: string;
        runIds: string[];
        error?: string;
        code?: string;
      };
      if (reply.error) reject(new CliError(reply.code ?? 'internal', reply.error));
      else resolve(reply);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new CliError('internal', `the batch process exited (${code}) before starting the batch`)),
    );
  });
}

function exploreValues(values: Values): Values {
  const refused = ['persona', 'tag', 'suite', 'note', 'repeats'].filter((key) => values[key] !== undefined);
  if (refused.length > 0) throw new CliError('usage', `cohort explore does not take --${refused.join(', --')}`);
  if (values.url === undefined) throw new CliError('usage', 'cohort explore needs --url <url>');
  return { ...values, note: EXPLORE_GOAL, repeats: '1' };
}

function exploreScrub(env: NodeJS.ProcessEnv, providers: Record<string, ProviderAdapter>, url?: string) {
  const keys = [...Object.values(createProviders(env)), ...Object.values(providers)].flatMap(
    (provider) => env[provider.keyEnv] ?? [],
  );
  const secrets = url && URL.canParse(url) ? urlSecrets(new URL(url)) : new SecretStore();
  return (text: string): string => scrubEnv(text, secrets, keys);
}

function writeSummary(write: Write, summary: ExploreSummary): void {
  const dir = `.cohort/runs/${summary.runId}`;
  for (const feature of summary.features) write(`feature: ${feature.name} (steps ${feature.steps.join(', ')})\n`);
  for (const item of summary.untried) write(`untried: ${item.step} ${item.reason}\n`);
  for (const item of summary.dropped) write(`dropped ${item.kind} ${item.name}: ${item.reason}\n`);
  write(
    `${summary.personas.length} persona(s), ${summary.goals.length} goal(s), ${summary.tests.length} test(s) suggested in ${dir}/suggestions; ${summary.coverage}\n`,
  );
  for (const persona of summary.personas)
    write(`review, then: cohort explore save ${summary.runId} --persona ${persona.id} --yes\n`);
  if (summary.suite) write(`review, then: cohort explore save ${summary.runId} --suite ${summary.suite.id} --yes\n`);
}

async function suggestCommand(runId: string, ctx: Context, deps: Dependencies): Promise<number> {
  const summary = await suggest({
    projectRoot: ctx.root,
    runId,
    providers: ctx.providers,
    scrub: exploreScrub(deps.env ?? process.env, ctx.providers),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (ctx.json) emit(ctx.write, summary);
  else writeSummary(ctx.write, summary);
  return 0;
}

async function saveCommand(runId: string, ctx: Context): Promise<number> {
  const { values } = ctx;
  const kind = values.persona !== undefined ? 'personas' : 'suites';
  const id = (values.persona ?? values.suite) as string | undefined;
  if (!id || (values.persona !== undefined && values.suite !== undefined))
    throw new CliError('usage', 'cohort explore save <run-id> needs one of --persona <id> or --suite <id>');
  if (values.yes !== true) {
    const { dir } = await bundleDir(ctx.root, runId);
    const name = kind === 'personas' ? `suggestions/personas/${id}.md` : 'suggestions/suite.yml';
    const source = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) ? await readBundleFile(dir, name) : null;
    if (!ctx.json && source !== null) ctx.write(source);
    throw new CliError('confirmation_required', `review ${name} in ${runId}, then pass --yes to save it`);
  }
  const saved = await saveSuggestion(ctx.root, runId, kind, id, values.revision as string | undefined);
  const path = `.cohort/${kind}/${saved.id}.${kind === 'personas' ? 'md' : 'yml'}`;
  if (ctx.json) emit(ctx.write, { id: saved.id, revision: saved.revision, path, action: saved.action });
  else ctx.write(`${saved.action} ${path}\n`);
  return 0;
}

async function runCommand(
  given: Values,
  write: Write,
  deps: Dependencies,
  ctx: Context,
  explore = false,
): Promise<number> {
  const projectRoot = ctx.root;
  const env = deps.env ?? process.env;
  const { providers } = ctx;
  const values = explore ? exploreValues(given) : given;
  const submission = submissionFrom(values);
  const estimated = await estimate(projectRoot, providers, submission, values['allow-untested'] === true);
  const entries = explore
    ? estimated.entries.map((entry) => ({ ...entry, explore: true as const }))
    : estimated.entries;
  const plan =
    explore && estimated.plan.maxBatchUsd !== null
      ? { ...estimated.plan, maxBatchUsd: estimated.plan.maxBatchUsd + SUGGEST_DOLLARS }
      : estimated.plan;
  if (!values.json) write(`${plan.lines.join('\n')}\n${budgetLine(plan)}\n`);
  const { maxUsd, refusal } = costRefusal(plan, values);
  if (refusal) throw refusal;
  const request = {
    submission: submission.url ? { ...submission, url: safeUrl(submission.url, new SecretStore()) } : submission,
    allowUntested: values['allow-untested'] === true,
    source: explore ? 'explore' : 'cli',
  };
  if (values.detach) {
    const started = await (deps.worker ?? ((batch) => spawnWorker(projectRoot, env, batch)))({ entries, request });
    if (values.json)
      emit(write, { ...started, preflight: plan.lines, plans: plan.plans, maxBatchUsd: plan.maxBatchUsd, maxUsd });
    else
      write(
        `batch ${started.batchId} started in the background; next: cohort runs wait ${started.batchId}${explore ? `, then cohort explore suggest ${started.runIds[0]}` : ''}\n`,
      );
    return 0;
  }
  const db = await openIndex(projectRoot).catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      'index_unavailable',
      `cannot open .cohort/index.sqlite (${error.code ?? error.name}); a foreground run needs a writable index`,
    );
  });
  const batch = await runOwnedBatch(
    db,
    {
      projectRoot,
      entries,
      providers,
      env,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onRunStart: values.json
        ? undefined
        : (started) => write(`run ${started.runId} (${started.personaId}, repeat ${started.repeat + 1})\n`),
    },
    request,
  ).finally(() => db.close());
  if (explore) {
    const [explored] = batch.runs;
    if (!explored) throw new CliError('interrupted', 'the exploration run did not start');
    const summary = await suggest({
      projectRoot,
      runId: explored.runId,
      providers,
      scrub: exploreScrub(env, providers, values.url as string),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (values.json) emit(write, { batchId: batch.batchId, maxUsd, runOutcome: explored.outcome, ...summary });
    else {
      write(`${explored.runId}: ${explored.outcome.state}: ${explored.outcome.reason}\n`);
      writeSummary(write, summary);
    }
    return 0;
  }
  const exitCode = batch.skipped === 0 && batch.runs.every((item) => item.outcome.state === 'completed') ? 0 : 1;
  if (values.json)
    emit(write, {
      batchId: batch.batchId,
      preflight: plan.lines,
      plans: plan.plans,
      maxBatchUsd: plan.maxBatchUsd,
      maxUsd,
      runs: batch.runs,
      skipped: batch.skipped,
      summary: batch.summary,
      reportDir: batch.reportDir,
      exitCode,
    });
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
      // Bounded and key-free; COHORT_DEBUG=1 adds the stack.
      const keys = Object.values(createProviders()).flatMap((provider) => process.env[provider.keyEnv] ?? []);
      const text = process.env.COHORT_DEBUG === '1' ? String((error as Error)?.stack ?? error) : firstLine(error);
      const scrubbed = scrubEnv(text, new SecretStore(), keys);
      process.stderr.write(`cohort: unexpected error: ${scrubbed}\n`);
      if (process.argv.includes('--json'))
        emit((out) => process.stdout.write(out), { error: firstLine(scrubbed), code: 'internal' });
      return 2;
    },
  );
}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .split('\n')[0]!
    .slice(0, 500);
}
