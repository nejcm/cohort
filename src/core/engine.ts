import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { generateReplay } from '../evidence/replay.ts';
import { stepsJsonl } from '../evidence/steps.ts';
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';

export interface RunOnceOptions extends Omit<AgentOptions, 'page' | 'hasTouch' | 'screenshotsDir'> {
  outDir: string;
  device: { viewport: { width: number; height: number }; touch: boolean };
  locale: string;
  timezone: string;
  onPage?: (page: Page) => void;
}

export interface RunOnceResult extends AgentResult {
  tracePath: string;
  replayPath: string;
}

// Phase 0 spike engine: one fresh context per run, trace started before the first navigation.
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const screenshotsDir = join(options.outDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });
  const tracePath = join(options.outDir, 'trace.zip');
  const replayPath = join(options.outDir, 'replay.spec.ts');
  const allowed = new Set([new URL(options.startUrl).origin, ...options.allowedOrigins]);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: options.device.viewport,
      hasTouch: options.device.touch,
      locale: options.locale,
      timezoneId: options.timezone,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', (route) => {
      const request = route.request();
      const origin = new URL(request.url()).origin;
      if (
        request.isNavigationRequest() &&
        request.frame() === request.frame().page().mainFrame() &&
        !allowed.has(origin)
      )
        return route.abort('blockedbyclient');
      return route.fallback();
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    options.onPage?.(page);
    let result: AgentResult;
    try {
      result = await runAgent({ ...options, page, hasTouch: options.device.touch, screenshotsDir });
    } finally {
      await context.tracing.stop({ path: tracePath });
    }
    await writeFile(join(options.outDir, 'steps.jsonl'), stepsJsonl(result.steps), { mode: 0o600 });
    await writeFile(
      replayPath,
      generateReplay(
        {
          runId: options.runId,
          viewport: options.device.viewport,
          hasTouch: options.device.touch,
          locale: options.locale,
          timezone: options.timezone,
        },
        result.steps,
      ),
      { mode: 0o600 },
    );
    return { ...result, tracePath, replayPath };
  } finally {
    await browser.close();
  }
}
