import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ConfigError } from './files.ts';

const CONFIG = `schemaVersion: 1
# <provider>/<id> from the model catalog. \`cohort doctor\` shows whether it is usable.
model: openai/gpt-6.1-terra
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
const SUITES = new URL('../../examples/suites/', import.meta.url);
const PACK_SUFFIX = '-pack.yml';
const DEFAULT_TEMPLATES = ['first-time-host', 'mobile-first-guest', 'returning-desktop-user'];

/** The shipped persona templates, sorted by id. */
export async function personaTemplates(): Promise<{ id: string; source: string }[]> {
  const names = (await readdir(TEMPLATES)).filter((file) => file.endsWith('.md')).toSorted();
  return Promise.all(
    names.map(async (name) => ({ id: name.slice(0, -3), source: await readFile(new URL(name, TEMPLATES), 'utf8') })),
  );
}

/** The shipped scenario packs (`examples/suites/<id>-pack.yml`), sorted by id, with the personas each suite names. */
async function scenarioPacks(): Promise<{ id: string; suiteId: string; source: string; personas: string[] }[]> {
  const names = (await readdir(SUITES)).filter((file) => file.endsWith(PACK_SUFFIX)).toSorted();
  return Promise.all(
    names.map(async (name) => {
      const source = await readFile(new URL(name, SUITES), 'utf8');
      const suite = parse(source) as { entries: { persona: string }[] };
      return {
        id: name.slice(0, -PACK_SUFFIX.length),
        suiteId: name.slice(0, -'.yml'.length),
        source,
        personas: [...new Set(suite.entries.map((entry) => entry.persona))],
      };
    }),
  );
}

/**
 * Creates the `.cohort` project layout with the chosen persona templates and scenario packs; never overwrites an
 * existing file. A pack copies its suite and the templates it names; with packs and no templates, only those are copied.
 */
export async function initProject(
  projectRoot: string,
  templateIds?: string[],
  packIds: string[] = [],
): Promise<{ created: string[]; kept: string[] }> {
  const templates = await personaTemplates();
  const unknown = (templateIds ?? []).filter((id) => !templates.some((template) => template.id === id));
  if (unknown.length > 0)
    throw new ConfigError(
      `unknown template ${unknown.join(', ')}; known templates: ${templates.map((template) => template.id).join(', ')}`,
    );
  const packs = await scenarioPacks();
  const unknownPacks = packIds.filter((id) => !packs.some((pack) => pack.id === id));
  if (unknownPacks.length > 0)
    throw new ConfigError(
      `unknown pack ${unknownPacks.join(', ')}; known packs: ${packs.map((pack) => pack.id).join(', ')}`,
    );
  const chosen = packs.filter((pack) => packIds.includes(pack.id));
  const personaIds = new Set([
    ...(templateIds ?? (chosen.length > 0 ? [] : DEFAULT_TEMPLATES)),
    ...chosen.flatMap((pack) => pack.personas),
  ]);
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
    if (personaIds.has(template.id)) files.push([`.cohort/personas/${template.id}.md`, template.source]);
  for (const pack of chosen) files.push([`.cohort/suites/${pack.suiteId}.yml`, pack.source]);
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
