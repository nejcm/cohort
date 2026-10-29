import assert from 'node:assert/strict';
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../../src/config/files.ts';
import { CANARY, compareFixture, KEY } from '../helpers/compare-fixture.ts';

const f = compareFixture();

test('a head that breaks the approved journey is a confirmed regression in four executions', async () => {
  const original = await f.bundleState();
  const { code, out } = await f.cli([
    'compare',
    f.runId,
    '--base',
    f.base.url,
    '--head',
    `${f.broken.url}/`,
    ...f.provenance(),
    '--json',
    '--markdown',
    'comment.md',
  ]);
  const result = JSON.parse(out);
  assert.equal(code, 1, out);
  assert.equal(result.outcome, 'regression');
  assert.deepEqual(
    result.executions.map((execution: { side: string; status: string }) => `${execution.side} ${execution.status}`),
    ['base passed', 'head failed', 'base passed', 'head failed'],
  );
  assert.match(result.executions[1].failure, /^s0001 click: .*(Error|Test timeout)/u);
  const markdown = await readFile(join(f.root, 'comment.md'), 'utf8');
  assert.ok(markdown.startsWith(`<!-- cohort-compare:${f.runId} -->\n`));
  assert.match(markdown, /journey check: regression/u);
  for (const text of [out, markdown]) {
    assert.ok(!text.includes(CANARY), 'setup secret leaked');
    assert.ok(!text.includes(KEY), 'provider key leaked');
  }
  assert.deepEqual(await f.bundleState(), original, 'compare does not touch the approved run');
  assert.equal(JSON.parse(original[0]!).replay.status, 'not_attempted');
});

test('an identical head is no_regression after one round and exits 0', async () => {
  const { code, out } = await f.cli([
    'compare',
    f.runId,
    '--base',
    f.base.url,
    '--head',
    f.healthy.url,
    ...f.provenance(),
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /^1\. base passed .*\n2\. head passed .*\ncompare run_\S+: no_regression \(/mu);
  assert.ok(!out.includes(CANARY));
});

test('compare refuses bad origins and journeys pinned to the recorded origin', async () => {
  for (const argv of [
    ['--base', f.base.url],
    ['--base', `${f.base.url}/app`, '--head', f.base.url],
    ['--base', `http://user:pw@127.0.0.1:1`, '--head', f.base.url],
    ['--base', `${f.base.url}/?token=x`, '--head', f.base.url],
  ]) {
    const { code, out } = await f.cli(['compare', f.runId, ...argv]);
    assert.equal(code, 2, out);
    assert.match(out, /must be an http\(s\) origin/u);
  }
  const script = join(f.runDir, 'replay.spec.ts');
  const original = await readFile(script, 'utf8');
  const manifest = await readFile(join(f.runDir, 'manifest.json'), 'utf8');
  for (const url of [`${f.base.url}/arrival`, `${f.base.url.replace(/^http:/u, '')}/arrival`]) {
    await appendFile(script, `// await page.goto(${JSON.stringify(url)});\n`);
    await writeFile(
      join(f.runDir, 'manifest.json'),
      manifest.replace(sha256(original), sha256(await readFile(script))),
    );
    try {
      const pinned = await f.cli(['compare', f.runId, '--base', f.base.url, '--head', f.base.url]);
      assert.equal(pinned.code, 2, url);
      assert.match(pinned.out, /replay\.spec\.ts navigates to an absolute URL/u);
    } finally {
      await writeFile(script, original);
      await writeFile(join(f.runDir, 'manifest.json'), manifest);
    }
  }
});

test('a tampered bundle, a planted file, or a script that is not the approved one is refused', async () => {
  const script = join(f.runDir, 'replay.spec.ts');
  const original = await readFile(script, 'utf8');
  const compare = () =>
    f.cli(['compare', f.runId, '--base', f.base.url, '--head', f.healthy.url, ...f.provenance(), '--json']);
  await writeFile(script, original.replace('expect', 'expect '));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.equal(JSON.parse(out).code, 'invalid');
    assert.match(out, /replay\.spec\.ts does not match its SHA-256 hash/u);
  } finally {
    await writeFile(script, original);
  }
  const configPath = join(f.runDir, 'resolved-config.json');
  const [config, manifest] = await Promise.all([
    readFile(configPath, 'utf8'),
    readFile(join(f.runDir, 'manifest.json'), 'utf8'),
  ]);
  const forged = config.replace('"timeMs": 8000', '"timeMs": 7000');
  assert.notEqual(forged, config);
  await writeFile(configPath, forged);
  await writeFile(join(f.runDir, 'manifest.json'), manifest.replaceAll(sha256(config), sha256(forged)));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /manifest\.json does not match the approved hash/u);
  } finally {
    await writeFile(configPath, config);
    await writeFile(join(f.runDir, 'manifest.json'), manifest);
  }
  await writeFile(join(f.runDir, 'playwright.config.ts'), 'process.exit(0);\n');
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /playwright\.config\.ts is not a file a run writes/u);
  } finally {
    await rm(join(f.runDir, 'playwright.config.ts'));
  }
  await rename(join(f.runDir, 'trace.zip'), join(f.root, 'trace.zip'));
  await rename(join(f.runDir, 'steps.jsonl'), join(f.root, 'steps.jsonl'));
  try {
    const { code, out } = await compare();
    assert.equal(code, 2, out);
    assert.match(out, /steps\.jsonl is listed in manifest\.json but missing/u);
    await rename(join(f.root, 'steps.jsonl'), join(f.runDir, 'steps.jsonl'));
    const withoutTrace = await f.cli(['compare', f.runId, '--base', f.base.url, '--head', f.healthy.url, '--json']);
    assert.equal(withoutTrace.code, 0, 'an uploaded bundle without trace.zip still verifies');
  } finally {
    await rename(join(f.root, 'trace.zip'), join(f.runDir, 'trace.zip'));
    await rename(join(f.root, 'steps.jsonl'), join(f.runDir, 'steps.jsonl')).catch(() => {});
  }
  const other = f.provenance();
  other[other.indexOf('--approved') + 1] = `sha256:${'0'.repeat(64)}`;
  const { code, out } = await f.cli(['compare', f.runId, '--base', f.base.url, '--head', f.healthy.url, ...other]);
  assert.equal(code, 2, out);
  assert.match(out, /does not match the approved hash/u);
});

test('unverified resets, contaminated scopes, wrong deployments, and failing hooks are inconclusive', async () => {
  for (const [mode, executions, reason] of [
    ['unverified', ['base error'], /base execution 1 could not run: reset verification failed/u],
    ['contaminated', ['base error'], /not scoped to this execution/u],
    ['wrong-deployment', ['base passed', 'head error'], /deployment identity does not match --deployment/u],
    ['cleanup-fails', ['base error'], /cleanup failed; the scope may be contaminated/u],
    ['throw', ['base error'], /compare hooks failed/u],
  ] as const) {
    const { code, out } = await f.cli(
      ['compare', f.runId, '--base', f.base.url, '--head', f.broken.url, ...f.provenance(), '--json'],
      { HOOK_MODE: mode },
    );
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.equal(result.outcome, 'inconclusive', mode);
    assert.deepEqual(
      result.executions.map((execution: { side: string; status: string }) => `${execution.side} ${execution.status}`),
      executions,
      mode,
    );
    assert.match(result.reason, reason);
    assert.ok(!out.includes(CANARY), mode);
  }
});
