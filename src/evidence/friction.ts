import { fingerprint, loopKey } from '../core/agent.ts';
import type { EvidenceRef } from '../core/outcomes.ts';
import { validate, type JsonSchema } from '../core/schema.ts';
import { focusLabel, type StepRecord } from './steps.ts';

type Measured<Kind extends string, Measurement> = { source: 'harness'; kind: Kind; measurement: Measurement };

export type FrictionClaim = {
  schemaVersion: 1;
  id: string;
  runId: string;
  statement: string;
  evidence: [EvidenceRef, ...EvidenceRef[]];
} & (
  | Measured<
      'steps_above_minimum',
      {
        actualActions: number;
        minimumActions: number;
        excessActions: number;
        basis: 'observed_success_minimum' | 'declared_fixture';
        baselineRunId: string | null;
      }
    >
  | Measured<'backtrack', { fromStepId: string; toStepId: string; count: number }>
  | Measured<'repeated_action', { actionFingerprint: string; count: number; windowSteps: number }>
  | Measured<'visible_error', { text: string; detector: 'visible_alert' | 'visible_validation_message' }>
  | Measured<'long_pause', { durationMs: number; thresholdMs: number; basis: 'page_wait' }>
  | Measured<'focus_trap', { element: string; presses: number }>
  | Measured<'focus_not_visible', { element: string }>
  | Measured<'horizontal_overflow', { overflowPx: number }>
  | { source: 'agent'; kind: 'opinion'; opinion: { reportingStepId: string; reason: string } }
);

export const BROWSER_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'fill',
  'press',
  'type',
  'scroll',
  'goto',
  'wait',
]);
const LONG_PAUSE_MS = 5000;
const REPEAT_WINDOW = 5;

const stepId = { type: 'string', pattern: '^s[0-9]{4,}$' } as const;
const count = { type: 'integer', minimum: 0 } as const;
const text = { type: 'string', minLength: 1, maxLength: 2000 } as const;
const evidenceRef: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stepId', 'screenshotId'],
  properties: { stepId, screenshotId: { type: 'string', pattern: '^shot-[0-9]{4,}$' } },
};
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const claim = (source: string, kind: string, detail: string, schema: JsonSchema): JsonSchema =>
  object({
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: '^c[0-9]{4,}$' },
    runId: { type: 'string', minLength: 1 },
    statement: text,
    evidence: { type: 'array', minItems: 1, items: evidenceRef },
    source: { const: source },
    kind: { const: kind },
    [detail]: schema,
  });
const claimSchema: JsonSchema = {
  oneOf: [
    claim(
      'harness',
      'steps_above_minimum',
      'measurement',
      object({
        actualActions: count,
        minimumActions: count,
        excessActions: { type: 'integer', minimum: 1 },
        basis: { enum: ['observed_success_minimum', 'declared_fixture'] },
        baselineRunId: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      }),
    ),
    claim('harness', 'backtrack', 'measurement', object({ fromStepId: stepId, toStepId: stepId, count })),
    claim(
      'harness',
      'repeated_action',
      'measurement',
      object({ actionFingerprint: text, count: { type: 'integer', minimum: 2 }, windowSteps: count }),
    ),
    claim(
      'harness',
      'visible_error',
      'measurement',
      object({ text, detector: { enum: ['visible_alert', 'visible_validation_message'] } }),
    ),
    claim(
      'harness',
      'long_pause',
      'measurement',
      object({ durationMs: count, thresholdMs: count, basis: { const: 'page_wait' } }),
    ),
    claim('harness', 'focus_trap', 'measurement', object({ element: text, presses: { type: 'integer', minimum: 2 } })),
    claim('harness', 'focus_not_visible', 'measurement', object({ element: text })),
    claim('harness', 'horizontal_overflow', 'measurement', object({ overflowPx: { type: 'integer', minimum: 1 } })),
    claim('agent', 'opinion', 'opinion', object({ reportingStepId: stepId, reason: text })),
  ],
};

const focusKey = (step: StepRecord): string | null =>
  step.focus ? `${step.pageUrl} ${step.focus.document} ${step.focus.css}` : null;

export const claimId = (index: number): string => `c${String(index).padStart(4, '0')}`;

function evidenceOf(step: StepRecord | undefined): EvidenceRef[] {
  const screenshotId = step?.afterScreenshotId ?? step?.beforeScreenshotId;
  return step && screenshotId ? [{ stepId: step.id, screenshotId }] : [];
}

type Draft = FrictionClaim extends infer Claim
  ? Claim extends FrictionClaim
    ? Omit<Claim, 'schemaVersion' | 'id' | 'runId' | 'evidence'> & { evidence: EvidenceRef[] }
    : never
  : never;

/** Harness measurements and agent opinions observable from one run's steps. */
export function deriveClaims(runId: string, steps: readonly StepRecord[]): FrictionClaim[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const drafts: Draft[] = [];
  const actions = steps.filter((step) => BROWSER_ACTIONS.has(step.action.name) && step.result.status === 'ok');

  for (const step of steps)
    if (step.action.name === 'report_friction' && step.result.status === 'ok') {
      const reason = String(step.action.args.reason);
      drafts.push({
        source: 'agent',
        kind: 'opinion',
        statement: `Agent opinion: ${reason}`,
        opinion: { reportingStepId: step.id, reason },
        evidence: evidenceOf(byId.get(String(step.action.args.step))),
      });
    }

  for (const step of actions)
    if (step.action.name !== 'wait' && step.durationMs >= LONG_PAUSE_MS)
      drafts.push({
        source: 'harness',
        kind: 'long_pause',
        statement: `The page took ${(step.durationMs / 1000).toFixed(1)} s to settle after ${step.action.name} at ${step.id}.`,
        measurement: { durationMs: step.durationMs, thresholdMs: LONG_PAUSE_MS, basis: 'page_wait' },
        evidence: evidenceOf(step),
      });

  const repeats = new Map<string, StepRecord[]>();
  for (const [index, step] of actions.entries()) {
    const key = fingerprint(step.action);
    const window = actions.slice(Math.max(0, index - REPEAT_WINDOW + 1), index + 1);
    const same = window.filter((candidate) => fingerprint(candidate.action) === key);
    if (same.length >= 2 && same.length > (repeats.get(key)?.length ?? 0)) repeats.set(key, same);
  }
  for (const [key, same] of repeats)
    drafts.push({
      source: 'harness',
      kind: 'repeated_action',
      statement: `The same ${same[0]!.action.name} was performed ${same.length} times within ${REPEAT_WINDOW} browser actions.`,
      measurement: { actionFingerprint: key, count: same.length, windowSteps: REPEAT_WINDOW },
      evidence: same.flatMap(evidenceOf),
    });

  const firstSeen = new Map<string, StepRecord>();
  const returns = new Map<string, number>();
  let previousUrl: string | null = null;
  for (const step of steps) {
    if (step.result.status !== 'ok' || !step.afterScreenshotId) continue;
    const url = step.pageUrl;
    const first = firstSeen.get(url);
    if (first && previousUrl !== null && previousUrl !== url) {
      const times = (returns.get(url) ?? 0) + 1;
      returns.set(url, times);
      drafts.push({
        source: 'harness',
        kind: 'backtrack',
        statement: `${step.id} returned to ${url}, first shown at ${first.id} (return ${times}).`,
        measurement: { fromStepId: step.id, toStepId: first.id, count: times },
        evidence: [...evidenceOf(first), ...evidenceOf(step)],
      });
    }
    if (!first) firstSeen.set(url, step);
    previousUrl = url;
  }

  let trap: StepRecord[] = [];
  const endTrap = (): void => {
    const focus = trap[0]?.focus;
    if (focus && trap.length >= 2)
      drafts.push({
        source: 'harness',
        kind: 'focus_trap',
        statement: `${trap.length} consecutive Tab or Shift+Tab presses ended on ${focusLabel(focus)} (${trap[0]!.id} to ${trap.at(-1)!.id}).`,
        measurement: { element: focusLabel(focus), presses: trap.length },
        evidence: trap.flatMap(evidenceOf),
      });
    trap = [];
  };
  for (const step of steps) {
    const tab =
      step.action.name === 'press' &&
      step.result.status === 'ok' &&
      (step.action.args.key === 'Tab' || step.action.args.key === 'Shift+Tab') &&
      step.focus;
    if (!tab || (trap.length > 0 && focusKey(trap[0]!) !== focusKey(step))) endTrap();
    if (tab) trap.push(step);
  }
  endTrap();

  let hidden: string | null = null;
  for (const step of steps) {
    if (step.focus === undefined) continue;
    const invisible = step.focus && !step.focus.visible ? focusKey(step) : null;
    if (
      invisible &&
      invisible !== hidden &&
      step.result.status === 'ok' &&
      (step.action.name === 'press' || step.action.name === 'type')
    )
      drafts.push({
        source: 'harness',
        kind: 'focus_not_visible',
        statement: `Focus moved to ${focusLabel(step.focus!)}, which is not visible on screen, at ${step.id}.`,
        measurement: { element: focusLabel(step.focus!) },
        evidence: evidenceOf(step),
      });
    hidden = invisible;
  }

  const overflowed = new Set<string>();
  for (const step of steps)
    if (
      step.result.status === 'ok' &&
      step.afterScreenshotId &&
      (step.overflowX ?? 0) > 0 &&
      !overflowed.has(step.pageUrl)
    ) {
      overflowed.add(step.pageUrl);
      drafts.push({
        source: 'harness',
        kind: 'horizontal_overflow',
        statement: `The page at ${step.pageUrl} is ${step.overflowX} px wider than the viewport at ${step.id}.`,
        measurement: { overflowPx: step.overflowX! },
        evidence: evidenceOf(step),
      });
    }

  return drafts
    .filter((draft) => draft.evidence.length > 0)
    .map((draft, index) => ({ schemaVersion: 1, id: claimId(index), runId, ...draft }) as FrictionClaim);
}

// Press lands on whatever had focus before it, and unresolved targets are per-observation, so neither is identifiable.
function actedOn(step: StepRecord): string | null {
  if (step.action.name === 'press') return null;
  if (step.action.name === 'type')
    return step.recipient === undefined ? null : JSON.stringify([loopKey(step), step.recipient]);
  return step.action.args.target && !step.target ? null : loopKey(step);
}

function stepIdentity(item: FrictionClaim, step: StepRecord): string | null {
  switch (item.kind) {
    case 'repeated_action':
    case 'long_pause': {
      const acted = actedOn(step);
      return acted === null ? null : JSON.stringify([item.kind, step.pageUrl, acted]);
    }
    case 'focus_trap':
    case 'focus_not_visible':
      return step.focus ? JSON.stringify([item.kind, step.pageUrl, step.focus.css]) : null;
    case 'visible_error':
      return JSON.stringify([
        item.kind,
        step.pageUrl,
        item.measurement.detector,
        item.measurement.text.replace(/\s+/gu, ' ').trim(),
      ]);
    default:
      return JSON.stringify([item.kind, step.pageUrl]);
  }
}

/** Cross-run identity of a measured claim; null unless every cited step is known and identifies the same thing. */
export function recurrenceKey(item: FrictionClaim, steps: ReadonlyMap<string, StepRecord>): string | null {
  if (item.kind === 'opinion') return null;
  if (item.kind === 'steps_above_minimum') return item.kind;
  const keys = new Set(
    item.evidence.map((ref) => {
      const step = steps.get(ref.stepId);
      return step ? stepIdentity(item, step) : null;
    }),
  );
  const [key] = keys;
  return keys.size === 1 && key ? key : null;
}

/** Rejects unknown fields, missing evidence, cross-run references, and unknown steps or screenshots. */
export function validateClaim(value: unknown, runId: string, steps: readonly StepRecord[]): string | null {
  const shape = validate(claimSchema, value, 'claim');
  if (shape) return shape;
  const item = value as FrictionClaim;
  if (item.runId !== runId) return `claim ${item.id}: belongs to run ${item.runId}`;
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const ref of item.evidence) {
    const step = byId.get(ref.stepId);
    if (!step) return `claim ${item.id}: unknown step ${ref.stepId}`;
    if (step.beforeScreenshotId !== ref.screenshotId && step.afterScreenshotId !== ref.screenshotId)
      return `claim ${item.id}: screenshot ${ref.screenshotId} is not part of step ${ref.stepId}`;
  }
  const cited =
    item.kind === 'opinion'
      ? [item.opinion.reportingStepId]
      : item.kind === 'backtrack'
        ? [item.measurement.fromStepId, item.measurement.toStepId]
        : [];
  const missing = cited.find((id) => !byId.has(id));
  return missing ? `claim ${item.id}: unknown step ${missing}` : null;
}
