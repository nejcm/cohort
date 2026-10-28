import { link, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  ConfigError,
  listIds,
  parsePersona,
  parseSuite,
  readDeclared,
  sha256,
  type SuiteEntry,
} from '../config/files.ts';
import { writeAtomic } from '../evidence/manifest.ts';

type Kind = 'personas' | 'suites';

export class EditError extends Error {
  override name = 'EditError';
  readonly status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_SOURCE_BYTES = 256 * 1024;
const extension = (kind: Kind): string => (kind === 'personas' ? 'md' : 'yml');
const sourceName = (kind: Kind, id: string): string => `.lab/${kind}/${id}.${extension(kind)}`;

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
    if (error instanceof ConfigError) throw new EditError(400, error.message);
    throw error;
  }
}

async function plainDirectory(projectRoot: string, kind: Kind): Promise<string> {
  const dir = join(projectRoot, '.lab', kind);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const path of [join(projectRoot, '.lab'), dir])
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
  const entries = (parsed as { entries: SuiteEntry[] }).entries;
  const missing = entries.findIndex((entry) => !known.includes(entry.persona));
  if (missing >= 0) throw new EditError(400, `entries[${missing}]: unknown persona ${entries[missing]!.persona}`);
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

/** Saves only when the file still has `revision`; setup references can change only through a local file edit. */
export async function saveEditable(
  projectRoot: string,
  kind: Kind,
  id: string,
  source: string,
  revision: string,
): Promise<Editable> {
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
  // shortcut: the revision is rechecked just before the rename, not under a lock; add a lock file if editors race in practice.
  if (sha256(await current(projectRoot, kind, id)) !== revision)
    throw new EditError(409, `${where} changed since it was read; reload it`);
  await writeAtomic(join(dir, `${id}.${extension(kind)}`), source);
  return { id, source, revision: sha256(source), parsed: next.parsed, error: null };
}

/** Creates a new persona file; the ID must be unused and the file may not reference setup code. */
export async function createPersona(projectRoot: string, source: string): Promise<Editable> {
  const { id, setup, parsed } = parse('personas', source, 'new persona');
  if (setup !== undefined) throw new EditError(400, 'new personas cannot reference setup code; add it locally');
  const dir = await plainDirectory(projectRoot, 'personas');
  const target = join(dir, `${id}.md`);
  const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(temp, source, { mode: 0o600, flag: 'wx' });
  try {
    await link(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new EditError(409, `${sourceName('personas', id)} exists`);
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
