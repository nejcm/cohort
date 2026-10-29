---
name: cohort
description: Use when working with the cohort CLI, where AI synthetic users operate a web app and leave an inspectable Playwright trail. Covers setting up a project, creating personas and suites, pricing and running batches, reading reports, replaying and comparing runs. Triggers on "cohort", ".cohort/", synthetic users, persona runs.
---

# Working with the cohort CLI

`cohort help` prints every command; `cohort help <command>` prints one. Full agent contract: `docs/agents.md`.

## Rules

- Always pass `--json`. One JSON document on stdout, errors included (`{"error", "code"}`); nothing prompts.
- Exit `0` success, `1` ran but result is not a success (run incomplete, provider failure, wait timeout), `2` refused, nothing ran. Branch on `code`, not on the message.
- `run` spends real money. Run `cohort estimate <selector> --json` first and read `refusal`. Never raise `--max-usd` or pass `--allow-unpriced` unless the user said to.
- Provider keys come from the environment only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Never put a key in an argument, persona, suite or file. Never print or commit `.cohort/runs`, `.cohort/auth` or `trace.zip`.
- Do not wire a `setup:` module into a persona yourself; setup modules run as code and are a person's edit.

## Workflow

1. `cohort init` then `cohort doctor --json` (exit 2 means fix the listed errors first).
2. Personas and suites are files edited through the CLI: `persona schema|templates|list`, then `persona add --file <f>` (`-` reads stdin), `persona validate`. Edits take `--revision <sha256>` from the last `show` so concurrent edits conflict instead of overwriting. Deleting needs `--yes`.
3. Selector for `estimate` and `run`: `--persona <id>`, `--tag <tag>`, `--suite <id>`, or `--url <url> --note <text>`.
4. `cohort run <selector> --detach --json` returns `batchId` and `runIds`; then `cohort runs wait <id> --json` (`timeout` code 1 means wait again), or `runs show|cancel`.
5. Read results from `runs show --json` (`report`, `dir`, `artifacts`, `screenshots`) or `cohort report <id> --format json|md|html`.
6. No persona yet: `cohort explore --url <url>`, then `explore suggest <run-id>` and `explore save <run-id> --persona <id> --yes`.
7. Regression checks: `cohort replay <run-id>` (no model), `cohort compare` between two deployments, `cohort publish` posts the comment (needs `GITHUB_TOKEN`).

## Pitfalls

- A person must act for `login` (headed browser) and `blocked` errors; relay the `command` field instead of trying to work around it.
- Run IDs look like `run_YYYYMMDD_HHMMSS_xxxxxx`; batches are `batch_…`. Other strings are `not_found`.
- A run directory without `manifest.json` is unfinished or killed, not complete.
