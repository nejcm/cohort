import { isAlias, isScalar, isSeq, parseDocument, stringify, visit } from 'yaml';
import { localeProblems } from '../../src/config/locale.ts';
import { validate, type JsonSchema } from '../../src/core/schema.ts';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
type Path = (string | number)[];

function edit(yaml: string, path: Path, value: unknown): string {
  const document = parseDocument(yaml);
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  if (value === undefined || value === null) document.deleteIn(path);
  else {
    document.setIn(path, value);
    const node = document.getIn(path, true);
    // A reparsed `""` keeps its quote style; reset it so YAML quotes only when the value needs it.
    if (isScalar(node)) node.type = undefined;
  }
  return String(document);
}

/** Reads a YAML value at `path`, or the persona frontmatter when `markdown` is set; null when unparsable. */
export function readAt(source: string, path: Path, markdown: boolean): unknown {
  const yaml = markdown ? FRONTMATTER.exec(source)?.[1] : source;
  if (yaml === undefined) return null;
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return null;
  return valueAt(document.toJS(), path) ?? null;
}

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (at, key) => (typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined),
    value,
  );

/** Sets or (for undefined or null) removes one field, keeping comments, other keys and the Markdown body. */
export function setAt(source: string, path: Path, value: unknown, markdown: boolean): string {
  if (!markdown) return edit(source, path, value);
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error('the persona has no --- frontmatter block');
  return `---\n${edit(match[1]!, path, value)}---\n${source.slice(match[0].length)}`;
}

/** Moves list item `from` to `to` in the YAML at `path`, keeping each item's comments. */
export function moveAt(yaml: string, path: Path, from: number, to: number): string {
  const document = parseDocument(yaml);
  const list = document.getIn(path, true);
  if (document.errors.length > 0 || !isSeq(list)) throw new Error(`${path.join('.')} is not a list`);
  // The parser hangs the first item's leading comment on the list; move it with the item.
  const first = list.items[0] as { commentBefore?: string | null } | undefined;
  if (first && list.commentBefore) {
    first.commentBefore = first.commentBefore ? `${list.commentBefore}\n${first.commentBefore}` : list.commentBefore;
    list.commentBefore = null;
  }
  list.items.splice(to, 0, ...list.items.splice(from, 1));
  return String(document);
}

export const bodyOf = (source: string): string => source.slice(FRONTMATTER.exec(source)?.[0].length ?? 0);

export function withBody(source: string, body: string): string {
  const match = FRONTMATTER.exec(source);
  return match ? source.slice(0, match[0].length) + body : source;
}

export function personaMarkdown(persona: Record<string, unknown>, body: string): string {
  const keys = ['schemaVersion', 'id', 'name', 'tags', 'device', 'locale', 'timezone'];
  const picked = Object.fromEntries(keys.filter((key) => persona[key] !== undefined).map((key) => [key, persona[key]]));
  return `---\n${stringify(picked)}---\n\n${body.trim()}\n`;
}

export interface Field {
  path: Path;
  label: string;
  schema: JsonSchema;
  required: boolean;
}

const words = (keys: string[]): string => {
  const text = keys.join(' ').replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function leaves(schema: JsonSchema, path: Path, label: string[]): Field[] {
  return Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    if ('const' in child) return [];
    if (child.type === 'object') return leaves(child, [...path, key], [...label, key]);
    return [
      {
        path: [...path, key],
        label: words([...label, key]),
        schema: child,
        required: !!schema.required?.includes(key),
      },
    ];
  });
}

/** Form fields for a schema: top-level values first, then one group per nested object; paths start with `prefix`. */
export function fieldGroups(
  schema: JsonSchema,
  omit: readonly string[],
  prefix: Path = [],
): { legend: string; fields: Field[] }[] {
  const top = Object.entries(schema.properties ?? {}).filter(([key]) => !omit.includes(key));
  const flat = leaves(
    { ...schema, properties: Object.fromEntries(top.filter(([, child]) => child.type !== 'object')) },
    prefix,
    [],
  );
  return [
    { legend: 'Details', fields: flat },
    ...top
      .filter(([, child]) => child.type === 'object')
      .map(([key, child]) => ({ legend: words([key]), fields: leaves(child, [...prefix, key], []) })),
  ];
}

export const multiline = (schema: JsonSchema): boolean => (schema.maxLength ?? 0) > 200 && !schema.pattern;

function mismatch(schema: JsonSchema, value: unknown, at: string): string | null {
  if (value === undefined) return null;
  if (schema.type === 'string' && !multiline(schema) && typeof value === 'string' && /[\r\n]/u.test(value))
    return `${at} has several lines`;
  if (schema.type === 'array') return Array.isArray(value) ? null : `${at || 'frontmatter'} is not a list`;
  if (schema.type !== 'object') return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return `${at || 'frontmatter'} is not a mapping`;
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    if ('const' in child && (value as Record<string, unknown>)[key] !== child.const)
      return `${at ? `${at}.${key}` : key} is not ${JSON.stringify(child.const)}`;
  for (const [key, item] of Object.entries(value)) {
    const child = schema.properties?.[key];
    const where = at ? `${at}.${key}` : key;
    const problem = child ? mismatch(child, item, where) : `unknown field ${where}`;
    if (problem) return problem;
  }
  return null;
}

/** Why the form cannot represent this file, or null when every (frontmatter) value has a field. */
export function formProblem(source: string, schema: JsonSchema, markdown = true): string | null {
  const yaml = markdown ? FRONTMATTER.exec(source)?.[1] : source;
  if (yaml === undefined) return 'the file has no --- frontmatter block';
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return `the frontmatter is not valid YAML: ${document.errors[0]!.message}`;
  let linked = false;
  visit(document, (_key, node) => {
    if (isAlias(node) || (node as { anchor?: string }).anchor) return ((linked = true), visit.BREAK);
  });
  if (linked) return 'the frontmatter uses YAML anchors or aliases';
  return mismatch(schema, document.toJS() ?? {}, '');
}

const pathText = (path: Path): string => path.map((key) => (typeof key === 'number' ? `[${key}]` : `.${key}`)).join('');

/** The part of a validation error that names `path` (or its list item `index`), such as `too short` for `x.md.name: too short`. */
export function fieldError(error: string, path: Path, index?: number): string | null {
  const at = pathText(index === undefined ? path : [...path, index]).replace(/[.[\]]/gu, '\\$&');
  return new RegExp(`${at}: (.*)$`, 'u').exec(error)?.[1] ?? null;
}

/** Checks each field's frontmatter value against its schema, plus locale and time zone; errors use the server's `.path: message` form. */
export function fieldProblems(source: string, fields: Field[], markdown = true): string[] {
  const front = readAt(source, [], markdown);
  const fieldErrors = fields.flatMap((field) => {
    const value = valueAt(front, field.path);
    const at = pathText(field.path);
    if (value === undefined) return field.required ? [`${at}: required`] : [];
    const { items: itemSchema, ...list } = field.schema;
    if (!Array.isArray(value) || !itemSchema)
      return [validate(field.schema, value, at)].filter((error) => error !== null);
    const items = value.map((item, index) => validate(itemSchema, item, `${at}[${index}]`));
    return [...items, validate(list, value, at)].filter((error) => error !== null);
  });
  return [...fieldErrors, ...localeProblems((front ?? {}) as Record<string, unknown>, '')];
}
