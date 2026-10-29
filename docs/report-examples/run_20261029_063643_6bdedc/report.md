# Run run_20261029_063643_6bdedc

> trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.

> Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport, except that keyboard-input personas are also told the focused element's role and name, even when it is off screen. A completed outcome is an agent declaration unless marked harness_verified; it is not an automatic end-to-end assertion.

| Field | Value |
| --- | --- |
| Run | run_20261029_063643_6bdedc |
| Batch | batch_20261029_063643_8436f4 |
| Persona | guest |
| Goal | Request a stay. |
| Outcome | blocked: oauth (agent-declared, unverified) |
| Reason | Login provider. |
| Mode | vision |
| Model | openai/example-model (returned: fake-model) |
| Effort | low |
| Catalog | phase-0-unverified+example sha256:757955d685a1d7aaba4b5fbf8000ac0a3bc67fcfa0aaa83c47c9b94f4f5770dc; untested: no |
| Started | 2026-10-29T06:36:43.767Z |
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
| s0000 | navigate {"url":"http://127.0.0.1:34109/lab/oauth"} | ok | http://127.0.0.1:34109/lab/oauth | [shot-0000](screenshots/shot-0000.png) |
| s0001 | report_blocked {"kind":"oauth","reason":"Login provider.","step":"s0000"} | ok | http://127.0.0.1:34109/lab/oauth | none |

## Issues

None.
