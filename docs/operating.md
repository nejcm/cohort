# Operating the lab

Keys, models, costs, limits, blockers, replay bindings, artifacts, and deletion. Setup modules and saved logins: [setup-and-login.md](setup-and-login.md). Personas and suites: [personas.md](personas.md).

## Keys

- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are read from the process environment only. There is no key file, prompt, dashboard field, or Action input.
- A provider without a key is hidden from the dashboard pickers and rejected by `lab run`. `lab doctor` prints only whether each key is set.
- Keys are scrubbed from provider errors, setup and cleanup errors, custom-tool output, and unexpected-error output. They never appear in reports, `steps.jsonl`, replay scripts, the SQLite index, API responses, or SSE events (`tests/integration/canary.test.ts`, `tests/integration/dashboard.test.ts`).
- Screenshots and page text go to the provider you choose. Use test data and test accounts; retention is the provider's policy, not ours.

## Models

The shipped catalog (`src/providers/catalog.json`) has one candidate entry and it is disabled: no model has been verified against a live API yet. To run, add an entry to `.lab/models.yml`:

```yaml
version: local-2026-10
models:
  - id: <model id>
    provider: openai          # or anthropic
    label: My verified model
    visionCapable: true       # required for vision mode
    supportedEffortLevels: [low, medium]
    defaultEffort: low
    pricesPerMTok: { input: 1.25, output: 10, cachedInput: 0.125 }   # USD per million tokens, or null
    pricingVerifiedAt: 2026-10-01
    untested: true            # runs then need --allow-untested
```

Entries override the shipped catalog by `(provider, id)`. Reports record the catalog version, hash, and entry used, so a later edit does not change old results. `lab doctor` checks that the project's default model resolves.

## Costs and limits

Defaults per run: 40 tool attempts, 10 minutes wall time (setup and provider waits included), and $2.00. The first limit reached ends the run as `limit_reached`. Override with `--steps`, `--time-ms`, `--dollars`, or `limits` in config, persona, or suite.

- Before a batch, `lab run` and the run dialog print an estimated cost range and the maximum batch budget. The estimate uses an unmeasured, conservative token budget per call; it is not an invoice.
- With prices, each provider call reserves an upper bound first and is refused if it cannot fit the remaining budget. A cancelled or failed call keeps its reservation, because it may be billed.
- Without prices (`null`), the dollar cap cannot be enforced. The CLI, dashboard, and reports say "cost unknown; dollar cap unenforceable"; only the step and time caps bound spend. Add dated prices to restore enforcement.
- Persona generation has its own budget (`--dollars`, default $0.50).

## Outcomes and blockers

Every run ends in exactly one state: `completed`, `abandoned`, `blocked(kind)`, `agent_error(code)`, or `limit_reached(limit)`. Only `completed` gives exit code 0. Harness-detected blockers (OAuth, CAPTCHA, and payment hosts on list v1) and the agent's own blocker reports are labelled separately; the host list and its limits are in [setup-and-login.md](setup-and-login.md#external-blockers). CAPTCHAs are never solved and real payments are never made.

## Replay bindings

`lab replay <run-id>` runs the generated `replay.spec.ts` with no model. It needs `@playwright/test` installed in the project. Bindings, in order:

1. If the run used a setup module, it runs again; its custom tools are served over a loopback bridge so one-time codes are fresh.
2. Otherwise `LAB_START_URL` from the environment.
3. Otherwise the recorded start URL, only if it was not reduced to origin and path.

Secrets are passed as `LAB_SECRET_<NAME>` and a storage state as `LAB_STORAGE_STATE` (a file path). Replay never saves screenshots, because it types real values.

## Artifacts

Each run writes `.lab/runs/<run-id>/`; each batch writes `.lab/runs/<batch-id>/`. Directories are created owner-only (0700) and files 0600, including `trace.zip`. `lab init` creates `.lab` as 0700, and `lab ui` tightens `.lab` to 0700 and `index.sqlite`, `-wal`, and `-shm` to 0600 on every start.

| File | Contents | Sensitivity |
| --- | --- | --- |
| `trace.zip` | Native Playwright trace: unmasked DOM snapshots, network, typed values | Private. Holds secrets. Never publish, commit, or upload |
| `screenshots/` | Masked screenshots sent to the model | Masked for known secrets; may still show sensitive app content |
| `steps.jsonl`, `replay.spec.ts` | Actions with `{{placeholder}}` bindings | Redacted |
| `report.{json,md,html}`, `resolved-config.json` | Outcome, claims, cost, resolved request | Redacted; URLs keep origin and path only |
| `manifest.json` | Inventory and configuration hashes, written last | No secrets |
| `.lab/auth/<name>.json` | Saved login storage state | A credential |
| `.lab/index.sqlite*` | Dashboard index of redacted events | Redacted |

`lab init` writes `.lab/.gitignore` so `runs/`, `auth/`, and `index.sqlite*` stay out of git; `lab doctor` checks this with `git check-ignore`. Treat every artifact as sensitive until reviewed.

A run directory without `manifest.json` was not finalized: it is still running, or its process was killed. `SIGINT` and `SIGTERM` finalize runs as interrupted; a hard kill cannot. `lab doctor` lists such directories, and `lab ui` marks the ones it indexed as interrupted with a bounded report. Nothing resumes or spends again.

## Retention and deletion

There is no automatic retention. Delete what you no longer need:

```sh
rm -rf .lab/runs/run_20261028_123523_6a126b   # one run
rm -rf .lab/runs                              # all runs and batch reports
rm -f .lab/index.sqlite*                      # dashboard index; rebuilt from finalized runs on next lab ui
rm -f .lab/auth/<name>.json                   # a saved login
```

Stop `lab ui` before deleting the index. In CI, set an artifact retention period and exclude `trace.zip`; see [github-action.md](github-action.md).

## Diagnostics

- `lab doctor [--json]` checks Node, `node:sqlite`, Chromium, `.lab/config.yml`, the catalog and default model, key presence, personas and suites, gitignore coverage, `.lab/auth` permissions, and unfinalized runs. It never calls a model. Exit code 2 when any check is an error.
- Unexpected errors print one bounded line with keys scrubbed and exit 2; set `LAB_DEBUG=1` for the stack.
