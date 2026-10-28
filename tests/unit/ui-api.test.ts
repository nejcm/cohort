import assert from 'node:assert/strict';
import { test } from 'node:test';
import { follow, splitEvents, type LiveEvent } from '../../ui/api.ts';
import { readAt, setAt } from '../../ui/source.ts';

const frame = (id: number, type: string): string => `id: ${id}\nevent: ${type}\ndata: {}\n\n`;

test('splitEvents keeps partial frames and drops heartbeats', () => {
  const { events, rest } = splitEvents(
    ': ping\n\nid: 1\nevent: run.started\ndata: {"runId":"r"}\n\nid: 2\nevent: step',
  );
  assert.deepEqual(events, [{ id: 1, type: 'run.started', data: { runId: 'r' } }]);
  assert.equal(rest, 'id: 2\nevent: step');
});

test('follow resumes after a dropped stream with Last-Event-ID and stops when the server ends it', async () => {
  const sent: Record<string, string>[] = [];
  const bodies = [
    // The first connection drops mid-frame.
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(1, 'run.started') + 'id: 2\nev'));
      },
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(2, 'step.started') + frame(3, 'run.finished')));
        controller.close();
      },
    }),
  ];
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { sessionStorage: { getItem: () => 'token' } });
  globalThis.fetch = async (_url, init) => {
    sent.push(init?.headers as Record<string, string>);
    return new Response(bodies.shift()!, { status: 200 });
  };
  try {
    const events: LiveEvent[] = [];
    await new Promise<void>((resolve) =>
      follow(
        'run_x',
        (event) => events.push(event),
        resolve,
        () => 0,
      ),
    );
    assert.deepEqual(
      events.map((event) => [event.id, event.type]),
      [
        [1, 'run.started'],
        [2, 'step.started'],
        [3, 'run.finished'],
      ],
    );
    assert.deepEqual(
      sent.map((headers) => [headers.authorization, headers['last-event-id']]),
      [
        ['Bearer token', '0'],
        ['Bearer token', '1'],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('follow reconnects after a clean close of an active run and stops once the run has finished', async () => {
  const urls: string[] = [];
  const replies = [
    () => new Response(frame(1, 'run.started'), { status: 200 }),
    () => Response.json({ run: { status: 'running' } }),
    () => new Response(frame(2, 'step.started'), { status: 200 }),
    () => Response.json({ run: { status: 'finished' } }),
  ];
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { sessionStorage: { getItem: () => 'token' } });
  globalThis.fetch = async (url, init) => {
    urls.push(
      `${String(url)} ${(init?.headers as Record<string, string> | undefined)?.['last-event-id'] ?? ''}`.trim(),
    );
    return replies.shift()!();
  };
  try {
    const events: LiveEvent[] = [];
    await new Promise<void>((resolve) =>
      follow(
        'run_x',
        (event) => events.push(event),
        resolve,
        () => 0,
      ),
    );
    assert.deepEqual(
      events.map((event) => event.id),
      [1, 2],
    );
    assert.deepEqual(urls, [
      '/api/runs/run_x/events 0',
      '/api/runs/run_x',
      '/api/runs/run_x/events 1',
      '/api/runs/run_x',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('picker edits keep comments and the Markdown body, and clearing a value removes the key', () => {
  const persona = '---\nid: guest # keep\nname: Guest\n---\n\nBody text.\n';
  const withModel = setAt(persona, ['model'], 'openai/x', true);
  assert.equal(withModel, '---\nid: guest # keep\nname: Guest\nmodel: openai/x\n---\n\nBody text.\n');
  assert.equal(readAt(withModel, ['model'], true), 'openai/x');
  assert.equal(setAt(withModel, ['model'], '', true), persona);
  const suite = 'id: smoke\nentries:\n  - persona: guest\n';
  assert.equal(
    setAt(suite, ['entries', 0, 'effort'], 'low', false),
    'id: smoke\nentries:\n  - persona: guest\n    effort: low\n',
  );
  assert.throws(() => setAt('no frontmatter', ['model'], 'x', true), /frontmatter/u);
});
