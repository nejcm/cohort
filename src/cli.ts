#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError } from './config/files.ts';
import { EditError } from './config/editable.ts';
import { PublishError } from './core/publish.ts';
import { BundleError } from './evidence/bundle.ts';
import { CatalogError } from './providers/catalog.ts';
import { createProviders } from './providers/registry.ts';
import { ProviderError, type ProviderAdapter } from './providers/types.ts';
import { GenerateError } from './personas/generate.ts';
import { QueueError } from './dashboard/runner.ts';
import { COMMANDS, renderHelp } from './help.ts';
import { scrubEnv } from './setup/run.ts';
import { SecretStore } from './setup/secrets.ts';
import { CliError, emit, type Context, type Dependencies, type Values, type Write } from './commands/context.ts';
import { compareCommand, publishCommand, replayCommand, reportCommand, traceCommand } from './commands/evidence.ts';
import { configCommand, fileCommand, modelsCommand } from './commands/files.ts';
import { doctorCommand, generateCommand, initCommand, validateCommand } from './commands/project.ts';
import {
  DEFAULT_MAX_USD,
  estimateCommand,
  runCommand,
  saveCommand,
  spawnWorker,
  suggestCommand,
  WORKER,
  workerCommand,
} from './commands/run.ts';
import { runsCommand } from './commands/runs.ts';
import { loginCommand, uiCommand } from './commands/serve.ts';

const USAGE = `Usage: cohort [options]
       cohort init [--template <id>]... [--pack keyboard|small-screen]...
       cohort doctor
       cohort config show | edit --file <path>|- [--revision <sha256>]
       cohort models list | show | edit --file <path>|- [--revision <sha256>]
       cohort estimate (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options]
       cohort run (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options] [--detach]
       cohort explore --url <url> [--mode|--model|--effort|--steps|--time-ms|--dollars|--max-usd] [--detach]
       cohort explore suggest <run-id>
       cohort explore save <run-id> (--persona <id> | --suite <id>) [--revision <sha256>] --yes
       cohort runs list [--limit <n>] [--filter active|look|blocked|finished] [--sort <key>] [--asc] [--search <text>]
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
       cohort help [command]

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
  pack: { type: 'string', multiple: true },
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
  if (positionals[0] === 'help' && positionals.length <= 2) {
    const text = renderHelp(positionals[1]);
    if (text === undefined) {
      const known = COMMANDS.map((command) => command.name).join(', ');
      const message = `unknown command: ${positionals[1]} (known: ${known})`;
      if (values.json) emit(write, { error: message, code: 'usage' });
      else write(`Error: ${message}\n`);
      return 2;
    }
    if (values.json)
      emit(write, {
        commands: COMMANDS.filter((command) => positionals[1] === undefined || command.name === positionals[1]),
      });
    else write(text);
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
  const env = deps.env ?? process.env;
  const ctx: Context = {
    root: deps.cwd ?? process.cwd(),
    values,
    write,
    json,
    providers: deps.providers ?? createProviders(env),
    stdin: deps.stdin ?? process.stdin,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
  if (['run', 'explore', 'ui', WORKER].includes(command!) || (command === 'persona' && id === 'generate'))
    refuseShortKeys(env, ctx.providers);
  if (command === 'init' && id === undefined) return initCommand(ctx);
  if (command === 'doctor' && id === undefined) return doctorCommand(ctx, env);
  if (command === WORKER && id === undefined) return workerCommand(ctx, deps);
  if ((command === 'run' || command === 'explore') && id === undefined) {
    // Only this module knows which script a detached batch must re-run (src/cli.ts or dist/cli.js).
    const worker = deps.worker ?? ((batch) => spawnWorker(fileURLToPath(import.meta.url), ctx.root, env, batch));
    return runCommand(values, write, { ...deps, worker }, ctx, command === 'explore');
  }
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
