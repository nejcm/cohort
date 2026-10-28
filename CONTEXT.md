# Project context

Terms with a specific meaning in this project.

| Term            | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Persona         | A Markdown file with YAML frontmatter describing who the synthetic user is, their device, locale, and limits.                        |
| Goal            | What the persona tries to accomplish, given on the persona or a suite entry.                                                         |
| Suite           | A named, ordered list of persona/goal entries with shared defaults, stored as a file in the repo.                                    |
| Run             | One agent attempt at a goal; each persona/goal runs 3 times by default with the same resolved model and effort.                      |
| Trail           | The Playwright `trace.zip`, step records, screenshots, and generated replayable script left by a run.                                |
| Perception mode | `vision` (screenshots only, default) or `text` (accessibility snapshot, cheaper, can overstate usability).                           |
| Friction claim  | A finding that cites step IDs and screenshots, either measured by the harness or reported by the agent.                              |
| Outcome         | The classification of a run: completed, abandoned, blocked (with a kind), agent_error, limit_reached, or interrupted.                |
| Blocked         | The run hit an external dependency it cannot pass (email code, CAPTCHA, OAuth, payment, third party); excluded from completion rate. |
| Setup module    | Trusted user TypeScript that prepares a run (start URL, saved state, secrets) and can add custom agent tools.                        |
| Model catalog   | The shipped, overridable list of models with vision capability, effort levels, and prices.                                           |

## Important boundaries

- The tool is target-agnostic; Staywise is only an external test target.
- Deterministic harness data (not the LLM) decides measured friction; agent-reported friction is shown as opinion.
