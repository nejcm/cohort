# Release-candidate checklist

For `0.1.0-rc.0`. Offline items are automated; everything under "Manual" needs a person, live keys, or another environment, and is not done yet.

## Automated (run before tagging)

- [ ] `bun install --frozen-lockfile`
- [ ] `bun run verify`: typecheck, lint, format check, unit and Chromium integration tests (including the secret-canary suite and Action tests), unused-code check
- [ ] `bun run build`
- [ ] `bun run smoke:package`: npm install of the packed tarball with no Bun, CLI, library fixture run, dashboard, Action script
- [ ] CI green on Node 24 for both the `verify` and `package` jobs (the `package` job also runs the Action from the tarball)

## Manual

- [ ] Run `bun run verify` and `bun run smoke:package` on a local Node 24 install and record any `node:sqlite` or type-stripping warning in [compatibility.md](compatibility.md).
- [ ] Verify at least one model live per provider: model ID, vision, supported efforts, dated prices, image token accounting. Add the verified entries to `src/providers/catalog.json` with `untested: false` only after a reproducible fixture bake-off.
- [ ] Run a live fixture journey per verified model and check that its `replay.spec.ts` replays.
- [ ] Measure real run cost and replace the provisional $2 default cap if the measurements say so.
- [ ] Confirm provider retention settings for the request shapes we send.
- [x] Decide the package and executable names: package `cohort-lab` (free on npm, checked 2026-10-29; `cohort` is taken), executable `cohort`, project directory `.cohort/`. The old `lab` bin collided with hapi's `lab` test runner.
- [ ] Add `repository`, `homepage`, and `bugs` to `package.json` once the public repository exists, and replace `OWNER` in [github-action.md](github-action.md).
- [ ] Review `NOTICE` against the final `dist/ui` bundle (it currently lists Svelte and clsx).
- [ ] `npm publish --tag next` from a clean checkout after `bun run build`, then tag the same commit `v0.1.0-rc.0` so the Action installs the matching package.
- [ ] Run the Action once on a GitHub-hosted runner against a disposable test target.
- [ ] Fresh-install walkthrough from the README on a clean machine: install, `cohort init`, `cohort doctor`, start the fixture app, first run, open the report. Record browser-install time separately.
- [ ] Exercise `cohort login` by hand: the headed window and the Enter prompt are not covered by tests.
- [ ] Two outside developers install unaided and configure one goal on their own app.
