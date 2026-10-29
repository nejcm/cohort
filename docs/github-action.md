# GitHub Action

`action.yml` at the repository root is a thin composite Action. It installs the `cohort-lab` npm package whose version matches the Action's own `package.json`, installs Chromium, runs `cohort run --json` (or `cohort compare` when `compare-run` is set), and exposes the result as step outputs. It does not upload anything, comment on pull requests, or read keys from inputs.

Status: release candidate. The output mapping and input handling are tested locally with a stub CLI (`tests/unit/action.test.ts`). Neither the Action nor the workflows below have been observed on GitHub-hosted runners yet.

## Example

Provider keys come only from the job environment, for example repository secrets. The example uploads run bundles for review but excludes native traces, which hold unmasked DOM snapshots.

```yaml
name: Synthetic users
on: workflow_dispatch

permissions:
  contents: read

jobs:
  lab:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - id: lab
        uses: OWNER/cohort-lab@v0.1.0-rc.0
        continue-on-error: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          suite: smoke
          repeats: 1
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lab-runs
          retention-days: 7
          path: |
            .cohort/runs/
            !.cohort/runs/**/trace.zip
      - if: steps.lab.outputs.exit-code == '2'
        run: exit 1
```

`OWNER` and the tag are placeholders until the first release is published.

## Inputs

| Input | Meaning |
| --- | --- |
| `persona`, `tag`, `suite` | Selector; choose one, or `url` with `note` |
| `url`, `note` | Ad-hoc start URL and goal. Never put bearer tokens in a URL; use setup bindings |
| `model`, `effort` | Optional `<provider>/<id>` and `low`/`medium`/`high`; same precedence as `cohort run` |
| `repeats` | Optional repetitions per entry |
| `allow-untested` | `true` to allow untested catalog entries |
| `max-usd` | Dollar ceiling for the batch estimate (default `10`); a larger estimate refuses with `over_budget` |
| `allow-unpriced` | `true` to run models with unknown prices; without it they refuse with `cap_unenforceable` |
| `working-directory` | Directory that contains `.cohort/` (default `.`) |
| `install-browser` | `false` to skip `playwright install --with-deps chromium` |
| `package` | npm spec to install instead of the matching release, for testing a release-candidate tarball |
| `compare-run`, `base-url`, `head-url` | Run `cohort compare <compare-run> --base <base-url> --head <head-url>` instead of `cohort run`; the selector and run options are ignored |

Inputs reach the CLI as separate arguments through environment variables; they are never interpolated into a shell script.

## Outputs

`batch-id`, `report-path` (the batch `report.html`), `exit-code`, `runs`, and per-outcome counts: `completed`, `abandoned`, `blocked`, `agent-error`, `limit-reached`. With `compare-run`: `outcome` (`unchanged`, `fixed`, `regression`, or `inconclusive`) and `markdown-path`, the comment body in `$RUNNER_TEMP`; both are empty when compare stopped on invalid configuration.

The step's exit code is the CLI's: `0` all runs completed, `1` the batch ran but some run did not complete, `2` invalid configuration or a cost refusal. For compare, `1` means a confirmed regression and every other outcome is `0`. Advisory workflows use `continue-on-error: true` and decide from `exit-code`, as in the examples.

## Pull-request comparison

`compare-run` replays one approved run against the base and head deployments with no model and no keys; [operating.md](operating.md#comparing-base-and-head) has the confirmation rules and outcomes. The Action only writes the comment body. The workflow below posts it as a single pull-request comment and updates that comment on later pushes, finding it by the hidden `<!-- cohort-compare:<run-id> -->` marker on the body's first line.

Before using it:

- Approve a run: pick a run whose replay you trust from a `Synthetic users` workflow run, then set the repository variables `COHORT_APPROVED_RUN` (its run ID) and `COHORT_APPROVED_ARTIFACT_RUN` (the workflow run ID whose `lab-runs` artifact holds it). The artifact excludes `trace.zip`; compare does not need it. Artifacts expire with their retention period, so raise it for the approving workflow or re-approve.
- The project must have `@playwright/test` installed at the same version as the Action's `playwright`.
- `base-url` and `head-url` are bare origins. Replace the placeholders with your production or staging origin and your preview naming scheme. Use test accounts on both deployments; setup modules can read the target origin as `COHORT_COMPARE_ORIGIN`.

```yaml
name: Journey check
on: pull_request

permissions:
  contents: read
  actions: read
  pull-requests: write

jobs:
  compare:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          name: lab-runs
          path: .cohort/runs/
          run-id: ${{ vars.COHORT_APPROVED_ARTIFACT_RUN }}
          github-token: ${{ github.token }}
      - id: compare
        uses: OWNER/cohort-lab@v0.1.0-rc.0
        continue-on-error: true
        with:
          compare-run: ${{ vars.COHORT_APPROVED_RUN }}
          base-url: https://staging.example.com
          head-url: https://pr-${{ github.event.pull_request.number }}.preview.example.com
      - if: steps.compare.outputs.markdown-path != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          BODY: ${{ steps.compare.outputs.markdown-path }}
        run: |
          marker="$(head -n 1 "$BODY")"
          id="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments" \
            --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)"
          if [ -n "$id" ]; then
            gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -F "body=@$BODY"
          else
            gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -F "body=@$BODY"
          fi
      - if: steps.compare.outputs.exit-code == '2'
        run: exit 1
```

Notes:

- The job checks out the base revision, not the pull request, because compare tests deployed URLs and only needs trusted configuration and setup modules from the checkout. `persist-credentials: false` keeps the token out of `.git/config` while setup code runs.
- `continue-on-error` keeps a regression advisory; only invalid configuration fails the job. Drop it to block merges on a confirmed regression.
- `pull-requests: write` is the only write permission, held by the token the comment step uses.
- On pull requests from forks, GitHub gives the workflow a read-only token and no secrets, so the comment step fails there. Do not switch to `pull_request_target` to work around it: that runs with a write token and secrets next to code the fork can influence.

## Artifact boundaries

- The Action writes `.cohort/runs/` in the working directory and uploads nothing itself.
- Exclude `trace.zip` from any upload. Upload-artifact retention and repository access then decide who can see screenshots and reports, which can still show sensitive content.
- Never upload `.cohort/auth/`; it holds saved logins.
- Setup modules run with the job's privileges. Run the Action only on trusted revisions; do not run it on pull requests from forks with secrets available.
