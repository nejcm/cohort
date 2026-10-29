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
  stepId: string;
  shot: string;
  point: { x: number; y: number } | null;
  failed: boolean;
  weight: number;
}

export const SPEEDS = [1, 2, 4] as const;

const failed = (status: string): boolean => !status.startsWith('ok') && status !== 'running';

/** A step with only a before shot repeats the previous frame, so it is dropped. A clicked step shows its before frame with the ring, then the after frame; steps with no screenshot are skipped. */
export function framesOf(steps: readonly PlayerStep[]): Frame[] {
  const frames = steps.flatMap((step): Frame[] => {
    const base = { stepId: step.id, failed: failed(step.status) };
    if (step.point && step.beforeId && step.afterId && step.beforeId !== step.afterId)
      return [
        { ...base, shot: step.beforeId, point: step.point, weight: 0.5 },
        { ...base, shot: step.afterId, point: null, weight: 0.5 },
      ];
    const shot = step.afterId ?? step.beforeId;
    return shot ? [{ ...base, shot, point: step.beforeId === shot ? step.point : null, weight: 1 }] : [];
  });
  return frames.filter((frame, index) => frame.shot !== frames[index - 1]?.shot);
}

export function delayFor(durationMs: number, speed: number, weight = 1): number {
  return Math.max(300, (Math.min(durationMs, 1500) * weight) / speed);
}

export const clampIndex = (index: number, length: number): number => Math.min(Math.max(index, 0), length - 1);

/** The next index, or null at the end or after a frame that should pause playback. */
export function nextIndex(frames: readonly Frame[], index: number): number | null {
  const next = index + 1;
  return next >= frames.length || frames[next]!.failed ? null : next;
}
