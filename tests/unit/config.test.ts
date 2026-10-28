import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { ConfigError, loadPersona, loadProjectConfig, loadSuite } from '../../src/config/files.ts';
import { resolveSubmission, validateSubmission, type RunSubmission } from '../../src/config/resolve.ts';
import { validateCatalog, type ModelCatalogEntry } from '../../src/providers/catalog.ts';
import { createProviders } from '../../src/providers/registry.ts';

const priced = { input: 1, output: 4, cachedInput: 0.1 };
const unpriced = { input: null, output: null, cachedInput: null };
const entry = (id: string, provider: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id,
  provider,
  label: id,
  visionCapable: true,
  supportedEffortLevels: ['low', 'medium'],
  defaultEffort: 'medium',
  pricesPerMTok: priced,
  pricingVerifiedAt: '2026-10-01',
  untested: false,
  ...extra,
});
const catalog = validateCatalog(
  {
    version: 'test-1',
    models: [
      entry('model-a', 'openai'),
      entry('model-b', 'openai', {
        supportedEffortLevels: ['low', 'medium', 'high'],
        defaultEffort: 'low',
        pricesPerMTok: unpriced,
        pricingVerifiedAt: null,
      }),
      entry('model-c', 'anthropic', { supportedEffortLevels: ['low', 'high'], defaultEffort: 'high' }),
      entry('model-d', 'openai', { supportedEffortLevels: ['high'], defaultEffort: 'high' }),
      entry('blind', 'openai', { visionCapable: false }),
      entry('fresh', 'openai', { untested: true }),
    ],
  },
  'test',
);
const allKeys = createProviders({ OPENAI_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' });

let root: string;

const persona = (id: string, front: string, body = 'You are a careful guest.'): string =>
  `---\nschemaVersion: 1\nid: ${id}\nname: ${id}\ntags: [guest]\ndevice:\n  viewport: { width: 390, height: 844 }\n  touch: true\nlocale: sl-SI\ntimezone: Europe/Ljubljana\n${front}---\n\n${body}\n`;

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lab-config-'));
  await put(
    '.lab/config.yml',
    'schemaVersion: 1\nmodel: openai/model-a\nrepeats: 2\nlimits: { dollars: 1 }\nallowedOrigins: [http://api.example.test]\n',
  );
  // Written in reverse order so stable ID ordering is not an accident of creation order.
  await put('.lab/personas/zed.md', persona('zed', 'goal: Find the exit.\n'));
  await put(
    '.lab/personas/alpha.md',
    persona(
      'alpha',
      'goal: Find arrival.\nmodel: openai/model-b\neffort: high\nlimits: { steps: 10 }\nsetup: ../setup/persona.ts\nstorageState: persona-state\n',
    ),
  );
  await put('.lab/personas/other.md', persona('other', '').replace('tags: [guest]', 'tags: [host]'));
  await put('.lab/setup/persona.ts', 'export default async () => ({ startUrl: "http://a.test/" });\n');
  await put('.lab/setup/suite.ts', 'export default async () => ({ startUrl: "http://a.test/" });\n');
  await put(
    '.lab/suites/mixed.yml',
    `schemaVersion: 1
id: mixed
name: Mixed
defaults:
  url: http://a.test/
  model: anthropic/model-c
  effort: low
  note: Suite note.
  limits: { timeMs: 60000 }
  setup: ../setup/suite.ts
  storageState: suite-state
  allowedOrigins: [http://cdn.example.test]
entries:
  - persona: alpha
    model: openai/model-a
    effort: medium
    goal: Entry goal.
  - persona: alpha
  - persona: zed
    url: http://b.test/
`,
  );
});
after(() => rm(root, { recursive: true, force: true }));

async function resolve(submission: RunSubmission, overrides: { allowUntested?: boolean; providers?: object } = {}) {
  return resolveSubmission(validateSubmission(submission), {
    projectRoot: root,
    project: await loadProjectConfig(root),
    catalog,
    providers: (overrides.providers ?? allKeys) as never,
    ...(overrides.allowUntested ? { allowUntested: true } : {}),
  });
}

test('model and effort resolve per field across all five layers, then the catalog default', async () => {
  const suite = await resolve({ selector: { kind: 'suite', id: 'mixed' } });
  const pairs = suite.map(({ request, layers }) => [
    `${request.provider}/${request.model}`,
    request.effort,
    layers.modelFrom,
    layers.effortFrom,
  ]);
  assert.deepEqual(pairs, [
    ['openai/model-a', 'medium', 'suite_entry', 'suite_entry'],
    ['anthropic/model-c', 'low', 'suite_default', 'suite_default'],
    ['anthropic/model-c', 'low', 'suite_default', 'suite_default'],
  ]);
  const run = await resolve({ selector: { kind: 'suite', id: 'mixed' }, model: 'openai/model-b', effort: 'high' });
  assert.ok(run.every(({ request, layers }) => request.model === 'model-b' && layers.modelFrom === 'run'));
  assert.ok(run.every(({ request, layers }) => request.effort === 'high' && layers.effortFrom === 'run'));

  const [alpha] = await resolve({ selector: { kind: 'persona', id: 'alpha' } });
  assert.deepEqual(
    [alpha!.request.model, alpha!.request.effort, alpha!.layers.modelFrom],
    ['model-b', 'high', 'persona'],
  );
  const [zed] = await resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/' });
  assert.deepEqual(
    [zed!.request.model, zed!.request.effort, zed!.layers.modelFrom, zed!.layers.effortFrom],
    ['model-a', 'medium', 'project', 'catalog_default'],
  );
});

test('an inherited unsupported effort fails instead of being substituted', async () => {
  // alpha's persona effort (high) is inherited by model-a, which does not support it.
  await assert.rejects(
    resolve({ selector: { kind: 'persona', id: 'alpha' }, model: 'openai/model-a' }),
    /effort high is not supported by openai\/model-a \(model from run, effort from persona\)/u,
  );
  const [zed] = await resolve({
    selector: { kind: 'persona', id: 'zed' },
    url: 'http://a.test/',
    model: 'openai/model-d',
  });
  assert.equal(zed!.request.effort, 'high');
  await assert.rejects(
    resolve({
      selector: { kind: 'persona', id: 'zed' },
      url: 'http://a.test/',
      model: 'openai/model-d',
      effort: 'low',
    }),
    ConfigError,
  );
});

test('tag selection expands in stable ID order and merges limits per field without materialized overrides', async () => {
  const tagged = await resolve({ selector: { kind: 'tag', tag: 'guest' }, url: 'http://a.test/' });
  assert.deepEqual(
    tagged.map((resolved) => resolved.persona.id),
    ['alpha', 'zed'],
  );
  assert.deepEqual(
    tagged.map(({ request }) => request.limits),
    [
      { steps: 10, timeMs: 600_000, dollars: 1 },
      { steps: 40, timeMs: 600_000, dollars: 1 },
    ],
  );
  assert.ok(tagged.every(({ request }) => request.repeats === 2 && request.mode === 'vision'));

  const overridden = await resolve({
    selector: { kind: 'tag', tag: 'guest' },
    url: 'http://a.test/',
    limits: { timeMs: 5000 },
    repeats: 1,
  });
  assert.deepEqual(
    overridden.map(({ request }) => [request.limits, request.repeats]),
    [
      [{ steps: 10, timeMs: 5000, dollars: 1 }, 1],
      [{ steps: 40, timeMs: 5000, dollars: 1 }, 1],
    ],
  );

  const suite = await resolve({ selector: { kind: 'suite', id: 'mixed' } });
  assert.deepEqual(suite[0]!.request.limits, { steps: 10, timeMs: 60_000, dollars: 1 });
  assert.deepEqual(suite[2]!.request.limits, { steps: 40, timeMs: 60_000, dollars: 1 });
});

test('suite entries resolve URL, goal, notes, setup, storage state, and origins by precedence', async () => {
  const [first, second, third] = await resolve({ selector: { kind: 'suite', id: 'mixed' }, note: 'Run note.' });
  assert.equal(first!.request.url, 'http://a.test/');
  assert.equal(third!.request.url, 'http://b.test/');
  assert.equal(first!.layers.goal, 'Entry goal.');
  assert.equal(second!.layers.goal, 'Find arrival.');
  assert.match(
    first!.task,
    /^You are a careful guest\.\n\nGoal: Entry goal\.\n\nSuite note: Suite note\.\n\nRun note: Run note\.$/u,
  );
  assert.equal(first!.setup, join(root, '.lab/setup/suite.ts'));
  assert.equal(first!.storageState, 'suite-state');
  assert.deepEqual(first!.allowedOrigins, ['http://api.example.test', 'http://cdn.example.test']);
  const overridden = await resolve({ selector: { kind: 'suite', id: 'mixed' }, url: 'http://c.test/' });
  assert.ok(overridden.every(({ request }) => request.url === 'http://c.test/'));
  const [alpha] = await resolve({ selector: { kind: 'persona', id: 'alpha' } });
  assert.equal(alpha!.setup, join(root, '.lab/setup/persona.ts'));
  assert.equal(alpha!.storageState, 'persona-state');
});

test('resolved requests are frozen with a catalog snapshot that later catalog edits cannot change', async () => {
  const [resolved] = await resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/' });
  const { request } = resolved!;
  assert.match(request.catalog.hash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(request.catalog.version, 'test-1');
  assert.deepEqual(request.catalog.entry, catalog.models[0]);
  catalog.models[0]!.pricesPerMTok.input = 99;
  assert.equal(request.catalog.entry.pricesPerMTok.input, 1);
  catalog.models[0]!.pricesPerMTok.input = 1;
  assert.throws(() => {
    (request as { model: string }).model = 'other';
  }, TypeError);
  assert.throws(() => {
    (request.limits as { steps: number }).steps = 1;
  }, TypeError);
});

test('missing keys, non-vision models, and untested models fail preflight', async () => {
  const zed = { selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/' } as const;
  await assert.rejects(
    resolve(zed, { providers: createProviders({ ANTHROPIC_API_KEY: 'k2' }) }),
    /provider openai is unavailable; set OPENAI_API_KEY/u,
  );
  await assert.rejects(resolve(zed, { providers: createProviders({ OPENAI_API_KEY: '' }) }), /OPENAI_API_KEY/u);
  await assert.rejects(resolve({ ...zed, model: 'openai/blind' }), /not vision-capable/u);
  await assert.rejects(resolve({ ...zed, model: 'openai/fresh' }), /untested; confirm explicitly/u);
  const [fresh] = await resolve({ ...zed, model: 'openai/fresh' }, { allowUntested: true });
  assert.equal(fresh!.request.catalog.entry.untested, true);
});

test('submissions reject client-supplied provider or catalog metadata and incomplete ad-hoc runs', async () => {
  assert.throws(() => validateSubmission({ selector: { kind: 'adhoc' }, provider: 'openai' }), /submission\.provider/u);
  assert.throws(
    () => validateSubmission({ selector: { kind: 'persona', id: 'x' }, catalog: {} }),
    /submission\.catalog/u,
  );
  assert.throws(() => validateSubmission({ selector: { kind: 'adhoc' }, url: 'http://a.test/' }), /url and note/u);
  assert.throws(
    () => validateSubmission({ selector: { kind: 'persona', id: 'x' }, limits: { steps: 0 } }),
    /below minimum/u,
  );
  assert.throws(() => validateSubmission({ selector: { kind: 'persona', id: 'x' }, bogus: 1 }), /unknown property/u);
  const [adhoc] = await resolve({ selector: { kind: 'adhoc' }, url: 'http://a.test/', note: 'Find the contact page.' });
  assert.equal(adhoc!.persona.id, 'adhoc-first-time-user');
  assert.deepEqual(adhoc!.persona.device, { viewport: { width: 1280, height: 720 }, touch: false });
  assert.equal(adhoc!.setup, null);
  assert.deepEqual(adhoc!.request.limits, { steps: 40, timeMs: 600_000, dollars: 1 });
  assert.match(adhoc!.task, /first time.*\n\nGoal: Find the contact page\.$/su);
  await assert.rejects(
    resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/', mode: 'text' }),
    /text mode/u,
  );
  await assert.rejects(resolve({ selector: { kind: 'persona', id: 'zed' } }), /no start URL/u);
});

test('config files reject unknown versions, unknown fields, and unsafe or invalid personas', async () => {
  const bad = await mkdtemp(join(tmpdir(), 'lab-bad-'));
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(bad, path)), { recursive: true });
    await writeFile(join(bad, path), content);
  };
  try {
    await write('.lab/config.yml', 'schemaVersion: 2\nmodel: openai/model-a\n');
    await assert.rejects(loadProjectConfig(bad), /schemaVersion: must equal 1/u);
    await write('.lab/config.yml', 'schemaVersion: 1\nmodel: openai/model-a\nkeys: nope\n');
    await assert.rejects(loadProjectConfig(bad), /keys: unknown property/u);
    await write(
      '.lab/config.yml',
      'schemaVersion: 1\nmodel: openai/model-a\nroutes: [{ match: "**", action: block }]\n',
    );
    const project = await loadProjectConfig(bad);
    await write('.lab/personas/p.md', persona('p', ''));
    await assert.rejects(
      resolveSubmission(
        { selector: { kind: 'persona', id: 'p' }, url: 'http://a.test/' },
        { projectRoot: bad, project, catalog, providers: allKeys },
      ),
      /routes are not implemented/u,
    );

    const cases: [string, RegExp][] = [
      [persona('p', '', ''), /body is empty/u],
      [persona('q', ''), /does not match the file name/u],
      [persona('p', '').replace('Europe/Ljubljana', 'Mars/Olympus'), /unsupported time zone/u],
      [persona('p', '').replace('width: 390', 'width: 20'), /below minimum/u],
      [persona('p', 'setup: ../../outside.ts\n'), /must be inside \.lab\/setup/u],
      [persona('p', 'storageState: ../auth\n'), /does not match pattern/u],
      ['no frontmatter', /missing YAML frontmatter/u],
    ];
    for (const [content, expected] of cases) {
      await write('.lab/personas/p.md', content);
      await assert.rejects(loadPersona(bad, 'p'), expected);
    }
    await write('.lab/elsewhere.md', persona('s', ''));
    await symlink(join(bad, '.lab/elsewhere.md'), join(bad, '.lab/personas/s.md'));
    await assert.rejects(loadPersona(bad, 's'), /symlink not allowed/u);
    await assert.rejects(loadPersona(bad, '../x'), /invalid persona id/u);

    await write('.lab/suites/s.yml', 'schemaVersion: 1\nid: s\nname: S\nentries: []\n');
    await assert.rejects(loadSuite(bad, 's'), /too few items/u);
    await write('.lab/suites/s.yml', 'schemaVersion: 1\nid: s\nname: S\nentries: [{ persona: p, limits: {} }]\n');
    await assert.rejects(loadSuite(bad, 's'), /limits: unknown property/u);
  } finally {
    await rm(bad, { recursive: true, force: true });
  }
});
