import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from './files.ts';

const CONFIG = `schemaVersion: 1
# <provider>/<id> from the model catalog. \`lab doctor\` shows whether it is usable.
model: anthropic/claude-sonnet-5-5
repeats: 3
limits:
  steps: 40
  timeMs: 600000
  dollars: 2.00
allowedOrigins: []
`;

// Private evidence and credentials; see docs/operating.md.
const GITIGNORE = 'auth/\nruns/\nindex.sqlite*\n';

const EXAMPLES = new URL('../../examples/personas/', import.meta.url);

/** Creates the `.lab` project layout; never overwrites an existing file. */
export async function initProject(projectRoot: string): Promise<{ created: string[]; kept: string[] }> {
  const created: string[] = [];
  const kept: string[] = [];
  for (const dir of ['.lab', '.lab/personas', '.lab/suites', '.lab/setup']) {
    await mkdir(join(projectRoot, dir), { mode: dir === '.lab' ? 0o700 : 0o777 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    if (!(await lstat(join(projectRoot, dir))).isDirectory())
      throw new ConfigError(`${dir} must be a plain directory, not a symlink or file`);
  }
  const files: [string, string][] = [
    ['.lab/config.yml', CONFIG],
    ['.lab/.gitignore', GITIGNORE],
  ];
  for (const name of (await readdir(EXAMPLES)).filter((file) => file.endsWith('.md')).toSorted())
    files.push([`.lab/personas/${name}`, await readFile(new URL(name, EXAMPLES), 'utf8')]);
  for (const [path, content] of files)
    // `wx` also refuses to follow a symlink planted at the path.
    await writeFile(join(projectRoot, path), content, { flag: 'wx' }).then(
      () => created.push(path),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        kept.push(path);
      },
    );
  return { created, kept };
}
