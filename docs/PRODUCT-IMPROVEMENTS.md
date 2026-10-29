# Product improvements: cohort.

**As of 2026-10-29.** A product-strategy pass over what to build next: features, extensions, and UX. Engineering quality, performance, and refactoring are out of scope. Every idea cites a file or flow in this repository or a competitor finding; competitor claims are paraphrased from the sources listed at the end and from [COMPETITIVE-INTELLIGENCE.md](COMPETITIVE-INTELLIGENCE.md), and are vendor descriptions, not independently verified performance.

**Personas this serves**, inferred from the README, [agents.md](agents.md), and [compare.md](compare.md):

- **Activation-flow developer**: a developer on a 2–10 person team who owns signup and onboarding, runs `cohort run` locally and wants a pre-merge signal (the buyer named in the competitive research).
- **Coding agent**: Claude Code, Codex and similar, driving every command through `--json` with the shipped `skills/cohort/SKILL.md`.
- **CI maintainer**: wires `action.yml`, `cohort compare`, and `cohort publish` into pull requests.
- **Product or design reviewer**: reads `report.html` and the dashboard's run and batch pages without running the CLI.

## 1. Competitive landscape

**Synthetic Users** sells AI-persona _interviews_, not browser sessions: research-goal interviews with dynamic follow-ups, full transcripts, an insights report across all interviews, and context clustering that groups interview data into themes. Cohort is ahead on observable behaviour, because its agents actually operate the app and every claim cites a screenshot. It is behind on synthesis across many sessions: a batch shows counts, not themes.

**Uxia** runs unmoderated usability tests with AI testers on prototypes or live URLs, typically several differentiated testers per test (one evaluation reports 5, and 10 by default on standard plans). A directory listing mentions transcripts and heatmaps, which I could not confirm in Uxia's own documentation. A reviewer warned that 30 synthetic responses saying the same thing are one opinion multiplied. Cohort's split between measured friction and agent opinion (`src/evidence/friction.ts`) answers that critique directly, but cohort has no notion of a varied _panel_: repeats rerun the same persona.

**Meticulous** records real sessions and replays them on a PR's base and head with network responses stubbed, picks only the flows that reach the changed code, and posts screenshot diffs to the PR. Developers approve or reject the diffs. It also ships a hosted MCP server so coding agents can pull diff data. Cohort's `cohort compare` is stricter on provenance (hash-pinned approval, verified scoped resets, live backend) but needs a human to choose which run to compare, and nothing remembers a reviewer's verdict on a finding.

**Momentic** pairs goal-driven natural-language AI actions with step-based tests for critical paths, self-healing locators, a step cache that invokes the agent only when needed, and reportedly a CLI, CI recipes, and an MCP server. Cohort already has the same split (agent runs produce `replay.spec.ts`; compare never heals), which is a positioning strength: it refuses to heal away a regression.

**QA Wolf and TestSprite** (from the existing research) cover PR-triggered AI testing at $1 per run and $19–$69 a month. Cohort's local-first, bring-your-own-key, no-telemetry model and honest outcome taxonomy (`src/core/outcomes.ts`) are its clearest differences; it does not yet offer a hosted experience, which is deliberate.

**Net:** cohort leads on evidence honesty and local control. It trails on cross-run synthesis, on remembering reviewer decisions, on choosing what to check for a given PR, and on surfacing explore and compare in the dashboard.

## 2. New features

| Feature | Description | User Value | Effort | Where it would live | Inspired by |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Finding triage** | Mark each friction claim as _confirmed_, _won't fix_, or _known_ from the run page; later batches carry the verdict forward by matching claim kind, step fingerprint, and journey, and show only new or regressed claims by default. | The product reviewer stops re-reading the same `visible_error` on every batch; the activation-flow developer sees what changed. | Medium: matching uses the existing `fingerprint` in `src/core/agent.ts`, plus one table in the SQLite index. | `src/dashboard/db.ts`, `ui/pages/RunDetail.svelte`, `ui/pages/BatchDetail.svelte`; mirrored by a `cohort finding` command for agents | Meticulous (approve/reject of diffs) |
| **Persona panel** | `cohort run --panel <tag>` runs one goal across several personas that differ by device, locale, input, and familiarity (for example `first-time-host`, `small-screen-form-filler`, `keyboard-only-navigator`, `booking-guest`) instead of three repeats of one persona, and reports where the journey diverged. | The developer learns that the flow works on desktop but horizontally overflows at 360 px, in one batch. | Medium: suites already support ordered entries and a shared goal; this adds a panel selector and a divergence summary. | `src/core/batch.ts`, `src/evidence/report.ts`, `examples/personas/` tags | Uxia (several differentiated testers per test) |
| **Diff-aware journey selection** | `cohort compare --select` takes the PR's changed paths and a project map (`routes` or URL prefixes per approved run) and compares only approved runs whose observed URLs touch the change, skipping the rest as `not_selected`. | The CI maintainer gets fewer, more relevant comparisons per PR, which matters given the per-comparison cost model in the competitive research. | High: needs a mapping from code changes to observed URLs in `steps.jsonl`, and honest reporting when the mapping is uncertain. | `src/core/compare.ts`, `action.yml`, [compare.md](compare.md) | Meticulous (replays only flows that reach the diff) |
| **MCP server** | `cohort mcp` exposes the existing `--json` commands (`estimate`, `run --detach`, `runs wait`, `report`, `explore`) as MCP tools over stdio, with the same `max-usd` ceiling and refusal codes. | The coding agent persona calls cohort as tools instead of parsing shell output; the $10 default ceiling still applies. | Medium: stdio JSON-RPC on Node built-ins, no SDK (per AGENTS.md), mapping onto `src/commands.ts`. | New `src/mcp.ts` beside `src/commands.ts`; [agents.md](agents.md) | Meticulous and Momentic (both advertise MCP servers) |
| **Agent-driven variant comparison** | `cohort run --variant-a <url> --variant-b <url>` runs the same persona and goal against two live origins with the agent (not frozen replay), and reports completion, action counts, and measured friction side by side. | A product reviewer can compare a redesigned onboarding against the current one before there is an approved replay to freeze. | Medium: two batch groups with identical resolved config already compare cleanly in `src/evidence/report.ts` ("runs compare only when persona, goal, mode… all match"). | `src/core/batch.ts`, `src/evidence/report.ts`, `ui/pages/BatchDetail.svelte` | No direct precedent found |

## 3. Extend or improve existing features

### Extend: batch report (`src/evidence/report.ts`, `ui/pages/BatchDetail.svelte`)

| Aspect | Detail |
| :--- | :--- |
| Current limitation | `BatchGroup` counts outcomes, blockers, limits, and cost, but friction is only a per-run number (`sumOf(ids, 'friction')` in `BatchDetail.svelte`). A reviewer cannot tell whether three runs hit the same `visible_error` or three different ones. |
| Proposed extension | Group claims across the runs of a batch group by kind plus the step's action fingerprint or error text, and show each recurring claim as "seen in 3 of 3 runs", linking the evidence screenshots from each run. Keep agent opinions in a separate, clearly labelled cluster. |
| User Value | The product reviewer gets the one-page answer they came for: what reliably goes wrong, separated from what one run happened to think. This turns Uxia's "one opinion multiplied" critique into cohort's selling point. |

### Extend: `cohort explore` (`src/core/explore.ts`, [explore.md](explore.md))

| Aspect | Detail |
| :--- | :--- |
| Current limitation | Suggestions live in `suggestions/explore.json` and are saved one at a time with `cohort explore save <run-id> --persona <id> --yes`; suggested test specs must be copied by hand. The docs and README both say there is no crawler view in the dashboard, and the dashboard has no explore page at all. |
| Proposed extension | A dashboard explore page: start an exploration from the run dialog, then review each suggested feature, persona, goal, and test beside its cited screenshots, with **Save** and **Dismiss** per item using the same validated atomic write. Dropped suggestions are shown with their reasons. |
| User Value | The developer's first-run path becomes "point at a URL, keep the good suggestions", which is the fastest route from install to a useful suite. |

### Extend: `cohort compare` (`src/core/compare.ts`, [compare.md](compare.md))

| Aspect | Detail |
| :--- | :--- |
| Current limitation | Results appear in the terminal, as JSON or Markdown, and as one PR comment via `cohort publish`. Nothing in `ui/` shows a comparison, so the base and head evidence cannot be stepped through. |
| Proposed extension | A compare page that reuses `ui/components/ReplayPlayer.svelte` to play base and head side by side and stop at the first diverging step, with the provenance (`--base-sha`, `--head-sha`, `--deployment`) shown in its header. `cohort publish --evidence <url>` could link to it when the dashboard is reachable. |
| User Value | The CI maintainer can confirm a `regression` in seconds instead of opening two traces. |

### Extend: journeys (`db.journeys()` in `src/dashboard/db.ts`, the lead block of `ui/pages/Runs.svelte`)

| Aspect | Detail |
| :--- | :--- |
| Current limitation | Journeys group finished runs by persona and goal over the latest 10 runs (`JOURNEY_WINDOW` in `src/dashboard/server.ts`), sorted worst completion first. There is no history: a journey that fell from 100% to 40% after yesterday's deploy looks like one that has always been at 40%. |
| Proposed extension | Show the completion rate per batch as a short tick series (the dashboard already has `ui/components/Ticks.svelte`), mark the batch where it dropped, and link that batch. |
| User Value | The developer sees regressions in the place they already look first. |

## 4. UX ideas and improvements

**Empty runs page is a dead end for a new user.**
Today: `ui/pages/Runs.svelte` shows "No runs yet. Start one with **New run**." → Friction: a first-time user may have no key set or no Chromium, which `cohort doctor` would catch, and won't know the bundled fixture app exists. → Change: replace the empty state with a three-item checklist built from data the dashboard already serves (`/api/config` reports provider availability): key present, a persona exists, and a suggested first command (`cohort explore --url …` or the fixture). → Effort: Low.

**Saved login is invisible from the dashboard.**
Today: personas accept `storageState`, but the state is created only by `cohort login --url <url> --state <name>`, and the schema-driven field in `ui/components/PersonaForm.svelte` is free text. → Friction: templates such as `back-office-operator` and `subscription-manager` need a signed-in session, and nothing in the form says how to get one or which states exist. → Change: list the existing `.cohort/auth/<name>.json` names (names only, never contents) as choices, and show the exact `cohort login` command beside the field. → Effort: Low.

**Scenario packs need a manual copy out of `node_modules`.**
Today: [personas.md](personas.md#scenario-packs) asks the user to run `cohort init --template …` for each persona and then `cp node_modules/cohort-lab/examples/suites/keyboard-pack.yml .cohort/suites/`, adjusting the path. → Friction: the keyboard and small-screen packs are a differentiator, and the setup is the step most likely to fail. → Change: `cohort init --pack keyboard|small-screen` copies the suite and its personas together, without overwriting, and the dashboard's suite page offers the same. → Effort: Low.

**`cohort replay` fails late on a missing dependency.**
Today: the README notes that replay "needs `@playwright/test` in the project", and `src/doctor.ts` checks Chromium and keys but not that package. → Friction: users discover the requirement after their first successful run, at the moment they try the replayable script cohort promised. → Change: add a doctor line (warning, not error) and say so in the run's closing output when the package is missing. → Effort: Low.

**Blocked runs read as problems.**
Today: the runs page's "Needs a look" KPI groups blocked, limit reached, and failed. Blocked runs are, by design, excluded from completion because an email code or CAPTCHA stopped them. → Friction: a new user sees a red count for runs that behaved correctly, and may think cohort is broken. → Change: show blocked runs as their own neutral count with the blocker kind and a link to [setup-and-login.md](setup-and-login.md) for passing it (setup modules, saved login). → Effort: Low.

## 5. Moonshot: a PR check that tells you which users your change hurt

- **Concept:** On every pull request, cohort picks the journeys a change touches, replays the frozen ones for a regression verdict, and runs a small persona panel on the head preview for _new_ friction. It then posts one comment: "this PR broke nothing that was approved; it added a cut-off button for the 360 px persona and two extra steps for the keyboard persona", each linked to screenshots.
- **Why cohort is positioned to build it:** it already has every piece in separate commands: hash-pinned `cohort compare` with an honest `inconclusive`, a single-comment `cohort publish` that skips stale heads, persona templates and scenario packs with harness-measured `focus_trap` and `horizontal_overflow` claims, and a measured-versus-opinion split. Competitors either replay (Meticulous) or explore (Momentic, QA.tech); cohort can do both, with the agent forbidden to heal the frozen half.
- **Smallest version worth prototyping:** one GitHub workflow on the fixture app (`tests/fixtures/friction-app/server.ts` with `--mutation hidden_primary`) that runs `cohort compare` on one approved run plus `cohort run --suite small-screen-pack` on head only, then publishes a combined comment. No selection logic yet: one journey, chosen by hand.
- **Biggest risk:** alert precision. The research's pilot gates are at least 90% actionable alerts and at most 5% false alerts on unchanged pairs; agent-run friction on head is noisier than replay, so new-friction findings must be shown as advisory and compared against base before they ever flag a PR.

## 6. Quick-win plan

The best value-to-effort idea is **recurring-friction grouping in the batch report** (section 3): it needs no new runs, reuses claims and evidence that already exist, and improves every batch.

1. In `src/evidence/report.ts`, add a `recurring` list to `BatchGroup`: claims grouped by `kind` plus `measurement.actionFingerprint`, `measurement.text`, or `measurement.element` (whichever the kind has), each with the run IDs and evidence references that contributed. Keep `source: 'agent'` claims out of it. Add unit tests in `tests/` using the scripted fake model's existing fixture batches.
2. Render it in `report.md` and `report.html` as "Seen in k of n runs" above the per-run sections, and regenerate `docs/report-examples/` with `node scripts/report-examples.ts`.
3. In `ui/pages/BatchDetail.svelte`, replace the per-group friction total with the recurring list, linking each item to the first run's step and screenshot; keep agent opinions in a separate, labelled section.

## Sources

- [Synthetic Users product features](https://legal.syntheticusers.com/product-documentation/product-features) and [FAQ](https://syntheticusers.com/faqs)
- [Uxia comparative evaluation (Zenodo)](https://zenodo.org/records/21249233), [skills directory listing](https://skillsmp.com/creators/sales-skills/sales/skills-sales-uxia), [The Good review](https://thegood.com/?p=111567)
- [Meticulous: how it works](https://meticulous.ai/how-it-works), [architecture overview](https://app.meticulous.ai/docs/concepts/architecture-overview.md), [MCP server](https://app.meticulous.ai/docs/agents/mcp-server.md)
- [Momentic agentic testing docs](https://momentic.ai/docs/core-concepts/agentic-testing), [Momentic features summary (Bug0)](https://bug0.com/knowledge-base/momentic-features)
- [COMPETITIVE-INTELLIGENCE.md](COMPETITIVE-INTELLIGENCE.md) for QA Wolf, TestSprite, and the pilot gates
