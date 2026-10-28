import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import shipped from './catalog.json' with { type: 'json' };
import { EFFORTS, type Effort } from './types.ts';

const PROVIDERS = ['openai', 'anthropic'] as const;

export interface Prices {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  label: string;
  visionCapable: boolean | null;
  supportedEffortLevels: Effort[];
  defaultEffort: Effort | null;
  pricesPerMTok: Prices;
  pricingVerifiedAt: string | null;
  contextLimitTokens?: number;
  untested: boolean;
}

export interface ModelCatalog {
  version: string;
  models: ModelCatalogEntry[];
}

interface CatalogSnapshot {
  version: string;
  hash: string;
  entry: ModelCatalogEntry;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  effort: Effort;
  catalog: CatalogSnapshot;
}

export class CatalogError extends Error {
  override name = 'CatalogError';
}

const ENTRY_KEYS = new Set([
  'id',
  'provider',
  'label',
  'visionCapable',
  'supportedEffortLevels',
  'defaultEffort',
  'pricesPerMTok',
  'pricingVerifiedAt',
  'contextLimitTokens',
  'untested',
]);
const REQUIRED_ENTRY_KEYS = [...ENTRY_KEYS].filter((key) => key !== 'contextLimitTokens');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryIssues(entry: unknown, where: string): string[] {
  if (!isRecord(entry)) return [`${where}: must be an object`];
  const issues: string[] = [];
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) issues.push(`${where}.${key}: unknown field`);
  for (const key of REQUIRED_ENTRY_KEYS) if (!(key in entry)) issues.push(`${where}.${key}: required`);
  if (issues.length > 0) return issues;

  const { id, provider, label, visionCapable, supportedEffortLevels: efforts, defaultEffort, untested } = entry;
  if (typeof id !== 'string' || !/^\S+$/u.test(id))
    issues.push(`${where}.id: must be a nonempty string without spaces`);
  if (!(PROVIDERS as readonly unknown[]).includes(provider)) issues.push(`${where}.provider: unknown provider`);
  if (typeof label !== 'string' || label.length === 0) issues.push(`${where}.label: required`);
  if (typeof untested !== 'boolean') issues.push(`${where}.untested: must be a boolean`);
  if (visionCapable !== null && typeof visionCapable !== 'boolean')
    issues.push(`${where}.visionCapable: must be a boolean or null`);
  if (
    !Array.isArray(efforts) ||
    efforts.some((effort) => !(EFFORTS as readonly unknown[]).includes(effort)) ||
    new Set(efforts).size !== efforts.length
  )
    issues.push(`${where}.supportedEffortLevels: must list unique efforts from ${EFFORTS.join(', ')}`);
  else if (defaultEffort !== null && !efforts.includes(defaultEffort))
    issues.push(`${where}.defaultEffort: must be one of supportedEffortLevels`);
  if (
    untested === false &&
    (typeof visionCapable !== 'boolean' || !Array.isArray(efforts) || efforts.length === 0 || defaultEffort === null)
  )
    issues.push(`${where}: tested entries need visionCapable, supported efforts, and a default effort`);

  const prices = entry.pricesPerMTok;
  if (!isRecord(prices) || Object.keys(prices).toSorted().join() !== 'cachedInput,input,output')
    issues.push(`${where}.pricesPerMTok: must have exactly input, output, cachedInput`);
  else {
    for (const [name, price] of Object.entries(prices))
      if (price !== null && !(typeof price === 'number' && Number.isFinite(price) && price >= 0))
        issues.push(`${where}.pricesPerMTok.${name}: must be a nonnegative number or null`);
    const dated = entry.pricingVerifiedAt;
    if (dated !== null && !(typeof dated === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(dated)))
      issues.push(`${where}.pricingVerifiedAt: must be YYYY-MM-DD or null`);
    if (Object.values(prices).some((price) => price !== null) && dated === null)
      issues.push(`${where}.pricingVerifiedAt: known prices need a verification date`);
  }
  const limit = entry.contextLimitTokens;
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) > 0))
    issues.push(`${where}.contextLimitTokens: must be a positive integer`);
  return issues;
}

export function validateCatalog(value: unknown, source: string): ModelCatalog {
  const issues: string[] = [];
  if (!isRecord(value)) throw new CatalogError(`${source}: catalog must be an object`);
  for (const key of Object.keys(value))
    if (key !== 'version' && key !== 'models') issues.push(`${source}.${key}: unknown field`);
  if (typeof value.version !== 'string' || value.version.length === 0) issues.push(`${source}.version: required`);
  if (!Array.isArray(value.models)) issues.push(`${source}.models: must be a list`);
  else {
    const seen = new Set<string>();
    value.models.forEach((entry: unknown, index) => {
      issues.push(...entryIssues(entry, `${source}.models[${index}]`));
      if (isRecord(entry)) {
        const key = `${String(entry.provider)}/${String(entry.id)}`;
        if (seen.has(key)) issues.push(`${source}.models[${index}]: duplicate ${key}`);
        seen.add(key);
      }
    });
  }
  if (issues.length > 0) throw new CatalogError(issues.join('\n'));
  return value as unknown as ModelCatalog;
}

const entryKey = (entry: ModelCatalogEntry): string => `${entry.provider}/${entry.id}`;

function mergeCatalogs(base: ModelCatalog, override?: ModelCatalog): ModelCatalog {
  if (!override) return base;
  const replaced = new Map(override.models.map((entry) => [entryKey(entry), entry]));
  const models = base.models.map((entry) => replaced.get(entryKey(entry)) ?? entry);
  const baseKeys = new Set(base.models.map(entryKey));
  models.push(...override.models.filter((entry) => !baseKeys.has(entryKey(entry))));
  return { version: `${base.version}+${override.version}`, models };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function loadCatalog(projectRoot: string): Promise<ModelCatalog> {
  const base = validateCatalog(shipped, 'catalog.json');
  let text: string;
  try {
    text = await readFile(join(projectRoot, '.lab', 'models.yml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base;
    throw error;
  }
  return mergeCatalogs(base, validateCatalog(parse(text) as unknown, '.lab/models.yml'));
}

export function resolveModel(
  catalog: ModelCatalog,
  qualified: string,
  options: { effort?: Effort; mode: 'vision' | 'text'; allowUntested?: boolean },
): ResolvedModel {
  const slash = qualified.indexOf('/');
  if (slash <= 0) throw new CatalogError(`model must be <provider>/<id>: ${qualified}`);
  const provider = qualified.slice(0, slash);
  const model = qualified.slice(slash + 1);
  const entry = catalog.models.find((candidate) => candidate.provider === provider && candidate.id === model);
  if (!entry) throw new CatalogError(`model not in catalog: ${qualified}`);
  if (entry.visionCapable === null || entry.supportedEffortLevels.length === 0)
    throw new CatalogError(`model is disabled until its capabilities are confirmed: ${qualified}`);
  if (entry.untested && !options.allowUntested)
    throw new CatalogError(`model is untested; confirm explicitly to use it: ${qualified}`);
  if (options.mode === 'vision' && entry.visionCapable !== true)
    throw new CatalogError(`model is not vision-capable: ${qualified}`);
  const effort = options.effort ?? entry.defaultEffort;
  if (effort === null) throw new CatalogError(`no effort given and no default for ${qualified}`);
  if (!entry.supportedEffortLevels.includes(effort))
    throw new CatalogError(`effort ${effort} is not supported by ${qualified}`);
  const hash = `sha256:${createHash('sha256').update(canonical(catalog)).digest('hex')}`;
  const snapshot = structuredClone(entry);
  Object.freeze(snapshot.pricesPerMTok);
  Object.freeze(snapshot.supportedEffortLevels);
  return { provider, model, effort, catalog: { version: catalog.version, hash, entry: Object.freeze(snapshot) } };
}
