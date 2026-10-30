import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inventory, writeAtomic, writeManifest, type BundleIdentity, type RunManifest } from './manifest.ts';
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
  readonly code: 'invalid' | 'not_found';

  constructor(message: string, code: 'invalid' | 'not_found' = 'invalid') {
    super(message);
    this.code = code;
  }
}

const RUNS = '.cohort/runs';
export const runsDir = (projectRoot: string): string => join(projectRoot, RUNS);
export const runDir = (projectRoot: string, id: string): string => join(projectRoot, RUNS, id);
/** The POSIX spelling relative to the project root, for the index and printed paths. */
export const relativeRunDir = (id: string): string => `${RUNS}/${id}`;

/** Resolves a run or batch directory by ID; IDs are generated, so anything else is rejected before touching the filesystem. */
export async function bundleDir(projectRoot: string, id: string): Promise<{ kind: 'run' | 'batch'; dir: string }> {
  const kind = RUN_ID.test(id) ? 'run' : BATCH_ID.test(id) ? 'batch' : null;
  if (!kind) throw new BundleError(`not a run or batch ID: ${id}`, 'not_found');
  const runs = runsDir(projectRoot);
  const dir = runDir(projectRoot, id);
  for (const path of [join(projectRoot, '.cohort'), runs, dir]) {
    const info = await lstat(path).catch(() => null);
    if (!info) throw new BundleError(`no artifacts for ${id}`, 'not_found');
    if (!info.isDirectory()) throw new BundleError(`${id}: artifact path is not a plain directory`);
  }
  return { kind, dir };
}

/** Reads a bundle file, or null when it is missing; a symlink or other non-regular entry is a BundleError. */
export async function readBundleFile(dir: string, name: string): Promise<string | null> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(join(dir, name), flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new BundleError(`${name} is not a regular file`);
  });
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) throw new BundleError(`${name} is not a regular file`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function readBundleJson<T>(dir: string, name: string): Promise<T> {
  const text = await readBundleFile(dir, name);
  if (text === null) throw new BundleError(`${name} is missing`);
  return JSON.parse(text) as T;
}

// Files a recorded run writes; anything else (a planted playwright.config or node_modules) could run during replay.
const RUN_FILES =
  /^(report\.(json|md|html)|steps\.jsonl|resolved-config\.json|replay\.spec\.ts|trace\.zip|screenshots\/[\w.-]+\.png)$/u;

/** Refuses a run bundle whose files differ from its manifest's SHA-256 hashes; returns the manifest. */
export async function verifyBundle(dir: string): Promise<RunManifest> {
  const manifest = await readBundleJson<RunManifest>(dir, 'manifest.json');
  const { artifacts, rejected } = await inventory(dir);
  if (rejected.length > 0) throw new BundleError(`${rejected[0]} is not a regular file`);
  const listed = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  for (const artifact of artifacts) {
    if (!RUN_FILES.test(artifact.path)) throw new BundleError(`${artifact.path} is not a file a run writes`);
    if (listed.get(artifact.path) !== artifact.sha256)
      throw new BundleError(`${artifact.path} does not match its SHA-256 hash in manifest.json`);
  }
  const present = new Set(artifacts.map((artifact) => artifact.path));
  // Uploaded bundles leave out the private trace; nothing reads it during replay.
  const missing = [...listed.keys()].find((path) => !present.has(path) && path !== 'trace.zip');
  if (missing) throw new BundleError(`${missing} is listed in manifest.json but missing`);
  return manifest;
}

export async function readSteps(dir: string): Promise<StepRecord[]> {
  const text = (await readBundleFile(dir, 'steps.jsonl')) ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StepRecord);
}

const runReports = (report: RunReport, steps: readonly StepRecord[]): [string, () => string][] => [
  ['report.json', () => `${JSON.stringify(report, null, 2)}\n`],
  ['report.md', () => renderRunMarkdown(report, steps)],
  ['report.html', () => renderRunHtml(report, steps)],
];

async function writeRunReports(dir: string, report: RunReport, steps: readonly StepRecord[]): Promise<void> {
  for (const [name, render] of runReports(report, steps)) await writeAtomic(join(dir, name), render());
}

export interface BundleFailure {
  path: string;
  message: string;
}

/** Writes report.json, report.md, report.html, then manifest.json; never throws. A failed write hands the failures to `degrade` and writes its report once more. */
export async function writeBundle(
  dir: string,
  identity: BundleIdentity,
  report: RunReport,
  steps: readonly StepRecord[],
  degrade?: (failed: BundleFailure[]) => RunReport,
): Promise<{ report: RunReport; written: string[]; failed: BundleFailure[] }> {
  const first = await writePass(dir, identity, report, steps);
  if (first.failed.length === 0 || !degrade) return { report, ...first };
  const degraded = degrade(first.failed);
  return { report: degraded, ...(await writePass(dir, identity, degraded, steps, first.written)) };
}

// A plain pass writes manifest.json only after every report. The degraded pass (`stale` set) needs only its own
// report.json, and first removes earlier files it could not rewrite, since they describe the run it no longer is.
async function writePass(
  dir: string,
  identity: BundleIdentity,
  report: RunReport,
  steps: readonly StepRecord[],
  stale?: readonly string[],
): Promise<{ written: string[]; failed: BundleFailure[] }> {
  const written: string[] = [];
  const failed: BundleFailure[] = [];
  const attempt = async (path: string, write: () => Promise<unknown>): Promise<void> => {
    try {
      await write();
      written.push(path);
    } catch (error) {
      failed.push({ path, message: String((error as Error)?.message ?? error) });
    }
  };
  for (const [name, render] of runReports(report, steps)) {
    await attempt(name, () => writeAtomic(join(dir, name), render()));
    if (!written.includes('report.json')) break;
  }
  for (const path of stale ?? [])
    if (!written.includes(path)) await rm(join(dir, path), { force: true }).catch(() => {});
  if (written.includes('report.json') && (stale || failed.length === 0))
    await attempt('manifest.json', () => writeManifest(dir, identity));
  return { written, failed };
}

export async function writeBatchReports(dir: string, report: BatchReport): Promise<void> {
  await writeAtomic(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(join(dir, 'report.md'), renderBatchMarkdown(report));
  await writeAtomic(join(dir, 'report.html'), renderBatchHtml(report));
}

async function bundleIdentity(dir: string): Promise<BundleIdentity> {
  const {
    schemaVersion: _,
    finalizedAt: _f,
    sensitivity: _s,
    artifacts: _a,
    ...identity
  } = await readBundleJson<RunManifest>(dir, 'manifest.json');
  return identity;
}

/** Re-inventories a finalized run under a fresh manifest that keeps its identity. */
export async function reinventory(dir: string): Promise<void> {
  await writeManifest(dir, await bundleIdentity(dir));
}

/** Rewrites a finalized run's reports from a changed report, then re-inventories it under a fresh manifest. */
export async function refreshRun(dir: string, change: (report: RunReport) => RunReport): Promise<RunReport> {
  const report = change(await readBundleJson<RunReport>(dir, 'report.json'));
  const identity = await bundleIdentity(dir);
  await writeRunReports(dir, report, await readSteps(dir));
  await writeManifest(dir, identity);
  return report;
}
