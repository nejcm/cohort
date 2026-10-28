# GitHub Action

`action.yml` at the repository root is a thin composite Action. It installs the `synthetic-customer-lab` npm package whose version matches the Action's own `package.json`, installs Chromium, runs `lab run --json`, and exposes the result as step outputs. It does not upload anything, comment on pull requests, or read keys from inputs.

Status: release candidate. The output mapping and input handling are tested locally with a stub CLI (`tests/unit/action.test.ts`). A run on GitHub-hosted runners has not been observed yet.

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
        uses: OWNER/synthetic-customer-lab@v0.1.0-rc.0
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
            .lab/runs/
            !.lab/runs/**/trace.zip
      - if: steps.lab.outputs.exit-code == '2'
        run: exit 1
```

`OWNER` and the tag are placeholders until the first release is published.

## Inputs

| Input | Meaning |
| --- | --- |
| `persona`, `tag`, `suite` | Selector; choose one, or `url` with `note` |
| `url`, `note` | Ad-hoc start URL and goal. Never put bearer tokens in a URL; use setup bindings |
| `model`, `effort` | Optional `<provider>/<id>` and `low`/`medium`/`high`; same precedence as `lab run` |
| `repeats` | Optional repetitions per entry |
| `allow-untested` | `true` to allow untested catalog entries |
| `working-directory` | Directory that contains `.lab/` (default `.`) |
| `install-browser` | `false` to skip `playwright install --with-deps chromium` |
| `package` | npm spec to install instead of the matching release, for testing a release-candidate tarball |

Inputs reach the CLI as separate arguments through environment variables; they are never interpolated into a shell script.

## Outputs

`batch-id`, `report-path` (the batch `report.html`), `exit-code`, `runs`, and per-outcome counts: `completed`, `abandoned`, `blocked`, `agent-error`, `limit-reached`.

The step's exit code is the CLI's: `0` all runs completed, `1` the batch ran but some run did not complete, `2` invalid configuration. Advisory workflows use `continue-on-error: true` and decide from `exit-code`, as in the example.

## Artifact boundaries

- The Action writes `.lab/runs/` in the working directory and uploads nothing itself.
- Exclude `trace.zip` from any upload. Upload-artifact retention and repository access then decide who can see screenshots and reports, which can still show sensitive content.
- Never upload `.lab/auth/`; it holds saved logins.
- Setup modules run with the job's privileges. Run the Action only on trusted revisions; do not run it on pull requests from forks with secrets available.
