import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { ConfigError } from '../config/files.ts';
import { compareRun, renderCompareMarkdown, renderCompareText } from '../core/compare.ts';
import { parseCompareReport, publishCompare } from '../core/publish.ts';
import { replayRun } from '../core/replay.ts';
import { BundleError, bundleDir, readBundleFile, readSteps } from '../evidence/bundle.ts';
import {
  renderBatchHtml,
  renderBatchMarkdown,
  renderRunHtml,
  renderRunMarkdown,
  type BatchReport,
  type RunReport,
} from '../evidence/report.ts';
import { CliError, emit, type Dependencies, type Values, type Write } from './context.ts';

export async function reportCommand(id: string, format: string, write: Write, deps: Dependencies): Promise<number> {
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

export async function replayCommand(id: string, json: boolean, write: Write, deps: Dependencies): Promise<number> {
  const { report, output } = await replayRun(deps.cwd ?? process.cwd(), id, {
    env: deps.env ?? process.env,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const passed = report.replay.status === 'passed';
  if (json) emit(write, { runId: id, replay: report.replay });
  else write(`${output.trimEnd()}\nreplay ${id}: ${report.replay.status}\n`);
  return passed ? 0 : 1;
}

export async function compareCommand(id: string, flags: Values, write: Write, deps: Dependencies): Promise<number> {
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

export async function publishCommand(path: string, values: Values, write: Write, deps: Dependencies): Promise<number> {
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

function showTrace(tracePath: string): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve) => {
    spawn(process.execPath, [cli, 'show-trace', tracePath], { stdio: 'inherit' }).on('exit', (code) =>
      resolve(code ?? 1),
    );
  });
}

export async function traceCommand(id: string, json: boolean, write: Write, deps: Dependencies): Promise<number> {
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
