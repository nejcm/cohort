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
}

export interface RunEvent {
  sequence: number;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

const now = (): string => new Date().toISOString();

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
} as const;

const ACTIVE = "status IN ('queued', 'running')";
const LOOK = "(status = 'finished' AND outcome_state IN ('blocked', 'limit_reached', 'agent_error'))";
export const RUN_FILTERS = { active: ACTIVE, look: LOOK, finished: `NOT ${ACTIVE}` } as const;

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
  | 'finished'
  | 'total'
  | 'lookTotal'
  | 'running'
  | 'queued'
  | 'finishedToday'
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
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version + index + 1, now());
      }),
    );
  }

  get schemaVersion(): number {
    return (this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number })
      .version;
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

  insertBatch(id: string, request: unknown, createdAt = now()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO batches (id, created_at, request_json) VALUES (?, ?, ?)')
      .run(id, createdAt, JSON.stringify(request));
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

  hasRun(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id) !== undefined;
  }

  batch(id: string): { id: string; created_at: string; request_json: string } | null {
    return (
      (this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as
        | { id: string; created_at: string; request_json: string }
        | undefined) ?? null
    );
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
          TOTAL(hit AND NOT ${ACTIVE}) AS finished, COUNT(*) AS total, TOTAL(${LOOK}) AS lookTotal,
          TOTAL(status = 'running') AS running, TOTAL(status = 'queued') AS queued,
          TOTAL(created_at >= ? AND NOT ${ACTIVE}) AS finishedToday, TOTAL(IIF(created_at >= ?, estimated_cost_usd, 0)) AS spentToday
        FROM matched`,
      )
      .get(...(text ? [text] : []), since, since) as unknown as RunCounts;
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
