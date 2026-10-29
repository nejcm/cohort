# cohort.

> Working title. Release candidate `0.1.0-rc.0`: tested offline against a scripted model; no shipped model is enabled until live verification.

AI synthetic users that operate your web app like real people. You give a persona a goal; an agent drives a real Chromium browser from screenshots, the way a first-time user would, and every action is recorded as an inspectable Playwright trail plus a replayable script. Reports separate what the harness measured from what the agent thought, and every claim cites screenshot evidence.

- Local-first: a CLI and a local dashboard. No hosted service, accounts, or telemetry.
- Bring your own LLM key (OpenAI or Anthropic). Keys stay in your environment.
- Honest outcomes: `completed`, `abandoned`, `blocked(kind)`, `agent_error(code)`, or `limit_reached(limit)`. An agent failure is never reported as a UX failure.
- Bounded spend: step, time, and dollar caps, with "cost unknown" stated when prices are missing.

What it is not: an accessibility audit, a substitute for user research, a load tester, or a CAPTCHA or payment bot. Synthetic behaviour is not validated against real people.

## Quick start

Requires Node.js 24.2.0 or later and npm.

```sh
npm install --save-dev cohort-lab   # not yet published; see docs/release-checklist.md
npx playwright install chromium
npx cohort init      # .cohort/ with config, three example personas, and a .gitignore for private evidence
npx cohort doctor    # runtime, browser, config, model, keys, paths; never calls a model
```

`cohort doctor` reports that the default model is disabled: no model has been verified live yet. Add a model you have checked to `.cohort/models.yml` ([how](docs/operating.md#models)) and set its key, for example `export ANTHROPIC_API_KEY=...`.

Try it on the bundled fixture app (from a clone of this repository; it needs only Node):

```sh
node tests/fixtures/friction-app/server.ts --port 4173        # add --mutation hidden_primary etc. for seeded friction
npx cohort run --persona first-time-host --url http://127.0.0.1:4173/ --repeats 1
open .cohort/runs/<batch-id>/report.html                    # the run prints its report path
```

## Commands

| Command | Purpose |
| --- | --- |
| `cohort init [--template <id>]...` | Create `.cohort/` without overwriting anything; `--template` adds the named [persona templates](docs/personas.md#templates) instead of the default three |
| `cohort doctor [--json]` | Check the setup; exit 2 on any error |
| `cohort run --persona <id> \| --tag <tag> \| --suite <id> \| --url <url> --note <goal>` | Run a batch. Options: `--mode`, `--model <provider>/<id>`, `--effort`, `--repeats`, `--steps`, `--time-ms`, `--dollars`, `--allow-untested`, `--json` |
| `cohort report <run-or-batch-id> [--format json\|md\|html]` | Print or re-render a report |
| `cohort replay <run-id>` | Rerun `replay.spec.ts` with no model; needs `@playwright/test` in the project |
| `cohort compare <run-id> --base <origin> --head <origin> [--json] [--markdown <file>]` | Replay an approved run on two deployments with confirmation; writes one advisory PR comment body ([details](docs/operating.md#comparing-base-and-head)) |
| `cohort trace <run-id>` | Open the private trace locally with `playwright show-trace` |
| `cohort login --url <url> --state <name>` | Log in by hand in a headed browser; saves `.cohort/auth/<name>.json` |
| `cohort persona validate` | Check every persona and suite, reporting all problems |
| `cohort persona generate --url <url> --description <text> [--out <file>]` | One metered call over a landing page; preview unless `--out` |
| `cohort ui [--port <n>] [--host <address>]` | Authenticated local dashboard on `127.0.0.1` |

Exit codes: `0` every run completed, `1` the batch ran but some run did not complete or was cancelled, `2` invalid invocation or configuration. `cohort compare` exits `1` only for a confirmed regression.

Each run writes `.cohort/runs/<run-id>/`: `trace.zip`, `screenshots/`, `steps.jsonl`, `replay.spec.ts`, `resolved-config.json`, `report.{json,md,html}`, and `manifest.json` last. Each batch writes a summary report beside them.

## Documentation

- [Operating the lab](docs/operating.md): keys, models, costs and limits, blockers, replay bindings, base/head comparison, artifacts, retention and deletion, diagnostics.
- [Personas and suites](docs/personas.md): formats, templates, prompt layers, generator guidance.
- [Setup modules and saved login](docs/setup-and-login.md): custom tools for one-time codes, storage state, routes, blocker detection.
- [GitHub Action](docs/github-action.md): the thin Action, a workflow that never uploads traces, and a pull-request comparison workflow.
- [Compatibility](docs/compatibility.md): exact runtime, browser, and provider status, and what is unsupported.
- [Security review notes](docs/security.md): the threat model, its controls, and what remains.
- [Release-candidate checklist](docs/release-checklist.md): what is automated and what is still manual.
- [Report examples](docs/report-examples/) for every outcome, generated from the fixture.

## Evidence warning

`trace.zip` files are native Playwright traces with unmasked DOM snapshots and typed values; they contain secrets. Keep `.cohort/runs` and `.cohort/auth` private: never publish, commit, or upload them. Screenshots sent to models are masked for known secrets and scripts use `{{placeholder}}` bindings, but reports and screenshots can still show sensitive app content. Use test accounts and synthetic data.

## Roadmap

The MVP ends with screening by outside developers. Add-ons follow in this order, each only after the previous one is useful:

1. Crawler and suggestions: an `explore` mode that proposes personas and replayable tests from observed paths.
2. PR regression hardening: `cohort compare` and the Action's `compare-run` already replay an approved run on base and head with confirmation and one advisory comment. Still to come: approved assertions, per-artifact hashes for downloaded bundles, preview provenance, scoped preparation and cleanup, a separate comment publisher, and a PR-head recheck before posting.
3. CLI-subscription backend: drive the same tools from a local Codex or Claude Code session, only once the providers' terms permit it.

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
