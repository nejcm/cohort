# Run run_20261029_144719_393178

> trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.

> Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport, except that keyboard-input personas are also told the focused element's role and name, even when it is off screen. A completed outcome is an agent declaration unless marked harness_verified; it is not an automatic end-to-end assertion.

| Field | Value |
| --- | --- |
| Run | run_20261029_144719_393178 |
| Batch | batch_20261029_144719_24c0d0 |
| Persona | guest |
| Goal | Request a stay. |
| Outcome | completed (agent_reported) |
| Reason | The request form is reachable. |
| Mode | vision |
| Model | openai/example-model (returned: fake-model) |
| Effort | low |
| Catalog | phase-0-unverified+example sha256:63af94944a90e243cd441c8393abc7c768e021c23d2d89ec2891300d5e8b19f7; untested: no |
| Started | 2026-10-29T14:47:19.965Z |
| Duration | 0.2 s |
| Steps | 1 attempts, 0 browser actions |
| Cost | $0.0012 |
| Tokens | 1000 in, 50 out (estimated) |
| Replay | replay.spec.ts: not_attempted |

## Evidence

- s0000: [shot-0000](screenshots/shot-0000.png)

## Friction

No friction claims.

## Timeline

| Step | Action | Result | Page | Screenshot |
| --- | --- | --- | --- | --- |
| s0000 | navigate {"url":"http://127.0.0.1:43039/"} | ok | http://127.0.0.1:43039/ | [shot-0000](screenshots/shot-0000.png) |
| s0001 | done {"summary":"The request form is reachable.","step":"s0000"} | ok | http://127.0.0.1:43039/ | none |

## Issues

None.
