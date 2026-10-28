import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic, writeManifest, type RunManifest } from './manifest.ts';
import {
  renderBatchHtml,
  renderBatchMarkdown,
  renderRunHtml,
  renderRunMarkdown,
  type BatchReport,
  type RunReport,
} from './report.ts';
import type { StepRecord } from './steps.ts';

const RUN_ID = /^run_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;
const BATCH_ID = /^batch_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;

export class BundleError extends Error {
  override name = 'BundleError';
}

/** Resolves a run or batch directory by ID; IDs are generated, so anything else is rejected before touching the filesystem. */
export async function bundleDir(projectRoot: string, id: string): Promise<{ kind: 'run' | 'batch'; dir: string }> {
  const kind = RUN_ID.test(id) ? 'run' : BATCH_ID.test(id) ? 'batch' : null;
  if (!kind) throw new BundleError(`not a run or batch ID: ${id}`);
  const runs = join(projectRoot, '.lab', 'runs');
  const dir = join(runs, id);
  for (const path of [join(projectRoot, '.lab'), runs, dir]) {
    const info = await lstat(path).catch(() => null);
    if (!info) throw new BundleError(`no artifacts for ${id}`);
    if (!info.isDirectory()) throw new BundleError(`${id}: artifact path is not a plain directory`);
  }
  return { kind, dir };
}

export async function readSteps(dir: string): Promise<StepRecord[]> {
  const text = await readFile(join(dir, 'steps.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StepRecord);
}

export async function writeRunReports(dir: string, report: RunReport, steps: readonly StepRecord[]): Promise<void> {
  await writeAtomic(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(join(dir, 'report.md'), renderRunMarkdown(report, steps));
  await writeAtomic(join(dir, 'report.html'), renderRunHtml(report, steps));
}

export async function writeBatchReports(dir: string, report: BatchReport): Promise<void> {
  await writeAtomic(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(join(dir, 'report.md'), renderBatchMarkdown(report));
  await writeAtomic(join(dir, 'report.html'), renderBatchHtml(report));
}

/** Rewrites a finalized run's reports from a changed report, then re-inventories it under a fresh manifest. */
export async function refreshRun(dir: string, change: (report: RunReport) => RunReport): Promise<RunReport> {
  const report = change(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport);
  const previous = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  await writeRunReports(dir, report, await readSteps(dir));
  const { schemaVersion: _, finalizedAt: _f, sensitivity: _s, artifacts: _a, ...identity } = previous;
  await writeManifest(dir, identity);
  return report;
}
