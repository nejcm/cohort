import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareFixture, switching } from '../helpers/compare-fixture.ts';

const f = compareFixture();

test('a result that flips between rounds is inconclusive, never a regression', async () => {
  const flaky = await switching(f.broken.url, f.healthy.url);
  try {
    const { code, out } = await f.cli([
      'compare',
      f.runId,
      '--base',
      f.base.url,
      '--head',
      flaky.url,
      ...f.provenance(),
      '--json',
    ]);
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.deepEqual([result.outcome, result.executions.length], ['inconclusive', 4]);
    assert.match(result.reason, /flaky/u);
  } finally {
    flaky.server.close();
  }
});

test('missing provenance or hooks is inconclusive without opening a browser', async () => {
  const all = f.provenance();
  for (const drop of ['--deployment', '--head-sha', '--approved', '--hooks']) {
    const index = all.indexOf(drop);
    const argv = [...all.slice(0, index), ...all.slice(index + 2)];
    const { code, out } = await f.cli([
      'compare',
      f.runId,
      '--base',
      f.base.url,
      '--head',
      f.broken.url,
      ...argv,
      '--json',
    ]);
    const result = JSON.parse(out);
    assert.equal(code, 0, out);
    assert.deepEqual([result.outcome, result.executions.length], ['inconclusive', 0], drop);
    assert.match(
      result.reason,
      drop === '--hooks' ? /no --hooks module/u : new RegExp(`missing provenance: ${drop}`, 'u'),
    );
  }
  const bad = await f.cli([
    'compare',
    f.runId,
    '--base',
    f.base.url,
    '--head',
    f.broken.url,
    '--repo',
    '../x',
    '--json',
  ]);
  assert.equal(bad.code, 2, bad.out);
});

test('values the hooks read are redacted from failure text', async () => {
  const { out } = await f.cli(
    ['compare', f.runId, '--base', f.base.url, '--head', f.broken.url, ...f.provenance(), '--json'],
    {
      HOOK_TOKEN: 'Arrival instructions',
    },
  );
  const result = JSON.parse(out);
  assert.equal(result.executions[1].status, 'failed', out);
  assert.match(result.executions[1].failure, /\[env\]/u);
  assert.ok(!out.includes('Arrival instructions'));
});
