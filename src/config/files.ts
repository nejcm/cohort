import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { validate, type JsonSchema } from '../core/schema.ts';
import { localeProblems } from './locale.ts';
import { EFFORTS, type Effort } from '../providers/types.ts';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface Limits {
  steps: number;
  timeMs: number;
  dollars: number;
}

export type Mode = 'vision' | 'text';

export interface RouteRule {
  match: string;
  action: 'block' | 'fulfill';
  status?: number;
  contentType?: string;
  body?: string;
}

export interface ProjectConfig {
  schemaVersion: 1;
  model: string;
  effort?: Effort;
  mode?: Mode;
  repeats?: number;
  limits?: Partial<Limits>;
  allowedOrigins?: string[];
  resourceOrigins?: string[];
  screenshots?: { maxWidth?: number; maskSelectors?: string[] };
  routes?: RouteRule[];
}

export interface Persona {
  schemaVersion: 1;
  id: string;
  name: string;
  tags: string[];
  device: { viewport: { width: number; height: number }; touch: boolean };
  /** `keyboard` withholds pointer tools from the agent. */
  input?: 'keyboard';
  locale: string;
  timezone: string;
  goal?: string;
  model?: string;
  effort?: Effort;
  limits?: Partial<Limits>;
  /** Absolute path, resolved from the declaring file and contained in `.cohort/setup/`. */
  setup?: string;
  storageState?: string;
  body: string;
  hash: string;
}

export interface SuiteEntry {
  persona: string;
  goal?: string;
  url?: string;
  note?: string;
  model?: string;
  effort?: Effort;
}

export interface Suite {
  schemaVersion: 1;
  id: string;
  name: string;
  defaults: {
    url?: string;
    setup?: string;
    model?: string;
    effort?: Effort;
    mode?: Mode;
    repeats?: number;
    note?: string;
    limits?: Partial<Limits>;
    allowedOrigins?: string[];
    routes?: RouteRule[];
    storageState?: string;
  };
  entries: SuiteEntry[];
}

const ID = '^[a-z0-9][a-z0-9-]{0,63}$';
const id: JsonSchema = { type: 'string', pattern: ID };
const text: JsonSchema = { type: 'string', minLength: 1, maxLength: 4000 };
export const qualifiedModel: JsonSchema = { type: 'string', pattern: '^[a-z0-9-]+/\\S+$', maxLength: 200 };
export const effortSchema: JsonSchema = { enum: EFFORTS };
export const modeSchema: JsonSchema = { enum: ['vision', 'text'] };
export const repeatsSchema: JsonSchema = { type: 'integer', minimum: 1, maximum: 20 };
const httpUrl: JsonSchema = { type: 'string', pattern: '^https?://', maxLength: 4096 };
const origins: JsonSchema = { type: 'array', items: { type: 'string', pattern: '^https?://[^/?#@]+$' } };
export const limitsSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    steps: { type: 'integer', minimum: 1, maximum: 500 },
    timeMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
    dollars: { type: 'number', minimum: 0, maximum: 1000 },
  },
};
const routes: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['match', 'action'],
    properties: {
      match: { type: 'string', minLength: 1 },
      action: { enum: ['block', 'fulfill'] },
      status: { type: 'integer', minimum: 100, maximum: 599 },
      contentType: { type: 'string' },
      body: { type: 'string' },
    },
  },
};
const nameValue = { name: { type: 'string' }, value: { type: 'string' } } as const;
// Matches Playwright's storageState shape so a bad file fails preflight, not browser creation.
const storageStateSchema: JsonSchema = {
  type: 'object',
  required: ['cookies', 'origins'],
  properties: {
    cookies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'value', 'domain', 'path'],
        properties: {
          ...nameValue,
          domain: { type: 'string', minLength: 1 },
          path: { type: 'string', pattern: '^/' },
          expires: { type: 'number' },
          httpOnly: { type: 'boolean' },
          secure: { type: 'boolean' },
          sameSite: { enum: ['Strict', 'Lax', 'None'] },
          partitionKey: { type: 'string' },
        },
      },
    },
    origins: {
      type: 'array',
      items: {
        type: 'object',
        required: ['origin', 'localStorage'],
        properties: {
          origin: { type: 'string', pattern: '^https?://' },
          localStorage: {
            type: 'array',
            items: { type: 'object', required: ['name', 'value'], properties: nameValue },
          },
          indexedDB: { type: 'array' },
        },
      },
    },
  },
};
const relativePath: JsonSchema = { type: 'string', minLength: 1, maxLength: 1024 };

const projectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'model'],
  properties: {
    schemaVersion: { const: 1 },
    model: qualifiedModel,
    effort: effortSchema,
    mode: modeSchema,
    repeats: repeatsSchema,
    limits: limitsSchema,
    allowedOrigins: origins,
    resourceOrigins: origins,
    screenshots: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxWidth: { type: 'integer', minimum: 320, maximum: 3840 },
        maskSelectors: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    routes,
  },
};

export const personaSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'name', 'tags', 'device', 'locale', 'timezone'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    tags: { type: 'array', items: id, uniqueItems: true },
    device: {
      type: 'object',
      additionalProperties: false,
      required: ['viewport', 'touch'],
      properties: {
        viewport: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height'],
          properties: {
            width: { type: 'integer', minimum: 240, maximum: 3840 },
            height: { type: 'integer', minimum: 240, maximum: 2160 },
          },
        },
        touch: { type: 'boolean' },
      },
    },
    input: { enum: ['keyboard'] },
    locale: { type: 'string', minLength: 2, maxLength: 35 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    goal: text,
    model: qualifiedModel,
    effort: effortSchema,
    limits: limitsSchema,
    setup: relativePath,
    storageState: id,
  },
};

const suiteSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'name', 'entries'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    defaults: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: httpUrl,
        setup: relativePath,
        model: qualifiedModel,
        effort: effortSchema,
        mode: modeSchema,
        repeats: repeatsSchema,
        note: text,
        limits: limitsSchema,
        allowedOrigins: origins,
        routes,
        storageState: id,
      },
    },
    entries: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['persona'],
        properties: { persona: id, goal: text, url: httpUrl, note: text, model: qualifiedModel, effort: effortSchema },
      },
    },
  },
};

const ADHOC_BASE = {
  schemaVersion: 1 as const,
  id: 'adhoc-first-time-user',
  name: 'Ad-hoc first-time user',
  tags: [],
  device: { viewport: { width: 1280, height: 720 }, touch: false },
  locale: 'en-US',
  timezone: 'UTC',
  body: 'You are using this application for the first time. Attempt the supplied goal using only visible information.',
};
export const ADHOC_PERSONA: Persona = { ...ADHOC_BASE, hash: sha256(JSON.stringify(ADHOC_BASE)) };

export function sha256(data: string | Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function checked<T>(schema: JsonSchema, value: unknown, source: string): T {
  const error = validate(schema, value, source);
  if (error) throw new ConfigError(error);
  return value as T;
}

function parseYaml(textValue: string, source: string): unknown {
  try {
    return parse(textValue) as unknown;
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML: ${(error as Error).message.split('\n')[0]}`);
  }
}

// Rejects symlinks on every segment below the project root.
async function containedFile(projectRoot: string, path: string, where: string[]): Promise<void> {
  const base = join(projectRoot, ...where);
  const rel = relative(base, path);
  if (rel === '' || rel.startsWith('..') || resolve(base, rel) !== path)
    throw new ConfigError(`${path} must be inside ${where.join('/')}/`);
  let current = projectRoot;
  for (const part of [...where, ...rel.split(sep)]) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      throw new ConfigError(`missing file: ${relative(projectRoot, current)}`);
    }
    if (stat.isSymbolicLink()) throw new ConfigError(`symlink not allowed: ${relative(projectRoot, current)}`);
  }
  if (!(await realpath(path)).startsWith((await realpath(base)) + sep))
    throw new ConfigError(`${path} escapes ${base}`);
}

async function readContained(projectRoot: string, where: string[], name: string): Promise<string> {
  const path = join(projectRoot, ...where, name);
  await containedFile(projectRoot, path, where);
  return readFile(path, 'utf8');
}

async function setupPath(projectRoot: string, declaringDir: string, value: string, source: string): Promise<string> {
  const path = resolve(declaringDir, value);
  try {
    await containedFile(projectRoot, path, ['.cohort', 'setup']);
  } catch (error) {
    throw new ConfigError(`${source}.setup: ${(error as Error).message}`);
  }
  return path;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const source = '.cohort/config.yml';
  return checked<ProjectConfig>(
    projectSchema,
    parseYaml(await readContained(projectRoot, ['.cohort'], 'config.yml'), source),
    source,
  );
}

/** Parses and validates persona Markdown without touching the file system; `setup` stays as written. */
export function parsePersona(content: string, source: string): Omit<Persona, 'setup'> & { setup?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  if (!match) throw new ConfigError(`${source}: missing YAML frontmatter`);
  // The leading newline makes YAML error line numbers match the file.
  const front = checked<Omit<Persona, 'body' | 'hash'>>(personaSchema, parseYaml(`\n${match[1]!}`, source), source);
  const [localeProblem] = localeProblems(front, source);
  if (localeProblem) throw new ConfigError(localeProblem);
  const body = match[2]!.trim();
  if (!body) throw new ConfigError(`${source}: persona body is empty`);
  return { ...front, body, hash: sha256(content) };
}

async function requireFile(projectRoot: string, path: string, what: string): Promise<void> {
  if (!(await lstat(join(projectRoot, path)).catch(() => null))) throw new ConfigError(`unknown ${what}: no ${path}`);
}

export async function listIds(projectRoot: string, dir: string, extension: string): Promise<string[]> {
  const names = await readdir(join(projectRoot, '.cohort', dir)).catch(() => []);
  return names
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length))
    .toSorted();
}

export async function loadPersona(projectRoot: string, personaId: string): Promise<Persona> {
  if (!new RegExp(ID, 'u').test(personaId)) throw new ConfigError(`invalid persona id: ${personaId}`);
  const source = `.cohort/personas/${personaId}.md`;
  await requireFile(projectRoot, source, `persona ${personaId}`);
  const persona = parsePersona(await readContained(projectRoot, ['.cohort', 'personas'], `${personaId}.md`), source);
  if (persona.id !== personaId) throw new ConfigError(`${source}: id ${persona.id} does not match the file name`);
  if (persona.setup)
    persona.setup = await setupPath(projectRoot, join(projectRoot, '.cohort', 'personas'), persona.setup, source);
  return persona;
}

export async function loadPersonasByTag(projectRoot: string, tag: string): Promise<Persona[]> {
  const ids = await listIds(projectRoot, 'personas', '.md');
  const personas = await Promise.all(ids.map((personaId) => loadPersona(projectRoot, personaId)));
  const matching = personas.filter((persona) => persona.tags.includes(tag));
  if (matching.length === 0) {
    const known = [...new Set(personas.flatMap((persona) => persona.tags))].toSorted();
    throw new ConfigError(`no persona has tag ${tag}; known tags: ${known.join(', ') || 'none'}`);
  }
  return matching;
}

const message = (error: unknown): string => (error instanceof ConfigError ? error.message : String(error));

/** Loads every persona and suite, collecting each problem instead of stopping at the first. */
export async function checkProject(
  projectRoot: string,
): Promise<{ personas: number; suites: number; problems: string[] }> {
  const problems: string[] = [];
  const personaIds = await listIds(projectRoot, 'personas', '.md');
  const valid = new Set<string>();
  for (const personaId of personaIds)
    await loadPersona(projectRoot, personaId).then(
      () => valid.add(personaId),
      (error: unknown) => problems.push(message(error)),
    );
  const suiteIds = await listIds(projectRoot, 'suites', '.yml');
  for (const suiteId of suiteIds)
    await loadSuite(projectRoot, suiteId).then(
      (suite) =>
        suite.entries.forEach((entry, index) => {
          if (!personaIds.includes(entry.persona))
            problems.push(`.cohort/suites/${suiteId}.yml entries[${index}]: unknown persona ${entry.persona}`);
        }),
      (error: unknown) => problems.push(message(error)),
    );
  return { personas: valid.size, suites: suiteIds.length, problems };
}

/** Parses and validates suite YAML without touching the file system; `defaults.setup` stays as written. */
export function parseSuite(content: string, source: string): Suite {
  const suite = checked<Suite>(suiteSchema, parseYaml(content, source), source);
  suite.defaults ??= {};
  return suite;
}

/** Raw text of `.cohort/<kind>/<id>.<ext>`, or null when absent; bad IDs, symlinks, and escapes are rejected. */
export async function readDeclared(
  projectRoot: string,
  kind: 'personas' | 'suites',
  fileId: string,
): Promise<string | null> {
  if (!new RegExp(ID, 'u').test(fileId)) throw new ConfigError(`invalid ${kind.slice(0, -1)} id: ${fileId}`);
  const name = `${fileId}.${kind === 'personas' ? 'md' : 'yml'}`;
  if (!(await lstat(join(projectRoot, '.cohort', kind, name)).catch(() => null))) return null;
  return readContained(projectRoot, ['.cohort', kind], name);
}

export async function loadSuite(projectRoot: string, suiteId: string): Promise<Suite> {
  if (!new RegExp(ID, 'u').test(suiteId)) throw new ConfigError(`invalid suite id: ${suiteId}`);
  const source = `.cohort/suites/${suiteId}.yml`;
  await requireFile(projectRoot, source, `suite ${suiteId}`);
  const suite = parseSuite(await readContained(projectRoot, ['.cohort', 'suites'], `${suiteId}.yml`), source);
  if (suite.id !== suiteId) throw new ConfigError(`${source}: id ${suite.id} does not match the file name`);
  if (suite.defaults.setup)
    suite.defaults.setup = await setupPath(
      projectRoot,
      join(projectRoot, '.cohort', 'suites'),
      suite.defaults.setup,
      source,
    );
  return suite;
}

export async function loadStorageState(projectRoot: string, name: string): Promise<Record<string, unknown>> {
  if (!new RegExp(ID, 'u').test(name)) throw new ConfigError(`invalid storage state name: ${name}`);
  const content = await readContained(projectRoot, ['.cohort', 'auth'], `${name}.json`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ConfigError(`storage state ${name}: invalid JSON`);
  }
  return checked<Record<string, unknown>>(storageStateSchema, value, `storage state ${name}`);
}

/** Writes `.cohort/auth/<name>.json` owner-only and atomically; refuses symlinked directories. */
export async function saveStorageState(projectRoot: string, name: string, state: unknown): Promise<string> {
  if (!new RegExp(ID, 'u').test(name)) throw new ConfigError(`invalid storage state name: ${name}`);
  checked(storageStateSchema, state, `storage state ${name}`);
  const dir = join(projectRoot, '.cohort', 'auth');
  // Checked level by level so a symlinked .cohort never gets an auth directory created through it.
  for (const path of [join(projectRoot, '.cohort'), dir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink())
      throw new ConfigError(`symlink not allowed: ${relative(projectRoot, path)}`);
  }
  const path = join(dir, `${name}.json`);
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return path;
}
