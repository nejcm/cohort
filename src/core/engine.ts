import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContextOptions, type Page } from 'playwright';
import { generateReplay, replayGaps } from '../evidence/replay.ts';
import { stepsJsonl } from '../evidence/steps.ts';
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';

export interface RunOnceOptions extends Omit<AgentOptions, 'page' | 'hasTouch' | 'screenshotsDir'> {
  outDir: string;
  device: { viewport: { width: number; height: number }; touch: boolean };
  locale: string;
  timezone: string;
  storageState?: BrowserContextOptions['storageState'];
  onPage?: (page: Page) => void;
}

export interface RunOnceResult extends AgentResult {
  tracePath: string | null;
  replayPath: string;
  /** Recorded steps the generated script cannot replay faithfully. */
  replayGaps: string[];
  browserVersion: string;
}

// One fresh browser and context per run, trace started before the first navigation.
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const screenshotsDir = join(options.outDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });
  const tracePath = join(options.outDir, 'trace.zip');
  const replayPath = join(options.outDir, 'replay.spec.ts');
  const allowed = new Set([new URL(options.startUrl).origin, ...options.allowedOrigins]);
  const resources = new Set(options.resourceOrigins ?? []);
  const permitted = (url: string, navigation: boolean): boolean => {
    const { protocol, origin } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return !navigation;
    return allowed.has(origin) || (!navigation && resources.has(origin));
  };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: options.device.viewport,
      hasTouch: options.device.touch,
      locale: options.locale,
      timezoneId: options.timezone,
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...(options.storageState ? { storageState: options.storageState } : {}),
    });
    await context.route('**/*', (route) => {
      const request = route.request();
      return permitted(request.url(), request.isNavigationRequest())
        ? route.fallback()
        : route.abort('blockedbyclient');
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    context.on('page', (popup) => void popup.close());
    // Routes never see redirect hops; CDP Fetch pauses every hop in the page's own process.
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', ({ requestId, request, resourceType }) => {
      const sent = permitted(request.url, resourceType === 'Document')
        ? cdp.send('Fetch.continueRequest', { requestId })
        : cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      sent.catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    options.onPage?.(page);
    const result = await runAgent({ ...options, page, hasTouch: options.device.touch, screenshotsDir });
    let traced: string | null = tracePath;
    try {
      await context.tracing.stop({ path: tracePath });
    } catch (error) {
      traced = null;
      const message = options.secrets.redact((error as Error).message.split('\n')[0]!).slice(0, 200);
      result.issues.push({ code: 'trace_failed', message });
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
    return {
      ...result,
      tracePath: traced,
      replayPath,
      replayGaps: replayGaps(result.steps),
      browserVersion: browser.version(),
    };
  } finally {
    await browser.close();
  }
}
