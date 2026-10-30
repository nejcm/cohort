import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseYaml, parseDocument } from 'yaml';
import {
  ConfigError,
  listIds,
  parsePersona,
  parseProjectConfig,
  parseSuite,
  readDeclared,
  sha256,
  type SuiteEntry,
} from './files.ts';
import { writeAtomic } from '../evidence/manifest.ts';
import { CatalogError, validateCatalog } from '../providers/catalog.ts';

type Kind = 'personas' | 'suites';

export class EditError extends Error {
  override name = 'EditError';
  readonly status: 400 | 404 | 409;
  readonly problems: string[];

  constructor(status: 400 | 404 | 409, message: string | string[]) {
    const problems = typeof message === 'string' ? [message] : message;
    super(problems.join('; '));
    this.status = status;
    this.problems = problems;
  }
}

const MAX_SOURCE_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 10_000;
const SQLITE_BUSY = 5;
const EDIT_LOCK = '.cohort/index.sqlite-edit-lock';
const extension = (kind: Kind): string => (kind === 'personas' ? 'md' : 'yml');
const sourceName = (kind: Kind, id: string): string => `.cohort/${kind}/${id}.${extension(kind)}`;

function parse(kind: Kind, source: string, where: string): { id: string; setup: string | undefined; parsed: unknown } {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new EditError(400, `${where}: larger than 256 KiB`);
  try {
    if (kind === 'personas') {
      const persona = parsePersona(source, where);
      return { id: persona.id, setup: persona.setup, parsed: persona };
    }
    const suite = parseSuite(source, where);
    return { id: suite.id, setup: suite.defaults.setup, parsed: suite };
  } catch (error) {
    if (error instanceof ConfigError) throw new EditError(400, error.problems);
    throw error;
  }
}

async function plainDirectory(projectRoot: string, kind: Kind): Promise<string> {
  const dir = join(projectRoot, '.cohort', kind);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const path of [join(projectRoot, '.cohort'), dir])
    if (!(await lstat(path)).isDirectory()) throw new EditError(400, `${path} is not a plain directory`);
  return dir;
}

async function current(projectRoot: string, kind: Kind, id: string): Promise<string> {
  let source: string | null;
  try {
    source = await readDeclared(projectRoot, kind, id);
  } catch (error) {
    if (error instanceof ConfigError) throw new EditError(400, error.message);
    throw error;
  }
  if (source === null) throw new EditError(404, `no ${sourceName(kind, id)}`);
  return source;
}

async function checkReferences(projectRoot: string, kind: Kind, parsed: unknown): Promise<void> {
  if (kind !== 'suites') return;
  const known = await listIds(projectRoot, 'personas', '.md');
  const missing = (parsed as { entries: SuiteEntry[] }).entries.flatMap((entry, index) =>
    known.includes(entry.persona) ? [] : [`entries[${index}]: unknown persona ${entry.persona}`],
  );
  if (missing.length > 0) throw new EditError(400, missing);
}

export interface Editable {
  id: string;
  source: string;
  revision: string;
  parsed: unknown;
  error: string | null;
}

export async function readEditable(projectRoot: string, kind: Kind, id: string): Promise<Editable> {
  const source = await current(projectRoot, kind, id);
  try {
    return {
      id,
      source,
      revision: sha256(source),
      parsed: parse(kind, source, sourceName(kind, id)).parsed,
      error: null,
    };
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    return { id, source, revision: sha256(source), parsed: null, error: error.message };
  }
}

const writing = new Map<string, Promise<unknown>>();

// Serializes every check-then-write in a project, within this process and then across processes.
async function exclusive<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(projectRoot);
  const queued = (writing.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withLockFile(key, task));
  writing.set(key, queued);
  try {
    return await queued;
  } finally {
    if (writing.get(key) === queued) writing.delete(key);
  }
}

async function withLockFile<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  await mkdir(join(projectRoot, '.cohort'), { recursive: true, mode: 0o700 });
  await writeFile(join(projectRoot, EDIT_LOCK), '', { flag: 'a', mode: 0o600 });
  // An exclusive SQLite transaction is a cross-process lock that the OS releases if its holder dies.
  const lock = new DatabaseSync(join(projectRoot, EDIT_LOCK));
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        lock.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
        if (Date.now() > deadline) throw new EditError(409, 'another edit is in progress; retry');
        await delay(20);
      }
    }
    try {
      return await task();
    } finally {
      lock.exec('ROLLBACK');
    }
  } finally {
    lock.close();
  }
}

/** Saves only when the file still has `revision`; setup references can change only through a local file edit. */
export function saveEditable(
  projectRoot: string,
  kind: Kind,
  id: string,
  source: string,
  revision: string,
): Promise<Editable> {
  return exclusive(projectRoot, () => save(projectRoot, kind, id, source, revision));
}

async function save(projectRoot: string, kind: Kind, id: string, source: string, revision: string): Promise<Editable> {
  const where = sourceName(kind, id);
  const before = await current(projectRoot, kind, id);
  if (sha256(before) !== revision) throw new EditError(409, `${where} changed since it was read; reload it`);
  const next = parse(kind, source, where);
  if (next.id !== id) throw new EditError(400, `${where}: id ${next.id} does not match the file name`);
  let previousSetup: string | undefined;
  try {
    previousSetup = parse(kind, before, where).setup;
  } catch {
    previousSetup = undefined;
  }
  if (next.setup !== previousSetup)
    throw new EditError(400, `${where}: setup references are read-only here; edit the file locally`);
  await checkReferences(projectRoot, kind, next.parsed);
  const dir = await plainDirectory(projectRoot, kind);
  await writeAtomic(join(dir, `${id}.${extension(kind)}`), source);
  return { id, source, revision: sha256(source), parsed: next.parsed, error: null };
}

/** Creates a new persona or suite file; the ID must be unused and the file may not reference setup code. */
export function createEditable(projectRoot: string, kind: Kind, source: string): Promise<Editable> {
  return exclusive(projectRoot, () => create(projectRoot, kind, source));
}

async function create(projectRoot: string, kind: Kind, source: string): Promise<Editable> {
  const { id, setup, parsed } = parse(kind, source, `new ${kind === 'personas' ? 'persona' : 'suite'}`);
  if (setup !== undefined) throw new EditError(400, `new ${kind} cannot reference setup code; add it locally`);
  await checkReferences(projectRoot, kind, parsed);
  const dir = await plainDirectory(projectRoot, kind);
  const target = join(dir, `${id}.${extension(kind)}`);
  const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(temp, source, { mode: 0o600, flag: 'wx' });
  try {
    await link(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EditError(409, `${sourceName(kind, id)} exists`);
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
  return { id, source, revision: sha256(source), parsed, error: null };
}

export async function appendSuiteEntry(
  projectRoot: string,
  suiteId: string,
  entry: SuiteEntry,
  revision: string,
): Promise<Editable> {
  const before = await current(projectRoot, 'suites', suiteId);
  if (sha256(before) !== revision)
    throw new EditError(409, `${sourceName('suites', suiteId)} changed since it was read; reload it`);
  const document = parseDocument(before);
  document.addIn(['entries'], entry);
  return saveEditable(projectRoot, 'suites', suiteId, String(document), revision);
}

/** Deletes a persona or suite file; a persona that suites still reference is kept. */
export function removeEditable(projectRoot: string, kind: Kind, id: string): Promise<{ id: string }> {
  return exclusive(projectRoot, async () => {
    await current(projectRoot, kind, id);
    if (kind === 'personas') {
      const users: string[] = [];
      for (const suiteId of await listIds(projectRoot, 'suites', '.yml')) {
        const suite = await readEditable(projectRoot, 'suites', suiteId);
        const entries = (suite.parsed as { entries?: SuiteEntry[] } | null)?.entries ?? [];
        if (entries.some((entry) => entry.persona === id)) users.push(suiteId);
      }
      if (users.length > 0) throw new EditError(409, `persona ${id} is used by suite(s) ${users.join(', ')}`);
    }
    await rm(join(await plainDirectory(projectRoot, kind), `${id}.${extension(kind)}`));
    return { id };
  });
}

type Settings = 'config.yml' | 'models.yml';

/** `.cohort/config.yml` or `.cohort/models.yml` as written; `source` is null when the file does not exist. */
export async function readSettings(projectRoot: string, name: Settings) {
  const path = join(projectRoot, '.cohort', name);
  const stat = await lstat(path).catch(() => null);
  if (stat && !stat.isFile()) throw new EditError(400, `.cohort/${name} is not a plain file`);
  const source = stat ? await readFile(path, 'utf8') : null;
  return { path: `.cohort/${name}`, source, revision: source === null ? null : sha256(source) };
}

function checkSettings(name: Settings, source: string): void {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new EditError(400, `.cohort/${name}: larger than 256 KiB`);
  try {
    if (name === 'config.yml') parseProjectConfig(source);
    else validateCatalog(parseYaml(source) as unknown, '.cohort/models.yml');
  } catch (error) {
    if (error instanceof ConfigError) throw new EditError(400, error.problems);
    if (error instanceof CatalogError) throw new EditError(400, error.message.split('\n'));
    throw new EditError(400, `.cohort/${name}: invalid YAML: ${(error as Error).message.split('\n')[0]}`);
  }
}

/** Validates and atomically replaces a settings file; with `revision`, only if the file still has it. */
export function saveSettings(projectRoot: string, name: Settings, source: string, revision?: string) {
  return exclusive(projectRoot, async () => {
    checkSettings(name, source);
    const before = await readSettings(projectRoot, name);
    if (revision !== undefined && before.revision !== revision)
      throw new EditError(409, `${before.path} changed since it was read; reload it`);
    await writeAtomic(join(projectRoot, before.path), source);
    return { path: before.path, revision: sha256(source) };
  });
}
