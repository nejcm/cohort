import { validate, type JsonSchema } from './schema.ts';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export const BLOCKED_KINDS = ['email_code', 'captcha', 'oauth', 'payment', 'third_party', 'unknown'] as const;
const PRESS_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  'Control+A',
  'Meta+A',
] as const;

const observationId: JsonSchema = { type: 'string', pattern: '^o[0-9]{4,}$' };
const stepId: JsonSchema = { type: 'string', pattern: '^s[0-9]{4,}$' };
const reason: JsonSchema = { type: 'string', minLength: 1, maxLength: 1000 };
const point: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'x', 'y'],
  properties: { kind: { const: 'point' }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } },
};
const reference: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ref'],
  properties: { kind: { const: 'ref' }, ref: { type: 'string', pattern: '^e[0-9]+$' } },
};
const target: JsonSchema = { oneOf: [point, reference] };

function args(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'click',
    description: 'Click (or tap on touch devices) a point in the current screenshot.',
    parameters: args(['observationId', 'target'], { observationId, target }),
  },
  {
    name: 'fill',
    description: 'Replace the contents of an editable field, or choose a visible option label in a select box.',
    parameters: args(['observationId', 'target', 'value'], {
      observationId,
      target,
      value: { type: 'string', maxLength: 4096 },
    }),
  },
  {
    name: 'press',
    description: 'Press one key on the focused element.',
    parameters: args(['observationId', 'key'], { observationId, key: { enum: PRESS_KEYS } }),
  },
  {
    name: 'type',
    description: 'Type text into the focused element; write secrets as their {{placeholder}}.',
    parameters: args(['observationId', 'text'], { observationId, text: { type: 'string', maxLength: 4096 } }),
  },
  {
    name: 'scroll',
    description: 'Scroll the viewport (target null) or the scrollable region under a target.',
    parameters: args(['observationId', 'target', 'deltaX', 'deltaY'], {
      observationId,
      target: { oneOf: [target, { type: 'null' }] },
      deltaX: { type: 'integer', minimum: -2000, maximum: 2000 },
      deltaY: { type: 'integer', minimum: -2000, maximum: 2000 },
    }),
  },
  {
    name: 'goto',
    description: 'Navigate to an absolute or relative URL within the allowed origins.',
    parameters: args(['url'], { url: { type: 'string', minLength: 1, maxLength: 4096 } }),
  },
  {
    name: 'wait',
    description: 'Wait for the page to change.',
    parameters: args(['ms'], { ms: { type: 'integer', minimum: 100, maximum: 5000 } }),
  },
  {
    name: 'report_friction',
    description: 'Record something confusing or slow at a step, then continue.',
    parameters: args(['step', 'reason'], { step: stepId, reason }),
  },
  {
    name: 'report_blocked',
    description: 'Stop because an external prerequisite prevents progress.',
    parameters: args(['kind', 'step', 'reason'], { kind: { enum: BLOCKED_KINDS }, step: stepId, reason }),
  },
  {
    name: 'done',
    description: 'Stop because the goal is complete; cite the step that shows it.',
    parameters: args(['step', 'summary'], { step: stepId, summary: reason }),
  },
  {
    name: 'give_up',
    description: 'Stop without completing the goal.',
    parameters: args(['kind', 'step', 'reason'], {
      kind: { enum: ['journey_abandoned', 'agent_uncertain'] },
      step: stepId,
      reason,
    }),
  },
];

const POINTER_TOOLS = new Set(['click', 'fill', 'scroll']);

/** The built-in tools offered for a persona's input; `keyboard` drops the pointer tools. */
export function toolsFor(input?: 'keyboard'): readonly ToolDefinition[] {
  return input === 'keyboard' ? BUILTIN_TOOLS.filter((tool) => !POINTER_TOOLS.has(tool.name)) : BUILTIN_TOOLS;
}

export function validateToolCall(call: ToolCall, tools: readonly ToolDefinition[] = BUILTIN_TOOLS): string | null {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return `unknown tool: ${call.name}`;
  return validate(tool.parameters, call.args, call.name);
}
