# Driving cohort from an agent

Everything the dashboard does, and every file a person would edit, has a CLI command. A coding agent (or a script) can create personas and suites, price a batch, start it in the background, wait for it, cancel it, and read the reports without `cohort ui` running and without ever being prompted.

Rules every command follows:

- `--json` prints exactly one JSON document on stdout, errors included. Nothing else goes to stdout; the exit code still applies.
- Nothing prompts. A step that needs a person (deleting a file, logging in) fails with exit 2 and a stable error code instead; `--yes` confirms deletions.
- Input that is a file comes from `--file <path>` or `--file -` (stdin), up to 1 MiB. A terminal on stdin is refused rather than read.
- Output has no color or progress animation, TTY or not.
- No output contains provider keys: every value is redacted before it is printed, and `run`, `explore`, `ui`, and `persona generate`, which hand keys to a provider, refuse a set provider key shorter than 8 characters as `invalid`; other commands never read key values, so they run. Those other commands do not redact a key shorter than 8 characters, so they can echo one back if it is passed as an argument or flag; real provider keys are longer. Nor does it contain setup secrets, the dashboard token, or URL query strings; start URLs are reduced to origin and path everywhere they are stored or printed. `suite show` and `persona show` return the file exactly as written, so do not put secrets in persona or suite files.

`cohort help` prints every command with its flags and `cohort help <command>` prints one; with `--json` it returns the same table as `commands[]`. The repository ships an agent skill for this CLI at `skills/cohort/SKILL.md` (copy it into your agent's skills directory).

## Invoking the CLI

Examples below use `cohort` as the command prefix:

- Installed package: use `npx --no-install cohort ...` for a project-local install, or `cohort ...` if installed on `PATH`.
- Uninstalled checkout: after `bun install --frozen-lockfile`, use `node src/cli.ts ...` from the repository root; no build is needed. For example, `node src/cli.ts help run --json`.
- To operate on another project from a checkout, run `node /absolute/path/to/cohort/src/cli.ts ...` with that project as the working directory. `.cohort/` is resolved from the working directory, not the script's location.

Export provider keys into the environment before commands that call a model. If a person has provided an environment file, Node can load it with `node --env-file=/path/to/file /absolute/path/to/cohort/src/cli.ts ...`; never print its contents.

Run `cohort init --json` before estimating or running in a new project. Its config defaults to **3 repeats**: pass `--repeats 1` to both `estimate` and `run` for a single run, and inspect the estimate first.

## Persona input

Persona files are **Markdown with YAML frontmatter** between `---` delimiters, followed by a nonempty Markdown description. `cohort persona schema --json` describes the frontmatter fields, not a JSON document accepted by `persona add --file`.

Use `cohort persona templates --json` for complete examples: each template's `source` is a valid persona document. Adapt that source, then pass the Markdown to `cohort persona add --file <path> --json` (or `--file -` for stdin) and run `cohort persona validate --json`. See [personas.md](personas.md#persona-format) for the format.

## Command map

| Dashboard route or manual edit | Command |
| --- | --- |
| `GET /api/config` | `cohort config show --json` (adds the raw `source` and its `revision`) |
| `GET /api/models` | `cohort models list --json` |
| Editing `.cohort/config.yml` | `cohort config edit --file <f> [--revision <sha256>]` |
| Editing `.cohort/models.yml` | `cohort models show --json`, then `cohort models edit --file <f> [--revision <sha256>]` |
| `GET /api/personas` | `cohort persona list --json` |
| `GET /api/persona-schema`, `GET /api/persona-templates` | `cohort persona schema --json`, `cohort persona templates --json` |
| `GET /api/personas/:id`, `GET /api/suites/:id` | `cohort persona show <id> --json`, `cohort suite show <id> --json` |
| `POST /api/personas`, `POST /api/suites` (create) | `cohort persona add --file <f>`, `cohort suite add --file <f>` (`--force` replaces) |
| `PUT /api/personas/:id`, `PUT /api/suites/:id` (save) | `cohort persona edit <id> --file <f> [--revision <sha256>]`, same for `suite` |
| Deleting a persona or suite file | `cohort persona remove <id> --yes`, `cohort suite remove <id> --yes` |
| `POST /api/suites/:id/entries` | `cohort suite add-entry <suite> --persona <id> [--goal] [--url] [--note] [--model] [--effort]` |
| `POST /api/personas/generate` | `cohort persona generate ... --json` |
| `GET /api/suites` | `cohort suite list --json` |
| `GET /api/storage-states` (saved login names, never contents) | `ls .cohort/auth/` |
| `POST /api/runs` with `preview` | `cohort estimate <selector> --json` (never calls a model) |
| `POST /api/runs` | `cohort run <selector> --detach --json` (or without `--detach` to block) |
| `GET /api/runs` (tabs, search, sort, paging) | `cohort runs list --json [--limit] [--filter active\|look\|blocked\|finished] [--search <text>] [--sort <key>] [--asc] [--since <iso-date>] [--cursor]` (`--since` sets where "today" starts for `counts`; default UTC midnight; `look` is limit reached or agent error, and `blocked` runs are counted apart) |
| `GET /api/journeys` (completion and friction per persona and goal over their latest 10 runs) | No CLI equivalent yet; `cohort runs list --json` returns the runs it groups, each with `friction` and `opinions` |
| `GET /api/runs/:id`, `GET /api/batches/:id` | `cohort runs show <run-or-batch-id> --json` |
| `GET /api/runs/:id/events` (live stream) | `cohort runs wait <id> --json [--timeout-ms]` |
| `POST /api/runs/:id/cancel` | `cohort runs cancel <run-or-batch-id> --json` |
| `GET /api/runs/:id/artifacts/:file`, `.../screenshots/:id` | Read `<dir>/<artifact id>` and `<dir>/screenshots/<id>.png`; `runs show` returns `dir`, `artifacts`, and `screenshots` |
| Checking personas and suites after a manual edit | `cohort persona validate --json` |
| Starting the dashboard for a person | `cohort ui --json` runs in the foreground (start it as a background job); it prints `origin`, `pid`, and `urlFile` |
| Stopping the dashboard | Send `SIGTERM` (or `SIGINT`) to that `pid`; it closes cleanly and removes `urlFile` |
| Exploring an app and reviewing suggestions (CLI only) | `cohort explore --url <url> --json [--detach]`, then `cohort explore suggest <run-id> --json` after a detached run; `cohort explore save <run-id> --persona <id> \| --suite <id> --yes [--revision <sha256>]` ([explore.md](explore.md)) |
| Viewing a trace | `cohort trace <run-id> --json` returns the path and opens nothing |

Adding or changing a `setup:` reference stays a manual edit by a person, in the CLI as in the dashboard. Setup modules run as code with your privileges, and the security model allows no model-authored setup ([security.md](security.md)), so an agent must not be the one to wire them in.

All edits (personas, suites, config, catalog) validate before writing, replace the file atomically, and hold an exclusive SQLite lock on `.cohort/index.sqlite-edit-lock` across processes, so two concurrent edits from the same `--revision` cannot both succeed. The operating system releases the lock if its holder dies.

`config edit` and `models edit` check the file's schema; check that the default model resolves with `cohort doctor --json` afterwards.

## Output

Every JSON document has `schemaVersion: 1`. The version changes only when a field is removed or changes meaning; new fields can appear at any time. Model prices (`pricesPerMTok`) carry `input`, `output`, `cachedInput`, and `cacheWrite`; run usage carries `cacheWriteInputTokens` beside `cachedInputTokens` (see [operating.md](operating.md#models)). The shape of each command's output is pinned in [`tests/integration/agent-cli.test.ts.snapshot`](../tests/integration/agent-cli.test.ts.snapshot).

| Command | Top-level fields |
| --- | --- |
| `init` | `created`, `kept` |
| `doctor` | `checks[] {level, message}` |
| `config show` | `defaults`, `providers`, `source`, `revision` |
| `models list` | `catalog`, `providers[]`, `models[]` |
| `models show` | `path`, `source` (null when absent), `revision` |
| `config edit`, `models edit` | `path`, `revision`, `action: "saved"` |
| `ui` | `origin`, `pid`, `urlFile` |
| `explore`, `explore suggest` | `runId`, `outcome`, `coverage`, `features[]`, `untried[]`, `personas[]`, `goals[]`, `suite`, `tests[]`, `dropped[]`, `estimatedCostUsd`; foreground `explore` adds `batchId`, `maxUsd`, `runOutcome`; `--detach` returns `batchId`, `runIds` |
| `explore save` | `id`, `revision`, `path`, `action: "created" \| "replaced"` |
| `--help`, or no command | `usage` |
| `help [command]` | `commands[] {name, usage, summary, options?, notes?}`; `options` enumerates shared run flags |
| `persona list` / `suite list` | `personas[]` / `suites[]`, each with `error` (null when valid) |
| `persona show` / `suite show` | `id`, `source`, `revision`, `parsed`, `error`, `path` |
| `add`, `edit`, `add-entry` | `id`, `revision`, `path`, `action` (`created`, `replaced`, `saved`) |
| `remove` | `id`, `path`, `action: "removed"` |
| `estimate` | `preflight[]`, `plans[]`, `maxBatchUsd`, `maxUsd`, `refusal` (null, or `{code, error}` that `run` would return) |
| `run --detach` | `batchId`, `runIds[]`, `preflight`, `plans`, `maxBatchUsd`, `maxUsd` |
| `run` | `batchId`, `runs[]`, `skipped`, `summary`, `reportDir`, `exitCode`, plus the estimate fields |
| `runs list` | `runs[]`, `nextCursor`, `counts` |
| `runs show` / `runs wait` on a run | `run`, `report`, `artifacts[]`, `screenshots[]`, `dir`, `done` |
| `runs show` / `runs wait` on a batch | `batch`, `runs[]`, `summary`, `dir`, `done` |
| `runs cancel` | `id`, `cancelling[]` |
| `compare` | `runId`, `base`, `head`, `provenance`, `outcome` (`regression`, `no_regression`, `inconclusive`), `reason`, `executions[]` ([compare.md](compare.md)) |
| `publish` | `action` (`created`, `updated`, `skipped`), `reason`, `commentId` |
| `report --json` | the report itself, with its own `schemaVersion`; `--json` with `--format md` or `html` is a `usage` error |

## Exit codes and errors

- `0`: success. For `run` and `runs wait`, every run completed.
- `1`: the command worked but the result is not a success: a run did not complete, the provider failed, or `runs wait` timed out.
- `2`: refused. Nothing ran and nothing was written.

Errors look like `{"schemaVersion":1,"error":"<message>","code":"<code>", ...}`. Codes are stable; messages are not.

| Code | Exit | Meaning and extra fields |
| --- | --- | --- |
| `usage` | 2 | Unknown command or flag, or a bad flag value |
| `invalid` | 2 | Content failed validation; `problems[]` lists every problem at once |
| `not_found` | 2 | No such persona, suite, run, batch, file, or report |
| `conflict` | 2 | The file exists (use `--force`), changed since `--revision`, is used by a suite, or the run is no longer active |
| `confirmation_required` | 2 | A deletion without `--yes` |
| `cap_unenforceable` | 2 | A model has no prices, so the dollar ceiling cannot be enforced; `estimate` |
| `over_budget` | 2 | The batch's maximum cost exceeds `--max-usd`; `estimate` |
| `blocked` | 2 | A person must act; `command` is what they should run |
| `queue_full` | 2 | Too many queued runs |
| `index_unavailable` | 2 | A foreground `run` could not open `.cohort/index.sqlite`; it needs a writable index |
| `not_ready` | 2 | The run has no report yet |
| `provider_error` | 1 | The model provider failed (persona generation) |
| `timeout` | 1 | `runs wait` reached `--timeout-ms`; wait again |
| `publish_failed` | 1 | `cohort publish` got an error or no response from the GitHub API |
| `internal` | 2 | A bug; the message is scrubbed. `COHORT_DEBUG=1` adds the stack on stderr |

## Cost safety

Every `cohort run` and `cohort estimate` checks the batch before anything starts:

- Each run has step, time, and dollar caps (defaults 40 steps, 10 minutes, $2.00; see [operating.md](operating.md#costs-and-limits)).
- The batch's maximum cost must be at most `--max-usd`, default **$10** and at most $1000. Otherwise it is refused with `over_budget`.
- A model without prices cannot be held to a dollar cap, so it is refused with `cap_unenforceable` unless `--allow-unpriced` is given.

Run `cohort estimate` first; its `refusal` field says exactly what `run` would refuse, without calling a model. The config created by `init` defaults to **3 repeats**. For a single run, pass `--repeats 1` to both `estimate` and `run`, keeping the selector and budget flags identical.

## Background runs

`cohort run --detach` resolves and prices the batch, then starts a separate `cohort` process that owns it and returns the batch and run IDs as soon as they are queued. The batch lives in the same index the dashboard reads (`.cohort/index.sqlite`), so `cohort ui` shows it, and `runs show|wait|cancel` work from any process.

- `runs wait` polls until every run has ended and the batch report is written. When the owning process died, `runs wait` and `runs show` mark its active runs `interrupted` and write the batch report from the run reports. Owners are identified by PID plus process start time on Linux. Elsewhere, and for batches recorded before start times were stored, the PID alone is checked, so a reused PID can make a dead batch look alive until that process exits: `runs wait` then ends in `timeout` and a cancel stays pending. It never makes a live batch look dead.
- A foreground `cohort run` is indexed the same way, so every `runs` command sees it (it does not act on `runs cancel`; stop it with `SIGINT`). A hard kill cannot finalize itself; the next `cohort run`, `cohort ui`, or any `cohort runs` command marks it interrupted and writes its batch report.
- `runs cancel` (and the dashboard's cancel button) records the request in the index; the owning process stops queued runs at once and running ones within about 200 ms, finalizing them as cancelled by the user. Cancelling a finished run is a `conflict`.
- An open dashboard follows a detached run's events through the index, every half second.
- `runs` commands need only the index, so a broken `config.yml` never prevents cancelling a batch.
- The owner survives the launching CLI's exit. An agent sandbox or job supervisor can still kill detached descendants when its command or session ends; `--detach` cannot override that cleanup. Use foreground `run` with a tool that keeps the command alive in such environments. Cancel the batch, or wait for it, before leaving.

## Dashboard

The dashboard URL carries a bearer token that can launch browsers and spend on your keys, so `cohort ui --json` never prints it. It writes the URL to `.cohort/auth/dashboard-<id>.url`, unique per instance (owner-only, ignored by git; `urlFile` names it) for a person to open, and removes it when that dashboard stops, including when startup fails after the listener opened. In a terminal, `cohort ui` prints the URL as before.

## Login stays human

`cohort login` opens a headed browser for a person to log in. With `--json`, or without a terminal, it does not start; it returns `blocked` with the exact command:

```json
{"schemaVersion":1,"error":"cohort login needs a person at a headed browser and terminal; ask one to run it","code":"blocked","command":"cohort login --url 'https://app.example/login' --state host"}
```

Ask the person to run it, then reference the saved state with `storageState: host` in a persona or suite.

## Snippet for AGENTS.md

```md
## Synthetic users (cohort)

- Always pass `--json` and read the exit code: 0 ok, 1 result not ok, 2 refused (see `code`).
- Never edit `.cohort/personas` or `.cohort/suites` by hand: use `cohort persona|suite add|edit --file -`, then `cohort persona validate --json`.
- Price first: `cohort estimate --suite <id> --repeats 1 --json`; if `refusal` is not null, change the request or ask the user. Do not add `--allow-unpriced` or raise `--max-usd` without the user's approval. `init` defaults to 3 repeats; choose the count explicitly.
- Start with `cohort run --suite <id> --repeats 1 --detach --json`, then `cohort runs wait <batchId> --json --timeout-ms 600000`. Cancel with `cohort runs cancel <id>` if you stop early.
- Read results from `cohort report <id> --format json`. Never open, upload, or quote `trace.zip`; it contains secrets.
- If a command returns `code: "blocked"`, ask the user to run its `command`; do not try to log in yourself.
```

The [2026-10-30 agent session](agent-session.md) records a real coding agent creating, estimating, launching, inspecting, and deleting a persona through the CLI. Its detached owner stopped before any recorded action, so a completed live-provider journey remains unverified.
