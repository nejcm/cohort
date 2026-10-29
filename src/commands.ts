import { lstat, readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadProjectConfig, parsePersona, parseSuite, personaSchema, type SuiteEntry } from './config/files.ts';
import { personaTemplates } from './config/init.ts';
import type { LabDb } from './dashboard/db.ts';
import {
  appendSuiteEntry,
  createEditable,
  EditError,
  readEditable,
  readSettings,
  removeEditable,
  saveEditable,
  saveSettings,
  type Editable,
} from './dashboard/files.ts';
import {
  batchDetail,
  configView,
  isActive,
  listRunsPage,
  modelList,
  personaSummaries,
  runDetail,
  runDirOf,
  suiteSummaries,
} from './dashboard/operations.ts';
import { openIndex, recoverInterrupted } from './dashboard/runner.ts';
import { loadCatalog } from './providers/catalog.ts';
import type { ProviderAdapter } from './providers/types.ts';

// Version of every `--json` document the CLI prints; bump on a breaking change (docs/agents.md).
const JSON_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 1024 * 1024;
const WAIT_POLL_MS = 250;
const DEFAULT_WAIT_MS = 300_000;

export type Write = (text: string) => void;
export type Values = Record<string, string | string[] | boolean | undefined>;
export type Input = AsyncIterable<Buffer | string> & { isTTY?: boolean };

/** A refusal with a stable `code` for `--json` callers; `detail` fields are added to the JSON error. */
export class CliError extends Error {
  override name = 'CliError';
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const emit = (write: Write, value: object): void =>
  write(`${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...value })}\n`);

export interface Context {
  root: string;
  values: Values;
  write: Write;
  json: boolean;
  providers: Record<string, ProviderAdapter>;
  stdin: Input;
  signal?: AbortSignal;
}

const KINDS = { persona: 'personas', suite: 'suites' } as const;
const sourcePath = (kind: 'personas' | 'suites', id: string): string =>
  `.cohort/${kind}/${id}.${kind === 'personas' ? 'md' : 'yml'}`;

function need(value: string | undefined, usage: string): string {
  if (value === undefined) throw new CliError('usage', `usage: cohort ${usage}`);
  return value;
}

/** `--file <path>`, or `--file -` for stdin; a terminal on stdin is refused instead of waiting for input. */
export async function readInput(ctx: Context): Promise<string> {
  const file = ctx.values.file;
  if (typeof file !== 'string') throw new CliError('usage', 'pass --file <path>, or --file - to read stdin');
  if (file !== '-')
    return readFile(resolvePath(ctx.root, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
      throw new CliError('not_found', `cannot read ${file}: ${error.code}`);
    });
  if (ctx.stdin.isTTY) throw new CliError('usage', 'stdin is a terminal; pipe the source in or use --file <path>');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new CliError('invalid', 'input larger than 1 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function saved(ctx: Context, kind: 'personas' | 'suites', item: Editable, action: string): number {
  const path = sourcePath(kind, item.id);
  if (ctx.json) emit(ctx.write, { id: item.id, revision: item.revision, path, action });
  else ctx.write(`${action} ${path}\n`);
  return 0;
}

/** `cohort persona|suite list|show|add|edit|remove`, plus `suite add-entry` and `persona schema|templates`. */
export async function fileCommand(
  noun: 'persona' | 'suite',
  verb: string | undefined,
  id: string | undefined,
  ctx: Context,
): Promise<number> {
  const kind = KINDS[noun];
  const { root, values, write } = ctx;
  if (verb === 'list') {
    const items = noun === 'persona' ? await personaSummaries(root) : await suiteSummaries(root);
    if (ctx.json) emit(write, { [kind]: items });
    else
      for (const item of items) write(`${item.id}\t${item.name ?? ''}${item.error ? `\terror: ${item.error}` : ''}\n`);
    return 0;
  }
  if (verb === 'show') {
    const item = await readEditable(root, kind, need(id, `${noun} show <id>`));
    if (ctx.json) emit(write, { ...item, path: sourcePath(kind, item.id) });
    else write(item.source);
    return 0;
  }
  if (verb === 'add') {
    const source = await readInput(ctx);
    try {
      return saved(ctx, kind, await createEditable(root, kind, source), 'created');
    } catch (error) {
      if (!(error instanceof EditError && error.status === 409 && values.force === true)) throw error;
      const sourceId = (kind === 'personas' ? parsePersona : parseSuite)(source, 'input').id;
      const before = await readEditable(root, kind, sourceId);
      return saved(ctx, kind, await saveEditable(root, kind, sourceId, source, before.revision), 'replaced');
    }
  }
  if (verb === 'edit') {
    const target = need(id, `${noun} edit <id> --file <path> [--revision <sha256>]`);
    const source = await readInput(ctx);
    const revision = (values.revision as string | undefined) ?? (await readEditable(root, kind, target)).revision;
    return saved(ctx, kind, await saveEditable(root, kind, target, source, revision), 'saved');
  }
  if (verb === 'remove') {
    const target = need(id, `${noun} remove <id> --yes`);
    if (values.yes !== true)
      throw new CliError('confirmation_required', `this deletes ${sourcePath(kind, target)}; pass --yes to confirm`);
    await removeEditable(root, kind, target);
    if (ctx.json) emit(write, { id: target, path: sourcePath(kind, target), action: 'removed' });
    else write(`removed ${sourcePath(kind, target)}\n`);
    return 0;
  }
  if (noun === 'suite' && verb === 'add-entry') {
    const target = need(id, 'suite add-entry <suite-id> --persona <id> [--goal|--url|--note|--model|--effort]');
    const entry = Object.fromEntries(
      (['persona', 'goal', 'url', 'note', 'model', 'effort'] as const).flatMap((key) =>
        values[key] === undefined ? [] : [[key, values[key]]],
      ),
    ) as unknown as SuiteEntry;
    if (!entry.persona) throw new CliError('usage', 'suite add-entry needs --persona <id>');
    const before = await readEditable(root, 'suites', target);
    return saved(ctx, kind, await appendSuiteEntry(root, target, entry, before.revision), 'saved');
  }
  if (noun === 'persona' && verb === 'schema' && id === undefined) {
    if (ctx.json) emit(write, { schema: personaSchema });
    else write(`${JSON.stringify(personaSchema, null, 2)}\n`);
    return 0;
  }
  if (noun === 'persona' && verb === 'templates' && id === undefined) {
    const templates = await personaTemplates();
    if (ctx.json) emit(write, { templates });
    else for (const template of templates) write(`${template.id}\n`);
    return 0;
  }
  throw new CliError('usage', `unknown command: cohort ${noun} ${verb ?? ''}`.trimEnd());
}

// `config|models show` adds the raw file; `edit` validates and replaces it.
async function settingsCommand(name: 'config.yml' | 'models.yml', verb: string, ctx: Context): Promise<boolean> {
  if (verb === 'edit') {
    const source = await readInput(ctx);
    const file = await saveSettings(ctx.root, name, source, ctx.values.revision as string | undefined);
    if (ctx.json) emit(ctx.write, { ...file, action: 'saved' });
    else ctx.write(`saved ${file.path}\n`);
    return true;
  }
  if (verb === 'show' && name === 'models.yml') {
    const file = await readSettings(ctx.root, name);
    if (ctx.json) emit(ctx.write, file);
    else ctx.write(file.source ?? '');
    return true;
  }
  return false;
}

export async function modelsCommand(verb: string, ctx: Context): Promise<number> {
  if (await settingsCommand('models.yml', verb, ctx)) return 0;
  const listed = modelList(await loadCatalog(ctx.root), ctx.providers);
  if (ctx.json) emit(ctx.write, listed);
  else
    for (const model of listed.models) {
      const prices =
        model.pricesPerMTok.input === null
          ? 'prices unknown'
          : `$${model.pricesPerMTok.input}/$${model.pricesPerMTok.output} per MTok`;
      ctx.write(
        `${model.id}\t${model.enabled ? 'enabled' : 'disabled'}${model.untested ? ', untested' : ''}\t${prices}\n`,
      );
    }
  return 0;
}

export async function configCommand(verb: string, ctx: Context): Promise<number> {
  if (await settingsCommand('config.yml', verb, ctx)) return 0;
  const view = configView(await loadProjectConfig(ctx.root), ctx.providers);
  const { source, revision } = await readSettings(ctx.root, 'config.yml');
  if (ctx.json) emit(ctx.write, { ...view, source, revision });
  else ctx.write(`${JSON.stringify(view, null, 2)}\n`);
  return 0;
}

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
