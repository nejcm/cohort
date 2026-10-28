import { lstat, realpath } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SetupModule } from './types.ts';

export class SetupLoadError extends Error {
  override name = 'SetupLoadError';
}

// Node 24 strips TypeScript types natively; setup modules must use explicit `.ts` relative imports.
export async function loadSetupModule(projectRoot: string, modulePath: string): Promise<SetupModule> {
  const setupDir = join(projectRoot, '.lab', 'setup');
  const rel = relative(setupDir, modulePath);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep))
    throw new SetupLoadError(`setup module must be inside .lab/setup/: ${modulePath}`);
  if (!['.ts', '.js', '.mjs'].includes(extname(modulePath)))
    throw new SetupLoadError(`setup module must be .ts, .js, or .mjs: ${modulePath}`);
  let current = projectRoot;
  for (const part of ['.lab', 'setup', ...rel.split(sep)]) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new SetupLoadError(`symlink in setup path: ${current}`);
  }
  const real = await realpath(modulePath);
  if (!real.startsWith((await realpath(setupDir)) + sep)) throw new SetupLoadError(`setup module escapes .lab/setup/`);
  const loaded = (await import(pathToFileURL(real).href)) as { default?: unknown };
  if (typeof loaded.default !== 'function') throw new SetupLoadError(`setup module has no default function export`);
  return loaded.default as SetupModule;
}
