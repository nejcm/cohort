import assert from 'node:assert/strict';
import { test } from 'node:test';
import { follow, splitEvents, type LiveEvent } from '../../ui/lib/api.ts';
import { parsePersona, personaSchema } from '../../src/config/files.ts';
import { bodyOf, fieldError, fieldGroups, formProblem, readAt, setAt, withBody } from '../../ui/lib/source.ts';

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
  assert.equal(setAt(withModel, ['model'], undefined, true), persona);
  const suite = 'id: smoke\nentries:\n  - persona: guest\n';
  assert.equal(
    setAt(suite, ['entries', 0, 'effort'], 'low', false),
    'id: smoke\nentries:\n  - persona: guest\n    effort: low\n',
  );
  assert.throws(() => setAt('no frontmatter', ['model'], 'x', true), /frontmatter/u);
});

test('persona form fields come from the schema, and form edits round-trip to valid frontmatter', () => {
  const groups = fieldGroups(personaSchema, ['model', 'effort', 'setup']);
  assert.deepEqual(
    groups.map((group) => [group.legend, group.fields.map((field) => `${field.path.join('.')}:${field.label}`)]),
    [
      [
        'Details',
        [
          'id:Id',
          'name:Name',
          'tags:Tags',
          'input:Input',
          'locale:Locale',
          'timezone:Timezone',
          'goal:Goal',
          'storageState:Storage state',
        ],
      ],
      [
        'Device',
        ['device.viewport.width:Viewport width', 'device.viewport.height:Viewport height', 'device.touch:Touch'],
      ],
      ['Limits', ['limits.steps:Steps', 'limits.timeMs:Time ms', 'limits.dollars:Dollars']],
    ],
  );

  const original =
    '---\nschemaVersion: 1\nid: guest # keep\nname: Guest\ntags: [guest]\ndevice: { viewport: { width: 800, height: 600 }, touch: false }\nlocale: en-US\ntimezone: UTC\n---\n\nYou are a guest.\n';
  assert.equal(formProblem(original, personaSchema), null);
  let source = setAt(original, ['name'], 'Guest: "quoted"', true);
  source = setAt(source, ['tags', 1], 'mobile', true);
  source = setAt(source, ['device', 'viewport', 'width'], 390, true);
  source = setAt(source, ['device', 'touch'], true, true);
  source = setAt(source, ['input'], 'keyboard', true);
  source = setAt(source, ['limits', 'steps'], 12, true);
  source = withBody(source, `${bodyOf(source)}Edited.\n`);
  assert.match(source, /^id: guest # keep$/mu);
  assert.match(source, /^tags: \[ guest, mobile \]$/mu);
  const persona = parsePersona(source, 'x.md');
  assert.equal(persona.name, 'Guest: "quoted"');
  assert.deepEqual(persona.device, { viewport: { width: 390, height: 600 }, touch: true });
  assert.deepEqual([persona.input, persona.limits], ['keyboard', { steps: 12 }]);
  assert.equal(persona.body, 'You are a guest.\nEdited.');
  assert.equal(
    setAt(setAt(source, ['limits', 'steps'], undefined, true), ['input'], undefined, true).includes('input'),
    false,
  );
});

test('the persona form falls back to source for frontmatter it cannot show, and keeps unknown keys it does not edit', () => {
  const extra = '---\nschemaVersion: 1\nid: guest\ncustom: keep # note\n---\nBody.\n';
  assert.equal(formProblem(extra, personaSchema), 'unknown field custom');
  assert.equal(
    setAt(extra, ['name'], 'Guest', true),
    '---\nschemaVersion: 1\nid: guest\ncustom: keep # note\nname: Guest\n---\nBody.\n',
  );
  assert.equal(
    formProblem('---\nschemaVersion: 1\ndevice: { viewport: 5 }\n---\nB', personaSchema),
    'device.viewport is not a mapping',
  );
  assert.equal(formProblem('---\nschemaVersion: 1\ntags: guest\n---\nB', personaSchema), 'tags is not a list');
  assert.match(formProblem('---\nid: [\n---\nB', personaSchema) ?? '', /not valid YAML/u);
  assert.equal(formProblem('no frontmatter', personaSchema), 'the file has no --- frontmatter block');
  assert.equal(formProblem('---\nschemaVersion: 1\nlimits:\n---\nB', personaSchema), 'limits is not a mapping');
  assert.equal(
    formProblem('---\nschemaVersion: 1\ndevice: { viewport: null }\n---\nB', personaSchema),
    'device.viewport is not a mapping',
  );
  assert.equal(formProblem('---\nid: guest\n---\nB', personaSchema), 'schemaVersion is not 1');
  assert.equal(formProblem('---\nschemaVersion: 2\n---\nB', personaSchema), 'schemaVersion is not 1');
});

test('validation errors attach to the field they name', () => {
  const error = '.cohort/personas/guest.md.device.viewport.width: above maximum';
  assert.equal(fieldError(error, ['device', 'viewport', 'width']), 'above maximum');
  assert.equal(fieldError(error, ['device', 'viewport', 'height']), null);
  assert.equal(fieldError('new persona.tags[1]: does not match pattern', ['tags']), 'does not match pattern');
  assert.equal(fieldError('x.md.name: required', ['name']), 'required');
  assert.equal(fieldError('x.md: persona body is empty', ['name']), null);
});

test('list edits touch only the edited item, and anchors or aliases fall back to source', () => {
  const source = '---\ntags:\n  - guest # guest note\n  - mobile # mobile note\n  - desktop # desktop note\n---\nB';
  assert.equal(
    setAt(source, ['tags', 1], undefined, true),
    '---\ntags:\n  - guest # guest note\n  - desktop # desktop note\n---\nB',
  );
  assert.equal(
    setAt(source, ['tags', 2], 'tablet', true),
    '---\ntags:\n  - guest # guest note\n  - mobile # mobile note\n  - tablet # desktop note\n---\nB',
  );
  assert.match(setAt(source, ['tags', 3], 'new', true), /desktop # desktop note\n {2}- new\n---/u);
  assert.deepEqual(readAt(setAt('---\nid: x\n---\nB', ['tags', 0], '', true), ['tags'], true), ['']);
  const linked = '---\nschemaVersion: 1\ntags: [guest, &mobile mobile]\nname: *mobile\n---\nB';
  assert.equal(formProblem(linked, personaSchema), 'the frontmatter uses YAML anchors or aliases');
});
