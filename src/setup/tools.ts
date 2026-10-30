import { validate, type JsonSchema } from '../core/schema.ts';
import { BUILTIN_TOOLS, type ToolCall, type ToolDefinition } from '../core/tools.ts';
import type { SecretStore } from './secrets.ts';
import type { CustomTool } from './types.ts';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const RESERVED = new Set([...BUILTIN_TOOLS.map((tool) => tool.name), 'navigate', 'invalid']);
const SCHEMA_KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'minItems',
  'oneOf',
  'description',
]);
const PLACEHOLDER_REF = /^\{\{([a-z][a-z0-9_]*)\}\}$/u;
const MAX_OUTPUT_BYTES = 2000;

export type CustomToolResult =
  | { status: 'ok'; output: string; bound: Record<string, string> }
  | { status: 'rejected' | 'error'; code: string; message: string };

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function keywordValueSupported(key: string, value: unknown): boolean {
  switch (key) {
    case 'type':
      return typeof value === 'string' && SCHEMA_TYPES.has(value);
    case 'enum':
    case 'oneOf':
      return Array.isArray(value);
    case 'required':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'additionalProperties':
      return value === false;
    case 'properties':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'pattern':
      try {
        return typeof value === 'string' && Boolean(new RegExp(value, 'u'));
      } catch {
        return false;
      }
    case 'minLength':
    case 'maxLength':
    case 'minimum':
    case 'maximum':
    case 'minItems':
      return Number.isFinite(value);
    case 'description':
      return typeof value === 'string';
    default:
      return true;
  }
}

// Unknown keywords would be silently ignored by the validator, weakening the schema the user wrote.
function schemaProblem(schema: unknown, path: string): string | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return `${path} must be an object`;
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) return `${path}.${key} is not a supported schema keyword`;
    if (!keywordValueSupported(key, value)) return `${path}.${key} has an unsupported value`;
    const nested =
      key === 'properties'
        ? Object.entries(value as object).map(([name, item]) => [`${path}.properties.${name}`, item] as const)
        : key === 'items'
          ? [[`${path}.items`, value] as const]
          : key === 'oneOf'
            ? (value as unknown[]).map((item, index) => [`${path}.oneOf[${index}]`, item] as const)
            : [];
    for (const [where, item] of nested) {
      const problem = schemaProblem(item, where);
      if (problem) return problem;
    }
  }
  return null;
}

/** Validates setup-returned tools and returns their model-facing definitions; throws on an unusable tool. */
export function customToolDefinitions(tools: Record<string, CustomTool> = {}): ToolDefinition[] {
  return Object.entries(tools).map(([name, tool]) => {
    if (!TOOL_NAME.test(name)) throw new Error(`custom tool name ${JSON.stringify(name)} is invalid`);
    if (RESERVED.has(name)) throw new Error(`custom tool ${name} would override a built-in tool`);
    if (typeof tool?.execute !== 'function' || typeof tool.description !== 'string' || !tool.description.trim())
      throw new Error(`custom tool ${name} needs a description and an execute function`);
    const problem = schemaProblem(tool.inputSchema, `${name}.inputSchema`);
    if (problem) throw new Error(`custom tool ${problem}`);
    if ((tool.inputSchema as JsonSchema).type !== 'object')
      throw new Error(`custom tool ${name}.inputSchema must have type object`);
    return { name, description: tool.description.slice(0, 1000), parameters: tool.inputSchema as JsonSchema };
  });
}

/** Runs one schema-checked call within `timeoutMs`; secrets never enter its arguments or leave in its output. */
export async function runCustomTool(
  name: string,
  tool: CustomTool,
  call: ToolCall,
  secrets: SecretStore,
  timeoutMs: number,
  scrub: (text: string) => string = (text) => secrets.redact(text),
): Promise<CustomToolResult> {
  const invalid = validate(tool.inputSchema as JsonSchema, call.args, name);
  if (invalid) return { status: 'rejected', code: 'invalid_tool', message: invalid };
  if (argStrings(call.args).some((text) => secrets.hasPlaceholder(text) || secrets.contains(text)))
    return { status: 'rejected', code: 'secret_in_custom_args', message: 'custom tool arguments may not hold secrets' };
  const bound: Record<string, string> = {};
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let result: unknown;
  let settled = false;
  try {
    result = await Promise.race([
      tool.execute(structuredClone(call.args), {
        signal: controller.signal,
        bindSecret: (secretName, value) => {
          if (settled) throw new Error('bindSecret called after the tool call ended');
          const placeholder = secrets.bind(secretName, value);
          bound[secretName] = value;
          return placeholder;
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeout()), Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    controller.abort();
    if (error instanceof ToolTimeout)
      return { status: 'error', code: 'tool_timeout', message: `custom tool ${name} ran past ${timeoutMs} ms` };
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'error';
    return { status: 'error', code: 'tool_error', message: scrub(message).slice(0, 500) };
  } finally {
    settled = true;
    clearTimeout(timer);
  }
  const { text, secretRefs } = (result ?? {}) as { text?: unknown; secretRefs?: unknown };
  if (text !== undefined && typeof text !== 'string')
    return { status: 'error', code: 'invalid_tool_output', message: 'text must be a string' };
  if (typeof (secretRefs ?? {}) !== 'object' || Array.isArray(secretRefs))
    return { status: 'error', code: 'invalid_tool_output', message: 'secretRefs must be an object' };
  const refs = Object.entries((secretRefs ?? {}) as Record<string, unknown>);
  for (const [, ref] of refs) {
    const known = typeof ref === 'string' ? PLACEHOLDER_REF.exec(ref)?.[1] : undefined;
    if (!known || !secrets.names.includes(known))
      return {
        status: 'error',
        code: 'invalid_tool_output',
        message: 'secretRefs values must be placeholders returned by bindSecret',
      };
  }
  const output = scrub([text ?? '', ...refs.map(([label, ref]) => `${label}: ${String(ref)}`)].join('\n').trim());
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES)
    return { status: 'error', code: 'invalid_tool_output', message: `output exceeds ${MAX_OUTPUT_BYTES} bytes` };
  return { status: 'ok', output, bound };
}

class ToolTimeout extends Error {}

function argStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(argStrings);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) => [key, ...argStrings(item)]);
  return [];
}
