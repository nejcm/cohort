---
name: cohort
description: Use when working with the cohort CLI, where AI synthetic users operate a web app and leave an inspectable Playwright trail. Covers setting up a project, creating personas and suites, pricing and running batches, reading reports, replaying and comparing runs. Triggers on "cohort", ".cohort/", synthetic users, persona runs.
---

# Working with the cohort CLI

`cohort help` prints every command; `cohort help <command>` prints one. Full agent contract: `docs/agents.md`.

## Invocation

Examples use `cohort` as the prefix. With an installed package, use `npx --no-install cohort ...` for a project-local install, or `cohort ...` if on `PATH`. From an uninstalled checkout, run `bun install --frozen-lockfile`, then `node src/cli.ts ...` from its root; no build is needed. To operate on another project, use `node /absolute/path/to/cohort/src/cli.ts ...` with that project as the working directory. `.cohort/` belongs to the working directory.

Keys must already be in the environment. Node can load a person-provided environment file with `node --env-file=/path/to/file /absolute/path/to/cohort/src/cli.ts ...`; never print it.

## Rules

- Always pass `--json`. One JSON document on stdout, errors included (`{"error", "code"}`); nothing prompts.
- Exit `0` success, `1` ran but result is not a success (run incomplete, provider failure, wait timeout), `2` refused, nothing ran. Branch on `code`, not on the message.
- `run` spends real money. Run `cohort estimate <selector> --json` first and read `refusal`. Never raise `--max-usd` or pass `--allow-unpriced` unless the user said to.
- Provider keys come from the environment only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Never put a key in an argument, persona, suite or file. Never print or commit `.cohort/runs`, `.cohort/auth` or `trace.zip`.
- Do not wire a `setup:` module into a persona yourself; setup modules run as code and are a person's edit.

## Workflow

1. `cohort init --json` then `cohort doctor --json` (exit 2 means fix the listed errors first). Init's config defaults to **3 repeats**; pass `--repeats 1` to both `estimate` and `run` for one run.
2. Personas are Markdown with YAML frontmatter between `---` delimiters and a nonempty description body. `persona schema --json` describes only the frontmatter; JSON alone is not valid input to `persona add`. Start from a `source` returned by `persona templates --json`, then `persona add --file <f>` (`-` reads stdin), `persona validate`. Suites are YAML. Edits take `--revision <sha256>` from the last `show` so concurrent edits conflict instead of overwriting. Deleting needs `--yes`.
3. Selector for `estimate` and `run`: `--persona <id>`, `--tag <tag>`, `--suite <id>`, or `--url <url> --note <text>`. Estimate first, check `refusal`, and use the same selector, repeat count, and budget flags for the run.
4. `cohort run <selector> --repeats 1 --detach --json` returns `batchId` and `runIds`; then `cohort runs wait <id> --json` (`timeout` code 1 means wait again), or `runs show|cancel`. Sandboxes may kill detached descendants when a command ends; use foreground `run` with a tool that keeps the command alive there.
5. Read results from `runs show --json` (`report`, `dir`, `artifacts`, `screenshots`) or `cohort report <id> --format json|md|html`. In a batch report, `groups[].friction.measured` holds harness claims with the runs that hit them; `friction.opinions` are unverified.
6. No persona yet: `cohort explore --url <url>`, then `explore suggest <run-id>` and `explore save <run-id> --persona <id> --yes`.
7. Regression checks: `cohort replay <run-id>` (no model), `cohort compare` between two deployments, `cohort publish` posts the comment (needs `GITHUB_TOKEN`).

## Pitfalls

- A person must act for `login` (headed browser) and `blocked` errors; relay the `command` field instead of trying to work around it.
- Run IDs look like `run_YYYYMMDD_HHMMSS_xxxxxx`; batches are `batch_…`. Other strings are `not_found`.
- A run directory without `manifest.json` is unfinished or killed, not complete.
