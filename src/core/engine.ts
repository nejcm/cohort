import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContextOptions, type Page, type Request, type Route } from 'playwright';
import type { RouteRule } from '../config/files.ts';
import { generateReplay, replayGaps } from '../evidence/replay.ts';
import { stepsJsonl } from '../evidence/steps.ts';
import { runAgent, type AgentOptions, type AgentResult } from './agent.ts';

export interface RunOnceOptions extends Omit<AgentOptions, 'page' | 'hasTouch' | 'screenshotsDir'> {
  outDir: string;
  device: { viewport: { width: number; height: number }; touch: boolean };
  locale: string;
  timezone: string;
  storageState?: BrowserContextOptions['storageState'];
  /** Trusted block/mock rules; they apply only inside the allowlist and every one is reported. */
  routes?: readonly RouteRule[];
  onPage?: (page: Page) => void;
}

export interface RunOnceResult extends AgentResult {
  tracePath: string | null;
  replayPath: string;
  /** Recorded steps the generated script cannot replay faithfully. */
  replayGaps: string[];
  browserVersion: string;
}

// A popup's first request has no frame yet; it is a top-level navigation.
function topLevel(request: Request): boolean {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return true;
  }
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
    const denied: string[] = [];
    const guard = (route: Route): Promise<void> | undefined => {
      const request = route.request();
      if (permitted(request.url(), request.isNavigationRequest())) return undefined;
      if (request.isNavigationRequest() && topLevel(request)) denied.push(request.url());
      return route.abort('blockedbyclient');
    };
    await context.route('**/*', (route) => guard(route) ?? route.fallback());
    const routes = options.routes ?? [];
    const hits = routes.map(() => 0);
    // Later registrations take precedence, so each rule runs before the guard above and re-checks the allowlist.
    for (const [index, rule] of routes.entries())
      await context.route(rule.match, (route) => {
        const blocked = guard(route);
        if (blocked) return blocked;
        hits[index]! += 1;
        return rule.action === 'block'
          ? route.abort('blockedbyclient')
          : route.fulfill({
              status: rule.status ?? 200,
              contentType: rule.contentType ?? 'text/plain',
              body: rule.body ?? '',
            });
      });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    context.on('page', (popup) => void popup.close());
    // Routes never see redirect hops; CDP Fetch pauses every hop in the page's own process.
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    cdp.on('Fetch.requestPaused', ({ requestId, request, resourceType, frameId }) => {
      const ok = permitted(request.url, resourceType === 'Document');
      if (!ok && resourceType === 'Document' && frameId === frameTree.frame.id) denied.push(request.url);
      const sent = ok
        ? cdp.send('Fetch.continueRequest', { requestId })
        : cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      sent.catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    options.onPage?.(page);
    const result = await runAgent({
      ...options,
      page,
      hasTouch: options.device.touch,
      screenshotsDir,
      deniedNavigations: denied,
    });
    for (const [index, rule] of routes.entries())
      result.issues.push({
        code: rule.action === 'block' ? 'route_blocked' : 'route_mocked',
        message: options.secrets.redact(
          `${rule.action === 'block' ? 'blocked' : `mocked (${rule.status ?? 200})`} ${rule.match}: ${hits[index]} request(s); simulated, not a real integration result`,
        ),
      });
    let traced: string | null = tracePath;
    try {
      await context.tracing.stop({ path: tracePath });
      await chmod(tracePath, 0o600);
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
          customTools: Object.keys(options.customTools ?? {}),
          routes,
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
