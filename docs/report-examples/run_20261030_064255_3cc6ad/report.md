# Run run_20261030_064255_3cc6ad

> trace.zip is private raw evidence and may contain secrets (DOM snapshots, network traffic, URLs, browser state); never share or upload it. Screenshots and reports are redacted for registered secrets but may still show sensitive content. Treat every artifact as sensitive until reviewed.

> Vision mode: the agent saw only masked screenshots and acted by pixel coordinates, which the harness converted to locators. It cannot perceive hidden text, accessibility semantics, or content outside the viewport, except that keyboard-input personas are also told the focused element's role and name, even when it is off screen. A completed outcome is an agent declaration unless marked harness_verified; it is not an automatic end-to-end assertion.

| Field | Value |
| --- | --- |
| Run | run_20261030_064255_3cc6ad |
| Batch | batch_20261030_064255_e00d69 |
| Persona | guest |
| Goal | Request a stay. |
| Outcome | abandoned by the agent |
| Reason | The arrival times do not fit my trip. |
| Mode | vision |
| Model | openai/example-model (returned: fake-model) |
| Effort | low |
| Catalog | phase-0-unverified+example sha256:fdd5495416fe73cc7131e3483270787d14eed9c3dd0f19fea81bebb9c9468717; untested: no |
| Started | 2026-10-30T06:42:55.765Z |
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
| s0000 | navigate {"url":"http://127.0.0.1:34711/"} | ok | http://127.0.0.1:34711/ | [shot-0000](screenshots/shot-0000.png) |
| s0001 | give_up {"kind":"journey_abandoned","reason":"The arrival times do not fit my trip.","step":"s0000"} | ok | http://127.0.0.1:34711/ | none |

## Issues

None.
