# Agent CLI session

- Date: 2026-10-30.
- Subject agent: Codex gpt-6.1-sol.
- Run model: `openai/gpt-6.1-terra`, low effort.
- Goal: add a persona, run it against the fixture, summarize friction, delete it.
- Entry point: only `docs/agents.md` initially; the subject followed its links to the skill and operating guide without reading source or tests.
- Run: `run_20261029_191855_adb1ae`, batch `batch_20261029_191855_2815ca`.
- Result: interrupted, zero recorded steps, no fixture UX findings. Actual cost unknown; the configured single-run cap was $0.85. No retry.

## Condensed transcript

CLI commands below use `node --env-file=.env src/cli.ts` as their prefix. The environment file was loaded without printing its contents. Persona input is described rather than reproduced; no secrets are included.

| Command or action | Outcome |
| --- | --- |
| `cat docs/agents.md`; `command -v cohort`; read the linked skill and operating sections | No installed `cohort` executable. The subject found the repository entry point in the supplied project instructions. |
| `help run --json`; `persona schema --json`; `models list --json` | Queried help, schema, and catalog without model calls. JSON help contained `[run options]` without enumerating those flags. |
| Attempt browser access to `http://127.0.0.1:4791` | Browser access host unavailable. No interface inspected. |
| `persona add --file - --json` with a JSON persona object | Exit 2: missing YAML frontmatter. No persona created. |
| `persona validate --json`; `estimate --persona agent-fixture-first-visit-20261030 --url http://127.0.0.1:4791 --max-usd 0.85 --allow-untested --json` | Validation found zero personas; estimate refused because project config was missing. |
| `init --json`; `persona templates --json` | Created config and three starter personas; retrieved complete Markdown templates. |
| `persona add --file - --json` with YAML frontmatter and a Markdown body; `persona validate --json` | Temporary persona created; all four personas valid. Persona selected the requested model and low effort, with caps of 16 steps, 180000 ms, and $0.85. |
| Repeat the estimate above | One plan had three repeats, maximum batch cost $2.55, and `refusal.code: over_budget`. Nothing started. |
| Repeat the estimate with `--repeats 1` | One repeat, maximum batch cost $0.85, `refusal: null`. |
| `run --persona agent-fixture-first-visit-20261030 --url http://127.0.0.1:4791 --repeats 1 --max-usd 0.85 --allow-untested --detach --json` | Exit 0; returned the batch and run IDs above. Exactly one run launched. |
| `runs wait batch_20261029_191855_2815ca --timeout-ms 45000 --json` | Exit 1, `done: true`; interrupted by process, zero steps, empty friction and opinions, `costUsd: null`. |
| `runs show run_20261029_191855_adb1ae --json` | Confirmed `agent_error` / `interrupted`, no screenshots, `returnedModel: null`, unknown usage and cost in the reconstructed report. |
| `persona remove agent-fixture-first-visit-20261030 --yes --json`; `persona list --json` | Temporary persona deleted and absence verified. The three init-created examples and config remained. |

The subject's raw log corrected two premature outcome descriptions: the first persona was rejected, and the initial priced plan was refused for three repeats. The outcomes above reflect those corrections.

## Friction and fixes

| Friction | Resolution |
| --- | --- |
| No CLI executable in an uninstalled checkout | `docs/agents.md` and `skills/cohort/SKILL.md` now distinguish installed-package invocation from `node src/cli.ts`, including working-directory behavior. |
| JSON help omitted run flags | Shared command metadata now includes the run options for JSON and text help. A CLI regression test checks all run flags in topic JSON, overview JSON, and text help. |
| Frontmatter schema looked like a complete JSON input format | Both guides now specify Markdown with YAML frontmatter and a nonempty body, explain the schema's scope, and point to `persona templates --json`. |
| Init defaults to three repeats | Both guides now call out the default, require estimating first, and show `--repeats 1` for a single run. |
| Detached owner disappeared before any recorded step | Detach code left unchanged: inspection found no parent-exit kill hook. The background-run docs now explain sandbox and supervisor cleanup limits. The original cause remains unconfirmed. |

## Detached-owner investigation

In [`src/commands/run.ts`](../src/commands/run.ts), `spawnWorker` starts a new process with `detached: true` and `stdio: ['pipe', 'pipe', 'ignore']`. It ends stdin after sending the batch, destroys stdout after receiving the ID handshake, and calls `child.unref()`. The worker writes that handshake once, then awaits the batch; it does not depend on the parent's continued presence or send ongoing progress over the closed pipe. No parent-exit handler kills the worker. `SIGINT` and `SIGTERM` abort the CLI's own controller.

In [`src/dashboard/runner.ts`](../src/dashboard/runner.ts), the worker records itself as batch owner. Recovery checks PID plus process start time on Linux and finalizes abandoned runs as interrupted; it never resumes them or calls a provider again. The recorded result is consistent with that recovery path, but cannot identify what killed the owner.

Sandbox cleanup of detached descendants when the launching command returned is the likely explanation, not a proven cause. A follow-up isolated subprocess check could not complete because this review environment returned `EPERM` for child-process pipes; a loopback-listener probe also returned `EPERM`. No live provider was called during this investigation, and no detach implementation change was justified by the available evidence.

## MCP verdict

**Not needed** — the agent drove the CLI successfully via `--json`: it created and validated a persona, priced the batch, launched it, inspected the interrupted result, and deleted the persona. The failures were documentation gaps and the detached-owner issue, not CLI usability. This session does not verify a completed live-provider journey or support fixture UX findings.
