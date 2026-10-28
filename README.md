# Synthetic Customer Lab

> Working title. Pre-alpha: `lab run` works offline against a scripted fake model; no shipped model is enabled yet.

AI synthetic users that operate your web app like real people. You give a persona a goal, the agent drives a real browser from screenshots, and every action is recorded as an inspectable Playwright trail plus a replayable script. Open source, self-hosted, bring your own LLM keys.

## Status

Implementation follows [PLAN.md](.plans/PLAN.md). Phases 0 and 1 (fixture app, both `fetch` provider adapters, catalog, config/persona/suite resolution, target resolution, masking, caps, cancellation, loop detection, replay, basic `lab run`) are tested against a scripted fake model; live provider checks are still open. Verified behavior and unsupported cases: [compatibility notes](docs/compatibility.md). Background: [competitive research](docs/COMPETITIVE-INTELLIGENCE.md) and the [original idea](docs/original-idea.md).

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

Overrides: `--mode`, `--model <provider>/<id>`, `--effort`, `--repeats`, `--steps`, `--time-ms`, `--dollars`, `--url`, `--note`. Untested catalog entries need `--allow-untested`. `--json` prints one JSON result. Exit codes: `0` all runs completed, `1` any other outcome or cancellation, `2` invalid invocation or configuration.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables OpenAI models in the model picker |
| `ANTHROPIC_API_KEY` | Enables Anthropic models in the model picker |

## Evidence warning

Run directories (`.lab/runs`) hold native Playwright traces, which record unmasked DOM snapshots and may contain secrets. Keep them private; never publish or commit them. Screenshots sent to models, `steps.jsonl`, and generated replay scripts are masked or use `{{placeholder}}` bindings.

## License

Apache-2.0, see [LICENSE](LICENSE).
