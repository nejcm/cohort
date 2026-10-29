import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  checkProject,
  ConfigError,
  loadPersona,
  loadProjectConfig,
  loadSuite,
  parsePersona,
  saveStorageState,
} from '../../src/config/files.ts';
import { personaTemplates } from '../../src/config/init.ts';
import { PERSONA_GUIDANCE } from '../../src/personas/generate.ts';
import { resolveSubmission, validateSubmission, type RunSubmission } from '../../src/config/resolve.ts';
import { validateCatalog, type ModelCatalogEntry } from '../../src/providers/catalog.ts';
import { createProviders } from '../../src/providers/registry.ts';

const priced = { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 };
const unpriced = { input: null, output: null, cachedInput: null, cacheWrite: null };
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
    '.cohort/config.yml',
    'schemaVersion: 1\nmodel: openai/model-a\neffort: low\nrepeats: 2\nlimits: { dollars: 1 }\nallowedOrigins: [http://api.example.test]\n',
  );
  // Written in reverse order so stable ID ordering is not an accident of creation order.
  await put('.cohort/personas/zed.md', persona('zed', 'goal: Find the exit.\n'));
  await put(
    '.cohort/personas/alpha.md',
    persona(
      'alpha',
      'goal: Find arrival.\nmodel: openai/model-b\neffort: high\nlimits: { steps: 10 }\nsetup: ../setup/persona.ts\nstorageState: persona-state\n',
    ),
  );
  await put('.cohort/personas/other.md', persona('other', '').replace('tags: [guest]', 'tags: [host]'));
  await put('.cohort/setup/persona.ts', 'export default async () => ({ startUrl: "http://a.test/" });\n');
  await put('.cohort/setup/suite.ts', 'export default async () => ({ startUrl: "http://a.test/" });\n');
  await put(
    '.cohort/suites/mixed.yml',
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
  - persona: zed
    effort: high
`,
  );
});
after(() => rm(root, { recursive: true, force: true }));

async function resolve(
  submission: RunSubmission,
  overrides: { allowUntested?: boolean; providers?: object; projectEffort?: false } = {},
) {
  const project = await loadProjectConfig(root);
  if (overrides.projectEffort === false) delete project.effort;
  return resolveSubmission(validateSubmission(submission), {
    projectRoot: root,
    project,
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
    ['anthropic/model-c', 'high', 'suite_default', 'suite_entry'],
  ]);
  const run = await resolve({ selector: { kind: 'suite', id: 'mixed' }, model: 'openai/model-b', effort: 'high' });
  assert.ok(run.every(({ request, layers }) => request.model === 'model-b' && layers.modelFrom === 'run'));
  assert.ok(run.every(({ request, layers }) => request.effort === 'high' && layers.effortFrom === 'run'));

  const [alpha] = await resolve({ selector: { kind: 'persona', id: 'alpha' } });
  assert.deepEqual(
    [alpha!.request.model, alpha!.request.effort, alpha!.layers.modelFrom],
    ['model-b', 'high', 'persona'],
  );
  const [mixed] = await resolve({ selector: { kind: 'persona', id: 'alpha' }, model: 'anthropic/model-c' });
  assert.deepEqual(
    [mixed!.request.effort, mixed!.layers.modelFrom, mixed!.layers.effortFrom],
    ['high', 'run', 'persona'],
  );

  const zedOf = (overrides: Parameters<typeof resolve>[1] = {}, model?: string) =>
    resolve(
      { selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/', ...(model ? { model } : {}) },
      overrides,
    );
  const project = (await zedOf())[0]!;
  assert.deepEqual(
    [project.request.model, project.request.effort, project.layers.modelFrom, project.layers.effortFrom],
    ['model-a', 'low', 'project', 'project'],
  );
  const runModel = (await zedOf({}, 'openai/model-b'))[0]!;
  assert.deepEqual(
    [runModel.request.effort, runModel.layers.modelFrom, runModel.layers.effortFrom],
    ['low', 'run', 'project'],
  );
  const fallback = (await zedOf({ projectEffort: false }))[0]!;
  assert.deepEqual([fallback.request.effort, fallback.layers.effortFrom], ['medium', 'catalog_default']);
  const fallbackB = (await zedOf({ projectEffort: false }, 'openai/model-b'))[0]!;
  assert.equal(fallbackB.request.effort, 'low');
});

test('an inherited unsupported effort fails instead of being substituted', async () => {
  // alpha's persona effort (high) is inherited by model-a, which does not support it.
  await assert.rejects(
    resolve({ selector: { kind: 'persona', id: 'alpha' }, model: 'openai/model-a' }),
    /effort high is not supported by openai\/model-a \(model from run, effort from persona\)/u,
  );
  // The project effort (low) is inherited by model-d, which supports only high.
  await assert.rejects(
    resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/', model: 'openai/model-d' }),
    /effort low is not supported by openai\/model-d \(model from run, effort from project\)/u,
  );
  const [zed] = await resolve(
    { selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/', model: 'openai/model-d' },
    { projectEffort: false },
  );
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
  assert.equal(first!.setup, join(root, '.cohort/setup/suite.ts'));
  assert.equal(first!.storageState, 'suite-state');
  assert.deepEqual(first!.allowedOrigins, ['http://api.example.test', 'http://cdn.example.test']);
  const overridden = await resolve({ selector: { kind: 'suite', id: 'mixed' }, url: 'http://c.test/' });
  assert.ok(overridden.every(({ request }) => request.url === 'http://c.test/'));
  const [alpha] = await resolve({ selector: { kind: 'persona', id: 'alpha' } });
  assert.equal(alpha!.setup, join(root, '.cohort/setup/persona.ts'));
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
  const [text] = await resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/', mode: 'text' });
  assert.equal(text!.request.mode, 'text');
  await assert.rejects(resolve({ selector: { kind: 'persona', id: 'zed' } }), /no start URL/u);
});

test('config files reject unknown versions, unknown fields, and unsafe or invalid personas', async () => {
  const bad = await mkdtemp(join(tmpdir(), 'lab-bad-'));
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(bad, path)), { recursive: true });
    await writeFile(join(bad, path), content);
  };
  try {
    await write('.cohort/config.yml', 'schemaVersion: 2\nmodel: openai/model-a\n');
    await assert.rejects(loadProjectConfig(bad), /schemaVersion: must equal 1/u);
    await write('.cohort/config.yml', 'schemaVersion: 1\nmodel: openai/model-a\nkeys: nope\n');
    await assert.rejects(loadProjectConfig(bad), /keys: unknown property/u);
    await write(
      '.cohort/config.yml',
      'schemaVersion: 1\nmodel: openai/model-a\nroutes: [{ match: "**", action: block }]\n',
    );
    const project = await loadProjectConfig(bad);
    await write('.cohort/personas/p.md', persona('p', ''));
    const [resolved] = await resolveSubmission(
      { selector: { kind: 'persona', id: 'p' }, url: 'http://a.test/' },
      { projectRoot: bad, project, catalog, providers: allKeys },
    );
    assert.deepEqual(resolved!.routes, [{ match: '**', action: 'block' }]);
    await write('.cohort/personas/p.md', persona('p', 'input: keyboard\n'));
    assert.equal((await loadPersona(bad, 'p')).input, 'keyboard');

    const cases: [string, RegExp][] = [
      [persona('p', '', ''), /body is empty/u],
      [persona('q', ''), /does not match the file name/u],
      [persona('p', '').replace('Europe/Ljubljana', 'Mars/Olympus'), /unsupported time zone/u],
      [persona('p', '').replace('width: 390', 'width: 20'), /below minimum/u],
      [persona('p', 'setup: ../../outside.ts\n'), /must be inside \.cohort\/setup/u],
      [persona('p', 'storageState: ../auth\n'), /does not match pattern/u],
      [persona('p', 'input: mouse\n'), /input/u],
      ['no frontmatter', /missing YAML frontmatter/u],
    ];
    for (const [content, expected] of cases) {
      await write('.cohort/personas/p.md', content);
      await assert.rejects(loadPersona(bad, 'p'), expected);
    }
    await write('.cohort/elsewhere.md', persona('s', ''));
    await symlink(join(bad, '.cohort/elsewhere.md'), join(bad, '.cohort/personas/s.md'));
    await assert.rejects(loadPersona(bad, 's'), /symlink not allowed/u);
    await assert.rejects(loadPersona(bad, '../x'), /invalid persona id/u);

    await write('.cohort/suites/s.yml', 'schemaVersion: 1\nid: s\nname: S\nentries: []\n');
    await assert.rejects(loadSuite(bad, 's'), /too few items/u);
    await write('.cohort/suites/s.yml', 'schemaVersion: 1\nid: s\nname: S\nentries: [{ persona: p, limits: {} }]\n');
    await assert.rejects(loadSuite(bad, 's'), /limits: unknown property/u);
  } finally {
    await rm(bad, { recursive: true, force: true });
  }
});

test('every prompt layer records where it came from; setup wins the start URL', async () => {
  const [first, second] = await resolve({ selector: { kind: 'suite', id: 'mixed' }, note: 'Run note.' });
  assert.deepEqual(
    [first!.layers.goalFrom, second!.layers.goalFrom, first!.layers.urlFrom, first!.layers.runNote],
    ['suite_entry', 'persona', 'setup', 'Run note.'],
  );
  const [zed] = await resolve({ selector: { kind: 'persona', id: 'zed' }, url: 'http://a.test/' });
  assert.deepEqual([zed!.layers.goalFrom, zed!.layers.urlFrom], ['persona', 'run']);
  const [adhoc] = await resolve({ selector: { kind: 'adhoc' }, url: 'http://a.test/', note: 'Find help.' });
  assert.deepEqual([adhoc!.layers.goalFrom, adhoc!.layers.goal, adhoc!.layers.runNote], ['run', 'Find help.', null]);
  assert.ok(Object.isFrozen(adhoc!.layers));
});

test('authoring diagnostics name the file, line, entry, and known alternatives', async () => {
  const bad = await mkdtemp(join(tmpdir(), 'lab-diag-'));
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(bad, path)), { recursive: true });
    await writeFile(join(bad, path), content);
  };
  try {
    await write('.cohort/config.yml', 'schemaVersion: 1\nmodel: openai/model-a\n');
    await write('.cohort/personas/good.md', persona('good', ''));
    await write('.cohort/personas/twice.md', persona('twice', 'id: twice\n'));
    await write('.cohort/personas/tags.md', persona('tags', '').replace('tags: [guest]', 'tags: [guest, guest]'));
    await write(
      '.cohort/suites/s.yml',
      'schemaVersion: 1\nid: s\nname: S\nentries: [{ persona: good }, { persona: ghost }]\n',
    );
    await write('.cohort/suites/broken.yml', 'schemaVersion: 1\nid: broken\nname: [\n');
    await assert.rejects(loadPersona(bad, 'twice'), /twice\.md: invalid YAML: Map keys must be unique at line 11/u);
    await assert.rejects(loadPersona(bad, 'tags'), /tags\[1\]: duplicate "guest"/u);
    await assert.rejects(loadPersona(bad, 'ghost'), /unknown persona ghost: no \.cohort\/personas\/ghost\.md/u);
    await assert.rejects(loadSuite(bad, 'nope'), /unknown suite nope: no \.cohort\/suites\/nope\.yml/u);
    const project = await loadProjectConfig(bad);
    const options = { projectRoot: bad, project, catalog, providers: allKeys };
    await assert.rejects(
      resolveSubmission({ selector: { kind: 'suite', id: 's' } }, options),
      /\.cohort\/suites\/s\.yml entries\[1\]: unknown persona ghost/u,
    );
    await rm(join(bad, '.cohort/personas/twice.md'));
    await rm(join(bad, '.cohort/personas/tags.md'));
    await assert.rejects(
      resolveSubmission({ selector: { kind: 'tag', tag: 'host' }, url: 'http://a.test/' }, options),
      /no persona has tag host; known tags: guest/u,
    );
    await write('.cohort/personas/twice.md', persona('twice', 'id: twice\n'));
    const checked = await checkProject(bad);
    assert.equal(checked.personas, 1);
    assert.equal(checked.suites, 2);
    assert.equal(checked.problems.length, 3);
    assert.match(checked.problems.join('\n'), /twice\.md: invalid YAML/u);
    assert.match(checked.problems.join('\n'), /broken\.yml: invalid YAML/u);
    assert.match(checked.problems.join('\n'), /s\.yml entries\[1\]: unknown persona ghost/u);
  } finally {
    await rm(bad, { recursive: true, force: true });
  }
});

test('every shipped persona template and suite validate unchanged; the docs carry the generator guidance verbatim', async () => {
  const project = await mkdtemp(join(tmpdir(), 'lab-examples-'));
  try {
    const examples = new URL('../../examples/personas/', import.meta.url).pathname;
    const names = (await readdir(examples)).toSorted();
    const templates = await personaTemplates();
    assert.deepEqual(
      templates.map((template) => `${template.id}.md`),
      names,
    );
    assert.ok(templates.length >= 10 && templates.length <= 20);
    for (const { id, source } of templates) {
      const parsed = parsePersona(source, id);
      for (const key of ['setup', 'storageState', 'model', 'effort', 'limits'])
        assert.equal(key in parsed, false, `${id} leaves ${key} to the operator`);
      assert.ok(parsed.goal, `${id} has a goal`);
      assert.match(source, /^Assumptions \(edit these\):/mu, `${id} marks its assumptions`);
    }
    const docs = await readFile(new URL('../../docs/personas.md', import.meta.url), 'utf8');
    for (const { id } of templates) assert.ok(docs.includes(`\`${id}\``), `docs list ${id}`);
    await mkdir(join(project, '.cohort/personas'), { recursive: true });
    for (const name of names) await copyFile(join(examples, name), join(project, '.cohort/personas', name));
    await mkdir(join(project, '.cohort/suites'), { recursive: true });
    await mkdir(join(project, '.cohort/setup'), { recursive: true });
    const shipped = new URL('../../examples/', import.meta.url).pathname;
    const suites = (await readdir(join(shipped, 'suites'))).filter((name) => name.endsWith('.yml'));
    for (const name of suites) await copyFile(join(shipped, 'suites', name), join(project, '.cohort/suites', name));
    await copyFile(join(shipped, 'setup/fixture.ts'), join(project, '.cohort/setup/fixture.ts'));
    assert.deepEqual(await checkProject(project), { personas: names.length, suites: 3, problems: [] });
    assert.equal(
      parsePersona(templates.find(({ id }) => id === 'keyboard-only-navigator')!.source, 'k').input,
      'keyboard',
    );
    assert.ok(docs.includes(`> ${PERSONA_GUIDANCE}`));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('saved login state refuses a symlinked .cohort or .cohort/auth', async () => {
  const project = await mkdtemp(join(tmpdir(), 'lab-login-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'lab-elsewhere-'));
  const state = { cookies: [], origins: [] };
  try {
    await mkdir(join(project, '.cohort'));
    await symlink(elsewhere, join(project, '.cohort/auth'));
    await assert.rejects(saveStorageState(project, 'host', state), /symlink not allowed: \.cohort\/auth/u);
    await rm(join(project, '.cohort'), { recursive: true });
    await symlink(elsewhere, join(project, '.cohort'));
    await assert.rejects(saveStorageState(project, 'host', state), /symlink not allowed: \.cohort$/u);
    assert.deepEqual(await readdir(elsewhere), [], 'nothing is created through the symlink');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
