#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadProjectConfig } from './config/files.ts';
import { resolveSubmission, validateSubmission, type ResolvedEntry, type RunSubmission } from './config/resolve.ts';
import { runBatch, type BatchResult } from './core/batch.ts';
import { estimateCostUsd } from './core/cost.ts';
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
import { CatalogError, loadCatalog } from './providers/catalog.ts';
import { createProviders } from './providers/registry.ts';
import type { ProviderAdapter } from './providers/types.ts';

const USAGE = `Usage: lab [options]
       lab run (--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>) [run options]
       lab report <run-or-batch-id> [--format json|md|html]
       lab replay <run-id> [--json]
       lab trace <run-id>

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
} as const;

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
  if (command === 'run' && id === undefined) return runCommand(values, write, deps);
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
  write(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
  return 2;
}

async function reportCommand(id: string, format: string, write: Write, deps: Dependencies): Promise<number> {
  if (!['json', 'md', 'html'].includes(format)) throw new BundleError('--format must be json, md, or html');
  const { kind, dir } = await bundleDir(deps.cwd ?? process.cwd(), id);
  const text = await readBundleFile(dir, 'report.json');
  if (text === null) throw new BundleError(`${id} has no report.json`);
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

// shortcut: fixed per-call token assumption (6k in, 300 out); replace with measured per-call usage from Phase 0 runs.
function costLine(entry: ResolvedEntry): { text: string; maxUsd: number | null } {
  const { pricesPerMTok: prices, untested } = entry.request.catalog.entry;
  const { steps, dollars } = entry.request.limits;
  const perCall = estimateCostUsd(
    {
      inputTokens: 6000,
      outputTokens: 300,
      cachedInputTokens: 0,
      imageInputTokens: null,
      reportedCostUsd: null,
      source: 'estimated',
    },
    prices,
  );
  const cost =
    perCall === null
      ? 'cost unknown; dollar cap unenforceable'
      : `estimated $${(perCall * 2).toFixed(2)}-$${Math.min(dollars, perCall * steps).toFixed(2)} per run`;
  return {
    text: `untested: ${untested ? 'yes' : 'no'}; ${cost}`,
    maxUsd: perCall === null ? null : dollars * entry.request.repeats,
  };
}

function preflight(entries: readonly ResolvedEntry[]): { lines: string[]; maxBatchUsd: number | null } {
  let maxBatchUsd: number | null = 0;
  const lines = entries.map((entry, index) => {
    const { request, layers } = entry;
    const cost = costLine(entry);
    maxBatchUsd = cost.maxUsd === null || maxBatchUsd === null ? null : maxBatchUsd + cost.maxUsd;
    return `${index + 1}. ${entry.persona.id} x${request.repeats}: ${request.provider}/${request.model} effort ${request.effort} (model from ${layers.modelFrom}, effort from ${layers.effortFrom}); ${cost.text}; caps ${request.limits.steps} steps, ${request.limits.timeMs} ms, $${request.limits.dollars}`;
  });
  return { lines, maxBatchUsd };
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
  process.exitCode = await run(process.argv.slice(2), undefined, { signal: controller.signal });
}
