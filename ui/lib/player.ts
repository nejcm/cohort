export interface PlayerStep {
  id: string;
  action: string;
  args: string;
  status: string;
  pageUrl: string;
  durationMs: number;
  beforeId: string | null;
  afterId: string | null;
  point: { x: number; y: number } | null;
}

export interface Frame {
  key: string;
  stepId: string;
  shot: string;
  point: { x: number; y: number } | null;
  failed: boolean;
  weight: number;
}

export const SPEEDS = [1, 2, 4] as const;

const failed = (status: string): boolean => !status.startsWith('ok') && status !== 'running';

/** One frame per step and phase; a clicked step shows its before frame with the ring, then the after frame; steps with no screenshot are skipped. */
export function framesOf(steps: readonly PlayerStep[]): Frame[] {
  return steps.flatMap((step): Frame[] => {
    const base = { stepId: step.id, failed: failed(step.status) };
    if (step.point && step.beforeId && step.afterId && step.beforeId !== step.afterId)
      return [
        { ...base, key: `${step.id}:before`, shot: step.beforeId, point: step.point, weight: 0.5 },
        { ...base, key: `${step.id}:after`, shot: step.afterId, point: null, weight: 0.5 },
      ];
    const shot = step.afterId ?? step.beforeId;
    return shot
      ? [{ ...base, key: `${step.id}:after`, shot, point: step.beforeId === shot ? step.point : null, weight: 1 }]
      : [];
  });
}

export function delayFor(durationMs: number, speed: number, weight = 1): number {
  return Math.max(300, (Math.min(durationMs, 1500) * weight) / speed);
}

export const clampIndex = (index: number, length: number): number => Math.min(Math.max(index, 0), length - 1);

export const nextIndex = (length: number, index: number): number | null => (index + 1 < length ? index + 1 : null);
