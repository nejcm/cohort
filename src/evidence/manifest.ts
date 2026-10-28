import { randomBytes } from 'node:crypto';
import { lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import type { ResolvedModel } from '../providers/catalog.ts';
import type { Effort } from '../providers/types.ts';

type Sensitivity = 'private_raw' | 'redacted_sensitive' | 'redacted' | 'placeholder_bindings' | 'no_secret_values';

export interface ManifestArtifact {
  path: string;
  mediaType: string;
  bytes: number;
  sensitivity: Sensitivity;
}

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  batchId: string;
  createdAt: string;
  finalizedAt: string;
  toolVersion: string;
  runtime: { node: string; playwright: string; chromium: string | null };
  configuration: {
    personaId: string;
    personaHash: string;
    suiteId: string | null;
    resolvedConfigHash: string | null;
    setupHash: string | null;
    mode: 'vision' | 'text';
    provider: string;
    model: string;
    effort: Effort;
    catalog: ResolvedModel['catalog'];
  };
  sensitivity: { traceMayContainSecrets: true; otherArtifactsMayContainSensitiveContent: true };
  artifacts: ManifestArtifact[];
}

const MEDIA_TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.ts': 'text/typescript',
  '.md': 'text/markdown',
  '.html': 'text/html',
};
const TEMP = /\.tmp-[0-9a-f]+$/u;

function sensitivityOf(path: string): Sensitivity {
  if (path === 'trace.zip') return 'private_raw';
  if (path.startsWith('screenshots/') || path.startsWith('report.')) return 'redacted_sensitive';
  if (path === 'replay.spec.ts') return 'placeholder_bindings';
  return 'redacted';
}

/** Writes beside the target and renames, so readers never see a partial file. */
export async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Regular files under `outDir`; symlinks and other entries are rejected, never followed. */
export async function inventory(outDir: string): Promise<{ artifacts: ManifestArtifact[]; rejected: string[] }> {
  const artifacts: ManifestArtifact[] = [];
  const rejected: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const name of (await readdir(join(outDir, relative))).toSorted()) {
      const path = relative ? posix.join(relative, name) : name;
      if (path === 'manifest.json' || TEMP.test(name)) continue;
      const info = await lstat(join(outDir, path));
      if (info.isDirectory()) await walk(path);
      else if (info.isFile())
        artifacts.push({
          path,
          mediaType: MEDIA_TYPES[extname(name)] ?? 'application/octet-stream',
          bytes: info.size,
          sensitivity: sensitivityOf(path),
        });
      else rejected.push(path);
    }
  }
  await walk('');
  return { artifacts, rejected };
}

export async function writeManifest(
  outDir: string,
  manifest: Omit<RunManifest, 'schemaVersion' | 'finalizedAt' | 'sensitivity' | 'artifacts'>,
): Promise<{ manifest: RunManifest; rejected: string[] }> {
  const { artifacts, rejected } = await inventory(outDir);
  const complete: RunManifest = {
    schemaVersion: 1,
    ...manifest,
    finalizedAt: new Date().toISOString(),
    sensitivity: { traceMayContainSecrets: true, otherArtifactsMayContainSensitiveContent: true },
    artifacts,
  };
  await writeAtomic(join(outDir, 'manifest.json'), `${JSON.stringify(complete, null, 2)}\n`);
  return { manifest: complete, rejected };
}
