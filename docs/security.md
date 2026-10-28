# Security review notes

Release-candidate review of the implementation against its threat model, done offline with a scripted fake model on Linux, Node v26.8.2, Playwright 1.64.1. Each row names the control, where it lives, the test that holds it, and what remains. "Not verified" means no live provider, outside environment, or Node 24 run has checked it.

Scope and trust boundary: the lab is a local tool for trusted application targets with synthetic data. Setup modules are trusted local code with your process privileges. Browser interception is a guardrail, not a network sandbox. Remote or Docker hosting is unsupported.

| Threat | Control (code) | Held by (tests) | Remaining risk |
| --- | --- | --- | --- |
| Page prompt injection | Fixed system instructions; the model sees placeholders, never secret values; tools are schema-validated; navigation allowlist (`src/core/agent.ts`, `src/core/tools.ts`, `src/core/engine.ts`) | `agent.test.ts` injection page (`goto` to an exfiltration host is refused); persona generator injection (`persona.test.ts`) | The agent can still follow misleading in-scope instructions |
| Secret leakage to provider | Fill-only substitution, masked capture with change tracking, outbound text scan that fails closed (`src/browser/observations.ts`, `src/setup/secrets.ts`) | PNG pixel canaries and outbound scans in `agent.test.ts`, `run.test.ts`; `canary.test.ts` | Transformed, encoded, or canvas-rendered secrets; script-set `.value`, late or closed shadow roots ([compatibility.md](compatibility.md#secret-boundary)) |
| Secret leakage in artifacts | Redaction of reports, steps, replay, resolved config; owner-only modes; gitignore from `lab init`; trace warnings | `canary.test.ts` scans every file under `.lab` except `trace.zip` for setup secrets, an env-only value, and the provider key (plain and base64), checks 0700/0600 modes, and confirms the trace does hold the filled value | `trace.zip` holds secrets by design; screenshots can show sensitive app content |
| Wrong application or real side effects | Start-URL scheme/credential checks, explicit origins, no payment or CAPTCHA automation | `run.test.ts`, `agent.test.ts` navigation and blocker tests | The owner must point the lab at a safe environment |
| Navigation and request escape | Context route guard, CDP redirect-hop guard, response backstop, popups closed, service workers blocked (`src/core/engine.ts`) | Redirect, popup, frame, and route tests in `agent.test.ts`, `run.test.ts` | WebSockets and redirects inside out-of-process frames are not intercepted (backstop ends the run); not a network sandbox |
| Local API compromise | Random 256-bit token in a URL fragment, Host and Origin checks, JSON-only mutations, no CORS (`src/dashboard/server.ts`) | `dashboard.test.ts` (401/403/421, rebinding Host, cross-site fetch metadata) | Local malware can read the process or the token |
| Dashboard XSS | Escaped text, sanitized Markdown, strict CSP with no inline code, report HTML served sandboxed (`src/dashboard/server.ts`, `src/evidence/report.ts`) | `dashboard-ui.test.ts` (CSP violations fail the suite, persona names render as text), `report.test.ts` escaping | Browser or library vulnerabilities |
| Trusted setup abuse | `.lab/setup/` containment, symlink refusal, API rejects setup-reference edits, no model-authored modules (`src/config/files.ts`, `src/dashboard/files.ts`) | `config.test.ts` path and symlink tests, `dashboard.test.ts` setup-reference tests | Setup code runs with your privileges |
| Excessive spend | Dated catalog prices, reservations, step/time/dollar caps, explicit unknown-cost status (`src/core/cost.ts`, `src/core/estimate.ts`) | `core.test.ts`, `agent.test.ts` cap and reservation boundaries | Unpriced models: dollar cap unenforceable and stated so; an in-flight call can overshoot reported spend |
| Provider key disclosure | Keys read only by adapters; booleans across the API; scrubbed errors (`src/providers/types.ts`, `src/setup/run.ts`); unexpected-error output scrubbed (`src/cli.ts`) | `providers.test.ts` error paths, `dashboard.test.ts` canaries, `canary.test.ts` (CLI output, every artifact) | A provider error that echoes a masked key fragment is kept (up to 500 chars); the local process is trusted |
| Wrong model or comparison drift | Catalog validation, availability, vision and effort checks, frozen snapshot across repeats (`src/providers/catalog.ts`, `src/config/resolve.ts`) | `catalog.test.ts`, `config.test.ts`, `dashboard-ui.test.ts` pickers | Owner-edited rates and capabilities may be stale |
| Misleading UX claims | Exact outcome states, labelled opinions, evidence-required claims (`src/evidence/friction.ts`) | `report.test.ts`, `run.test.ts` | Synthetic behaviour is not validated against people |
| Replay injection | Fixed templates, structured locators, escaped literals (`src/evidence/replay.ts`) | `core.test.ts` locator literal and replay-generation cases | Trusted setup remains executable |
| Brittle replay | Stability labels, no healing, explicit replay status | `journey.test.ts`, `run.test.ts` replays | A recorded run does not guarantee future replay |
| Cross-run contamination | Fresh contexts, scoped setup, cleanup, no resume | `run.test.ts` repetition isolation | The application must support independent data |
| Artifact traversal or tampering | Generated IDs, plain-directory and regular-file checks, manifest IDs only (`src/evidence/bundle.ts`, `src/evidence/manifest.ts`) | `report.test.ts`, `dashboard.test.ts` traversal and symlink tests | No per-file hashes until Add-on 2; local files remain mutable |
| Provider retention | OpenAI requests set `store: false`; minimal payloads (latest image only) | Fake-server contract tests | Not verified live; retention is the provider's policy |
| Browser or dependency compromise | Exact-pinned runtime deps (Playwright, `yaml`), lockfile, Dependabot | CI `--frozen-lockfile` | No hostile-site security guarantee |
| Privileged PR execution | The Action takes no keys as inputs, never interpolates inputs into shell, and uploads nothing (`action.yml`, `action/run.ts`) | `action.test.ts` | Workflow authors must not run it on untrusted fork code with secrets ([github-action.md](github-action.md)) |
| Public remote exposure | Loopback default, explicit `--host` with a printed warning, token still required | `dashboard.test.ts` | Plain HTTP; remote hosting unsupported |

## Changes made in this review

- `trace.zip` is now chmod 0600 after writing, and `.lab/index.sqlite` is created 0600 before SQLite opens it (its WAL files inherit the mode). Before, both followed the umask, typically 0644, inside an 0700 directory.
- Unexpected CLI errors print one bounded line with provider keys scrubbed instead of a raw stack; `LAB_DEBUG=1` restores the stack.
- `lab init` writes `.lab/.gitignore`; `lab doctor` reports when `.lab/runs` or `.lab/auth` is not ignored and when `.lab/auth` is group- or world-readable.
- The build now starts from an empty `dist/`, so deleted modules cannot ship from a stale build.

## Not verified

- Provider wire formats, retention settings, and error bodies against live APIs.
- Node 24 locally (CI pins Node 24; local runs used Node v26.8.2).
- The Action on GitHub-hosted runners.
- Other browsers for the dashboard; Chromium only.
