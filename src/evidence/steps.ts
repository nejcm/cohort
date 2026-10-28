import type { LocatorDescriptor, Stability } from '../browser/targets.ts';

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
  result: { status: 'ok' } | { status: 'rejected' | 'error'; code: string; message: string };
  beforeScreenshotId: string | null;
  afterScreenshotId: string | null;
  pageUrl: string;
}

export function stepsJsonl(steps: readonly StepRecord[]): string {
  return steps.map((step) => JSON.stringify(step)).join('\n') + '\n';
}
