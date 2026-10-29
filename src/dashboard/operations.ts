import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, listIds, loadProjectConfig, type ProjectConfig } from '../config/files.ts';
import { resolveSubmission, type ResolvedEntry, type RunSubmission } from '../config/resolve.ts';
import { preflight } from '../core/estimate.ts';
import { bundleDir, readBundleFile } from '../evidence/bundle.ts';
import type { RunManifest } from '../evidence/manifest.ts';
import { catalogHash, loadCatalog, type ModelCatalog } from '../providers/catalog.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { RUN_FILTERS, RUN_SORTS, type BatchRow, type LabDb, type RunQuery, type RunRow } from './db.ts';
import { readEditable } from './files.ts';

type Providers = Readonly<Record<string, ProviderAdapter>>;

const MAX_PAGE = 100;
export const SHOT = /^shot-[0-9]{4}$/u;
const ACTIVE = new Set(['queued', 'running']);

export const isActive = (row: RunRow): boolean => ACTIVE.has(row.status);

function publicRun(row: RunRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    entryIndex: row.entry_index,
    repeat: row.repeat_index,
    personaId: row.persona_id,
    goal: row.goal,
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    catalog: {
      version: row.catalog_version,
      hash: row.catalog_hash,
      entry: JSON.parse(row.catalog_entry_json) as unknown,
    },
    untested: row.model_untested === 1,
    status: row.status,
    outcome: row.outcome_state,
    blockedKind: row.blocked_kind,
    outcomeCode: row.outcome_code,
    interruptedBy: row.interrupted_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    steps: row.steps,
    durationMs: row.duration_ms,
    costUsd: row.estimated_cost_usd,
    friction: row.friction_count ?? null,
    opinions: row.opinion_count ?? null,
    capEnforcement: row.cap_enforcement,
  };
}

export async function runDirOf(projectRoot: string, id: string): Promise<string | null> {
  return bundleDir(projectRoot, id).then(
    ({ dir }) => dir,
    () => null,
  );
}

async function screenshotIds(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, 'screenshots')).catch(() => []);
  return names
    .map((name) => name.replace(/\.png$/u, ''))
    .filter((name) => SHOT.test(name))
    .toSorted();
}

/** One run as the run page shows it: index row, finalized report, manifest artifacts, and screenshot IDs. */
export async function runDetail(projectRoot: string, row: RunRow) {
  const dir = await runDirOf(projectRoot, row.id);
  const report = dir ? await readBundleFile(dir, 'report.json') : null;
  const manifest = dir ? await readBundleFile(dir, 'manifest.json') : null;
  return {
    run: publicRun(row),
    report: report ? (JSON.parse(report) as unknown) : null,
    artifacts: manifest
      ? (JSON.parse(manifest) as RunManifest).artifacts.map(({ path, mediaType, bytes, sensitivity }) => ({
          id: path,
          mediaType,
          bytes,
          sensitivity,
        }))
      : [],
    screenshots: dir ? await screenshotIds(dir) : [],
  };
}

export async function batchDetail(projectRoot: string, db: LabDb, batch: BatchRow) {
  const dir = await runDirOf(projectRoot, batch.id);
  const summary = dir ? await readBundleFile(dir, 'report.json') : null;
  return {
    batch: { id: batch.id, createdAt: batch.created_at, request: JSON.parse(batch.request_json) as unknown },
    runs: db.batchRuns(batch.id).map(publicRun),
    summary: summary ? (JSON.parse(summary) as unknown) : null,
  };
}

export interface RunPageQuery {
  limit?: number;
  sort?: string;
  asc?: boolean;
  filter?: string;
  text?: string;
  cursor?: string;
  /** Start of "today" for the headline counts, an ISO date. */
  since?: string;
}

/** Keyset-paged runs with tab counts; invalid sort, filter, or cursor values are a ConfigError. */
export function listRunsPage(db: LabDb, params: RunPageQuery) {
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(params.limit ?? 50) || 50));
  const sort = params.sort ?? 'created';
  const filter = params.filter || undefined;
  if (!Object.hasOwn(RUN_SORTS, sort))
    throw new ConfigError(`invalid sort; one of ${Object.keys(RUN_SORTS).join(', ')}`);
  const since = params.since === undefined ? undefined : Date.parse(params.since);
  if (since !== undefined && Number.isNaN(since)) throw new ConfigError('invalid since; use an ISO date or time');
  if (filter && !Object.hasOwn(RUN_FILTERS, filter))
    throw new ConfigError(`invalid filter; one of ${Object.keys(RUN_FILTERS).join(', ')}`);
  const query: RunQuery = {
    sort: sort as RunQuery['sort'],
    asc: params.asc === true,
    filter: filter as RunQuery['filter'],
    text: params.text?.trim(),
  };
  if (params.cursor) {
    let after: unknown;
    try {
      after = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
    } catch {}
    if (
      !Array.isArray(after) ||
      after.length !== 2 ||
      !['string', 'number'].includes(typeof after[0]) ||
      typeof after[1] !== 'string'
    )
      throw new ConfigError('invalid cursor');
    query.after = after as [string | number, string];
  }
  const rows = db.listRuns(limit, query);
  const last = rows.at(-1);
  return {
    runs: rows.map(publicRun),
    nextCursor:
      rows.length === limit && last
        ? Buffer.from(JSON.stringify([last.sort_key, last.id])).toString('base64url')
        : null,
    counts: db.runCounts(query.text ?? '', new Date(since ?? new Date().setUTCHours(0, 0, 0, 0)).toISOString()),
  };
}

export async function personaSummaries(projectRoot: string) {
  const ids = await listIds(projectRoot, 'personas', '.md');
  const personas = await Promise.all(ids.map((id) => readEditable(projectRoot, 'personas', id)));
  return personas.map(({ id, parsed, error }) => {
    const persona = parsed as { name?: string; tags?: string[]; goal?: string; setup?: string } | null;
    return {
      id,
      name: persona?.name ?? null,
      tags: persona?.tags ?? [],
      goal: persona?.goal ?? null,
      setup: persona?.setup ?? null,
      error,
    };
  });
}

export async function suiteSummaries(projectRoot: string) {
  const ids = await listIds(projectRoot, 'suites', '.yml');
  const suites = await Promise.all(ids.map((id) => readEditable(projectRoot, 'suites', id)));
  return suites.map(({ id, parsed, error }) => {
    const suite = parsed as { name?: string; entries?: unknown[] } | null;
    return { id, name: suite?.name ?? null, entries: suite?.entries?.length ?? 0, error };
  });
}

const available = (providers: Providers, id: string): boolean => providers[id]?.available() === true;

export function configView(project: ProjectConfig, providers: Providers) {
  return {
    defaults: {
      model: project.model,
      effort: project.effort ?? null,
      mode: project.mode ?? 'vision',
      repeats: project.repeats ?? 3,
      limits: project.limits ?? {},
      allowedOrigins: project.allowedOrigins ?? [],
    },
    providers: Object.fromEntries(Object.keys(providers).map((id) => [id, available(providers, id)])),
  };
}

/** Catalog models whose provider has a key; `enabled` is false for entries not verified for vision runs. */
export function modelList(catalog: ModelCatalog, providers: Providers) {
  return {
    catalog: { version: catalog.version, hash: catalogHash(catalog) },
    providers: Object.keys(providers).map((id) => ({ id, available: available(providers, id) })),
    models: catalog.models
      .filter((entry) => available(providers, entry.provider))
      .map((entry) => ({
        id: `${entry.provider}/${entry.id}`,
        provider: entry.provider,
        label: entry.label,
        visionCapable: entry.visionCapable,
        supportedEffortLevels: entry.supportedEffortLevels,
        defaultEffort: entry.defaultEffort,
        pricesPerMTok: entry.pricesPerMTok,
        pricingVerifiedAt: entry.pricingVerifiedAt,
        untested: entry.untested,
        enabled: entry.visionCapable !== null && entry.supportedEffortLevels.length > 0,
      })),
  };
}

/** Resolves a submission and prices it without calling a model: the dashboard preview and `cohort estimate`. */
export async function estimate(
  projectRoot: string,
  providers: Providers,
  submission: RunSubmission,
  allowUntested: boolean,
): Promise<{ entries: ResolvedEntry[]; plan: ReturnType<typeof preflight> }> {
  const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
  const entries = await resolveSubmission(submission, { projectRoot, project, catalog, providers, allowUntested });
  return { entries, plan: preflight(entries) };
}
