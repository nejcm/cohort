#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const USAGE = `Usage: lab [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

export function run(argv: string[], write: (text: string) => void = (text) => process.stdout.write(text)): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
      allowPositionals: true,
    });
  } catch (error) {
    if (!(error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')))
      throw error;
    write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    write(`${readVersion()}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    write(USAGE);
    return 0;
  }
  write(`Unknown command: ${positionals[0]}\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
