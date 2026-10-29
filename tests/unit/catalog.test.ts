import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CatalogError,
  loadCatalog,
  resolveModel,
  validateCatalog,
  type ModelCatalogEntry,
} from '../../src/providers/catalog.ts';
import shipped from '../../src/providers/catalog.json' with { type: 'json' };

const tested = (overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id: 'model-a',
  provider: 'openai',
  label: 'Model A',
  visionCapable: true,
  supportedEffortLevels: ['low', 'medium'],
  defaultEffort: 'low',
  pricesPerMTok: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 1 },
  pricingVerifiedAt: '2026-10-01',
  untested: false,
  ...overrides,
});

test('shipped catalog is the approved set, and untested entries need explicit confirmation', () => {
  const catalog = validateCatalog(shipped, 'catalog.json');
  assert.deepEqual(
    catalog.models.map((entry) => [entry.provider, entry.id, entry.label, entry.defaultEffort, entry.untested]),
    [
      ['anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'medium', false],
      ['openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', 'low', true],
    ],
  );
  assert.deepEqual(catalog.models[0]?.pricesPerMTok, { input: 2, output: 10, cachedInput: 0.1, cacheWrite: 2.5 });
  for (const entry of catalog.models) {
    const id = `${entry.provider}/${entry.id}`;
    if (entry.visionCapable === null) assert.throws(() => resolveModel(catalog, id, { mode: 'vision' }), /disabled/u);
    else if (entry.untested) {
      assert.throws(() => resolveModel(catalog, id, { mode: 'vision' }), /untested/u);
      assert.equal(resolveModel(catalog, id, { mode: 'vision', allowUntested: true }).effort, entry.defaultEffort);
    } else assert.equal(resolveModel(catalog, id, { mode: 'vision' }).effort, entry.defaultEffort);
  }
});

const issues = (entry: unknown): string => {
  try {
    validateCatalog({ version: 'v', models: [entry] }, 'x');
    return '';
  } catch (error) {
    return String(error);
  }
};

test('catalog validation reports every bad field', () => {
  assert.equal(issues(tested()), '');
  assert.match(issues({ ...tested(), extra: 1 }), /extra: unknown field/u);
  assert.match(issues(tested({ provider: 'acme' })), /unknown provider/u);
  assert.match(issues(tested({ id: 'has space' })), /without spaces/u);
  assert.match(issues(tested({ supportedEffortLevels: ['max' as 'low'] })), /unique efforts/u);
  assert.match(issues(tested({ defaultEffort: 'high' })), /one of supportedEffortLevels/u);
  assert.match(issues(tested({ visionCapable: null })), /tested entries need/u);
  assert.match(
    issues(tested({ pricesPerMTok: { input: -1, output: 1, cachedInput: 0, cacheWrite: -1 } })),
    /nonnegative/u,
  );
  assert.match(issues(tested({ pricingVerifiedAt: null })), /verification date/u);
  const { cacheWrite: _, ...noWriteKey } = tested().pricesPerMTok;
  assert.match(issues({ ...tested(), pricesPerMTok: noWriteKey }), /exactly input, output, cachedInput, cacheWrite/u);
  const writeUnknown = { input: 1, output: 4, cachedInput: 0.1, cacheWrite: null };
  assert.match(issues(tested({ pricesPerMTok: writeUnknown })), /cacheWrite: required when input and output/u);
  const unpriced = { input: null, output: null, cachedInput: null, cacheWrite: null };
  assert.equal(issues(tested({ pricesPerMTok: unpriced, pricingVerifiedAt: null })), '');
  assert.match(issues(tested({ contextLimitTokens: 1.5 })), /positive integer/u);
  assert.throws(
    () => validateCatalog({ version: 'v', models: [tested(), tested()] }, 'x'),
    /duplicate openai\/model-a/u,
  );
});

test('resolveModel applies defaults, rejects unsupported effort, and hashes the snapshot', () => {
  const catalog = validateCatalog(
    { version: 'v1', models: [tested(), tested({ id: 'blind', visionCapable: false })] },
    'x',
  );
  const resolved = resolveModel(catalog, 'openai/model-a', { mode: 'vision' });
  assert.equal(resolved.effort, 'low');
  assert.match(resolved.catalog.hash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(resolveModel(catalog, 'openai/model-a', { mode: 'vision' }).catalog.hash, resolved.catalog.hash);
  assert.throws(() => resolveModel(catalog, 'openai/model-a', { effort: 'high', mode: 'vision' }), /not supported/u);
  assert.throws(() => resolveModel(catalog, 'openai/blind', { mode: 'vision' }), /not vision-capable/u);
  assert.equal(resolveModel(catalog, 'openai/blind', { mode: 'text' }).model, 'blind');
  assert.throws(() => resolveModel(catalog, 'model-a', { mode: 'vision' }), /<provider>\/<id>/u);
  assert.throws(() => resolveModel(catalog, 'openai/nope', { mode: 'vision' }), CatalogError);
});

test('project models.yml overrides and extends the shipped catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-catalog-'));
  try {
    assert.equal((await loadCatalog(root)).version, shipped.version);
    await mkdir(join(root, '.cohort'));
    await writeFile(
      join(root, '.cohort', 'models.yml'),
      `version: local-1
models:
  - id: model-a
    provider: openai
    label: Model A
    visionCapable: true
    supportedEffortLevels: [low, medium]
    defaultEffort: medium
    pricesPerMTok: { input: 1, output: 4, cachedInput: null, cacheWrite: 1 }
    pricingVerifiedAt: "2026-10-01"
    untested: false
`,
    );
    const catalog = await loadCatalog(root);
    assert.equal(catalog.version, `${shipped.version}+local-1`);
    assert.equal(catalog.models.length, shipped.models.length + 1);
    assert.equal(resolveModel(catalog, 'openai/model-a', { mode: 'vision' }).effort, 'medium');
    const yaml = await readFile(join(root, '.cohort', 'models.yml'), 'utf8');
    await writeFile(join(root, '.cohort', 'models.yml'), yaml.replace('cacheWrite: 1', 'cacheWrite: null'));
    await assert.rejects(loadCatalog(root), /models\.yml\.models\[0\]\.pricesPerMTok\.cacheWrite: required/u);
    await writeFile(join(root, '.cohort', 'models.yml'), 'version: bad\nmodels: [{ id: x }]\n');
    await assert.rejects(loadCatalog(root), /\.cohort\/models\.yml\.models\[0\]\.provider: required/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolved snapshots do not change when the source catalog is mutated', () => {
  const catalog = validateCatalog({ version: 'v1', models: [tested()] }, 'x');
  const resolved = resolveModel(catalog, 'openai/model-a', { mode: 'vision' });
  catalog.models[0]!.pricesPerMTok.input = 99;
  catalog.models[0]!.supportedEffortLevels.push('high');
  assert.equal(resolved.catalog.entry.pricesPerMTok.input, 1);
  assert.deepEqual(resolved.catalog.entry.supportedEffortLevels, ['low', 'medium']);
  assert.throws(() => {
    (resolved.catalog.entry.pricesPerMTok as { input: number }).input = 5;
  }, TypeError);
});
