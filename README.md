# Synthetic Customer Lab

> Working title. Pre-alpha: `lab run` works offline against a scripted fake model; no shipped model is enabled yet.

AI synthetic users that operate your web app like real people. You give a persona a goal, the agent drives a real browser from screenshots, and every action is recorded as an inspectable Playwright trail plus a replayable script. Open source, self-hosted, bring your own LLM keys.

## Status

Implementation follows [PLAN.md](.plans/PLAN.md). Phases 0–3 and the Phase 4 dashboard API are tested against a scripted fake model. They cover the fixture app, both `fetch` provider adapters, the catalog, config/persona/suite resolution, target resolution, masking, caps, cancellation, loop detection, `lab run`, run bundles with manifests and reports, friction claims, `lab replay`/`lab report`/`lab trace`, persona validation and generation, and the `lab ui` HTTP/SSE API. Live provider checks are still open. Verified behavior and unsupported cases: [compatibility notes](docs/compatibility.md). Background: [competitive research](docs/COMPETITIVE-INTELLIGENCE.md) and the [original idea](docs/original-idea.md).

## Prerequisites

- Node.js 24.2.0+ (see `.node-version`)
- [Bun](https://bun.sh) for development only; the published package does not need it

## Setup

```sh
bun install --frozen-lockfile
bunx playwright install chromium
cp .env.example .env.local   # add the provider keys you want; never commit real values
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run verify` | typecheck, lint, format check, tests, unused-code check |
| `bun run build` | compile to `dist/` |
| `bun run test` | unit and Chromium integration tests (`node --test`, fake model, no network to providers) |

## Running

The shipped catalog has no enabled model yet. Add a verified entry to `.lab/models.yml` (see PLAN §5), then:

```sh
lab run --persona <id>            # one persona and its goal
lab run --tag <tag>               # personas with a tag, in ID order
lab run --suite <id>              # ordered suite entries
lab run --url <url> --note <goal> # ad-hoc first-time user
```

Each run writes `.lab/runs/<run-id>/`. The run directory holds:

- `trace.zip`, `steps.jsonl`, `screenshots/`, and `replay.spec.ts`;
- `resolved-config.json` and `report.json` (canonical), with `report.md` and `report.html` rendered from it;
- `manifest.json`, written last and atomically, which inventories every other file.

Each batch writes a summary to `.lab/runs/<batch-id>/report.{json,md,html}`. It gives completion rate with numerator and denominator, blocked runs by kind and detector, user cancellations, agent errors, limits, and costs.

```sh
lab report <run-or-batch-id> [--format json|md|html]  # print or re-render a report
lab replay <run-id>   # rerun replay.spec.ts with no model; needs @playwright/test in the project
lab trace <run-id>    # open trace.zip locally with playwright show-trace
```

```sh
lab persona validate                                   # check every persona and suite, reporting all problems
lab persona generate --url <url> --description <text>  # one metered call over the landing page; prints a preview
lab persona generate ... --out .lab/personas/<id>.md   # save only when asked; never overwrites
```

How to write personas and suites, how prompt layers combine, and the generator guidance: [docs/personas.md](docs/personas.md). Three editable examples are in `examples/personas/`.

`lab replay` prepares bindings in this order:

1. If the run used a setup module, it runs that module again.
2. Otherwise it uses `LAB_START_URL` from the environment.
3. Failing that, it uses the recorded start URL, but only when that URL was not reduced to origin and path.

The result is recorded as `passed` or `failed` in the run report.

Overrides: `--mode`, `--model <provider>/<id>`, `--effort`, `--repeats`, `--steps`, `--time-ms`, `--dollars`, `--url`, `--note`. Untested catalog entries need `--allow-untested`. `--json` prints one JSON result. Exit codes: `0` all runs completed, `1` any other outcome or cancellation, `2` invalid invocation or configuration.

### Dashboard

```sh
lab ui [--port <n>]           # loopback only; prints http://127.0.0.1:<port>/#token=...
lab ui --host <address>       # explicit exposure; prints a warning first
```

The dashboard API is complete: run queue, cancel, live events over SSE, artifact downloads, and revision-checked persona and suite editing. The browser screens are not built yet, so the page answers 503 until they ship. Every API call needs the per-launch token as `Authorization: Bearer`. Requests with a foreign `Host` or `Origin` are refused. Setup references in personas and suites are read-only through the API. Runs are indexed in `.lab/index.sqlite` (gitignored). A restart marks unfinished runs `interrupted` and never resumes them.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables OpenAI models in the model picker |
| `ANTHROPIC_API_KEY` | Enables Anthropic models in the model picker |

## Evidence warning

Run directories (`.lab/runs`) hold native Playwright traces, which record unmasked DOM snapshots and may contain secrets. Keep them private; never publish or commit them. Screenshots sent to models, `steps.jsonl`, and generated replay scripts are masked or use `{{placeholder}}` bindings. Reports and screenshots may still show sensitive content; treat every artifact as sensitive until reviewed.

## License

Apache-2.0, see [LICENSE](LICENSE).
