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
| Cross-origin iframe (`127.0.0.1` page, `localhost` frame) | Supported |
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

- Before every capture, magenta (`rgb(255, 0, 255)`) overlays cover `maskSelectors`, `[data-lab-masked]` fields, inputs whose value contains a secret, and text nodes containing a secret. Overlays are also injected into open shadow roots and frames, but the pixel tests cover the top document only. The test decodes the PNG and checks the pixels for filled email and one-time-code fields, a DOM mirror of the email, and a fragment-token echo.
- If a mask cannot be applied, or a secret appears in the outbound text, the provider call is suppressed and the run ends `agent_error(browser_error)`.
- Observation text and step URLs keep only origin and path, never queries or fragments.
- Native traces (`trace.zip`) hold unmasked DOM snapshots. They are private evidence: never publish or commit them.

## Runtime

- Setup modules load natively with type stripping. Relative imports must use explicit `.ts` extensions. Modules must live inside `.lab/setup/` and the path must not contain symlinks.
- `node:sqlite` works in a child Node process. Node v26.8.2 printed no warning; check the Node 24 warning on CI.
- Generated `replay.spec.ts` runs with `@playwright/test`. Start it with `LAB_START_URL`, and pass secrets as `LAB_SECRET_<NAME>`.

## Not verified (needs live keys or external targets)

- The provider wire formats were checked only against fake HTTP servers: Anthropic `output_config.effort`, `tool_choice: auto` with `disable_parallel_tool_use`, and OpenAI Responses `reasoning.effort`.
- Not measured: model IDs, prices, image token accounting, caching, and effort support.
