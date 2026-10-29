import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampIndex, delayFor, framesOf, nextIndex, type PlayerStep } from '../../ui/lib/player.ts';

const step = (id: string, extra: Partial<PlayerStep> = {}): PlayerStep => ({
  id,
  action: 'click',
  args: '',
  status: 'ok',
  pageUrl: 'http://x/',
  durationMs: 100,
  beforeId: null,
  afterId: null,
  point: null,
  ...extra,
});

test('frames fall back to before, skip shotless steps, and split clicks', () => {
  const frames = framesOf([
    step('s1', { afterId: 'a' }),
    step('s2', { beforeId: 'b' }),
    step('s3', { beforeId: 'b' }),
    step('s5'),
    step('s4', { beforeId: 'c', afterId: 'd', point: { x: 1, y: 2 } }),
  ]);
  assert.deepEqual(
    frames.map((frame) => [frame.stepId, frame.shot, frame.point !== null]),
    [
      ['s1', 'a', false],
      ['s2', 'b', false],
      ['s4', 'c', true],
      ['s4', 'd', false],
    ],
  );
});

test('delay is clamped per speed', () => {
  assert.equal(delayFor(10, 1), 300);
  assert.equal(delayFor(9000, 1), 1500);
  assert.equal(delayFor(9000, 4), 375);
  assert.equal(delayFor(9000, 1, 0.5), 750);
});

test('next stops at the end and before a failed step', () => {
  const frames = framesOf([
    step('a', { afterId: '1' }),
    step('b', { afterId: '2', status: 'error: x' }),
    step('c', { afterId: '3' }),
  ]);
  assert.equal(nextIndex(frames, 0), null);
  assert.equal(nextIndex(frames, 1), 2);
  assert.equal(nextIndex(frames, 2), null);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(9, 3), 2);
});
