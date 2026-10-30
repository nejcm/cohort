# Setup modules, saved login, routes, and blockers

Real journeys usually need a signed-in user, a one-time code, or a stubbed vendor. The cohort offers four generic tools for that. None of them knows about a particular app, and all of them are trusted local configuration. The model can never select or edit them.

| Need | Use |
| --- | --- |
| Fresh test data or a signed-in session for each run | A setup module |
| A code, link, or token that only exists mid-journey | A custom tool returned by setup |
| A login you can only do by hand (OAuth, social, SSO) | `cohort login` and a named storage state |
| A third-party call you must stub or cut off | `routes` |

When a run hits something none of these cover, it ends as an evidenced `blocked(kind)` outcome. The run does not try to work around it.

## Setup modules

A setup module is a TypeScript or JavaScript file inside `.cohort/setup/`. You reference it from a persona (`setup: ../setup/x.ts`) or from a suite's defaults. A suite default overrides the persona's setup. The module's default export is called once for every repetition, before the browser opens. Its type, `SetupModule`, is exported from `cohort-lab`:

```ts
import type { SetupModule } from 'cohort-lab';

const setup: SetupModule = async (ctx) => ({
  startUrl, // required absolute URL (runs and replays reject anything else); the run starts here, even if a URL is configured
  storageState, // optional; Playwright storage state for this run's fresh context
  secrets, // optional; { name: value } exposed to the model only as {{name}}
  tools, // optional; custom tools, described below
});
```

- **Scope.** `ctx.scopeId` is unique for each repetition (it is the run ID). Use it to keep test data apart, so that repetitions never share state. Both example modules pass it to the fixture app.
- **Environment.** `ctx.env(name)` reads the environment. Every value read this way is scrubbed from setup errors, cleanup errors, and custom-tool text, even when the module throws right after reading it. Runs and replays share one composition of that scrub (provider keys, values read, bound secrets) in `src/setup/session.ts`.
- **Cleanup.** `ctx.onCleanup(fn)` registers cleanup handlers. They run in reverse order after the run, within min(10 s, the run time cap). Failures and timeouts become `cleanup_failed` and `cleanup_timeout` report issues.
- **Precedence.** Storage state returned by setup overrides a named `storageState`. `resolved-config.json` records `storageState: "setup"` and never stores the state itself.

Examples:

- [`examples/setup/fixture.ts`](../examples/setup/fixture.ts) gives a guest a fresh scope.
- [`examples/setup/fixture-auth.ts`](../examples/setup/fixture-auth.ts) signs in through the fixture's test-only API, returns the session as storage state, and logs the session out in cleanup.
- [`examples/suites/fixture-guest.yml`](../examples/suites/fixture-guest.yml) is the unauthenticated guest suite.

## Custom tools

Setup can return `tools: { name: { description, inputSchema, execute } }`. The model sees these tools beside the built-in ones.

- **Names and schemas.** A name must match `^[a-z][a-z0-9_]{0,63}$` and must not shadow a built-in tool. The input schema must be an object schema that uses only the keywords the harness validator supports: `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `minItems`, `oneOf`, `description`. Each keyword must also use the value form the validator supports: a single `type` string, arrays for `enum`, `required`, and `oneOf`, `additionalProperties: false` only, a `pattern` that compiles as a Unicode regular expression, and finite numbers for the length, range, and item limits. If a module breaks either rule, the run fails as `setup_error`.
- **Arguments.** Arguments are validated against the schema. They are refused if they contain a secret value or a `{{placeholder}}`, because placeholders are substituted only in `fill`.
- **Limits.** Each call runs within min(30 s, the remaining run time). A call that runs longer ends with `tool_timeout`, and its `signal` is aborted. A call counts as one step toward the step cap.
- **Secrets.** `bindSecret(name, value)` registers a value right before it is used and returns `{{name}}`. Binding the same name again replaces the value. Every value ever bound stays masked and redacted for the whole run.
- **Output.** Return `{ text?, secretRefs? }`. Each `secretRefs` value must be a placeholder returned by `bindSecret`. The text is redacted and limited to 2,000 bytes. It is recorded as the step's `output` and shown to the model in its history.

The usual pattern is a tool that fetches a fresh one-time code (email code, SMS code, TOTP) or a magic-link token from your test infrastructure. The model calls the tool, then types `{{code}}` with `fill`. See `request_code` in `examples/setup/fixture-auth.ts`.

**Replay.** `cohort replay` runs the setup module again, then serves its tools to the generated script over a loopback HTTP bridge. The bridge has a random token and closes when the replay ends. Codes are acquired again at replay time instead of being reused.

## Saved login

```sh
cohort login --url https://app.example.test/login --state host-local
```

This opens a headed Chromium window. Log in by hand, then press Enter in the terminal. The session is saved to `.cohort/auth/host-local.json`, written atomically with mode `0600`. A symlinked `.cohort` or `.cohort/auth` is refused.

Reference the saved state from a persona or a suite's defaults with `storageState: host-local`. No setup module is needed. A suite default overrides the persona's value.

`cohort login` never automates CAPTCHAs, and it never puts credentials into prompts or artifacts. The saved file is a credential: `.cohort/auth/` is gitignored, so keep it that way.

The cohort does not guess expiry from the file's age. If a saved login has expired and the app redirects to a known identity provider, the run ends as `blocked(oauth)`, detected by the harness (see below). Run `cohort login` again to refresh it.

## Routes

```yaml
routes:
  - match: https://analytics.example.test/**
    action: block
  - match: https://vendor.example.test/status
    action: fulfill
    status: 200
    contentType: application/json
    body: '{"status":"ok"}'
```

Routes are allowed in `.cohort/config.yml` and in a suite's defaults. The two lists are combined, project rules first. `match` is a Playwright URL glob.

- **No mocking by default.** Third parties are real unless a rule says otherwise.
- **Allowlist.** Rules apply only inside the allowlist. A request the origin guard would refuse is still refused. To stub a vendor, add its origin to `allowedOrigins` (navigations) or `resourceOrigins` (subresources).
- **Reporting.** Every rule appears in every run's report as a `route_blocked` or `route_mocked` issue with its hit count, marked as simulated. Rules are also listed in `resolved-config.json`.
- **Replay.** The generated `replay.spec.ts` installs the same rules.
- **Limit.** Playwright routes do not see redirect hops, so a rule never matches a redirect target.

## External blockers

| Blocker | What happens |
| --- | --- |
| Email/SMS code | A setup custom tool supplies it; otherwise the agent reports `blocked(email_code)` |
| CAPTCHA | `blocked(captcha)`; never solved or bypassed |
| OAuth/social | Use a saved login or setup storage state; otherwise `blocked(oauth)` |
| Payment | Test mode only, through secret bindings (for example vendor test cards); otherwise `blocked(payment)` |
| Third-party outage | `blocked(third_party)` with evidence |
| Anything unclear | `blocked(unknown)` |

`report_blocked` from the agent records `detectedBy: "agent"`. That is an unverified declaration, and reports show it separately.

The harness also detects blockers itself and records `detectedBy: "harness"`. When a top-level navigation is refused by the origin guard and goes to a known blocker host, the run ends as `blocked(kind)` with screenshot evidence, before any further provider call. This covers:

- a link or a model `goto` that redirects;
- a start URL that redirects;
- popups.

The request is aborted before any network contact. Subframes are not counted, because invisible CAPTCHA widgets load on ordinary pages.

### Known blocker hosts (list v1)

This list is in `src/core/blockers.ts`. It is small on purpose and not exhaustive. A host that is not on it is refused as an ordinary disallowed origin, and the agent may report it.

| Kind | Hosts (a leading dot matches any subdomain) |
| --- | --- |
| oauth | `accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, `login.salesforce.com`, `.okta.com`, `.auth0.com`, `.onelogin.com`, `.amazoncognito.com` |
| captcha | `challenges.cloudflare.com`, `.hcaptcha.com` |
| payment | `checkout.stripe.com`, `www.paypal.com`, `pay.google.com` |

A model `goto` straight to one of these hosts is recorded as `navigation_denied` and also ends the run as a harness-detected `blocked(kind)`, because the destination is never allowed. Route rules (including `**/*`) cannot hide these navigations from the harness.
