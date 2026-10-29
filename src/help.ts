export interface CommandHelp {
  name: string;
  usage: string[];
  summary: string;
  options?: string[];
  notes?: string[];
}

const SELECTOR = '(--persona <id> | --tag <tag> | --suite <id> | --url <url> --note <text>)';

const RUN_OPTION_LINES = [
  '--mode vision|text        --model <provider>/<id>   --effort low|medium|high',
  '--repeats <n>             --steps <n>               --time-ms <n>   --dollars <n>',
  '--url <url>               --note <text>             --allow-untested',
  '--max-usd <n>             batch ceiling, default $10',
  '--allow-unpriced          run models with unknown prices (no enforceable dollar cap)',
];

export const COMMANDS: CommandHelp[] = [
  {
    name: 'init',
    usage: ['cohort init [--template <id>]...'],
    summary: 'Create .cohort/ with config, starter personas and a private .gitignore. Never overwrites existing files.',
    notes: ['--template (repeatable) copies the named persona templates instead of the defaults.'],
  },
  {
    name: 'doctor',
    usage: ['cohort doctor'],
    summary:
      'Check Node, node:sqlite, Chromium, config, default model, key presence, personas, suites, gitignore, auth permissions and unfinalized runs. Never calls a model; exit 2 on any error.',
  },
  {
    name: 'config',
    usage: ['cohort config show', 'cohort config edit --file <path>|- [--revision <sha256>]'],
    summary: 'Show or replace .cohort/config.yml. `show --json` adds the raw source and its revision.',
    notes: ['--revision rejects the edit if the file changed since you read it.'],
  },
  {
    name: 'models',
    usage: ['cohort models list', 'cohort models show', 'cohort models edit --file <path>|- [--revision <sha256>]'],
    summary: 'List the resolved model catalog, show .cohort/models.yml, or replace it.',
  },
  {
    name: 'estimate',
    usage: [`cohort estimate ${SELECTOR} [run options]`],
    summary: 'Price a batch without calling a model.',
    options: RUN_OPTION_LINES,
  },
  {
    name: 'run',
    usage: [`cohort run ${SELECTOR} [run options] [--detach]`],
    summary:
      'Run synthetic users against a site. Blocks until done, or with --detach starts a background batch and returns its ids.',
    options: RUN_OPTION_LINES,
    notes: [
      'Selectors: --persona <id>, --tag <tag>, --suite <id>, or an ad-hoc --url with --note.',
      'Exit 0 when every run completed, 1 when any did not, 2 on invalid invocation.',
    ],
  },
  {
    name: 'explore',
    usage: [
      'cohort explore --url <url> [--mode|--model|--effort|--steps|--time-ms|--dollars|--max-usd] [--detach]',
      'cohort explore suggest <run-id>',
      'cohort explore save <run-id> (--persona <id> | --suite <id>) [--revision <sha256>] --yes',
    ],
    summary: 'Let an agent explore a site with no persona, suggest personas or a suite from the run, and save one.',
    options: [
      '--url <url>               --mode vision|text        --model <provider>/<id>   --effort low|medium|high',
      '--steps <n>               --time-ms <n>             --dollars <n>             --allow-untested',
      '--max-usd <n>             batch ceiling, default $10',
      '--allow-unpriced          run models with unknown prices (no enforceable dollar cap)',
    ],
  },
  {
    name: 'runs',
    usage: [
      'cohort runs list [--limit <n>] [--filter active|look|finished] [--sort <key>] [--asc] [--search <text>]',
      '                 [--since <iso-date>] [--cursor <c>]',
      'cohort runs show|wait|cancel <run-or-batch-id> [--timeout-ms <n>]',
    ],
    summary: 'List runs, show one, wait for it to finish, or cancel it.',
    notes: ['`show` returns the run directory, artifacts and screenshots so an agent can read them from disk.'],
  },
  {
    name: 'report',
    usage: ['cohort report <run-or-batch-id> [--format json|md|html]'],
    summary: 'Print a run or batch report. --json implies --format json.',
  },
  {
    name: 'replay',
    usage: ['cohort replay <run-id>'],
    summary: 'Run the generated replay.spec.ts with no model. Needs @playwright/test installed in the project.',
  },
  {
    name: 'compare',
    usage: [
      'cohort compare <run-id> --base <origin> --head <origin> --repo <owner/name> --pr <n> --base-sha <sha>',
      '               --head-sha <sha> --deployment <id> --approved <sha256> --hooks <module> [--markdown <file>]',
    ],
    summary: 'Replay one approved run against two deployments and report whether the journey regressed.',
    notes: ['Exit 1 only for a confirmed regression. See docs/compare.md.'],
  },
  {
    name: 'publish',
    usage: ['cohort publish <compare-report.json> [--evidence <https-url>]'],
    summary: 'Post a compare report as a pull-request comment. Token comes from GITHUB_TOKEN.',
  },
  {
    name: 'trace',
    usage: ['cohort trace <run-id>'],
    summary: "Open the run's Playwright trace. Traces are private evidence and may contain secrets.",
  },
  {
    name: 'login',
    usage: ['cohort login --url <url> --state <name>'],
    summary:
      'Open a headed browser, let you sign in, and save the storage state for personas with storageState: <name>.',
  },
  {
    name: 'persona',
    usage: [
      'cohort persona list | schema | templates | validate',
      'cohort persona show|remove <id> [--yes]',
      'cohort persona add [--force] | edit <id> [--revision <sha256>]  --file <path>|-',
      'cohort persona generate --url <url> --description <text> [--out <file>] [--model <provider>/<id>]',
      '                        [--effort low|medium|high] [--dollars <n>] [--allow-untested]',
    ],
    summary: 'Manage persona files in .cohort/personas/. `generate` drafts one with a model (spends money).',
  },
  {
    name: 'suite',
    usage: [
      'cohort suite list',
      'cohort suite show|remove <id> [--yes]',
      'cohort suite add [--force] | edit <id>  --file <path>|-',
      'cohort suite add-entry <suite-id> --persona <id> [--goal <text>] [--url <url>] [--note <text>]',
    ],
    summary: 'Manage suites (named sets of persona runs) in .cohort/suites/.',
  },
  {
    name: 'ui',
    usage: ['cohort ui [--port <n>] [--host <address>]'],
    summary: 'Serve the local dashboard in the foreground. Prints the launch URL with its access token.',
    notes: ['Listens on 127.0.0.1 by default. SIGTERM or SIGINT stops it cleanly.'],
  },
  {
    name: 'help',
    usage: ['cohort help [command]'],
    summary: 'Describe every command, or one command in detail.',
  },
];

const GLOBAL_OPTIONS = [
  '-h, --help     Show the short usage',
  '-v, --version  Show the version',
  '--json         One JSON document on stdout, errors included; never prompts (docs/agents.md)',
  '--yes          Confirm a deletion or save that would otherwise be refused',
  '--file <path>  Input file for add/edit commands; `-` reads stdin (max 1 MiB)',
];

const ENV_LINES = [
  'ANTHROPIC_API_KEY, OPENAI_API_KEY   provider keys; read from the environment only',
  'GITHUB_TOKEN                        used by `cohort publish`',
];

function renderCommand(command: CommandHelp): string {
  const lines = command.usage.map((line) => `  ${line}`);
  const body = [command.summary, ...(command.notes ?? [])].map((line) => `    ${line}`);
  const options = command.options?.map((line) => `  ${line}`) ?? [];
  return [...lines, ...body, ...options].join('\n');
}

export function renderHelp(topic?: string): string | undefined {
  if (topic !== undefined) {
    const command = COMMANDS.find((item) => item.name === topic);
    if (!command) return undefined;
    return `${renderCommand(command)}\n\nGlobal options:\n${GLOBAL_OPTIONS.map((line) => `  ${line}`).join('\n')}\n`;
  }
  return [
    'cohort: AI synthetic users operate a web app and leave an inspectable trail.',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `\n${renderCommand(command)}`),
    '',
    'Global options:',
    ...GLOBAL_OPTIONS.map((line) => `  ${line}`),
    '',
    'Environment:',
    ...ENV_LINES.map((line) => `  ${line}`),
    '',
  ].join('\n');
}
