import { renderLocator } from '../browser/targets.ts';
import type { RouteRule } from '../config/files.ts';
import type { StepRecord } from './steps.ts';

export interface ReplaySession {
  runId: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
  locale: string;
  timezone: string;
  /** Names of trusted setup tools; their steps replay through the bridge `lab replay` serves. */
  customTools?: readonly string[];
  routes?: readonly RouteRule[];
}

const j = JSON.stringify;

function value(raw: unknown): string {
  const text = String(raw);
  return /\{\{[a-z][a-z0-9_]*\}\}/u.test(text) ? `bind(${j(text)})` : j(text);
}

function statement(step: StepRecord, hasTouch: boolean, customTools: readonly string[] = []): string | null {
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
      case 'scroll':
        return `await page.mouse.move(viewport.width / 2, viewport.height / 2);\n    ${wheel}`;
      case 'goto':
        return `await page.goto(new URL(${j(args.url)}, page.url()).href);`;
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
      return `await ${locator}.${hasTouch ? 'tap' : 'click'}(${position});`;
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
  for (const step of steps) {
    if (step.result.status !== 'ok') continue;
    if (step.action.name === 'navigate') {
      body.push(
        `  await test.step(${j(`${step.id} navigate`)}, async () => {\n    await page.goto(binding('LAB_START_URL'));\n  });`,
      );
      continue;
    }
    const code = statement(step, session.hasTouch, session.customTools);
    if (code) body.push(`  await test.step(${j(`${step.id} ${step.action.name}`)}, async () => {\n    ${code}\n  });`);
  }
  const custom = steps.some((step) => step.result.status === 'ok' && session.customTools?.includes(step.action.name));
  const routes = (session.routes ?? []).map(
    (rule) =>
      `  await page.route(${j(rule.match)}, (route) => ${rule.action === 'block' ? "route.abort('blockedbyclient')" : `route.fulfill(${j({ status: rule.status ?? 200, contentType: rule.contentType ?? 'text/plain', body: rule.body ?? '' })})`});`,
  );
  return `import { test } from '@playwright/test';

const viewport = ${j(session.viewport)};

function binding(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`missing replay binding \${name}\`);
  return value;
}

function bind(template: string): string {
  return template.replace(/\\{\\{([a-z][a-z0-9_]*)\\}\\}/g, (_, name: string) => binding(\`LAB_SECRET_\${name.toUpperCase()}\`));
}

${custom ? CUSTOM_TOOL_CLIENT : ''}test.use({
  viewport,
  hasTouch: ${session.hasTouch},
  locale: ${j(session.locale)},
  timezoneId: ${j(session.timezone)},
  ...(process.env.LAB_STORAGE_STATE ? { storageState: process.env.LAB_STORAGE_STATE } : {}),
});

test(${j(`replay ${session.runId}`)}, async ({ page }) => {
${[...routes, ...body].join('\n')}
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
});
`;
}

// Bound secrets come back as values and land in the environment `bind` reads; the bridge lives only for this replay.
const CUSTOM_TOOL_CLIENT = `async function customTool(name: string, args: unknown): Promise<void> {
  const response = await fetch(binding('LAB_TOOL_BRIDGE'), {
    method: 'POST',
    headers: { authorization: \`Bearer \${binding('LAB_TOOL_TOKEN')}\`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const result = (await response.json()) as { bound?: Record<string, string>; error?: string };
  if (!response.ok) throw new Error(\`custom tool \${name} failed: \${result.error}\`);
  for (const [secret, value] of Object.entries(result.bound ?? {})) process.env[\`LAB_SECRET_\${secret.toUpperCase()}\`] = value;
}

`;
