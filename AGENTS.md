# Agent instructions

Open-source, self-hosted CLI and local dashboard where AI synthetic users operate a web app like real users (vision by default) and leave an inspectable Playwright trail plus a replayable script. TypeScript on Node 24.2.0+, Bun for development only, bring-your-own LLM keys.

## Constraints

- Nothing shipped may be specific to any one target app. The owner's own test targets are external; keep notes about them out of this repository.
- Secrets never reach prompts, LLM transcripts, screenshots, generated scripts, logs, or API responses. Native traces are private evidence that may contain secrets; never publish or commit them. Keys come from the environment only.
- Runtime stays Node 24; the published package is compiled JavaScript and must not need Bun. Use Node built-ins first (HTTP, fs, hashing, `parseArgs`, `node:test`, `node:sqlite`).
- Runtime dependencies are Playwright and a maintained YAML parser only; no provider SDKs. Add a dependency only for a concrete need.
- The dashboard (`ui/`) uses Svelte 5 and Vite as build-only dev dependencies; `bun run build` compiles it into `dist/ui`, which `cohort ui` serves under a strict CSP (no inline scripts or styles, no `style=` attributes or Svelte transitions).
- Keep runtime dependencies small; follow the existing package manager, formatter, linter, and test runner.
- Never commit secrets, local environment files, `.cohort/auth`, `.cohort/runs`, or real user data.

## Source layout

- `src/cli.ts` only parses arguments, maps errors to exit codes, and dispatches; each command group lives in `src/commands/` and shares `commands/context.ts` (`Context`, `Dependencies`, `CliError`, `emit`).
- `src/dashboard/` (server, queue, index) sits on top of `src/core/`; nothing under `core/` imports from `dashboard/`. Project-file editing (personas, suites, `config.yml`, `models.yml`) is `src/config/editable.ts`, shared by the CLI, the dashboard, and `core/explore`.
- Setup lifecycle and error scrubbing go through `src/setup/session.ts`; callers keep outcome mapping.
- oxlint's `import/no-cycle` guards the module graph; keep it that way instead of adding re-export shims.

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
| Seed local dashboard data (`.seed/`, then `cd .seed && node ../src/cli.ts ui`) | `bun run seed` |
| Package smoke (after build; needs npm registry access) | `bun run smoke:package` |

TypeScript uses `NodeNext` with explicit `.ts` relative imports (rewritten on build), not the baseline's `Bundler` resolution, because the output runs directly on Node.

## Change workflow

- Trace the relevant code path and callers before editing shared behavior.
- Add or update tests for behavior changes and keep docs accurate.
- Run the narrowest relevant checks, then `bun run verify` when practical.
- Do not weaken checks to make a change pass; record intentional exceptions beside the config and here.
  - `docs/report-examples/` is generated tool output (byte-exact bundles), so oxfmt and oxlint ignore it like `.cohort/runs`; regenerate with `node scripts/report-examples.ts`.
  - knip `ignoreDependencies: ["@playwright/test"]`: no source imports it; tests run generated replay specs through its CLI.
- Do not call live LLM providers in CI or default tests; use a scripted fake model.
