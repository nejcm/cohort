import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { Page } from 'playwright';
import type { DetachedBatch } from '../dashboard/runner.ts';
import type { ProviderAdapter } from '../providers/types.ts';

// Version of every `--json` document the CLI prints; bump on a breaking change (docs/agents.md).
const JSON_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 1024 * 1024;

export type Write = (text: string) => void;
export type Values = Record<string, string | string[] | boolean | undefined>;
type Input = AsyncIterable<Buffer | string> & { isTTY?: boolean };

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

/** What every command handler needs: the project root, parsed flags, the output sink, and the providers. */
export interface Context {
  root: string;
  values: Values;
  write: Write;
  json: boolean;
  providers: Record<string, ProviderAdapter>;
  stdin: Input;
  signal?: AbortSignal;
}

/** Process-level seams for `run()`; tests inject these, the `cohort` binary leaves them at their defaults. */
export interface Dependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, ProviderAdapter>;
  signal?: AbortSignal;
  openTrace?: (tracePath: string) => Promise<number>;
  /** Replaces the manual step of `cohort login`; tests drive a headless browser through it. */
  login?: { headless: boolean; ready: (page: Page) => Promise<void> };
  stdin?: Input;
  /** Starts a detached batch; defaults to a background `cohort` process, tests run it in-process with a fake model. */
  worker?: (batch: DetachedBatch) => Promise<{ batchId: string; runIds: string[] }>;
  fetch?: typeof fetch;
}

export function need(value: string | undefined, usage: string): string {
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
