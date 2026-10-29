import { isTokenLike } from '../setup/secrets.ts';
import { renderLocator } from '../browser/targets.ts';
import type { RouteRule } from '../config/files.ts';
import type { StepRecord } from './steps.ts';

export interface ReplaySession {
  runId: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
  locale: string;
  timezone: string;
  /** Names of trusted setup tools; their steps replay through the bridge `cohort replay` serves. */
  customTools?: readonly string[];
  routes?: readonly RouteRule[];
}

const j = JSON.stringify;

function value(raw: unknown): string {
  const text = String(raw);
  return /\{\{[a-z][a-z0-9_]*\}\}/u.test(text) ? `bind(${j(text)})` : j(text);
}

// Absolute same-origin URLs are rebased onto the replay's start URL so replays and comparisons stay on their target.
function gotoUrl(raw: unknown, start: string | undefined): string {
  const text = String(raw);
  const url = /^([a-z][a-z\d+.-]*:|\/\/)/iu.test(text) ? URL.parse(text, start) : null;
  return url && url.origin === URL.parse(String(start))?.origin
    ? `inheritQuery(new URL(${j(url.pathname + url.search + url.hash)}, binding('COHORT_START_URL')))`
    : `inheritQuery(new URL(${j(text)}, page.url()))`;
}

function statement(
  step: StepRecord,
  hasTouch: boolean,
  customTools: readonly string[] = [],
  start?: string,
): string | null {
  const args = step.action.args;
  if (customTools.includes(step.action.name)) return `await customTool(${j(step.action.name)}, ${j(args)});`;
  const redacted = ['deltaX', 'deltaY', 'ms'].find((key) => key in args && !Number.isFinite(Number(args[key])));
  if (redacted)
    return `throw new Error(${j(`${step.id}: argument ${redacted} was redacted; this step cannot replay`)});`;
  const wheel = `await page.mouse.wheel(${Number(args.deltaX)}, ${Number(args.deltaY)});`;
  if (!step.target) {
    switch (step.action.name) {
      case 'press':
        return `await page.keyboard.press(${j(args.key)});`;
      case 'type':
        if (step.recipient === undefined)
          return `throw new Error(${j(`${step.id}: the focused element had no unique locator; this step cannot replay`)});`;
        return `${step.recipient ? `await expect(${renderLocator(step.recipient)}).toBeFocused();\n    ` : ''}await page.keyboard.type(${value(args.text)});`;
      case 'scroll':
        return `await page.mouse.move(viewport.width / 2, viewport.height / 2);\n    ${wheel}`;
      case 'goto':
        return `await page.goto(${gotoUrl(args.url, start)});`;
      case 'wait':
        return `await page.waitForTimeout(${Number(args.ms)});`;
      default:
        return null;
    }
  }
  const locator = renderLocator(step.target.locator);
  const position = `{ position: ${j(step.target.position)} }`;
  switch (step.action.name) {
    case 'click':
      return hasTouch ? `await tap(${locator}, ${j(step.target.position)});` : `await ${locator}.click(${position});`;
    case 'fill':
      return step.target.tag === 'select'
        ? `await ${locator}.selectOption({ label: ${value(args.value)} });`
        : `await ${locator}.fill(${value(args.value)});`;
    case 'scroll':
      return `await ${locator}.hover(${position});\n    ${wheel}`;
    default:
      return null;
  }
}

/** Step IDs whose recorded arguments cannot be replayed faithfully. */
export function replayGaps(steps: readonly StepRecord[]): string[] {
  return steps
    .filter((step) => step.result.status === 'ok' && statement(step, false)?.startsWith('throw '))
    .map((step) => step.id);
}

/** Generates a standalone Playwright test from recorded steps; secrets stay as placeholders bound from the environment. */
export function generateReplay(session: ReplaySession, steps: readonly StepRecord[]): string {
  const body: string[] = [];
  const answered = steps.filter((step) => step.result.status === 'ok' && step.action.name === 'dialog');
  const track = (id: string): string => (answered.length > 0 ? `current = ${j(id)};\n    ` : '');
  const start = steps.find((step) => step.action.name === 'navigate')?.action.args.url as string | undefined;
  for (const step of steps) {
    if (step.result.status !== 'ok') continue;
    if (step.action.name === 'navigate') {
      body.push(
        `  await test.step(${j(`${step.id} navigate`)}, async () => {\n    ${track(step.id)}await page.goto(binding('COHORT_START_URL'));\n  });`,
      );
      continue;
    }
    const code = statement(step, session.hasTouch, session.customTools, start);
    if (code)
      body.push(
        `  await test.step(${j(`${step.id} ${step.action.name}`)}, async () => {\n    ${track(step.id)}${code}\n  });`,
      );
  }
  const custom = steps.some((step) => step.result.status === 'ok' && session.customTools?.includes(step.action.name));
  const tap = body.some((line) => line.includes('await tap('));
  const routes = (session.routes ?? []).map(
    (rule) =>
      `  await page.route(${j(rule.match)}, (route) => ${rule.action === 'block' ? "route.abort('blockedbyclient')" : `route.fulfill(${j({ status: rule.status ?? 200, contentType: rule.contentType ?? 'text/plain', body: rule.body ?? '' })})`});`,
  );
  const answers = answered.map(({ action: { args }, dialog }) =>
    j({
      step: dialog?.openedBy ?? null,
      type: dialog?.type ?? null,
      message: dialog && !dialog.message.includes('[redacted]') ? dialog.message : null,
      accept: args.action === 'accept',
      text: args.text === undefined ? null : String(args.text),
    }),
  );
  if (answers.length > 0) routes.push(DIALOGS.replace('ANSWERS', answers.join(',\n    ')));
  return `import { expect, test${tap ? ', type Locator' : ''} } from '@playwright/test';

const viewport = ${j(session.viewport)};

function binding(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`missing replay binding \${name}\`);
  return value;
}

const isTokenLike = ${isTokenLike.toString()};

function inheritQuery(url: URL): string {
  const start = new URL(binding('COHORT_START_URL'));
  if (url.origin !== start.origin || url.search) return url.href;
  const hidden = Object.entries(process.env).filter(([name, value]) => value && /^COHORT_(SECRET_|TOOL_TOKEN)/.test(name)).map(([, value]) => value as string);
  for (const [name, value] of start.searchParams) if (!isTokenLike(value) && !hidden.some((secret) => value.includes(secret))) url.searchParams.append(name, value);
  return url.href;
}

function bind(template: string): string {
  return template.replace(/\\{\\{([a-z][a-z0-9_]*)\\}\\}/g, (_, name: string) => binding(\`COHORT_SECRET_\${name.toUpperCase()}\`));
}

${custom ? CUSTOM_TOOL_CLIENT : ''}test.use({
  viewport,
  hasTouch: ${session.hasTouch},
  locale: ${j(session.locale)},
  timezoneId: ${j(session.timezone)},
  ...(process.env.COHORT_STORAGE_STATE ? { storageState: process.env.COHORT_STORAGE_STATE } : {}),
});

test(${j(`replay ${session.runId}`)}, async ({ page }) => {
${tap ? TAP : ''}${[...routes, ...body].join('\n')}
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});${answers.length > 0 ? `\n  expect(unexpectedDialogs).toEqual([]);\n  expect(dialogs).toEqual([]);` : ''}
});
`;
}

// Bound secrets come back as values and land in the environment `bind` reads; the bridge lives only for this replay.
const CUSTOM_TOOL_CLIENT = `async function customTool(name: string, args: unknown): Promise<void> {
  const response = await fetch(binding('COHORT_TOOL_BRIDGE'), {
    method: 'POST',
    headers: { authorization: \`Bearer \${binding('COHORT_TOOL_TOKEN')}\`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const result = (await response.json()) as { bound?: Record<string, string>; error?: string };
  if (!response.ok) throw new Error(\`custom tool \${name} failed: \${result.error}\`);
  for (const [secret, value] of Object.entries(result.bound ?? {})) process.env[\`COHORT_SECRET_\${secret.toUpperCase()}\`] = value;
}

`;

// Unlike click, Playwright's tap does not wait for a navigation it starts; the live run waited for it.
const TAP = `  async function tap(locator: Locator, position: { x: number; y: number }): Promise<void> {
    let navigated: Promise<unknown> | undefined;
    const onRequest = (request: { isNavigationRequest(): boolean; frame(): unknown }): void => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        navigated ??= page
          .waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame(), timeout: 10_000 })
          .catch(() => {});
    };
    page.on('request', onRequest);
    try {
      await locator.tap({ position });
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))).catch(() => {});
    } finally {
      page.off('request', onRequest);
    }
    if (navigated) {
      await navigated;
      await page.waitForLoadState('domcontentloaded');
    }
  }

`;

// Answers are matched to the step that opened them and bound only when used, after custom tools may have supplied secrets.
const DIALOGS = `  let current = '';
  const unexpectedDialogs: string[] = [];
  const dialogs: { step: string | null; type: string | null; message: string | null; accept: boolean; text: string | null }[] = [
    ANSWERS,
  ];
  page.on('dialog', (dialog) => {
    const answer = dialogs[0];
    if (!answer || answer.step !== current || answer.type !== dialog.type() || (answer.message !== null && answer.message !== dialog.message())) {
      unexpectedDialogs.push(\`\${dialog.type()} during \${current}\`);
      void dialog.dismiss();
      return;
    }
    dialogs.shift();
    void (answer.accept ? dialog.accept(answer.text === null ? undefined : bind(answer.text)) : dialog.dismiss());
  });`;
