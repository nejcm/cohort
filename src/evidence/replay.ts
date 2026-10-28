import { renderLocator } from '../browser/targets.ts';
import type { StepRecord } from './steps.ts';

export interface ReplaySession {
  runId: string;
  viewport: { width: number; height: number };
  hasTouch: boolean;
  locale: string;
  timezone: string;
}

const j = JSON.stringify;

function value(raw: unknown): string {
  const text = String(raw);
  return /\{\{[a-z][a-z0-9_]*\}\}/u.test(text) ? `bind(${j(text)})` : j(text);
}

function statement(step: StepRecord, hasTouch: boolean): string | null {
  const args = step.action.args;
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
    const code = statement(step, session.hasTouch);
    if (code) body.push(`  await test.step(${j(`${step.id} ${step.action.name}`)}, async () => {\n    ${code}\n  });`);
  }
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

test.use({ viewport, hasTouch: ${session.hasTouch}, locale: ${j(session.locale)}, timezoneId: ${j(session.timezone)} });

test(${j(`replay ${session.runId}`)}, async ({ page }) => {
${body.join('\n')}
  await page.waitForLoadState('networkidle');
});
`;
}
