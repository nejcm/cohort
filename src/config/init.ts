import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from './files.ts';

const CONFIG = `schemaVersion: 1
# <provider>/<id> from the model catalog. \`cohort doctor\` shows whether it is usable.
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

const TEMPLATES = new URL('../../examples/personas/', import.meta.url);
const DEFAULT_TEMPLATES = ['first-time-host', 'mobile-first-guest', 'returning-desktop-user'];

/** The shipped persona templates, sorted by id. */
export async function personaTemplates(): Promise<{ id: string; source: string }[]> {
  const names = (await readdir(TEMPLATES)).filter((file) => file.endsWith('.md')).toSorted();
  return Promise.all(
    names.map(async (name) => ({ id: name.slice(0, -3), source: await readFile(new URL(name, TEMPLATES), 'utf8') })),
  );
}

/** Creates the `.cohort` project layout with the chosen persona templates; never overwrites an existing file. */
export async function initProject(
  projectRoot: string,
  templateIds: string[] = DEFAULT_TEMPLATES,
): Promise<{ created: string[]; kept: string[] }> {
  const templates = await personaTemplates();
  const unknown = templateIds.filter((id) => !templates.some((template) => template.id === id));
  if (unknown.length > 0)
    throw new ConfigError(
      `unknown template ${unknown.join(', ')}; known templates: ${templates.map((template) => template.id).join(', ')}`,
    );
  const created: string[] = [];
  const kept: string[] = [];
  for (const dir of ['.cohort', '.cohort/personas', '.cohort/suites', '.cohort/setup']) {
    await mkdir(join(projectRoot, dir), { mode: dir === '.cohort' ? 0o700 : 0o777 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    if (!(await lstat(join(projectRoot, dir))).isDirectory())
      throw new ConfigError(`${dir} must be a plain directory, not a symlink or file`);
  }
  const files: [string, string][] = [
    ['.cohort/config.yml', CONFIG],
    ['.cohort/.gitignore', GITIGNORE],
  ];
  for (const template of templates)
    if (templateIds.includes(template.id)) files.push([`.cohort/personas/${template.id}.md`, template.source]);
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
