# Compatibility notes (Phase 0)

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
  - the deepest element whose text contains a whole secret, which also catches secrets split across spans.
- Tests decode the PNG and require every pixel of the rendered box to be masked for filled email and one-time-code fields, a DOM mirror, a fragment echo, split text, a placeholder, an open shadow root, a srcdoc frame, and a button label.
- After capture the page is rescanned. If the mask regions or the frame list changed, the image is discarded and capture is retried up to three times; after that it fails closed. A change that appears and disappears between the two scans is not detected.
- If a mask cannot be applied, a capture times out, or a secret appears in the outbound text, no further provider call is made and the run ends `agent_error(browser_error)`. This holds after failed actions too.
- Locator candidates containing a registered secret are skipped, so `steps.jsonl` and replay scripts never contain one. If every candidate is unsafe, the target is unsupported.
- Generated replays do not save screenshots, because replay fills real secret values.
- Every value ever bound to a secret name stays masked and redacted for the whole run, even after rebinding.
- Observation text and step URLs keep only origin and path, never queries or fragments.
- Native traces (`trace.zip`) hold unmasked DOM snapshots. They are private evidence: never publish or commit them.

## Navigation guard

`runOnce` aborts main-frame and subframe navigations, including form posts, to origins outside the allowlist. It closes popups and rejects start URLs with credentials or non-HTTP schemes. Subresources (images, scripts, fetch) are not restricted, and Playwright routes do not see redirect hops.

## Runtime

- Setup modules load natively with type stripping. Relative imports must use explicit `.ts` extensions. Modules must live inside `.lab/setup/` and the path must not contain symlinks.
- `node:sqlite` works in a child Node process. Node v26.8.2 printed no warning; check the Node 24 warning on CI.
- Generated `replay.spec.ts` runs with `@playwright/test`. Start it with `LAB_START_URL`, and pass secrets as `LAB_SECRET_<NAME>`. It ends by waiting for network idle.

## Not verified (needs live keys or external targets)

- The provider wire formats were checked only against fake HTTP servers: Anthropic `output_config.effort`, `tool_choice: auto` with `disable_parallel_tool_use`, and OpenAI Responses `reasoning.effort`.
- Not measured: model IDs, prices, image token accounting, caching, and effort support.
