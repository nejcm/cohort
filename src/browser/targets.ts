import type { ElementHandle, Frame, FrameLocator, Locator, Page } from 'playwright';

type LocatorStep =
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; text: string }
  | { by: 'placeholder'; text: string }
  | { by: 'testid'; id: string }
  | { by: 'id'; id: string }
  | { by: 'css'; selector: string };

export interface LocatorDescriptor {
  frames: LocatorStep[];
  target: LocatorStep;
}

export type Stability = 'semantic' | 'test_id' | 'id' | 'css_path';

export type Resolution =
  | {
      ok: true;
      descriptor: LocatorDescriptor;
      stability: Stability;
      locator: Locator;
      position: { x: number; y: number };
      tag: string;
    }
  | { ok: false; reason: string };

interface Point {
  x: number;
  y: number;
}

export function screenshotToCss(
  point: Point,
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): Point | null {
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) return null;
  return { x: (point.x * viewport.width) / image.width, y: (point.y * viewport.height) / image.height };
}

const halfPixel = (value: number): number => Math.round(value * 2) / 2;

const STABILITY: Record<LocatorStep['by'], Stability> = {
  role: 'semantic',
  label: 'semantic',
  placeholder: 'semantic',
  testid: 'test_id',
  id: 'id',
  css: 'css_path',
};

type Scope = Page | FrameLocator;

function stepLocator(scope: Scope, step: LocatorStep): Locator {
  switch (step.by) {
    case 'role':
      return scope.getByRole(step.role as Parameters<Page['getByRole']>[0], { name: step.name, exact: true });
    case 'label':
      return scope.getByLabel(step.text, { exact: true });
    case 'placeholder':
      return scope.getByPlaceholder(step.text, { exact: true });
    case 'testid':
      return scope.getByTestId(step.id);
    case 'id':
      return scope.locator(`[id=${JSON.stringify(step.id)}]`);
    case 'css':
      return scope.locator(step.selector);
  }
}

export function toLocator(page: Page, descriptor: LocatorDescriptor): Locator {
  let scope: Scope = page;
  for (const frame of descriptor.frames) scope = stepLocator(scope, frame).contentFrame();
  return stepLocator(scope, descriptor.target);
}

function renderStep(step: LocatorStep): string {
  const j = JSON.stringify;
  switch (step.by) {
    case 'role':
      return `getByRole(${j(step.role)}, { name: ${j(step.name)}, exact: true })`;
    case 'label':
      return `getByLabel(${j(step.text)}, { exact: true })`;
    case 'placeholder':
      return `getByPlaceholder(${j(step.text)}, { exact: true })`;
    case 'testid':
      return `getByTestId(${j(step.id)})`;
    case 'id':
      return `locator(${j(`[id=${j(step.id)}]`)})`;
    case 'css':
      return `locator(${j(step.selector)})`;
  }
}

/** Renders a descriptor as Playwright source; every model-influenced string is a JSON literal. */
export function renderLocator(descriptor: LocatorDescriptor): string {
  return [
    'page',
    ...descriptor.frames.map((frame) => `${renderStep(frame)}.contentFrame()`),
    renderStep(descriptor.target),
  ].join('.');
}

function hitTest({ x, y }: Point): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

function classify(element: Element) {
  const tag = element.tagName.toLowerCase();
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  let transformed = false;
  for (let node: Element | null = element; node; node = node.parentElement)
    if (getComputedStyle(node).transform !== 'none') transformed = true;
  return {
    tag,
    // A closed shadow host hit-tests as itself with no light DOM to explain what was rendered.
    closedHost:
      tag.includes('-') && !element.shadowRoot && element.childElementCount === 0 && !element.textContent?.trim(),
    transformed,
    offsetX: rect.left + element.clientLeft + Number.parseFloat(style.paddingLeft),
    offsetY: rect.top + element.clientTop + Number.parseFloat(style.paddingTop),
  };
}

function toInteractive(element: Element): Element {
  const interactive =
    'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true]';
  let node: Element | null = element;
  while (node && !node.matches(interactive)) {
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  if (node instanceof HTMLLabelElement && node.control) return node.control;
  return node ?? element;
}

function describe(element: Element) {
  const whitespace = /\s+/gu;
  const text = (value: string | null | undefined): string => (value ?? '').replace(whitespace, ' ').trim();
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  let role = element.getAttribute('role');
  if (!role) {
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) role = 'button';
    else if (tag === 'a' && element.hasAttribute('href')) role = 'link';
    else if (tag === 'select') role = (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    else if (tag === 'textarea') role = 'textbox';
    else if (tag === 'input')
      role =
        { checkbox: 'checkbox', radio: 'radio', number: 'spinbutton', range: 'slider', search: 'searchbox' }[type] ??
        (['', 'text', 'email', 'tel', 'url'].includes(type) ? 'textbox' : null);
    else if (/^h[1-6]$/u.test(tag)) role = 'heading';
  }
  const labels = 'labels' in element ? [...((element as HTMLInputElement).labels ?? [])] : [];
  const label = text(labels.map((item) => item.textContent).join(' '));
  const labelledBy = element.getAttribute('aria-labelledby');
  const nameFromContent = ['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch'];
  const name =
    text(element.getAttribute('aria-label')) ||
    (labelledBy
      ? text(
          labelledBy
            .split(/\s+/u)
            .map((id) => element.ownerDocument.getElementById(id)?.textContent)
            .join(' '),
        )
      : '') ||
    label ||
    (role && nameFromContent.includes(role)
      ? text(element.textContent) || text(element.querySelector('img')?.alt)
      : '') ||
    text(element.getAttribute('title'));

  const segments: string[] = [];
  for (let node: Element | null = element; node;) {
    const parts: string[] = [];
    for (let current: Element | null = node; current; current = current.parentElement) {
      const parent: ParentNode | null = current.parentNode;
      const sameTag = parent ? [...parent.children].filter((child) => child.tagName === current?.tagName) : [current];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${sameTag.indexOf(current) + 1})`);
      if (!current.parentElement && current.getRootNode() instanceof ShadowRoot) parts[0] = `:scope > ${parts[0]}`;
    }
    segments.unshift(parts.join(' > '));
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return {
    tag,
    role,
    name,
    label,
    placeholder: element.getAttribute('placeholder'),
    testId: element.getAttribute('data-testid'),
    id: element.id,
    css: segments.join(' >> '),
  };
}

function candidates(info: ReturnType<typeof describe>): LocatorStep[] {
  const steps: LocatorStep[] = [];
  if (info.role && info.name) steps.push({ by: 'role', role: info.role, name: info.name });
  if (info.label) steps.push({ by: 'label', text: info.label });
  if (info.placeholder) steps.push({ by: 'placeholder', text: info.placeholder });
  if (info.testId) steps.push({ by: 'testid', id: info.testId });
  if (info.id) steps.push({ by: 'id', id: info.id });
  steps.push({ by: 'css', selector: info.css });
  return steps;
}

async function uniqueStep(
  scope: Scope,
  element: ElementHandle,
  unsafe: (text: string) => boolean,
): Promise<LocatorStep | null> {
  for (const step of candidates(await element.evaluate(describe))) {
    if (unsafe(JSON.stringify(step))) continue;
    const locator = stepLocator(scope, step);
    if ((await locator.count()) === 1 && (await locator.evaluate((found, wanted) => found === wanted, element)))
      return step;
  }
  return null;
}

// Hit-tests a CSS viewport point through open shadow roots and frames and returns a verified unique locator for it, skipping candidates `unsafe` flags (e.g. secrets).
export async function resolvePoint(
  page: Page,
  point: Point,
  unsafe: (text: string) => boolean = () => false,
): Promise<Resolution> {
  let frame: Frame = page.mainFrame();
  let scope: Scope = page;
  let local = point;
  const frames: LocatorStep[] = [];
  for (let depth = 0; depth < 8; depth += 1) {
    const hit = (await frame.evaluateHandle(hitTest, local)).asElement();
    if (!hit) return { ok: false, reason: 'no_element' };
    const info = await hit.evaluate(classify);
    if (info.tag === 'canvas') return { ok: false, reason: 'canvas' };
    if (info.closedHost) return { ok: false, reason: 'closed_shadow_root' };
    if (info.tag === 'iframe' || info.tag === 'frame') {
      if (info.transformed) return { ok: false, reason: 'transformed_frame' };
      const child = await hit.contentFrame();
      const step: LocatorStep | null = child && (await uniqueStep(scope, hit, unsafe));
      if (!child || !step) return { ok: false, reason: 'unresolvable_frame' };
      frames.push(step);
      scope = stepLocator(scope, step).contentFrame();
      local = { x: local.x - info.offsetX, y: local.y - info.offsetY };
      frame = child;
      continue;
    }
    const target = (await hit.evaluateHandle(toInteractive)).asElement();
    const step: LocatorStep | null = target && (await uniqueStep(scope, target, unsafe));
    if (!target || !step) return { ok: false, reason: 'no_unique_locator' };
    const locator = stepLocator(scope, step);
    const box = await locator.boundingBox();
    if (!box) return { ok: false, reason: 'not_visible' };
    const tag = await target.evaluate((element) => element.tagName.toLowerCase());
    return {
      ok: true,
      descriptor: { frames, target: step },
      stability: STABILITY[step.by],
      locator,
      position: { x: halfPixel(point.x - box.x), y: halfPixel(point.y - box.y) },
      tag,
    };
  }
  return { ok: false, reason: 'frame_depth' };
}
