import type { Page } from 'playwright';

export const MASK_RGB = [255, 0, 255] as const;

export class MaskError extends Error {
  override name = 'MaskError';
}

export interface Capture {
  png: Buffer;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  maskedRegions: number;
}

export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

type Rect = [number, number, number, number];

function scanMasks({ secrets, selectors }: { secrets: string[]; selectors: string[] }): Rect[] {
  const rects: Rect[] = [];
  const masked = ['[data-lab-masked]', ...selectors].join(',');
  const hit = (text: string | null | undefined): boolean =>
    Boolean(text) && secrets.some((secret) => text!.includes(secret));
  const rendered = ['placeholder', 'value', 'alt', 'title', 'aria-label'];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll('*')) {
      if (element.closest('[data-lab-overlay]')) continue;
      const exposed =
        element.matches(masked) ||
        ('value' in element && hit(String(element.value))) ||
        [...element.attributes].some((attribute) => rendered.includes(attribute.name) && hit(attribute.value)) ||
        // The deepest element holding the whole secret also catches values split across text nodes.
        (hit(element.textContent) && ![...element.children].some((child) => hit(child.textContent)));
      if (exposed)
        for (const rect of element.getClientRects()) rects.push([rect.left, rect.top, rect.width, rect.height]);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return rects;
}

function drawMasks({ rects, color }: { rects: Rect[]; color: string }): void {
  const host = document.createElement('div');
  host.dataset.labOverlay = '';
  host.setAttribute('popover', 'manual');
  host.style.cssText =
    'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;padding:0;overflow:visible;background:transparent;pointer-events:none;z-index:2147483647;display:block';
  for (const [left, top, width, height] of rects) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${left - 2}px;top:${top - 2}px;width:${width + 4}px;height:${height + 4}px;background:${color}`;
    host.append(box);
  }
  document.documentElement.append(host);
  // The top layer keeps the overlay above modal dialogs and popovers opened earlier.
  host.showPopover?.();
}

function removeMasks(): void {
  for (const overlay of document.querySelectorAll('[data-lab-overlay]')) overlay.remove();
}

async function scanFrames(page: Page, options: { secrets: string[]; maskSelectors: string[] }) {
  const frames = page.frames();
  const rects = await Promise.all(
    frames.map((frame) => frame.evaluate(scanMasks, { secrets: options.secrets, selectors: options.maskSelectors })),
  );
  return { frames, rects, signature: JSON.stringify([frames.map((frame) => frame.url()), rects]) };
}

const CAPTURE_ATTEMPTS = 3;
const CAPTURE_TIMEOUT_MS = 10_000;

// Masks registered secrets and configured regions in every frame, then captures; rescans after capture and fails closed if anything changed.
export async function captureMasked(
  page: Page,
  options: { secrets: string[]; maskSelectors: string[]; maxWidth: number },
): Promise<Capture> {
  const viewport = page.viewportSize();
  if (!viewport) throw new MaskError('page has no fixed viewport');
  const color = `rgb(${MASK_RGB.join(',')})`;
  const failure = (error: unknown) =>
    new MaskError(`could not apply secret masks: ${(error as Error).message.split('\n')[0]}`);
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    let capture: Capture;
    let before: Awaited<ReturnType<typeof scanFrames>>;
    try {
      before = await scanFrames(page, options);
      await Promise.all(
        before.frames.map((frame, index) => frame.evaluate(drawMasks, { rects: before.rects[index]!, color })),
      );
    } catch (error) {
      await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
      throw failure(error);
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      const { pageX, pageY } = await page.evaluate(() => ({
        pageX: visualViewport?.pageLeft ?? 0,
        pageY: visualViewport?.pageTop ?? 0,
      }));
      const scale = Math.min(1, options.maxWidth / viewport.width);
      const shot = async () => {
        // CDP capture can hang right after a navigation commit until the renderer has produced a frame.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        return (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: pageX, y: pageY, width: viewport.width, height: viewport.height, scale },
        })) as { data: string };
      };
      let timer: NodeJS.Timeout | undefined;
      const { data } = await Promise.race([
        shot(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MaskError('screenshot capture timed out')), CAPTURE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      const png = Buffer.from(data, 'base64');
      capture = { png, ...pngSize(png), viewport, maskedRegions: before.rects.flat().length };
    } finally {
      await cdp.detach().catch(() => {});
      await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
    }
    let after: string;
    try {
      after = (await scanFrames(page, options)).signature;
    } catch (error) {
      throw failure(error);
    }
    // shortcut: a change that appears and disappears between the two scans is not detected; add a mutation observer if that matters.
    if (after === before.signature) return capture;
  }
  throw new MaskError('page changed during masked capture; image discarded');
}
