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

function installMasks({
  secrets,
  selectors,
  color,
}: {
  secrets: string[];
  selectors: string[];
  color: string;
}): number {
  const rects: DOMRect[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll(['[data-lab-masked]', ...selectors].join(',')))
      rects.push(...element.getClientRects());
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
      if (secrets.some((secret) => field.value.includes(secret))) rects.push(...field.getClientRects());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!secrets.some((secret) => node.nodeValue?.includes(secret))) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...range.getClientRects());
    }
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  const host = document.createElement('div');
  host.dataset.labOverlay = '';
  host.setAttribute('popover', 'manual');
  host.style.cssText =
    'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;padding:0;overflow:visible;background:transparent;pointer-events:none;z-index:2147483647;display:block';
  for (const rect of rects) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${rect.left - 2}px;top:${rect.top - 2}px;width:${rect.width + 4}px;height:${rect.height + 4}px;background:${color}`;
    host.append(box);
  }
  document.documentElement.append(host);
  // The top layer keeps the overlay above modal dialogs and popovers opened earlier.
  host.showPopover?.();
  return rects.length;
}

function removeMasks(): void {
  for (const overlay of document.querySelectorAll('[data-lab-overlay]')) overlay.remove();
}

// Masks registered secrets and configured regions in every frame, then captures; any inspection failure throws instead of capturing.
export async function captureMasked(
  page: Page,
  options: { secrets: string[]; maskSelectors: string[]; maxWidth: number },
): Promise<Capture> {
  const viewport = page.viewportSize();
  if (!viewport) throw new MaskError('page has no fixed viewport');
  const color = `rgb(${MASK_RGB.join(',')})`;
  let maskedRegions = 0;
  try {
    for (const frame of page.frames())
      maskedRegions += await frame.evaluate(installMasks, {
        secrets: options.secrets,
        selectors: options.maskSelectors,
        color,
      });
  } catch (error) {
    await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
    throw new MaskError(`could not apply secret masks: ${(error as Error).message.split('\n')[0]}`);
  }
  const cdp = await page.context().newCDPSession(page);
  try {
    const { pageX, pageY } = await page.evaluate(() => ({
      pageX: visualViewport?.pageLeft ?? 0,
      pageY: visualViewport?.pageTop ?? 0,
    }));
    const scale = Math.min(1, options.maxWidth / viewport.width);
    const { data } = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: pageX, y: pageY, width: viewport.width, height: viewport.height, scale },
    })) as { data: string };
    const png = Buffer.from(data, 'base64');
    return { png, ...pngSize(png), viewport, maskedRegions };
  } finally {
    await cdp.detach().catch(() => {});
    await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
  }
}
