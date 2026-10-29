import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { run } from '../../src/cli.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await run(argv, (text) => {
    out += text;
  });
  return { code, out };
}

test('prints the package version', async () => {
  const { code, out } = await capture(['--version']);
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+/);
});

test('prints usage with no arguments', async () => {
  const { code, out } = await capture([]);
  assert.equal(code, 0);
  assert.match(out, /^Usage: cohort/);
});

test('rejects an unknown command', async () => {
  const { code, out } = await capture(['nope']);
  assert.equal(code, 2);
  assert.match(out, /Unknown command: nope/);
});

test('rejects an unknown option', async () => {
  const { code, out } = await capture(['--bogus']);
  assert.equal(code, 2);
  assert.match(out, /Unknown option '--bogus'/);
  assert.match(out, /Usage: cohort/);
});

test('invalid run invocations exit 2 before reading any project', async () => {
  const cases: [string[], RegExp][] = [
    [['run'], /choose --persona, --tag, --suite, or --url with --note/u],
    [['run', '--persona', 'a', '--tag', 'b'], /choose one of/u],
    [['run', '--persona', 'a', '--repeats', 'abc'], /submission\.repeats: must be a number/u],
    [['run', '--persona', 'a', '--effort', 'max'], /submission\.effort: must be one of/u],
    [['run', '--url', 'http://a.test/'], /url and note/u],
    [['run', 'extra'], /Unknown command: run extra/u],
  ];
  for (const [argv, expected] of cases) {
    const { code, out } = await capture(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(out, expected);
  }
});

test('init creates the project layout once and doctor reports it without printing keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-init-'));
  await promisify(execFile)('git', ['init', '-q', root]);
  const cli = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    let out = '';
    const code = await run(argv, (text) => void (out += text), { cwd: root, env });
    return { code, out };
  };
  const first = await cli(['init']);
  assert.equal(first.code, 0);
  assert.equal((await lstat(join(root, '.cohort'))).mode & 0o777, 0o700);
  for (const path of ['.cohort/config.yml', '.cohort/.gitignore', '.cohort/personas/first-time-host.md'])
    assert.match(first.out, new RegExp(`created ${path.replaceAll('.', '\\.')}`, 'u'));
  await writeFile(join(root, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/vision-model\n');
  assert.doesNotMatch(first.out, /saas-trial-evaluator/u);
  const second = await cli(['init']);
  assert.doesNotMatch(second.out, /created/u);
  assert.match(second.out, /kept \.cohort\/config\.yml/u);
  assert.equal(
    await readFile(join(root, '.cohort/config.yml'), 'utf8'),
    'schemaVersion: 1\nmodel: openai/vision-model\n',
  );
  const unknown = await cli(['init', '--template', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /unknown template nope; known templates: .*saas-trial-evaluator/u);
  const picked = await cli(['init', '--template', 'saas-trial-evaluator', '--template', 'first-time-host']);
  assert.equal(picked.code, 0);
  assert.match(picked.out, /^created \.cohort\/personas\/saas-trial-evaluator\.md$/mu);
  assert.match(picked.out, /^kept \.cohort\/personas\/first-time-host\.md \(exists\)$/mu);
  assert.doesNotMatch(picked.out, /mobile-first-guest/u);
  assert.match((await cli(['persona', 'validate'])).out, /^4 valid persona\(s\), 0 suite\(s\), 0 problem\(s\)$/mu);

  await writeFile(join(root, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/untested-model\n');
  await writeFile(
    join(root, '.cohort/models.yml'),
    'version: test\nmodels:\n  - id: untested-model\n    provider: openai\n    label: u\n    visionCapable: null\n    supportedEffortLevels: []\n    defaultEffort: null\n    pricesPerMTok: { input: null, output: null, cachedInput: null, cacheWrite: null }\n    pricingVerifiedAt: null\n    untested: true\n',
  );
  const unusable = await cli(['doctor']);
  assert.equal(unusable.code, 2);
  assert.match(unusable.out, /error default model: model is disabled until its capabilities are confirmed/u);
  assert.match(unusable.out, /error OPENAI_API_KEY is not set/u);
  assert.match(unusable.out, /ok    \.cohort\/runs is gitignored/u);
  assert.match(unusable.out, /ok    \.cohort\/auth is gitignored/u);
  assert.match(unusable.out, /ok    \.cohort\/index\.sqlite is gitignored/u);
  await writeFile(join(root, '.cohort/.gitignore'), 'auth/\nruns/\n');
  const exposed = await cli(['doctor']);
  assert.match(exposed.out, /error \.cohort\/index\.sqlite is not gitignored/u);
  await writeFile(join(root, '.cohort/.gitignore'), 'auth/\nruns/\nindex.sqlite*\n');

  const key = 'sk-doctor-canary-0123456789';
  await writeFile(join(root, '.cohort/config.yml'), 'schemaVersion: 1\nmodel: openai/vision-model\n');
  await writeFile(
    join(root, '.cohort/models.yml'),
    'version: test\nmodels:\n  - id: vision-model\n    provider: openai\n    label: v\n    visionCapable: true\n    supportedEffortLevels: [low]\n    defaultEffort: low\n    pricesPerMTok: { input: 1, output: 4, cachedInput: null, cacheWrite: 1 }\n    pricingVerifiedAt: 2026-10-01\n    untested: false\n',
  );
  await mkdir(join(root, '.cohort/runs/run_20261028_000000_abcdef'), { recursive: true });
  const ready = await cli(['doctor'], { OPENAI_API_KEY: key });
  assert.equal(ready.code, 0, ready.out);
  assert.match(ready.out, /ok    default model openai\/vision-model \(low\)/u);
  assert.match(ready.out, /ok    OPENAI_API_KEY is set/u);
  assert.match(ready.out, /warn  1 run\(s\) without manifest\.json.*run_20261028_000000_abcdef/u);
  const json = await cli(['doctor', '--json'], { OPENAI_API_KEY: key });
  assert.ok(Array.isArray(JSON.parse(json.out).checks));
  assert.doesNotMatch(ready.out + json.out, new RegExp(key, 'u'));
});

test('init refuses a symlinked .cohort and doctor asks for init', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-init-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'lab-elsewhere-'));
  const cli = async (argv: string[]) => {
    let out = '';
    const code = await run(argv, (text) => void (out += text), { cwd: root, env: {} });
    return { code, out };
  };
  assert.match((await cli(['doctor'])).out, /error no \.cohort directory here; run: cohort init/u);
  await symlink(elsewhere, join(root, '.cohort'));
  const refused = await cli(['init']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /\.cohort must be a plain directory/u);
  assert.deepEqual(await readdir(elsewhere), []);
});
