import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { validate, type JsonSchema } from '../core/schema.ts';
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

interface RouteRule {
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
  locale: string;
  timezone: string;
  goal?: string;
  model?: string;
  effort?: Effort;
  limits?: Partial<Limits>;
  /** Absolute path, resolved from the declaring file and contained in `.lab/setup/`. */
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

const personaSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'name', 'tags', 'device', 'locale', 'timezone'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    tags: { type: 'array', items: id },
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

function checkLocaleAndZone(persona: { locale: string; timezone: string }, source: string): void {
  try {
    Intl.getCanonicalLocales(persona.locale);
  } catch {
    throw new ConfigError(`${source}.locale: unsupported locale ${persona.locale}`);
  }
  try {
    Intl.DateTimeFormat('en', { timeZone: persona.timezone });
  } catch {
    throw new ConfigError(`${source}.timezone: unsupported time zone ${persona.timezone}`);
  }
}

async function setupPath(projectRoot: string, declaringDir: string, value: string, source: string): Promise<string> {
  const path = resolve(declaringDir, value);
  try {
    await containedFile(projectRoot, path, ['.lab', 'setup']);
  } catch (error) {
    throw new ConfigError(`${source}.setup: ${(error as Error).message}`);
  }
  return path;
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const source = '.lab/config.yml';
  return checked<ProjectConfig>(
    projectSchema,
    parseYaml(await readContained(projectRoot, ['.lab'], 'config.yml'), source),
    source,
  );
}

function parsePersona(content: string, source: string): Omit<Persona, 'setup'> & { setup?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  if (!match) throw new ConfigError(`${source}: missing YAML frontmatter`);
  const front = checked<Omit<Persona, 'body' | 'hash'>>(personaSchema, parseYaml(match[1]!, source), source);
  checkLocaleAndZone(front, source);
  const body = match[2]!.trim();
  if (!body) throw new ConfigError(`${source}: persona body is empty`);
  return { ...front, body, hash: sha256(content) };
}

export async function loadPersona(projectRoot: string, personaId: string): Promise<Persona> {
  if (!new RegExp(ID, 'u').test(personaId)) throw new ConfigError(`invalid persona id: ${personaId}`);
  const source = `.lab/personas/${personaId}.md`;
  const persona = parsePersona(await readContained(projectRoot, ['.lab', 'personas'], `${personaId}.md`), source);
  if (persona.id !== personaId) throw new ConfigError(`${source}: id ${persona.id} does not match the file name`);
  if (persona.setup)
    persona.setup = await setupPath(projectRoot, join(projectRoot, '.lab', 'personas'), persona.setup, source);
  return persona;
}

export async function loadPersonasByTag(projectRoot: string, tag: string): Promise<Persona[]> {
  let names: string[];
  try {
    names = await readdir(join(projectRoot, '.lab', 'personas'));
  } catch {
    names = [];
  }
  const ids = names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .toSorted();
  const personas = await Promise.all(ids.map((personaId) => loadPersona(projectRoot, personaId)));
  const matching = personas.filter((persona) => persona.tags.includes(tag));
  if (matching.length === 0) throw new ConfigError(`no persona has tag ${tag}`);
  return matching;
}

export async function loadSuite(projectRoot: string, suiteId: string): Promise<Suite> {
  if (!new RegExp(ID, 'u').test(suiteId)) throw new ConfigError(`invalid suite id: ${suiteId}`);
  const source = `.lab/suites/${suiteId}.yml`;
  const suite = checked<Suite>(
    suiteSchema,
    parseYaml(await readContained(projectRoot, ['.lab', 'suites'], `${suiteId}.yml`), source),
    source,
  );
  if (suite.id !== suiteId) throw new ConfigError(`${source}: id ${suite.id} does not match the file name`);
  suite.defaults ??= {};
  if (suite.defaults.setup)
    suite.defaults.setup = await setupPath(
      projectRoot,
      join(projectRoot, '.lab', 'suites'),
      suite.defaults.setup,
      source,
    );
  return suite;
}

export async function loadStorageState(projectRoot: string, name: string): Promise<Record<string, unknown>> {
  if (!new RegExp(ID, 'u').test(name)) throw new ConfigError(`invalid storage state name: ${name}`);
  const content = await readContained(projectRoot, ['.lab', 'auth'], `${name}.json`);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ConfigError(`storage state ${name}: invalid JSON`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { cookies?: unknown }).cookies) ||
    !Array.isArray((value as { origins?: unknown }).origins)
  )
    throw new ConfigError(`storage state ${name}: must have cookies and origins lists`);
  return value as Record<string, unknown>;
}
