# Compatibility notes

Verified offline on Linux, Node v26.8.2, Playwright 1.64.1 headless Chromium, with a scripted fake model. Node 24 itself has not been run yet: CI pins it in `.node-version`, but the workflow has never run (no remote).

## Runtime, browser, and providers (release candidate 0.1.0-rc.0)

| Component | Supported | Verified |
| --- | --- | --- |
| Node.js | 24.2.0 or later (`engines`) | Local: v26.8.2 only. CI is configured to run every check and the package smoke test on Node 24 (`.node-version`); no Node 24 run has been observed, locally or in CI |
| Package manager for users | npm (no Bun) | `scripts/package-smoke.ts`: npm 12.2.1, Bun removed from `PATH` |
| Bun | Development only (`bun@1.4.4`) | Local |
| Playwright | 1.64.1, exact pin | Local |
| Browser | Chromium 156.0.8078.4 (Playwright revision 1248), headless, plus headed for `cohort login` | Headless local; the headed `cohort login` window is not exercised by tests |
| Operating system | Linux | Local Linux 7.2; macOS and Windows untested |
| OpenAI | Responses API through `fetch`, `reasoning.effort` | Fake HTTP server only; not live |
| Anthropic | Messages API through `fetch`, `output_config.effort` | Fake HTTP server only; not live |
| Shipped models | None enabled | The one catalog entry is a disabled candidate until live verification |
| Dashboard browsers | Chromium | Firefox and WebKit untested |

## Target resolution and replay

Each row passes `tests/integration/targets.test.ts`: the hit point resolves to a unique locator that is the same element, and clicking that locator replays the action.

| Target | Status |
| --- | --- |
| Light DOM elements (links, buttons, inputs, selects) | Supported |
| Nested open shadow roots | Supported |
| Same-origin iframe with border and padding | Supported |
| Open shadow root inside a frame | Supported |
| Cross-origin iframe (`127.0.0.1` page, `localhost` frame) | Supported. Out-of-process isolation is assumed from Chromium site isolation, not asserted. |
| Closed shadow root | Unsupported: `agent_error(unsupported_target)`, reason `closed_shadow_root` (heuristic: an empty custom element) |
| `<canvas>` | Unsupported: reason `canvas` |
| Frame inside a CSS-transformed ancestor | Unsupported: reason `transformed_frame` |

Screenshot points are scaled to CSS pixels from the captured image size; a point outside the image is rejected. Click positions are recorded relative to the target box, rounded to 0.5 px.

## Native browser UI

| Interaction | Behavior |
| --- | --- |
| `fill` on a `<select>` with a visible option label | `selectOption({ label })`; replays the same way |
| Click a `<select>`, then `press ArrowDown` / `Enter` | Changes the value in headless Chromium. Whether the open popup appears in the screenshot is not verified. |
| JavaScript dialogs | Dismissed; recorded as issue `dialog_dismissed` with redacted text. Dialog text is not given to the model. |
| File chooser | Cancelled; recorded as issue `file_chooser_cancelled`. Uploads are unsupported. |
| `type` text into the focused element | `keyboard.type`, offered in every mode. The element focused when typing starts, inside frames and open shadow roots, is recorded as `recipient` (a verified unique locator, skipping candidates that contain a secret, and re-checked as still focused once resolved); the replay waits for it to be focused, then calls `page.keyboard.type`. When only the page has focus, the replay types without waiting. When the focused element has no such locator, sits more than eight frames deep, or focus moved while it was resolved, the step is reported as unable to replay. Text containing a registered secret, as a `{{placeholder}}` or literally, is typed one character at a time and each receiving element (in a frame, the whole frame) is masked like a filled field, so auto-advancing code inputs stay masked. Focus that moves between the check and the first keystroke is not detected. |
| `input: keyboard` persona | `click`, `fill`, and `scroll` are not offered; a call to one is rejected as `invalid_tool` (`unknown tool`), and three identical ones in a row end as `agent_error(loop)`. Each observation adds `Focus: <role or tag> "<name>"` or `Focus: none`. |
| Focus and overflow evidence | Read after every after-screenshot, in every mode: the focused element of the main frame through open shadow roots (tag, role, name, and structural CSS path, all redacted for secrets, whether it is rendered inside the viewport, and the document's `performance.timeOrigin`, which tells documents at one URL apart) and `scrollWidth - clientWidth` of the document. Focus inside an iframe reads as the iframe. |
| Small screens | Viewport size and touch only, without a mobile user agent or device scaling, so screenshot points map 1:1 to CSS pixels. A page without a viewport meta tag is laid out at the persona's width instead of being shrunk like on a phone. |

Text perception mode is not implemented yet, so "both modes" is unverified.

## Secret boundary

- Before every capture, magenta (`rgb(255, 0, 255)`) overlays are drawn in every frame and open shadow root. They cover:
  - `maskSelectors` and `[data-cohort-masked]` fields;
  - elements whose value or rendered attribute (`placeholder`, `value`, `alt`, `title`, `aria-label`) contains a secret;
  - the deepest element whose text contains a whole secret, which also catches secrets split across spans. Both the element's boxes and its content boxes are covered, so text under `display: contents` is masked too.
- Tests decode the PNG and require every pixel of the rendered box to be masked for filled email and one-time-code fields, a DOM mirror, a fragment echo, split text, `display: contents` text, a placeholder, an open shadow root, a srcdoc frame, and a button label.
- From before the scan until after capture, a `MutationObserver` (document and open shadow roots) and a capturing scroll listener run in every frame. The image is discarded and capture retried, up to three times, if any non-overlay mutation or scroll happened, a frame was replaced or reloaded, or the post-capture rescan differs. Then it fails closed. A test re-renders a frame identically while the overlay is up; it fails without the change tracking.
- Not tracked: script-set `.value` on inputs (no DOM mutation), shadow roots attached after the scan starts, and closed shadow roots. A page that mutates its DOM continuously fails capture by design.
- If a mask cannot be applied, a capture times out, or a secret appears in the outbound text, no further provider call is made and the run ends `agent_error(browser_error)`. This holds after failed actions too.
- Locator candidates whose raw strings contain a registered secret are skipped, for the target and every frame in its chain, so `steps.jsonl` and replay scripts do not contain one. If every candidate is unsafe, the target is unsupported. Recorded step arguments are redacted structurally, keys included; a numeric argument that had to be redacted makes its replay step throw instead of passing `NaN`.
- Generated replays do not save screenshots, because replay fills real secret values.
- Every value ever bound to a secret name stays masked and redacted for the whole run, even after rebinding.
- Observation text and step URLs keep only origin and path, never queries or fragments.
- Native traces (`trace.zip`) hold unmasked DOM snapshots. They are private evidence: never publish or commit them.

## Stale targets

At each clean capture every element's box is recorded and the mutation log is reset. A point action is rejected as `stale_target` when the hit element or its interactive target was not present at capture, has moved, or changed inside since. The agent then observes again and sends a fresh screenshot. A test swaps a button in after the observation; it is never clicked.

## Navigation guard

- Navigations (main frame and subframes, including form posts) must go to the start origin or `allowedOrigins`. Other requests may also go to `resourceOrigins`. Non-HTTP navigations are blocked.
- Playwright context routes enforce this for first requests in every page and frame. They do not see redirect hops, so a CDP `Fetch` interceptor on the page applies the same rule to every hop in the page's own process. A test redirects both a `fetch` and a `goto` through the fixture's lab redirect.
- Backstop: any response from a disallowed origin (for example, a redirect inside an out-of-process frame, which the page session does not intercept) ends the run before the next provider call.
- Popups are closed. Start URLs with credentials or non-HTTP schemes are rejected. WebSockets are not intercepted.
- A refused top-level navigation to a known identity-provider, CAPTCHA, or payment host ends the run as `blocked(kind)`, detected by the harness. This covers both guard layers: popups and script navigations through the route guard, and redirect hops (including a start-URL redirect from an expired login) through the CDP guard. A popup's `window.open` target counts even when the popup closes before its first request. Subframes are not counted. The host list and its limits are in [setup-and-login.md](setup-and-login.md).
- Route `block`/`fulfill` rules run only after the allowlist check passes and are reported on every run. Like the route guard, they do not see redirect hops.

## Runtime

- Setup modules load natively with type stripping. Relative imports must use explicit `.ts` extensions. Modules must live inside `.cohort/setup/` and the path must not contain symlinks.
- `node:sqlite` works in a child Node process. Node v26.8.2 printed no warning; check the Node 24 warning on the first CI run.
- Generated `replay.spec.ts` runs with `@playwright/test`. Start it with `COHORT_START_URL`, and pass secrets as `COHORT_SECRET_<NAME>`. It ends by waiting up to 5 s for network idle, so a final form post completes. With persistent connections it simply proceeds after 5 s.
- If writing `trace.zip` fails, the run still writes `steps.jsonl` and the replay, reports `tracePath: null`, and records issue `trace_failed`.

## Runner and configuration (Phase 1)

- `.cohort/config.yml`, personas, and suites are validated against closed schemas (unknown fields and schema versions fail). Persona viewports are 240-3840 x 240-2160; locales and time zones must be accepted by `Intl`.
- Persona, suite, storage-state, and setup paths must stay inside their `.cohort/` folders with no symlinked segment.
- Not implemented yet, rejected at preflight: `mode: text`. (Routes and custom tools landed in Phase 5.)
- When setup runs, its `startUrl` replaces the configured URL, and its storage state replaces a named one. The time cap includes setup.
- Setup, including loading its module, is raced against the run's time cap and cancellation: a hung setup ends as `limit_reached(time)` or `interrupted`. Cleanups share a budget of min(10 s, time cap); overruns are recorded as `cleanup_timeout`.
- Setup and cleanup error text is redacted for setup secrets, for every value setup read through `ctx.env()`, and for provider key variables (shown as `[env]`). If one of those values is shorter than 4 characters and appears in the text, the whole message is withheld. Values read through `ctx.env()` are not masked in screenshots, because many are not secrets.
- `resolved-config.json` keeps only origin and path of the run URL, like the start URL.
- Named storage states are checked against Playwright's `cookies`/`origins` shape at preflight.
- Untested catalog entries need explicit confirmation: `--allow-untested`, or `allowUntested` in the engine API.
- Cancellation: `SIGINT` ends as `interrupted` by `user`, `SIGTERM` as `process`. The pending provider call, browser action (click, fill, type, scroll hover, goto, wait), or post-action load wait is abandoned right away. A pending provider call keeps its reservation as possibly billed. Repeats that never started are counted as `skipped`.
- Loop detection: three consecutive identical actions (name and key-order-independent arguments, ignoring the observation ID) end as `agent_error(loop)` when none changed the masked screenshot or URL, or each was rejected. Report tools that are accepted reset the count, as does any action that changes the screen. Playwright hides the caret in screenshots, so a blinking caret does not count as a change. Animated pages may hide a real loop until the step cap.
- `cohort run` prints a cost range before running. It assumes 6k input and 300 output tokens per call, from 2 calls up to the step cap, capped at the dollar limit. Without prices it prints "cost unknown; dollar cap unenforceable".

## Trail and reports (Phase 2)

- Every run that starts gets `report.json`, `report.md`, and `report.html`, then `manifest.json`. That includes runs that fail during setup: their outcome has no evidence and their report carries an `evidence_unavailable` issue, as does any run that ends before its first screenshot. If writing a run's bundle fails, the run becomes `agent_error(artifact_error)` and still counts in the batch completion rate and cost. Each file is written to a temp name and renamed. The manifest is written last, so a run directory without `manifest.json` was not finalized.
- The manifest inventories regular files only. Symlinks and other non-regular entries are not followed, and are reported as `artifact_rejected`. It records configuration hashes (persona, resolved config, setup, catalog) and runtime versions (Node, Playwright, Chromium). It does not hash each artifact, so it is not a tamper guarantee.
- `cohort report`, `cohort replay`, `cohort compare`, and `cohort trace` accept only generated IDs (`run_YYYYMMDD_HHMMSS_xxxxxx`, `batch_…`). The path from `.cohort` down to the run must be plain directories, not symlinks, and the bundle files they read (`report.json`, `manifest.json`, `steps.jsonl`, `resolved-config.json`, `replay.spec.ts`) must be regular files; symlinks are refused, not followed.
- Friction claims are validated before they are written. Validation rejects unknown fields, empty evidence, references to another run, unknown steps, and screenshots that are not part of the cited step or missing on disk. Rejected claims become `invalid_claim` issues.
- The harness derives these claims:
  - `long_pause`: a browser action, excluding `wait`, whose action plus page settling took at least 5 s; provider time is not included.
  - `repeated_action`: the same action at least twice within 5 browser actions.
  - `backtrack`: a return to an earlier origin and path.
  - `focus_trap`: two or more consecutive successful `Tab` or `Shift+Tab` presses whose focus ended on the same element of the same document; one claim per run of presses, counting the press that arrived there. A trap that does not change the screenshot also feeds loop detection, so the run may end as `agent_error(loop)` after three presses that change nothing; the claim is still derived.
  - `focus_not_visible`: a successful `press` or `type` after which the focused element is hidden, transparent, zero-size, or outside the viewport; not repeated while focus stays on the same hidden element of the same document. Focus rings themselves are not checked.
  - `horizontal_overflow`: the first step with an after-screenshot on each origin and path whose document is wider than the viewport, with the overflow in CSS pixels.
  - `steps_above_minimum`: computed per comparison group against the run with the fewest successful browser actions in the same batch; labeled "Above observed batch minimum".
- Agent `report_friction` calls become claims labeled "Agent opinion".
- Not implemented: `visible_error` detection (the schema accepts it, nothing emits it) and declared fixture baselines.
- Report text is redacted with the run's secret store; the manifest holds only IDs, hashes, versions, and file metadata. HTML reports escape all text, set a restrictive Content-Security-Policy, and link only to harness screenshot IDs. Markdown escapes link, emphasis, HTML, and table syntax.
- Replay status starts as `not_attempted`. It is `unsupported` when the run ended before its first screenshot, or when a step's arguments were redacted (`replay_unsupported` issue). `cohort replay` sets `passed` or `failed`, then refreshes the reports and manifest. Playwright output goes to a temp directory.
- `cohort compare` runs the same replay without changing the bundle or its replay status. It replaces only the start URL's origin with `--base` or `--head`, which must be bare origins, sets `COHORT_COMPARE_ORIGIN` for setup, and bounds each replay test by min(time cap, 30 s); setup keeps the time cap. It refuses a run with a successful absolute or protocol-relative `goto` on the recorded origin. Outcomes and confirmation rules are in [operating.md](operating.md#comparing-base-and-head).
- Replay bindings: `COHORT_START_URL`, `COHORT_SECRET_<NAME>`, and `COHORT_STORAGE_STATE` (a path to a storage-state file). `cohort replay` writes named or setup-provided storage state to a private temp file and deletes it afterwards. Setup cleanups run after the replay.
- Replay setup has the same bounds and redaction as `cohort run`: setup and its module load are raced against the recorded time cap and cancellation, cleanups share min(10 s, time cap), and setup errors and printed Playwright output are redacted for setup secrets, bindings, `ctx.env()` values, and provider keys (`[env]`), or withheld when a value shorter than 4 characters appears.
- `docs/report-examples/` holds one bundle per outcome and their batch report, generated by `node scripts/report-examples.ts` from the fixture app and a scripted model. `trace.zip` is left out because native traces are never published; the manifests still list it.

## Personas and generation (Phase 3)

- Authoring formats, prompt layers, and commands are documented in [personas.md](personas.md).
- `cohort persona generate` was tested only with a scripted model. The tests cover: redirects and scripted navigation off the landing page are refused before the target loads; cross-origin subresources and popups are blocked; a query or fragment value in `--url` never reaches the model or an error message, even when the page echoes it; masked elements stay out of both the screenshot and the page text; cancellation closes the browser during capture; an unpriced model warns before the call; injected page text cannot make an accepted persona set `setup`, `storageState`, `model`, `effort`, or `limits`; invalid output is never saved; `--out` never overwrites.
- Not verified: the quality of personas from a live model, and whether one landing page gives enough context. Both need live keys.
- The token bound used to reserve the generator budget is the same unmeasured, conservative one the agent uses.

## Dashboard (Phase 4)

- Verified with a scripted model and raw HTTP clients:
  - 401 without the bearer token, including when the token is in the query.
  - 403 for a foreign `Origin`, a mutation with no `Origin`, or a cross-site `Sec-Fetch-Site`.
  - 421 for a rebinding `Host` or the wrong port.
  - No CORS headers are sent.
  - SSE replays from `Last-Event-ID`.
  - Queued and running runs can be cancelled; the queue is bounded at 100.
  - Edits get a 409 on a stale revision and never overwrite external edits. Setup references cannot be added, changed or removed through the API.
  - Artifacts are served by manifest ID only; traces download as sandboxed attachments.
  - A restart marks orphans `interrupted`.
  - The key value never appears in responses, events, the index, or bundle files other than the trace.
- `/api/runs/:id/screenshots/shot-NNNN` serves the screenshots of a run still in progress, because the manifest exists only after finalize.
- Cancelling in the window between dequeue and `run.started` records the run as finished with an interrupted outcome, not as `cancelled`.
- The UI was tested with Playwright Chromium against the Vite build. The tests cover:
  - no CSP violations and no inline code;
  - the token leaves the URL;
  - keyboard-only use of the run dialog and its pickers, the screenshot timeline, cancel, and save;
  - providers without a key are hidden, and non-vision models are disabled in vision mode;
  - estimate and unknown-cost displays;
  - an edit conflict keeps the user's text;
  - persona frontmatter edits through form fields and shows validation errors beside them;
  - persona names are rendered as text, not HTML;
  - ad-hoc save to a suite.
  Other browsers were not tested.
- Run limits show only after the run finishes, because they come from `resolved-config.json`.
- Svelte components have no type checking: `svelte-check` was not added. The logic they rely on lives in typechecked `ui/lib/*.ts` files.

## Packaging, Action, and hardening (Phase 6)

- `scripts/package-smoke.ts` (`bun run smoke:package` after `bun run build`) packs the tarball, checks its file list (only `dist/`, `examples/personas/`, the `examples/suites/*-pack.yml` scenario packs, `LICENSE`, `NOTICE`, `README.md`, `package.json`), installs it with npm into an empty directory with Bun removed from `PATH`, then runs the installed `cohort --version`, `init`, `persona validate`, `doctor`, a fixture run through the installed library with a scripted model, `cohort report`, `cohort ui` (static page with CSP, 401 without the token, the run in `/api/runs`), and the Action script against the installed CLI. Passed locally on Node v26.8.2; the CI `package` job is configured to run it on Node 24 but has not run yet.
- The Action (`action.yml`) is tested with a stub CLI: inputs arrive as separate arguments, outputs and exit codes map from the JSON result, and no step interpolates inputs into shell or uploads anything. It has not run on GitHub-hosted runners yet.
- `tests/integration/canary.test.ts` scans every file a run, its batch, and the reports write under `.cohort` (except `trace.zip`) for setup secrets, an environment-only value, and the provider key, and checks owner-only modes.
- `cohort init` and `cohort doctor` exist; doctor never calls a model.
- A hard-killed `cohort run` leaves run directories without `manifest.json`. `cohort doctor` lists them; they are not finalized automatically, because another `cohort run` may still own them.

## Not verified (needs live keys or external targets)

- The provider wire formats were checked only against fake HTTP servers: Anthropic `output_config.effort`, `tool_choice: auto` with `disable_parallel_tool_use`, and OpenAI Responses `reasoning.effort`.
- Not measured: model IDs, prices, image token accounting, caching, and effort support.
