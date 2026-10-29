# Pull-request comparison

`cohort compare` replays one approved run on a base and a head deployment and decides whether the head broke it. `cohort publish` posts the result as one pull-request comment. They are separate commands so the job that runs browsers never holds a write token, and the job that holds the token never runs project code or sees an LLM key.

## cohort compare

```sh
cohort compare <run-id> --base <origin> --head <origin> \
  --repo <owner/name> --pr <n> --base-sha <sha> --head-sha <sha> --deployment <id> \
  --approved <sha256:…> --hooks .cohort/setup/<module>.ts [--json] [--markdown <file>]
```

- The run's `replay.spec.ts` is the frozen script and its assertions are the approved ones. Nothing is healed, re-planned, or rewritten, no model is called, and the bundle is not changed.
- `--approved` is the `sha256:<hex>` of the run's `manifest.json` (`sha256sum manifest.json`), which pins the hash of every file replay reads. Before anything runs, every file in the bundle is hashed and checked against the manifest, files a run never writes (a `playwright.config.ts`, `node_modules/`) are refused, and `manifest.json` must match `--approved`. `cohort replay` rewrites the manifest, so re-approve after it. A mismatch exits 2 with code `invalid`. Explore bundles hold extra files and are refused; approve a run from `cohort run`.
- `--base` and `--head` are bare origins, handled as described in [operating.md](operating.md#comparing-base-and-head).
- Provenance (`--repo`, `--pr`, `--base-sha`, `--head-sha`, `--deployment`, `--approved`) and `--hooks` are all required for a conclusive result. A malformed value exits 2. A missing one gives `inconclusive` without opening a browser.

### Hooks

`--hooks` names a trusted module inside `.cohort/setup/`, loaded under the same rules as setup modules. Its default export runs before every execution:

```ts
export default async (ctx) => {
  // ctx: { side: 'base' | 'head', origin, scopeId, signal, env(name) }
  await resetTestAccount(ctx.origin, ctx.scopeId);
  return {
    revision: await deployedRevision(ctx.origin), // must equal --base-sha or --head-sha
    deployment: await deploymentId(ctx.origin), // must equal --deployment on head
    reset: { scopeId: ctx.scopeId, verified: await resetLooksClean(ctx.origin, ctx.scopeId) },
    cleanup: async () => removeScopedData(ctx.origin, ctx.scopeId),
  };
};
```

- Preparation: reset the data this journey touches, scoped to `ctx.scopeId`.
- Verification: `reset` must echo this execution's `scopeId` and `verified: true`, based on reading the state back, not on an HTTP `200` from the reset call. A missing, unscoped, or failed verification is invalid isolation.
- Identity: `revision` and `deployment` prove which build the origin serves. A mismatch means the comparison would test the wrong code.
- Cleanup: runs after the execution. If it throws, the scope may be contaminated and the execution counts as an error.

Hooks run under the run's time limit. Their error messages are never printed, and values they read through `ctx.env` are redacted from replay failure text.

### Verdicts

Executions run in order base, head, then, only when head fails, base and head again: at most four browser executions. There is no cached baseline.

| Result | Meaning |
| --- | --- |
| `regression` | The approved script passed on base and failed on head at the same step in both the initial and the confirmation round (exit 1); a different or unknown failing step is `inconclusive` |
| `no_regression` | Base and head both passed. It means no approved regression was detected in this script, nothing more (exit 0) |
| `inconclusive` | Missing provenance or hooks, a baseline failure, invalid isolation, a wrong revision or deployment, a hook, setup, cleanup, or environment error, or a confirmation that disagreed (exit 0) |

`--json` prints `runId`, `base`, `head`, `provenance`, `outcome`, `reason`, and `executions[] {side, status, durationMs, failure}`. Save it as the report for `cohort publish`.

## cohort publish

```sh
GITHUB_TOKEN=… cohort publish <compare-report.json> [--evidence <https-url>] [--json]
```

- Reads only the report and `GITHUB_TOKEN` (and `GITHUB_API_URL` on GitHub Enterprise). It needs no bundle, no project, and no LLM key.
- Validates the report's shape and provenance before any of it reaches a comment, and Markdown-escapes every text field.
- Rechecks the pull request through the GitHub REST API, before reading comments and again right before writing. When its head is no longer `--head-sha`, or it comes from another repository, it posts nothing and returns `action: "skipped"`, so a stale run never replaces a current result.
- Updates the one bot-authored comment that starts with `<!-- cohort-compare:<run-id> -->` (one per pull request and journey), or creates it.
- The comment names the revisions and deployment, links `--evidence` (for example the workflow run), and states that artifacts are private to repository readers and expire with their retention.
- `--json` prints `action` (`created`, `updated`, `skipped`), `reason`, and `commentId`. An API failure exits 1 with code `publish_failed`.

## Trusted workflow

Same-repository pull requests only. Permissions start empty and each job gets only what it needs. The compare job checks out the base revision, so hooks and setup modules come from reviewed code, and never sees the pull request's code. The publish job holds `pull-requests: write` and nothing else, with no LLM key or application secret.

Before using it, set repository variables: `COHORT_APPROVED_RUN` (the run ID), `COHORT_APPROVED_SHA256` (`sha256:` plus the hex digest of its `manifest.json`), and `COHORT_APPROVED_ARTIFACT_RUN` (the workflow run whose `lab-runs` artifact holds it). Replace the origins and the `--deployment` value with your preview scheme.

```yaml
name: Journey check
on: pull_request

permissions: {}

jobs:
  compare:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - uses: actions/download-artifact@v4
        with:
          name: lab-runs
          path: .cohort/runs/
          run-id: ${{ vars.COHORT_APPROVED_ARTIFACT_RUN }}
          github-token: ${{ github.token }}
      - env:
          RUN_ID: ${{ vars.COHORT_APPROVED_RUN }}
          APPROVED: ${{ vars.COHORT_APPROVED_SHA256 }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          npx cohort compare "$RUN_ID" --base https://staging.example.com --head "https://pr-$PR.preview.example.com" \
            --repo "$REPO" --pr "$PR" --base-sha "$BASE_SHA" --head-sha "$HEAD_SHA" --deployment "pr-$PR" \
            --approved "$APPROVED" --hooks .cohort/setup/compare-hooks.ts --json > "$RUNNER_TEMP/compare.json" \
            || [ $? -eq 1 ]
      - uses: actions/upload-artifact@v4
        with:
          name: cohort-compare
          path: ${{ runner.temp }}/compare.json
          retention-days: 14

  publish:
    needs: compare
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: cohort-compare
          path: ${{ runner.temp }}/report
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - env:
          GITHUB_TOKEN: ${{ github.token }}
          EVIDENCE: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: npx --yes cohort-lab@0.1.0-rc.0 publish "$RUNNER_TEMP/report/compare.json" --evidence "$EVIDENCE"
```

Notes:

- The comparison is advisory: only a confirmed `regression` exits 1, and the workflow tolerates it so the comment still posts. Remove `|| [ $? -eq 1 ]` to block merges on it.
- Never switch to `pull_request_target` or run fork code with secrets. Fork pull requests are skipped by the `if:` guard and by `cohort publish`.
- The uploaded report is text: verdict, provenance, and the first failure per execution, after replay redaction. No trace, screenshot, or bundle is uploaded. Upload `trace.zip` only by explicit choice; it holds secrets.
- A preview or backend that changes between executions can still make a result wrong; hooks that verify identity and scoped reset are the guard, and anything they cannot confirm is `inconclusive`.
