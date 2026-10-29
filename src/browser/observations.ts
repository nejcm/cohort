import type { BrowserContext, Frame, Page } from 'playwright';

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

const GUARD_KEY = 'cohort.guard';

interface Guard {
  roots: WeakMap<Element, ShadowRoot>;
  changes: number;
  attached: number;
}

// Init script: counts DOM changes that MutationObserver misses and keeps every shadow root, closed ones included, reachable for scanning.
function guardMasks(key: string): void {
  const store = globalThis as unknown as Record<symbol, Guard | undefined>;
  const id = Symbol.for(key);
  if (store[id]) return;
  const guard: Guard = { roots: new WeakMap(), changes: 0, attached: 0 };
  store[id] = guard;
  // Adopted nodes keep their creating realm's prototype, so changes are reported to the guard of the element's current document.
  const guardOf = (node: Node): Guard =>
    (node.ownerDocument?.defaultView as unknown as Record<symbol, Guard | undefined> | null)?.[id] ?? guard;
  const bump = (): void => void (guard.changes += 1);
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    const read = Object.getOwnPropertyDescriptor(proto, 'value')!.get!;
    const counted = <T extends unknown[], R>(write: (...args: T) => R) =>
      function (this: HTMLInputElement, ...args: T): R {
        const before = read.call(this);
        try {
          return write.apply(this, args);
        } finally {
          if (this.isConnected && read.call(this) !== before) guardOf(this).changes += 1;
        }
      };
    for (const name of ['value', 'valueAsNumber', 'valueAsDate']) {
      const property = Object.getOwnPropertyDescriptor(proto, name);
      if (property?.set) Object.defineProperty(proto, name, { ...property, set: counted(property.set) });
    }
    const methods = proto as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ['setRangeText', 'stepUp', 'stepDown'])
      if (name in proto) methods[name] = counted(methods[name]!);
  }
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    const owner = guardOf(this);
    owner.roots.set(this, root);
    guard.roots.set(this, root);
    // A root on a detached host only renders once inserted, which the MutationObserver sees.
    owner.attached += 1;
    if (this.isConnected) owner.changes += 1;
    return root;
  };
  // Synthetic input events change nothing; trusted ones cover edits that bypass the setters, such as execCommand.
  addEventListener('input', (event) => event.isTrusted && bump(), true);
}

/** Installs the mask guard in every later document of the context; captures fail closed in frames without it. */
export async function installMaskGuard(context: BrowserContext): Promise<void> {
  await context.addInitScript(guardMasks, GUARD_KEY);
}

// Declarative closed roots bypass attachShadow, so the guard cannot reach them; CDP still sees them, and any it finds fail the capture.
async function assertShadowRootsReachable(page: Page): Promise<void> {
  const check = `function () { return globalThis[Symbol.for(${JSON.stringify(GUARD_KEY)})]?.roots.has(this) === true; }`;
  for (const target of [page, ...page.frames().slice(1)]) {
    // Only out-of-process frames get their own session; the rest are pierced from their parent's document.
    const cdp = await page
      .context()
      .newCDPSession(target)
      .catch(() => null);
    if (!cdp) continue;
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const hosts: number[] = [];
      const walk = (node: typeof root): void => {
        for (const shadow of node.shadowRoots ?? []) {
          if (shadow.shadowRootType === 'closed') hosts.push(node.backendNodeId);
          walk(shadow);
        }
        for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])])
          walk(child);
      };
      walk(root);
      for (const backendNodeId of hosts) {
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
        const { result } = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId!,
          functionDeclaration: check,
          returnByValue: true,
        });
        if (result.value !== true) throw new MaskError('a closed shadow root cannot be scanned');
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
}

function scanMasks({ secrets, selectors, key }: { secrets: string[]; selectors: string[]; key: string }): Rect[] {
  const guard = (globalThis as unknown as Record<symbol, Guard | undefined>)[Symbol.for(key)];
  if (!guard) throw new Error('mask guard missing in frame');
  const rects: Rect[] = [];
  const masked = ['[data-cohort-masked]', ...selectors].join(',');
  const hit = (text: string | null | undefined): boolean =>
    Boolean(text) && secrets.some((secret) => text!.includes(secret));
  const rendered = ['placeholder', 'value', 'alt', 'title', 'aria-label'];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll('*')) {
      if (element.closest('[data-cohort-overlay]')) continue;
      const exposed =
        element.matches(masked) ||
        ('value' in element && hit(String(element.value))) ||
        [...element.attributes].some((attribute) => rendered.includes(attribute.name) && hit(attribute.value)) ||
        // The deepest element holding the whole secret also catches values split across text nodes.
        (hit(element.textContent) && ![...element.children].some((child) => hit(child.textContent)));
      if (exposed) {
        // Content rects cover text whose element has no box of its own, such as `display: contents`.
        const contents = document.createRange();
        contents.selectNodeContents(element);
        for (const rect of [...element.getClientRects(), ...contents.getClientRects()])
          rects.push([rect.left, rect.top, rect.width, rect.height]);
      }
      const shadow = element.shadowRoot ?? guard.roots.get(element);
      if (shadow) visit(shadow);
    }
  };
  visit(document);
  return rects;
}

export const WATCH_KEY = 'cohort.watch';

interface Watch {
  observer: MutationObserver;
  records: MutationRecord[];
  scrolled: boolean;
  onScroll: () => void;
  rects: WeakMap<Element, string>;
  changes: number;
  attached: number;
}

// Starts recording DOM mutations and scrolls in this document and its shadow roots, replacing any earlier watch; true when a declarative closed root may have appeared since the last one.
function armWatch({ key, guardKey }: { key: string; guardKey: string }): boolean {
  const store = globalThis as unknown as Record<symbol, Watch | undefined>;
  const guard = (globalThis as unknown as Record<symbol, Guard | undefined>)[Symbol.for(guardKey)];
  const id = Symbol.for(key);
  const previous = store[id];
  const stale =
    !previous ||
    !guard ||
    previous.attached !== guard.attached ||
    [...previous.records, ...previous.observer.takeRecords()].some((record) =>
      [...record.addedNodes].some((node) => node instanceof Element && !node.closest('[data-cohort-overlay]')),
    );
  previous?.observer.disconnect();
  if (previous) removeEventListener('scroll', previous.onScroll, true);
  const watch: Watch = {
    observer: new MutationObserver((records) => watch.records.push(...records)),
    records: [],
    scrolled: false,
    onScroll: () => (watch.scrolled = true),
    rects: new WeakMap(),
    changes: guard?.changes ?? -1,
    attached: guard?.attached ?? -1,
  };
  const observe = (root: Document | ShadowRoot): void => {
    watch.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? guard?.roots.get(element);
      if (shadow) observe(shadow);
    }
  };
  observe(document);
  addEventListener('scroll', watch.onScroll, true);
  store[id] = watch;
  return stale;
}

// True when anything but the mask overlay changed since armWatch, or this is a different document; otherwise snapshots element boxes for target checks.
function settleWatch({ key, guardKey }: { key: string; guardKey: string }): boolean {
  const watch = (globalThis as unknown as Record<symbol, Watch | undefined>)[Symbol.for(key)];
  const guard = (globalThis as unknown as Record<symbol, Guard | undefined>)[Symbol.for(guardKey)];
  if (!watch || !guard || guard.changes !== watch.changes) return true;
  const overlaySelector = '[data-cohort-overlay]';
  const overlay = (node: Node): boolean =>
    Boolean((node instanceof Element ? node : node.parentElement)?.closest(overlaySelector));
  const records = [...watch.records, ...watch.observer.takeRecords()];
  const changed =
    watch.scrolled ||
    records.some(
      (record) =>
        !overlay(record.target) &&
        (record.type !== 'childList' || ![...record.addedNodes, ...record.removedNodes].every(overlay)),
    );
  if (changed) return true;
  watch.records = [];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      watch.rects.set(element, `${box.left},${box.top},${box.width},${box.height}`);
      const shadow = element.shadowRoot ?? guard.roots.get(element);
      if (shadow) visit(shadow);
    }
  };
  visit(document);
  return false;
}

/** Page function: true unless the element existed with the same box at the last capture and nothing inside it changed since. */
export function changedSinceCapture(element: Element, key: string): boolean {
  const watch = (globalThis as unknown as Record<symbol, Watch | undefined>)[Symbol.for(key)];
  if (!watch) return true;
  watch.records.push(...watch.observer.takeRecords());
  const box = element.getBoundingClientRect();
  if (watch.rects.get(element) !== `${box.left},${box.top},${box.width},${box.height}`) return true;
  const inside = (node: Node | null): boolean => {
    for (let current = node; current; current = current instanceof ShadowRoot ? current.host : current.parentNode)
      if (current === element) return true;
    return false;
  };
  return watch.records.some((record) => inside(record.target));
}

function drawMasks({ rects, color }: { rects: Rect[]; color: string }): void {
  const host = document.createElement('div');
  host.dataset.cohortOverlay = '';
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
  for (const overlay of document.querySelectorAll('[data-cohort-overlay]')) overlay.remove();
}

async function scanFrames(page: Page, options: { secrets: string[]; maskSelectors: string[] }) {
  const frames = page.frames();
  const rects = await Promise.all(
    frames.map((frame) =>
      frame.evaluate(scanMasks, { secrets: options.secrets, selectors: options.maskSelectors, key: GUARD_KEY }),
    ),
  );
  return { frames, rects, signature: JSON.stringify([frames.map((frame) => frame.url()), rects]) };
}

const CAPTURE_ATTEMPTS = 3;
const CAPTURE_TIMEOUT_MS = 10_000;

// Masks registered secrets and configured regions in every frame, then captures; discards the image and retries if the DOM, scroll, or frames changed meanwhile.
export async function captureMasked(
  page: Page,
  options: { secrets: string[]; maskSelectors: string[]; maxWidth: number },
): Promise<Capture> {
  const viewport = page.viewportSize();
  if (!viewport) throw new MaskError('page has no fixed viewport');
  const color = `rgb(${MASK_RGB.join(',')})`;
  const failure = (error: unknown) =>
    new MaskError(`could not apply secret masks: ${(error as Error).message.split('\n')[0]}`);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    let capture: Capture;
    let before: Awaited<ReturnType<typeof scanFrames>>;
    try {
      const stale = await Promise.all(
        page.frames().map((frame) => frame.evaluate(armWatch, { key: WATCH_KEY, guardKey: GUARD_KEY })),
      );
      before = await scanFrames(page, options);
      if (stale.includes(true)) await assertShadowRootsReachable(page);
      await Promise.all(
        before.frames.map((frame, index) => frame.evaluate(drawMasks, { rects: before.rects[index]!, color })),
      );
    } catch (error) {
      // Frames can detach or navigate mid-scan; retry, and fail closed if it keeps happening.
      await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
      if (error instanceof MaskError) throw error;
      lastError = error;
      continue;
    }
    const cdp = await page.context().newCDPSession(page);
    let onNavigated: ((frame: Frame) => void) | undefined;
    try {
      const scale = Math.min(1, options.maxWidth / viewport.width);
      const shot = async () => {
        // CDP capture can hang right after a navigation commit until the renderer has produced a frame.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const { pageX, pageY } = await page.evaluate(() => ({
          pageX: visualViewport?.pageLeft ?? 0,
          pageY: visualViewport?.pageTop ?? 0,
        }));
        return (await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: pageX, y: pageY, width: viewport.width, height: viewport.height, scale },
        })) as { data: string };
      };
      // A capture that a main-frame commit overtakes never settles or fails outright; retry on the new document.
      const navigated = new Promise<null>((resolve) => {
        onNavigated = (frame) => {
          if (frame !== page.mainFrame()) return;
          lastError = new Error('page navigated during capture');
          resolve(null);
        };
        page.on('framenavigated', onNavigated);
      });
      const failed = (error: unknown) => {
        lastError = error;
        return null;
      };
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        shot().catch(failed),
        navigated,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MaskError('screenshot capture timed out')), CAPTURE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!result) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        continue;
      }
      const png = Buffer.from(result.data, 'base64');
      capture = { png, ...pngSize(png), viewport, maskedRegions: before.rects.flat().length };
    } finally {
      if (onNavigated) page.off('framenavigated', onNavigated);
      await cdp.detach().catch(() => {});
      await Promise.allSettled(page.frames().map((frame) => frame.evaluate(removeMasks)));
    }
    // A rescan that fails (e.g. a frame detached meanwhile) counts as a change.
    const unchanged = await scanFrames(page, options)
      .then(async (after) => {
        const changed = await Promise.all(
          after.frames.map((frame) => frame.evaluate(settleWatch, { key: WATCH_KEY, guardKey: GUARD_KEY })),
        );
        return (
          after.signature === before.signature &&
          after.frames.every((frame, index) => frame === before.frames[index]) &&
          !changed.includes(true)
        );
      })
      .catch(() => false);
    if (unchanged) return capture;
  }
  throw lastError ? failure(lastError) : new MaskError('page changed during masked capture; image discarded');
}
