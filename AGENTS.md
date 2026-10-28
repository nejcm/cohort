# Agent instructions

Open-source, self-hosted CLI and local dashboard where AI synthetic users operate a web app like real users (vision by default) and leave an inspectable Playwright trail plus a replayable script. TypeScript on Node 24.2.0+, Bun for development only, bring-your-own LLM keys.

## Constraints

- Nothing shipped may be specific to any one target app. Staywise (`/home/nejc/Work/staywise`) is the owner's external test target only; keep its notes in the PLAN.md appendix.
- Secrets never reach prompts, LLM transcripts, screenshots, generated scripts, logs, or API responses. Native traces are private evidence that may contain secrets; never publish or commit them. Keys come from the environment only.
- Runtime stays Node 24; the published package is compiled JavaScript and must not need Bun. Use Node built-ins first (HTTP, fs, hashing, `parseArgs`, `node:test`, `node:sqlite`).
- Runtime dependencies are Playwright and a maintained YAML parser only; no provider SDKs. Add a dependency only for a concrete need.
- Keep runtime dependencies small; follow the existing package manager, formatter, linter, and test runner.
- Never commit secrets, local environment files, `.lab/auth`, `.lab/runs`, or real user data.

## Commands

| Purpose | Command |
| --- | --- |
| Install | `bun install --frozen-lockfile` |
| Format | `bun run format` |
| Format check | `bun run format:check` |
| Lint | `bun run lint` |
| Typecheck | `bun run typecheck` |
| Test | `bun run test` |
| Unused code | `bun run knip` |
| Build | `bun run build` |
| Verify | `bun run verify` |

TypeScript uses `NodeNext` with explicit `.ts` relative imports (rewritten on build), not the baseline's `Bundler` resolution, because the output runs directly on Node.

## Change workflow

- Trace the relevant code path and callers before editing shared behavior.
- Add or update tests for behavior changes and keep PLAN.md and docs accurate.
- Run the narrowest relevant checks, then `bun run verify` when practical.
- Do not weaken checks to make a change pass; record intentional exceptions beside the config and here.
  - knip `ignoreDependencies: ["@playwright/test"]`: no source imports it; tests run generated replay specs through its CLI.
- Do not call live LLM providers in CI or default tests; use a scripted fake model.
