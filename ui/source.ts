import { parseDocument, stringify } from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
type Path = (string | number)[];

function edit(yaml: string, path: Path, value: string): string {
  const document = parseDocument(yaml);
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  if (value) document.setIn(path, value);
  else document.deleteIn(path);
  return String(document);
}

/** Reads a YAML value at `path`, or the persona frontmatter when `markdown` is set; null when unparsable. */
export function readAt(source: string, path: Path, markdown: boolean): unknown {
  const yaml = markdown ? FRONTMATTER.exec(source)?.[1] : source;
  if (yaml === undefined) return null;
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return null;
  let value: unknown = document.toJS();
  for (const key of path)
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return value ?? null;
}

/** Sets or (for an empty value) removes one field, keeping comments and the Markdown body. */
export function setAt(source: string, path: Path, value: string, markdown: boolean): string {
  if (!markdown) return edit(source, path, value);
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error('the persona has no --- frontmatter block');
  return `---\n${edit(match[1]!, path, value)}---\n${source.slice(match[0].length)}`;
}

export function personaMarkdown(persona: Record<string, unknown>, body: string): string {
  const keys = ['schemaVersion', 'id', 'name', 'tags', 'device', 'locale', 'timezone'];
  const picked = Object.fromEntries(keys.filter((key) => persona[key] !== undefined).map((key) => [key, persona[key]]));
  return `---\n${stringify(picked)}---\n\n${body.trim()}\n`;
}
