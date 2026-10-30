<p align="center">
  <img src="ui/favicon.svg" alt="cohort logo" width="96" height="96">
</p>

<h1 align="center">cohort</h1>

<p align="center">
  AI synthetic users that operate your web app like real people.<br>
  Inspectable Playwright trail. Replayable script. Evidence-cited reports.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

> [!NOTE]
> Working title. Release candidate `0.1.0-rc.0`: tested offline against a scripted model; no shipped model is enabled until live verification.

Give a persona a goal. An agent drives a real Chromium browser from screenshots, the way a first-time user would, and every action is recorded as an inspectable Playwright trail plus a replayable script. Reports separate what the harness measured from what the agent thought, and every claim cites screenshot evidence.

## Why cohort

- **Local-first.** A CLI and a local dashboard. No hosted service, accounts, or telemetry.
- **Bring your own key.** OpenAI or Anthropic; keys stay in your environment.
- **Honest outcomes.** `completed`, `abandoned`, `blocked(kind)`, `agent_error(code)`, or `limit_reached(limit)`. An agent failure is never reported as a UX failure.
- **Bounded spend.** Step, time, and dollar caps, with "cost unknown" stated when prices are missing.

**Not** an accessibility audit, a substitute for user research, a load tester, or a CAPTCHA or payment bot. Synthetic behaviour is not validated against real people.

## Quick start

Requires Node.js 24.2.0 or later and npm.

```sh
npm install --save-dev cohort-lab   # not yet published; see docs/release-checklist.md
npx playwright install chromium
npx cohort init      # .cohort/ with config, three example personas, and a .gitignore for private evidence
npx cohort doctor    # runtime, browser, config, model, keys, paths; never calls a model
```

`cohort init` defaults to `openai/gpt-6.1-terra` (set `OPENAI_API_KEY`); `anthropic/claude-sonnet-5-5` is also shipped (set `ANTHROPIC_API_KEY`). Pick either with `model:` in `.cohort/config.yml`.

Try it on the bundled fixture app (from a clone of this repository; it needs only Node):

```sh
node tests/fixtures/friction-app/server.ts --port 4173        # add --mutation hidden_primary etc. for seeded friction
npx cohort run --persona first-time-host --url http://127.0.0.1:4173/ --repeats 1
open .cohort/runs/<batch-id>/report.html                    # the run prints its report path
```

## Commands

| Command | Purpose |
| --- | --- |
| `cohort init [--template <id>]... [--pack <id>]...` | Create `.cohort/` without overwriting anything; `--template` adds the named [persona templates](docs/personas.md#templates) instead of the default three, `--pack keyboard\|small-screen` adds a [scenario pack](docs/personas.md#scenario-packs) and its personas |
| `cohort doctor [--json]` | Check the setup, including whether `cohort replay` can run; exit 2 on any error |
| `cohort run --persona <id> \| --tag <tag> \| --suite <id> \| --url <url> --note <goal>` | Run a batch. Options: `--mode`, `--model <provider>/<id>`, `--effort`, `--repeats`, `--steps`, `--time-ms`, `--dollars`, `--max-usd` (batch ceiling, default $10), `--allow-unpriced`, `--allow-untested`, `--detach`, `--json` |
| `cohort estimate <selector> [run options]` | Price a batch and show whether `run` would refuse it; never calls a model |
| `cohort runs list \| show \| wait \| cancel [<run-or-batch-id>]` | List (`--filter`, `--search`, `--sort`, `--asc`, `--since`), inspect, wait for (`--timeout-ms`), or cancel runs, including detached ones and those started from the dashboard |
| `cohort report <run-or-batch-id> [--format json\|md\|html]` | Print or re-render a report |
| `cohort replay <run-id>` | Rerun `replay.spec.ts` with no model; needs `@playwright/test` in the project |
| `cohort compare <run-id> --base <origin> --head <origin> <provenance> --hooks <module> [--json]` | Replay an approved, hash-verified run on base and head with confirmation: `regression`, `no_regression`, or `inconclusive` ([details](docs/compare.md)) |
| `cohort publish <compare-report.json> [--evidence <url>]` | Post or update the one advisory PR comment for a compare report, skipping a stale PR head; needs only `GITHUB_TOKEN` ([details](docs/compare.md#cohort-publish)) |
| `cohort explore --url <url> [--steps\|--time-ms\|--dollars\|--max-usd] [--detach]` | One bounded exploration run that refuses destructive controls, then one metered call that suggests personas, goals, and replay tests citing observed steps; written only into the run bundle, saved with `cohort explore save <run-id> --persona\|--suite <id> --yes` or from the dashboard's review page ([details](docs/explore.md)) |
| `cohort trace <run-id>` | Open the private trace locally with `playwright show-trace` |
| `cohort login --url <url> --state <name>` | Log in by hand in a headed browser; saves `.cohort/auth/<name>.json` |
| `cohort persona validate \| schema \| templates` | Check every persona and suite, reporting all problems; print the persona schema or the template list |
| `cohort persona\|suite list \| show \| add \| edit \| remove` | Manage persona and suite files with validation, atomic writes, and revision checks; `suite add-entry` appends an entry |
| `cohort config show\|edit`, `cohort models list\|show\|edit` | Effective defaults, key presence, and runnable models; `edit` validates and atomically replaces `config.yml` or `models.yml` |
| `cohort persona generate --url <url> --description <text> [--out <file>]` | One metered call over a landing page; preview unless `--out` |
| `cohort ui [--port <n>] [--host <address>]` | Authenticated local dashboard on `127.0.0.1`; with `--json` it prints `origin`, `pid`, and a private `urlFile` holding the sign-in URL, and stops on `SIGTERM` |

Every command takes `--json` and never prompts, so a coding agent can drive the whole lab; see [docs/agents.md](docs/agents.md).

Exit codes: `0` every run completed, `1` the batch ran but some run did not complete or was cancelled, `2` invalid invocation or configuration, or a refusal such as a batch over its dollar ceiling (JSON errors carry a stable `code`). `cohort compare` exits `1` only for a confirmed regression; `cohort publish` exits `1` when the GitHub API fails.

Each run writes `.cohort/runs/<run-id>/`: `trace.zip`, `screenshots/`, `steps.jsonl`, `replay.spec.ts`, `resolved-config.json`, `report.{json,md,html}`, and `manifest.json` last. Each batch writes a summary report beside them that groups measured friction across runs and lists agent opinions separately.

## Documentation

- [Operating the lab](docs/operating.md): keys, models, costs and limits, blockers, replay bindings, base/head comparison, artifacts, retention and deletion, diagnostics.
- [Driving cohort from an agent](docs/agents.md): command map, JSON output, error codes, cost safety, background runs, and an AGENTS.md snippet.
- [Agent session](docs/agent-session.md): a real coding agent's CLI workflow, friction, and interrupted fixture run.
- [Personas and suites](docs/personas.md): formats, templates, prompt layers, generator guidance.
- [Setup modules and saved login](docs/setup-and-login.md): custom tools for one-time codes, storage state, routes, blocker detection.
- [GitHub Action](docs/github-action.md): the thin Action, a workflow that never uploads traces, and a pull-request comparison workflow.
- [Compatibility](docs/compatibility.md): exact runtime, browser, and provider status, and what is unsupported.
- [Security review notes](docs/security.md): the threat model, its controls, and what remains.
- [Release-candidate checklist](docs/release-checklist.md): what is automated and what is still manual.
- [Report examples](docs/report-examples/) for every outcome, generated from the fixture.

## Evidence warning

> [!WARNING]
> `trace.zip` files are native Playwright traces with unmasked DOM snapshots and typed values; they contain secrets. Keep `.cohort/runs` and `.cohort/auth` private: never publish, commit, or upload them. Screenshots sent to models are masked for known secrets and scripts use `{{placeholder}}` bindings, but reports and screenshots can still show sensitive app content. Use test accounts and synthetic data.

## Roadmap

The MVP ends with screening by outside developers. Add-ons follow in this order, each only after the previous one is useful:

1. Crawler and suggestions: `cohort explore` proposes personas, goals, and replayable tests from observed paths ([docs/explore.md](docs/explore.md)), also from the dashboard's New run dialog with a review page per run.
2. PR regression: `cohort compare` replays a hash-pinned approved run on base and head with provenance, verified scoped resets, and confirmation, and `cohort publish` posts one comment after rechecking the PR head ([docs/compare.md](docs/compare.md)). Still to come: validation on real apps and previews.
3. CLI-subscription backend: drive the same tools from a local Codex or Claude Code session, only once the providers' terms permit it.

An agent-operable CLI is available: every dashboard action has a `--json` command, runs can be detached and waited on, and batches are capped at $10 by default ([docs/agents.md](docs/agents.md)). A [recorded agent session](docs/agent-session.md) reached launch and cleanup; a completed live-provider journey remains unverified.

Keyboard-only personas and small-screen packs are available; see [docs/personas.md](docs/personas.md#scenario-packs).

## Development

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run verify          # typecheck, lint, format check, tests, unused-code check
bun run build           # dist/ and the dashboard in dist/ui
bun run smoke:package   # npm-installed tarball, no Bun on PATH
```

Bun is for development only; the published package runs on Node. Tests use a scripted fake model and never call a provider. Background: [competitive research](docs/COMPETITIVE-INTELLIGENCE.md), [original idea](docs/original-idea.md).

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
