# Operating the lab

Keys, models, costs, limits, blockers, replay bindings, base/head comparison, artifacts, and deletion. Setup modules and saved logins: [setup-and-login.md](setup-and-login.md). Personas and suites: [personas.md](personas.md).

## Keys

- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are read from the process environment only. There is no key file, prompt, dashboard field, or Action input.
- A provider without a key is hidden from the dashboard pickers and rejected by `cohort run`. `cohort doctor` prints only whether each key is set.
- Keys are scrubbed from provider errors, setup and cleanup errors, custom-tool output, and unexpected-error output. They never appear in reports, `steps.jsonl`, replay scripts, the SQLite index, API responses, or SSE events (`tests/integration/canary.test.ts`, `tests/integration/dashboard.test.ts`).
- Screenshots and page text go to the provider you choose. Use test data and test accounts; retention is the provider's policy, not ours.

## Models

The shipped catalog (`src/providers/catalog.json`) has one entry, `anthropic/claude-sonnet-5-5` (Claude Sonnet 5.5), live-checked and priced on 2026-10-29. To use another model, add an entry to `.cohort/models.yml` (by hand, or validated with `cohort models edit --file -`):

```yaml
version: local-2026-10
models:
  - id: <model id>
    provider: openai          # or anthropic
    label: My verified model
    visionCapable: true       # required for vision mode
    supportedEffortLevels: [low, medium]
    defaultEffort: low
    pricesPerMTok: { input: 1.25, output: 10, cachedInput: 0.125, cacheWrite: 1.5625 }   # USD per million tokens, or null
    pricingVerifiedAt: 2026-10-01
    untested: true            # runs then need --allow-untested
```

`pricesPerMTok` needs all four keys. `cachedInput` is the cache-read price; `cacheWrite` is the price of tokens written to the prompt cache, at the TTL cohort requests: the 5-minute TTL on Anthropic, and the default retention on OpenAI, which cohort does not change (when unsure, use the higher tier). An entry with `input` and `output` prices must also price `cacheWrite`; copy `input` only when the provider charges writes at the input rate. Reports and `--json` output count written tokens as `usage.cacheWriteInputTokens`, part of `inputTokens` like `cachedInputTokens`. An Anthropic response that reports writes at any other TTL fails the call (`provider_error`) instead of pricing them at the 5-minute rate.

Entries override the shipped catalog by `(provider, id)`. Reports record the catalog version, hash, and entry used, so a later edit does not change old results. `cohort doctor` checks that the project's default model resolves.

## Costs and limits

Defaults per run: 40 tool attempts, 10 minutes wall time (setup and provider waits included), and $2.00. The first limit reached ends the run as `limit_reached`. Override with `--steps`, `--time-ms`, `--dollars`, or `limits` in config, persona, or suite.

- Before a batch, `cohort run` and the run dialog print an estimated cost range and the maximum batch budget. The estimate uses an unmeasured, conservative token budget per call; it is not an invoice.
- With prices, each provider call reserves an upper bound first, pricing every input token at the dearest of the input, cache-read, and cache-write rates, and is refused if it cannot fit the remaining budget. A cancelled or failed call keeps its reservation, because it may be billed.
- Without prices (`null`), the dollar cap cannot be enforced. The CLI, dashboard, and reports say "cost unknown; dollar cap unenforceable"; only the step and time caps bound spend. Add dated prices to restore enforcement. `cohort run` refuses such a batch (`cap_unenforceable`) unless given `--allow-unpriced`.
- `cohort run` also refuses a batch whose maximum cost exceeds `--max-usd` (default $10, at most $1000) with `over_budget`. `cohort estimate` shows the same check without running anything.
- Persona generation has its own budget (`--dollars`, default $0.50).

## Outcomes and blockers

Every run ends in exactly one state: `completed`, `abandoned`, `blocked(kind)`, `agent_error(code)`, or `limit_reached(limit)`. Only `completed` gives exit code 0. Harness-detected blockers (OAuth, CAPTCHA, and payment hosts on list v1) and the agent's own blocker reports are labelled separately; the host list and its limits are in [setup-and-login.md](setup-and-login.md#external-blockers). CAPTCHAs are never solved and real payments are never made.

## Replay bindings

`cohort replay <run-id>` runs the generated `replay.spec.ts` with no model. It needs `@playwright/test` installed in the project. Bindings, in order:

1. If the run used a setup module, it runs again; its custom tools are served over a loopback bridge so one-time codes are fresh.
2. Otherwise `COHORT_START_URL` from the environment.
3. Otherwise the recorded start URL, only if it was not reduced to origin and path.

A same-origin `goto` without its own query keeps the start URL's query parameters, live and in replay, so state like `?scope=` survives. Parameters whose values are bound secrets or look like tokens (20+ characters, or 8+ mixing letters and digits) are never carried over; pass those through setup bindings.

Secrets are passed as `COHORT_SECRET_<NAME>` and a storage state as `COHORT_STORAGE_STATE` (a file path). Replay never saves screenshots, because it types real values.

## Comparing base and head

`cohort compare <run-id> --base <origin> --head <origin> <provenance> --hooks <module> [--json] [--markdown <file>]` replays one approved run against two deployments, such as production and a pull-request preview, and reports whether the journey regressed. No model is called and the run's bundle, including its replay status, is not changed. Provenance, hooks, hash checks, verdicts, and publishing are in [compare.md](compare.md); this section covers how each execution runs.

- `--base` and `--head` must be bare `http(s)` origins: no path, query, fragment, or credentials. Each execution resolves the start URL as `cohort replay` does (setup module, then `COHORT_START_URL`, then the recorded URL) and then replaces only its origin, keeping the path, query, and fragment. Tokens therefore stay in setup bindings or `COHORT_START_URL`, never on the command line, and the printed origins hold nothing secret.
- A setup module runs once per execution and can read the origin under test as `ctx.env('COHORT_COMPARE_ORIGIN')`, for example to seed an account on that deployment. Its returned `startUrl` origin is replaced like any other.
- A replay script that still names the recorded origin in a `goto` is refused (exit 2): retargeting it would change the journey. Current scripts rebase such URLs onto the start URL.
- Each execution's replay test is bounded by the shorter of the run's time limit and Playwright's 30 s default test timeout. Setup and cleanup keep the run's time limit, as in `cohort replay`.

At most four executions: base, head, and, only when head fails, both once more. Only a base pass and head fail in both rounds is `regression`; base and head passing is `no_regression`; everything else is `inconclusive` with a reason, including a failing base, a flaky confirmation, or an execution that could not run because a hook, setup, or cleanup failed or Playwright reported an environment error (`net::ERR_…`, a missing replay binding, a browser that will not launch). Environment and setup failures are never a regression.

Evidence per execution is text only: side, pass or fail, duration, and the first failing step with its error and locator, taken from Playwright output after the same redaction as `cohort replay`. No screenshots are saved, because replay types real values.

Output is plain text by default; `--json` prints the structured result. `--markdown <file>` writes the advisory pull-request comment body that `cohort publish` posts; it starts with `<!-- cohort-compare:<run-id> -->`. Failure text in it is Markdown-escaped. Exit codes: `0` for `no_regression` or `inconclusive`; `1` only for a confirmed `regression`; `2` for invalid invocation, configuration, or a bundle that fails its hash checks. [compare.md](compare.md#trusted-workflow) has a workflow.

## Artifacts

Each run writes `.cohort/runs/<run-id>/`; each batch writes `.cohort/runs/<batch-id>/`. Directories are created owner-only (0700) and files 0600, including `trace.zip`. `cohort init` creates `.cohort` as 0700, and `cohort ui` tightens `.cohort` to 0700 and `index.sqlite`, `-wal`, and `-shm` to 0600 on every start.

| File | Contents | Sensitivity |
| --- | --- | --- |
| `trace.zip` | Native Playwright trace: unmasked DOM snapshots, network, typed values | Private. Holds secrets. Never publish, commit, or upload |
| `screenshots/` | Masked screenshots sent to the model | Masked for known secrets; may still show sensitive app content |
| `steps.jsonl`, `replay.spec.ts` | Actions with `{{placeholder}}` bindings | Redacted |
| `report.{json,md,html}`, `resolved-config.json` | Outcome, claims, cost, resolved request | Redacted; URLs keep origin and path only |
| `manifest.json` | Inventory with each file's SHA-256, and configuration hashes, written last | No secrets |
| `.cohort/auth/<name>.json` | Saved login storage state | A credential |
| `.cohort/auth/dashboard-<id>.url` | Dashboard URL with its token, written by `cohort ui --json` while it runs | A credential |
| `.cohort/index.sqlite*` | Index of runs and redacted events, shared by `cohort ui`, `cohort run` (foreground and `--detach`), and `cohort runs` | Redacted |

`cohort init` writes `.cohort/.gitignore` so `runs/`, `auth/`, and `index.sqlite*` stay out of git; `cohort doctor` checks this with `git check-ignore`. Treat every artifact as sensitive until reviewed.

`cohort run --detach` hands the batch to a background `cohort` process that records its PID and start time in the index; `cohort runs wait|cancel` and the dashboard coordinate through the index ([agents.md](agents.md#background-runs)).

A run directory without `manifest.json` was not finalized: it is still running, or its process was killed. `SIGINT` and `SIGTERM` finalize runs as interrupted; a hard kill does not finalize itself. Every batch, foreground `cohort run` included, is indexed with its owning process, so a foreground run needs a writable `.cohort/index.sqlite` (`index_unavailable` otherwise). The next `cohort run`, `cohort ui`, or any `cohort runs` command marks runs whose owner is gone as interrupted and writes a bounded run and batch report. `cohort doctor` stays read-only and only lists such directories. Nothing resumes or spends again.

## Retention and deletion

There is no automatic retention. Delete what you no longer need:

```sh
rm -rf .cohort/runs/run_20261028_123523_6a126b   # one run
rm -rf .cohort/runs                              # all runs and batch reports
rm -f .cohort/index.sqlite .cohort/index.sqlite-wal .cohort/index.sqlite-shm  # run index; rebuilt on next cohort ui or cohort run
rm -f .cohort/auth/<name>.json                   # a saved login
```

Stop `cohort ui` and any detached batch (`cohort runs list --filter active`) before deleting the index. Leave `.cohort/index.sqlite-edit-lock` in place: it is the cross-process edit lock. In CI, set an artifact retention period and exclude `trace.zip`; see [github-action.md](github-action.md).

## Diagnostics

- `cohort doctor [--json]` checks Node, `node:sqlite`, Chromium, `.cohort/config.yml`, the catalog and default model, key presence, personas and suites, gitignore coverage, `.cohort/auth` permissions, and unfinalized runs. It never calls a model. Exit code 2 when any check is an error.
- Unexpected errors print one bounded line with keys scrubbed and exit 2; set `COHORT_DEBUG=1` for the stack.
