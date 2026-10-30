# Batch batch_20261028_000000_000000

> trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.

> Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport, except that keyboard-input personas are also told the focused element's role and name, even when it is off screen.

> Blocked runs and user cancellations are excluded from the completion denominator; agent-declared blocks are unverified. Agent errors and limits count as non-completions but are not UX failures.

> Measured friction is grouped across a comparison's runs by kind plus page and the step's resolved target, focused element, or error text; anything uncertain stays separate. Agent opinions are listed one by one and never grouped or counted as recurring.

Total cost: $0.0084. Runs not started: 0.

## guest · openai/example-model · low

| Field | Value |
| --- | --- |
| Comparison | guest: openai/example-model effort low, vision |
| Goal | Request a stay. |
| Catalog | sha256:fdd5495416fe73cc7131e3483270787d14eed9c3dd0f19fea81bebb9c9468717; untested: no |
| Completion rate | 25% (1/4) |
| Blocked by kind | oauth 1 |
| Blocked by detector | agent 1 |
| User cancellations | 1 |
| Agent errors | browser_error 1 |
| Limits reached | steps 1 |
| Abandoned | 1 |
| Cost | $0.0084 |

### Friction across runs

| Claim | Seen in | Evidence |
| --- | --- | --- |
| **Harness: repeated action** The same wait was performed 2 times within 5 browser actions. | 1 of 6 runs | [run_20261030_064256_f79341 s0001](../run_20261030_064256_f79341/screenshots/shot-0001.png), [run_20261030_064256_f79341 s0003](../run_20261030_064256_f79341/screenshots/shot-0003.png) |
| **Harness: repeated action** The same scroll was performed 2 times within 5 browser actions. | 1 of 6 runs | [run_20261030_064256_f79341 s0002](../run_20261030_064256_f79341/screenshots/shot-0002.png), [run_20261030_064256_f79341 s0004](../run_20261030_064256_f79341/screenshots/shot-0004.png) |

| Run | Outcome | Cost |
| --- | --- | --- |
| [run_20261030_064255_248dc1](../run_20261030_064255_248dc1/report.md) | completed (agent_reported) | $0.0012 |
| [run_20261030_064255_3cc6ad](../run_20261030_064255_3cc6ad/report.md) | abandoned by the agent | $0.0012 |
| [run_20261030_064256_b5604d](../run_20261030_064256_b5604d/report.md) | blocked: oauth (agent-declared, unverified) | $0.0012 |
| [run_20261030_064256_f79341](../run_20261030_064256_f79341/report.md) | limit reached: steps (4 of 4; not a UX failure) | $0.0048 |
| [run_20261030_064258_7166a6](../run_20261030_064258_7166a6/report.md) | cancelled by user (not an agent or UX failure) | $0.0000 (+$0.0103 unsettled) |
| [run_20261030_064259_16e1bd](../run_20261030_064259_16e1bd/report.md) | agent error: browser_error (not a UX failure) | $0.0000 |
