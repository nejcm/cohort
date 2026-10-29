import type { FocusState, LocatorDescriptor, Stability } from '../browser/targets.ts';

export interface StepRecord {
  schemaVersion: 1;
  runId: string;
  id: string;
  sequence: number;
  startedAt: string;
  elapsedMs: number;
  durationMs: number;
  observationId: string;
  action: { name: string; args: Record<string, unknown> };
  target?: {
    locator: LocatorDescriptor;
    stability: Stability;
    screenshotPoint?: { x: number; y: number };
    position: { x: number; y: number };
    tag: string;
  };
  /** The element focused when a `type` began; null when only the page had focus, absent when unresolvable. */
  recipient?: LocatorDescriptor | null;
  result: { status: 'ok' } | { status: 'rejected' | 'error'; code: string; message: string };
  /** Redacted text a custom tool returned to the model. */
  output?: string;
  beforeScreenshotId: string | null;
  afterScreenshotId: string | null;
  pageUrl: string;
  /** Focus and horizontal overflow (CSS px) read with the after screenshot; the name is redacted. */
  focus?: FocusState | null;
  overflowX?: number;
}

export const focusLabel = (focus: FocusState): string =>
  `${focus.role ?? focus.tag}${focus.name ? ` "${focus.name}"` : ''}`;

export function stepsJsonl(steps: readonly StepRecord[]): string {
  return steps.map((step) => JSON.stringify(step)).join('\n') + '\n';
}
