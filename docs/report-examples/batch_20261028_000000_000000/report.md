# Batch batch_20261028_000000_000000

> trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.

> Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport, except that keyboard-input personas are also told the focused element's role and name, even when it is off screen.

> Blocked runs and user cancellations are excluded from the completion denominator; agent-declared blocks are unverified. Agent errors and limits count as non-completions but are not UX failures.

Total cost: $0.0084. Runs not started: 0.

## guest · openai/example-model · low

| Field | Value |
| --- | --- |
| Comparison | guest: openai/example-model effort low, vision |
| Goal | Request a stay. |
| Catalog | sha256:63af94944a90e243cd441c8393abc7c768e021c23d2d89ec2891300d5e8b19f7; untested: no |
| Completion rate | 25% (1/4) |
| Blocked by kind | oauth 1 |
| Blocked by detector | agent 1 |
| User cancellations | 1 |
| Agent errors | browser_error 1 |
| Limits reached | steps 1 |
| Abandoned | 1 |
| Cost | $0.0084 |

| Run | Outcome | Cost |
| --- | --- | --- |
| [run_20261029_144719_393178](../run_20261029_144719_393178/report.md) | completed (agent_reported) | $0.0012 |
| [run_20261029_144720_c7d2e7](../run_20261029_144720_c7d2e7/report.md) | abandoned by the agent | $0.0012 |
| [run_20261029_144720_1b4cfa](../run_20261029_144720_1b4cfa/report.md) | blocked: oauth (agent-declared, unverified) | $0.0012 |
| [run_20261029_144721_30b83c](../run_20261029_144721_30b83c/report.md) | limit reached: steps (4 of 4; not a UX failure) | $0.0048 |
| [run_20261029_144723_2e20cc](../run_20261029_144723_2e20cc/report.md) | cancelled by user (not an agent or UX failure) | $0.0000 (+$0.0103 unsettled) |
| [run_20261029_144723_f51ffc](../run_20261029_144723_f51ffc/report.md) | agent error: browser_error (not a UX failure) | $0.0000 |
