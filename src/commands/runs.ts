import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LabDb } from '../dashboard/db.ts';
import { batchDetail, isActive, listRunsPage, runDetail, runDirOf } from '../dashboard/operations.ts';
import { openIndex, recoverInterrupted } from '../dashboard/runner.ts';
import { CliError, emit, type Context } from './context.ts';

const WAIT_POLL_MS = 250;
const DEFAULT_WAIT_MS = 300_000;

interface Found {
  detail: Record<string, unknown>;
  done: boolean;
  completed: boolean;
}

async function describe(root: string, db: LabDb, id: string): Promise<Found> {
  const row = db.run(id);
  if (row)
    return {
      detail: { ...(await runDetail(root, row)), dir: await runDirOf(root, id), done: !isActive(row) },
      done: !isActive(row),
      completed: row.outcome_state === 'completed',
    };
  const batch = db.batch(id);
  if (!batch) throw new CliError('not_found', `unknown run or batch: ${id}`);
  const rows = db.batchRuns(id);
  // An owned batch is done once its report is written; recovery writes it when the owner died first.
  const done = !rows.some(isActive) && (batch.finished_at !== null || batch.owner_pid === null);
  return {
    detail: { ...(await batchDetail(root, db, batch)), dir: await runDirOf(root, id), done },
    done,
    completed: rows.length > 0 && rows.every((item) => item.outcome_state === 'completed'),
  };
}

function printFound(ctx: Context, found: Found): void {
  if (ctx.json) return emit(ctx.write, found.detail);
  const { run, runs, batch } = found.detail as {
    run?: ReturnType<typeof listRunsPage>['runs'][number];
    runs?: ReturnType<typeof listRunsPage>['runs'];
    batch?: { id: string };
  };
  for (const item of run ? [run] : (runs ?? []))
    ctx.write(`${item.id}\t${item.status}${item.outcome ? `\t${item.outcome}` : ''}\t${item.personaId}\n`);
  if (batch) ctx.write(`batch ${batch.id}: ${found.done ? 'done' : 'running'}\n`);
}

/** `cohort runs list|show|wait|cancel` over the same index the dashboard uses. */
export async function runsCommand(verb: string | undefined, id: string | undefined, ctx: Context): Promise<number> {
  const { root, values } = ctx;
  if (!['list', 'show', 'wait', 'cancel'].includes(verb ?? '') || (verb === 'list') !== (id === undefined))
    throw new CliError('usage', 'usage: cohort runs list | runs show|wait|cancel <run-or-batch-id>');
  if (!(await lstat(join(root, '.cohort')).catch(() => null))?.isDirectory())
    throw new CliError('not_found', 'no .cohort directory here; run cohort init');
  const db = await openIndex(root);
  try {
    if (verb === 'list') {
      const page = listRunsPage(db, {
        limit: values.limit === undefined ? undefined : Number(values.limit),
        sort: values.sort as string | undefined,
        asc: values.asc === true,
        text: values.search as string | undefined,
        since: values.since as string | undefined,
        filter: values.filter as string | undefined,
        cursor: values.cursor as string | undefined,
      });
      if (ctx.json) emit(ctx.write, page);
      else
        for (const run of page.runs)
          ctx.write(
            `${run.id}\t${run.status}${run.outcome ? `\t${run.outcome}` : ''}\t${run.personaId}\t${run.batchId}\n`,
          );
      return 0;
    }
    if (verb === 'show') {
      await recoverInterrupted(root, db);
      printFound(ctx, await describe(root, db, id!));
      return 0;
    }
    if (verb === 'cancel') {
      const ids = db.run(id!) ? [id!] : db.batch(id!) ? db.batchRuns(id!).map((row) => row.id) : null;
      if (!ids) throw new CliError('not_found', `unknown run or batch: ${id}`);
      const cancelling = db.requestCancel(ids);
      if (cancelling.length === 0) throw new CliError('conflict', `${id} has no queued or running run`);
      if (ctx.json) emit(ctx.write, { id, cancelling });
      else ctx.write(`cancelling ${cancelling.length} run(s); cohort runs wait ${id}\n`);
      return 0;
    }
    const timeoutMs = values['timeout-ms'] === undefined ? DEFAULT_WAIT_MS : Number(values['timeout-ms']);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0)
      throw new CliError('usage', '--timeout-ms must be an integer >= 0');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await recoverInterrupted(root, db);
      const found = await describe(root, db, id!);
      if (found.done) {
        printFound(ctx, found);
        return found.completed ? 0 : 1;
      }
      if (Date.now() >= deadline)
        throw new CliError('timeout', `${id} is still running after ${timeoutMs} ms; wait again`);
      await delay(WAIT_POLL_MS, undefined, ctx.signal ? { signal: ctx.signal } : {}).catch(() => {
        throw new CliError('timeout', `waiting for ${id} was interrupted`);
      });
    }
  } finally {
    db.close();
  }
}
