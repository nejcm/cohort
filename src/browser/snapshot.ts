import type { Page } from 'playwright';
import { MaskError } from './observations.ts';

const MAX_CHARS = 40_000;
const MAX_MASKED = 200;
const REF = /\[ref=((?:f\d+)?e\d+)\]/u;

const MIN_MASKED_TEXT = 4;
// Raw, JSON-escaped, and Playwright's YAML `\xNN` escapes for control characters.
const yamlForms = (value: string): string[] => {
  const json = JSON.stringify(value).slice(1, -1);
  const hex = (upper: boolean): string =>
    json.replace(/\\u00([0-9a-f]{2})/giu, (_, code: string) => `\\x${upper ? code.toUpperCase() : code.toLowerCase()}`);
  return [...new Set([value, json, hex(false), hex(true)])];
};

/** Main-frame accessibility snapshot with refs; masked subtrees, frame contents, and URL queries are cut, then secrets are redacted. The refs are those shown. */
export async function textSnapshot(
  page: Page,
  options: {
    maskSelectors: readonly string[];
    secrets: readonly string[];
    redact: (text: string) => string;
    timeout: number;
  },
): Promise<{ text: string; refs: Set<string> }> {
  const { timeout } = options;
  const masked = page.locator(['[data-cohort-masked]', ...options.maskSelectors].join(','));
  const count = await masked.count();
  if (count > MAX_MASKED) throw new MaskError(`more than ${MAX_MASKED} masked elements`);
  const hidden = new Set<string>();
  // Taken before the page snapshot: refs only resolve against the latest one, and an element keeps its ref while its role and name hold.
  for (let index = 0; index < count; index += 1) {
    const subtree = await masked.nth(index).ariaSnapshot({ mode: 'ai', timeout });
    if (!subtree.trim()) continue;
    const ref = REF.exec(subtree.split('\n')[0]!)?.[1];
    if (ref) hidden.add(ref);
    else if (!((await masked.nth(index).textContent({ timeout })) ?? '').trim())
      throw new MaskError('a masked element has no snapshot ref or text; text mode cannot hide it');
  }
  const maskedValues = (
    await masked.evaluateAll((elements) =>
      elements.flatMap((element) => [
        element.textContent ?? '',
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '',
        ...['aria-label', 'placeholder', 'title', 'alt'].map((name) => element.getAttribute(name) ?? ''),
      ]),
    )
  )
    .map((value) => value.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const maskedTexts = maskedValues.filter((value) => value.length >= MIN_MASKED_TEXT);
  const lines = (await page.ariaSnapshot({ mode: 'ai', timeout })).split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  let skipBelow = -1;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const ref = REF.exec(line)?.[1];
    if (skipBelow >= 0 && indent > skipBelow) {
      if (ref && hidden.has(ref)) seen.add(ref);
      continue;
    }
    skipBelow = -1;
    const role = /^\s*- ([a-z]+)/u.exec(line)?.[1] ?? 'generic';
    if (ref && hidden.has(ref)) {
      seen.add(ref);
      skipBelow = indent;
      out.push(`${' '.repeat(indent)}- ${role} [ref=${ref}]: [masked]`);
    } else if (role === 'iframe') {
      skipBelow = indent;
      out.push(`${' '.repeat(indent)}- iframe: [frame content is not shown in text mode]`);
    } else if (/^\s*- \/url: /u.test(line)) out.push(line.replace(/[?#].*$/u, ''));
    else out.push(line);
  }
  if (seen.size !== hidden.size) throw new MaskError('a masked element changed during the snapshot');
  let text = out.join('\n');
  // Every substring is masked, even inside longer words; ref tokens are kept so targets still resolve.
  for (const words of maskedValues)
    for (const form of yamlForms(words))
      text = text
        .split(/(\[ref=(?:f\d+)?e\d+\])/u)
        .map((part) => (REF.test(part) ? part : part.split(form).join('[masked]')))
        .join('');
  for (const secret of options.secrets)
    for (const form of yamlForms(secret)) text = text.split(form).join('[redacted]');
  text = options.redact(text);
  // Masked text can reach other names, e.g. through aria-labelledby; refuse rather than chase every path.
  if (maskedTexts.some((value) => yamlForms(value).some((form) => text.includes(form))))
    throw new MaskError('masked text appears elsewhere in the snapshot');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n[snapshot truncated]`;
  return { text, refs: new Set([...text.matchAll(new RegExp(REF.source, 'gu'))].map((match) => match[1]!)) };
}
