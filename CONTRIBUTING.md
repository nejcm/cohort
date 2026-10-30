# Contributing

Requires Node 24.2.0+ and [Bun](https://bun.sh) (development only; the published package does not need it).

```sh
bun install --frozen-lockfile
bun run verify
```

`verify` runs typecheck, lint, format check, tests, and knip. Run it before opening a PR.

- Keep the runtime dependencies to Playwright and the YAML parser; use Node built-ins first.
- Nothing shipped may be specific to one target app.
- Tests use a scripted fake model. Never call live LLM providers in CI or default tests.
- Secrets must never reach prompts, transcripts, screenshots, generated scripts, logs, or API responses.
- Do not commit `.env`, `.cohort/auth`, `.cohort/runs`, or real user data.
- Add or update tests for behavior changes and keep docs accurate.

See [AGENTS.md](AGENTS.md) for the full command table and constraints, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.
