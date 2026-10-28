# Compatibility notes (Phases 0-1)

Verified offline on Linux, Node v26.8.2, Playwright 1.64.1 headless Chromium, with a scripted fake model. Node 24 itself has not been run locally yet; CI pins `.node-version`.

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

Text perception mode is not implemented yet, so "both modes" is unverified.

## Secret boundary

- Before every capture, magenta (`rgb(255, 0, 255)`) overlays are drawn in every frame and open shadow root. They cover:
  - `maskSelectors` and `[data-lab-masked]` fields;
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

## Runtime

- Setup modules load natively with type stripping. Relative imports must use explicit `.ts` extensions. Modules must live inside `.lab/setup/` and the path must not contain symlinks.
- `node:sqlite` works in a child Node process. Node v26.8.2 printed no warning; check the Node 24 warning on CI.
- Generated `replay.spec.ts` runs with `@playwright/test`. Start it with `LAB_START_URL`, and pass secrets as `LAB_SECRET_<NAME>`. It ends by waiting up to 5 s for network idle, so a final form post completes. With persistent connections it simply proceeds after 5 s.
- If writing `trace.zip` fails, the run still writes `steps.jsonl` and the replay, reports `tracePath: null`, and records issue `trace_failed`.

## Runner and configuration (Phase 1)

- `.lab/config.yml`, personas, and suites are validated against closed schemas (unknown fields and schema versions fail). Persona viewports are 240-3840 x 240-2160; locales and time zones must be accepted by `Intl`.
- Persona, suite, storage-state, and setup paths must stay inside their `.lab/` folders with no symlinked segment.
- Not implemented yet, rejected at preflight: `mode: text`, non-empty `routes`, and custom tools returned by setup (`setup_error`).
- When setup runs, its `startUrl` replaces the configured URL, and its storage state replaces a named one. The time cap includes setup.
- Untested catalog entries need explicit confirmation: `--allow-untested`, or `allowUntested` in the engine API.
- Cancellation: `SIGINT` ends as `interrupted` by `user`, `SIGTERM` as `process`. The pending provider call or browser wait is abandoned right away. A pending provider call keeps its reservation as possibly billed. Repeats that never started are counted as `skipped`.
- Loop detection: three consecutive identical actions (name and arguments, ignoring the observation ID) end as `agent_error(loop)` when none changed the masked screenshot or URL, or each was rejected. Report tools that are accepted reset the count, as does any action that changes the screen. Playwright hides the caret in screenshots, so a blinking caret does not count as a change. Animated pages may hide a real loop until the step cap.
- `lab run` prints a cost range before running. It assumes 6k input and 300 output tokens per call, from 2 calls up to the step cap, capped at the dollar limit. Without prices it prints "cost unknown; dollar cap unenforceable".

## Not verified (needs live keys or external targets)

- The provider wire formats were checked only against fake HTTP servers: Anthropic `output_config.effort`, `tool_choice: auto` with `disable_parallel_tool_use`, and OpenAI Responses `reasoning.effort`.
- Not measured: model IDs, prices, image token accounting, caching, and effort support.
