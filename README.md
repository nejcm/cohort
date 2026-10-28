# Synthetic Customer Lab

> Working title. Pre-alpha: only the CLI skeleton exists.

AI synthetic users that operate your web app like real people. You give a persona a goal, the agent drives a real browser from screenshots, and every action is recorded as an inspectable Playwright trail plus a replayable script. Open source, self-hosted, bring your own LLM keys.

## Status

Planning is done; implementation follows [PLAN.md](.plans/PLAN.md), starting with Phase 0 (agent, replay, cost, and secret-boundary spikes). Background: [competitive research](docs/COMPETITIVE-INTELLIGENCE.md) and the [original idea](docs/original-idea.md).

## Prerequisites

- Node.js 24.2.0+ (see `.node-version`)
- [Bun](https://bun.sh) for development only; the published package does not need it

## Setup

```sh
bun install --frozen-lockfile
cp .env.example .env.local   # add the provider keys you want; never commit real values
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run verify` | typecheck, lint, format check, tests, unused-code check |
| `bun run build` | compile to `dist/` |
| `bun run test` | unit tests (`node --test`) |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables OpenAI models in the model picker |
| `ANTHROPIC_API_KEY` | Enables Anthropic models in the model picker |

## License

Apache-2.0, see [LICENSE](LICENSE).
