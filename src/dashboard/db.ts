import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { RunReport } from '../evidence/report.ts';

const MIGRATIONS = [
  `CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    request_json TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    entry_index INTEGER NOT NULL,
    repeat_index INTEGER NOT NULL,
    persona_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
    catalog_version TEXT NOT NULL,
    catalog_hash TEXT NOT NULL,
    catalog_entry_json TEXT NOT NULL,
    model_untested INTEGER NOT NULL CHECK (model_untested IN (0, 1)),
    status TEXT NOT NULL,
    outcome_state TEXT,
    blocked_kind TEXT,
    blocked_detected_by TEXT,
    outcome_code TEXT,
    interrupted_by TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    steps INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    estimated_cost_usd REAL,
    cap_enforcement TEXT NOT NULL CHECK (cap_enforcement IN ('priced_reservations', 'provider_reported_cost', 'step_time_only')),
    artifact_dir TEXT NOT NULL UNIQUE,
    report_path TEXT,
    config_hash TEXT NOT NULL,
    UNIQUE(batch_id, entry_index, repeat_index)
  );
  CREATE INDEX runs_created_at ON runs(created_at DESC, id);
  CREATE INDEX runs_batch ON runs(batch_id, entry_index, repeat_index);
  CREATE TABLE run_events (
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(run_id, sequence)
  );`,
  `ALTER TABLE batches ADD COLUMN owner_pid INTEGER;
  ALTER TABLE batches ADD COLUMN finished_at TEXT;
  ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;`,
  `ALTER TABLE batches ADD COLUMN owner_start TEXT;`,
  `ALTER TABLE runs ADD COLUMN friction_count INTEGER;
  ALTER TABLE runs ADD COLUMN opinion_count INTEGER;`,
];

export type RunStatus = 'queued' | 'running' | 'finished' | 'cancelled' | 'interrupted';

export interface RunRow {
  id: string;
  batch_id: string;
  entry_index: number;
  repeat_index: number;
  persona_id: string;
  goal: string;
  mode: string;
  provider: string;
  model: string;
  effort: string;
  catalog_version: string;
  catalog_hash: string;
  catalog_entry_json: string;
  model_untested: number;
  status: RunStatus;
  outcome_state: string | null;
  blocked_kind: string | null;
  blocked_detected_by: string | null;
  outcome_code: string | null;
  interrupted_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  steps: number;
  duration_ms: number | null;
  estimated_cost_usd: number | null;
  cap_enforcement: string;
  artifact_dir: string;
  report_path: string | null;
  config_hash: string;
  cancel_requested_at?: string | null;
  /** Harness-measured friction claims and agent opinions; null until the report is read. */
  friction_count?: number | null;
  opinion_count?: number | null;
}

export interface BatchRow {
  id: string;
  created_at: string;
  request_json: string;
  /** Process that executes the batch; null for batches indexed from files. */
  owner_pid: number | null;
  owner_start: string | null;
  finished_at: string | null;
}

export interface RunEvent {
  sequence: number;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface Journey {
  personaId: string;
  goal: string;
  lastAt: string;
  /** Every finished run of this journey; the other figures cover only the latest window. */
  total: number;
  models: number;
  completed: number;
  /** The completion denominator: blocked runs and user cancellations are left out, as in the batch report. */
  counted: number;
  blocked: number;
  /** Harness claims; null when no run in the window has been counted yet. */
  friction: number | null;
  latest: { id: string; outcome: string; interruptedBy: string | null }[];
  /** Completion per batch over the latest `window` batches, oldest first; same denominator as `counted`. */
  batches: { id: string; completed: number; counted: number }[];
  /** The latest batch whose completion fell at least 50 points below the batch before it. */
  drop: string | null;
}

const now = (): string => new Date().toISOString();

const DROP_POINTS = 50;
const percent = (batch: { completed: number; counted: number }): number =>
  Math.round((batch.completed / batch.counted) * 100);
function dropOf(batches: Journey['batches']): string | null {
  const counted = batches.filter((batch) => batch.counted > 0);
  return (
    counted.findLast((batch, index) => index > 0 && percent(counted[index - 1]!) - percent(batch) >= DROP_POINTS)?.id ??
    null
  );
}

/** Sort keys never NULL, so `(key, id)` row-value comparisons page correctly. */
export const RUN_SORTS = {
  created: 'created_at',
  id: 'id',
  status: "status || ':' || COALESCE(outcome_state, '')",
  persona: 'persona_id',
  started: "COALESCE(started_at, '')",
  mode: 'mode',
  model: "provider || '/' || model",
  repeat: 'repeat_index',
  duration: 'COALESCE(duration_ms, -1)',
  cost: 'COALESCE(estimated_cost_usd, -1)',
  friction: 'COALESCE(friction_count, -1)',
} as const;

const ACTIVE = "status IN ('queued', 'running')";
// Blocked runs met an external dependency by design, so they are counted apart from runs that went wrong.
const LOOK = "(status = 'finished' AND outcome_state IN ('limit_reached', 'agent_error'))";
const BLOCKED = "(status = 'finished' AND outcome_state = 'blocked')";
const COUNTED =
  "outcome_state != 'blocked' AND NOT (outcome_state = 'agent_error' AND outcome_code = 'interrupted' AND COALESCE(interrupted_by, '') != 'process')";
export const RUN_FILTERS = { active: ACTIVE, look: LOOK, blocked: BLOCKED, finished: `NOT ${ACTIVE}` } as const;

export interface RunQuery {
  sort?: keyof typeof RUN_SORTS;
  asc?: boolean;
  filter?: keyof typeof RUN_FILTERS;
  text?: string;
  after?: [string | number, string];
}

export type RunCounts = Record<
  | 'all'
  | 'active'
  | 'look'
  | 'blocked'
  | 'finished'
  | 'total'
  | 'lookTotal'
  | 'blockedTotal'
  | 'running'
  | 'queued'
  | 'finishedToday'
  | 'frictionToday'
  | 'spentToday',
  number
>;

const TEXT_MATCH =
  "instr(fold(id || ' ' || goal || ' ' || persona_id || ' ' || mode || ' ' || provider || '/' || model), fold(?)) > 0";

function runFilter({ filter, text }: RunQuery): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = filter ? [RUN_FILTERS[filter]] : [];
  const params: SQLInputValue[] = [];
  if (text) {
    where.push(TEXT_MATCH);
    params.push(text);
  }
  return { where, params };
}

/** Columns a finished report fills; unknown costs stay NULL. */
export function reportColumns(report: RunReport): Partial<RunRow> {
  const { outcome, usage } = report;
  return {
    outcome_state: outcome.state,
    blocked_kind: outcome.state === 'blocked' ? outcome.kind : null,
    blocked_detected_by: outcome.state === 'blocked' ? outcome.detectedBy : null,
    outcome_code:
      outcome.state === 'agent_error' ? outcome.code : outcome.state === 'limit_reached' ? outcome.limit : null,
    interrupted_by: outcome.state === 'agent_error' ? (outcome.interruptedBy ?? null) : null,
    steps: report.steps,
    friction_count: report.friction.filter((claim) => claim.source === 'harness').length,
    opinion_count: report.friction.filter((claim) => claim.source === 'agent').length,
    duration_ms: report.durationMs,
    estimated_cost_usd: usage.providerReportedCostUsd ?? usage.estimatedCostUsd,
    cap_enforcement: usage.capEnforcement,
    report_path: 'report.json',
  };
}

export class LabDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    // SQLite's lower() folds ASCII only; toLowerCase() picks final ς by context, so map it back to σ.
    this.db.function('fold', { deterministic: true }, (value) =>
      typeof value === 'string' ? value.toLowerCase().replaceAll('ς', 'σ') : value,
    );
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const { version } = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
      version: number;
    };
    MIGRATIONS.slice(version).forEach((sql, index) =>
      this.transaction(() => {
        // Another process may have migrated since the version was read.
        if (this.schemaVersion >= version + index + 1) return;
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version + index + 1, now());
      }),
    );
  }

  get schemaVersion(): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }
    ).version;
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertBatch(
    id: string,
    request: unknown,
    createdAt = now(),
    owner: { pid: number; start: string | null } | null = null,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO batches (id, created_at, request_json, owner_pid, owner_start) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, createdAt, JSON.stringify(request), owner?.pid ?? null, owner?.start ?? null);
  }

  unfinishedOwnedBatches(): BatchRow[] {
    return this.db
      .prepare('SELECT * FROM batches WHERE finished_at IS NULL AND owner_pid IS NOT NULL')
      .all() as unknown as BatchRow[];
  }

  finishBatch(id: string): void {
    this.db.prepare('UPDATE batches SET finished_at = ? WHERE id = ? AND finished_at IS NULL').run(now(), id);
  }

  /** Marks queued or running runs for their owner to cancel; returns the IDs that were still active. */
  requestCancel(ids: readonly string[]): string[] {
    const mark = this.db.prepare(
      `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ? AND ${ACTIVE}`,
    );
    return ids.filter((id) => mark.run(now(), id).changes > 0);
  }

  cancelRequested(): string[] {
    return (
      this.db.prepare(`SELECT id FROM runs WHERE cancel_requested_at IS NOT NULL AND ${ACTIVE}`).all() as {
        id: string;
      }[]
    ).map((row) => row.id);
  }

  insertRun(row: Omit<RunRow, 'steps'> & { steps?: number }): boolean {
    const columns = Object.keys(row);
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...(Object.values(row) as SQLInputValue[]));
    return result.changes > 0;
  }

  updateRun(id: string, fields: Partial<RunRow>): void {
    const columns = Object.keys(fields);
    if (columns.length === 0) return;
    this.db
      .prepare(`UPDATE runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...(Object.values(fields) as SQLInputValue[]), id);
  }

  run(id: string): RunRow | null {
    return (this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
  }

  batch(id: string): BatchRow | null {
    return (this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined) ?? null;
  }

  batchRuns(batchId: string): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE batch_id = ? ORDER BY entry_index, repeat_index')
      .all(batchId) as unknown as RunRow[];
  }

  /** Keyset-paged runs; `after` is the previous page's last `[sort_key, id]`. */
  listRuns(limit: number, query: RunQuery = {}): (RunRow & { sort_key: string | number })[] {
    const key = RUN_SORTS[query.sort ?? 'created'];
    const order = query.asc ? 'ASC' : 'DESC';
    const { where, params } = runFilter(query);
    if (query.after) {
      where.push(`(${key}, id) ${query.asc ? '>' : '<'} (?, ?)`);
      params.push(...query.after);
    }
    return this.db
      .prepare(
        `SELECT *, ${key} AS sort_key FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_key ${order}, id ${order} LIMIT ?`,
      )
      .all(...params, limit) as unknown as (RunRow & { sort_key: string | number })[];
  }

  /** Tab counts over the runs matching `text`; headline counts over every run, with "today" starting at `since`. */
  runCounts(text: string, since: string): RunCounts {
    return this.db
      .prepare(
        `WITH matched AS (SELECT *, ${text ? TEXT_MATCH : '1'} AS hit FROM runs)
        SELECT TOTAL(hit) AS "all", TOTAL(hit AND ${ACTIVE}) AS active, TOTAL(hit AND ${LOOK}) AS look,
          TOTAL(hit AND ${BLOCKED}) AS blocked, TOTAL(hit AND NOT ${ACTIVE}) AS finished, COUNT(*) AS total,
          TOTAL(${LOOK}) AS lookTotal, TOTAL(${BLOCKED}) AS blockedTotal,
          TOTAL(status = 'running') AS running, TOTAL(status = 'queued') AS queued,
          TOTAL(COALESCE(finished_at, created_at) >= ? AND NOT ${ACTIVE}) AS finishedToday,
          TOTAL(IIF(COALESCE(finished_at, created_at) >= ?, friction_count, 0)) AS frictionToday,
          TOTAL(IIF(COALESCE(finished_at, created_at) >= ?, estimated_cost_usd, 0)) AS spentToday
        FROM matched`,
      )
      .get(...(text ? [text] : []), since, since, since) as unknown as RunCounts;
  }

  /** Finished runs grouped by persona and goal, over each journey's latest `window` runs and batches, worst completion first. */
  journeys(window: number): Journey[] {
    const rows = this.db
      .prepare(
        `WITH recent AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY persona_id, goal ORDER BY created_at DESC, id DESC) AS n
          FROM runs WHERE outcome_state IS NOT NULL),
        batched AS (
          SELECT persona_id, goal, batch_id, MAX(created_at) AS at,
            TOTAL(outcome_state = 'completed') AS completed, TOTAL(${COUNTED}) AS counted
          FROM runs WHERE outcome_state IS NOT NULL GROUP BY persona_id, goal, batch_id),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY persona_id, goal ORDER BY at DESC, batch_id DESC) AS n FROM batched)
        SELECT persona_id AS personaId, goal, MAX(created_at) AS lastAt,
          (SELECT COUNT(*) FROM runs r WHERE r.persona_id = recent.persona_id AND r.goal = recent.goal AND r.outcome_state IS NOT NULL) AS total,
          COUNT(DISTINCT provider || '/' || model) AS models,
          TOTAL(outcome_state = 'completed') AS completed,
          TOTAL(${COUNTED}) AS counted,
          TOTAL(outcome_state = 'blocked') AS blocked,
          SUM(friction_count) AS friction,
          json_group_array(json_array(id, outcome_state, interrupted_by) ORDER BY n DESC) AS latest,
          (SELECT json_group_array(json_array(batch_id, completed, counted) ORDER BY n DESC) FROM ranked b
            WHERE b.persona_id = recent.persona_id AND b.goal = recent.goal AND b.n <= ?) AS batches
        FROM recent WHERE n <= ? GROUP BY persona_id, goal`,
      )
      .all(window, window) as unknown as (Omit<Journey, 'latest' | 'batches' | 'drop'> & {
      latest: string;
      batches: string;
    })[];
    const rate = (journey: Pick<Journey, 'completed' | 'counted'>): number =>
      journey.counted === 0 ? 2 : journey.completed / journey.counted;
    return rows
      .map((row) => {
        const batches = (JSON.parse(row.batches) as [string, number, number][]).map(([id, completed, counted]) => ({
          id,
          completed,
          counted,
        }));
        return {
          ...row,
          latest: (JSON.parse(row.latest) as [string, string, string | null][]).map(([id, outcome, interruptedBy]) => ({
            id,
            outcome,
            interruptedBy,
          })),
          batches,
          drop: dropOf(batches),
        };
      })
      .toSorted((a, b) => rate(a) - rate(b) || b.lastAt.localeCompare(a.lastAt));
  }

  runsWithStatus(...statuses: RunStatus[]): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at, id`)
      .all(...statuses) as unknown as RunRow[];
  }

  appendEvent(runId: string, type: string, payload: Record<string, unknown>): RunEvent {
    return this.transaction(() => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE run_id = ?')
        .get(runId) as { next: number };
      const event = { sequence: next, type, createdAt: now(), payload };
      this.db
        .prepare('INSERT INTO run_events (run_id, sequence, type, created_at, payload_json) VALUES (?, ?, ?, ?, ?)')
        .run(runId, next, type, event.createdAt, JSON.stringify(payload));
      return event;
    });
  }

  eventsAfter(runId: string, sequence: number): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence')
      .all(runId, sequence) as { sequence: number; type: string; created_at: string; payload_json: string }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  close(): void {
    this.db.close();
  }
}
